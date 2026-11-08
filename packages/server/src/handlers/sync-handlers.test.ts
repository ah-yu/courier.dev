import { describe, expect, it, vi } from "vitest";
import {
  handleSyncPush as handleSyncPushWithDeps,
  handleSyncPull as handleSyncPullWithChain,
  handleSyncContents,
  getFileVersionHistory,
  getVaultSyncHistory,
  getVaultSyncIndex,
  listDeletedFiles,
} from "./sync-handlers";
import type {
  InsertFileVersionData,
  TryInsertFileVersionsFn,
  TryInsertFileVersionResult,
  GetVersionChainFn,
  GetLatestVersionIdsFn,
  ListFilesByVaultIdFn,
  ListFileHeadsByVaultIdFn,
  ListDeletedChainsFn,
  WriteBlobFn,
  HasBlobFn,
  SyncPullInput,
  SyncPushInput,
} from "./sync-handlers";
import type { SyncPushResponse } from "@courier/shared";
import { DEFAULT_HISTORY_LIMITS, type HistoryLimits } from "@courier/shared";
import { PayloadTooLargeError } from "../lib/errors";
import type { BlobReader } from "../lib/blob-store";
import { parseContentBatchBody } from "@courier/shared";

/** A blob reader that answers `payload` (or `undefined`) and records its calls. */
function blobReader(payload: Uint8Array | undefined): BlobReader & {
  readAll: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    stat: { size: payload?.byteLength ?? 0 },
    readAll: vi.fn(async () => payload),
    close: vi.fn(async () => {}),
  } as unknown as BlobReader & {
    readAll: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}
import { NotFoundError } from "../lib/errors";

/**
 * The cases below were written against a handler that asked for one chain head at a
 * time; it now reads the whole batch in one query and takes its dependencies as an
 * object. This adapter keeps them about the **protocol** rather than about argument
 * order 鈥?the batch shape and the announcement have their own case at the end of
 * the push block.
 */
type SingleHeadLookup = (vaultId: string, fileId: string) => Promise<string | undefined>;

/**
 * One row's verdict, as these cases assert it.
 *
 * The real dependency inserts a **batch** in one transaction (`TryInsertFileVersionsFn`);
 * the wrapper below still calls a per-row mock once per row, so every case here stays
 * about the protocol and the per-row verdict rather than about array plumbing. The
 * batch shape itself has its own case at the end of the push block.
 */
type RowInsert = (row: InsertFileVersionData) => Promise<TryInsertFileVersionResult>;

function handleSyncPush(
  input: SyncPushInput,
  writeBlob: WriteBlobFn,
  tryInsertFileVersion: RowInsert,
  getLatestVersionId: SingleHeadLookup,
  hasBlob: HasBlobFn,
): Promise<SyncPushResponse> {
  return handleSyncPushWithDeps(input, {
    writeBlob,
    tryInsertFileVersions: async (rows) =>
      Promise.all(rows.map((row) => tryInsertFileVersion(row))),
    hasBlob,
    assembleChunks: vi.fn().mockResolvedValue(true),
    flushBlobs: vi.fn(async () => {}),
    getLatestVersionIds: async (vaultId, fileIds) => {
      const heads = new Map<string, string>();
      for (const fileId of fileIds) {
        const head = await getLatestVersionId(vaultId, fileId);
        if (head !== undefined) heads.set(fileId, head);
      }
      return heads;
    },
    broadcast: vi.fn(),
    isContentHashReferenced: vi.fn(async () => false),
    deleteBlob: vi.fn(async () => {}),
  });
}

/** The same, for a pull that no longer needs a second lookup: the chain's tail is the path. */
function handleSyncPull(
  input: SyncPullInput,
  getVersionChain: GetVersionChainFn,
): ReturnType<typeof handleSyncPullWithChain> {
  return handleSyncPullWithChain(input, getVersionChain);
}

/** A ciphertext payload, as the frame carries it: raw bytes. */
function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * A payload shaped like a real one: the 12-byte IV and 16-byte tag precede the
 * plaintext, so its length is `plaintext bytes + 28` 鈥?what the handler now checks
 * against the row's `sizeBytes`.
 */
function cipher(text: string): Uint8Array {
  const plain = bytes(text);
  const payload = new Uint8Array(plain.byteLength + 28);
  payload.set(plain, 28);
  return payload;
}

function makeDate(iso: string): Date {
  return new Date(iso);
}

/** A store that holds nothing 鈥?the answer for a first push. */
function storesNothing(): HasBlobFn {
  return vi.fn<HasBlobFn>().mockResolvedValue(false);
}

/** A store that already holds every hash 鈥?the answer a `rename` relies on. */
function storesEveryHash(): HasBlobFn {
  return vi.fn<HasBlobFn>().mockResolvedValue(true);
}

/** A server whose chain for every fileId is empty (`null` base is the only match). */
function noVersionsYet(): SingleHeadLookup {
  return vi.fn<SingleHeadLookup>().mockResolvedValue(undefined);
}

/**
 * A conditional insert that accepts everything the pre-check let through 鈥?the shape
 * of a fix-free path, used by the cases that are about the handler's plumbing.
 */
function acceptsEveryInsert(): RowInsert {
  return vi.fn<RowInsert>().mockResolvedValue({ status: "ok" });
}

const mkRow = (
  versionId: string,
  action: "create" | "modify" | "rename" | "delete" | "restore",
  iso: string,
) => ({
  versionId,
  contentHash: `hash-${versionId}`,
  encryptedPath: `path-${versionId}`,
  action,
  sizeBytes: 12,
  mtimeMs: 1_760_000_000_000,
  deviceName: "device-a",
  createdAt: new Date(iso),
});

describe("handleSyncPush", () => {
  it("inserts a file version", async () => {
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersion = vi.fn<RowInsert>().mockResolvedValue({ status: "ok" });
    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-001",
            encryptedPath: "enc_p1",
            content: cipher("enc_c1"),
            action: "create",
            versionId: "v001",
            contentHash: "hash001",
            sizeBytes: bytes("enc_c1").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      noVersionsYet(),
      storesNothing(),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0].status).toBe("ok");
    expect(writeBlob).toHaveBeenCalledWith("v1", "hash001", cipher("enc_c1"));
    expect(tryInsertFileVersion).toHaveBeenCalledTimes(1);
    // The base travels with the insert: that is what the transaction checks.
    expect(tryInsertFileVersion).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "f-001", versionId: "v001", baseVersionId: null }),
    );
  });

  it("refuses a payload whose length disagrees with the version's size", async () => {
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsert = vi.fn<RowInsert>().mockResolvedValue({ status: "ok" });

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-size",
            encryptedPath: "p",
            content: cipher("abc"),
            action: "create",
            versionId: "v-size",
            contentHash: "hash-size",
            // A peer would size its read from this number; it has to describe the bytes.
            sizeBytes: 99,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsert,
      noVersionsYet(),
      storesNothing(),
    );

    expect(result.results[0]).toMatchObject({ status: "error", error: "size_mismatch" });
    expect(writeBlob).not.toHaveBeenCalled();
    expect(tryInsert).not.toHaveBeenCalled();
  });

  it("refuses a file that carries content and chunks at once", async () => {
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsert = vi.fn<RowInsert>().mockResolvedValue({ status: "ok" });

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-both",
            encryptedPath: "p",
            content: cipher("abc"),
            contentChunks: 1,
            action: "create",
            versionId: "v-both",
            contentHash: "hash-both",
            sizeBytes: bytes("abc").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsert,
      noVersionsYet(),
      storesNothing(),
    );

    expect(result.results[0]).toMatchObject({ status: "error", error: "size_mismatch" });
    expect(writeBlob).not.toHaveBeenCalled();
  });

  it("stores the file's modification time with the version", async () => {
    // A config-folder conflict is settled by comparing this value with the peer's own
    // file stamp, so it has to survive the handler untouched.
    const tryInsertFileVersion = acceptsEveryInsert();
    await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-001",
            encryptedPath: "enc_p1",
            content: cipher("enc_c1"),
            action: "modify",
            versionId: "v002",
            contentHash: "hash002",
            sizeBytes: bytes("enc_c1").length,
            mtimeMs: 1_760_000_123_456,
            baseVersionId: "v001",
            historyKind: "documents",
          },
        ],
      },
      vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
      tryInsertFileVersion,
      vi.fn<SingleHeadLookup>().mockResolvedValue("v001"),
      storesNothing(),
    );

    expect(tryInsertFileVersion).toHaveBeenCalledWith(
      expect.objectContaining({ mtimeMs: 1_760_000_123_456 }),
    );
  });

  it("handles multiple files", async () => {
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersion = acceptsEveryInsert();
    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "a",
            content: cipher("ca"),
            action: "create",
            versionId: "v1",
            contentHash: "hash1",
            sizeBytes: bytes("ca").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
          {
            fileId: "f-2",
            encryptedPath: "b",
            content: cipher("cb"),
            action: "create",
            versionId: "v2",
            contentHash: "hash2",
            sizeBytes: bytes("cb").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      noVersionsYet(),
      storesNothing(),
    );
    expect(result.results).toHaveLength(2);
  });

  it("accepts a push whose base is the chain's head", async () => {
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersion = acceptsEveryInsert();
    const getLatestVersionId = vi.fn<SingleHeadLookup>().mockResolvedValue("v001");

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "p",
            content: cipher("c"),
            action: "modify",
            versionId: "v002",
            contentHash: "hash2",
            sizeBytes: bytes("c").length,
            mtimeMs: 0,
            baseVersionId: "v001",
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      getLatestVersionId,
      storesNothing(),
    );

    expect(result.results[0].status).toBe("ok");
    expect(tryInsertFileVersion).toHaveBeenCalledTimes(1);
  });

  it("refuses a push decided from a head the chain has moved past, writing nothing", async () => {
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersion = acceptsEveryInsert();
    // A peer pushed `v-peer` while this client was deciding from `v001`.
    const getLatestVersionId = vi.fn<SingleHeadLookup>().mockResolvedValue("v-peer");

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "p",
            content: cipher("c"),
            action: "modify",
            versionId: "v002",
            contentHash: "hash2",
            sizeBytes: bytes("c").length,
            mtimeMs: 0,
            baseVersionId: "v001",
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      getLatestVersionId,
      storesNothing(),
    );

    // The peer's version is not overwritten, and nothing of the refused push lands:
    // no blob, no row, no broadcast (the client pulls and decides again instead).
    expect(result.results).toEqual([
      { fileId: "f-1", status: "stale_base", currentVersionId: "v-peer" },
    ]);
    expect(writeBlob).not.toHaveBeenCalled();
    expect(tryInsertFileVersion).not.toHaveBeenCalled();
  });

  it("refuses a push the chain moved past while its blob was being written", async () => {
    // The pre-check saw the base as the head, so the blob is written 鈥?and the
    // authoritative insert, which runs after that asynchronous write, is what
    // refuses the push. This is the race one step further along than the test
    // above: without it, two pushes decided from the same head both land and the
    // chain's head becomes whichever *finished* last rather than the newer one.
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const staleRefusal: TryInsertFileVersionResult = {
      status: "stale_base",
      currentVersionId: "v-peer",
    };
    const tryInsertFileVersion = vi.fn<RowInsert>().mockResolvedValue(staleRefusal);
    const getLatestVersionId = vi.fn<SingleHeadLookup>().mockResolvedValue("v001");

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "p",
            content: cipher("c"),
            action: "modify",
            versionId: "v002",
            contentHash: "hash2",
            sizeBytes: bytes("c").length,
            mtimeMs: 0,
            baseVersionId: "v001",
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      getLatestVersionId,
      storesNothing(),
    );

    expect(result.results).toEqual([
      { fileId: "f-1", status: "stale_base", currentVersionId: "v-peer" },
    ]);
    expect(tryInsertFileVersion).toHaveBeenCalledTimes(1);
  });

  it("refuses a push that claims no chain where the vault has one", async () => {
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersion = acceptsEveryInsert();
    const getLatestVersionId = vi.fn<SingleHeadLookup>().mockResolvedValue("v-existing");

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "p",
            content: cipher("c"),
            action: "create",
            versionId: "v002",
            contentHash: "hash2",
            sizeBytes: bytes("c").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      getLatestVersionId,
      storesNothing(),
    );

    expect(result.results[0].status).toBe("stale_base");
    expect(tryInsertFileVersion).not.toHaveBeenCalled();
  });

  it("accepts a push for a chain the vault no longer has at all", async () => {
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersion = acceptsEveryInsert();
    // Emptied by the recycle bin or by retention: there is nothing to overwrite,
    // and refusing would leave a client holding a versionId it can never match.
    const getLatestVersionId = vi.fn<SingleHeadLookup>().mockResolvedValue(undefined);

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "p",
            content: cipher("c"),
            action: "restore",
            versionId: "v002",
            contentHash: "hash2",
            sizeBytes: bytes("c").length,
            mtimeMs: 0,
            baseVersionId: "v-gone",
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      getLatestVersionId,
      storesNothing(),
    );

    expect(result.results[0].status).toBe("ok");
    expect(tryInsertFileVersion).toHaveBeenCalledTimes(1);
  });

  it("accepts a content-less rename while the store holds those bytes", async () => {
    // The engine omits the payload for a `rename` whose content is already on the
    // chain under the same hash: the move is one small request instead of a second
    // upload of the whole file.
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersion = acceptsEveryInsert();
    const getLatestVersionId = vi.fn<SingleHeadLookup>().mockResolvedValue("v001");

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "moved",
            content: null,
            action: "rename",
            versionId: "v002",
            contentHash: "hash-of-the-same-bytes",
            sizeBytes: 6 * 1024 * 1024,
            mtimeMs: 0,
            baseVersionId: "v001",
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      getLatestVersionId,
      storesEveryHash(),
    );

    expect(result.results[0].status).toBe("ok");
    // Nothing is written 鈥?the store already has this content 鈥?but the plaintext
    // size still travels, so a peer applies its own size cap before pulling.
    expect(writeBlob).not.toHaveBeenCalled();
    expect(tryInsertFileVersion).toHaveBeenCalledWith(
      expect.objectContaining({ action: "rename", sizeBytes: 6 * 1024 * 1024 }),
    );
  });

  it("refuses a content-less push for bytes the store does not hold", async () => {
    // A chain head whose content nobody can fetch would leave every peer retrying
    // a pull that can never succeed, so the push is refused instead and the client
    // sends the payload with its next attempt.
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersion = acceptsEveryInsert();
    const getLatestVersionId = vi.fn<SingleHeadLookup>().mockResolvedValue("v001");

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "moved",
            content: null,
            action: "rename",
            versionId: "v002",
            contentHash: "hash-nobody-has",
            sizeBytes: 10,
            mtimeMs: 0,
            baseVersionId: "v001",
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      getLatestVersionId,
      storesNothing(),
    );

    expect(result.results).toEqual([{ fileId: "f-1", status: "content_missing" }]);
    expect(tryInsertFileVersion).not.toHaveBeenCalled();
    expect(writeBlob).not.toHaveBeenCalled();
  });

  it("writes no blob for a delete, whatever the frame carried", async () => {
    // Two unrelated deletions share the hash of an empty string, so a blob written
    // for one would be read back by the other as content that decrypts to nothing.
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersion = acceptsEveryInsert();
    const getLatestVersionId = vi.fn<SingleHeadLookup>().mockResolvedValue("v001");

    const result = await handleSyncPush(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "p",
            content: cipher("should never be stored"),
            action: "delete",
            versionId: "v002",
            contentHash: "hash-of-empty",
            sizeBytes: bytes("should never be stored").length,
            mtimeMs: 0,
            baseVersionId: "v001",
            historyKind: "documents",
          },
        ],
      },
      writeBlob,
      tryInsertFileVersion,
      getLatestVersionId,
      storesNothing(),
    );

    expect(result.results[0].status).toBe("ok");
    expect(writeBlob).not.toHaveBeenCalled();
  });
  it("reads every chain head of a batch in one query, and announces what it wrote", async () => {
    const writeBlob = vi.fn<WriteBlobFn>().mockResolvedValue(undefined);
    const tryInsertFileVersions = vi
      .fn<TryInsertFileVersionsFn>()
      .mockImplementation(async (rows) => rows.map(() => ({ status: "ok" })));
    const getLatestVersionIds = vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map());
    const broadcast = vi.fn();

    const result = await handleSyncPushWithDeps(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "a",
            content: cipher("ca"),
            action: "create",
            versionId: "v1",
            contentHash: "hash1",
            sizeBytes: bytes("ca").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
          {
            fileId: "f-2",
            encryptedPath: "b",
            content: cipher("cb"),
            action: "create",
            versionId: "v2",
            contentHash: "hash2",
            sizeBytes: bytes("cb").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
        ],
      },
      {
        writeBlob,
        tryInsertFileVersions,
        getLatestVersionIds,
        hasBlob: storesNothing(),
        assembleChunks: vi.fn().mockResolvedValue(true),
        flushBlobs: vi.fn(async () => {}),
        broadcast,
        isContentHashReferenced: vi.fn(async () => false),
        deleteBlob: vi.fn(async () => {}),
      },
    );

    expect(result.results.map((r) => r.status)).toEqual(["ok", "ok"]);
    // One query for the whole batch, not one per file.
    expect(getLatestVersionIds).toHaveBeenCalledTimes(1);
    expect(getLatestVersionIds).toHaveBeenCalledWith("v1", ["f-1", "f-2"]);
    // And one conditional insert for the whole batch: a commit per file is what made a
    // first bind cost ~0.9 ms of fsync per file (see `docs/first-bind-performance.md`).
    expect(tryInsertFileVersions).toHaveBeenCalledTimes(1);
    expect(tryInsertFileVersions).toHaveBeenCalledWith([
      expect.objectContaining({ fileId: "f-1", versionId: "v1" }),
      expect.objectContaining({ fileId: "f-2", versionId: "v2" }),
    ]);
    // Every accepted version is announced to the vault's subscribers, with the label
    // this push stated.
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith("v1", "f-1", "v1", undefined, undefined);
  });

  it("flushes the batch's bytes before any row that names them commits", async () => {
    // The durability contract, in the order the handler has to make the calls: a row that
    // exists must mean "the bytes survived a crash". Nothing asserted it before, so a
    // reordering that inserted the rows first would have passed every case here.
    const order: string[] = [];
    const writeBlob = vi.fn<WriteBlobFn>().mockImplementation(async () => {
      order.push("blob");
    });
    const flushBlobs = vi.fn(async () => {
      order.push("flush");
    });
    const tryInsertFileVersions = vi
      .fn<TryInsertFileVersionsFn>()
      .mockImplementation(async (rows) => {
        order.push("rows");
        return rows.map(() => ({ status: "ok" }));
      });

    const result = await handleSyncPushWithDeps(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "a",
            content: cipher("ca"),
            action: "create",
            versionId: "v1",
            contentHash: "hash1",
            sizeBytes: bytes("ca").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
        ],
      },
      {
        writeBlob,
        tryInsertFileVersions,
        getLatestVersionIds: vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map()),
        hasBlob: storesNothing(),
        assembleChunks: vi.fn().mockResolvedValue(true),
        flushBlobs,
        broadcast: vi.fn(),
        isContentHashReferenced: vi.fn(async () => false),
        deleteBlob: vi.fn(async () => {}),
      },
    );

    expect(result.results.map((r) => r.status)).toEqual(["ok"]);
    expect(flushBlobs).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["blob", "flush", "rows"]);
  });

  it("refuses one row of a batch without discarding the rows that landed", async () => {
    // The transaction answers per row: a peer pushed f-2's chain while this batch was
    // in flight, and the other two files must still be appended and announced.
    const tryInsertFileVersions = vi
      .fn<TryInsertFileVersionsFn>()
      .mockResolvedValue([
        { status: "ok" },
        { status: "stale_base", currentVersionId: "v-peer" },
        { status: "ok" },
      ]);
    const broadcast = vi.fn();

    const result = await handleSyncPushWithDeps(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: ["f-1", "f-2", "f-3"].map((fileId) => ({
          fileId,
          encryptedPath: `p-${fileId}`,
          content: cipher(`c-${fileId}`),
          action: "create" as const,
          versionId: `v-${fileId}`,
          contentHash: `hash-${fileId}`,
          sizeBytes: bytes(`c-${fileId}`).length,
          mtimeMs: 0,
          baseVersionId: null,
          historyKind: "documents",
        })),
      },
      {
        writeBlob: vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
        tryInsertFileVersions,
        getLatestVersionIds: vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map()),
        hasBlob: storesNothing(),
        assembleChunks: vi.fn().mockResolvedValue(true),
        flushBlobs: vi.fn(async () => {}),
        broadcast,
        isContentHashReferenced: vi.fn(async () => false),
        deleteBlob: vi.fn(async () => {}),
      },
    );

    expect(result.results).toEqual([
      { fileId: "f-1", status: "ok", versionId: "v-f-1", contentHash: "hash-f-1" },
      { fileId: "f-2", status: "stale_base", currentVersionId: "v-peer" },
      { fileId: "f-3", status: "ok", versionId: "v-f-3", contentHash: "hash-f-3" },
    ]);
    // The stale row is not announced; the two that committed are.
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith("v1", "f-1", "v-f-1", undefined, undefined);
    expect(broadcast).toHaveBeenCalledWith("v1", "f-3", "v-f-3", undefined, undefined);
  });

  it("keeps a retained row's verdict with its file when a phase-1 refusal precedes it", async () => {
    // f-1 is refused in phase 1 (its base is stale), so only f-2 and f-3 reach the
    // insert. The verdict array is indexed by **pending slot**, and each slot has to be
    // mapped back to the input index: a handler that used one for the other would give
    // f-3's answer to f-2, or leave a retained file "not processed".
    const insertedFileIds: string[] = [];
    const tryInsertFileVersions = vi
      .fn<TryInsertFileVersionsFn>()
      .mockImplementation(async (rows) => {
        insertedFileIds.push(...rows.map((row) => row.fileId));
        return rows.map(() => ({ status: "ok" as const }));
      });
    const getLatestVersionIds = vi
      .fn<GetLatestVersionIdsFn>()
      .mockResolvedValue(new Map([["f-1", "v-peer"]]));
    const broadcast = vi.fn();

    const result = await handleSyncPushWithDeps(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: ["f-1", "f-2", "f-3"].map((fileId) => ({
          fileId,
          encryptedPath: `p-${fileId}`,
          content: cipher(`c-${fileId}`),
          action: "create" as const,
          versionId: `v-${fileId}`,
          contentHash: `hash-${fileId}`,
          sizeBytes: bytes(`c-${fileId}`).length,
          mtimeMs: 0,
          baseVersionId: fileId === "f-1" ? "v-stale" : null,
          historyKind: "documents",
        })),
      },
      {
        writeBlob: vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
        tryInsertFileVersions,
        getLatestVersionIds,
        hasBlob: storesNothing(),
        assembleChunks: vi.fn().mockResolvedValue(true),
        flushBlobs: vi.fn(async () => {}),
        broadcast,
        isContentHashReferenced: vi.fn(async () => false),
        deleteBlob: vi.fn(async () => {}),
      },
    );

    // Only the rows that survived phase 1 reached the transaction, in input order.
    expect(insertedFileIds).toEqual(["f-2", "f-3"]);
    // And each answer landed on its own file, not on the slot's position in the input.
    expect(result.results).toEqual([
      { fileId: "f-1", status: "stale_base", currentVersionId: "v-peer" },
      { fileId: "f-2", status: "ok", versionId: "v-f-2", contentHash: "hash-f-2" },
      { fileId: "f-3", status: "ok", versionId: "v-f-3", contentHash: "hash-f-3" },
    ]);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledWith("v1", "f-2", "v-f-2", undefined, undefined);
    expect(broadcast).toHaveBeenCalledWith("v1", "f-3", "v-f-3", undefined, undefined);
  });

  it("fails every pending file when the batch insert itself throws", async () => {
    const broadcast = vi.fn();
    const result = await handleSyncPushWithDeps(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "a",
            content: cipher("ca"),
            action: "create",
            versionId: "v1",
            contentHash: "hash1",
            sizeBytes: bytes("ca").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
          {
            fileId: "f-2",
            encryptedPath: "b",
            content: cipher("cb"),
            action: "create",
            versionId: "v2",
            contentHash: "hash2",
            sizeBytes: bytes("cb").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
        ],
      },
      {
        writeBlob: vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
        tryInsertFileVersions: vi
          .fn<TryInsertFileVersionsFn>()
          .mockRejectedValue(new Error("disk full")),
        getLatestVersionIds: vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map()),
        hasBlob: storesNothing(),
        assembleChunks: vi.fn().mockResolvedValue(true),
        flushBlobs: vi.fn(async () => {}),
        broadcast,
        isContentHashReferenced: vi.fn(async () => false),
        deleteBlob: vi.fn(async () => {}),
      },
    );

    expect(result.results).toEqual([
      { fileId: "f-1", status: "error", error: "disk full" },
      { fileId: "f-2", status: "error", error: "disk full" },
    ]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("answers per file when the batch's head query itself fails", async () => {
    // A database that cannot be read is answered the way a single-file read failure
    // always was: the client is told which files did not land, instead of the whole
    // request turning into a 500.
    const getLatestVersionIds = vi
      .fn<GetLatestVersionIdsFn>()
      .mockRejectedValue(new Error("db gone"));

    const result = await handleSyncPushWithDeps(
      {
        vaultId: "v1",
        historyLimits: DEFAULT_HISTORY_LIMITS,
        files: [
          {
            fileId: "f-1",
            encryptedPath: "a",
            content: cipher("ca"),
            action: "create",
            versionId: "v1",
            contentHash: "hash1",
            sizeBytes: bytes("ca").length,
            mtimeMs: 0,
            baseVersionId: null,
            historyKind: "documents",
          },
        ],
      },
      {
        writeBlob: vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
        tryInsertFileVersions: async (rows) => rows.map(() => ({ status: "ok" })),
        getLatestVersionIds,
        hasBlob: storesNothing(),
        assembleChunks: vi.fn().mockResolvedValue(true),
        flushBlobs: vi.fn(async () => {}),
        broadcast: vi.fn(),
        isContentHashReferenced: vi.fn(async () => false),
        deleteBlob: vi.fn(async () => {}),
      },
    );

    expect(result.results[0]).toMatchObject({ fileId: "f-1", status: "error", error: "db gone" });
  });

  /** A push input with one content-carrying version, for the history-limit cases. */
  function oneFile(
    kind: "documents" | "attachments" = "documents",
    historyLimits: HistoryLimits = DEFAULT_HISTORY_LIMITS,
  ): SyncPushInput {
    return {
      vaultId: "v1",
      historyLimits,
      files: [
        {
          fileId: "f-trim",
          encryptedPath: "enc",
          content: cipher("ca"),
          action: "create",
          versionId: "v-2",
          contentHash: "hash-v2",
          sizeBytes: bytes("ca").length,
          mtimeMs: 0,
          baseVersionId: "v-1",
          historyKind: kind,
        },
      ],
    };
  }

  it("resolves each version's limit from the vault's values and the file's kind", async () => {
    // The numbers are the vault's (the route reads them from its row); the client only
    // states the kind. Both have to reach the row the transaction trims against.
    const tryInsertFileVersion = vi.fn<RowInsert>().mockResolvedValue({ status: "ok" });

    await handleSyncPush(
      oneFile("attachments", { documents: 300, attachments: 7 }),
      vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
      tryInsertFileVersion,
      vi.fn<SingleHeadLookup>().mockResolvedValue("v-1"),
      storesNothing(),
    );

    expect(tryInsertFileVersion).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "f-trim", historyKind: "attachments", historyLimit: 7 }),
    );
  });

  it("states the document limit for a document kind from the same vault values", async () => {
    const tryInsertFileVersion = vi.fn<RowInsert>().mockResolvedValue({ status: "ok" });

    await handleSyncPush(
      oneFile("documents", { documents: 300, attachments: 7 }),
      vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
      tryInsertFileVersion,
      vi.fn<SingleHeadLookup>().mockResolvedValue("v-1"),
      storesNothing(),
    );

    expect(tryInsertFileVersion).toHaveBeenCalledWith(
      expect.objectContaining({ historyKind: "documents", historyLimit: 300 }),
    );
  });

  it("reclaims the blobs a trim orphaned, and keeps one another file still references", async () => {
    // The insert transaction answers the hashes of the rows it removed. Each of those
    // blobs goes only when no remaining version row names it any more — two files can
    // hold the same bytes, and the blob is one row per hash.
    const isContentHashReferenced = vi.fn(
      async (_vaultId: string, contentHash: string) => contentHash === "hash-shared",
    );
    const deleteBlob = vi.fn(async () => {});
    const invalidateStorageUsage = vi.fn();

    const result = await handleSyncPushWithDeps(oneFile(), {
      writeBlob: vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
      tryInsertFileVersions: vi.fn<TryInsertFileVersionsFn>().mockImplementation(async (rows) =>
        rows.map(() => ({
          status: "ok" as const,
          prunedContentHashes: ["hash-gone", "hash-shared"],
        })),
      ),
      getLatestVersionIds: vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map()),
      hasBlob: storesNothing(),
      assembleChunks: vi.fn().mockResolvedValue(true),
      flushBlobs: vi.fn(async () => {}),
      broadcast: vi.fn(),
      isContentHashReferenced,
      deleteBlob,
      invalidateStorageUsage,
    });

    expect(result.results.map((entry) => entry.status)).toEqual(["ok"]);
    expect(isContentHashReferenced).toHaveBeenCalledWith("v1", "hash-gone");
    expect(isContentHashReferenced).toHaveBeenCalledWith("v1", "hash-shared");
    expect(deleteBlob).toHaveBeenCalledTimes(1);
    expect(deleteBlob).toHaveBeenCalledWith("v1", "hash-gone");
    // A trim freed bytes, so the route's cached usage has to be dropped (once, not per
    // hash): otherwise a quota check keeps counting space the account no longer uses.
    expect(invalidateStorageUsage).toHaveBeenCalledTimes(1);
  });

  it("does not touch the store when no chain was trimmed", async () => {
    const isContentHashReferenced = vi.fn(async () => false);
    const deleteBlob = vi.fn(async () => {});
    const invalidateStorageUsage = vi.fn();

    await handleSyncPushWithDeps(oneFile(), {
      writeBlob: vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
      tryInsertFileVersions: vi.fn<TryInsertFileVersionsFn>().mockResolvedValue([{ status: "ok" }]),
      getLatestVersionIds: vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map()),
      hasBlob: storesNothing(),
      assembleChunks: vi.fn().mockResolvedValue(true),
      flushBlobs: vi.fn(async () => {}),
      broadcast: vi.fn(),
      isContentHashReferenced,
      deleteBlob,
      invalidateStorageUsage,
    });

    expect(isContentHashReferenced).not.toHaveBeenCalled();
    expect(deleteBlob).not.toHaveBeenCalled();
    // Nothing was freed, so the route's cached usage is still correct.
    expect(invalidateStorageUsage).not.toHaveBeenCalled();
  });

  it("answers the push as applied when the reclaim itself cannot delete a blob", async () => {
    // The version committed before the reclaim ran. A store that refuses the delete is
    // the orphan sweep's problem, not a push the client must retry — reporting an error
    // here would say a stored version was lost.
    const result = await handleSyncPushWithDeps(oneFile(), {
      writeBlob: vi.fn<WriteBlobFn>().mockResolvedValue(undefined),
      tryInsertFileVersions: vi
        .fn<TryInsertFileVersionsFn>()
        .mockResolvedValue([{ status: "ok", prunedContentHashes: ["hash-gone"] }]),
      getLatestVersionIds: vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map()),
      hasBlob: storesNothing(),
      assembleChunks: vi.fn().mockResolvedValue(true),
      flushBlobs: vi.fn(async () => {}),
      broadcast: vi.fn(),
      isContentHashReferenced: vi.fn(async () => false),
      deleteBlob: vi.fn(async () => {
        throw new Error("store locked");
      }),
    });

    expect(result.results[0]).toMatchObject({ fileId: "f-trim", status: "ok" });
  });
});

it("writes a batch's payloads concurrently", async () => {
  // A first bind sends 100 files per request. Writing their blobs one after another
  // made each file wait for the store; the batch's store work now runs at once.
  let inFlight = 0;
  let peak = 0;
  const writeBlob = vi.fn<WriteBlobFn>().mockImplementation(async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  });

  const result = await handleSyncPushWithDeps(
    {
      vaultId: "v1",
      historyLimits: DEFAULT_HISTORY_LIMITS,
      files: Array.from({ length: 8 }, (_, index) => ({
        fileId: `f-${index}`,
        encryptedPath: `p-${index}`,
        content: cipher(`c-${index}`),
        action: "create" as const,
        versionId: `v-${index}`,
        contentHash: `hash-${index}`,
        sizeBytes: bytes(`c-${index}`).length,
        mtimeMs: 0,
        baseVersionId: null,
        historyKind: "documents",
      })),
    },
    {
      writeBlob,
      tryInsertFileVersions: vi
        .fn<TryInsertFileVersionsFn>()
        .mockImplementation(async (rows) => rows.map(() => ({ status: "ok" }))),
      getLatestVersionIds: vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map()),
      hasBlob: storesNothing(),
      assembleChunks: vi.fn().mockResolvedValue(true),
      flushBlobs: vi.fn(async () => {}),
      broadcast: vi.fn(),
      isContentHashReferenced: vi.fn(async () => false),
      deleteBlob: vi.fn(async () => {}),
    },
  );

  expect(result.results.map((r) => r.status)).toEqual(Array(8).fill("ok"));
  expect(writeBlob).toHaveBeenCalledTimes(8);
  expect(peak).toBeGreaterThan(1);
});

it("keeps one failed blob write with its file", async () => {
  // A store that refuses one payload must answer that file with an error and still
  // insert the rest — the same per-file contract a failed write always had.
  const writeBlob = vi.fn<WriteBlobFn>().mockImplementation(async (_vaultId, hash) => {
    if (hash === "hash-f-2") throw new Error("disk full");
  });
  const tryInsertFileVersions = vi
    .fn<TryInsertFileVersionsFn>()
    .mockImplementation(async (rows) => rows.map(() => ({ status: "ok" })));

  const result = await handleSyncPushWithDeps(
    {
      vaultId: "v1",
      historyLimits: DEFAULT_HISTORY_LIMITS,
      files: ["f-1", "f-2", "f-3"].map((fileId) => ({
        fileId,
        encryptedPath: `p-${fileId}`,
        content: cipher(`c-${fileId}`),
        action: "create" as const,
        versionId: `v-${fileId}`,
        contentHash: `hash-${fileId}`,
        sizeBytes: bytes(`c-${fileId}`).length,
        mtimeMs: 0,
        baseVersionId: null,
        historyKind: "documents",
      })),
    },
    {
      writeBlob,
      tryInsertFileVersions,
      getLatestVersionIds: vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map()),
      hasBlob: storesNothing(),
      assembleChunks: vi.fn().mockResolvedValue(true),
      flushBlobs: vi.fn(async () => {}),
      broadcast: vi.fn(),
      isContentHashReferenced: vi.fn(async () => false),
      deleteBlob: vi.fn(async () => {}),
    },
  );

  expect(result.results).toEqual([
    { fileId: "f-1", status: "ok", versionId: "v-f-1", contentHash: "hash-f-1" },
    { fileId: "f-2", status: "error", error: "disk full" },
    { fileId: "f-3", status: "ok", versionId: "v-f-3", contentHash: "hash-f-3" },
  ]);
  expect(tryInsertFileVersions).toHaveBeenCalledWith([
    expect.objectContaining({ fileId: "f-1" }),
    expect.objectContaining({ fileId: "f-3" }),
  ]);
});

it("accepts a rename whose bytes a create in the same batch wrote", async () => {
  // Presence is checked after the batch's writes, so a rename that reuses content
  // carried by another file in the same request finds it instead of answering
  // `content_missing`.
  const held = new Set<string>();
  const writeBlob = vi.fn<WriteBlobFn>().mockImplementation(async (_vaultId, hash) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    held.add(hash);
  });
  const hasBlob = vi.fn<HasBlobFn>().mockImplementation(async (_vaultId, hash) => held.has(hash));

  const result = await handleSyncPushWithDeps(
    {
      vaultId: "v1",
      historyLimits: DEFAULT_HISTORY_LIMITS,
      files: [
        {
          fileId: "f-1",
          encryptedPath: "p-1",
          content: cipher("shared"),
          action: "create",
          versionId: "v-1",
          contentHash: "hash-shared",
          sizeBytes: bytes("shared").length,
          mtimeMs: 0,
          baseVersionId: null,
          historyKind: "documents",
        },
        {
          fileId: "f-2",
          encryptedPath: "p-2",
          content: null,
          action: "rename",
          versionId: "v-2",
          contentHash: "hash-shared",
          sizeBytes: bytes("shared").length,
          mtimeMs: 0,
          baseVersionId: "v-1",
          historyKind: "documents",
        },
      ],
    },
    {
      writeBlob,
      tryInsertFileVersions: vi
        .fn<TryInsertFileVersionsFn>()
        .mockImplementation(async (rows) => rows.map(() => ({ status: "ok" }))),
      getLatestVersionIds: vi.fn<GetLatestVersionIdsFn>().mockResolvedValue(new Map()),
      hasBlob,
      assembleChunks: vi.fn().mockResolvedValue(true),
      flushBlobs: vi.fn(async () => {}),
      broadcast: vi.fn(),
      isContentHashReferenced: vi.fn(async () => false),
      deleteBlob: vi.fn(async () => {}),
    },
  );

  expect(result.results.map((r) => r.status)).toEqual(["ok", "ok"]);
});

describe("handleSyncPull", () => {
  it("returns version chain for a file", async () => {
    const getVersionChain = vi.fn<GetVersionChainFn>().mockResolvedValue([
      {
        versionId: "v001",
        contentHash: "hash001",
        encryptedPath: "enc_p1",
        action: "create",
        sizeBytes: 5,
        mtimeMs: 1_760_000_000_000,
        deviceName: "device-a",
        createdAt: makeDate("2026-06-01T00:00:00Z"),
      },
      {
        versionId: "v002",
        contentHash: "hash002",
        encryptedPath: "enc_p2",
        action: "modify",
        sizeBytes: 7,
        mtimeMs: 1_760_000_001_000,
        deviceName: null,
        createdAt: makeDate("2026-06-02T00:00:00Z"),
      },
    ]);
    // The path a client materialises the file at is the chain's own last row 鈥?the
    // same row the push's head check reads, so the two cannot disagree.
    const result = await handleSyncPull(
      { vaultId: "v1", files: [{ fileId: "f-001" }] },
      getVersionChain,
    );
    expect(result.files).toHaveLength(1);
    expect(result.files[0].fileId).toBe("f-001");
    expect(result.files[0].encryptedPath).toBe("enc_p2");
    expect(result.files[0].versions).toHaveLength(2);
    // The modification time travels with the chain: it is what a config-folder
    // conflict compares on the client side.
    expect(result.files[0].versions.map((v) => v.mtimeMs)).toEqual([
      1_760_000_000_000, 1_760_000_001_000,
    ]);
  });

  it("returns empty for unknown fileId", async () => {
    const getVersionChain = vi.fn<GetVersionChainFn>().mockResolvedValue([]);
    const result = await handleSyncPull(
      { vaultId: "v1", files: [{ fileId: "unknown" }] },
      getVersionChain,
    );
    expect(result.files[0].versions).toHaveLength(0);
    // No chain means no path to record either: an empty string, not a crash.
    expect(result.files[0].encryptedPath).toBe("");
  });
});

describe("getFileVersionHistory", () => {
  it("returns versions", async () => {
    const getVersionChain = vi.fn<GetVersionChainFn>().mockResolvedValue([
      {
        versionId: "v001",
        contentHash: "hash001",
        encryptedPath: "ep",
        action: "create",
        sizeBytes: 0,
        mtimeMs: 0,
        deviceName: "device-a",
        createdAt: makeDate("2026-06-01T00:00:00Z"),
      },
    ]);
    const result = await getFileVersionHistory("v1", "f-001", getVersionChain);
    expect(result.versions).toHaveLength(1);
    // The version keeps the label of the client that pushed it, for UI display.
    expect(result.versions[0].deviceName).toBe("device-a");
  });

  it("throws NotFoundError for empty chain", async () => {
    const getVersionChain = vi.fn<GetVersionChainFn>().mockResolvedValue([]);
    await expect(getFileVersionHistory("v1", "unknown", getVersionChain)).rejects.toThrow(
      NotFoundError,
    );
  });
});

describe("getVaultSyncHistory", () => {
  it("returns all files", async () => {
    const listFilesByVaultId = vi.fn<ListFilesByVaultIdFn>().mockResolvedValue([
      {
        fileId: "f-001",
        encryptedPath: "ep",
        currentVersionId: "v001",
        currentContentHash: "hash001",
        versions: [],
      },
    ]);
    const result = await getVaultSyncHistory("v1", listFilesByVaultId);
    expect(result.files[0].fileId).toBe("f-001");
  });
});

describe("getVaultSyncIndex", () => {
  it("maps a live chain's head and leaves previousLive null", async () => {
    const listFileHeadsByVaultId = vi.fn<ListFileHeadsByVaultIdFn>().mockResolvedValue([
      {
        fileId: "f-live",
        head: mkRow("v2", "modify", "2026-06-02T00:00:00Z"),
        previousLive: null,
      },
    ]);

    const result = await getVaultSyncIndex("v1", listFileHeadsByVaultId);

    expect(result.files).toEqual([
      {
        fileId: "f-live",
        head: {
          versionId: "v2",
          contentHash: "hash-v2",
          encryptedPath: "path-v2",
          action: "modify",
          sizeBytes: 12,
          mtimeMs: 1_760_000_000_000,
          createdAt: "2026-06-02T00:00:00.000Z",
        },
        previousLive: null,
      },
    ]);
    // The wire shape the engine reads has no device label: it is the history UI's row.
    expect(result.files[0]!.head).not.toHaveProperty("deviceName");
  });

  it("carries the previous live version for a tombstone", async () => {
    const listFileHeadsByVaultId = vi.fn<ListFileHeadsByVaultIdFn>().mockResolvedValue([
      {
        fileId: "f-dead",
        head: mkRow("v3", "delete", "2026-06-03T00:00:00Z"),
        previousLive: mkRow("v2", "modify", "2026-06-02T00:00:00Z"),
      },
    ]);

    const result = await getVaultSyncIndex("v1", listFileHeadsByVaultId);

    expect(result.files[0]!.head.action).toBe("delete");
    expect(result.files[0]!.previousLive?.versionId).toBe("v2");
  });

  it("answers previousLive = null for a chain that holds nothing but a delete", async () => {
    const listFileHeadsByVaultId = vi.fn<ListFileHeadsByVaultIdFn>().mockResolvedValue([
      {
        fileId: "f-only-delete",
        head: mkRow("v1", "delete", "2026-06-01T00:00:00Z"),
        previousLive: null,
      },
    ]);

    const result = await getVaultSyncIndex("v1", listFileHeadsByVaultId);

    expect(result.files[0]!.previousLive).toBeNull();
  });
});

describe("listDeletedFiles", () => {
  const mkVersion = (
    versionId: string,
    action: "create" | "modify" | "rename" | "delete" | "restore",
    encryptedPath: string,
    contentHash: string,
    iso: string,
    deviceName: string | null = null,
    sizeBytes = 0,
  ) => ({
    versionId,
    contentHash,
    encryptedPath,
    action,
    sizeBytes,
    mtimeMs: 0,
    deviceName,
    createdAt: makeDate(iso),
  });

  it("returns deleted files with their restorable previous version", async () => {
    // The query behind this returns the last two rows of every chain that ends in a
    // `delete` 鈥?a chain that is still live is not in the answer at all, which is why
    // `f-live` has no row here.
    const listDeletedChains = vi.fn<ListDeletedChainsFn>().mockResolvedValue([
      {
        fileId: "f-dead",
        previous: mkVersion(
          "v2",
          "modify",
          "ep-prev",
          "h-prev",
          "2026-06-02T00:00:00Z",
          null,
          12 * 1024 * 1024,
        ),
        last: mkVersion("v-del", "delete", "ep-del", "h-del", "2026-06-04T00:00:00Z", "device-b"),
      },
      {
        fileId: "f-orphan",
        previous: null,
        last: mkVersion("v-del-only", "delete", "ep-orphan", "h-del-only", "2026-06-05T00:00:00Z"),
      },
    ]);
    const result = await listDeletedFiles({ vaultId: "v1" }, listDeletedChains);

    expect(result.files).toHaveLength(2);
    expect(result.files[0]).toEqual({
      fileId: "f-dead",
      lastEncryptedPath: "ep-prev",
      previousVersionId: "v2",
      previousContentHash: "h-prev",
      previousSizeBytes: 12 * 1024 * 1024,
      deletedByDeviceName: "device-b",
      deletedAt: "2026-06-04T00:00:00.000Z",
    });
    expect(result.files[1]).toEqual({
      fileId: "f-orphan",
      lastEncryptedPath: null,
      previousVersionId: null,
      previousContentHash: null,
      previousSizeBytes: null,
      deletedByDeviceName: null,
      deletedAt: "2026-06-05T00:00:00.000Z",
    });
  });

  it("returns an empty list when nothing is deleted", async () => {
    const listDeletedChains = vi.fn<ListDeletedChainsFn>().mockResolvedValue([]);
    const result = await listDeletedFiles({ vaultId: "v1" }, listDeletedChains);
    expect(result.files).toHaveLength(0);
  });
});

describe("handleSyncContents", () => {
  it("answers the versions in order, with a missing entry for a hash the store lacks", async () => {
    const first = new Uint8Array([1, 2, 3]);
    const second = new Uint8Array([4, 5]);
    const openBlobReader = vi.fn(async (_vaultId: string, hash: string) => {
      if (hash === "a".repeat(64)) return blobReader(first);
      if (hash === "b".repeat(64)) return undefined;
      return blobReader(second);
    });

    const body = await handleSyncContents(
      { vaultId: "v1", hashes: ["a".repeat(64), "b".repeat(64), "c".repeat(64)] },
      openBlobReader,
    );

    const parsed = parseContentBatchBody(body, 3);
    expect(parsed[0]).toEqual(first);
    expect(parsed[1]).toBeNull();
    expect(parsed[2]).toEqual(second);
  });

  it("reads a short file as missing, and closes every handle it opened", async () => {
    const opened = blobReader(undefined);
    const body = await handleSyncContents(
      { vaultId: "v1", hashes: ["a".repeat(64)] },
      async () => opened,
    );
    expect(parseContentBatchBody(body, 1)).toEqual([null]);
    expect(opened.close).toHaveBeenCalledTimes(1);
  });

  it("refuses an answer over its byte bound without reading the blob", async () => {
    const opened = blobReader(new Uint8Array(64));
    const run = handleSyncContents(
      { vaultId: "v1", hashes: ["a".repeat(64)] },
      async () => opened,
      32,
    );
    await expect(run).rejects.toBeInstanceOf(PayloadTooLargeError);
    // The size is checked before the read: a blob at the cap must not be buffered just to
    // answer 413, and the handle must still be closed.
    expect(opened.readAll).not.toHaveBeenCalled();
    expect(opened.close).toHaveBeenCalledTimes(1);
  });
});
