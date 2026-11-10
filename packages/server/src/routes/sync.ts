import {
  CHUNK_PLAINTEXT_BYTES,
  chunkCountFor,
  historyLimitsOf,
  storedChunkBytes,
  type ChunkUploadQuery,
  type FileVersionQuery,
  type PushBody,
  type SyncContentsRequest,
  type SyncPullRequest,
} from "@courier/shared";
import {
  deleteFileVersionsByFileIds,
  getLatestVersionIds,
  getVersionChain,
  isContentHashReferenced,
  listDeletedChains,
  listDeletedFileIds,
  listFileHeadsByVaultId,
  listFilesByVaultId,
  tryInsertFileVersions,
} from "../db/repositories/file-versions";
import {
  getFileVersionHistory,
  getVaultSyncHistory,
  getVaultSyncIndex,
  handleClearDeleted,
  handleSyncContents,
  handleSyncPull,
  handleSyncPush,
  listDeletedFiles,
} from "../handlers/sync-handlers";
import type { WsHub } from "../handlers/ws-handlers";
import type { RouteHandlerBody, RouteHandlers } from "../http/contract-routes";
import { parseByteRange } from "../lib/byte-range";
import { getReferencedContentHashes } from "../lib/blob-references";
import {
  UploadChunkError,
  assembleUploadedChunks,
  deleteBlob,
  flushBlobWrites,
  hasBlob,
  openBlobReader,
  uploadStatus,
  writeBlob,
  writeUploadChunk,
} from "../lib/blob-store";
import { NotFoundError, RangeNotSatisfiableError, ValidationError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { logPushResults } from "../lib/push-log";
import { assertWithinQuota, incomingBytes } from "../lib/quota";
import { userStorageBytes } from "../lib/users-db";
import {
  invalidateUserStorageUsage,
  recordUserStorageUsage,
  userStorageUsage,
} from "../lib/storage-usage";

/**
 * The sync API's HTTP surface.
 *
 * Every dependency the routes need — the statements, the blob store, the WebSocket
 * hub — arrives by import from the module that owns it, and the handlers receive them
 * as arguments. This file is therefore only: wiring and HTTP status codes. The schemas,
 * auth, rate limits and response validation come from the registry via
 * `http/contract-routes.ts`.
 */

/**
 * Largest body a content GET reads into memory instead of streaming.
 *
 * A batch file holds many blobs, so a per-request `createReadStream` pays a stream's
 * allocation and readahead on every blob the file holds; a positional read of the same
 * range costs 0.20 ms against 0.28 ms streamed (5 000 notes, warm cache).
 */
const SMALL_BODY_BYTES = 256 * 1024;

/** One content GET/HEAD: the ciphertext, or one `Range` block of it. */
const serveContent: RouteHandlerBody = async ({ request, params, vaultId }) => {
  const contentHash = params.contentHash!;
  const reader = await openBlobReader(vaultId!, contentHash);
  if (reader === undefined) throw new NotFoundError("Version content");
  const blob = reader.stat;

  const headers = {
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
  };
  try {
    const range = parseByteRange(request.headers.get("range") ?? undefined, blob.size);
    if (range === "invalid") throw new RangeNotSatisfiableError(blob.size);
    const status = range === null ? 200 : 206;
    const responseHeaders =
      range === null
        ? { ...headers, "Content-Length": String(blob.size) }
        : {
            ...headers,
            "Content-Length": String(range.end - range.start + 1),
            "Content-Range": `bytes ${range.start}-${range.end}/${blob.size}`,
          };
    // A HEAD has the same headers as the GET and no body.
    if (request.method === "HEAD") {
      await reader.close();
      return new Response(null, { status, headers: responseHeaders });
    }
    // A full GET of a small blob is one positional read, not a stream.
    if (range === null && blob.size <= SMALL_BODY_BYTES) {
      const bytes = await reader.readAll();
      if (bytes === undefined) throw new NotFoundError("Version content");
      return new Response(bytes, { status, headers: responseHeaders });
    }
    // A `Bun.file` slice is a lazy view of the batch file: Bun serves it from disk and,
    // being a known-size Blob, keeps the `Content-Length` above. A stream cannot carry
    // that header through `Bun.serve` (it answers with chunked encoding).
    await reader.close();
    const start = blob.dataStart + (range?.start ?? 0);
    const end = blob.dataStart + (range?.end ?? blob.size - 1) + 1;
    return new Response(Bun.file(blob.filePath).slice(start, end), {
      status,
      headers: responseHeaders,
    });
  } catch (err) {
    // No body was handed out, so the route still owns the handle (a 416, say).
    await reader.close().catch(() => {});
    throw err;
  }
};

/**
 * The ten sync routes, keyed by their registry id.
 *
 * The adapter has already authenticated the `ck_` key and resolved the vault, parsed
 * the body/query/params and applied the rate limit; the handlers own the protocol
 * decisions and the storage calls.
 */
export function syncHandlers(
  hub: WsHub,
  logger: Logger,
): Pick<
  RouteHandlers,
  | "sync.push"
  | "sync.pull"
  | "sync.versionContent"
  | "sync.versionContentHead"
  | "sync.contents"
  | "sync.chunkPut"
  | "sync.chunkStatus"
  | "sync.versions"
  | "sync.history"
  | "sync.index"
  | "sync.deleted"
  | "sync.clearDeleted"
> {
  return {
    "sync.push": async ({ request, vaultId, user, vault, body }) => {
      const current = user!;
      const vaultRow = vault!;
      const id = vaultId!;
      const excludeSessionId = request.headers.get("x-courier-session-id") ?? undefined;
      const { deviceName, files } = body as PushBody;

      // The password is checked client-side and the store is content-addressed, so the
      // one thing a user can spend is space: the limit is enforced here, before anything
      // is written, and the whole batch is refused rather than half-accepted.
      const incoming = await incomingBytes(files, (hash) => hasBlob(id, hash));
      assertWithinQuota(
        current,
        await userStorageUsage(current.id, { measure: userStorageBytes }),
        incoming,
      );

      const response = await handleSyncPush(
        {
          vaultId: id,
          // The vault's own limits: the policy the trim applies, read here so a push
          // cannot state a value of its own.
          historyLimits: historyLimitsOf(vaultRow),
          excludeSessionId,
          files,
          deviceName,
        },
        {
          writeBlob,
          tryInsertFileVersions,
          getLatestVersionIds,
          hasBlob,
          assembleChunks: assembleUploadedChunks,
          flushBlobs: flushBlobWrites,
          broadcast: hub.broadcastFilesPushed,
          // The history trim inside the insert transaction removes old rows; these two
          // reclaim the blobs those rows were the last reference to, and the third drops
          // the cached usage a reclaim has just made too high.
          isContentHashReferenced,
          deleteBlob,
          invalidateStorageUsage: () => invalidateUserStorageUsage(current.id),
        },
      );
      // What was just written is added to the cached usage, so the rest of this window
      // is checked against reality instead of re-walking the store.
      if (files.some((file) => (file.contentChunks ?? 0) > 0)) {
        invalidateUserStorageUsage(current.id);
      } else {
        recordUserStorageUsage(current.id, incoming);
      }
      logPushResults(logger, id, deviceName, response.results);
      return { body: response };
    },

    "sync.pull": async ({ vaultId, body }) => ({
      body: await handleSyncPull(
        { vaultId: vaultId!, files: (body as SyncPullRequest).files },
        getVersionChain,
      ),
    }),

    "sync.versionContent": serveContent,
    "sync.versionContentHead": serveContent,

    // Several versions' ciphertext in one answer: the batch frame from `@courier/shared`'s
    // `wire.ts`. A bind or a burst used to cost one content request per file; this is the
    // route that removes that per-file round trip. A hash the store no longer holds is an
    // ordinary `missing` entry, not a failed request.
    "sync.contents": async ({ vaultId, body }) => ({
      body: await handleSyncContents(
        { vaultId: vaultId!, hashes: (body as SyncContentsRequest).hashes },
        openBlobReader,
      ),
    }),

    "sync.chunkPut": async ({ vaultId, user, params, query, body }) => {
      const current = user!;
      const id = vaultId!;
      const contentHash = params.contentHash!;
      const index = Number(params.index);
      const { chunkCount, plaintextSize } = query as ChunkUploadQuery;

      if (chunkCount !== chunkCountFor(plaintextSize, CHUNK_PLAINTEXT_BYTES)) {
        throw new ValidationError("chunkCount does not match plaintextSize");
      }
      if (index >= chunkCount) throw new ValidationError("chunk index is out of range");

      const bytes = body as Uint8Array;
      // The same length `writeUploadChunk` will check, but before the quota is consulted:
      // a body that cannot be this chunk must not consume quota or disk.
      if (bytes.byteLength !== storedChunkBytes(index, plaintextSize)) {
        throw new ValidationError("chunk body has the wrong length for its index");
      }

      // Staged bytes are disk this account holds, so they are charged as they arrive.
      assertWithinQuota(
        current,
        await userStorageUsage(current.id, { measure: userStorageBytes }),
        bytes.byteLength,
      );

      try {
        const { received, newBytes } = await writeUploadChunk(
          id,
          contentHash,
          index,
          chunkCount,
          plaintextSize,
          bytes,
        );
        recordUserStorageUsage(current.id, newBytes);
        return { body: { received } };
      } catch (err) {
        if (err instanceof UploadChunkError) {
          throw new ValidationError(
            err.reason === "bad_meta"
              ? "chunk metadata disagrees with the upload"
              : "chunk body has the wrong length for its index",
          );
        }
        throw err;
      }
    },

    // How much of a staged chunk upload the server already holds (the resume point).
    "sync.chunkStatus": async ({ vaultId, params }) => {
      const status = await uploadStatus(vaultId!, params.contentHash!);
      if (status === undefined) throw new NotFoundError("Upload");
      return { body: status };
    },

    "sync.versions": async ({ vaultId, query }) => ({
      body: await getFileVersionHistory(
        vaultId!,
        (query as FileVersionQuery).fileId,
        getVersionChain,
      ),
    }),

    "sync.history": async ({ vaultId }) => ({
      body: await getVaultSyncHistory(vaultId!, listFilesByVaultId),
    }),

    "sync.index": async ({ vaultId }) => ({
      body: await getVaultSyncIndex(vaultId!, listFileHeadsByVaultId),
    }),

    "sync.deleted": async ({ vaultId }) => ({
      body: await listDeletedFiles({ vaultId: vaultId! }, listDeletedChains),
    }),

    "sync.clearDeleted": async ({ vaultId }) => ({
      body: await handleClearDeleted(
        { vaultId: vaultId! },
        {
          listDeletedFileIds,
          deleteFileVersionsByFileIds,
          getReferencedContentHashes,
          deleteBlob,
        },
      ),
    }),
  };
}
