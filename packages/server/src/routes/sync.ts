import { z } from "zod";
import { json, type RouteHandler, type RouteTable, withAccessLog } from "../http/router";
import { withErrorMapping } from "../http/auth";
import { parseJson } from "../http/guards";
import { withRateLimiter, withSyncAuth, type SyncRequestContext } from "../http/sync-guards";
import {
  createRateLimiter,
  syncRateLimitOptions,
  syncTransferRateLimitOptions,
} from "../middleware/rate-limit";
import { validationDetails } from "../lib/validator";
import {
  assembleUploadedChunks,
  deleteBlob,
  hasBlob,
  openBlobReader,
  uploadStatus,
  flushBlobWrites,
  writeBlob,
  writeUploadChunk,
  UploadChunkError,
} from "../lib/blob-store";
import { parseByteRange } from "../lib/byte-range";
import { getReferencedContentHashes } from "../lib/blob-references";
import { assertWithinQuota, incomingBytes } from "../lib/quota";
import {
  recordUserStorageUsage,
  userStorageUsage,
  invalidateUserStorageUsage,
} from "../lib/storage-usage";
import {
  NotFoundError,
  PayloadTooLargeError,
  RangeNotSatisfiableError,
  ValidationError,
} from "../lib/errors";
import { config } from "../config";
import {
  CHUNKED_TRANSFER_THRESHOLD,
  CHUNK_PLAINTEXT_BYTES,
  CONTENT_HASH_PATTERN,
  HISTORY_KINDS,
  MAX_CHUNKS,
  MAX_CONTENT_BATCH_FILES,
  MAX_DEVICE_NAME_LENGTH,
  MAX_ENCRYPTED_PATH_LENGTH,
  MAX_ID_LENGTH,
  MAX_PULL_BATCH_FILES,
  MAX_PUSH_BATCH_FILES,
  SYNC_ACTIONS,
  WireFormatError,
  chunkCountFor,
  historyLimitsOf,
  parsePushBody,
  storedChunkBytes,
  type PushBody,
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
import { findVaultById } from "../db/repositories/vaults";
import { findUserByKey, userStorageBytes } from "../lib/users-db";
import { logPushResults } from "../lib/push-log";
import type { Logger } from "../lib/logger";
import type { WsHub } from "../handlers/ws-handlers";

/**
 * The sync API's HTTP surface.
 *
 * Every dependency the routes need — the statements, the blob store, the WebSocket
 * hub — arrives by import from the module that owns it, and the handlers receive
 * them as arguments. This file is therefore only: schemas, body reading, wiring and
 * HTTP status codes.
 */

// ── Zod schemas ──

/**
 * Largest body a content GET reads into memory instead of streaming.
 *
 * A batch file holds many blobs, so a per-request `createReadStream` pays a stream's
 * allocation and readahead on every blob the file holds; a positional read of the same
 * range costs 0.20 ms against 0.28 ms streamed (5 000 notes, warm cache).
 */
const SMALL_BODY_BYTES = 256 * 1024;

/**
 * One entry of a push **header** (see `@courier/shared`'s `wire.ts`): the body is
 * binary, so this validates the metadata the frame carried, not a JSON request.
 */
const pushFileSchema = z.object({
  fileId: z.string().min(1).max(MAX_ID_LENGTH),
  encryptedPath: z.string().min(0).max(MAX_ENCRYPTED_PATH_LENGTH),
  action: z.enum(SYNC_ACTIONS),
  versionId: z.string().min(1).max(MAX_ID_LENGTH),
  // The SHA-256 of the file's plaintext. The shape is checked here because this
  // string is also used as a **path component** in the blob store.
  contentHash: z
    .string()
    .regex(CONTENT_HASH_PATTERN, "contentHash must be a 64-character lowercase hex SHA-256"),
  sizeBytes: z.number().int().nonnegative(),
  mtimeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  baseVersionId: z.string().min(1).max(MAX_ID_LENGTH).nullable(),
  contentChunks: z.number().int().nonnegative().max(MAX_CHUNKS).optional(),
  // What kind of file this version is. The client states it (only the plaintext path can
  // say); the server maps it to the **vault's** retention limit and stores it on the row.
  historyKind: z.enum(HISTORY_KINDS),
});

const syncPushSchema = z.object({
  files: z.array(pushFileSchema).min(1).max(MAX_PUSH_BATCH_FILES),
  deviceName: z.string().trim().min(1).max(MAX_DEVICE_NAME_LENGTH).nullish(),
});

const pullFileSchema = z.object({
  fileId: z.string().min(1).max(MAX_ID_LENGTH),
});

const syncPullSchema = z.object({
  files: z.array(pullFileSchema).min(0).max(MAX_PULL_BATCH_FILES),
});

const syncContentsSchema = z.object({
  hashes: z.array(z.string().regex(CONTENT_HASH_PATTERN)).min(1).max(MAX_CONTENT_BATCH_FILES),
});

const chunkQuerySchema = z.object({
  chunkCount: z.coerce.number().int().positive().max(MAX_CHUNKS),
  plaintextSize: z.coerce.number().int().positive(),
});

// ── Body reading ──

/**
 * Read and validate one push body.
 *
 * The body is the binary frame from `@courier/shared`'s `wire.ts`: a JSON header
 * and the raw ciphertext of every file, in header order. Reading it is bounded on
 * purpose, before and after buffering.
 */
async function readPushBody(request: Request): Promise<PushBody> {
  const limit = config.SYNC_MAX_PUSH_BYTES;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new PayloadTooLargeError(`push body exceeds ${limit} bytes`);
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > limit) {
    throw new PayloadTooLargeError(`push body exceeds ${limit} bytes`);
  }

  let parsedBody: PushBody;
  try {
    parsedBody = parsePushBody(body);
  } catch (err) {
    if (err instanceof WireFormatError) {
      throw new ValidationError("Validation failed", [{ field: "body", message: err.message }]);
    }
    throw err;
  }

  // The frame parser checked the shape; this checks the contract (id lengths, the
  // action enum, the batch cap, the label's length).
  const parsed = syncPushSchema.safeParse({
    files: parsedBody.files,
    deviceName: parsedBody.deviceName,
  });
  if (!parsed.success) {
    throw new ValidationError("Validation failed", validationDetails(parsed.error.issues));
  }
  // Cross-field rules the per-entry schema cannot express: a version travels either as
  // a whole payload or as staged chunks, and the size decides which.
  for (const file of parsedBody.files) {
    const chunks = file.contentChunks ?? 0;
    if (file.content !== null && chunks > 0) {
      throw new ValidationError("Validation failed", [
        { field: "contentChunks", message: "a push carries either content or chunks, not both" },
      ]);
    }
    if (chunks > 0) {
      if (file.sizeBytes <= CHUNKED_TRANSFER_THRESHOLD) {
        throw new ValidationError("Validation failed", [
          { field: "contentChunks", message: "chunked uploads are only for payloads above 8 MiB" },
        ]);
      }
      if (chunks !== chunkCountFor(file.sizeBytes)) {
        throw new ValidationError("Validation failed", [
          { field: "contentChunks", message: "chunkCount does not match sizeBytes" },
        ]);
      }
    } else if (file.content !== null && file.sizeBytes > CHUNKED_TRANSFER_THRESHOLD) {
      throw new ValidationError("Validation failed", [
        { field: "content", message: "a payload above 8 MiB must be uploaded in chunks" },
      ]);
    }
  }
  return { deviceName: parsed.data.deviceName ?? null, files: parsedBody.files };
}

/** The sync API's HTTP surface: schemas, body reading, wiring and status codes. */
export function syncRoutes(hub: WsHub, logger: Logger): RouteTable {
  const syncLimit = createRateLimiter(syncRateLimitOptions());
  // The blocks of one file get a budget of their own; see `syncTransferRateLimitOptions`.
  const transferLimit = createRateLimiter(syncTransferRateLimitOptions());

  /** access log → error mapping → rate limit → sync auth → handler. */
  const sync = (
    limit: typeof syncLimit,
    handler: Parameters<typeof withSyncAuth>[1],
  ): RouteHandler =>
    withAccessLog(
      logger,
      withErrorMapping(
        withRateLimiter(limit, withSyncAuth({ findUserByKey, findVaultById }, handler)),
        logger,
      ),
      config.LOG_SLOW_MS,
    );

  /** One content GET/HEAD: the ciphertext, or one `Range` block of it. */
  const serveContent: RouteHandler = sync(transferLimit, async (request, { vaultId }) => {
    const contentHash = request.params.contentHash ?? "";
    // A content hash is 64 hex characters or it names nothing; without this check a
    // `..%2F<otherVault>%2F<hash>` would resolve into another tenant's blob.
    if (!CONTENT_HASH_PATTERN.test(contentHash)) {
      throw new NotFoundError("Version content");
    }
    const reader = await openBlobReader(vaultId, contentHash);
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
      // A `Bun.file` slice is a lazy view of the batch file: Bun serves it from disk
      // and, being a known-size Blob, keeps the `Content-Length` above. A stream cannot
      // carry that header through `Bun.serve` (it answers with chunked encoding).
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
  });

  return {
    "/api/vaults/:id/sync/push": {
      POST: sync(syncLimit, async (request, { vaultId, user, vault }: SyncRequestContext) => {
        const excludeSessionId = request.headers.get("x-courier-session-id") ?? undefined;
        const { deviceName, files } = await readPushBody(request);

        // The password is checked client-side and the store is content-addressed,
        // so the one thing a user can spend is space: the limit is enforced here,
        // before anything is written, and the whole batch is refused rather than
        // half-accepted.
        let incoming = 0;
        incoming = await incomingBytes(files, (hash) => hasBlob(vaultId, hash));
        assertWithinQuota(
          user,
          await userStorageUsage(user.id, { measure: userStorageBytes }),
          incoming,
        );

        const response = await handleSyncPush(
          {
            vaultId,
            // The vault's own limits: the policy the trim applies, read here so a push
            // cannot state a value of its own.
            historyLimits: historyLimitsOf(vault),
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
            // reclaim the blobs those rows were the last reference to, and the third
            // drops the cached usage a reclaim has just made too high.
            isContentHashReferenced,
            deleteBlob,
            invalidateStorageUsage: () => invalidateUserStorageUsage(user.id),
          },
        );
        // What was just written is added to the cached usage, so the rest of this
        // window is checked against reality instead of re-walking the store.
        if (files.some((file) => (file.contentChunks ?? 0) > 0)) {
          invalidateUserStorageUsage(user.id);
        } else {
          recordUserStorageUsage(user.id, incoming);
        }
        logPushResults(logger, vaultId, deviceName, response.results);
        return json(response);
      }),
    },
    "/api/vaults/:id/sync/pull": {
      POST: sync(syncLimit, async (request, { vaultId }) => {
        const { files } = await parseJson(request, syncPullSchema);
        return json(await handleSyncPull({ vaultId, files }, getVersionChain));
      }),
    },
    "/api/vaults/:id/sync/versions/:contentHash/content": {
      GET: serveContent,
      // A HEAD has the same headers as the GET and no body; Bun routes dispatch by
      // method, so it needs its own entry.
      HEAD: serveContent,
    },
    // Several versions' ciphertext in one answer: the batch frame from `@courier/shared`'s
    // `wire.ts`. A bind or a burst used to cost one content request per file; this is the
    // route that removes that per-file round trip. A hash the store no longer holds is an
    // ordinary `missing` entry, not a failed request.
    "/api/vaults/:id/sync/contents": {
      POST: sync(transferLimit, async (request, { vaultId }) => {
        const { hashes } = await parseJson(request, syncContentsSchema);
        const body = await handleSyncContents({ vaultId, hashes }, openBlobReader);
        return new Response(body, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(body.byteLength),
          },
        });
      }),
    },
    // ── Chunked uploads ──
    "/api/vaults/:id/sync/blobs/:contentHash/chunks/:index": {
      PUT: sync(transferLimit, async (request, { vaultId, user }) => {
        const contentHash = request.params.contentHash ?? "";
        if (!CONTENT_HASH_PATTERN.test(contentHash)) {
          throw new ValidationError("contentHash must be a 64-character lowercase hex SHA-256");
        }
        const indexText = request.params.index ?? "";
        if (!/^\d+$/.test(indexText)) {
          throw new ValidationError("chunk index must be a non-negative integer");
        }
        const index = Number(indexText);
        const query = chunkQuerySchema.safeParse({
          chunkCount: new URL(request.url).searchParams.get("chunkCount") ?? undefined,
          plaintextSize: new URL(request.url).searchParams.get("plaintextSize") ?? undefined,
        });
        if (!query.success) {
          throw new ValidationError("Validation failed", validationDetails(query.error.issues));
        }
        const { chunkCount, plaintextSize } = query.data;
        if (chunkCount !== chunkCountFor(plaintextSize, CHUNK_PLAINTEXT_BYTES)) {
          throw new ValidationError("chunkCount does not match plaintextSize");
        }
        if (index >= chunkCount) throw new ValidationError("chunk index is out of range");

        const limit = config.SYNC_MAX_CHUNK_BYTES;
        const declared = Number(request.headers.get("content-length") ?? "0");
        if (Number.isFinite(declared) && declared > limit) {
          throw new PayloadTooLargeError(`chunk body exceeds ${limit} bytes`);
        }
        const body = new Uint8Array(await request.arrayBuffer());
        if (body.byteLength > limit) {
          throw new PayloadTooLargeError(`chunk body exceeds ${limit} bytes`);
        }
        // The same length `writeUploadChunk` will check, but before the quota is
        // consulted: a body that cannot be this chunk must not consume quota or disk.
        if (body.byteLength !== storedChunkBytes(index, plaintextSize)) {
          throw new ValidationError("chunk body has the wrong length for its index");
        }

        // Staged bytes are disk this account holds, so they are charged as they arrive.
        assertWithinQuota(
          user,
          await userStorageUsage(user.id, { measure: userStorageBytes }),
          body.byteLength,
        );

        try {
          const { received, newBytes } = await writeUploadChunk(
            vaultId,
            contentHash,
            index,
            chunkCount,
            plaintextSize,
            body,
          );
          recordUserStorageUsage(user.id, newBytes);
          return json({ received });
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
      }),
    },
    // How much of a staged chunk upload the server already holds (the resume point).
    "/api/vaults/:id/sync/blobs/:contentHash/status": {
      GET: sync(transferLimit, async (request, { vaultId }) => {
        const contentHash = request.params.contentHash ?? "";
        if (!CONTENT_HASH_PATTERN.test(contentHash)) {
          throw new ValidationError("contentHash must be a 64-character lowercase hex SHA-256");
        }
        const status = await uploadStatus(vaultId, contentHash);
        if (status === undefined) throw new NotFoundError("Upload");
        return json(status);
      }),
    },
    "/api/vaults/:id/sync/versions": {
      GET: sync(syncLimit, async (request, { vaultId }) => {
        const fileId = new URL(request.url).searchParams.get("fileId");
        if (!fileId) {
          // The same error the rest of the API answers a rejected input with.
          throw new ValidationError("fileId query parameter is required");
        }
        return json(await getFileVersionHistory(vaultId, fileId, getVersionChain));
      }),
    },
    "/api/vaults/:id/sync/history": {
      GET: sync(syncLimit, async (_request, { vaultId }) =>
        json(await getVaultSyncHistory(vaultId, listFilesByVaultId)),
      ),
    },
    "/api/vaults/:id/sync/index": {
      GET: sync(syncLimit, async (_request, { vaultId }) =>
        json(await getVaultSyncIndex(vaultId, listFileHeadsByVaultId)),
      ),
    },
    "/api/vaults/:id/sync/deleted": {
      GET: sync(syncLimit, async (_request, { vaultId }) =>
        json(await listDeletedFiles({ vaultId }, listDeletedChains)),
      ),
    },
    "/api/vaults/:id/sync/deleted/clear": {
      POST: sync(syncLimit, async (_request, { vaultId }) =>
        json(
          await handleClearDeleted(
            { vaultId },
            {
              listDeletedFileIds,
              deleteFileVersionsByFileIds,
              getReferencedContentHashes,
              deleteBlob,
            },
          ),
        ),
      ),
    },
  };
}
