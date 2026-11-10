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
  MAX_CONTENT_BATCH_FILES,
  chunkAdditionalData,
  reversedCopy,
  sortedCopy,
} from "@courier/shared";
import { conflictFilePath } from "./conflict-file";
import type { OpQueueLimits } from "./op-queue";
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
export function freezeConflictClock(): void {
  beforeEach(() => {
    // Only the clock is frozen: `setSystemTime` without `useFakeTimers` leaves every
    // scheduler real, and the engine's waits rely on that.
    vi.setSystemTime(new Date(2026, 1, 14, 10, 15, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
  });
}

/**
 * The fake vault's file map, which stamps every mutation.
 *
 * A real filesystem gives a changed file a new mtime, and the engine's "do not re-read
 * what has not changed" rule leans on exactly that. A plain `Map` would let a test
 * change content without moving the clock, and the engine would keep trusting the hash
 * it recorded — so the stamping lives in the map itself and every mutation a test makes
 * (directly, or through the adapter) keeps the fake honest.
 */
export class StampedFiles extends Map<string, Uint8Array> {
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
export class FakeAdapter implements SyncAdapter {
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
 * A fake adapter whose deletes take a turn, so a test can see how many run at once.
 *
 * Without the timer the fake resolves in a microtask and four tasks that never yield
 * look exactly like one; the timer is the window in which the overlap is observable.
 */
export class SlowDeleteAdapter extends FakeAdapter {
  active = 0;
  maxActive = 0;

  override async deleteFile(path: string): Promise<void> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await super.deleteFile(path);
    } finally {
      this.active -= 1;
    }
  }
}

/**
 * A fake adapter whose writes and moves take a turn, so a test can see how many run at
 * once.
 *
 * The write/move twin of {@link SlowDeleteAdapter}: a batch that must serialise two
 * decisions about one path is visible in the overlap.
 */
export class SlowWriteAdapter extends FakeAdapter {
  active = 0;
  maxActive = 0;
  ops = 0;

  private async slow<T>(run: () => Promise<T>): Promise<T> {
    this.active += 1;
    this.ops += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return await run();
    } finally {
      this.active -= 1;
    }
  }

  override async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    await this.slow(() => super.writeFile(path, bytes));
  }

  override async renameFile(from: string, to: string): Promise<void> {
    await this.slow(() => super.renameFile(from, to));
  }
}

/**
 * A fake host that can write a file in pieces.
 *
 * It records what the engine streams, so a test can prove a large download never took
 * the whole-file path and that a failed one aborted instead of leaving a partial file.
 * `close` writes the assembled bytes and plays the host's vault event, exactly like a
 * real adapter's rename.
 */
export class StreamingFakeAdapter extends FakeAdapter {
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
export class FakeApi implements SyncApi {
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
  /** Every batched content request, by the hashes it named, in call order. */
  contentBatchCalls: string[][] = [];
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
   * `files_pushed` broadcast reaches a client while its own request is still in
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

  /**
   * The batched content route: the same blobs, in the order asked for, with `null` for a
   * hash the store does not hold. `contentBatchCalls` is what a test asserts the engine's
   * batching against.
   */
  async getVersionContents(
    _vaultId: string,
    contentHashes: readonly string[],
  ): Promise<Array<Uint8Array | null>> {
    this.guard();
    this.contentBatchCalls.push([...contentHashes]);
    for (const hash of contentHashes) this.contentFetches.push(hash);
    this.inFlightContent++;
    this.maxInFlightContent = Math.max(this.maxInFlightContent, this.inFlightContent);
    try {
      if (this.contentDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.contentDelayMs));
      }
      return contentHashes.map((hash) => this.blobs.get(hash) ?? null);
    } finally {
      this.inFlightContent--;
    }
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
export async function makeEngine(
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

export const encoder = new TextEncoder();

/** Assert byte equality without `Buffer` (the engine runs on Web Crypto). */
export function expectSameBytes(actual: Uint8Array | undefined, expected: Uint8Array): void {
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
export function syncPointOf(engine: SyncEngine, fileId: string): string | undefined {
  const state = JSON.parse(engine.serializeState()) as Record<
    string,
    { lastKnownVersionId: string }
  >;
  return state[fileId]?.lastKnownVersionId;
}

/** The fileId the server knows a path under, after a first sync. */
export async function syncedFileId(api: FakeApi, action: SyncAction = "create"): Promise<string> {
  return api.pushed.find((p) => p.action === action)!.fileId;
}

/**
 * Park the *first* push the api receives, so a test can start a reconcile while
 * an event is still inside `pushFile` — the "slow network" shape of an event
 * still in flight. Later pushes pass through, or the reconcile would be the one
 * the test hangs on.
 */
export function holdFirstPush(api: FakeApi) {
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
export function pushFromPeerMidFlight(api: FakeApi, run: () => Promise<void>): void {
  let injected = false;
  api.onPush = async () => {
    if (injected) return;
    injected = true;
    await run();
  };
}

export function engineOver(
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
export function scopeWith(...groups: SettingsGroup[]): SyncScope {
  const settingsGroups: Record<string, boolean> = {};
  for (const group of groups) settingsGroups[group] = true;
  return normalizeScope({ configDir: ".obsidian", settingsGroups, fileTypes: NO_FILE_TYPES });
}

/** Markdown-only, with the named vault folders excluded on this device. */
export function scopeWithExcluded(...folders: string[]): SyncScope {
  return normalizeScope({
    configDir: ".obsidian",
    settingsGroups: NO_SETTINGS_GROUPS,
    fileTypes: NO_FILE_TYPES,
    excludedFolders: folders,
  });
}

/** A scope with the named vault file types on and nothing else special. */
export function fileTypesWith(...types: FileTypeGroup[]): SyncScope {
  const fileTypes: Record<string, boolean> = { ...NO_FILE_TYPES };
  for (const type of types) fileTypes[type] = true;
  return normalizeScope({ fileTypes });
}

export function fileTypesEngine(
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
export function textOf(adapter: FakeAdapter, path: string): string | null {
  const bytes = adapter.files.get(path);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

export const plain = (bytes: Uint8Array | undefined): string =>
  bytes ? new TextDecoder().decode(bytes) : "";

/** No `*.conflict.*` copy anywhere in the fake vault. */
export function noConflictCopies(adapter: FakeAdapter): boolean {
  return ![...adapter.files.keys()].some((path) => path.includes(".conflict."));
}

export const conflictPaths = (adapter: FakeAdapter): string[] =>
  [...adapter.files.keys()].filter((path) => path.includes(".conflict."));

/** A refusal shaped like the server's 429, with a wait short enough for a test. */
export function rateLimited(retryAfterMs = 1): Error {
  return Object.assign(new Error("Rate limit exceeded. Please try again in 1 seconds."), {
    status: 429,
    code: "RATE_LIMITED",
    retryAfterMs,
  });
}

/**
 * The invariants a settled engine must hold, whatever order its jobs ran in.
 *
 * A pass, a notification and an event are separate jobs; the matrix below pairs them at
 * the windows a change can open, and this is what every case asserts afterwards: the
 * state names a path that maps back to its chain, the state's hash is the bytes on disk
 * (or a tombstone with no file), and a conflict copy never holds content the chain
 * already has (that copy would be a conflict with no divergence behind it).
 */
export async function expectConsistent(
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
      // A tombstoned chain's old path may already belong to another chain — a move landed
      // there in the same job (the destination's tombstone precedes the move) — so the test
      // is "no file unless a *different* chain owns the path", not "no file".
      const owner = engine.fileIdForPath(entry.plainPath);
      if (owner === null || owner === fileId) {
        expect(bytes, `a tombstone at ${entry.plainPath} has no file`).toBeUndefined();
      }
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
// The suite files import their fixtures and the modules they assert on from here, so
// each one reads as a topic and not as another copy of this preamble.
export {
  CHUNK_PLAINTEXT_BYTES,
  MAX_CONTENT_BATCH_FILES,
  MAX_RATE_LIMIT_WAITS,
  NO_FILE_TYPES,
  NO_SETTINGS_GROUPS,
  SETTINGS_GROUPS,
  SyncEngine,
  afterEach,
  beforeEach,
  chunkAdditionalData,
  conflictFilePath,
  decryptCombinedBytes,
  decryptString,
  deriveEncryptionKey,
  describe,
  encryptChunkBytes,
  encryptCombinedBytes,
  encryptString,
  expect,
  generateFileId,
  generateVersionId,
  it,
  normalizeScope,
  realPlatform,
  reversedCopy,
  sha256Hex,
  sha256Text,
  sortedCopy,
  vi,
};
export type {
  ConflictResolvedEvent,
  FileSkippedEvent,
  FileStamp,
  FileTooLargeEvent,
  FileTypeGroup,
  OpQueueLimits,
  PushFile,
  SettingsAppliedEvent,
  SettingsGroup,
  SyncAction,
  SyncActivityEvent,
  SyncAdapter,
  SyncApi,
  SyncProgress,
  SyncPullResponse,
  SyncPushResponse,
  SyncPushResult,
  SyncScope,
  SyncWriteStream,
  VaultSyncIndexResponse,
  VersionChainEntry,
};
