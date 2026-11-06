import { realPlatform } from "@courier/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine, type ConflictResolvedEvent } from "./engine";
import type { FileStamp, SyncAdapter, SyncWriteStream } from "./adapter";
import type { SyncApi, PushFile } from "./api";
import {
  deriveEncryptionKey,
  sha256Hex,
  sha256Text,
  encryptCombinedBytes,
  encryptChunkBytes,
  encryptString,
  decryptCombinedBytes,
  decryptString,
} from "./crypto";
import { generateFileId, generateVersionId } from "./ids";
import type {
  SyncAction,
  VersionChainEntry,
  SyncPushResponse,
  SyncPushResult,
  SyncPullResponse,
  VaultSyncIndexResponse,
} from "@courier/shared";
import {
  CHUNK_PLAINTEXT_BYTES,
  chunkAdditionalData,
  reversedCopy,
  sortedCopy,
} from "@courier/shared";
import { conflictFilePath } from "./conflict-file";
import { MAX_RATE_LIMIT_WAITS } from "./rate-limit";
import {
  normalizeScope,
  NO_SETTINGS_GROUPS,
  SETTINGS_GROUPS,
  type SettingsGroup,
  type SyncScope,
} from "./sync-scope";
import { NO_FILE_TYPES, type FileTypeGroup } from "./file-types";
import type {
  FileSkippedEvent,
  FileTooLargeEvent,
  SettingsAppliedEvent,
  SyncActivityEvent,
  SyncProgress,
} from "./engine";

/**
 * A conflict copy is named after the second it was parked at, so a test that asserts
 * where it landed has to know that second: rebuilding the name from a live clock is a
 * race no assertion can win reliably. Freezing **only** `Date` is what turns that name
 * into a constant here — timers and the fake filesystem's own mtime clock stay real, and
 * the naming rule itself is pinned by `conflict-file.test.ts`.
 *
 * Two consequences worth knowing while reading the tests below: two conflicts park under
 * the same timestamp (so the `-2` counter is what tells them apart, which is exactly the
 * case one of them covers), and the engine's self-write windows, measured against
 * `Date.now()`, do not expire on their own.
 */
beforeEach(() => {
  // Only the clock is frozen: `setSystemTime` without `useFakeTimers` leaves every
  // scheduler real, and the engine's waits rely on that.
  vi.setSystemTime(new Date(2026, 1, 14, 10, 15, 30));
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * The fake vault's file map, which stamps every mutation.
 *
 * A real filesystem gives a changed file a new mtime, and the engine's "do not re-read
 * what has not changed" rule leans on exactly that. A plain `Map` would let a test
 * change content without moving the clock, and the engine would keep trusting the hash
 * it recorded — so the stamping lives in the map itself and every mutation a test makes
 * (directly, or through the adapter) keeps the fake honest.
 */
class StampedFiles extends Map<string, Uint8Array> {
  private clock = 1;
  readonly mtimes = new Map<string, number>();

  override set(path: string, bytes: Uint8Array): this {
    super.set(path, bytes);
    this.mtimes.set(path, this.clock++);
    return this;
  }

  /**
   * Set a path's modification time explicitly.
   *
   * The fake clock is a small counter, while a remote version's `mtimeMs` in these tests
   * is whatever the test says — so dating one side of a config-folder conflict has to be
   * explicit rather than a race between two clocks.
   */
  touch(path: string, mtimeMs: number): this {
    this.mtimes.set(path, mtimeMs);
    return this;
  }

  override delete(path: string): boolean {
    this.mtimes.delete(path);
    return super.delete(path);
  }
}

/** In-memory filesystem adapter for tests. */
class FakeAdapter implements SyncAdapter {
  files = new StampedFiles();
  /** Every path `readFile` was asked for — the size cap must keep files out of here. */
  reads: string[] = [];

  /**
   * Hooks that let a test play the host's vault-event wiring: a real adapter's
   * write/delete/rename fires an event the host feeds straight back into
   * `handleLocalChange` / `handleLocalDelete` / `handleLocalRename`, while the
   * engine is still midway through its own operation. Awaiting the handler here
   * makes that interleaving deterministic instead of dependent on microtask
   * ordering.
   */
  onWrite: ((path: string) => Promise<void>) | null = null;
  onDelete: ((path: string) => Promise<void>) | null = null;
  onRename: ((from: string, to: string) => Promise<void>) | null = null;
  /**
   * Runs at the start of every {@link statFile}, before the stamp is taken.
   *
   * A pass stats a path more than once — the scan, then a re-check before it adopts a
   * chain — and the only way to model "the file changed between the two" is to change
   * it inside one of them. A hook on the *write* side cannot: the pass reads the file
   * before it decides, so the change would simply be hashed.
   */
  onStat: ((path: string) => void) | null = null;

  /**
   * Everything this fake filesystem holds — "what exists", in the sense of
   * `SyncAdapter.listSyncableFiles`. The scope filter lives in the engine, so a
   * test can put a settings file here and still expect the engine to ignore it
   * when the scope says markdown only.
   */
  async listSyncableFiles(): Promise<string[]> {
    return [...this.files.keys()];
  }
  /**
   * What the host would list for the engine's excluded-folder move detection.
   *
   * The fake has no scope of its own, so a test states the same folders it put in
   * `normalizeScope`; the engine narrows the result by name and content.
   */
  excludedFolders: string[] = [];
  async listExcludedFiles(): Promise<string[]> {
    return [...this.files.keys()].filter((path) =>
      this.excludedFolders.some((folder) => path === folder || path.startsWith(`${folder}/`)),
    );
  }
  async readFile(path: string): Promise<Uint8Array | null> {
    this.reads.push(path);
    return this.files.get(path) ?? null;
  }
  /** Size and stamp, straight from the in-memory store (never a read). */
  async statFile(path: string): Promise<FileStamp | null> {
    this.onStat?.(path);
    const bytes = this.files.get(path);
    if (!bytes) return null;
    return { sizeBytes: bytes.byteLength, mtimeMs: this.files.mtimes.get(path) ?? 0 };
  }
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
    await this.onWrite?.(path);
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
    await this.onDelete?.(path);
  }
  async renameFile(from: string, to: string): Promise<void> {
    const b = this.files.get(from);
    if (b) {
      this.files.delete(from);
      this.files.set(to, b);
    }
    await this.onRename?.(from, to);
  }
  async createFolder(): Promise<void> {}
}

/**
 * A fake host that can write a file in pieces.
 *
 * It records what the engine streams, so a test can prove a large download never took
 * the whole-file path and that a failed one aborted instead of leaving a partial file.
 * `close` writes the assembled bytes and plays the host's vault event, exactly like a
 * real adapter's rename.
 */
class StreamingFakeAdapter extends FakeAdapter {
  readonly streamed: Array<{ path: string; chunks: number; bytes: number }> = [];
  readonly aborted: string[] = [];
  readonly wholeWrites: string[] = [];
  /**
   * Vault-event handlers this adapter started but did not await.
   *
   * The real app's watcher fires after the rename, asynchronously; `close` must not wait
   * for the handler (a handler that waits for the commit's stamp would otherwise
   * deadlock), so the test awaits these explicitly.
   */
  readonly events: Promise<void>[] = [];
  /** Make `beginWrite` fail, as an unsupported adapter sink would. */
  failBeginWrite = false;

  /** Wait for the watcher events a commit started. */
  async settleEvents(): Promise<void> {
    const pending = this.events.splice(0);
    await Promise.all(pending);
  }

  async beginWrite(path: string): Promise<SyncWriteStream> {
    if (this.failBeginWrite) throw new Error("streaming sink unsupported");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let closed = false;
    const record = { path, chunks: 0, bytes: 0 };
    this.streamed.push(record);
    return {
      write: async (chunk) => {
        chunks.push(chunk.slice());
        bytes += chunk.byteLength;
        record.chunks++;
        record.bytes = bytes;
      },
      close: async () => {
        const total = new Uint8Array(bytes);
        let offset = 0;
        for (const part of chunks) {
          total.set(part, offset);
          offset += part.byteLength;
        }
        closed = true;
        this.files.set(path, total);
        const event = this.onWrite?.(path);
        if (event) this.events.push(event);
      },
      abort: async () => {
        if (!closed) {
          this.aborted.push(path);
          closed = true;
        }
      },
    };
  }

  override async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    this.wholeWrites.push(path);
    await super.writeFile(path, bytes);
  }
}

/**
 * Fake server: stores encrypted blobs + version chains like the real server
 * (content-addressed encrypted blobs, chains per file, delete = last action).
 */
class FakeApi implements SyncApi {
  chains = new Map<string, VersionChainEntry[]>(); // fileId → chain
  blobs = new Map<string, Uint8Array>(); // contentHash → ciphertext
  paths = new Map<string, string>(); // fileId → encryptedPath
  /** How many files each push request carried, in order. */
  pushCalls: number[] = [];
  /** How many `push` calls are in flight right now, and their high-water mark. */
  inFlightPush = 0;
  maxInFlightPush = 0;
  /** A small delay inside `push`, so the per-file pool's bound is observable. */
  pushDelayMs = 0;
  /** Every version content this server was asked for, by hash. */
  contentFetches: string[] = [];
  /** Chunks staged by a chunked upload, by content hash → index → bytes. */
  chunks = new Map<string, Map<number, Uint8Array>>();
  /** The `chunkCount`/`plaintextSize` the first chunk of an upload established. */
  chunkMeta = new Map<string, { chunkCount: number; plaintextSize: number }>();
  /** Every staged chunk, in arrival order. */
  uploadCalls: Array<{ contentHash: string; index: number }> = [];
  /** Every ranged content request — how a chunked download moves. */
  rangeFetches: Array<{ contentHash: string; start: number; end: number }> = [];
  /** How many `getVersionContent` calls are in flight right now, and their high-water mark. */
  inFlightContent = 0;
  maxInFlightContent = 0;
  /**
   * A small delay inside `getVersionContent`, so overlapping pulls really overlap.
   *
   * Without it the fake answers from memory in one microtask and a concurrency assertion
   * would only ever see one call at a time.
   */
  contentDelayMs = 0;
  key: CryptoKey;
  pushed: PushFile[] = [];
  /** Model the network going away: every request fails until this is cleared. */
  offline = false;
  /**
   * Hook that runs *inside* `push`, before it resolves — how the server's
   * `file_pushed` broadcast reaches a client while its own request is still in
   * flight.
   */
  onPush: ((files: PushFile[]) => Promise<void>) | null = null;
  /**
   * Hook that runs *inside* `getVaultSyncIndex` — i.e. after a pass has listed
   * and hashed the vault. How a test makes the vault change under a running
   * reconcile, which is the window the snapshot re-check exists for.
   */
  onIndex: (() => Promise<void>) | null = null;

  /**
   * Hook that runs *inside* `pull` — i.e. while an incremental event is waiting for the
   * chain, after it has already read the file. How a test makes the file move inside
   * that window, which is what the decision's stamp re-check exists for.
   */
  onPull: ((fileIds: string[]) => Promise<void>) | null = null;

  constructor(key: CryptoKey) {
    this.key = key;
  }

  private guard(): void {
    if (this.offline) throw new Error("network down");
  }

  /**
   * A **conditional** server, like the real one: a push whose `baseVersionId` is
   * not the chain's head is refused (`stale_base`) instead of appended. That makes
   * every test in this file exercise the base each caller states, and it is what a
   * peer push injected through {@link onPush} turns into a refusal.
   */
  async push(_vaultId: string, files: PushFile[]): Promise<SyncPushResponse> {
    this.guard();
    this.pushCalls.push(files.length);
    this.inFlightPush++;
    this.maxInFlightPush = Math.max(this.maxInFlightPush, this.inFlightPush);
    try {
      if (this.pushDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.pushDelayMs));
      }
      await this.onPush?.(files);
      const results: SyncPushResult[] = [];
      for (const f of files) {
        const head = (this.chains.get(f.fileId) ?? []).at(-1);
        if (head && head.versionId !== f.baseVersionId) {
          results.push({
            fileId: f.fileId,
            status: "stale_base",
            currentVersionId: head.versionId,
          });
          continue;
        }
        // A chunked push names staged parts instead of carrying a payload: assemble
        // them like the server does, and refuse an upload that is not complete.
        if (f.action !== "delete" && f.content === null && (f.contentChunks ?? 0) > 0) {
          const meta = this.chunkMeta.get(f.contentHash);
          if (
            meta === undefined ||
            meta.chunkCount !== f.contentChunks ||
            this.contiguousChunks(f.contentHash, meta.chunkCount) !== meta.chunkCount
          ) {
            results.push({ fileId: f.fileId, status: "error", error: "chunk_missing" });
            continue;
          }
          const staged = this.chunks.get(f.contentHash)!;
          let length = 0;
          for (let index = 0; index < meta.chunkCount; index++) {
            length += staged.get(index)!.byteLength;
          }
          const assembled = new Uint8Array(length);
          let offset = 0;
          for (let index = 0; index < meta.chunkCount; index++) {
            const part = staged.get(index)!;
            assembled.set(part, offset);
            offset += part.byteLength;
          }
          this.blobs.set(f.contentHash, assembled);
          this.chunks.delete(f.contentHash);
          this.chunkMeta.delete(f.contentHash);
        }
        // Like the real server: a version that carries no content is only accepted while
        // the store really holds that hash — a `rename` reusing bytes that are there.
        if (f.action !== "delete" && f.content === null && !this.blobs.has(f.contentHash)) {
          results.push({ fileId: f.fileId, status: "content_missing" });
          continue;
        }
        this.pushed.push(f);
        const entry: VersionChainEntry = {
          versionId: f.versionId,
          contentHash: f.contentHash,
          encryptedPath: f.encryptedPath,
          action: f.action as SyncAction,
          sizeBytes: f.sizeBytes,
          mtimeMs: f.mtimeMs,
          createdAt: new Date().toISOString(),
        };
        const chain = this.chains.get(f.fileId) ?? [];
        chain.push(entry);
        this.chains.set(f.fileId, chain);
        this.paths.set(f.fileId, f.encryptedPath);
        if (f.content) {
          this.blobs.set(f.contentHash, f.content);
        }
        results.push({
          fileId: f.fileId,
          status: "ok",
          versionId: f.versionId,
          contentHash: f.contentHash,
        });
      }
      return { results };
    } finally {
      this.inFlightPush--;
    }
  }

  async pull(_vaultId: string, fileIds: string[]): Promise<SyncPullResponse> {
    this.guard();
    await this.onPull?.(fileIds);
    return {
      files: fileIds.map((fileId) => ({
        fileId,
        encryptedPath: this.paths.get(fileId) ?? "",
        versions: this.chains.get(fileId) ?? [],
      })),
    };
  }

  async getVersionContent(_vaultId: string, contentHash: string): Promise<Uint8Array> {
    this.guard();
    this.contentFetches.push(contentHash);
    this.inFlightContent++;
    this.maxInFlightContent = Math.max(this.maxInFlightContent, this.inFlightContent);
    try {
      if (this.contentDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.contentDelayMs));
      }
      return this.blobs.get(contentHash) ?? new Uint8Array(0);
    } finally {
      this.inFlightContent--;
    }
  }

  async getVersionContentRange(
    _vaultId: string,
    contentHash: string,
    start: number,
    end: number,
  ): Promise<Uint8Array> {
    this.guard();
    this.rangeFetches.push({ contentHash, start, end });
    const blob = this.blobs.get(contentHash) ?? new Uint8Array(0);
    return blob.subarray(start, end + 1);
  }

  async uploadChunk(
    _vaultId: string,
    contentHash: string,
    index: number,
    chunkCount: number,
    plaintextSize: number,
    content: Uint8Array,
  ): Promise<{ received: number }> {
    this.guard();
    const meta = this.chunkMeta.get(contentHash);
    if (
      meta !== undefined &&
      (meta.chunkCount !== chunkCount || meta.plaintextSize !== plaintextSize)
    ) {
      throw new Error("chunk metadata disagrees with the upload");
    }
    this.chunkMeta.set(contentHash, { chunkCount, plaintextSize });
    const staged = this.chunks.get(contentHash) ?? new Map<number, Uint8Array>();
    staged.set(index, content);
    this.chunks.set(contentHash, staged);
    this.uploadCalls.push({ contentHash, index });
    return { received: this.contiguousChunks(contentHash, chunkCount) };
  }

  async getChunkStatus(
    _vaultId: string,
    contentHash: string,
  ): Promise<{ received: number; complete: boolean } | null> {
    this.guard();
    const meta = this.chunkMeta.get(contentHash);
    if (meta === undefined) return null;
    const received = this.contiguousChunks(contentHash, meta.chunkCount);
    return { received, complete: received === meta.chunkCount };
  }

  /** Chunks staged contiguously from index 0 — the server's `received` prefix. */
  private contiguousChunks(contentHash: string, chunkCount: number): number {
    const staged = this.chunks.get(contentHash);
    let received = 0;
    while (received < chunkCount && staged?.has(received)) received++;
    return received;
  }

  /**
   * The fake's cold-start index: one row per chain, copied out of the live arrays.
   *
   * Copying matters here: a version appended while a pass is running must not appear
   * retroactively in the snapshot that pass already fetched.
   */
  async getVaultSyncIndex(_vaultId: string): Promise<VaultSyncIndexResponse> {
    this.guard();
    await this.onIndex?.();
    const files: VaultSyncIndexResponse["files"] = [];
    for (const [fileId, versions] of this.chains) {
      const head = versions.at(-1);
      if (!head) continue;
      const previousLive =
        head.action === "delete"
          ? (reversedCopy(versions).find((version) => version.action !== "delete") ?? null)
          : null;
      files.push({
        fileId,
        head: { ...head },
        previousLive: previousLive === null ? null : { ...previousLive },
      });
    }
    return { files };
  }

  /**
   * Simulate another device pushing a new version of a file.
   *
   * `mtimeMs` is the peer file's modification time — the value a config-folder conflict
   * compares against. It defaults to "now", like a peer that just edited the file.
   */
  async remoteEdit(fileId: string, plainText: string, mtimeMs = Date.now()): Promise<void> {
    const bytes = new TextEncoder().encode(plainText);
    const contentHash = await sha256Hex(bytes);
    const ciphertext = await encryptCombinedBytes(this.key, bytes as Uint8Array<ArrayBuffer>);
    this.blobs.set(contentHash, ciphertext);
    const chain = this.chains.get(fileId) ?? [];
    // Every version records the path it was written at, like the real server.
    const encryptedPath = this.paths.get(fileId) ?? "";
    if (chain.length === 0)
      chain.push({
        versionId: generateVersionId(),
        contentHash: "seed",
        encryptedPath,
        action: "create",
        sizeBytes: 0,
        mtimeMs: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
    chain.push({
      versionId: generateVersionId(),
      contentHash,
      encryptedPath,
      action: "modify",
      sizeBytes: bytes.byteLength,
      mtimeMs,
      createdAt: new Date().toISOString(),
    });
    this.chains.set(fileId, chain);
  }

  /**
   * Simulate another device renaming a file: a new version that records the new path
   * and the **same** content hash, which is what a move is.
   */
  async remoteRename(fileId: string, encryptedPath: string, mtimeMs?: number): Promise<string> {
    const chain = this.chains.get(fileId);
    const head = chain?.at(-1);
    if (!chain || !head) throw new Error("remoteRename: no chain for that fileId");
    const versionId = generateVersionId();
    chain.push({
      versionId,
      contentHash: head.contentHash,
      encryptedPath,
      action: "rename",
      sizeBytes: head.sizeBytes,
      // A move changes no content, so the file's modification time is unchanged.
      mtimeMs: mtimeMs ?? head.mtimeMs,
      createdAt: new Date().toISOString(),
    });
    this.paths.set(fileId, encryptedPath);
    return versionId;
  }

  /**
   * Simulate another device pushing a version whose *reported* size is bigger than its
   * content — how a peer with a larger (or no) cap can leave a chain this device must
   * refuse without downloading it.
   */
  async remoteEditWithSize(
    fileId: string,
    plainText: string,
    sizeBytes: number,
    mtimeMs?: number,
  ): Promise<void> {
    const before = (this.chains.get(fileId) ?? []).length;
    await this.remoteEdit(fileId, plainText, mtimeMs);
    const chain = this.chains.get(fileId)!;
    chain[chain.length - 1] = { ...chain[chain.length - 1]!, sizeBytes };
    if (before === 0) chain[chain.length - 2] = { ...chain[chain.length - 2]!, sizeBytes };
  }

  /**
   * Simulate another device deleting the file.
   *
   * A delete version does **not** get a blob, exactly like the real server — its
   * contentHash is the hash of an empty string and `getVersionContent` cannot
   * resolve it. Anything that needs the remote *content* therefore has nothing to
   * fetch here, which is the whole point of this helper.
   */
  async remoteDelete(fileId: string, mtimeMs = Date.now()): Promise<string> {
    const contentHash = await sha256Text("");
    const chain = this.chains.get(fileId) ?? [];
    const versionId = generateVersionId();
    chain.push({
      versionId,
      contentHash,
      encryptedPath: this.paths.get(fileId) ?? "",
      action: "delete",
      sizeBytes: 0,
      // A deletion has no file to stamp; the peer records when it decided to delete.
      mtimeMs,
      createdAt: new Date().toISOString(),
    });
    this.chains.set(fileId, chain);
    return versionId;
  }

  async latestVersionId(fileId: string): Promise<string | null> {
    const chain = this.chains.get(fileId);
    return chain && chain.length > 0 ? chain[chain.length - 1].versionId : null;
  }

  async readPlainLatest(fileId: string): Promise<string | null> {
    const chain = this.chains.get(fileId);
    if (!chain || chain.length === 0) return null;
    const enc = this.blobs.get(chain[chain.length - 1].contentHash);
    if (!enc) return null;
    const bytes = await decryptCombinedBytes(this.key, enc);
    return new TextDecoder().decode(bytes);
  }
}

/** An engine over the in-memory adapter and fake server. */
async function makeEngine(
  onSaveState?: (json: string) => void,
  onConflictResolved?: (event: ConflictResolvedEvent) => void,
  syncScope?: SyncScope,
  onFileTooLarge?: (event: FileTooLargeEvent) => void,
  onFileSkipped?: (event: FileSkippedEvent) => void,
  onSyncActivity?: (event: SyncActivityEvent) => void,
  onProgress?: (progress: SyncProgress) => void,
  onRateLimited?: (event: { waitMs: number }) => void,
  onError?: (error: unknown, paths: readonly string[]) => void,
) {
  const key = await deriveEncryptionKey(
    "password",
    btoa(String.fromCharCode(...new Uint8Array(32))),
  );
  const adapter = new FakeAdapter();
  const api = new FakeApi(key);
  const engine = new SyncEngine({
    platform: realPlatform,
    vaultId: "vault-1",
    adapter,
    api,
    encryptionKey: key,
    syncScope,
    onConflictResolved,
    onFileTooLarge,
    onFileSkipped,
    onSyncActivity,
    onProgress,
    onRateLimited,
    onError,
    onSaveState,
  });
  return { engine, adapter, api, key };
}

const encoder = new TextEncoder();

/** Assert byte equality without `Buffer` (the engine runs on Web Crypto). */
function expectSameBytes(actual: Uint8Array | undefined, expected: Uint8Array): void {
  expect(actual).toBeDefined();
  expect(actual!.byteLength).toBe(expected.byteLength);
  let mismatch = -1;
  for (let index = 0; index < expected.byteLength; index++) {
    if (actual![index] !== expected[index]) {
      mismatch = index;
      break;
    }
  }
  expect(mismatch).toBe(-1);
}

/** The state entry's sync point, read back the way a restart would read it. */
function syncPointOf(engine: SyncEngine, fileId: string): string | undefined {
  const state = JSON.parse(engine.serializeState()) as Record<
    string,
    { lastKnownVersionId: string }
  >;
  return state[fileId]?.lastKnownVersionId;
}

/** The fileId the server knows a path under, after a first sync. */
async function syncedFileId(api: FakeApi, action: SyncAction = "create"): Promise<string> {
  return api.pushed.find((p) => p.action === action)!.fileId;
}

/**
 * Park the *first* push the api receives, so a test can start a reconcile while
 * an event is still inside `pushFile` — the "slow network" shape of an event
 * still in flight. Later pushes pass through, or the reconcile would be the one
 * the test hangs on.
 */
function holdFirstPush(api: FakeApi) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const at = new Promise<void>((resolve) => (reached = resolve));
  let first = true;
  api.onPush = async () => {
    if (!first) return;
    first = false;
    reached();
    await gate;
  };
  return {
    reached: at,
    release: () => {
      release();
      api.onPush = null;
    },
  };
}

/** Inject one peer push into the window between a decision and its push. */
function pushFromPeerMidFlight(api: FakeApi, run: () => Promise<void>): void {
  let injected = false;
  api.onPush = async () => {
    if (injected) return;
    injected = true;
    await run();
  };
}

function engineOver(
  adapter: FakeAdapter,
  api: FakeApi,
  key: CryptoKey,
  syncScope?: SyncScope,
  onConflictResolved?: (event: ConflictResolvedEvent) => void,
  onSettingsApplied?: (event: SettingsAppliedEvent) => void,
): SyncEngine {
  return new SyncEngine({
    platform: realPlatform,
    vaultId: "vault-1",
    adapter,
    api,
    encryptionKey: key,
    syncScope,
    onConflictResolved,
    onSettingsApplied,
  });
}

/** A scope with exactly the named config-folder groups on and no vault file types. */
function scopeWith(...groups: SettingsGroup[]): SyncScope {
  const settingsGroups: Record<string, boolean> = {};
  for (const group of groups) settingsGroups[group] = true;
  return normalizeScope({ configDir: ".obsidian", settingsGroups, fileTypes: NO_FILE_TYPES });
}

/** Markdown-only, with the named vault folders excluded on this device. */
function scopeWithExcluded(...folders: string[]): SyncScope {
  return normalizeScope({
    configDir: ".obsidian",
    settingsGroups: NO_SETTINGS_GROUPS,
    fileTypes: NO_FILE_TYPES,
    excludedFolders: folders,
  });
}

/** A scope with the named vault file types on and nothing else special. */
function fileTypesWith(...types: FileTypeGroup[]): SyncScope {
  const fileTypes: Record<string, boolean> = { ...NO_FILE_TYPES };
  for (const type of types) fileTypes[type] = true;
  return normalizeScope({ fileTypes });
}

function fileTypesEngine(
  adapter: FakeAdapter,
  api: FakeApi,
  key: CryptoKey,
  syncScope: SyncScope,
  onFileTooLarge?: (event: FileTooLargeEvent) => void,
): SyncEngine {
  return new SyncEngine({
    platform: realPlatform,
    vaultId: "vault-1",
    adapter,
    api,
    encryptionKey: key,
    syncScope,
    onFileTooLarge,
  });
}

/** The text a vault path holds, or null. */
function textOf(adapter: FakeAdapter, path: string): string | null {
  const bytes = adapter.files.get(path);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

const plain = (bytes: Uint8Array | undefined): string =>
  bytes ? new TextDecoder().decode(bytes) : "";

/** No `*.conflict.*` copy anywhere in the fake vault. */
function noConflictCopies(adapter: FakeAdapter): boolean {
  return ![...adapter.files.keys()].some((path) => path.includes(".conflict."));
}

const conflictPaths = (adapter: FakeAdapter): string[] =>
  [...adapter.files.keys()].filter((path) => path.includes(".conflict."));

describe("SyncEngine", () => {
  it("initial sync pushes untracked local files and records state", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("notes/a.md", encoder.encode("# A"));
    adapter.files.set("notes/b.md", encoder.encode("# B"));

    await engine.initialSync();

    expect(adapter.files.size).toBe(2);
    const creates = api.pushed.filter((p) => p.action === "create");
    expect(creates.length).toBe(2);

    // Another engine bound to the same vault pulls the files down.
    const adapter2 = new FakeAdapter();
    const engine2 = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: adapter2,
      api,
      encryptionKey: (await makeEngine()).key,
    });
    await engine2.initialSync();
    expect(adapter2.files.size).toBe(2);
    expect(new TextDecoder().decode(adapter2.files.get("notes/a.md"))).toBe("# A");
  });

  it("states each pushed version's history kind, from the plaintext path", async () => {
    // The server never sees a path, so the device classifies the file: markdown and
    // canvas are documents (the vault's deep limit), every other synced path an
    // attachment (its shallow one). The numbers stay on the vault.
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("# note"));
    adapter.files.set("board.canvas", encoder.encode("{}"));
    adapter.files.set("photo.png", encoder.encode("png"));

    await engine.initialSync();

    const kinds = new Map<string, string>();
    for (const pushed of api.pushed) {
      kinds.set(await decryptString(key, pushed.encryptedPath), pushed.historyKind);
    }
    expect(kinds.get("note.md")).toBe("documents");
    expect(kinds.get("board.canvas")).toBe("documents");
    expect(kinds.get("photo.png")).toBe("attachments");
  });

  it("pulls a remote edit when local is unchanged", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();

    const fileId = api.pushed[0].fileId;
    await api.remoteEdit(fileId, "v2-remote");

    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("v2-remote");
  });

  it("writes the state once for a batch, not once per file", async () => {
    // Persisting per notification rewrote the whole state once per file: a 5 000-file
    // bind meant ~3.5 GB of JSON. One write per batch is enough — every file in it is
    // applied before the host can read the state.
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    await engine.initialSync();
    const fileIds = api.pushed.map((p) => p.fileId);

    const saves: string[] = [];
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: new FakeAdapter(),
      api,
      encryptionKey: key,
      onSaveState: (json) => saves.push(json),
    });
    const events = await Promise.all(
      fileIds.map(async (fileId) => ({
        fileId,
        versionId: (await api.latestVersionId(fileId))!,
      })),
    );
    await peer.handleFilePushedBatch(events);

    expect(saves).toHaveLength(1);
    expect(Object.keys(JSON.parse(saves[0]!))).toHaveLength(2);
  });

  it("answers an own push's echo at arrival, and only once", async () => {
    // The host consumes the echo when the notification arrives. If it waited for the
    // batch to run, the record could be past its deadline and the engine's own version
    // would be pulled back as a peer's — one request per file.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("n"));
    await engine.initialSync();
    const versionId = api.pushed[0]!.versionId;

    expect(engine.consumeOwnPush(versionId)).toBe(true);
    expect(engine.consumeOwnPush(versionId)).toBe(false);
  });

  it("applies a burst of notifications with one chain request per batch", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    await engine.initialSync();
    const fileIds = api.pushed.map((p) => p.fileId);
    expect(fileIds).toHaveLength(2);

    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });

    const pull = vi.spyOn(api, "pull");
    const events = await Promise.all(
      fileIds.map(async (fileId) => ({
        fileId,
        versionId: (await api.latestVersionId(fileId))!,
      })),
    );
    await peer.handleFilePushedBatch(events);

    // Both chains travelled in one request. One `POST /sync/pull` per file is what spent
    // a live peer's whole 600/minute window on 548 files of 5 000.
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull.mock.calls[0]![1]).toEqual(fileIds);
    expect(sortedCopy(peerAdapter.files.keys())).toEqual(["a.md", "b.md"]);
    expect(new TextDecoder().decode(peerAdapter.files.get("b.md"))).toBe("b");
  });

  it("reports a notification whose version content cannot be read", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;

    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    expect(new TextDecoder().decode(peerAdapter.files.get("n.md"))).toBe("v1");

    // A peer edit whose stored blob cannot be read — a missing blob, or the
    // truncated one a concurrent overwrite used to leave behind. Either way the
    // content this pull needs is not there.
    await api.remoteEdit(fileId, "v2-remote");
    const head = (await api.latestVersionId(fileId))!;
    const contentHash = api.chains.get(fileId)!.at(-1)!.contentHash;
    const blob = api.blobs.get(contentHash)!;
    api.blobs.delete(contentHash);

    // The notification fails loudly rather than doing nothing: the note never
    // arriving with nothing said anywhere is exactly what made this a bug.
    await expect(peer.handleFilePushed(fileId, head)).rejects.toThrow(/Could not read the content/);
    expect(new TextDecoder().decode(peerAdapter.files.get("n.md"))).toBe("v1");

    // A full pass is the retry mechanism, so it must survive the same failure…
    await expect(peer.initialSync()).resolves.toBeUndefined();
    expect(new TextDecoder().decode(peerAdapter.files.get("n.md"))).toBe("v1");

    // …and converge once the content is readable again.
    api.blobs.set(contentHash, blob);
    await peer.initialSync();
    expect(new TextDecoder().decode(peerAdapter.files.get("n.md"))).toBe("v2-remote");
  });

  it("parks no conflict copy while the remote side cannot be applied", async () => {
    const conflicts: ConflictResolvedEvent[] = [];
    const { engine, adapter, api } = await makeEngine(undefined, (event) => conflicts.push(event));
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;

    // A peer edits the note while this device edits it too, so the pass decides "conflict"…
    await api.remoteEdit(fileId, "theirs");
    adapter.files.set("n.md", encoder.encode("mine"));

    // …and the content that resolution needs cannot be read (a missing blob, or the
    // truncated one a concurrent overwrite leaves behind).
    const contentHash = api.chains.get(fileId)!.at(-1)!.contentHash;
    const blob = api.blobs.get(contentHash)!;
    api.blobs.delete(contentHash);

    // A pass tolerates the failure — it is the retry — but nothing may be **announced** or
    // parked while the note still holds this device's text. Parking first is what told the
    // user the remote version had won, and what added one more copy on every later pass.
    await expect(engine.initialSync()).resolves.toBeUndefined();
    expect(conflicts).toHaveLength(0);
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("mine");

    // With the content readable again it resolves the one way it always does: the remote
    // version wins and the local text is parked beside the note.
    api.blobs.set(contentHash, blob);
    await engine.initialSync();
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("theirs");
    expect(conflicts).toHaveLength(1);
    expect(new TextDecoder().decode(adapter.files.get(conflicts[0]!.conflictPath!))).toBe("mine");
  });

  it("reports a conflict whose remote content cannot be read", async () => {
    // The pass above tolerates the failure because it is the retry. The notification is
    // not: it is the only thing that would have resolved this conflict now, so it has to
    // fail loudly instead of returning as if the note had been settled.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;

    await api.remoteEdit(fileId, "theirs");
    const versionId = (await api.latestVersionId(fileId))!;
    adapter.files.set("n.md", encoder.encode("mine"));
    const contentHash = api.chains.get(fileId)!.at(-1)!.contentHash;
    api.blobs.delete(contentHash);

    await expect(engine.handleFilePushed(fileId, versionId)).rejects.toThrow(
      /Could not apply the conflict/,
    );

    // Nothing was announced and nothing was parked: the note still holds this device's
    // text, which is exactly what the failure says.
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("mine");
  });

  it("suppresses echoes of versions it pushed itself", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("e.md", encoder.encode("hello"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
    const pushedVersion = api.pushed.find((p) => p.fileId === fileId)!.versionId;

    await engine.handleFilePushed(fileId, pushedVersion);
    // Echo suppressed — no error, state unchanged.
    expect(api.pushed.filter((p) => p.fileId === fileId).length).toBe(1);
    void key;
  });

  it("resolves a conflict towards the remote version and parks the local content", async () => {
    const conflicts: ConflictResolvedEvent[] = [];
    const { engine, adapter, api } = await makeEngine(undefined, (event) => conflicts.push(event));
    adapter.files.set("c.md", encoder.encode("local"));
    await engine.initialSync();

    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
    // Local edit AND a remote edit → a true conflict.
    adapter.files.set("c.md", encoder.encode("local-v2"));
    await api.remoteEdit(fileId, "remote");

    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    // The remote head is the truth now, and what this device had is beside it.
    expect(new TextDecoder().decode(adapter.files.get("c.md"))).toBe("remote");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("c.md")))).toBe("local-v2");
    // The host is told what the remote side did with the file, not only where the copy
    // went: `remoteAction` is how the plugin and the daemon word their one line.
    expect(conflicts).toEqual([
      {
        fileId,
        plainPath: "c.md",
        conflictPath: conflictFilePath("c.md"),
        remoteAction: "write",
      },
    ]);
    // The losing device pushed nothing: the chain still ends at the remote edit.
    expect(api.chains.get(fileId)!.at(-1)!.contentHash).toBe(
      await sha256Hex(encoder.encode("remote")),
    );
  });
});

describe("SyncEngine conflicts", () => {
  it("keeps a helper export shape stable", () => {
    expect(typeof generateFileId).toBe("function");
  });

  /**
   * Deleting a file and later having it on disk again is the user starting a new
   * note under a name the server remembers as deleted. The old chain is a
   * tombstone, so it says nothing about the new content: reconciling that path
   * gives it its own fileId and pushes a `create`, with no conflict and no
   * history shared with the deleted file.
   *
   * (This is the reconnect shape: the same directory with no persisted state.)
   */
  it("gives a file that outlived a remote delete its own new fileId", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("reborn.md", encoder.encode("first life"));
    await engine.initialSync();
    const originalFileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The file is deleted (here locally, but the effect is the same: the server
    // chain ends in a tombstone) and later exists again at that path.
    await engine.handleLocalDelete("reborn.md");
    adapter.files.set("reborn.md", encoder.encode("second life"));

    // A client that only has the directory — a restart, a reconnect, a reopened
    // Obsidian — reconciles instead of diffing its own state.
    const reopened = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    await reopened.initialSync();

    expect(adapter.files.has(conflictFilePath("reborn.md"))).toBe(false);
    const rebornFileId = reopened.fileIdForPath("reborn.md")!;
    expect(rebornFileId).not.toBe(originalFileId);
    expect(api.pushed.at(-1)?.action).toBe("create");
    expect(api.pushed.at(-1)?.fileId).toBe(rebornFileId);

    // The deleted file keeps its own chain, tombstone and all.
    expect(api.chains.get(originalFileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(api.chains.get(rebornFileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(await api.readPlainLatest(rebornFileId)).toBe("second life");
  });

  /**
   * A local delete followed by a local recreate is not a divergence: the tombstone
   * is **this device's own sync point**, so a file on disk under it can only be one
   * the user just created, and the remote side holds no content to compete with.
   * The recreate is pushed as a `restore` on the same chain — under the "remote
   * wins" rule the alternative would be deleting the note the user is typing.
   */
  it("pushes a restore for a file recreated after this device deleted it", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("reborn.md", encoder.encode("first life"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    await engine.handleLocalDelete("reborn.md");
    adapter.files.set("reborn.md", encoder.encode("second life"));
    await engine.handleLocalChange("reborn.md");

    expect(api.pushed.at(-1)?.action).toBe("restore");
    expect(engine.fileIdForPath("reborn.md")).toBe(fileId);
    expect(adapter.files.has(conflictFilePath("reborn.md"))).toBe(false);

    // The scheduled pass leaves it alone: it is a normal synced file again.
    await engine.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("reborn.md"))).toBe("second life");
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete", "restore"]);
  });

  it("takes the peer's deletion for an edit made offline, parking that edit", async () => {
    const conflicts: ConflictResolvedEvent[] = [];
    const { engine, adapter, api } = await makeEngine(undefined, (event) => conflicts.push(event));
    adapter.files.set("gone.md", encoder.encode("synced content"));
    await engine.initialSync();
    const originalFileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // Edited while offline: the change is on disk but was never pushed, so the
    // last-known point is still the synced one — the local copy diverged from the
    // version the tombstone removed, which is a conflict.
    adapter.files.set("gone.md", encoder.encode("edited offline"));
    const deleteVersion = await api.remoteDelete(originalFileId);
    await engine.handleFilePushed(originalFileId, deleteVersion);
    await engine.initialSync();

    // The remote deletion is applied — that is what "remote wins" means — and the
    // edit that lost is parked beside the note instead of vanishing with it.
    expect(adapter.files.has("gone.md")).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("gone.md")))).toBe(
      "edited offline",
    );
    // A conflict whose remote side was a tombstone is reported as a `delete`: the
    // host's line has to say the file went away, not that a version was written.
    expect(conflicts.map((event) => event.remoteAction)).toEqual(["delete"]);
    expect(api.chains.get(originalFileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("applies a remote delete to an untouched local copy", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("untouched"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The peer deleted it and this copy is exactly the version it removed, so the
    // deletion simply applies — no conflict, no push-back. The scheduled pass is
    // the one that applies it (the bind pass merges instead).
    await engine.handleFilePushed(fileId, await api.remoteDelete(fileId));
    await engine.initialSync();

    expect(adapter.files.has("gone.md")).toBe(false);
    expect(adapter.files.has(conflictFilePath("gone.md"))).toBe(false);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("ignores a delete for a path it never tracked", async () => {
    // The host feeds every vault event in, including paths this device does not sync
    // (a file created and deleted again between two passes, a path outside the scope).
    // There is nothing to push and no identity to record: the delete is a no-op.
    const { engine, api } = await makeEngine();
    await engine.initialSync();
    const before = api.pushCalls.length;

    await expect(engine.handleLocalDelete("never-synced.md")).resolves.toBeUndefined();
    expect(api.pushCalls).toHaveLength(before);
  });

  it("applies a remote delete once the local file is gone", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("untouched"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The user removed it (or a previous reconcile did): with no local file, the
    // peer's tombstone is just synced, so nothing is pushed back.
    adapter.files.delete("gone.md");
    await engine.handleFilePushed(fileId, await api.remoteDelete(fileId));
    const pushed = api.pushed.length;

    await engine.initialSync();

    expect(adapter.files.has("gone.md")).toBe(false);
    expect(api.pushed.length).toBe(pushed);
  });

  /**
   * The bind pass is the one place a local file wins over a tombstone: connecting
   * a vault (or reopening Obsidian) treats a file the remote already deleted as
   * the user's own, and gives it a fresh identity rather than letting the
   * connection delete it.
   */
  it("revives a peer-deleted local file as a new file when binding the vault", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("survivor.md", encoder.encode("still here"));
    await engine.initialSync();
    const originalFileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The peer deletes the file and the tombstone stays on the server; this
    // device never applied it, which is what a machine that was offline looks
    // like when it connects.
    await api.remoteDelete(originalFileId);
    expect(new TextDecoder().decode(adapter.files.get("survivor.md"))).toBe("still here");

    // A fresh client over that directory — a connect, or Obsidian reopening with
    // no state — has nothing to compare the tombstone against, so the file gets a
    // fresh identity instead of being deleted by the connection.
    const bound = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    await bound.initialSync();

    expect(adapter.files.has(conflictFilePath("survivor.md"))).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("survivor.md"))).toBe("still here");
    const newFileId = bound.fileIdForPath("survivor.md")!;
    expect(newFileId).not.toBe(originalFileId);
    expect(api.chains.get(originalFileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(api.chains.get(newFileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(await api.readPlainLatest(newFileId)).toBe("still here");
  });
});

/**
 * The connection can be gone while the user keeps working. Every push fails, the
 * engine keeps no queue, and the vault websocket delivers no backlog on
 * `subscribe` — so the next full reconcile (a reconnect, the host's periodic
 * pass, a restart) is the only thing that carries those changes to the server.
 * These are the shapes that pass has to get right, each of them a way the old
 * behaviour either lost a local change or undid it.
 */
describe("SyncEngine — changes made while the connection is down", () => {
  it("pushes the tombstone for a delete whose push failed, instead of pulling it back", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // The user deletes the note while the server is unreachable.
    api.offline = true;
    adapter.files.delete("n.md");
    await expect(engine.handleLocalDelete("n.md")).rejects.toThrow();

    api.offline = false;
    await engine.initialSync();

    // The deletion is real and the server has to hear about it — not read it as
    // "a remote file this device is missing" and hand the note back.
    expect(adapter.files.has("n.md")).toBe(false);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("resolves a tombstone a peer's edit refused during a pass", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // The user deletes it while the connection is down; the tombstone never lands.
    api.offline = true;
    adapter.files.delete("n.md");
    await expect(engine.handleLocalDelete("n.md")).rejects.toThrow("network down");
    api.offline = false;

    // The pass decides from a chain whose head is still this device's sync point, so it
    // pushes the tombstone — and a peer edit lands between the decision and the request,
    // which is a deletion racing an edit. That refusal is the case this branch exists
    // for: it has to resolve as the peer's version coming back, not be dropped into
    // `firstFailure` and forgotten until the next pass.
    api.onPush = async (files) => {
      api.onPush = null;
      for (const file of files) await api.remoteEdit(file.fileId, "peer-rushed");
    };
    await engine.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("peer-rushed");
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
  });

  it("pushes that tombstone after a restart as well", async () => {
    let persisted = "{}";
    const { engine, adapter, api, key } = await makeEngine((json) => {
      persisted = json;
    });
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    api.offline = true;
    adapter.files.delete("n.md");
    await expect(engine.handleLocalDelete("n.md")).rejects.toThrow();

    // Obsidian restarts before the connection comes back: the engine is rebuilt
    // from what settings hold, which is the state from *before* the deletion.
    api.offline = false;
    const restored = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    restored.loadState(persisted);
    await restored.initialSync({ firstBind: true });

    expect(adapter.files.has("n.md")).toBe(false);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("pushes a tombstone for a file deleted while the app was closed", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // No engine call at all: the file disappeared from the directory while
    // nothing was watching it.
    adapter.files.delete("n.md");
    await engine.initialSync();

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("pushes an edit made in another editor while the app was closed", async () => {
    let persisted = "{}";
    const { engine, adapter, api, key } = await makeEngine((json) => {
      persisted = json;
    });
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // Nothing is running, so no vault event exists to hear: the file is changed by
    // another editor (VS Code, a sync tool) and the engine only learns about it when
    // the next start binds the vault from what settings and the disk hold.
    adapter.files.set("n.md", encoder.encode("v2 from another editor"));

    const rebound = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    rebound.loadState(persisted);
    await rebound.initialSync({ firstBind: true });

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("v2 from another editor");
  });

  it("does not turn a vault listing that lags a write into a tombstone", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // The listing misses a file the adapter can still read — Obsidian's index
    // lagging a write. Absence from one listing is not evidence of a deletion.
    const listSyncableFiles = adapter.listSyncableFiles.bind(adapter);
    adapter.listSyncableFiles = async () => [];
    await engine.initialSync();
    adapter.listSyncableFiles = listSyncableFiles;

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(adapter.files.has("n.md")).toBe(true);
  });

  it("pushes the rename and keeps one chain when the move could not be pushed", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    api.offline = true;
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("v1"));
    await expect(engine.handleLocalRename("old.md", "new.md")).rejects.toThrow();

    api.offline = false;
    await engine.initialSync();

    // The versionId and the content already agree, so nothing but the recorded
    // path tells the chain that the note moved.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect([...api.chains.keys()]).toEqual([fileId]);
    expect(await decryptString(key, api.paths.get(fileId)!)).toBe("new.md");
    expect(adapter.files.has("old.md")).toBe(false);
  });

  it("keeps one chain when that move is followed by a restart", async () => {
    let persisted = "{}";
    const { engine, adapter, api, key } = await makeEngine((json) => {
      persisted = json;
    });
    adapter.files.set("old.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    api.offline = true;
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("v1"));
    await expect(engine.handleLocalRename("old.md", "new.md")).rejects.toThrow();

    // The move happened on disk, so it has to be in the persisted state even
    // though the push failed — otherwise the restart reads the old path as
    // deleted and the new one as a brand-new file.
    expect(JSON.parse(persisted)[fileId].plainPath).toBe("new.md");

    api.offline = false;
    const restored = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    restored.loadState(persisted);
    await restored.initialSync({ firstBind: true });

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect([...api.chains.keys()]).toEqual([fileId]);
    expect(await decryptString(key, api.paths.get(fileId)!)).toBe("new.md");
    expect(adapter.files.has("old.md")).toBe(false);
  });

  it("repairs a move that never reached the engine as a rename, not a delete plus a new file", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // Nothing told the engine about the move at all (the plugin was disabled
    // while the vault was reorganised, or an external tool moved the file).
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("v1"));
    await engine.initialSync();

    // One note, one chain: a tombstone here plus a fresh fileId for the new path
    // would leave a duplicate on every peer and split the history in two.
    expect([...api.chains.keys()]).toEqual([fileId]);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect(await decryptString(key, api.paths.get(fileId)!)).toBe("new.md");
  });

  it("keeps two same-content files on their own chains when only one of them moved", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("same bytes"));
    await engine.initialSync();
    const first = api.pushed.find((p) => p.action === "create")!;

    // A second, genuinely separate note with the same content, then a move of the
    // first one. The content match is ambiguous, so the move must not adopt the
    // other chain's file.
    adapter.files.set("b.md", encoder.encode("same bytes"));
    await engine.handleLocalChange("b.md");
    const second = api.pushed.find((p) => p.fileId !== first.fileId)!;

    adapter.files.delete("a.md");
    adapter.files.set("moved.md", encoder.encode("same bytes"));
    await engine.initialSync();

    expect(sortedCopy(api.chains.keys())).toEqual(sortedCopy([first.fileId, second.fileId]));
    expect(engine.fileIdForPath("moved.md")).toBe(first.fileId);
    expect(engine.fileIdForPath("b.md")).toBe(second.fileId);
  });
});

/**
 * A host reconciles on a timer and on a reconnect, and neither has anything to do
 * with what the user is typing. A reconcile decides from the snapshot it takes
 * when it starts — the vault listing, the hashes of that moment, the chains as
 * they were — while the vault keeps firing events. Both then act on the same file,
 * and the reconcile is the one working from stale bytes: a duplicate version at
 * best, a pull over an edit that landed mid-pass at worst. The engine resolves
 * that without a lock — the reconcile skips a path an event is handling (nothing
 * ever waits, so no host can deadlock) and re-reads a file before writing it.
 */
describe("SyncEngine — a reconcile racing an incremental event", () => {
  it("does not push the rename an in-flight event is already pushing", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The user moves the note; its push is slow rather than failed. The pass queues
    // behind the rename's job (one job per path), so it sees the settled state and has
    // nothing to push — the duplicate the plugin suite caught cannot be built.
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("v1"));
    const held = holdFirstPush(api);
    const rename = engine.handleLocalRename("old.md", "new.md");
    await held.reached;

    const pass = engine.initialSync();
    held.release();
    await Promise.all([rename, pass]);

    // Exactly one rename, from the event that owns the file. A second one is the
    // duplicated version the plugin suite caught when the reconnect reconcile ran
    // against a snapshot the move had already invalidated.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect([...api.chains.keys()]).toEqual([fileId]);
    expect(engine.fileIdForPath("new.md")).toBe(fileId);
  });

  it("does not push the tombstone an in-flight delete is already pushing", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.delete("n.md");
    const held = holdFirstPush(api);
    const remove = engine.handleLocalDelete("n.md");
    await held.reached;

    const pass = engine.initialSync();
    held.release();
    await Promise.all([remove, pass]);

    // One tombstone. A second one would rewrite the recycle bin's "previous
    // version" to the hash of an empty string, which is what makes a file
    // unrestorable.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("does not pull over an edit that landed while the pass was running", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The peer moved the file on, and then the user typed in it — both while the
    // pass was running. The hook fires where the history request goes out, i.e.
    // after this pass has already hashed the vault, so its snapshot still says
    // "the local copy is untouched" while the disk says otherwise.
    await api.remoteEdit(fileId, "peer version");
    api.onIndex = async () => {
      adapter.files.set("n.md", encoder.encode("typed during the pass"));
    };
    await engine.initialSync();
    api.onIndex = null;

    // The pull that snapshot decided on would have overwritten the edit; re-reading
    // the file turns the two divergent versions into the conflict they are, and the
    // remote side wins it — with the typed content parked beside the note.
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("peer version");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md")))).toBe(
      "typed during the pass",
    );
  });

  it("does not record a sync point older than the push that landed mid-pass", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    await engine.initialSync();
    const aFileId = engine.fileIdForPath("a.md")!;
    const bFileId = engine.fileIdForPath("b.md")!;

    // A peer's edit makes the pass pull A, and that pull's write is the await this test
    // releases B's push inside.
    await api.remoteEdit(aFileId, "peer-a");

    // The index the pass reads is a snapshot of the chains, like the wire: the fake
    // copies each head out, so a version appended mid-pass cannot appear retroactively
    // in the snapshot that pass already fetched and hide the race this test is about.

    // The pass hashes the vault *before* the index request, so this edit to B lands
    // after the pass has hashed it while the chain the pass is about to fetch still has
    // B at v1. B's push is parked, so the chain stays behind this device's own push for
    // the whole pass — the exact shape "the head already holds the bytes on disk, while
    // the state is one version behind" describes.
    const held = holdFirstPush(api);
    let bEvent: Promise<void> | null = null;
    api.onIndex = async () => {
      adapter.files.set("b.md", encoder.encode("b edited"));
      bEvent = engine.handleLocalChange("b.md");
      await held.reached;
    };
    adapter.onWrite = async (path) => {
      if (path !== "a.md" || !bEvent) return;
      held.release();
      await bEvent;
      adapter.onWrite = null;
    };

    await engine.initialSync();
    api.onIndex = null;

    // B's push is the newest version and the pass's chain does not contain it. Adopting
    // the pass's head would move the sync point backwards, and the next edit of B would
    // then conflict with the version this device had just pushed.
    const chain = api.chains.get(bFileId)!;
    expect(chain.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(new TextDecoder().decode(adapter.files.get("b.md"))).toBe("b edited");
    const state = JSON.parse(engine.serializeState()) as Record<
      string,
      { lastKnownVersionId: string }
    >;
    expect(state[bFileId]?.lastKnownVersionId).toBe(chain.at(-1)!.versionId);

    // An ordinary edit after the pass builds on that head: one new version, no copy.
    adapter.files.set("b.md", encoder.encode("after"));
    await engine.handleLocalChange("b.md");
    expect(api.chains.get(bFileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
    expect(new Set(adapter.files.keys())).toEqual(new Set(["a.md", "b.md"]));
  });
});

/**
 * The mirror of the race above, and the one no client can see by looking harder:
 * this device decides from a chain, and a **peer pushes that same file before the
 * decision's push arrives**. Every version the server holds would then be one this
 * client never read, and its push would silently replace it.
 *
 * The push is therefore conditional — it carries the head it was decided from, and
 * the server refuses it when that is no longer the head (see `SyncPushResult`). The
 * engine answers a refusal by taking the chain it was refused by and deciding again
 * *without* moving its own sync point, so a peer's version becomes the conflict it
 * is rather than something this device builds on top of.
 */
describe("SyncEngine — a push the chain has moved past", () => {
  it("takes the peer's version when it lands while this device's push is in flight", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.set("n.md", encoder.encode("edited here"));
    pushFromPeerMidFlight(api, () => api.remoteEdit(fileId, "edited there"));
    await engine.handleLocalChange("n.md");

    // The re-decision is a conflict, and a conflict goes to the remote head: the
    // peer's version is what the note now holds, and this device's bytes are parked
    // beside it — the refused push left no version of its own on the chain.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md")))).toBe(
      "edited here",
    );
  });

  it("does not build on a peer's version when the reconcile's push is refused", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // A pass reads the chain once, at the start — which is the whole gap: the peer's
    // push can land between that read and this pass's own push.
    adapter.files.set("n.md", encoder.encode("edited here"));
    pushFromPeerMidFlight(api, () => api.remoteEdit(fileId, "edited there"));
    await engine.initialSync();

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md")))).toBe(
      "edited here",
    );
  });

  it("adopts the version it already pushed when the response was lost", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.set("n.md", encoder.encode("edited here"));
    // The push was applied and only its response was lost: the retry carries the
    // same bytes against a base that is now the version it already wrote.
    api.onPush = async (files) => {
      api.onPush = null;
      for (const f of files) {
        const chain = api.chains.get(f.fileId) ?? [];
        chain.push({
          versionId: f.versionId,
          contentHash: f.contentHash,
          encryptedPath: f.encryptedPath,
          action: f.action as SyncAction,
          sizeBytes: f.sizeBytes,
          mtimeMs: f.mtimeMs,
          createdAt: new Date().toISOString(),
        });
        api.chains.set(f.fileId, chain);
        if (f.content) api.blobs.set(f.contentHash, f.content);
      }
    };
    await engine.handleLocalChange("n.md");

    // Recognised as the version this device already got in: no duplicate version and
    // no conflict file.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited here");
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(engine.fileIdForPath("n.md")).toBe(fileId);
  });

  /**
   * The race that used to park a conflict copy of a file over itself.
   *
   * Two operations run on one path: the first edits and pushes, the second decides before
   * the first's response has updated this device's sync point — but after its push landed
   * on the chain. The head then holds exactly the bytes on disk while the state still
   * points at the previous version, which `decideFile` used to read as a conflict. Every
   * test here starts from that state: chain head content === local content, state one
   * version behind.
   */
  describe("a decision that meets this device's own content on the head", () => {
    /** Push `base`, then leave the chain one version ahead with the same bytes on disk. */
    async function racedState(text: string) {
      const { engine, adapter, api } = await makeEngine();
      adapter.files.set("n.md", encoder.encode("base"));
      await engine.initialSync();
      const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

      // The other operation's push of the new bytes landed on the chain…
      adapter.files.set("n.md", encoder.encode(text));
      await api.remoteEdit(fileId, text);
      // …while this engine's sync point is still the version before it.
      return { engine, adapter, api, fileId };
    }

    it("an incremental event records the head instead of parking a copy", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");

      await engine.handleLocalChange("n.md");

      // No second version, no conflict copy, and the note still holds those bytes.
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      // The head became the sync point, so the *next* edit builds on it normally.
      expect(syncPointOf(engine, fileId) ?? null).toBe(await api.latestVersionId(fileId));

      adapter.files.set("n.md", encoder.encode("same2"));
      await engine.handleLocalChange("n.md");
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
    });

    it("a pass records the head too", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");

      await engine.initialSync();

      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      expect(syncPointOf(engine, fileId) ?? null).toBe(await api.latestVersionId(fileId));
    });

    it("does not adopt the head over a push that landed while it fetched the ancestry", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");
      const passHead = (await api.latestVersionId(fileId))!;

      // The pass proves its older sync point from the full chain (a request the head-only
      // index cannot answer). While that request is in flight, a peer pushes a version
      // with the same bytes and the notification adopts it. The notification writes
      // nothing, so only the state re-check can see it; adopting the pass's head would
      // move the sync point backwards under the peer's newer version.
      const originalPull = api.pull.bind(api);
      let fired = false;
      let notification: Promise<void> | null = null;
      api.pull = async (vaultId, fileIds) => {
        const response = await originalPull(vaultId, fileIds);
        if (!fired) {
          fired = true;
          await api.remoteEdit(fileId, "same");
          // The notification's job queues behind this pass's job (one job per path), so
          // it is started, not awaited: waiting here would wait for the pass that is
          // waiting for this hook. The promise is awaited after the pass, below.
          notification = engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);
        }
        return response;
      };

      try {
        await engine.initialSync();
        await notification;
        await engine.whenIdle();
      } finally {
        api.pull = originalPull;
      }

      const newest = (await api.latestVersionId(fileId))!;
      expect(newest).not.toBe(passHead);
      expect(syncPointOf(engine, fileId)).toBe(newest);
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    });

    it("does not adopt when the bytes changed while it fetched the ancestry", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");
      const before = syncPointOf(engine, fileId);

      const originalPull = api.pull.bind(api);
      let fired = false;
      api.pull = async (vaultId, fileIds) => {
        const response = await originalPull(vaultId, fileIds);
        if (!fired) {
          fired = true;
          adapter.files.set("n.md", encoder.encode("typed during the fetch"));
        }
        return response;
      };
      try {
        await engine.initialSync();
      } finally {
        api.pull = originalPull;
      }

      // The local bytes no longer match the head the pass adopts; recording the old
      // sync point would claim bytes this device does not hold.
      expect(syncPointOf(engine, fileId)).toBe(before);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("typed during the fetch");
      expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    });

    it("does not adopt when the bytes changed after the pass hashed them", async () => {
      // A first bind: no sync point yet, so the head-only chain proves the convergence
      // by itself and the adoption has no fetch to re-check after. The file moves between
      // the pass's listing and the decision; adopting the head would claim those bytes
      // for a file that no longer holds them.
      const key = await deriveEncryptionKey(
        "password",
        btoa(String.fromCharCode(...new Uint8Array(32))),
      );
      const api = new FakeApi(key);
      const sourceAdapter = new FakeAdapter();
      sourceAdapter.files.set("n.md", encoder.encode("same"));
      const source = new SyncEngine({
        platform: realPlatform,
        vaultId: "vault-1",
        adapter: sourceAdapter,
        api,
        encryptionKey: key,
      });
      await source.initialSync();

      const targetAdapter = new FakeAdapter();
      targetAdapter.files.set("n.md", encoder.encode("same"));
      const target = new SyncEngine({
        platform: realPlatform,
        vaultId: "vault-1",
        adapter: targetAdapter,
        api,
        encryptionKey: key,
      });
      // The scan stats the path once; the adoption's "are these still the bytes I
      // hashed?" re-check stats it again. The file changes in that window, so the
      // re-check must refuse to claim the head for bytes it never hashed.
      let stats = 0;
      targetAdapter.onStat = (path) => {
        if (path !== "n.md") return;
        stats += 1;
        if (stats === 2) targetAdapter.files.set("n.md", encoder.encode("typed after hashing"));
      };
      try {
        await target.initialSync();
      } finally {
        targetAdapter.onStat = null;
      }

      // No identity was recorded for bytes the pass did not hash, and no second chain was
      // created for the path the server already holds.
      expect(JSON.parse(target.serializeState())).toEqual({});
      expect(target.fileIdForPath("n.md")).toBeNull();
      expect(api.chains.size).toBe(1);
      expect(new TextDecoder().decode(targetAdapter.files.get("n.md"))).toBe("typed after hashing");
    });

    it("leaves the sync point alone when the ancestry request fails", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");
      const before = syncPointOf(engine, fileId);
      const originalPull = api.pull.bind(api);
      api.pull = async () => {
        throw new Error("offline");
      };
      try {
        await expect(engine.initialSync()).resolves.toBeUndefined();
      } finally {
        api.pull = originalPull;
      }

      // A failed fetch is answered conservatively: the state keeps its point and the
      // bytes stay on disk; the next pass retries instead of the file failing the pass.
      expect(syncPointOf(engine, fileId)).toBe(before);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    });

    it("a peer's notification records the head too", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");
      const versionId = (await api.latestVersionId(fileId))!;

      await engine.handleFilePushed(fileId, versionId);

      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      expect(syncPointOf(engine, fileId)).toBe(versionId);
    });

    /**
     * The same rule, for the window a pull's **write** opens: the bytes are on disk
     * before the sync point is recorded, so a decision that lands in between reads them
     * as a divergence from the head it is about to apply.
     *
     * This is the shape a note saved twice by Obsidian leaves behind — the app saves a
     * note again when the attachment it embeds finishes landing, so the peer's next
     * version can arrive while this device is still recording the previous one. It parked
     * a conflict copy of the note the engine had just pulled, and the pull that was still
     * in flight then moved the sync point *back* under the notification.
     */
    it("does not park a conflict copy of the bytes a pull is still recording", async () => {
      const conflicts: ConflictResolvedEvent[] = [];
      const { engine, adapter, api } = await makeEngine(undefined, (event) =>
        conflicts.push(event),
      );
      adapter.files.set("n.md", encoder.encode("v1"));
      await engine.initialSync();
      const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

      // The peer's first save is on the chain; a pass's index sees it.
      await api.remoteEdit(fileId, "v2");

      adapter.onWrite = async (path) => {
        if (path !== "n.md") return;
        adapter.onWrite = null;
        // The adapter has landed the pull's bytes and the engine has not recorded their
        // sync point yet — the notify-only turn the peer's second save arrives in.
        await api.remoteEdit(fileId, "v3");
        await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);
      };

      await engine.initialSync();
      adapter.onWrite = null;
      // The notification's job was queued behind the pull's (one job per path): let it
      // run before asserting the settled state.
      await engine.whenIdle();

      // Nothing the user wrote was overwritten, so nothing is parked; the note ends on
      // the peer's newest version, and so does the sync point.
      expect(conflicts).toEqual([]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("v3");
      expect(syncPointOf(engine, fileId)).toBe(await api.latestVersionId(fileId));
    });

    /**
     * The same window with the peer's version at another path: the notification follows a
     * rename, and the in-flight pull then re-creates the old path with its own bytes.
     * Those bytes must be removed, or the next pass reads them as a new file and forks a
     * second chain for the same note.
     */
    it("removes the old path a pull re-created after the peer moved the file", async () => {
      const { engine, adapter, api, key } = await makeEngine();
      adapter.files.set("n.md", encoder.encode("v1"));
      await engine.initialSync();
      const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
      await api.remoteEdit(fileId, "v2");

      const writeFile = adapter.writeFile.bind(adapter);
      let injected = false;
      adapter.writeFile = async (path, bytes) => {
        if (path === "n.md" && !injected) {
          injected = true;
          adapter.writeFile = writeFile;
          // The peer renames and edits: the notification's pull follows the move and
          // applies v3 at m.md, while this pull is still holding v2's write.
          await api.remoteRename(fileId, await encryptString(key, "m.md"));
          await api.remoteEdit(fileId, "v3");
          await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);
        }
        await writeFile(path, bytes);
      };

      await engine.initialSync();
      adapter.writeFile = writeFile;
      await engine.whenIdle();

      expect([...adapter.files.keys()]).toEqual(["m.md"]);
      expect(new TextDecoder().decode(adapter.files.get("m.md"))).toBe("v3");
      expect(syncPointOf(engine, fileId)).toBe(await api.latestVersionId(fileId));
      expect(engine.fileIdForPath("m.md")).toBe(fileId);
      expect(engine.fileIdForPath("n.md")).toBeNull();
    });

    /**
     * A deletion landing while a pull's write is in flight: the notification's job queues
     * behind the pull (one job per path), so it applies the tombstone to the settled state
     * — the file is deleted and the chain stays one chain, never a second one for the path.
     */
    it("applies a deletion that lands while a pull's write is in flight", async () => {
      const { engine, adapter, api } = await makeEngine();
      adapter.files.set("n.md", encoder.encode("v1"));
      await engine.initialSync();
      const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
      await api.remoteEdit(fileId, "v2");

      const writeFile = adapter.writeFile.bind(adapter);
      let injected = false;
      adapter.writeFile = async (path, bytes) => {
        if (path === "n.md" && !injected) {
          injected = true;
          adapter.writeFile = writeFile;
          const deleted = await api.remoteDelete(fileId);
          await engine.handleFilePushed(fileId, deleted);
        }
        await writeFile(path, bytes);
      };

      await engine.initialSync();
      adapter.writeFile = writeFile;
      await engine.whenIdle();

      // The pull settled v2, then the queued tombstone applied: the file is gone, the
      // path is untracked, and the chain is still the one it was.
      expect(adapter.files.has("n.md")).toBe(false);
      expect(engine.fileIdForPath("n.md")).toBeNull();
      expect([...api.chains.keys()]).toEqual([fileId]);
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "delete"]);
    });
  });

  it("keeps the later of two edits when both of its own pushes are in flight at once", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The first edit is on its way to the server and stuck there — a large file's
    // upload, a slow link — and the second edit is made and pushed while it is still
    // in flight. Both were decided from the same head, so the server appends the
    // second and refuses the first; nothing here needs a queue on the client for
    // the order to come out right.
    let firstPushStarted: (() => void) | null = null;
    const atPush = new Promise<void>((resolve) => {
      firstPushStarted = resolve;
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let held = false;
    api.onPush = async () => {
      if (held) return;
      held = true;
      firstPushStarted!();
      await gate;
    };

    adapter.files.set("n.md", encoder.encode("edited first"));
    const firstChange = engine.handleLocalChange("n.md");
    await atPush;

    adapter.files.set("n.md", encoder.encode("edited second"));
    // The second edit's job queues behind the first (one job per path), so it reads the
    // file after the first push settled and builds on its version.
    const secondChange = engine.handleLocalChange("n.md");
    releaseFirst();
    await Promise.all([firstChange, secondChange]);

    // The later edit is the head and the content on disk; the earlier version stays on
    // the chain and nothing was parked — the two edits are ordered, not raced.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited second");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited second");
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(engine.fileIdForPath("n.md")).toBe(fileId);
  });

  it("brings the file back when a deletion loses the race, because the remote side wins", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.delete("n.md");
    pushFromPeerMidFlight(api, () => api.remoteEdit(fileId, "edited there"));
    await engine.handleLocalDelete("n.md");

    // The tombstone would have removed a version this device never saw, so it is
    // refused. The two intents meet in a conflict, and the remote one wins: the
    // peer's version is on disk, and the deletion — which has no content — loses
    // without leaving a conflict file behind.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited there");
  });

  it("takes the peer's version when a pass finds the deletion, not the failed push", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The user deletes the note while the network is down, and a peer edits it before
    // the next pass: the deletion never reached the chain, so the pass is where the
    // two intents meet.
    api.offline = true;
    adapter.files.delete("n.md");
    await expect(engine.handleLocalDelete("n.md")).rejects.toThrow();
    await api.remoteEdit(fileId, "edited there");
    api.offline = false;

    await engine.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited there");
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
  });

  it("parks a second conflict in the same second beside the first, and reports both", async () => {
    const resolved: ConflictResolvedEvent[] = [];
    const { engine, adapter, api } = await makeEngine(undefined, (event) => resolved.push(event));
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.set("n.md", encoder.encode("local one"));
    await api.remoteEdit(fileId, "peer one");
    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    adapter.files.set("n.md", encoder.encode("local two"));
    await api.remoteEdit(fileId, "peer two");
    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    // A second conflict on the same file inside the same second must not overwrite the
    // copy the first one parked — that content is the only copy there is. (The clock is
    // frozen for this file, so both copies really do land in one second.)
    expect(
      new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md", new Date(), 1))),
    ).toBe("local one");
    expect(
      new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md", new Date(), 2))),
    ).toBe("local two");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("peer two");

    expect(resolved).toEqual([
      {
        fileId,
        plainPath: "n.md",
        conflictPath: conflictFilePath("n.md", new Date(), 1),
        remoteAction: "write",
      },
      {
        fileId,
        plainPath: "n.md",
        conflictPath: conflictFilePath("n.md", new Date(), 2),
        remoteAction: "write",
      },
    ]);
  });
});

/**
 * A host's adapter fires a vault event for every write **the engine itself
 * performs**, and the host feeds that event straight back into
 * `handleLocalChange` / `handleLocalDelete` — while the engine is still midway
 * through its own operation, before its state has caught up. The engine must
 * treat those events as echoes of its own action, exactly like it already
 * suppresses the websocket echo of a version it pushed (`pushedVersions`).
 *
 * Every test below drives that echo at the adapter boundary, which is where a
 * real host produces it. Without the suppression each shape is damaged in its
 * own way, so each one is pinned separately.
 */
describe("SyncEngine — the vault event caused by its own write", () => {
  it("does not record a conflict from the event its own restore write causes", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("phoenix.md", encoder.encode("rises again"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // This device deleted the file seconds ago. The delete push re-established
    // the path → fileId mapping, so the echo looks like a local edit *under a
    // delete head* — treating it as a conflict would park the note the user is
    // actively restoring.
    await engine.handleLocalDelete("phoenix.md");

    let conflictFileDuringRestore: boolean | "the vault-event handler never ran" =
      "the vault-event handler never ran";
    adapter.onWrite = async (path) => {
      adapter.onWrite = null;
      await engine.handleLocalChange(path);
      conflictFileDuringRestore = adapter.files.has(conflictFilePath("phoenix.md"));
    };
    await engine.restoreFile(created.fileId, "phoenix.md", created.contentHash);

    // Nothing about the engine's own write may reach the user as a conflict.
    // The sentinel string names the failure in the diff; compare the boolean it
    // guards explicitly (Bun's `toBe` will not take `false` for `boolean | string`).
    expect<boolean | string>(conflictFileDuringRestore).toBe(false);
    expect(adapter.files.has(conflictFilePath("phoenix.md"))).toBe(false);
    expect(api.pushed.map((p) => p.action)).toEqual(["create", "delete", "restore"]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(await api.readPlainLatest(created.fileId)).toBe("rises again");
  });

  it("does not push a second restore when the echo of its own write comes back", async () => {
    // The echo answers "a local edit under a delete head", which a conflict path
    // would resolve by pushing the restored bytes as a *second* restore version —
    // one extra version and one extra request per restore.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("phoenix.md", encoder.encode("rises again"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    await engine.handleLocalDelete("phoenix.md");

    adapter.onWrite = async (path) => {
      adapter.onWrite = null;
      await engine.handleLocalChange(path);
    };
    await engine.restoreFile(created.fileId, "phoenix.md", created.contentHash);

    expect(api.pushed.map((p) => p.action)).toEqual(["create", "delete", "restore"]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(await api.readPlainLatest(created.fileId)).toBe("rises again");
  });

  it("does not read its own pull as an edit when the vault reports that write twice", async () => {
    // Obsidian reports one write as more than one event — a file the engine created
    // is handed to the host as `create` *and* `modify` — and both arrive while the
    // engine is still midway through the pull that wrote the file. Suppressing only
    // the first left the second to be read as a divergent local edit, so the engine
    // parked a conflict copy of the content it had just pulled and pulled it again.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    await api.remoteEdit(created.fileId, "v2 from the peer");

    let writes = 0;
    adapter.onWrite = async (path) => {
      writes++;
      // Only the pull's own write: a write the *conflict path* performs must not
      // re-enter this hook, or a broken engine recurses instead of failing an
      // assertion (which is what it did in a real vault: the conflict copy's own
      // write fired more events, so the copies escalated `-2`, `-3`, `-4`…).
      if (writes > 1) return;
      // One write, two events — the way Obsidian reports a file it just created.
      await engine.handleLocalChange(path);
      await engine.handleLocalChange(path);
    };
    await engine.handleFilePushed(created.fileId, (await api.latestVersionId(created.fileId))!);

    expect(writes).toBe(1);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("v2 from the peer");
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    // The echo pushed nothing: one create, and the peer's modify.
    expect(api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
  });

  it("does not invent a second fileId when restoring a peer-deleted file", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("phoenix.md", encoder.encode("rises again"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // A peer deleted it, so there is no local delete the rename heuristic could
    // match — which is exactly when the echo used to birth a new fileId. (The
    // local copy is removed first: a local file under a tombstone is a *new*
    // file, not something to restore.)
    adapter.files.delete("phoenix.md");
    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));
    expect(adapter.files.has("phoenix.md")).toBe(false);

    adapter.onWrite = async (path) => {
      adapter.onWrite = null;
      await engine.handleLocalChange(path);
    };
    await engine.restoreFile(created.fileId, "phoenix.md", created.contentHash);

    // One chain for the restored path, still the original identity.
    expect([...api.chains.keys()]).toEqual([created.fileId]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(api.pushed.map((p) => p.action)).toEqual(["create", "restore"]);
    expect(adapter.files.has(conflictFilePath("phoenix.md"))).toBe(false);
    expect(await api.readPlainLatest(created.fileId)).toBe("rises again");
  });

  /**
   * Applying a peer's delete is the other half of the same problem, and the more
   * damaging one: the engine's own `delete` event arrives before it has cleared
   * the path → fileId mapping, so it used to push a second tombstone. The recycle
   * bin reads the version *before* the delete as the restorable one, so that
   * extra tombstone made every peer-deleted file unrestorable — the panel tried
   * to fetch the content hash of an empty string and failed.
   */
  it("does not push a second tombstone when it applies a peer's delete", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("untouched"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The user removed the note locally, so applying the peer's delete is the
    // only sensible outcome.
    adapter.files.delete("gone.md");
    adapter.onDelete = async (path) => {
      adapter.onDelete = null;
      await engine.handleLocalDelete(path);
    };
    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));

    expect(api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(adapter.files.has("gone.md")).toBe(false);
  });

  /**
   * A file written at a path whose chain ends in a tombstone is a **new** file.
   *
   * The notification that applied the peer's deletion must not stay in the live-path
   * index: adopting that identity (or matching it by content — a delete version's hash
   * is the empty string's) turns the user's restored note into a conflict against the
   * deletion and deletes it again, leaving the copy parked instead of the note.
   */
  it("pushes a local file at a peer-deleted path as a new chain, not a conflict", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("deleted by the peer"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));
    expect(adapter.files.has("gone.md")).toBe(false);

    // An empty file is the adversarial case: its hash IS the tombstone's content hash.
    adapter.files.set("gone.md", encoder.encode(""));
    await engine.handleLocalChange("gone.md");

    const restored = api.pushed.filter((p) => p.action === "create").at(-1)!;
    expect(restored.fileId).not.toBe(created.fileId);
    // The dead chain keeps its tombstone; the new file has a chain of its own.
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(api.chains.get(restored.fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(adapter.files.has(conflictFilePath("gone.md"))).toBe(false);
  });

  it("does not push a second rename when following a peer's move", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved by the peer"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer moves the file: the new head records the new path.
    api.paths.set(created.fileId, await encryptString(key, "new.md"));
    await api.remoteEdit(created.fileId, "moved by the peer");

    // Following that move renames the local file, which fires the host's event
    // while the engine still maps the old path.
    adapter.onRename = async (from, to) => {
      adapter.onRename = null;
      await engine.handleLocalRename(from, to);
    };
    await engine.handleFilePushed(created.fileId, (await api.latestVersionId(created.fileId))!);

    expect(adapter.files.has("new.md")).toBe(true);
    // The old path must be gone: falling back to it recreates the file the peer
    // moved away from, which leaves both paths on disk.
    expect(adapter.files.has("old.md")).toBe(false);
    expect(adapter.files.size).toBe(1);
    expect(api.pushed.map((p) => p.action)).toEqual(["create"]);
  });

  it("follows a peer's move when the vault reported the new path first", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved while we watched"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer moves the file: the new head records the new path.
    api.paths.set(created.fileId, await encryptString(key, "new.md"));
    await api.remoteEdit(created.fileId, "moved while we watched");

    // The vault already applied the move locally, so the old path is gone while
    // the engine still maps it. Real Obsidian would report a `rename` for this,
    // but the notification can arrive after the vault's own event (or not at
    // all), and the engine must not turn the reported path into a new file.
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("moved while we watched"));

    await engine.handleFilePushed(created.fileId, (await api.latestVersionId(created.fileId))!);

    expect(adapter.files.has("new.md")).toBe(true);
    expect(adapter.files.has("old.md")).toBe(false);
    expect(adapter.files.size).toBe(1);
    expect([...api.chains.keys()]).toEqual([created.fileId]);
    expect(engine.fileIdForPath("new.md")).toBe(created.fileId);
    // The state moved with the file: an entry still naming the old path is what
    // makes the next reconcile read the new path as untracked and fork a chain.
    const persisted = JSON.parse(engine.serializeState()) as Record<string, { plainPath: string }>;
    expect(Object.values(persisted).map((entry) => entry.plainPath)).toEqual(["new.md"]);
  });

  it("does not recreate the source path when the peer's move is applied", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved by the peer"));
    await engine.initialSync({ firstBind: true });
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer moves the file and the vault has already applied the move locally,
    // but the engine has not processed an event for it yet — a dropped rename
    // notification. The engine still maps the old path.
    api.paths.set(created.fileId, await encryptString(key, "new.md"));
    await api.remoteEdit(created.fileId, "moved by the peer");
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("moved by the peer"));

    await engine.handleFilePushed(created.fileId, (await api.latestVersionId(created.fileId))!);

    // The pull must land at the peer's path: falling back to the mapped old path
    // recreates the file the move removed, leaving both paths on disk.
    expect(adapter.files.has("new.md")).toBe(true);
    expect(adapter.files.has("old.md")).toBe(false);
    expect(adapter.files.size).toBe(1);
    expect([...api.chains.keys()]).toEqual([created.fileId]);
    expect(engine.fileIdForPath("new.md")).toBe(created.fileId);
  });

  it("adopts the remote fileId for a path no remote chain records", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("renamed by the peer"));
    await engine.initialSync({ firstBind: true });
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer renames it and that push never reaches this engine: the server's
    // live path is still the *old* one, while the vault already reports a file at
    // the new path. Without the content-identity net this forks a second chain.
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("renamed by the peer"));

    await engine.handleLocalChange("new.md");

    // One path, one chain, same fileId — not a second chain for the new path.
    expect([...api.chains.keys()]).toEqual([created.fileId]);
    expect(engine.fileIdForPath("new.md")).toBe(created.fileId);
    expect(engine.fileIdForPath("old.md")).toBeNull();
    expect(api.chains.get(created.fileId)!.at(-1)!.action).toBe("rename");
    expect(api.pushed.map((p) => p.action)).toEqual(["create", "rename"]);
  });

  it("does not treat its own push as a remote change when the echo beats the response", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    adapter.files.set("note.md", encoder.encode("first revision"));

    // The server broadcasts `file_pushed` while the push HTTP call is still in
    // flight, so the echo arrives before `push` resolves. Registering the pushed
    // versionId only after the response left a window in which the engine read
    // its own change back and pushed it a second time.
    let echoed = false;
    api.onPush = async (files) => {
      if (echoed) return;
      echoed = true;
      const file = files[0];
      await engine.handleFilePushed(file.fileId, file.versionId);
    };

    await engine.handleLocalChange("note.md");

    expect(api.pushed).toHaveLength(1);
    expect([...api.chains.keys()]).toHaveLength(1);
    expect(adapter.files.has(conflictFilePath("note.md"))).toBe(false);
    expect(adapter.files.size).toBe(1);
  });

  it("forgets a pushed version once its echo window closes", async () => {
    const { engine, adapter } = await makeEngine();
    await engine.initialSync();

    // The server skips the pushing session's own subscription, so on the ordinary path
    // the echo this record exists for never arrives at all. Without a deadline the map
    // grew by one id per push for as long as the host stayed up — weeks, for the CLI
    // daemon — which is the leak this pins. (Read through a cast: the record is
    // deliberately not part of the engine's public surface; `SelfEventLog`'s own tests
    // pin the window itself.)
    const pending = () =>
      (engine as unknown as { selfEvents: { pendingEchoes: number } }).selfEvents.pendingEchoes;

    adapter.files.set("first.md", encoder.encode("first"));
    await engine.handleLocalChange("first.md");
    expect(pending()).toBe(1);

    vi.setSystemTime(new Date(Date.now() + 11_000));

    adapter.files.set("second.md", encoder.encode("second"));
    await engine.handleLocalChange("second.md");

    // The earlier record's window has closed, so it is dropped instead of accumulated.
    expect(pending()).toBe(1);
  });

  it("keeps pulling its peers' changes when one of its own pushes is refused", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    // Two files this device owns, in a deliberate order: the refused push has to be met
    // before the pull, or the case cannot tell the two behaviours apart (the assertion at
    // the end checks that it really was met first).
    adapter.files.set("mine.md", encoder.encode("mine v1"));
    adapter.files.set("theirs.md", encoder.encode("theirs v1"));
    await engine.initialSync();

    // A peer on the same vault edits the second file.
    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    peerAdapter.files.set("theirs.md", encoder.encode("theirs v2"));
    await peer.handleLocalChange("theirs.md");

    // This device edits its own file, and the server refuses every push it makes — a full
    // quota is the real case (413 QUOTA_EXCEEDED). Hold the peer's content fetch just long
    // enough that the refusal is observed before the pull finishes; otherwise the faster
    // pull (the review's stamp shortcut) can win the race and make the assertion blind.
    adapter.files.set("mine.md", encoder.encode("mine v2"));
    api.contentDelayMs = 50;
    let peerChangeWasAlreadyPulled = false;
    api.onPush = async () => {
      peerChangeWasAlreadyPulled =
        new TextDecoder().decode(adapter.files.get("theirs.md")) === "theirs v2";
      throw new Error("QUOTA_EXCEEDED");
    };

    // The failure still reaches the host...
    await expect(engine.initialSync()).rejects.toThrow(/QUOTA_EXCEEDED/);
    // ...but it no longer ends the pass. The refused push came first, so the peer's edit
    // was skipped with it — which is how a device that is merely out of quota stopped
    // receiving its peers' changes while it still looked connected.
    expect(peerChangeWasAlreadyPulled).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("theirs.md"))).toBe("theirs v2");
  });

  it("keeps two live files with identical content on separate chains", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("same bytes"));
    await engine.initialSync();
    const first = api.pushed.find((p) => p.action === "create")!;

    // A second, genuinely separate file with the same content. Its bytes match a
    // live chain, but that chain's file is still here — adopting it would merge
    // two files the user sees as distinct.
    adapter.files.set("b.md", encoder.encode("same bytes"));
    await engine.handleLocalChange("b.md");

    const second = api.pushed.find((p) => p.fileId !== first.fileId);
    expect(second).toBeDefined();
    expect(second!.action).toBe("create");
    expect([...api.chains.keys()]).toEqual([first.fileId, second!.fileId]);
    expect(engine.fileIdForPath("a.md")).toBe(first.fileId);
    expect(engine.fileIdForPath("b.md")).toBe(second!.fileId);
  });

  it("does not push a pulled file back as a second file", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    // A running host: `initialSync` is what makes local events incremental.
    await engine.initialSync();

    // A peer creates a file this engine has never seen.
    const fileId = generateFileId();
    api.paths.set(fileId, await encryptString(key, "from-peer.md"));
    await api.remoteEdit(fileId, "created by the peer");

    adapter.onWrite = async (path) => {
      adapter.onWrite = null;
      await engine.handleLocalChange(path);
    };
    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    // The echo of the pull's own write must not be mistaken for a brand new
    // local file, which would push the same content back under a new fileId.
    expect(new TextDecoder().decode(adapter.files.get("from-peer.md"))).toBe("created by the peer");
    expect(api.pushed).toHaveLength(0);
    expect([...api.chains.keys()]).toEqual([fileId]);
  });
});

/**
 * A restore resurrects a deleted file at the path it used to live at — but that
 * path can have been taken since. Overwriting it silently destroys the occupying
 * file's live content locally, and (because the occupant is a different chain)
 * leaves two chains claiming one path, which the next reconcile "resolves" by
 * pushing the restored bytes into the occupant's chain.
 */
describe("SyncEngine — restoring onto a path that is no longer free", () => {
  /**
   * `hero.md` created and deleted, then re-created by a **fresh** engine — what
   * "Obsidian was closed and reopened, then a new note at the old path" produces:
   * the tombstone is excluded from the bind pass, so the new note is its own chain
   * and the old path is now held by it.
   */
  async function makeOccupiedPath() {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("hero.md", encoder.encode("old content"));
    await engine.initialSync();
    const old = api.pushed.find((p) => p.action === "create")!;
    await engine.handleLocalDelete("hero.md");
    adapter.files.delete("hero.md"); // what the user's delete does to the disk

    const reopened = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    await reopened.initialSync({ firstBind: true });
    adapter.files.set("hero.md", encoder.encode("new content"));
    await reopened.handleLocalChange("hero.md");
    const occupant = api.pushed.filter((p) => p.action === "create").at(-1)!;

    expect(occupant.fileId).not.toBe(old.fileId);
    return { engine: reopened, adapter, api, key, old, occupant };
  }

  it("refuses to overwrite the note that now holds the deleted file's path", async () => {
    const { engine, adapter, api, old, occupant } = await makeOccupiedPath();

    const status = await engine.inspectRestoreTarget(old.fileId, "hero.md");
    expect(status.kind).toBe("other-file");
    expect(status.holderFileId).toBe(occupant.fileId);

    const pushedBefore = api.pushed.length;
    await expect(engine.restoreFile(old.fileId, "hero.md", old.contentHash)).rejects.toMatchObject({
      reason: "occupied-by-other-file",
      message: expect.stringContaining("is already held"),
    });

    // Nothing written, nothing pushed, both files exactly as they were.
    expect(new TextDecoder().decode(adapter.files.get("hero.md"))).toBe("new content");
    expect(api.pushed).toHaveLength(pushedBefore);
    expect(api.chains.get(old.fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("restores under another name when the old path is taken", async () => {
    const { engine, adapter, api, key, old, occupant } = await makeOccupiedPath();

    await engine.restoreFile(old.fileId, "hero.md", old.contentHash, {
      targetPath: "hero (恢复).md",
    });

    // The restored note is back, under the new name.
    expect(new TextDecoder().decode(adapter.files.get("hero (恢复).md")!)).toBe("old content");
    // The note that took the path keeps its content *and* its identity.
    expect(new TextDecoder().decode(adapter.files.get("hero.md"))).toBe("new content");
    expect(engine.fileIdForPath("hero.md")).toBe(occupant.fileId);
    expect(engine.fileIdForPath("hero (恢复).md")).toBe(old.fileId);

    // One chain per path: the restore version records the name it came back as.
    expect(api.chains.get(old.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(await decryptString(key, api.paths.get(old.fileId)!)).toBe("hero (恢复).md");
  });

  it("refuses when an unattributed local file sits at the path", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("hero.md", encoder.encode("old content"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    // A peer deletes it and this device applies that deletion, which is when the
    // engine drops its path → fileId mapping entirely.
    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));

    // On disk again, but the vault event has not been processed yet, so no chain
    // claims it. That is still somebody's note — not ours to overwrite.
    adapter.files.set("hero.md", encoder.encode("unsynced note"));
    expect((await engine.inspectRestoreTarget(created.fileId, "hero.md")).kind).toBe(
      "unattributed",
    );

    await expect(
      engine.restoreFile(created.fileId, "hero.md", created.contentHash),
    ).rejects.toMatchObject({ reason: "unattributed-local-file" });
    expect(new TextDecoder().decode(adapter.files.get("hero.md"))).toBe("unsynced note");
  });

  it("refuses a restore whose chain names content the store no longer holds", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((push) => push.action === "create")!;
    // The row still names the version, but its blob was reclaimed.
    api.blobs.delete(created.contentHash);

    await expect(
      engine.restoreFile(created.fileId, "note.md", created.contentHash),
    ).rejects.toThrow(/Version content not found/);
    // Nothing was written from a missing payload.
    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("v1");
  });

  it("refuses a restore whose hash is not in the chain, instead of guessing a size", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((push) => push.action === "create")!;

    await expect(engine.restoreFile(created.fileId, "note.md", "f".repeat(64))).rejects.toThrow(
      /not in this file's history/,
    );
    // Nothing was fetched or written from a guess.
    expect(api.pushed).toHaveLength(1);
    expect(adapter.files.has("note.md")).toBe(true);
  });

  it("restores a version above this device's upload cap", async () => {
    // The cap bounds what a device **sends**; a version already in the chain is part of
    // the vault, so restoring it is not a reason to refuse. (The old rule refused it,
    // which left an old version silently unrestorable on a device whose account cap had
    // been lowered.)
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((push) => push.action === "create")!;
    // A device that may only upload one-byte files; the version is two bytes.
    adapter.files.delete("note.md");
    const capped = engineOver(adapter, api, key, { ...scopeWith(), maxFileBytes: 1 });

    await capped.restoreFile(created.fileId, "note.md", created.contentHash);

    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("v1");
  });

  it("still restores a version onto the chain's own file", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    adapter.files.set("note.md", encoder.encode("v2"));
    await engine.handleLocalChange("note.md");

    // The version-history entry point: the path holds *this* file, so restoring an
    // older version over it is the normal, expected write.
    expect((await engine.inspectRestoreTarget(created.fileId, "note.md")).kind).toBe("same-chain");

    await engine.restoreFile(created.fileId, "note.md", created.contentHash);
    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("v1");
    expect(api.chains.get(created.fileId)!.at(-1)!.action).toBe("restore");
  });

  it("has no live path for a chain whose deletion this device applied", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("deleted by the peer"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    expect(engine.pathForFileId(created.fileId)).toBe("gone.md");

    // The peer deletes it and this device applies that deletion, which is exactly
    // when the path → fileId mapping (and the state entry behind it) is dropped.
    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));

    // Nothing to prefer: a restore of this chain can only use what the caller knows.
    expect(engine.pathForFileId(created.fileId)).toBeNull();
  });

  it("writes a restore at the chain's own path, not the stale one a dialog held", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The user renames the note while the version-history dialog is open: the
    // dialog still holds "note.md", the chain now lives at "moved.md".
    adapter.files.delete("note.md");
    adapter.files.set("moved.md", encoder.encode("v2"));
    await engine.handleLocalRename("note.md", "moved.md");
    expect(engine.pathForFileId(created.fileId)).toBe("moved.md");

    await engine.restoreFile(created.fileId, "note.md", created.contentHash);

    // The content comes back where the chain is. Writing the stale path instead
    // would leave the chain live at two paths at once.
    expect(new TextDecoder().decode(adapter.files.get("moved.md")!)).toBe("v1");
    expect(adapter.files.has("note.md")).toBe(false);
    expect(engine.fileIdForPath("note.md")).toBeNull();
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "rename",
      "restore",
    ]);
    expect(await decryptString(key, api.paths.get(created.fileId)!)).toBe("moved.md");
  });
});

/**
 * The sync scope is a **device-local** decision, and it has to hold on both ends
 * of the wire: a path it rejects may neither be pushed out of this vault nor
 * pulled into it. Only the first half is obvious; the second is what keeps a
 * device with settings sync off from re-pulling a peer's `app.json` on every pass
 * and reporting a fresh "conflict" for it each time.
 *
 * `FakeAdapter.listSyncableFiles` deliberately returns *everything* in its map —
 * "what exists" — so these cases fail if the engine forgets to apply the scope.
 */
describe("SyncEngine — the sync scope", () => {
  const OBSIDIAN_DEFAULT = scopeWith(
    "app",
    "appearance",
    "themes",
    "snippets",
    "hotkeys",
    "corePlugins",
    "corePluginSettings",
  );
  const PLUGINS = scopeWith(...SETTINGS_GROUPS);
  const MARKDOWN_ONLY = scopeWith();

  /** A live chain the "peer" already pushed for `path`, blob and all. */
  async function seedRemoteFile(
    api: FakeApi,
    key: CryptoKey,
    path: string,
    content: string,
    mtimeMs = 0,
  ): Promise<{ fileId: string; versionId: string }> {
    const bytes = encoder.encode(content);
    const contentHash = await sha256Hex(bytes);
    api.blobs.set(contentHash, await encryptCombinedBytes(key, bytes as Uint8Array<ArrayBuffer>));
    const fileId = generateFileId();
    const versionId = generateVersionId();
    const encryptedPath = await encryptString(key, path);
    api.paths.set(fileId, encryptedPath);
    api.chains.set(fileId, [
      {
        versionId,
        contentHash,
        encryptedPath,
        action: "create",
        sizeBytes: bytes.byteLength,
        mtimeMs,
        createdAt: new Date().toISOString(),
      },
    ]);
    return { fileId, versionId };
  }

  it("answers a caller whether it syncs a path, with the scope it was built with", async () => {
    // The public door exists for the one path that comes from a *person* rather than from
    // the vault or the server: the new file name a restore is put under, which the dialog
    // checks before handing it over. What it must not be is a second, settings-derived
    // opinion — a host restarted for a switch change is the authority on what it syncs.
    const off = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    expect(off.engine.isSyncablePath("note.md")).toBe(true);
    expect(off.engine.isSyncablePath("photo.raw")).toBe(false);
    expect(off.engine.isSyncablePath(".obsidian/app.json")).toBe(false);

    const settings = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    expect(settings.engine.isSyncablePath(".obsidian/app.json")).toBe(true);
    expect(settings.engine.isSyncablePath("photo.raw")).toBe(false);
  });

  it("pushes a settings file only when the scope allows it", async () => {
    const off = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    off.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    off.adapter.files.set("note.md", encoder.encode("# note"));

    await off.engine.initialSync();

    expect(off.api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(await decryptString(off.key, off.api.pushed[0]!.encryptedPath)).toBe("note.md");

    const on = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    on.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    on.adapter.files.set("note.md", encoder.encode("# note"));

    await on.engine.initialSync();

    const paths = await Promise.all(
      on.api.pushed.map((p) => decryptString(on.key, p.encryptedPath)),
    );
    expect(sortedCopy(paths)).toEqual([".obsidian/app.json", "note.md"]);
  });

  it("pushes the settings files the scope allows, and never this plugin's own folder", async () => {
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, PLUGINS);
    adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    adapter.files.set(".obsidian/snippets/wide.css", encoder.encode("body {}"));
    adapter.files.set(".obsidian/plugins/courier/data.json", encoder.encode('{"deviceName":"x"}'));
    adapter.files.set(".obsidian/plugins/dataview/main.js", encoder.encode("module.exports={}"));

    await engine.initialSync();

    const paths = await Promise.all(api.pushed.map((p) => decryptString(key, p.encryptedPath)));
    expect(sortedCopy(paths)).toEqual([
      ".obsidian/app.json",
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/snippets/wide.css",
    ]);
  });

  it("ignores a peer's settings chain completely when settings sync is off", async () => {
    const { adapter, api, key } = await makeEngine();
    const conflicts: ConflictResolvedEvent[] = [];
    const engine = engineOver(adapter, api, key, MARKDOWN_ONLY, (event) => conflicts.push(event));
    const seeded = await seedRemoteFile(api, key, ".obsidian/app.json", '{"theme":"moonstone"}');

    await engine.initialSync();
    await engine.handleFilePushed(seeded.fileId, seeded.versionId);

    // Not pulled, not written, not parked as a conflict file, no notice.
    expect(adapter.files.has(".obsidian/app.json")).toBe(false);
    expect(adapter.files.has(conflictFilePath(".obsidian/app.json"))).toBe(false);
    expect(conflicts).toEqual([]);
    // And no second version was invented for the peer's chain.
    expect(api.chains.get(seeded.fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(engine.fileIdForPath(".obsidian/app.json")).toBeNull();
  });

  it("never lets a local file adopt a peer's settings chain by content", async () => {
    const { adapter, api, key } = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    const engine = engineOver(adapter, api, key, MARKDOWN_ONLY);
    // The same bytes as a local markdown note: a content-hash match must not be
    // enough to hand this device a chain whose path it is not allowed to write.
    const shared = "# identical";
    const seeded = await seedRemoteFile(api, key, ".obsidian/app.json", shared);
    adapter.files.set("note.md", encoder.encode(shared));

    await engine.initialSync();

    expect(engine.fileIdForPath("note.md")).not.toBe(seeded.fileId);
    expect(await decryptString(key, api.paths.get(engine.fileIdForPath("note.md")!)!)).toBe(
      "note.md",
    );
  });

  it("leaves a settings chain this device tracked alone once the scope turns it off", async () => {
    const on = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    on.adapter.files.set(".obsidian/app.json", encoder.encode('{"theme":"moonstone"}'));
    await on.engine.initialSync();
    const fileId = on.engine.fileIdForPath(".obsidian/app.json")!;
    const chainLength = on.api.chains.get(fileId)!.length;

    // The switch goes off (or this device never wanted settings): the same vault,
    // the same server, a markdown-only engine with the persisted state.
    const off = engineOver(on.adapter, on.api, on.key, MARKDOWN_ONLY);
    off.loadState(on.engine.serializeState());
    await off.initialSync();

    // Nothing is deleted, nothing is pulled back, no tombstone, no conflict file.
    expect(new TextDecoder().decode(on.adapter.files.get(".obsidian/app.json"))).toBe(
      '{"theme":"moonstone"}',
    );
    expect(on.api.chains.get(fileId)!.length).toBe(chainLength);
    expect(on.adapter.files.has(conflictFilePath(".obsidian/app.json"))).toBe(false);
  });

  it("drops local events for paths outside the scope", async () => {
    const { engine, adapter, api } = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    adapter.files.set(".hidden/secret.md", encoder.encode("s"));

    await engine.handleLocalChange(".obsidian/app.json");
    await engine.handleLocalChange(".hidden/secret.md");
    await engine.handleLocalRename(".obsidian/app.json", ".obsidian/appearance.json");

    expect(api.pushed).toEqual([]);
    expect(engine.fileIdForPath(".obsidian/app.json")).toBeNull();
  });

  it("ignores a move whose target is outside the scope", async () => {
    // A rename arrives with both paths, and the **destination** decides whether the move
    // is this device's business: a note moved into a hidden folder leaves the synced set,
    // so there is no version to write. The old path's disappearance is a separate event,
    // and one the scope answers on its own terms.
    const { engine, adapter, api } = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;

    adapter.files.delete("note.md");
    adapter.files.set(".trash/note.md", encoder.encode("body"));
    const before = api.pushCalls.length;
    await engine.handleLocalRename("note.md", ".trash/note.md");

    expect(api.pushCalls).toHaveLength(before);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("leaves everything inside an excluded folder on this device", async () => {
    const scope = scopeWithExcluded("private");
    const conflicts: ConflictResolvedEvent[] = [];
    const { adapter, api, key } = await makeEngine(undefined, undefined, scope);
    const engine = engineOver(adapter, api, key, scope, (event) => conflicts.push(event));
    adapter.files.set("public.md", encoder.encode("public"));
    adapter.files.set("private/local.md", encoder.encode("local"));
    const seeded = await seedRemoteFile(api, key, "private/peer.md", "peer");

    await engine.initialSync();

    // The local file in the excluded folder never leaves, the peer's file never arrives,
    // and the peer's chain is not touched (no second version, no conflict copy).
    const pushed = await Promise.all(
      api.pushed.map((push) => decryptString(key, push.encryptedPath)),
    );
    expect(pushed).toEqual(["public.md"]);
    expect(adapter.files.has("private/peer.md")).toBe(false);
    expect(adapter.files.has(conflictFilePath("private/peer.md"))).toBe(false);
    expect(conflicts).toEqual([]);
    expect(api.chains.get(seeded.fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(engine.fileIdForPath("private/local.md")).toBeNull();
    expect(engine.fileIdForPath("private/peer.md")).toBeNull();

    // Local events and remote notifications for that folder are dropped before anything
    // is decided, exactly like a settings group that is switched off.
    await engine.handleLocalChange("private/local.md");
    await engine.handleLocalDelete("private/local.md");
    await engine.handleFilePushed(seeded.fileId, seeded.versionId);
    expect(api.pushed).toHaveLength(1);
    expect(adapter.files.has("private/peer.md")).toBe(false);
  });

  it("resumes an excluded folder when the list no longer excludes it", async () => {
    const off = await makeEngine(undefined, undefined, scopeWithExcluded("private"));
    off.adapter.files.set("private/local.md", encoder.encode("local"));
    const seeded = await seedRemoteFile(off.api, off.key, "private/peer.md", "peer");
    await off.engine.initialSync();
    expect(off.api.pushed).toEqual([]);
    expect(off.adapter.files.has("private/peer.md")).toBe(false);

    // The same vault, server and persisted state, with the folder back in scope.
    const on = engineOver(off.adapter, off.api, off.key, MARKDOWN_ONLY);
    on.loadState(off.engine.serializeState());
    await on.initialSync();

    const pushed = await Promise.all(
      off.api.pushed.map((push) => decryptString(off.key, push.encryptedPath)),
    );
    expect(pushed).toEqual(["private/local.md"]);
    expect(new TextDecoder().decode(off.adapter.files.get("private/peer.md"))).toBe("peer");
    expect(off.api.chains.get(seeded.fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("records a tracked file moved into an excluded folder without pushing a tombstone", async () => {
    const scope = scopeWithExcluded("private");
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, scope);
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;
    const chainLength = api.chains.get(fileId)!.length;

    // What Obsidian reports as a rename: the file left a synced path for an excluded one.
    adapter.files.delete("note.md");
    adapter.files.set("private/note.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "private/note.md");

    // No version is written — in particular no tombstone — but the chain still knows
    // where this device's copy lives. A pass while excluded is silent too.
    expect(api.chains.get(fileId)!.length).toBe(chainLength);
    expect(engine.fileIdForPath("note.md")).toBeNull();
    expect(engine.fileIdForPath("private/note.md")).toBe(fileId);
    await engine.initialSync();
    expect(api.chains.get(fileId)!.length).toBe(chainLength);

    // Back in scope: the recorded path disagrees with the remote head's path, which is
    // exactly the reconcile branch that pushes a rename on the same chain.
    const back = engineOver(adapter, api, key, MARKDOWN_ONLY);
    back.loadState(engine.serializeState());
    await back.initialSync();

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect(await decryptString(key, api.chains.get(fileId)!.at(-1)!.encryptedPath)).toBe(
      "private/note.md",
    );
  });

  it("resumes a tracked file moved back into scope as a rename on the same chain", async () => {
    const scope = scopeWithExcluded("private");
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, scope);
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    // Out of scope: recorded, not pushed.
    adapter.files.delete("note.md");
    adapter.files.set("private/note.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "private/note.md");
    expect(engine.fileIdForPath("private/note.md")).toBe(fileId);

    // Back in scope through a rename event: the same chain gets the move as a `rename`
    // version, instead of the old path's vacancy becoming a tombstone.
    adapter.files.delete("private/note.md");
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.handleLocalRename("private/note.md", "note.md");

    expect(engine.fileIdForPath("note.md")).toBe(fileId);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect(await decryptString(key, api.chains.get(fileId)!.at(-1)!.encryptedPath)).toBe("note.md");
  });

  it("never hands an excluded chain to a local file by content", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("private/note.md", encoder.encode("shared"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("private/note.md")!;

    // The same bytes now sit at a syncable path while the chain's recorded path is
    // excluded. `repairMovedFile` must not read that as a move: the excluded file is
    // still on disk, and the copy is somebody else's new file.
    first.adapter.files.set("copy.md", encoder.encode("shared"));
    const second = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    second.loadState(first.engine.serializeState());
    await second.initialSync();

    expect(second.fileIdForPath("copy.md")).not.toBe(fileId);
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  /**
   * A move into an excluded folder that no host reported as a rename.
   *
   * This is the shape an external tool or a plugin that was not running produces: the
   * old path simply disappears and the new one is dropped by the scope before the engine
   * sees it. The chain must follow the file into the excluded folder — a tombstone here
   * would delete, on every peer, a note the user still owns.
   */
  it("recognises a file moved into an excluded folder without a rename event", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    // The pass that starts after the move sees only the old path's absence.
    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync({ firstBind: true });

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("note.md")).toBeNull();
    expect(restarted.fileIdForPath("private/note.md")).toBe(fileId);

    // A second pass stays silent, and the excluded folder's file is not read as a
    // deletion of the chain either.
    await restarted.initialSync();
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("recognises the same move when it arrives as a bare delete event", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    // `fs.watch`/an external tool: the "created" half is filtered out by the scope and
    // only the removal reaches the engine.
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    await restarted.handleLocalDelete("note.md");

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/note.md")).toBe(fileId);
  });

  /**
   * An **empty** note is the corner case of the hash match: its content hash is the
   * hash a `delete` version carries, so the move detection cannot use "not the empty
   * hash" to tell a real file from a tombstone — it has to trust the path index and the
   * candidate's bytes like any other file.
   */
  it("recognises an empty note moved into an excluded folder", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("blank.md", encoder.encode(""));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("blank.md")!;

    first.adapter.files.delete("blank.md");
    first.adapter.files.set("private/blank.md", encoder.encode(""));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/blank.md")).toBe(fileId);
  });

  /**
   * The re-check in the pass's delete branch: a rename that lands between "the listing
   * says the path is gone" and "the tombstone is sent" has already recorded the move,
   * so the pass must not overwrite that with a deletion decided from its snapshot.
   */
  it("does not publish a deletion for a path an event moved during the pass", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    first.adapter.files.delete("note.md");
    first.adapter.excludedFolders = ["private"];

    // The pass has already repaired all it can; the move lands while it is confirming
    // the deletion, which is exactly the window the state re-check exists for.
    let moved = false;
    const statFile = first.adapter.statFile.bind(first.adapter);
    first.adapter.statFile = async (path) => {
      const stamp = await statFile(path);
      if (!moved && path === "note.md") {
        moved = true;
        first.adapter.files.set("private/note.md", encoder.encode("body"));
        // The rename's job queues behind this pass's job; waiting here would wait for
        // the pass that is waiting for this hook.
        void restarted.handleLocalRename("note.md", "private/note.md");
      }
      return stamp;
    };
    await restarted.initialSync();
    await restarted.whenIdle();
    first.adapter.statFile = statFile;

    expect(moved).toBe(true);
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/note.md")).toBe(fileId);
  });

  it("keeps a deletion when the excluded folder holds only a different file with that name", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("the note"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    // A same-named copy under the excluded folder is not the moved file: the content
    // hash is what decides, so the real deletion still reaches the peers. The two
    // strings are the same length on purpose — that leaves the hash, not the size
    // prefilter, as the only thing standing between the copy and the chain.
    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("a copy!!"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("leaves an ambiguous match alone: two excluded copies are not a move", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/one/note.md", encoder.encode("body"));
    first.adapter.files.set("private/two/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    // Two candidates with the same name and bytes cannot say which one the chain became,
    // so the deletion stands rather than handing the chain to an arbitrary copy.
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(restarted.fileIdForPath("private/one/note.md")).toBeNull();
    expect(restarted.fileIdForPath("private/two/note.md")).toBeNull();
  });

  it("does not take a same-content file under another name as the moved one", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    // The name is the cheap first filter: a file with the same bytes but another name
    // under the excluded folder is somebody else's copy, not this chain's move.
    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/other.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(restarted.fileIdForPath("private/other.md")).toBeNull();
  });

  it("recognises the move when the state records no stamp for the file", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;
    // An older persisted state has the sync point but no size/mtime pair: the size
    // prefilter has to be skipped, not crash, and the bytes still decide.
    const state = JSON.parse(first.engine.serializeState()) as Record<string, { stamp?: unknown }>;
    delete state[fileId]!.stamp;

    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(JSON.stringify(state));
    await restarted.initialSync();

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/note.md")).toBe(fileId);
  });

  it("does not take a file another chain already owns as the moved one", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const deletedId = first.engine.fileIdForPath("note.md")!;
    const claimedId = first.engine.fileIdForPath("private/note.md")!;
    expect(deletedId).not.toBe(claimedId);

    // The note really was deleted; the only same-name, same-content file left is a
    // chain that already owns its path. Reading that as a move would put two chains
    // on one path, so the deletion stands.
    first.adapter.files.delete("note.md");
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    expect(first.api.chains.get(deletedId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(first.api.chains.get(claimedId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/note.md")).toBe(claimedId);
  });

  it("falls back to a deletion when the host cannot list the excluded files", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    first.adapter.listExcludedFiles = undefined as never;
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    // `listExcludedFiles` is optional: a host that cannot answer keeps the old
    // behaviour, where such a move is indistinguishable from a deletion.
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("walks the excluded folders once for a burst of deletions", async () => {
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("a.md", encoder.encode("aaa"));
    adapter.files.set("b.md", encoder.encode("bbb"));
    await engine.initialSync();
    const aId = engine.fileIdForPath("a.md")!;
    const bId = engine.fileIdForPath("b.md")!;

    let lists = 0;
    const list = adapter.listExcludedFiles.bind(adapter);
    adapter.listExcludedFiles = async () => {
      lists += 1;
      return await list();
    };
    adapter.excludedFolders = ["private"];
    adapter.files.delete("a.md");
    adapter.files.set("private/a.md", encoder.encode("aaa"));
    adapter.files.delete("b.md");
    adapter.files.set("private/b.md", encoder.encode("bbb"));

    // A remove of a whole folder arrives as a burst: one listing serves all of it.
    await engine.handleLocalDelete("a.md");
    await engine.handleLocalDelete("b.md");

    expect(lists).toBe(1);
    expect(api.chains.get(aId)!.map((v) => v.action)).toEqual(["create"]);
    expect(api.chains.get(bId)!.map((v) => v.action)).toEqual(["create"]);
    expect(engine.fileIdForPath("private/a.md")).toBe(aId);
    expect(engine.fileIdForPath("private/b.md")).toBe(bId);
  });

  it("does not hand the chain to a new file created at the vacated path", async () => {
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.delete("note.md");
    adapter.files.set("private/note.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "private/note.md");

    // The old path no longer belongs to this chain: a fresh note there is its own
    // chain, and the move must not leave a path job behind that hides it from the
    // next pass either.
    adapter.files.set("note.md", encoder.encode("something else"));
    await engine.initialSync();

    const newId = engine.fileIdForPath("note.md");
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(fileId);
    expect(engine.fileIdForPath("private/note.md")).toBe(fileId);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("persists the path a rename out of scope recorded", async () => {
    const saved: string[] = [];
    const { engine, adapter } = await makeEngine(
      (json) => saved.push(json),
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("renamed.md", encoder.encode("renamed"));
    await engine.initialSync();
    const renamedId = engine.fileIdForPath("renamed.md")!;

    saved.length = 0;
    adapter.excludedFolders = ["private"];
    adapter.files.delete("renamed.md");
    adapter.files.set("private/renamed.md", encoder.encode("renamed"));
    await engine.handleLocalRename("renamed.md", "private/renamed.md");

    // The recorded path is what a restart needs to keep one chain (and what turns the
    // move back into a `rename` when the folder returns to scope), so it has to reach
    // the persisted state, not only the in-memory one.
    const persisted = JSON.parse(saved.at(-1)!) as Record<string, { plainPath?: string }>;
    expect(persisted[renamedId]?.plainPath).toBe("private/renamed.md");
  });

  it("persists the path a delete event was recognised as a move for", async () => {
    const saved: string[] = [];
    const { engine, adapter } = await makeEngine(
      (json) => saved.push(json),
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("deleted.md", encoder.encode("deleted"));
    await engine.initialSync();
    const deletedId = engine.fileIdForPath("deleted.md")!;

    saved.length = 0;
    adapter.excludedFolders = ["private"];
    adapter.files.delete("deleted.md");
    adapter.files.set("private/deleted.md", encoder.encode("deleted"));
    await engine.handleLocalDelete("deleted.md");

    const persisted = JSON.parse(saved.at(-1)!) as Record<string, { plainPath?: string }>;
    expect(persisted[deletedId]?.plainPath).toBe("private/deleted.md");
  });

  it("records a move between two excluded folders without pushing", async () => {
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      scopeWithExcluded("private", "archive"),
    );
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.delete("note.md");
    adapter.files.set("private/note.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "private/note.md");
    adapter.files.delete("private/note.md");
    adapter.files.set("archive/note.md", encoder.encode("body"));
    await engine.handleLocalRename("private/note.md", "archive/note.md");

    // Both paths are outside the scope, so the chain follows the file silently and the
    // server keeps its old version.
    expect(engine.fileIdForPath("archive/note.md")).toBe(fileId);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("pushes a normal rename while another folder is excluded", async () => {
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.delete("note.md");
    adapter.files.set("renamed.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "renamed.md");

    // The excluded folder must not change what a move between two synced paths does.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect(engine.fileIdForPath("renamed.md")).toBe(fileId);
  });

  it("restores a deleted file into an excluded folder — an explicit action, not a scope leak", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("private/note.md")!;
    const contentHash = first.api.chains.get(fileId)![0]!.contentHash;
    first.adapter.files.delete("private/note.md");
    await first.engine.handleLocalDelete("private/note.md");
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);

    // The device now excludes the folder. The recycle bin still lists what the server
    // holds, and 恢复 is the person asking for that version back: it is written locally
    // and pushed as a live version again, while the folder stays excluded here.
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.restoreFile(fileId, "private/note.md", contentHash);

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(new TextDecoder().decode(first.adapter.files.get("private/note.md"))).toBe("body");
    // The folder is still out of scope on this device: the next pass leaves the file
    // alone, it is not synced from here on.
    await restarted.initialSync();
    expect(first.api.chains.get(fileId)!).toHaveLength(3);
  });

  it("pushes local settings changes that no vault event ever reports", async () => {
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    adapter.files.set("note.md", encoder.encode("# note"));
    adapter.files.set(".obsidian/app.json", encoder.encode('{"theme":"moonstone"}'));
    await engine.initialSync();
    const fileId = engine.fileIdForPath(".obsidian/app.json")!;

    // Obsidian's config folder is not in the vault index, so editing a settings
    // file on disk fires no event at all — the poll is the only thing that sees it.
    adapter.files.set(".obsidian/app.json", encoder.encode('{"theme":"obsidian"}'));
    adapter.files.set(".obsidian/hotkeys.json", encoder.encode('{"x":[]}'));
    await engine.syncLocalSettings();

    const actions = api.chains.get(fileId)!.map((v) => v.action);
    expect(actions).toEqual(["create", "modify"]);
    const hotkeysId = engine.fileIdForPath(".obsidian/hotkeys.json")!;
    expect(api.chains.get(hotkeysId)!.map((v) => v.action)).toEqual(["create"]);
    // The note was not touched by the settings pass.
    expect(api.chains.get(engine.fileIdForPath("note.md")!)!.map((v) => v.action)).toEqual([
      "create",
    ]);
    expect(await decryptString(key, api.paths.get(hotkeysId)!)).toBe(".obsidian/hotkeys.json");

    // Deleting it while nothing watches is the other half the poll carries.
    adapter.files.delete(".obsidian/app.json");
    await engine.syncLocalSettings();
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "delete"]);
  });

  it("does nothing before the first bind, and nothing when settings are off", async () => {
    const beforeBind = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    beforeBind.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    await beforeBind.engine.syncLocalSettings();
    expect(beforeBind.api.pushed).toEqual([]);

    const off = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    off.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    await off.engine.initialSync();
    await off.engine.syncLocalSettings();
    expect(off.api.pushed).toEqual([]);
  });

  it("does not turn a listing that lags a settings write into a tombstone", async () => {
    const { engine, adapter, api } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath(".obsidian/app.json")!;

    // The vault listing misses a file the adapter can still read: absence from one
    // listing is not evidence of a deletion, exactly as in the full reconcile.
    const listSyncableFiles = adapter.listSyncableFiles.bind(adapter);
    adapter.listSyncableFiles = async () => [];
    await engine.syncLocalSettings();
    adapter.listSyncableFiles = listSyncableFiles;

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(adapter.files.has(".obsidian/app.json")).toBe(true);
  });

  it("keeps every settings path out of a markdown-only listing", async () => {
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    adapter.files.set(".obsidian/plugins/courier/data.json", encoder.encode("{}"));
    adapter.files.set(".obsidian/workspace.json", encoder.encode("{}"));
    adapter.files.set("note.md", encoder.encode("# note"));

    await engine.initialSync();

    expect(api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(await decryptString(key, api.pushed[0]!.encryptedPath)).toBe("note.md");
  });

  it("syncs only the config-folder groups that are switched on", async () => {
    // Appearance on, the app settings off: the two files differ by one switch only.
    const { engine, adapter, api, key } = await makeEngine(
      undefined,
      undefined,
      scopeWith("appearance"),
    );
    adapter.files.set(".obsidian/app.json", encoder.encode('{"attachmentFolderPath":"files"}'));
    adapter.files.set(".obsidian/appearance.json", encoder.encode('{"theme":"moonstone"}'));
    adapter.files.set(".obsidian/graph.json", encoder.encode("{}"));
    adapter.files.set(".obsidian/themes/Minimal/theme.css", encoder.encode("body {}"));

    await engine.initialSync();

    const paths = await Promise.all(api.pushed.map((p) => decryptString(key, p.encryptedPath)));
    expect(paths).toEqual([".obsidian/appearance.json"]);
    expect(engine.fileIdForPath(".obsidian/app.json")).toBeNull();
  });

  it("ignores a peer's chain for a group this device has off, while another group still travels", async () => {
    const { adapter, api, key } = await makeEngine();
    const engine = engineOver(adapter, api, key, scopeWith("appearance"));
    const app = await seedRemoteFile(api, key, ".obsidian/app.json", '{"theme":"moonstone"}');
    const appearance = await seedRemoteFile(
      api,
      key,
      ".obsidian/appearance.json",
      '{"theme":"obsidian"}',
    );

    await engine.initialSync();

    // The enabled group arrives; the disabled one is not even looked at.
    expect(adapter.files.has(".obsidian/appearance.json")).toBe(true);
    expect(adapter.files.has(".obsidian/app.json")).toBe(false);
    expect(engine.fileIdForPath(".obsidian/app.json")).toBeNull();
    expect(api.chains.get(app.fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(api.chains.get(appearance.fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("carries the config folder's non-standard files only when otherFiles is on", async () => {
    const off = await makeEngine(undefined, undefined, scopeWith("app"));
    off.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    off.adapter.files.set(".obsidian/notes.txt", encoder.encode("scratch"));
    off.adapter.files.set(".obsidian/my-tool/state.json", encoder.encode('{"x":1}'));

    await off.engine.initialSync();
    const offPaths = await Promise.all(
      off.api.pushed.map((p) => decryptString(off.key, p.encryptedPath)),
    );
    expect(offPaths).toEqual([".obsidian/app.json"]);

    const on = await makeEngine(undefined, undefined, scopeWith("otherFiles"));
    on.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    on.adapter.files.set(".obsidian/notes.txt", encoder.encode("scratch"));
    on.adapter.files.set(".obsidian/my-tool/state.json", encoder.encode('{"x":1}'));

    await on.engine.initialSync();
    const onPaths = await Promise.all(
      on.api.pushed.map((p) => decryptString(on.key, p.encryptedPath)),
    );
    // `otherFiles` owns the unclaimed paths only — not app.json, whose own group is off.
    expect(sortedCopy(onPaths)).toEqual([".obsidian/my-tool/state.json", ".obsidian/notes.txt"]);
  });

  it("keeps the settings pass inside the switched-on groups", async () => {
    const { engine, adapter, api } = await makeEngine(undefined, undefined, scopeWith("app"));
    adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    await engine.initialSync();

    // A core plugin's settings file appears while nothing watches: it is not this
    // device's group, so the poll must not push it either.
    adapter.files.set(".obsidian/graph.json", encoder.encode("{}"));
    adapter.files.set(".obsidian/app.json", encoder.encode('{"newFileLocation":"folder"}'));
    await engine.syncLocalSettings();

    expect(engine.fileIdForPath(".obsidian/graph.json")).toBeNull();
    expect(
      api.chains.get(engine.fileIdForPath(".obsidian/app.json")!)!.map((v) => v.action),
    ).toEqual(["create", "modify"]);
  });

  /**
   * What a host is told after a peer's settings file landed.
   *
   * This is the one class of file a running Obsidian does not re-read, so the difference
   * between "the file arrived" and "the app applied it" is invisible on disk — the host
   * has to be told, and these cases fix exactly which applications count.
   */
  it("reports a settings file a peer applied, and never a note", async () => {
    const { adapter, api, key } = await makeEngine();
    const applied: SettingsAppliedEvent[] = [];
    const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT, undefined, (event) =>
      applied.push(event),
    );
    await seedRemoteFile(api, key, ".obsidian/core-plugins.json", '{"sync":false}');
    await seedRemoteFile(api, key, "note.md", "# note");

    await engine.initialSync();

    // The group travels with the event: a host decides what to say about a settings change
    // from which switch owns the file, and this is the only place that rule is applied.
    expect(applied).toEqual([
      { plainPath: ".obsidian/core-plugins.json", action: "write", group: "corePlugins" },
    ]);
    expect(adapter.files.has(".obsidian/core-plugins.json")).toBe(true);
  });

  it("reports a settings file a peer deleted, not only the ones it wrote", async () => {
    const { adapter, api, key } = await makeEngine();
    const seeded = await seedRemoteFile(api, key, ".obsidian/graph.json", '{"zoom":1}');
    const applied: SettingsAppliedEvent[] = [];
    const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT, undefined, (event) =>
      applied.push(event),
    );

    await engine.initialSync({ firstBind: true });
    expect(applied).toEqual([
      { plainPath: ".obsidian/graph.json", action: "write", group: "corePluginSettings" },
    ]);

    // The peer removes it: the absence is as much a change to what the app has read.
    await api.remoteDelete(seeded.fileId);
    await engine.initialSync();

    expect(adapter.files.has(".obsidian/graph.json")).toBe(false);
    expect(applied.at(-1)).toEqual({
      plainPath: ".obsidian/graph.json",
      action: "delete",
      group: "corePluginSettings",
    });
  });

  it("says nothing about a settings chain this device does not sync", async () => {
    const { adapter, api, key } = await makeEngine();
    const applied: SettingsAppliedEvent[] = [];
    const engine = engineOver(adapter, api, key, scopeWith("app"), undefined, (event) =>
      applied.push(event),
    );
    await seedRemoteFile(api, key, ".obsidian/core-plugins.json", '{"sync":false}');

    await engine.initialSync();

    // The group is off, so the chain is ignored entirely — there is nothing to apply and
    // nothing the user could be told.
    expect(applied).toEqual([]);
    expect(adapter.files.has(".obsidian/core-plugins.json")).toBe(false);
  });

  /**
   * A config-folder conflict is the one that is not parked.
   *
   * `.obsidian/` is outside Obsidian's file index, so a copy written there is invisible —
   * there is nothing the user could do with it. The engine settles these by **last
   * modification time** instead (the stamp the pushing device recorded on the version),
   * never writes a copy, and never raises `onConflictResolved`; a host is told only when
   * a peer's file was actually applied (`onSettingsApplied`, which the plugin turns into
   * its reload card).
   */
  describe("a config-folder conflict resolves by modification time", () => {
    it("keeps the newer local edit, with no copy and no notice", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const conflicts: ConflictResolvedEvent[] = [];
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT, (event) =>
        conflicts.push(event),
      );
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode('{"theme":"moonstone"}'));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // The peer edits it (and its push reached the server), then this device edits it
      // later — the *newer* edit has to win, not the one that pushed last.
      await api.remoteEdit(fileId, '{"theme":"obsidian"}', 1_000);
      adapter.files.set(path, encoder.encode('{"theme":"moonstone","newFileLocation":"folder"}'));
      adapter.files.touch(path, 2_000);

      await engine.initialSync();

      expect(textOf(adapter, path)).toBe('{"theme":"moonstone","newFileLocation":"folder"}');
      // The local version was pushed over the peer's, carrying the local stamp.
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
      expect(api.chains.get(fileId)!.at(-1)!.mtimeMs).toBe(2_000);
      expect(noConflictCopies(adapter)).toBe(true);
      expect(conflicts).toEqual([]);
    });

    it("takes the newer remote edit, with no copy, and reports it as applied", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const conflicts: ConflictResolvedEvent[] = [];
      const applied: SettingsAppliedEvent[] = [];
      const engine = engineOver(
        adapter,
        api,
        key,
        OBSIDIAN_DEFAULT,
        (event) => conflicts.push(event),
        (event) => applied.push(event),
      );
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode('{"theme":"moonstone"}'));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, '{"theme":"obsidian"}', 2_000);
      adapter.files.set(path, encoder.encode('{"theme":"moonstone","v":2}'));
      adapter.files.touch(path, 1_000);

      await engine.initialSync();

      expect(textOf(adapter, path)).toBe('{"theme":"obsidian"}');
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
      expect(noConflictCopies(adapter)).toBe(true);
      expect(conflicts).toEqual([]);
      // The app has already read the old file: applying a peer's copy is exactly the
      // change the host answers with its reload card.
      expect(applied).toContainEqual({ plainPath: path, action: "write", group: "app" });
    });

    it("resolves an equal modification time to the remote side", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, "remote-v2", 5_000);
      adapter.files.set(path, encoder.encode("local-v2"));
      adapter.files.touch(path, 5_000);

      await engine.initialSync();

      // Both devices apply the same tie rule, so they converge instead of pushing past
      // each other forever.
      expect(textOf(adapter, path)).toBe("remote-v2");
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("brings a config file back as a restore when the local edit is newer than the deletion", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/snippets/wide.css";

      adapter.files.set(path, encoder.encode(".wide {}"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteDelete(fileId, 1_000);
      adapter.files.set(path, encoder.encode(".wide { color: red; }"));
      adapter.files.touch(path, 2_000);

      await engine.initialSync();

      expect(textOf(adapter, path)).toBe(".wide { color: red; }");
      // A live version after a tombstone is a restore on the same chain, not a new one.
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete", "restore"]);
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("applies a deletion that is newer than the local copy", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const conflicts: ConflictResolvedEvent[] = [];
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT, (event) =>
        conflicts.push(event),
      );
      const path = ".obsidian/snippets/wide.css";

      adapter.files.set(path, encoder.encode(".wide {}"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteDelete(fileId, 2_000);
      adapter.files.set(path, encoder.encode(".wide { color: red; }"));
      adapter.files.touch(path, 1_000);

      await engine.initialSync();

      expect(adapter.files.has(path)).toBe(false);
      expect(noConflictCopies(adapter)).toBe(true);
      expect(conflicts).toEqual([]);
    });

    it("brings the file back when this device deleted it and a peer edited it", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // Deleted here (the push never landed), while the peer edited the file. A local
      // deletion carries no timestamp to argue with, so the remote side is applied —
      // and there is no local content to keep either way.
      adapter.files.delete(path);
      await api.remoteEdit(fileId, "peer-v2", 2_000);

      await engine.initialSync();

      expect(textOf(adapter, path)).toBe("peer-v2");
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("re-decides from the fresh chain when a peer pushes mid-conflict", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, "peer-older", 1_000);
      adapter.files.set(path, encoder.encode("local-newer"));
      adapter.files.touch(path, 2_000);
      // A second peer push lands between this device's decision and its push, so the
      // first conditional push is refused.
      api.onPush = async (files) => {
        api.onPush = null;
        for (const f of files) await api.remoteEdit(f.fileId, "peer-rushed", 1_500);
      };

      await engine.initialSync();

      // The local side is still newer than the chain the server showed, so it is pushed
      // again on top of it rather than parked or lost.
      expect(textOf(adapter, path)).toBe("local-newer");
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual([
        "create",
        "modify",
        "modify",
        "modify",
      ]);
      expect(api.chains.get(fileId)!.at(-1)!.mtimeMs).toBe(2_000);
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("treats a second refusal as contention rather than a failed conflict", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // A peer version this device's later edit beats on time, so the local side is the
      // one that tries to push — through the notification path, which reports what the
      // engine could not apply.
      await api.remoteEdit(fileId, "peer-older", 1_000);
      const peerVersion = (await api.latestVersionId(fileId))!;
      adapter.files.set(path, encoder.encode("local-newer"));
      adapter.files.touch(path, Date.now());
      // Every push here is refused: a peer lands a version between the decision and the
      // request, twice in a row.
      api.onPush = async () => {
        await api.remoteEdit(fileId, "peer-rushed", 1_500);
      };

      // Nothing was written and nothing was lost, so this is a race the engine lost, not
      // a conflict it failed to settle: the notification must not report a failure, and
      // the next pass decides again from the newer chain.
      await expect(engine.handleFilePushed(fileId, peerVersion)).resolves.toBeUndefined();
      expect(textOf(adapter, path)).toBe("local-newer");
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("stamps a retried tombstone with the moment the deletion was decided", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/snippets/wide.css";

      adapter.files.set(path, encoder.encode(".wide {}"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // Deleted while the connection is down, so the tombstone cannot be pushed.
      const deletedAt = Date.now();
      api.offline = true;
      adapter.files.delete(path);
      await expect(engine.handleLocalDelete(path)).rejects.toThrow("network down");

      // The retry happens a minute later. Without the recorded moment the tombstone would
      // claim *this* time, which is newer than an edit a peer made in the gap — and a
      // config-folder conflict is settled by exactly that comparison.
      vi.setSystemTime(new Date(deletedAt + 60_000));
      api.offline = false;
      await engine.initialSync();

      const tombstone = api.chains.get(fileId)!.at(-1)!;
      expect(tombstone.action).toBe("delete");
      expect(tombstone.mtimeMs).toBe(deletedAt);
    });

    it("settles a local win through a notification instead of reporting a failure", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // The peer's version is older on the time axis, so this device's copy is the one
      // that gets pushed — through the notification path, which is the caller that turns
      // "could not apply" into a reported failure.
      await api.remoteEdit(fileId, "peer-older", 1_000);
      const peerVersion = (await api.latestVersionId(fileId))!;
      adapter.files.set(path, encoder.encode("local-newer"));
      adapter.files.touch(path, 2_000);

      await expect(engine.handleFilePushed(fileId, peerVersion)).resolves.toBeUndefined();
      expect(textOf(adapter, path)).toBe("local-newer");
      // The local version became the head: the win is recorded on the chain, not only
      // in the state.
      expect(api.chains.get(fileId)!.at(-1)!.mtimeMs).toBe(2_000);
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("reports a conflict it could not push for a reason other than a refusal", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, "peer-older", 1_000);
      const peerVersion = (await api.latestVersionId(fileId))!;
      adapter.files.set(path, encoder.encode("local-newer"));
      adapter.files.touch(path, 2_000);

      // The local side wins on time, but the request itself cannot be made. That is not
      // a settled conflict, and the notification is the only thing that would say so.
      api.onPush = async () => {
        throw new Error("socket hang up");
      };
      await expect(engine.handleFilePushed(fileId, peerVersion)).rejects.toThrow(
        /Could not apply the conflict/,
      );

      // Nothing was written, so the local copy is untouched and no copy was parked.
      expect(textOf(adapter, path)).toBe("local-newer");
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("skips a local copy that grew past the size cap instead of pushing it", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const tooLarge: FileTooLargeEvent[] = [];
      // A cap the local file outgrows *after* the pass that listed it: the notification
      // path reads the file before any reconcile could filter it, which is the one door
      // the engine's "skip before reading" rule has to watch itself.
      const scope: SyncScope = { ...OBSIDIAN_DEFAULT, maxFileBytes: 8 };
      const engine = new SyncEngine({
        platform: realPlatform,
        vaultId: "vault-1",
        adapter,
        api,
        encryptionKey: key,
        syncScope: scope,
        onFileTooLarge: (event) => tooLarge.push(event),
      });
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("small"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, "peer", 1_000);
      const peerVersion = (await api.latestVersionId(fileId))!;
      adapter.files.set(path, encoder.encode("x".repeat(64)));
      adapter.files.touch(path, 2_000);

      await expect(engine.handleFilePushed(fileId, peerVersion)).resolves.toBeUndefined();

      // Reported once, nothing pushed, nothing parked: the same answer an over-cap file
      // gets from a pass.
      expect(tooLarge).toEqual([{ plainPath: path, sizeBytes: 64 }]);
      expect(api.chains.get(fileId)!.at(-1)!.contentHash).not.toBe(
        await sha256Hex(encoder.encode("x".repeat(64))),
      );
      expect(textOf(adapter, path)).toBe("x".repeat(64));
      expect(noConflictCopies(adapter)).toBe(true);
    });
  });
});

describe("SyncEngine — vault file types and the size cap", () => {
  /** A small PNG-shaped payload: bytes that are not valid UTF-8 on purpose. */
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0xff, 0xfe, 0x80, 0x7f,
  ]);

  it("carries a binary file byte for byte", async () => {
    const source = await makeEngine(undefined, undefined, fileTypesWith("images"));
    source.adapter.files.set("photos/raw.png", PNG);

    await source.engine.initialSync();
    expect(source.api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(source.api.pushed[0]!.sizeBytes).toBe(PNG.byteLength);

    // A second device with the same switch pulls exactly those bytes.
    const target = await makeEngine(undefined, undefined, fileTypesWith("images"));
    target.api.chains = source.api.chains;
    target.api.blobs = source.api.blobs;
    target.api.paths = source.api.paths;

    await target.engine.initialSync();
    expect(Array.from(target.adapter.files.get("photos/raw.png")!)).toEqual(Array.from(PNG));
    expect(target.adapter.files.get("photos/raw.png")).not.toBe(PNG);
  });

  it("pushes markdown and canvas even with every file type switched off", async () => {
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, fileTypesWith());
    adapter.files.set("note.md", encoder.encode("# note"));
    adapter.files.set("board.canvas", encoder.encode("{}"));
    adapter.files.set("photo.png", PNG);
    adapter.files.set("archive.zip", encoder.encode("zip"));

    await engine.initialSync();

    const paths = await Promise.all(api.pushed.map((p) => decryptString(key, p.encryptedPath)));
    expect(sortedCopy(paths)).toEqual(["board.canvas", "note.md"]);
  });

  it("ignores a peer's file type this device has off, and syncs it once it is on", async () => {
    const { adapter, api, key } = await makeEngine();
    const photosOff = fileTypesEngine(adapter, api, key, fileTypesWith("pdf"));

    const bytes = PNG;
    const contentHash = await sha256Hex(bytes);
    const encryptedPath = await encryptString(key, "photos/raw.png");
    api.paths.set("f-photo", encryptedPath);
    api.blobs.set(contentHash, await encryptCombinedBytes(key, bytes as Uint8Array<ArrayBuffer>));
    api.chains.set("f-photo", [
      {
        versionId: "v-photo",
        contentHash,
        encryptedPath,
        action: "create",
        sizeBytes: bytes.byteLength,
        mtimeMs: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    await photosOff.initialSync();
    expect(adapter.files.has("photos/raw.png")).toBe(false);
    expect(photosOff.fileIdForPath("photos/raw.png")).toBeNull();

    // Turning the type on resumes where it stopped: the chain is still there.
    const photosOn = fileTypesEngine(adapter, api, key, fileTypesWith("images"));
    await photosOn.initialSync();
    expect(Array.from(adapter.files.get("photos/raw.png")!)).toEqual(Array.from(PNG));
  });

  it("never reads a local file over the cap, and reports it instead", async () => {
    const reported: FileTooLargeEvent[] = [];
    const scope = normalizeScope({ fileTypes: { images: true }, maxFileBytes: 4 });
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, scope, (event) =>
      reported.push(event),
    );
    adapter.files.set("small.md", encoder.encode("ok"));
    adapter.files.set("photos/big.png", PNG);

    await engine.initialSync();

    const paths = await Promise.all(api.pushed.map((p) => decryptString(key, p.encryptedPath)));
    expect(paths).toEqual(["small.md"]);
    // The point of the cap: the oversized file was never loaded to be hashed.
    expect(adapter.reads).not.toContain("photos/big.png");
    expect(reported).toEqual([{ plainPath: "photos/big.png", sizeBytes: PNG.byteLength }]);
    expect(engine.fileIdForPath("photos/big.png")).toBeNull();
  });

  it("takes a peer's version that is over the cap, because the cap bounds uploads", async () => {
    // A file a peer already uploaded is part of the vault: refusing it here made it
    // silently absent from a new device, which is indistinguishable from data loss.
    // The cap still keeps this device from **sending** such a file (the case above).
    const scope = normalizeScope({ fileTypes: { images: true }, maxFileBytes: 16 });
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, scope);
    const bytes = PNG;
    const contentHash = await sha256Hex(bytes);
    const encryptedPath = await encryptString(key, "photos/raw.png");
    api.paths.set("f-photo", encryptedPath);
    api.blobs.set(contentHash, await encryptCombinedBytes(key, bytes as Uint8Array<ArrayBuffer>));
    api.chains.set("f-photo", [
      {
        versionId: "v-photo",
        contentHash,
        encryptedPath,
        action: "create",
        // Larger than this device's cap, whatever the content actually is.
        sizeBytes: PNG.byteLength,
        mtimeMs: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    await engine.initialSync();
    expect(Array.from(adapter.files.get("photos/raw.png")!)).toEqual(Array.from(PNG));
    expect(engine.fileIdForPath("photos/raw.png")).toBe("f-photo");
  });

  /**
   * The case the first-bind tests miss: this device already holds the file, and the
   * administrator then lowers the cap below it. The cap refuses what this device
   * **sends**; a peer's newer version must still land, or the file is silently stale
   * forever — the exact failure the upload-only rule exists to remove.
   */
  it("applies a peer's newer version over an over-cap local copy that has not changed", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("0123456789abcdefghij"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    // A device that may only upload eight-byte files, holding the twenty-byte copy it
    // synced under a higher cap.
    const lowered = engineOver(adapter, api, key, { ...scopeWith(), maxFileBytes: 8 });
    lowered.loadState(engine.serializeState());
    await lowered.initialSync();
    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("0123456789abcdefghij");

    await api.remoteEdit(fileId, "peer-v2");
    await lowered.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("peer-v2");
  });

  /**
   * The other half of the same rule: an over-cap local copy that **changed** is an edit
   * this device can never send (the cap refuses it), and it must not be replaced
   * silently. The pass leaves it alone and the scan reports it.
   */
  it("leaves an over-cap local edit alone when a peer also pushed", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("0123456789abcdefghij"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    const lowered = engineOver(adapter, api, key, { ...scopeWith(), maxFileBytes: 8 });
    lowered.loadState(engine.serializeState());
    await lowered.initialSync();

    const localEdit = "a local edit that this device cannot upload";
    adapter.files.set("note.md", encoder.encode(localEdit));
    adapter.files.touch("note.md", Date.now() + 60_000);
    await api.remoteEdit(fileId, "peer-v2");

    await lowered.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe(localEdit);
  });

  it("never applies a tombstone over an over-cap local copy", async () => {
    // Deleting a file this pass could not read would destroy content it never saw, and a
    // conflict copy cannot be parked without those bytes.
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("0123456789abcdefghij"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    const lowered = engineOver(adapter, api, key, { ...scopeWith(), maxFileBytes: 8 });
    lowered.loadState(engine.serializeState());
    await lowered.initialSync();

    await api.remoteDelete(fileId);
    await lowered.initialSync();

    expect(adapter.files.has("note.md")).toBe(true);
  });

  it("parks a binary conflict beside the original, extension and bytes intact", async () => {
    const conflicts: ConflictResolvedEvent[] = [];
    const scope = fileTypesWith("images");
    const { engine, adapter, api } = await makeEngine(
      undefined,
      (event) => conflicts.push(event),
      scope,
    );
    adapter.files.set("photos/raw.png", PNG);
    await engine.initialSync();

    const fileId = engine.fileIdForPath("photos/raw.png")!;
    // The peer moves ahead while this device edits the same image: the remote wins, and
    // the local bytes are parked beside the original — under an extension Obsidian can
    // still open, not as a `.conflict.md` full of PNG.
    await api.remoteEditWithSize(fileId, "peer-version", PNG.byteLength);
    const local = new Uint8Array([...PNG, 0x01]);
    adapter.files.set("photos/raw.png", local);
    await engine.handleLocalChange("photos/raw.png");

    const parked = conflictFilePath("photos/raw.png");
    expect(parked.endsWith(".conflict.png")).toBe(true);
    expect(conflicts.map((event) => event.conflictPath)).toEqual([parked]);
    expect(Array.from(adapter.files.get(parked)!)).toEqual(Array.from(local));
    expect(new TextDecoder().decode(adapter.files.get("photos/raw.png"))).toBe("peer-version");
  });
});

describe("SyncEngine — what a large file costs", () => {
  /**
   * A payload big enough to be worth not sending twice, small enough to keep the test
   * fast. Its bytes matter: they are compared after a move.
   */
  const LARGE = new Uint8Array(64 * 1024).map((_, index) => (index * 31) % 251);

  /**
   * A file that has not changed since its sync point is not read again.
   *
   * Every pass used to read and hash every syncable file in the vault, which for a
   * vault of attachments means re-reading gigabytes every five minutes (and on every
   * reconnect) to discover that nothing had happened. The state records the size and
   * modification time the hash was taken at, and a pass that finds them unchanged
   * reuses the hash.
   */
  it("does not read a file whose stamp has not moved, and still reads one that has", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();

    adapter.reads.length = 0;
    await engine.initialSync();
    // Nothing changed: the pass reused the recorded hash instead of reading the file.
    expect(adapter.reads).not.toContain("note.md");

    // An edit made while nothing was watching moves the stamp, so the pass reads it
    // and pushes the new content.
    adapter.files.set("note.md", encoder.encode("v2"));
    adapter.reads.length = 0;
    await engine.initialSync();
    expect(adapter.reads).toContain("note.md");
    const fileId = engine.fileIdForPath("note.md")!;
    expect(await api.readPlainLatest(fileId)).toBe("v2");
  });

  it("reads an edited file once, and pushes the bytes it read", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.set("note.md", encoder.encode("v2"));
    adapter.reads.length = 0;
    await engine.handleLocalChange("note.md");

    // The event handler's read is the one the decision and the push use. It used to
    // read the file a second time after fetching the chain, and hash it twice more.
    expect(adapter.reads).toEqual(["note.md"]);
    expect(await api.readPlainLatest(fileId)).toBe("v2");
  });

  it("re-reads an edit that lands while the chain is being fetched", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.set("note.md", encoder.encode("v2"));
    api.onPull = async () => {
      adapter.files.set("note.md", encoder.encode("v3"));
    };
    adapter.reads.length = 0;
    try {
      await engine.handleLocalChange("note.md");
    } finally {
      api.onPull = null;
    }

    // The bytes read before the fetch were stale by the time the decision ran; the
    // stamp check sends it back to disk, so the version carries what is actually there
    // instead of silently pushing the superseded content.
    expect(adapter.reads).toEqual(["note.md", "note.md"]);
    expect(await api.readPlainLatest(fileId)).toBe("v3");
  });

  it("moves a file without reading it when its stamp still matches the sync point", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((push) => push.action === "create")!;
    const fileId = engine.fileIdForPath("big.mp4")!;

    // A real rename keeps the modification time. The fake's `set` stamps a new one, so
    // the move states the old stamp explicitly.
    const mtime = adapter.files.mtimes.get("big.mp4")!;
    adapter.files.set("moved/big.mp4", LARGE);
    adapter.files.touch("moved/big.mp4", mtime);
    adapter.files.delete("big.mp4");
    adapter.reads.length = 0;

    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    const rename = api.pushed.at(-1)!;
    expect(rename.action).toBe("rename");
    expect(rename.content).toBeNull();
    expect(rename.sizeBytes).toBe(LARGE.byteLength);
    // The move names the create's content, not a re-encoding of it.
    expect(rename.contentHash).toBe(created.contentHash);
    // A move's cost used to be a full read and hash of the file, only to learn there
    // was nothing to send.
    expect(adapter.reads).toEqual([]);
    // The stamp is part of the sync point, or the next pass pays that read again.
    const state = JSON.parse(engine.serializeState()) as Record<string, { stamp?: unknown }>;
    expect(state[fileId]?.stamp).toBeDefined();
    adapter.reads.length = 0;
    await engine.initialSync();
    expect(adapter.reads).toEqual([]);
  });

  it("does not overwrite an edit that lands between the prefetch and a pull decision", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;
    const mtime = adapter.files.mtimes.get("note.md")!;

    // A peer moves the chain, so the decision for an unchanged local file is `pull`.
    await api.remoteEdit(fileId, "RR");

    // `applyLocalChange` reads "v1" (the sync point), then this edit lands during the
    // chain fetch — same size, same mtime, so the stamp check cannot see it.
    api.onPull = async () => {
      adapter.files.set("note.md", encoder.encode("v2"));
      adapter.files.touch("note.md", mtime);
    };
    try {
      await engine.handleLocalChange("note.md");
    } finally {
      api.onPull = null;
    }

    // The pull path re-reads before acting: the bytes are now "v2", so this is a
    // conflict — the remote wins and the local edit is parked, not overwritten.
    const conflict = [...adapter.files.keys()].find((name) => name.includes(".conflict"));
    expect(conflict).toBeDefined();
    expect(new TextDecoder().decode(adapter.files.get(conflict!))).toBe("v2");
    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("RR");
  });

  it("reads a moved file whose stamp moved with it, and sends the new content", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();

    // Edited and renamed with no event in between: the stamp no longer proves the
    // sync point's hash, so the move falls back to reading — and pushes the bytes that
    // are actually there rather than reusing the old content.
    const edited = LARGE.slice();
    edited[0] = (edited[0]! + 1) % 256;
    adapter.files.delete("big.mp4");
    adapter.files.set("moved/big.mp4", edited);
    adapter.reads.length = 0;

    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    expect(adapter.reads).toEqual(["moved/big.mp4"]);
    expect(api.pushed.at(-1)!.content).not.toBeNull();
  });

  it("sends the content for a stamp-proved move when the store lost the blob", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    api.blobs.delete(created.contentHash);

    const mtime = adapter.files.mtimes.get("big.mp4")!;
    adapter.files.set("moved/big.mp4", LARGE);
    adapter.files.touch("moved/big.mp4", mtime);
    adapter.files.delete("big.mp4");
    adapter.reads.length = 0;

    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    // The move sent no content, the server refused it (`content_missing`), and only
    // then did the engine read the file: the retry is the one place a stamp-proved move
    // pays for bytes.
    expect(adapter.reads).toEqual(["moved/big.mp4"]);
    expect(api.pushed.at(-1)!.content).not.toBeNull();
  });

  it("re-uploads a chunked move in chunks when the store lost the blob", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).fill(5);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    // The chain still points at the content, but the blob is gone.
    api.blobs.delete(created.contentHash);
    api.uploadCalls.length = 0;

    const mtime = adapter.files.mtimes.get("big.mp4")!;
    adapter.files.set("moved/big.mp4", bytes);
    adapter.files.touch("moved/big.mp4", mtime);
    adapter.files.delete("big.mp4");
    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    // A whole payload above the threshold would be rejected by the wire and unreadable
    // to a chunk-capable peer, so the retry stages chunks again.
    expect(api.uploadCalls.map((call) => call.index)).toEqual([0, 1, 2]);
    const rename = api.pushed.at(-1)!;
    expect(rename.action).toBe("rename");
    expect(rename.content).toBeNull();
    expect(rename.contentChunks).toBe(3);

    // …and a peer reads it back.
    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    const pulled = peerAdapter.files.get("moved/big.mp4")!;
    expect(pulled.byteLength).toBe(bytes.byteLength);
    // A byte loop rather than Buffer/Array.from: the engine package declares no runtime types.
    let mismatch = -1;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (pulled[index] !== bytes[index]) {
        mismatch = index;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  }, 20_000);

  it("refuses to rebind a content hash when the file changed before the retry", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    api.blobs.delete(created.contentHash);

    // Same size, same mtime (so the stamp still matches), different bytes: exactly the
    // window the stamp cannot see.
    const edited = LARGE.slice();
    edited[0] = (edited[0]! + 1) % 256;
    const mtime = adapter.files.mtimes.get("big.mp4")!;
    adapter.files.set("moved/big.mp4", edited);
    adapter.files.touch("moved/big.mp4", mtime);
    adapter.files.delete("big.mp4");

    await expect(engine.handleLocalRename("big.mp4", "moved/big.mp4")).rejects.toThrow(
      /Version content not found/,
    );
    // The old hash was not rebound to bytes that are not its content.
    expect(api.blobs.has(created.contentHash)).toBe(false);
  });

  it("records the stamp with the hash, so a restart keeps the benefit", async () => {
    let saved: string | null = null;
    const { engine, adapter, api, key } = await makeEngine((json) => {
      saved = json;
    });
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    expect(saved).not.toBeNull();

    // A second engine over the same persisted state and the same filesystem — what
    // reopening Obsidian does.
    const restarted = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    restarted.loadState(saved!);
    adapter.reads.length = 0;
    await restarted.initialSync({ firstBind: true });
    expect(adapter.reads).not.toContain("note.md");
  });

  it("pushes a rename without its content, and records the size a peer applies its cap to", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    expect(created.content).not.toBeNull();

    adapter.files.delete("big.mp4");
    adapter.files.set("moved/big.mp4", LARGE);
    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    const rename = api.pushed.at(-1)!;
    expect(rename.action).toBe("rename");
    // The bytes are the ones the chain's head already holds, so none are sent...
    expect(rename.content).toBeNull();
    // ...but the version still reports the real plaintext size, so a peer that never
    // had the file still applies its own size cap before pulling.
    expect(rename.sizeBytes).toBe(LARGE.byteLength);
    expect(api.blobs.size).toBe(1);
  });

  it("sends the content after all when the store no longer holds it", async () => {
    // The safety net behind the shortcut: the server refuses a content-less version
    // whose bytes it does not have (`content_missing`), and the engine answers by
    // sending the payload instead of leaving a chain nobody can fetch.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    api.blobs.delete(created.contentHash);

    adapter.files.delete("big.mp4");
    adapter.files.set("moved/big.mp4", LARGE);
    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    const rename = api.pushed.at(-1)!;
    expect(rename.action).toBe("rename");
    expect(rename.content).not.toBeNull();
    expect(api.blobs.get(rename.contentHash)).toBeDefined();
  });

  it("follows a peer's rename without downloading the content it already has", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer moves the file: a new version, same content hash, new path.
    const versionId = await api.remoteRename(created.fileId, await encryptString(key, "new.mp4"));
    api.contentFetches.length = 0;
    await engine.handleFilePushed(created.fileId, versionId);

    expect(api.contentFetches).toEqual([]);
    expect(adapter.files.has("old.mp4")).toBe(false);
    expect(Array.from(adapter.files.get("new.mp4")!)).toEqual(Array.from(LARGE));
  });

  it("still downloads for a device that never had the file", async () => {
    // The shortcut is "this device already holds those bytes", never "everyone does":
    // a fresh client must fetch the content its chain points at.
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    const versionId = await api.remoteRename(created.fileId, await encryptString(key, "new.mp4"));

    // A device that has never synced this vault, learning about the file from the
    // chain alone.
    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    api.contentFetches.length = 0;
    await peer.handleFilePushed(created.fileId, versionId);

    expect(api.contentFetches).toHaveLength(1);
    expect(Array.from(peerAdapter.files.get("new.mp4")!)).toEqual(Array.from(LARGE));
  });

  it("creates a bind's files in batches instead of one request each", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }
    await engine.initialSync();

    // 250 files, at most 100 per request: three pushes, not 250.
    expect(api.pushCalls).toEqual([100, 100, 50]);
    expect(api.chains.size).toBe(250);
    expect([...api.chains.values()].every((chain) => chain.length === 1)).toBe(true);
  });

  it("sends a file too large for a batch on its own", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("small.md", encoder.encode("# small"));
    // Over the 8 MiB batch bound: it never shares a request with another file, so a
    // bind holds one large payload at a time rather than a vault's worth of them.
    adapter.files.set("big.mp4", new Uint8Array(9 * 1024 * 1024).fill(7));
    await engine.initialSync();

    expect(api.pushCalls).toEqual([1, 1]);
    expect(api.chains.size).toBe(2);
    // Over the chunking threshold too, so it travelled through the chunk endpoints and
    // its push carried no payload at all.
    expect(api.uploadCalls.length).toBeGreaterThan(0);
    const chunked = api.pushed.find((p) => p.contentChunks === 3)!;
    expect(chunked.content).toBeNull();
  });

  it("moves a large file in chunks, and a peer fetches it in ranges", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).map((_, index) => (index * 31) % 251);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();

    const count = Math.ceil(bytes.byteLength / CHUNK_PLAINTEXT_BYTES);
    expect(api.uploadCalls.map((call) => call.index)).toEqual([0, 1, 2]);
    const push = api.pushed.at(-1)!;
    expect(push.content).toBeNull();
    expect(push.contentChunks).toBe(count);
    // The fake store assembled the chunks like the server: concatenated ciphertexts,
    // 28 bytes of IV and tag each.
    expect(api.blobs.get(push.contentHash)!.byteLength).toBe(bytes.byteLength + count * 28);

    // A peer fetches the version one range at a time and reassembles it.
    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    api.rangeFetches.length = 0;
    await peer.initialSync();

    expect(api.rangeFetches).toHaveLength(count);
    const pulled = peerAdapter.files.get("big.mp4")!;
    expect(pulled.byteLength).toBe(bytes.byteLength);
    let mismatch = -1;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (pulled[index] !== bytes[index]) {
        mismatch = index;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  }, 20_000);

  it("streams a large peer download through the adapter's sink", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).map((_, index) => (index * 37) % 251);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();

    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    const count = Math.ceil(bytes.byteLength / CHUNK_PLAINTEXT_BYTES);
    api.rangeFetches.length = 0;
    await peer.initialSync();

    // One sink, one chunk per ranged request, and no whole-file write at all: this is
    // the memory bound the streaming path exists for.
    expect(peerAdapter.streamed).toHaveLength(1);
    expect(peerAdapter.streamed[0]).toMatchObject({ path: "big.mp4", chunks: count });
    expect(peerAdapter.wholeWrites).toEqual([]);
    expect(peerAdapter.aborted).toEqual([]);
    expect(api.rangeFetches).toHaveLength(count);

    const pulled = peerAdapter.files.get("big.mp4")!;
    expect(pulled.byteLength).toBe(bytes.byteLength);
    expectSameBytes(pulled, bytes);
  }, 20_000);

  it("falls back to a whole write when the streaming sink fails", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).fill(2);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();

    const peerAdapter = new StreamingFakeAdapter();
    peerAdapter.failBeginWrite = true;
    const peer = engineOver(peerAdapter, api, key);
    await expect(peer.initialSync()).resolves.toBeUndefined();

    // The sink is an optional capability; a host whose implementation is broken must
    // still receive the file through the old whole-buffer path rather than fail forever.
    expect(peerAdapter.streamed).toEqual([]);
    expect(peerAdapter.wholeWrites).toEqual(["big.mp4"]);
    expectSameBytes(peerAdapter.files.get("big.mp4")!, bytes);
  }, 20_000);

  it("keeps a streamed pull's own event from becoming a local edit", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(3));
    await engine.initialSync();
    const fileId = api.pushed.at(-1)!.fileId;
    const versionId = api.chains.get(fileId)!.at(-1)!.versionId;

    // A bound peer, so the re-entering event handler does not start a bind of its own.
    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    await peer.initialSync();
    // The bind's decision may stat/read a path that is absent; only the event after the
    // stream matters here, so start counting from the notification.
    peerAdapter.reads.length = 0;
    // The host feeds the write's vault event straight back, exactly as Obsidian does.
    peerAdapter.onWrite = async (path) => {
      await peer.handleLocalChange(path);
    };
    const pushCallsBefore = api.pushCalls.length;

    await peer.handleFilePushed(fileId, versionId);
    await peerAdapter.settleEvents();

    // The self-event record covers the whole stream (the hash was known before `close`),
    // so the event is recognised instead of pushing the pulled bytes back as an edit.
    expect(api.pushCalls.length).toBe(pushCallsBefore);
    // …and, equally important, the event did not read the file back: the stamp recorded
    // at the commit is what answers it. A read here would allocate the whole attachment
    // on the plugin right after the streamed write.
    expect(peerAdapter.reads.filter((path) => path === "big.mp4")).toEqual([]);
    expect(peerAdapter.aborted).toEqual([]);
    expect(await peer.fileIdForPath("big.mp4")).not.toBeNull();
  }, 20_000);

  it("still reads a genuine edit inside the streamed write's window", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(6));
    await engine.initialSync();
    const fileId = api.pushed.at(-1)!.fileId;
    const versionId = api.chains.get(fileId)!.at(-1)!.versionId;

    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    await peer.initialSync();
    peerAdapter.onWrite = async (path) => {
      await peer.handleLocalChange(path);
    };
    await peer.handleFilePushed(fileId, versionId);
    await peerAdapter.settleEvents();

    const edited = new Uint8Array(8 * 1024 * 1024 + 1024).fill(8);
    peerAdapter.files.set("big.mp4", edited);
    const pushCallsBefore = api.pushCalls.length;
    await peer.handleLocalChange("big.mp4");

    // The stamp moved, so the fast path cannot answer; the edit is read, hashed and
    // pushed like any other.
    expect(peerAdapter.reads.filter((path) => path === "big.mp4").length).toBeGreaterThan(0);
    expect(api.pushCalls.length).toBeGreaterThan(pushCallsBefore);
  }, 20_000);

  it("aborts a streamed pull that cannot decrypt, and retries it whole later", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).fill(4);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();
    const head = api.chains.get(api.pushed.at(-1)!.fileId)!.at(-1)!;

    // A stored blob whose second chunk no longer decrypts: the temporary file must be
    // discarded, not renamed over a target.
    const stored = api.blobs.get(head.contentHash)!;
    const damaged = stored.slice();
    damaged[CHUNK_PLAINTEXT_BYTES + 28 + 5] ^= 0xff;
    api.blobs.set(head.contentHash, damaged);

    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    await expect(peer.initialSync()).resolves.toBeUndefined();

    expect(peerAdapter.streamed).toHaveLength(1);
    expect(peerAdapter.aborted).toEqual(["big.mp4"]);
    expect(peerAdapter.files.has("big.mp4")).toBe(false);

    // The pass is the retry: with the stored bytes intact again the file lands and the
    // earlier abort left nothing behind.
    api.blobs.set(head.contentHash, stored);
    peerAdapter.aborted.length = 0;
    await peer.initialSync();
    expect(peerAdapter.aborted).toEqual([]);
    expectSameBytes(peerAdapter.files.get("big.mp4")!, bytes);
  }, 20_000);

  it("refuses a chunk-valid blob whose plaintext hashes to a different content hash", async () => {
    const { api, key } = await makeEngine();
    const size = 8 * 1024 * 1024 + 1024;
    const plaintext = new Uint8Array(size).fill(9);
    const claimedHash = "a".repeat(64);
    const count = Math.ceil(size / CHUNK_PLAINTEXT_BYTES);

    // Every chunk decrypts under the claimed hash and its position, but the concatenated
    // plaintext does not hash to that value. Per-chunk AEAD cannot see this; the
    // streaming whole-file hash must.
    const parts: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const start = index * CHUNK_PLAINTEXT_BYTES;
      const end = Math.min(start + CHUNK_PLAINTEXT_BYTES, size);
      parts.push(
        await encryptChunkBytes(
          key,
          plaintext.subarray(start, end) as Uint8Array<ArrayBuffer>,
          chunkAdditionalData(claimedHash, index, count, size),
        ),
      );
    }
    const blob = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      blob.set(part, offset);
      offset += part.byteLength;
    }
    api.blobs.set(claimedHash, blob);
    const fileId = "forged-file";
    const encryptedPath = await encryptString(key, "forged.mp4");
    api.paths.set(fileId, encryptedPath);
    api.chains.set(fileId, [
      {
        versionId: "forged-version",
        contentHash: claimedHash,
        encryptedPath,
        action: "create",
        sizeBytes: size,
        mtimeMs: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    await expect(peer.initialSync()).resolves.toBeUndefined();

    expect(peerAdapter.streamed).toHaveLength(1);
    expect(peerAdapter.aborted).toEqual(["forged.mp4"]);
    expect(peerAdapter.files.has("forged.mp4")).toBe(false);
  }, 20_000);

  it("reports a chunked create the server refused, and tracks nothing", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(5));
    // The server answers every chunk with `received: 0`, so nothing is ever staged and
    // the push that names the upload is refused with `chunk_missing` — what a truncated
    // upload looks like from the client's side.
    api.uploadChunk = async () => ({ received: 0 });

    await expect(engine.initialSync()).rejects.toThrow(/Push failed for big\.mp4: chunk_missing/);
    // The failed create is not left half-tracked: the next pass must retry it through
    // the chunk endpoints, not as a one-file plain push of a payload the wire rejects.
    expect(engine.fileIdForPath("big.mp4")).toBeNull();
    expect(engine.serializeState()).not.toContain("big.mp4");
  }, 20_000);

  it("does not leave a chunked create behind when the upload itself fails", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(5));
    api.uploadChunk = async () => {
      throw new Error("chunk upload failed");
    };

    await expect(engine.initialSync()).rejects.toThrow("chunk upload failed");
    // Same rule on the throwing path: the pending create goes with the failed upload, so
    // the retry starts from the batched/chunked decision instead of a stale state entry.
    expect(engine.fileIdForPath("big.mp4")).toBeNull();
    expect(engine.serializeState()).not.toContain("big.mp4");
  }, 20_000);

  it("abandons the pending batch when the adapter fails mid-bind", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("first"));
    adapter.files.set("b.md", encoder.encode("second"));
    const readFile = adapter.readFile.bind(adapter);
    adapter.readFile = async (path: string) => {
      if (path === "b.md") throw new Error("disk error");
      return await readFile(path);
    };

    await expect(engine.initialSync()).rejects.toThrow("disk error");

    // A file the pass had already prepared for the batch must not stay "tracked, no
    // version": that entry makes the next pass push it on its own, one request at a
    // time, and it is invisible in the history. The throw is the adapter's, not the
    // server's, so the file itself is fine and must be retried normally.
    adapter.readFile = readFile;
    expect(engine.fileIdForPath("a.md")).toBeNull();
    expect(engine.fileIdForPath("b.md")).toBeNull();

    await engine.initialSync();
    const paths = await Promise.all(api.pushed.map((p) => decryptString(api.key, p.encryptedPath)));
    expect(sortedCopy(paths)).toEqual(["a.md", "b.md"]);
  }, 20_000);

  it("resumes a chunked upload from the prefix the server already holds", async () => {
    const { engine, adapter, api } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).fill(9);
    const size = bytes.byteLength;
    const count = Math.ceil(size / CHUNK_PLAINTEXT_BYTES);
    const hash = await sha256Hex(bytes);

    // A previous attempt staged chunk 0 and then the connection dropped.
    await api.uploadChunk(
      "vault-1",
      hash,
      0,
      count,
      size,
      new Uint8Array(CHUNK_PLAINTEXT_BYTES + 28),
    );
    api.uploadCalls.length = 0;

    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();

    // The retry asks for the resumed prefix and uploads only what is missing.
    expect(api.uploadCalls.map((call) => call.index)).toEqual([1, 2]);
  });
});

/** A refusal shaped like the server's 429, with a wait short enough for a test. */
function rateLimited(retryAfterMs = 1): Error {
  return Object.assign(new Error("Rate limit exceeded. Please try again in 1 seconds."), {
    status: 429,
    code: "RATE_LIMITED",
    retryAfterMs,
  });
}

describe("SyncEngine — a first bind that meets the server's limits", () => {
  it("waits out a rate limit and sends the same batch again", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    const realPush = api.push.bind(api);
    let refusals = 0;
    api.push = async (vaultId, files) => {
      if (refusals === 0) {
        refusals += 1;
        throw rateLimited();
      }
      return await realPush(vaultId, files);
    };

    await engine.initialSync();

    // The refused batch was re-sent after the wait, so every file landed and the pass
    // did not have to be retried by the host.
    expect(refusals).toBe(1);
    expect(api.pushCalls).toEqual([100, 100, 50]);
    expect(api.chains.size).toBe(250);
  });

  it("sends the batches after one the server refused, and keeps their files untracked", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    const realPush = api.push.bind(api);
    let attempts = 0;
    api.push = async (vaultId, files) => {
      // The first batch is refused for a reason a wait cannot fix (a quota, say).
      if (attempts++ === 0) throw new Error("quota exceeded");
      return await realPush(vaultId, files);
    };

    await expect(engine.initialSync()).rejects.toThrow("quota exceeded");

    // The pass kept going: the two batches after the refused one still went out.
    expect(api.pushCalls).toEqual([100, 50]);
    expect(api.chains.size).toBe(150);
    // And the refused batch's 100 files are *untracked*: no phantom state entry makes
    // the next pass push them one request at a time.
    expect(Object.keys(JSON.parse(engine.serializeState()))).toHaveLength(150);

    // The next pass retries them through the batched create path: one request for 100
    // files, not 100 requests.
    api.push = realPush;
    api.pushCalls.length = 0;
    await engine.initialSync();
    expect(api.pushCalls).toEqual([100]);
    expect(api.chains.size).toBe(250);
  });

  it("reads each file once when the remote holds nothing", async () => {
    const { engine, adapter } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    await engine.initialSync();

    // The scan hashes what a chain or a state entry claims; a file with neither is only
    // ever a `create`, so it is read once — by the create — instead of twice.
    expect(adapter.reads).toHaveLength(250);
    expect(new Set(adapter.reads).size).toBe(250);
  });

  it("prepares the next batch while the previous request is still in flight", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    const realPush = api.push.bind(api);
    const realRead = adapter.readFile.bind(adapter);
    let reads = 0;
    let readsWhenFirstPushResolved = 0;
    let announceSecondBatch!: () => void;
    const secondBatchRead = new Promise<void>((resolve) => {
      announceSecondBatch = resolve;
    });
    adapter.readFile = async (path) => {
      const bytes = await realRead(path);
      reads += 1;
      // The second batch's 100 files are done reading at read 200 (the first batch's 100
      // plus this one's).
      if (reads === 200) announceSecondBatch();
      return bytes;
    };
    api.push = async (vaultId, files) => {
      if (api.pushCalls.length === 0) {
        // Hold the first request until the second batch has been read (or give up after a
        // moment, which is what a serial bind does — and then this test fails on the count).
        await Promise.race([
          secondBatchRead,
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
        readsWhenFirstPushResolved = reads;
      }
      return await realPush(vaultId, files);
    };

    try {
      await engine.initialSync();
    } finally {
      adapter.readFile = realRead;
      api.push = realPush;
    }

    // The second batch was ready before the first answer arrived: preparation and the
    // request overlap instead of taking turns.
    expect(readsWhenFirstPushResolved).toBeGreaterThanOrEqual(200);
    expect(api.chains.size).toBe(250);
  });

  it("reports a bind's progress, and ends it at done === total", async () => {
    const progress: SyncProgress[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => progress.push(event),
    );
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    await engine.initialSync();

    // Coarse steps, not one callback per file: 250 files report far fewer than 250 times.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThan(250);
    // The last report is the pass's own "finished": a status surface can stop there.
    expect(progress.at(-1)).toEqual({ done: 250, total: 250 });
    // …and the counter never moves backwards while `total` only grows.
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]!.done).toBeGreaterThanOrEqual(progress[index - 1]!.done);
      expect(progress[index]!.total).toBeGreaterThanOrEqual(progress[index - 1]!.total);
    }
  });

  it("reports the total of a download up front, because every chain is known", async () => {
    const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
    sourceAdapter.files.set("a.md", encoder.encode("# a"));
    sourceAdapter.files.set("b.md", encoder.encode("# b"));
    await source.initialSync();

    const progress: SyncProgress[] = [];
    const download = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: new FakeAdapter(),
      api,
      encryptionKey: key,
      onProgress: (event) => progress.push(event),
    });
    await download.initialSync();

    // The first report already knows the size of the job: a download's chains all come
    // from the index, unlike a bind's creates, which are discovered as the scan walks.
    expect(progress[0]).toEqual({ done: 0, total: 2 });
    expect(progress.at(-1)).toEqual({ done: 2, total: 2 });
  });

  it("never reads a file twice on a second pass", async () => {
    const { engine, adapter } = await makeEngine();
    for (let i = 0; i < 50; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }
    await engine.initialSync();
    adapter.reads.length = 0;

    await engine.initialSync();

    // Every file's stamp was recorded with its hash, so a pass that finds the same bytes
    // reads none of them.
    expect(adapter.reads).toEqual([]);
  });

  it("reports a wait instead of going silent when the limiter refuses a batch", async () => {
    const waits: number[] = [];
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => waits.push(event.waitMs),
    );
    for (let i = 0; i < 150; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    const realPush = api.push.bind(api);
    let refusals = 0;
    api.push = async (vaultId, files) => {
      if (refusals++ === 0) throw rateLimited(120);
      return await realPush(vaultId, files);
    };
    try {
      await engine.initialSync();
    } finally {
      api.push = realPush;
    }

    // One report per wait, carrying the server's own delay — a host can log "waiting 1s"
    // instead of leaving a minute of silence that looks like a hang.
    expect(waits).toEqual([120]);
    expect(api.chains.size).toBe(150);
  });

  it("stops the pass when a rate limit outlasts its waits, and leaves the rest untracked", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    // The limiter never lets the first batch through: after the bounded waits the pass
    // gives up instead of spinning, and records nothing for the batch it could not send.
    const realPush = api.push.bind(api);
    let attempts = 0;
    api.push = async () => {
      attempts += 1;
      throw rateLimited();
    };
    await expect(engine.initialSync()).rejects.toMatchObject({ status: 429 });
    expect(attempts).toBe(MAX_RATE_LIMIT_WAITS + 1);
    expect(JSON.parse(engine.serializeState())).toEqual({});

    // The next pass, once the window is over, creates everything in batches — the files
    // were never recorded as tracked, so nothing is retried one request at a time.
    api.push = realPush;
    api.pushCalls.length = 0;
    await engine.initialSync();
    expect(api.pushCalls).toEqual([100, 100, 50]);
    expect(api.chains.size).toBe(250);
  });

  it("reports a refused content download instead of treating the blob as gone", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("# from the peer"));
    await engine.initialSync();

    // A fresh device pulls the same chain, but its content request is refused.
    const downloadAdapter = new FakeAdapter();
    const download = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: downloadAdapter,
      api,
      encryptionKey: key,
    });
    const realContent = api.getVersionContent.bind(api);
    api.getVersionContent = async () => {
      throw rateLimited(1);
    };
    try {
      // A 429 is a request that did not happen, not a missing blob: the pass fails so
      // the host retries it, instead of reporting success with the file still absent.
      await expect(download.initialSync()).rejects.toThrow(/rate limit/i);
      expect(downloadAdapter.files.has("note.md")).toBe(false);
    } finally {
      api.getVersionContent = realContent;
    }

    // The next pass, with the limiter window over, applies it.
    await download.initialSync();
    expect(new TextDecoder().decode(downloadAdapter.files.get("note.md"))).toBe("# from the peer");
  });

  it("waits out a rate-limited content read and still applies the file", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("# from the peer"));
    await engine.initialSync();

    const downloadAdapter = new FakeAdapter();
    const download = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: downloadAdapter,
      api,
      encryptionKey: key,
    });
    const realContent = api.getVersionContent.bind(api);
    let attempts = 0;
    api.getVersionContent = async (vaultId, contentHash) => {
      attempts += 1;
      if (attempts === 1) throw rateLimited();
      return await realContent(vaultId, contentHash);
    };
    try {
      // The window is waited out (the server said how long), so the first download of a
      // large vault does not fail on a bound it can simply wait for.
      await expect(download.initialSync()).resolves.toBeUndefined();
    } finally {
      api.getVersionContent = realContent;
    }

    expect(attempts).toBe(2);
    expect(new TextDecoder().decode(downloadAdapter.files.get("note.md"))).toBe("# from the peer");
  });

  it("still treats a blob the store does not hold as nothing to apply", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("# from the peer"));
    await engine.initialSync();

    const downloadAdapter = new FakeAdapter();
    const download = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: downloadAdapter,
      api,
      encryptionKey: key,
    });
    api.getVersionContent = async () => {
      throw Object.assign(new Error("Version content not found"), { status: 404 });
    };

    // A 404 is the store saying it holds nothing: no file is written and the pass does
    // not fail — the next pass decides again.
    await expect(download.initialSync()).resolves.toBeUndefined();
    expect(downloadAdapter.files.has("note.md")).toBe(false);
  });
});

describe("SyncEngine — a path the API cannot carry", () => {
  /**
   * The API bounds `encryptedPath` (base64 of `iv ‖ ciphertext ‖ tag`), and it refuses
   * an over-long one for the **whole batch** — so one deep path used to poison up to
   * 100 files that travelled with it, on every pass, with a 422 no client could
   * explain. The file is skipped instead (and reported), and the rest of the bind
   * happens.
   */
  const longPath = `${"d".repeat(400)}.md`;

  it("skips the over-long file, reports it, and still syncs the rest", async () => {
    const skipped: FileSkippedEvent[] = [];
    const { engine, adapter, api, key } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => skipped.push(event),
    );
    adapter.files.set(longPath, encoder.encode("# deep"));
    adapter.files.set("notes/shallow.md", encoder.encode("# shallow"));

    await engine.initialSync();

    expect(skipped).toEqual([{ plainPath: longPath, reason: "path-too-long" }]);
    // The shallow note is unaffected: one request, and only its chain exists.
    expect(api.pushCalls).toEqual([1]);
    const paths = await Promise.all(
      api.pushed.map((push) => decryptString(key, push.encryptedPath)),
    );
    expect(paths).toEqual(["notes/shallow.md"]);
    // Nothing was left looking tracked with no version.
    expect(engine.fileIdForPath(longPath)).toBeNull();
  });

  it("reports the skip once per pass, not once per file read", async () => {
    const skipped: FileSkippedEvent[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => skipped.push(event),
    );
    adapter.files.set(longPath, encoder.encode("# deep"));

    await engine.initialSync();
    await engine.initialSync();

    expect(skipped).toHaveLength(2);
    expect(skipped.map((event) => event.plainPath)).toEqual([longPath, longPath]);
  });
});

describe("SyncEngine — the order a pass works in", () => {
  /**
   * A cold start decides the same files either way; the order is what a user feels.
   * These cases pin the two signals the order is built from — the host's paths and the
   * local modification stamps — and the one subtlety: a chain whose path moved on one
   * side is ranked by **whichever** of the two paths the user has.
   */

  it("pulls the note the host named first", async () => {
    const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
    for (const [path, text] of [
      ["a.md", "a v1"],
      ["b.md", "b v1"],
      ["c.md", "c v1"],
    ]) {
      sourceAdapter.files.set(path, encoder.encode(text));
    }
    await source.initialSync();

    const targetAdapter = new FakeAdapter();
    const target = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: targetAdapter,
      api,
      encryptionKey: key,
      // Serialise the pass: this case is about the **order** the work is taken in,
      // and a concurrent pool may let two files reach the network together.
      opLimits: { maxConcurrent: 1, exclusiveBytes: 1_024 },
    });
    await target.initialSync();

    // Every file changes on the peer, so all three need a pull.
    for (const path of ["a.md", "b.md", "c.md"]) {
      await api.remoteEdit(target.fileIdForPath(path)!, `${path} v2`);
    }
    api.contentFetches.length = 0;

    await target.initialSync({ priorityPaths: ["b.md"] });

    expect(api.contentFetches).toHaveLength(3);
    expect(api.contentFetches[0]).toBe(await sha256Hex(encoder.encode("b.md v2")));
  });

  it("ranks a file by the local path when the peer moved its chain", async () => {
    const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
    sourceAdapter.files.set("old.md", encoder.encode("old v1"));
    sourceAdapter.files.set("z.md", encoder.encode("z v1"));
    await source.initialSync();

    const targetAdapter = new FakeAdapter();
    const target = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: targetAdapter,
      api,
      encryptionKey: key,
      // Same reason as the case above: this asserts the order, not the concurrency.
      opLimits: { maxConcurrent: 1, exclusiveBytes: 1_024 },
    });
    await target.initialSync();

    // The peer edits the note and moves it. The chain now records `new.md`, while the
    // local file — and the path the user has open — is still `old.md`.
    const movedFileId = target.fileIdForPath("old.md")!;
    await api.remoteEdit(movedFileId, "old v2");
    await api.remoteRename(movedFileId, await encryptString(key, "new.md"));
    await api.remoteEdit(target.fileIdForPath("z.md")!, "z v2");
    api.contentFetches.length = 0;

    await target.initialSync({ priorityPaths: ["old.md"] });

    expect(api.contentFetches).toHaveLength(2);
    expect(api.contentFetches[0]).toBe(await sha256Hex(encoder.encode("old v2")));
    expect(new TextDecoder().decode(targetAdapter.files.get("new.md"))).toBe("old v2");
  });

  it("orders the files nobody listed by the local modification time, newest first", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("old"));
    adapter.files.set("new.md", encoder.encode("new"));
    adapter.files.set("mid.md", encoder.encode("mid"));
    adapter.files.touch("old.md", 1_000);
    adapter.files.touch("new.md", 3_000);
    adapter.files.touch("mid.md", 2_000);

    await engine.initialSync();

    const pushedPaths = await Promise.all(
      api.pushed.map((push) => decryptString(key, push.encryptedPath)),
    );
    expect(pushedPaths).toEqual(["new.md", "mid.md", "old.md"]);
  });

  it("pushes a local file the host named before the other creates", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    adapter.files.set("c.md", encoder.encode("c"));

    await engine.initialSync({ priorityPaths: ["b.md"] });

    const pushedPaths = await Promise.all(
      api.pushed.map((push) => decryptString(key, push.encryptedPath)),
    );
    expect(pushedPaths).toEqual(["b.md", "c.md", "a.md"]);
  });
});

describe("SyncEngine — how much a pass runs at once", () => {
  /**
   * A bound, not a speed: the pass must not open one connection (and hold one file's
   * plaintext and ciphertext) per pending change on a phone. The pool's own edge cases
   * are pinned in `work-pool.test.ts`; what these cases prove is that the engine
   * actually sizes its per-file work with it, and that the size rule sees the bytes.
   */
  async function prepareChanges(
    count: number,
    opLimits: { maxConcurrent: number; exclusiveBytes: number },
    padding = "",
  ) {
    const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
    for (let index = 0; index < count; index++) {
      sourceAdapter.files.set(`n-${index}.md`, encoder.encode(`${padding}n-${index} v1`));
    }
    await source.initialSync();

    const targetAdapter = new FakeAdapter();
    const target = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: targetAdapter,
      api,
      encryptionKey: key,
      opLimits,
    });
    // The bind gives the target a sync point (and a local copy) for every file.
    await target.initialSync();
    for (let index = 0; index < count; index++) {
      await api.remoteEdit(target.fileIdForPath(`n-${index}.md`)!, `${padding}n-${index} v2`);
    }

    api.contentFetches.length = 0;
    api.maxInFlightContent = 0;
    api.contentDelayMs = 10;
    return { target, api };
  }

  it("pulls small files concurrently, up to the pool's limit", async () => {
    const { target, api } = await prepareChanges(9, {
      maxConcurrent: 3,
      exclusiveBytes: 1_024,
    });

    await target.initialSync();

    expect(api.contentFetches).toHaveLength(9);
    expect(api.maxInFlightContent).toBeGreaterThan(1);
    expect(api.maxInFlightContent).toBeLessThanOrEqual(3);
  });

  it("runs a file at or above exclusiveBytes alone", async () => {
    const { target, api } = await prepareChanges(
      4,
      { maxConcurrent: 3, exclusiveBytes: 8 },
      "0123456789abcdef",
    );

    await target.initialSync();

    expect(api.contentFetches).toHaveLength(4);
    // Every file is over the exclusive bound, so no two content reads may overlap.
    expect(api.maxInFlightContent).toBe(1);
  });

  it("weighs a local file by its own size, not only the size the head records", async () => {
    // A local edit can make the file much larger than the version the server holds. The
    // pass has to read those bytes to push them, so the local stamp's size is what
    // decides whether the file runs alone.
    const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
    sourceAdapter.files.set("a.md", encoder.encode("a"));
    sourceAdapter.files.set("b.md", encoder.encode("b"));
    await source.initialSync();

    const targetAdapter = new FakeAdapter();
    const target = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: targetAdapter,
      api,
      encryptionKey: key,
      opLimits: { maxConcurrent: 2, exclusiveBytes: 64 },
    });
    await target.initialSync();

    targetAdapter.files.set("a.md", encoder.encode("a2"));
    targetAdapter.files.set("b.md", encoder.encode("b".repeat(200)));
    api.pushCalls.length = 0;
    api.maxInFlightPush = 0;
    api.pushDelayMs = 10;

    await target.initialSync();

    expect(api.pushCalls).toHaveLength(2);
    // `b.md` is at or above the exclusive bound locally, so it never shares the pool.
    expect(api.maxInFlightPush).toBe(1);
  });

  it("keeps the other files going when one per-file operation throws", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a v1"));
    adapter.files.set("b.md", encoder.encode("b v1"));
    await engine.initialSync();
    const aFileId = engine.fileIdForPath("a.md")!;
    const bFileId = engine.fileIdForPath("b.md")!;

    adapter.files.set("a.md", encoder.encode("a v2"));
    adapter.files.set("b.md", encoder.encode("b v2"));

    // The pass's own listing hashes each file once; the per-file push reads it again.
    // Fail that second read for A only, so the throw happens inside one pool task.
    let readsOfA = 0;
    const originalRead = adapter.readFile.bind(adapter);
    adapter.readFile = async (path) => {
      if (path === "a.md" && ++readsOfA > 1) throw new Error("EACCES: a.md");
      return await originalRead(path);
    };

    await expect(engine.initialSync()).rejects.toThrow("EACCES");

    // B's edit still reached the server; A's did not, and A is retried next pass.
    expect(api.chains.get(bFileId)!).toHaveLength(2);
    expect(api.chains.get(aFileId)!).toHaveLength(1);
  });
});

/**
 * Two chains can name one path for a moment. A peer's move (or delete) is recorded on
 * the server while this device's file is still at the old path, and another device can
 * have created a new chain at that path. The pass is concurrent now, so without a path
 * claim the remote-only chain reads the other chain's file as a divergence and parks a
 * conflict copy of content that never conflicted — the serial pass was what hid this.
 */
describe("SyncEngine — two chains naming one path", () => {
  /**
   * Seed chain X at `old.md` on a source device, bind a target to it, then let a second
   * device change X (move it away or delete it) and create a note at `old.md`. The
   * target still has X's file at the old path when its next pass starts.
   */
  async function prepare(kind: "move" | "delete") {
    const key = await deriveEncryptionKey(
      "password",
      btoa(String.fromCharCode(...new Uint8Array(32))),
    );
    const api = new FakeApi(key);
    const sourceAdapter = new FakeAdapter();
    sourceAdapter.files.set("old.md", encoder.encode("old"));
    const source = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: sourceAdapter,
      api,
      encryptionKey: key,
    });
    await source.initialSync();
    const originalId = source.fileIdForPath("old.md")!;

    const targetAdapter = new FakeAdapter();
    targetAdapter.files.set("old.md", encoder.encode("old"));
    const conflicts: ConflictResolvedEvent[] = [];
    const target = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: targetAdapter,
      api,
      encryptionKey: key,
      // The production concurrency: both tasks are free to start together.
      opLimits: { maxConcurrent: 4, exclusiveBytes: 8 * 1024 * 1024 },
      onConflictResolved: (event) => conflicts.push(event),
    });
    await target.initialSync();

    if (kind === "move") {
      await api.remoteEdit(originalId, "moved");
      await api.remoteRename(originalId, await encryptString(key, "new.md"));
    } else {
      await api.remoteDelete(originalId);
    }

    // A second device puts a new note at the path this device still holds. It is a
    // first bind on that device, so it keeps its own file instead of applying X's
    // deletion — the chain it creates is the one that must land at `old.md`.
    const peerAdapter = new FakeAdapter();
    peerAdapter.files.set("old.md", encoder.encode("new note"));
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync({ firstBind: true });

    return { target, targetAdapter, conflicts };
  }

  it("applies a peer's move before a new chain at the old path decides", async () => {
    const { target, targetAdapter, conflicts } = await prepare("move");

    await target.initialSync();

    expect(textOf(targetAdapter, "new.md")).toBe("moved");
    expect(textOf(targetAdapter, "old.md")).toBe("new note");
    expect(conflictPaths(targetAdapter)).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("applies a peer's delete before a new chain at the vacated path decides", async () => {
    const { target, targetAdapter, conflicts } = await prepare("delete");

    await target.initialSync();

    expect(textOf(targetAdapter, "old.md")).toBe("new note");
    expect(conflictPaths(targetAdapter)).toEqual([]);
    expect(conflicts).toEqual([]);
  });
});

/**
 * The host-facing activity feed.
 *
 * It is not a sync rule: the engine decides exactly the same without a listener. What
 * these cases pin is that the decision is reported **when it is made** — direction,
 * outcome and, for a skip, the switch that fired — so the plugin's history can freeze a
 * row instead of reconstructing it from the server's chains and today's settings.
 */
describe("sync activity", () => {
  it("records a local create as outgoing, with the action it pushed", async () => {
    const events: SyncActivityEvent[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => events.push(event),
    );
    adapter.files.set("notes/a.md", encoder.encode("# A"));

    await engine.initialSync();

    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "out",
        outcome: "applied",
        plainPath: "notes/a.md",
        action: "create",
        versionId: expect.any(String),
      }),
    );
  });

  it("records a pulled remote version as incoming, and a converged pass as nothing", async () => {
    const sender = await makeEngine();
    sender.adapter.files.set("n.md", encoder.encode("v1"));
    await sender.engine.initialSync();

    const events: SyncActivityEvent[] = [];
    const receiverAdapter = new FakeAdapter();
    const receiver = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: receiverAdapter,
      api: sender.api,
      encryptionKey: sender.key,
      onSyncActivity: (event) => events.push(event),
    });
    await receiver.initialSync();

    expect(plain(receiverAdapter.files.get("n.md"))).toBe("v1");
    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "in",
        outcome: "applied",
        plainPath: "n.md",
        action: "create",
      }),
    );

    // A second pass sees the same bytes at the same sync point: nothing was applied, so
    // nothing may be reported (the row would otherwise repeat every reconcile).
    const seen = events.length;
    await receiver.initialSync();
    expect(events.length).toBe(seen);
  });

  it("records a live notification for a path the scope leaves out, naming the switch", async () => {
    // A chain merely discovered by a bind is not activity; a notification that arrives
    // while the device is running is. The receiver is told about the push as if its
    // socket had delivered it.
    const sender = await makeEngine(
      undefined,
      undefined,
      normalizeScope({ configDir: ".obsidian", settingsGroups: { corePlugins: true } }),
    );
    sender.adapter.files.set(".obsidian/core-plugins.json", encoder.encode("{}"));
    await sender.engine.initialSync();
    const fileId = sender.api.pushed[0].fileId;
    const head = await sender.api.latestVersionId(fileId);

    const events: SyncActivityEvent[] = [];
    const receiverAdapter = new FakeAdapter();
    const receiver = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: receiverAdapter,
      api: sender.api,
      encryptionKey: sender.key,
      syncScope: normalizeScope({ configDir: ".obsidian", settingsGroups: NO_SETTINGS_GROUPS }),
      onSyncActivity: (event) => events.push(event),
    });
    await receiver.handleFilePushed(fileId, head!, "Mobile");

    expect(receiverAdapter.files.has(".obsidian/core-plugins.json")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "in",
        outcome: "skipped",
        reason: "settingsGroup",
        plainPath: ".obsidian/core-plugins.json",
        action: "create",
        deviceName: "Mobile",
      }),
    );
  });

  it("records a local file over the size cap as an outgoing skip", async () => {
    const events: SyncActivityEvent[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      normalizeScope({ maxFileBytes: 4 }),
      undefined,
      undefined,
      (event) => events.push(event),
    );
    adapter.files.set("big.md", encoder.encode("12345"));

    await engine.initialSync();

    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "out",
        outcome: "skipped",
        reason: "size",
        plainPath: "big.md",
        action: null,
        sizeBytes: 5,
      }),
    );
  });

  it("records a path the API cannot carry as skipped, before a version exists", async () => {
    const events: SyncActivityEvent[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => events.push(event),
    );
    const path = `${"a".repeat(600)}.md`;
    adapter.files.set(path, encoder.encode("deep"));

    await engine.initialSync();

    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "out",
        outcome: "skipped",
        reason: "pathTooLong",
        plainPath: path,
        versionId: null,
      }),
    );
  });

  it("does not re-report a version this device already applied", async () => {
    // A `file_pushed` that names the head this device already holds is not an incoming
    // change: it adds no row and writes nothing. (A size cap used to be the reason such
    // a notification was skipped; the cap now bounds uploads only, so the rule that
    // matters is "already applied".)
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("hello"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;
    const head = await api.latestVersionId(fileId);
    expect(head).not.toBeNull();

    const events: SyncActivityEvent[] = [];
    const reopened = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
      syncScope: normalizeScope({}),
      onSyncActivity: (event) => events.push(event),
    });
    reopened.loadState(engine.serializeState());
    await reopened.initialSync();
    await reopened.handleFilePushed(fileId, head!);

    expect(events.filter((event) => event.direction === "in")).toEqual([]);
  });

  it("only uses the notified device label when the head is the notified version", async () => {
    const sender = await makeEngine();
    sender.adapter.files.set("n.md", encoder.encode("v1"));
    await sender.engine.initialSync();
    const fileId = sender.api.pushed[0].fileId;
    await sender.api.remoteEdit(fileId, "v2");
    const chain = sender.api.chains.get(fileId)!;
    const older = chain[0]!.versionId;
    const head = chain.at(-1)!.versionId;

    // A notification for a version that is no longer the head cannot name the client
    // whose version this device is about to apply.
    const olderEvents: SyncActivityEvent[] = [];
    const olderReceiver = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: new FakeAdapter(),
      api: sender.api,
      encryptionKey: sender.key,
      onSyncActivity: (event) => olderEvents.push(event),
    });
    await olderReceiver.handleFilePushed(fileId, older, "Mobile");
    expect(olderEvents).toContainEqual(
      expect.objectContaining({
        direction: "in",
        outcome: "applied",
        plainPath: "n.md",
        deviceName: null,
      }),
    );

    // The head's own notification carries the pusher's label.
    const headEvents: SyncActivityEvent[] = [];
    const headReceiver = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: new FakeAdapter(),
      api: sender.api,
      encryptionKey: sender.key,
      onSyncActivity: (event) => headEvents.push(event),
    });
    await headReceiver.handleFilePushed(fileId, head, "Mobile");
    expect(headEvents).toContainEqual(
      expect.objectContaining({
        direction: "in",
        outcome: "applied",
        plainPath: "n.md",
        deviceName: "Mobile",
      }),
    );
  });

  it("keeps a throwing listener from failing the push it reports", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error("the log listener blew up");
      },
    );
    adapter.files.set("n.md", encoder.encode("v1"));

    await expect(engine.initialSync()).resolves.toBeUndefined();
    expect(api.pushed).toHaveLength(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("sync-activity listener failed");
    error.mockRestore();
  });
});

/**
 * The invariants a settled engine must hold, whatever order its jobs ran in.
 *
 * A pass, a notification and an event are separate jobs; the matrix below pairs them at
 * the windows a change can open, and this is what every case asserts afterwards: the
 * state names a path that maps back to its chain, the state's hash is the bytes on disk
 * (or a tombstone with no file), and a conflict copy never holds content the chain
 * already has (that copy would be a conflict with no divergence behind it).
 */
async function expectConsistent(
  engine: SyncEngine,
  adapter: FakeAdapter,
  api: FakeApi,
): Promise<void> {
  const state = JSON.parse(engine.serializeState()) as Record<
    string,
    { lastKnownContentHash: string; plainPath: string }
  >;
  const chainHashes = new Set<string>();
  for (const chain of api.chains.values()) {
    for (const version of chain) chainHashes.add(version.contentHash);
  }
  for (const [fileId, entry] of Object.entries(state)) {
    const bytes = adapter.files.get(entry.plainPath);
    // The chain action tells a tombstone from a live empty file (both have the empty
    // content hash); without it the check would reject a correct empty file.
    if (api.chains.get(fileId)?.at(-1)?.action === "delete") {
      expect(bytes, `a tombstone at ${entry.plainPath} has no file`).toBeUndefined();
      continue;
    }
    expect(engine.fileIdForPath(entry.plainPath), `${entry.plainPath} maps back`).toBe(fileId);
    expect(bytes, `the state names ${entry.plainPath} and the file is there`).toBeDefined();
    expect(await sha256Hex(bytes!), `state and disk agree at ${entry.plainPath}`).toBe(
      entry.lastKnownContentHash,
    );
  }
  for (const [path, bytes] of adapter.files) {
    if (!path.includes(".conflict.")) continue;
    const hash = await sha256Hex(bytes);
    expect(chainHashes.has(hash), `${path} holds content the chain already has`).toBe(false);
  }
}

/**
 * The operation matrix: two engine jobs aimed at one path, forced to overlap at the
 * window a change can open, and the invariant check afterwards. The serialized outcome
 * is the contract — no conflict copy, one chain, state and disk agreeing.
 */
describe("SyncEngine — operation interleavings", () => {
  it("applies a deletion that lands while a pass pulls the same file", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
    await api.remoteEdit(fileId, "v2");

    adapter.onWrite = async (path) => {
      if (path !== "n.md") return;
      adapter.onWrite = null;
      const deleted = await api.remoteDelete(fileId);
      await engine.handleFilePushed(fileId, deleted);
    };
    await engine.initialSync();
    adapter.onWrite = null;
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(adapter.files.has("n.md")).toBe(false);
    expect(engine.fileIdForPath("n.md")).toBeNull();
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "delete"]);
  });

  it("keeps a live empty file (the empty hash is not a tombstone by itself)", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("blank.md", encoder.encode(""));
    await engine.initialSync();
    await engine.whenIdle();

    // The chain action says "live"; the state records the empty hash and a stamp, and the
    // disk still holds the empty file.
    await expectConsistent(engine, adapter, api);
    expect(adapter.files.has("blank.md")).toBe(true);
  });

  it("records a local delete as a tombstone with no file", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("body"));
    await engine.initialSync();
    adapter.files.delete("gone.md");
    await engine.handleLocalDelete("gone.md");
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(adapter.files.has("gone.md")).toBe(false);
  });
  it("runs one bind when a second bind is requested while the first is in flight", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    const held = holdFirstPush(api);

    const first = engine.initialSync({ firstBind: true });
    await held.reached;
    // The second bind must join the first: a second pass would scan the file before the
    // first bind recorded it and push a second chain for the same note.
    const second = engine.initialSync({ firstBind: true });
    held.release();
    await Promise.all([first, second]);
    await engine.whenIdle();

    expect(api.chains.size).toBe(1);
    expect([...api.chains.values()].flat().map((version) => version.action)).toEqual(["create"]);
  });
  it("binds the vault before a rename that arrives before the first sync", async () => {
    const { engine, adapter, api } = await makeEngine();
    const oldPath = "note-2026-01-01-000000.conflict.md";
    adapter.files.set(oldPath, encoder.encode("the old copy"));
    adapter.files.set("kept.md", encoder.encode("kept"));

    // No `initialSync` first: the rename's handler binds (with the bind merge rule),
    // so the file it creates is not a second chain for content the server may hold.
    await engine.handleLocalRename(oldPath, "kept.md");
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(engine.fileIdForPath("kept.md")).toBeTruthy();
    expect(api.chains.size).toBe(1);
  });
  it("turns an untracked rename into a create without waiting for its own job", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    const parked = "note-2026-01-01-000000.conflict.md";
    adapter.files.set(parked, encoder.encode("kept"));
    adapter.files.set("kept.md", encoder.encode("kept"));

    // The rename's job holds both paths; the create work must run directly, because
    // scheduling it would wait for the job that is waiting for it.
    await engine.handleLocalRename(parked, "kept.md");
    await engine.whenIdle();

    expect(engine.fileIdForPath("kept.md")).toBeTruthy();
    expect(api.chains.size).toBe(1);
  });
  it("binds outside the path queue when an event arrives before the first sync", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));

    // No `initialSync` first: the event must bind the vault without waiting for its own
    // job (the bind's per-file job queues on the path the event's job holds).
    await engine.handleLocalChange("n.md");
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(api.chains.size).toBe(1);
    expect(engine.fileIdForPath("n.md")).toBeTruthy();
  });
  it("reports a deferred event's push failure through onError", async () => {
    const failures: Array<{ error: unknown; paths: readonly string[] }> = [];
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (error, paths) => failures.push({ error, paths }),
    );
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);
    await api.remoteEdit(fileId, "v2");

    // A user edit that lands right after the pull's write: the event is fired from inside
    // the adapter call, so its job is deferred (it must not wait for the write), and its
    // push fails. The adapter has no place for that rejection, so `onError` must get it.
    adapter.onWrite = async (path) => {
      if (path !== "n.md") return;
      adapter.onWrite = null;
      adapter.files.set("n.md", encoder.encode("local edit"));
      api.onPush = async () => {
        throw new Error("network down");
      };
      void engine.handleLocalChange("n.md");
    };
    await engine.initialSync();
    await engine.whenIdle();
    adapter.onWrite = null;
    api.onPush = null;

    expect(failures).toHaveLength(1);
    expect(String(failures[0].error)).toContain("network down");
    expect(failures[0].paths).toEqual(["n.md"]);
  });
  it("settles one version when a pass and a notification run at the same time", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
    await api.remoteEdit(fileId, "v2");

    // Both jobs start without waiting for each other; the path queue orders them.
    const notified = engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);
    const pass = engine.initialSync();
    await Promise.all([notified, pass]);
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("v2");
    expect(syncPointOf(engine, fileId)).toBe(await api.latestVersionId(fileId));
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
  });
});
