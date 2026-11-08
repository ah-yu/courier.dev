import crypto from "crypto";
import type {
  SyncPushResponse,
  SyncPullResponse,
  FileVersionHistoryResponse,
  VaultSyncHistoryResponse,
  VaultSyncIndexResponse,
  VersionChainEntry,
  ClearDeletedResponse,
  ListDeletedFilesResponse,
  DeletedFileInfo,
  SyncAction,
  SyncPushResult,
  HistoryKind,
  HistoryLimits,
} from "@courier/shared";
import { NotFoundError, PayloadTooLargeError } from "../lib/errors";
import type { BlobReader } from "../lib/blob-store";
import { MAX_CONTENT_BATCH_BYTES, buildContentBatchBody } from "@courier/shared";

/**
 * The sync handlers: pure functions over injected DB/fs operations.
 *
 * They own the protocol decisions (the conditional push, what a chain's head
 * means, which chains are deleted) and nothing else — every statement lives in
 * `db/repositories/file-versions.ts`, and every dependency arrives as an
 * argument, so a unit test never opens a database.
 */

// ── Action types ──

export interface InsertFileVersionData {
  id: string;
  vaultId: string;
  fileId: string;
  encryptedPath: string;
  versionId: string;
  contentHash: string;
  /** Plaintext size of the version (`0` when it carries no content). */
  sizeBytes: number;
  /**
   * Plaintext last modification time of the file on the pushing device (ms since the
   * epoch). Stored for the clients' "newer modification wins" rule inside Obsidian's
   * config folder; never used for chain ordering.
   */
  mtimeMs: number;
  action: SyncAction;
  /** The client's self-declared label at the time of this push. */
  deviceName?: string | null;
  /** The chain head this push was decided from (`null` = the client expects none). */
  baseVersionId: string | null;
  /**
   * What kind of file the version belongs to (`documents` = markdown/canvas). Stored on
   * the row: the vault-wide trim maps it to the vault's limit, including for chains no
   * device pushes again.
   */
  historyKind: HistoryKind;
  /**
   * How many versions of this chain the server keeps after appending this one (the newest
   * N, this version included). Resolved by the handler from the **vault's** limits and the
   * version's kind; this is what the insert transaction trims against.
   */
  historyLimit: number;
}

export type TryInsertFileVersionResult =
  | {
      status: "ok";
      /**
       * Content hashes of the rows a history trim removed, if any: the store may have
       * to reclaim those blobs once the transaction committed (see
       * {@link SyncPushDeps.isContentHashReferenced}).
       */
      prunedContentHashes?: string[];
    }
  | { status: "stale_base"; currentVersionId: string };

/**
 * Append a batch of versions **only if each chain's head is still the one its push
 * was decided from** — and do every head read and insert in one transaction.
 *
 * This is the authoritative half of the conditional push. The handler's
 * {@link GetLatestVersionIdsFn} read is only a fast path that keeps an ordinary
 * refusal from writing a blob at all; it cannot be authoritative, because the blob
 * writes between it and the insert are real asynchronous I/O. Two pushes that both
 * read the same head — the same device firing two events in a row, two devices
 * editing at once, an earlier push held up by a large file's blob write — would
 * then both be appended, and the chain's head would be whichever *finished* last
 * rather than whichever was decided from the newer head.
 *
 * The check that decides therefore belongs in the same transaction as the row it
 * guards, and the transaction covers the **whole batch**: a first bind is hundreds
 * of batches of 100 files, and a commit per file cost ~0.9 ms of fsync per file
 * (measured; see `docs/first-bind-performance.md`). One synchronous transaction on
 * the `bun:sqlite` driver runs to completion in a single tick (an `await` inside it
 * does not typecheck), which is what makes the batch atomic against every other
 * request while still refusing a stale row individually.
 */
export type TryInsertFileVersionsFn = (
  rows: InsertFileVersionData[],
) => Promise<TryInsertFileVersionResult[]>;

/**
 * One version row as the server reads it: `createdAt` is a `Date` (the column
 * stores ISO text) and `action` is the shared enum.
 */
export interface DbVersionRow {
  versionId: string;
  contentHash: string;
  encryptedPath: string;
  action: SyncAction;
  sizeBytes: number;
  /** Plaintext last modification time on the pushing device (ms since the epoch). */
  mtimeMs: number;
  deviceName: string | null;
  createdAt: Date;
}

/**
 * The **heads** of many chains at once — one query for a push batch instead of
 * one per file.
 *
 * The head is the last row of {@link GetVersionChainFn} (`created_at`, then
 * `rowid`), and the cheap pre-check of a conditional push uses it to refuse a
 * push that is already known to be stale before a blob is written. It is not what
 * makes the push safe — see {@link TryInsertFileVersionFn}. A fileId with no row
 * at all is simply absent from the map.
 */
export type GetLatestVersionIdsFn = (
  vaultId: string,
  fileIds: string[],
) => Promise<Map<string, string>>;

/**
 * One file's version chain, oldest → newest. The **last** entry is the file's head,
 * and it has to be the same row the conditional insert treats as the head
 * (`created_at`, then `rowid`): a client takes its `baseVersionId` from the last
 * entry, so a chain that ordered a tie differently would have every push refused.
 */
export type GetVersionChainFn = (vaultId: string, fileId: string) => Promise<DbVersionRow[]>;

export type ListFilesByVaultIdFn = (vaultId: string) => Promise<
  Array<{
    fileId: string;
    currentVersionId: string;
    currentContentHash: string;
    encryptedPath: string;
    versions: DbVersionRow[];
  }>
>;

/**
 * One row per chain: its head, plus the last live version when the head is a `delete`.
 *
 * This is the engine's cold-start read. It needs the head to decide a file, and the
 * previous live version only to compare a tombstone against the content on disk; every
 * other version is for the history UI, not for a sync pass.
 */
export type ListFileHeadsByVaultIdFn = (vaultId: string) => Promise<
  Array<{
    fileId: string;
    head: DbVersionRow;
    previousLive: DbVersionRow | null;
  }>
>;

/**
 * The **last two rows** of every chain that ends in a `delete` — the tombstone and
 * the version it removed, which is exactly what the recycle bin shows and the only
 * thing it can restore.
 *
 * A dedicated query rather than "read every chain and look at its tail": a vault's
 * history is pulled on every reconcile, but the recycle bin only ever needs these
 * two rows per deleted file.
 */
export type ListDeletedChainsFn = (vaultId: string) => Promise<
  Array<{
    fileId: string;
    /** The restorable version — null when the chain holds nothing but the tombstone. */
    previous: DbVersionRow | null;
    last: DbVersionRow;
  }>
>;

export type WriteBlobFn = (vaultId: string, contentHash: string, data: Uint8Array) => Promise<void>;
export type HasBlobFn = (vaultId: string, contentHash: string) => Promise<boolean>;
export type DeleteBlobFn = (vaultId: string, contentHash: string) => Promise<void>;

/**
 * Turn a complete staged chunk upload into a stored blob.
 *
 * Answers `false` when the parts are absent, incomplete, or describe a different
 * plaintext than the version row — the push then carries `chunk_missing` and nothing is
 * inserted. See `lib/blob-store.ts`'s `assembleUploadedChunks`.
 */
export type AssembleChunksFn = (
  vaultId: string,
  contentHash: string,
  chunkCount: number,
  plaintextSize: number,
) => Promise<boolean>;

export type ListDeletedFileIdsFn = (
  vaultId: string,
) => Promise<Array<{ fileId: string; contentHashes: string[] }>>;

export type DeleteFileVersionsByFileIdsFn = (vaultId: string, fileIds: string[]) => Promise<void>;

export type GetReferencedContentHashesFn = (vaultId: string) => Promise<Set<string>>;

/**
 * Whether any remaining version row of this vault still names `contentHash`.
 *
 * The one question a history trim has to ask before reclaiming a blob: the same bytes
 * may also be another file's content, and the blob must stay for as long as one row
 * points at it.
 */
export type IsContentHashReferencedFn = (vaultId: string, contentHash: string) => Promise<boolean>;

/** Where a version this push appended is announced (the WebSocket hub). */
export type BroadcastFilePushedFn = (
  vaultId: string,
  fileId: string,
  versionId: string,
  excludeSessionId?: string,
  deviceName?: string | null,
) => void;

// ── Internal helpers ──

function generateId(): string {
  return crypto
    .getRandomValues(new Uint8Array(32))
    .toBase64({ alphabet: "base64url", omitPadding: true });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

// ── Push handler ──

export interface SyncPushInput {
  vaultId: string;
  /**
   * The **vault's** retention limits, read from its row when the request was authorized.
   *
   * They are the policy the trim applies, not something the pusher states: a device only
   * classifies its file (`historyKind`), so every device of the vault is trimmed by the
   * same numbers and changing them on one device changes them for all.
   */
  historyLimits: HistoryLimits;
  excludeSessionId?: string;
  /**
   * The label the pushing client stated for itself (`null` when it stated none).
   * Stored on every version row this push appends and passed on in the peers'
   * `file_pushed` notification — display metadata, never an identity.
   */
  deviceName?: string | null;
  files: Array<{
    fileId: string;
    encryptedPath: string;
    action: SyncAction;
    versionId: string;
    contentHash: string;
    /** Plaintext size of the version (`0` when it carries no content). */
    sizeBytes: number;
    /**
     * Plaintext last modification time of the file on the pushing device (ms since the
     * epoch); for a `delete`, the moment that device decided on the deletion.
     */
    mtimeMs: number;
    /** The head this push was decided from (`null` = the client expects no chain). */
    baseVersionId: string | null;
    /**
     * What kind of file this version belongs to (`documents` = markdown/canvas). The
     * client states it because only the plaintext path can say; the server maps it to the
     * vault's own limit. See `@courier/shared`'s `wire.ts`.
     */
    historyKind: HistoryKind;
    /**
     * The encrypted payload (`iv ‖ ciphertext ‖ tag`), or `null` when the version
     * carries none: a `delete`, a `rename` whose content the store already holds, or a
     * version whose bytes arrived through the chunk endpoints.
     */
    content: Uint8Array | null;
    /** Chunks staged under `contentHash`; `0`/absent for a normal payload. */
    contentChunks?: number;
  }>;
}

/** Everything a push needs, injected — including where its versions are announced. */
export interface SyncPushDeps {
  writeBlob: WriteBlobFn;
  tryInsertFileVersions: TryInsertFileVersionsFn;
  getLatestVersionIds: GetLatestVersionIdsFn;
  hasBlob: HasBlobFn;
  /** Assemble a chunked upload into a blob before the row is inserted. */
  assembleChunks: AssembleChunksFn;
  /**
   * Make every blob written for this batch durable, before any row names it.
   *
   * One call per batch, not one per file: the batch file is flushed once, which is what
   * the store trades for the per-blob `fsync` (see `docs/blob-files.md`).
   */
  flushBlobs: (vaultId: string) => Promise<void>;
  /** The WebSocket hub. A push with nowhere to announce itself still writes. */
  broadcast: BroadcastFilePushedFn;
  /**
   * Whether a version row (of any chain) still names a content hash — what the blob
   * reclaim after a history trim asks before it deletes anything.
   */
  isContentHashReferenced: IsContentHashReferencedFn;
  /** Remove one blob (its row, and its batch file with the last row). */
  deleteBlob: DeleteBlobFn;
  /**
   * Drop the cached per-user storage measurement because a trim reclaimed bytes.
   *
   * A route caches usage for a window so a push does not re-walk the store for every
   * request; adding the incoming bytes keeps that cache honest, but a trim removes bytes,
   * and a cache that still counts them can refuse a push the account now has room for.
   * Optional: a host that does not cache usages omits it.
   */
  invalidateStorageUsage?: () => void;
}

/**
 * Delete the blobs a history trim left without a version row.
 *
 * The trim runs inside the insert transaction, so this happens after the commit: the
 * rows a chain no longer holds are gone, and a hash none of the remaining rows names is
 * unreachable content. The reference is re-checked here rather than trusted from the
 * commit — the same bytes may be another file's content (a copy of one image), and that
 * chain must keep its blob.
 *
 * Best-effort on purpose: the push itself has already landed, and a blob this cannot
 * delete is reclaimed by the orphan sweep (which looks for exactly this: a blob no
 * version row names). Turning a reclaim failure into a failed push would report a
 * version as lost after it was stored.
 */
async function reclaimUnreferencedBlobs(
  vaultId: string,
  contentHashes: ReadonlySet<string>,
  deps: Pick<SyncPushDeps, "isContentHashReferenced" | "deleteBlob">,
): Promise<void> {
  for (const contentHash of contentHashes) {
    try {
      if (await deps.isContentHashReferenced(vaultId, contentHash)) continue;
      await deps.deleteBlob(vaultId, contentHash);
    } catch {
      // See the doc comment: the orphan sweep is the backstop, not a second bug.
    }
  }
}

/**
 * Apply one push batch.
 *
 * Three phases, in this order:
 *
 * 1. **Pre-check and content, per file.** A stale base is refused before its blob is
 *    written; a payload is stored (or a chunked upload assembled) only for a file
 *    whose head still matches. A refusal here writes no row. The store work of the
 *    batch runs **concurrently** — one request is at most 100 files, and a serial
 *    `writeBlob` per file made a first bind pay one store round trip after another.
 * 2. **One transaction for every row that survived phase 1.**
 *    {@link TryInsertFileVersionsFn} re-checks each head inside it, so a push that
 *    raced another writer is refused per row rather than appended. A database failure
 *    fails the **whole pending batch**: the transaction is all-or-nothing, so every row
 *    that reached the insert is reported failed — not the per-file answer a per-file
 *    insert gave, where only the file being written could fail. A row refused in phase 1
 *    is unaffected either way: it was decided before the transaction and wrote nothing.
 *    The same transaction **trims each chain** to the limit resolved from the vault's own
 *    values and the version's kind, and the blobs whose last row that trim removed are
 *    reclaimed right after the commit ({@link reclaimUnreferencedBlobs}).
 * 3. **Announce what landed, after the commit.** Broadcasting inside the transaction
 *    would tell a peer about a version a later rollback erased.
 *
 * The split matters for a first bind: the old loop committed once per file, so a
 * 100-file batch spent ~90 ms of its ~130 ms in fsyncs (see
 * `docs/first-bind-performance.md`).
 */
export async function handleSyncPush(
  input: SyncPushInput,
  deps: SyncPushDeps,
): Promise<SyncPushResponse> {
  const results: Array<SyncPushResult | null> = input.files.map(() => null);

  // One query for the whole batch. A batch the database cannot even read is
  // answered per file, the way a single-file read failure always was: the client
  // reports which files did not land, rather than the whole request 500-ing.
  let heads: Map<string, string>;
  try {
    heads = await deps.getLatestVersionIds(
      input.vaultId,
      input.files.map((file) => file.fileId),
    );
  } catch (err) {
    const error = errorMessage(err);
    return {
      results: input.files.map((file) => ({ fileId: file.fileId, status: "error", error })),
    };
  }

  // Phase 1 — everything that can be decided or transferred without the database.
  //
  // The store half is split from the decision half so a batch's blobs are written
  // **concurrently**: one request carries at most `MAX_PUSH_BATCH_FILES` files, and
  // writing them one after another made a first bind cost one store round trip per
  // file (see `docs/first-bind-performance.md`). Presence checks run after every write,
  // so a `rename` that shares its bytes with a `create` in the same batch still finds
  // them.
  const staged: Array<{
    index: number;
    file: (typeof input.files)[number];
    row: InsertFileVersionData;
  }> = [];
  for (const [index, file] of input.files.entries()) {
    try {
      // Cheap pre-check: the version must still be the head this client decided
      // from, or the push would overwrite a version it has never seen. Nothing is
      // written for a file refused here — no blob, no row, no broadcast — so the
      // client can pull, decide again and push with a base that is accepted.
      //
      // A fileId the vault holds no version for is accepted whatever the base says:
      // there is nothing to overwrite (the chain can have been emptied by the
      // recycle bin or by retention), and refusing would leave a client holding a
      // versionId for a chain that no longer exists unable to ever push again.
      const currentVersionId = heads.get(file.fileId);
      if (currentVersionId !== undefined && currentVersionId !== file.baseVersionId) {
        results[index] = { fileId: file.fileId, status: "stale_base", currentVersionId };
        continue;
      }

      // A delete carries no content: writing one would put garbage into the
      // content-addressed store under the hash of an empty string, which two
      // unrelated deletions would then share. A version whose content arrived through
      // the chunk endpoints has none here either — the staged parts are assembled into
      // the blob first, and a half-uploaded file is refused rather than inserted. And a
      // version that carries no content for any other reason (a `rename` reusing bytes
      // the store already holds) is only meaningful while the store really holds that
      // hash: accept it when it does, refuse it when it does not, so a chain can never
      // end up pointing at content no peer will ever be able to fetch.
      if (file.action !== "delete" && file.content !== null) {
        // The payload is `iv(12) ‖ plaintext ‖ tag(16)`, so its length has to agree
        // with the row's plaintext size: a peer sizes its read ranges and buffers from
        // that number, and a client must not be able to under- or over-report it.
        const contentChunks = file.contentChunks ?? 0;
        if (contentChunks > 0 || file.content.byteLength !== file.sizeBytes + 28) {
          results[index] = { fileId: file.fileId, status: "error", error: "size_mismatch" };
          continue;
        }
      }
      staged.push({
        index,
        file,
        row: {
          id: generateId(),
          vaultId: input.vaultId,
          fileId: file.fileId,
          encryptedPath: file.encryptedPath,
          versionId: file.versionId,
          contentHash: file.contentHash,
          sizeBytes: file.sizeBytes,
          mtimeMs: file.mtimeMs,
          action: file.action,
          deviceName: input.deviceName ?? null,
          baseVersionId: file.baseVersionId,
          historyKind: file.historyKind,
          // The vault's policy, not the pusher's: the file's kind picks the number.
          historyLimit: input.historyLimits[file.historyKind],
        },
      });
    } catch (err) {
      results[index] = { fileId: file.fileId, status: "error", error: errorMessage(err) };
    }
  }

  // Phase 1b — the store, concurrently across the batch. Writes and assemblies run
  // first and presence checks second, so a `rename` in this batch finds the bytes a
  // `create` in the same batch wrote. Each file answers for itself: one failed or
  // refused blob must not fail the rest of the batch.
  type StoreVerdict = NonNullable<(typeof results)[number]>;
  const storeVerdicts = new Map<number, StoreVerdict>();
  await Promise.all(
    staged.map(async (entry) => {
      const { file } = entry;
      if (file.action === "delete") return;
      const contentChunks = file.contentChunks ?? 0;
      try {
        if (file.content !== null) {
          await deps.writeBlob(input.vaultId, file.contentHash, file.content);
        } else if (contentChunks > 0) {
          const assembled = await deps.assembleChunks(
            input.vaultId,
            file.contentHash,
            contentChunks,
            file.sizeBytes,
          );
          if (!assembled) {
            storeVerdicts.set(entry.index, {
              fileId: file.fileId,
              status: "error",
              error: "chunk_missing",
            });
          }
        }
      } catch (err) {
        storeVerdicts.set(entry.index, {
          fileId: file.fileId,
          status: "error",
          error: errorMessage(err),
        });
      }
    }),
  );
  await Promise.all(
    staged.map(async (entry) => {
      const { file } = entry;
      // Only a version that carries no content and no chunks needs the store checked.
      if (file.action === "delete" || file.content !== null) return;
      if ((file.contentChunks ?? 0) > 0) return;
      if (storeVerdicts.has(entry.index)) return;
      try {
        if (!(await deps.hasBlob(input.vaultId, file.contentHash))) {
          storeVerdicts.set(entry.index, { fileId: file.fileId, status: "content_missing" });
        }
      } catch (err) {
        storeVerdicts.set(entry.index, {
          fileId: file.fileId,
          status: "error",
          error: errorMessage(err),
        });
      }
    }),
  );

  const pending: Array<{ index: number; row: InsertFileVersionData }> = [];
  // Phase 1c — the batch's bytes become durable before any row names them. A flush that
  // fails fails the files whose content it held: a version must never be inserted for
  // bytes that are not on disk.
  if (staged.length > 0) {
    try {
      await deps.flushBlobs(input.vaultId);
    } catch (err) {
      const error = errorMessage(err);
      for (const entry of staged) {
        results[entry.index] = { fileId: entry.file.fileId, status: "error", error };
      }
      return {
        results: results.map(
          (result, index) =>
            result ?? {
              fileId: input.files[index]!.fileId,
              status: "error",
              error: "not processed",
            },
        ),
      };
    }
  }
  for (const entry of staged) {
    const verdict = storeVerdicts.get(entry.index);
    if (verdict !== undefined) {
      results[entry.index] = verdict;
    } else {
      pending.push({ index: entry.index, row: entry.row });
    }
  }

  // Phase 2 — the authoritative, conditional insert, one transaction for the batch.
  //
  // The same transaction trims every chain to the vault's limits (chosen by each version's
  // kind), and answers the content hashes of the rows it removed (see
  // `tryInsertFileVersions`).
  const prunedContentHashes = new Set<string>();
  if (pending.length > 0) {
    let inserted: TryInsertFileVersionResult[];
    try {
      inserted = await deps.tryInsertFileVersions(pending.map((entry) => entry.row));
    } catch (err) {
      const error = errorMessage(err);
      for (const entry of pending) {
        results[entry.index] = { fileId: input.files[entry.index]!.fileId, status: "error", error };
      }
      inserted = [];
    }
    for (const [slot, verdict] of inserted.entries()) {
      const entry = pending[slot];
      if (!entry) continue;
      const file = input.files[entry.index]!;
      if (verdict.status === "stale_base") {
        results[entry.index] = {
          fileId: file.fileId,
          status: "stale_base",
          currentVersionId: verdict.currentVersionId,
        };
        continue;
      }
      for (const contentHash of verdict.prunedContentHashes ?? []) {
        prunedContentHashes.add(contentHash);
      }
      results[entry.index] = {
        fileId: file.fileId,
        status: "ok",
        versionId: file.versionId,
        contentHash: file.contentHash,
      };
    }
  }

  // Phase 2b — reclaim what the trim orphaned, after the commit. A blob whose hash no
  // remaining version row names is dead bytes: the chain that named it was just cut
  // back, and the store keeps content addressed blobs, so the row (and its batch file,
  // when it was the last one in it) has to go too.
  await reclaimUnreferencedBlobs(input.vaultId, prunedContentHashes, deps);
  // The trim removed rows, so whatever the route had cached about this user's storage is
  // now an overcount: drop it and let the next check measure again.
  if (prunedContentHashes.size > 0) deps.invalidateStorageUsage?.();

  // Phase 3 — announce the versions that committed, and nothing else.
  for (const [index, result] of results.entries()) {
    if (result?.status !== "ok") continue;
    const file = input.files[index]!;
    deps.broadcast(
      input.vaultId,
      file.fileId,
      file.versionId,
      input.excludeSessionId,
      input.deviceName,
    );
  }

  return {
    results: results.map(
      (result, index) =>
        result ?? { fileId: input.files[index]!.fileId, status: "error", error: "not processed" },
    ),
  };
}

// ── Pull handler ──

export interface SyncPullInput {
  vaultId: string;
  files: Array<{ fileId: string }>;
}

export async function handleSyncPull(
  input: SyncPullInput,
  getVersionChain: GetVersionChainFn,
): Promise<SyncPullResponse> {
  const result: SyncPullResponse["files"] = [];

  for (const f of input.files) {
    const versions = await getVersionChain(input.vaultId, f.fileId);
    // The chain's own last row records the path the file lives at now — the same
    // row the head check reads, so the two can never disagree about "latest".
    const head = versions.at(-1);
    result.push({
      fileId: f.fileId,
      encryptedPath: head?.encryptedPath ?? "",
      versions: versions.map((v) => ({
        versionId: v.versionId,
        contentHash: v.contentHash,
        // Each version's own path: lets a client place a file it has never seen
        // and follow renames straight from the chain.
        encryptedPath: v.encryptedPath,
        action: v.action,
        sizeBytes: v.sizeBytes,
        mtimeMs: v.mtimeMs,
        createdAt: v.createdAt.toISOString(),
      })),
    });
  }

  return { files: result };
}

// ── Version content ──

// The content route streams the stored blob and resolves `Range` itself
// (`routes/sync.ts`, `lib/byte-range.ts`): it needs the file's size before it answers,
// so a handler that returned the whole `Uint8Array` would only put the file back in
// the server's memory. There is deliberately no handler for it.

// ── File version history ──

export async function getFileVersionHistory(
  vaultId: string,
  fileId: string,
  getVersionChain: GetVersionChainFn,
): Promise<FileVersionHistoryResponse> {
  const versions = await getVersionChain(vaultId, fileId);
  if (versions.length === 0) throw new NotFoundError("File");
  return {
    versions: versions.map((v) => ({
      versionId: v.versionId,
      contentHash: v.contentHash,
      encryptedPath: v.encryptedPath,
      action: v.action,
      sizeBytes: v.sizeBytes,
      mtimeMs: v.mtimeMs,
      deviceName: v.deviceName,
      createdAt: v.createdAt.toISOString(),
    })),
  };
}

// ── Vault sync history ──

export async function getVaultSyncHistory(
  vaultId: string,
  listFilesByVaultId: ListFilesByVaultIdFn,
): Promise<VaultSyncHistoryResponse> {
  const files = await listFilesByVaultId(vaultId);
  return {
    files: files.map((f) => ({
      fileId: f.fileId,
      encryptedPath: f.encryptedPath,
      currentVersionId: f.currentVersionId,
      currentContentHash: f.currentContentHash,
      versions: f.versions.map((v) => ({
        versionId: v.versionId,
        contentHash: v.contentHash,
        encryptedPath: v.encryptedPath,
        action: v.action,
        sizeBytes: v.sizeBytes,
        mtimeMs: v.mtimeMs,
        deviceName: v.deviceName,
        createdAt: v.createdAt.toISOString(),
      })),
    })),
  };
}

// ── Vault sync index ──

/** One version row as the wire carries it — no `deviceName`: the engine never reads it. */
function toChainEntry(row: DbVersionRow): VersionChainEntry {
  return {
    versionId: row.versionId,
    contentHash: row.contentHash,
    encryptedPath: row.encryptedPath,
    action: row.action,
    sizeBytes: row.sizeBytes,
    mtimeMs: row.mtimeMs,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The engine's cold-start index: one row per chain, not every version.
 *
 * A pass decides from the chain's head, and only a tombstone needs one more row (the
 * last live version, to compare with the local content). `/sync/history` stays as the
 * UI's full history — it is opened on demand, while this is read by every client on
 * every pass.
 */
export async function getVaultSyncIndex(
  vaultId: string,
  listFileHeadsByVaultId: ListFileHeadsByVaultIdFn,
): Promise<VaultSyncIndexResponse> {
  const chains = await listFileHeadsByVaultId(vaultId);
  return {
    files: chains.map(({ fileId, head, previousLive }) => ({
      fileId,
      head: toChainEntry(head),
      previousLive: previousLive === null ? null : toChainEntry(previousLive),
    })),
  };
}

// ── List deleted files ──

export interface ListDeletedFilesInput {
  vaultId: string;
}

/**
 * List all deleted files of a vault for the recycle bin UI.
 *
 * A file is "deleted" when its version chain's last action is "delete" — which the
 * query behind {@link ListDeletedChainsFn} already selected on. For each such file
 * the response carries the last non-delete version's encrypted path / version id /
 * content hash (the restorable state) plus the delete event timestamp. Everything
 * is derived from the version chain — no tombstone table is needed.
 */
export async function listDeletedFiles(
  input: ListDeletedFilesInput,
  listDeletedChains: ListDeletedChainsFn,
): Promise<ListDeletedFilesResponse> {
  const chains = await listDeletedChains(input.vaultId);
  const deleted: DeletedFileInfo[] = chains.map(({ fileId, previous, last }) => ({
    fileId,
    lastEncryptedPath: previous?.encryptedPath ?? null,
    previousVersionId: previous?.versionId ?? null,
    previousContentHash: previous?.contentHash ?? null,
    previousSizeBytes: previous?.sizeBytes ?? null,
    deletedByDeviceName: last.deviceName,
    deletedAt: last.createdAt.toISOString(),
  }));

  return { files: deleted };
}

// ── Clear deleted files ──

export interface ClearDeletedInput {
  vaultId: string;
}

/** Everything a clear needs, injected. */
export interface ClearDeletedDeps {
  listDeletedFileIds: ListDeletedFileIdsFn;
  deleteFileVersionsByFileIds: DeleteFileVersionsByFileIdsFn;
  getReferencedContentHashes: GetReferencedContentHashesFn;
  deleteBlob: DeleteBlobFn;
}

/**
 * Clear all deleted files and their unreferenced blobs from a vault.
 *
 * 1. Finds all fileIds whose version chain ends with "delete"
 * 2. Collects all contentHashes from those files' versions
 * 3. Deletes every one of those fileIds' rows in a single transaction
 * 4. For each contentHash, checks if it's still referenced by any remaining row
 * 5. Deletes unreferenced blobs from disk
 *
 * The rows go first and in one statement: a half-cleared recycle bin (some chains
 * removed, the request failed) would leave the UI showing files whose versions are
 * already gone.
 */
export async function handleClearDeleted(
  input: ClearDeletedInput,
  deps: ClearDeletedDeps,
): Promise<ClearDeletedResponse> {
  const deletedFiles = await deps.listDeletedFileIds(input.vaultId);
  if (deletedFiles.length === 0) {
    return { deletedFiles: 0, deletedBlobs: 0 };
  }

  // Collect all contentHashes from deleted files before removing rows
  const allContentHashes = new Set<string>();
  for (const f of deletedFiles) {
    for (const hash of f.contentHashes) {
      allContentHashes.add(hash);
    }
  }

  const fileIds = deletedFiles.map((f) => f.fileId);

  // Remove every row of every deleted chain, atomically.
  await deps.deleteFileVersionsByFileIds(input.vaultId, fileIds);

  // Garbage-collect unreferenced blobs
  const referencedHashes = await deps.getReferencedContentHashes(input.vaultId);
  let deletedBlobs = 0;
  for (const hash of allContentHashes) {
    if (!referencedHashes.has(hash)) {
      await deps.deleteBlob(input.vaultId, hash);
      deletedBlobs++;
    }
  }

  return { deletedFiles: fileIds.length, deletedBlobs };
}

/** What one batch content request asks for. */
export interface SyncContentsInput {
  vaultId: string;
  /** The versions' content hashes, in the order the client wants them back. */
  hashes: readonly string[];
}

/** Open one stored blob — `openBlobReader`, injected so the handler owns no fs call. */
export type OpenBlobReaderFn = (
  vaultId: string,
  contentHash: string,
) => Promise<BlobReader | undefined>;

/**
 * The batch content route's work: the ciphertext of several versions in one frame.
 *
 * A download used to be one request per file, which was the last per-file round trip on
 * the sync path (`docs/first-bind-performance.md`). The frame is the one
 * `buildContentBatchBody` writes; a hash the store no longer holds is an ordinary `null`
 * entry — the same answer a `404` gives for one version — so a reclaimed blob does not fail
 * the whole batch. The answer is bounded: the request may name
 * `MAX_CONTENT_BATCH_FILES` hashes (the route's schema), and the bytes it may carry are
 * capped here, before the body exists.
 */
export async function handleSyncContents(
  input: SyncContentsInput,
  openBlobReader: OpenBlobReaderFn,
  maxBytes: number = MAX_CONTENT_BATCH_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
  const entries: Array<Uint8Array | null> = [];
  let total = 0;
  for (const contentHash of input.hashes) {
    const reader = await openBlobReader(input.vaultId, contentHash);
    if (reader === undefined) {
      entries.push(null);
      continue;
    }
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    try {
      bytes = await reader.readAll();
    } finally {
      await reader.close();
    }
    if (bytes === undefined) {
      entries.push(null);
      continue;
    }
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new PayloadTooLargeError(`content batch exceeds ${maxBytes} bytes`);
    }
    entries.push(bytes);
  }
  return buildContentBatchBody(entries);
}
