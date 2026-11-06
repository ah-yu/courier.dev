import { realPlatform } from "@courier/testing";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { FsAdapter } from "../../../cli/src/fs-adapter";
import { createCliSyncApi } from "../../../cli/src/api";
import {
  SyncEngine,
  normalizeScope,
  type FileTypeSync,
  type SettingsAppliedEvent,
  type SettingsSyncGroups,
  type SyncScope,
} from "../../../engine/src/index";
import type { TestServer } from "./server";
import { conflictCopyOf } from "./conflict";
import { assertClientConsistent } from "./consistency";
import type { SyncApi, PushFile, SyncActivityEvent } from "../../../engine/src/index";
import type {
  SyncPushResponse,
  SyncPullResponse,
  VaultSyncIndexResponse,
} from "../../../shared/src/index";

/**
 * The real API with two switches a test can flip: one models the connection going
 * away (every request throws, exactly as `fetch`/`requestUrl` do when the host
 * cannot reach the server), the other injects work into the window between a
 * decision and the push that carries it out.
 *
 * A host that loses its socket keeps running, so the first is how "the user kept
 * editing while the network was down" is reproduced at this layer; the second is
 * how "a peer pushed while this client was deciding" is.
 */
class SwitchableApi implements SyncApi {
  offline = false;
  /** Runs inside the next `push`, before the request goes out. Consumed once. */
  beforePush: (() => Promise<void>) | null = null;
  /**
   * Every push the engine handed over, with how many files and how many content
   * bytes it carried. This is how a test asserts the *wire* shape — that a rename
   * sent no payload, that a bind batched its files — without reaching into the
   * engine's internals.
   */
  readonly pushCalls: Array<{ files: number; contentBytes: number }> = [];
  /** Every push's per-file verdicts, in call order (`ok` / `stale_base` / …). */
  readonly pushResults: Array<
    Array<{ fileId: string; status: string; versionId?: string; currentVersionId?: string }>
  > = [];
  /** The last 50 pulls, with the chains exactly as the server returned them. */
  readonly pulls: Array<{ fileIds: string[]; files: unknown[] }> = [];
  /** Every version content the engine asked the server for, by content hash. */
  readonly contentFetches: string[] = [];
  /** Every chunk the engine staged, in arrival order (index per hash). */
  readonly chunkUploads: Array<{ contentHash: string; index: number }> = [];
  /** Every ranged content request — a chunked download's evidence. */
  readonly rangeFetches: Array<{ contentHash: string; start: number; end: number }> = [];

  constructor(private readonly inner: SyncApi) {}

  private guard(): void {
    if (this.offline) throw new Error("offline");
  }

  async push(vaultId: string, files: PushFile[]): Promise<SyncPushResponse> {
    this.guard();
    const hook = this.beforePush;
    if (hook) {
      this.beforePush = null;
      await hook();
    }
    this.pushCalls.push({
      files: files.length,
      contentBytes: files.reduce((total, file) => total + (file.content?.byteLength ?? 0), 0),
    });
    const response = await this.inner.push(vaultId, files);
    // The verdicts, per file, in order. A `stale_base` here is what makes the engine
    // re-decide from the fresh chain, so a test about that path has to see it.
    this.pushResults.push(response.results.map((result) => ({ ...result })));
    return response;
  }

  async pull(vaultId: string, fileIds: string[]): Promise<SyncPullResponse> {
    this.guard();
    const response = await this.inner.pull(vaultId, fileIds);
    // The chains **as the engine received them**: order is the whole question in a
    // `stale_base` re-decision (`remoteHead` is the last entry), so a probe has to see it.
    this.pulls.push({ fileIds: [...fileIds], files: structuredClone(response.files) });
    if (this.pulls.length > 50) this.pulls.shift();
    return response;
  }

  async getVersionContent(vaultId: string, contentHash: string): Promise<Uint8Array> {
    this.guard();
    this.contentFetches.push(contentHash);
    return await this.inner.getVersionContent(vaultId, contentHash);
  }

  async getVersionContentRange(
    vaultId: string,
    contentHash: string,
    start: number,
    end: number,
  ): Promise<Uint8Array> {
    this.guard();
    this.rangeFetches.push({ contentHash, start, end });
    return await this.inner.getVersionContentRange(vaultId, contentHash, start, end);
  }

  async uploadChunk(
    vaultId: string,
    contentHash: string,
    index: number,
    chunkCount: number,
    plaintextSize: number,
    content: Uint8Array,
  ): Promise<{ received: number }> {
    this.guard();
    this.chunkUploads.push({ contentHash, index });
    return await this.inner.uploadChunk(
      vaultId,
      contentHash,
      index,
      chunkCount,
      plaintextSize,
      content,
    );
  }

  async getChunkStatus(
    vaultId: string,
    contentHash: string,
  ): Promise<{ received: number; complete: boolean } | null> {
    this.guard();
    return await this.inner.getChunkStatus(vaultId, contentHash);
  }

  async getVaultSyncIndex(vaultId: string): Promise<VaultSyncIndexResponse> {
    this.guard();
    return await this.inner.getVaultSyncIndex(vaultId);
  }

  setSessionId(sessionId: string | null): void {
    this.inner.setSessionId?.(sessionId);
  }
}

/**
 * The CLI's real filesystem adapter, with a per-path read counter.
 *
 * The engine's "do not read what has not changed" rule is a claim about I/O, so the
 * honest way to assert it is to count the reads — which is what this is for. Nothing
 * else about the adapter changes: the same real `fs` calls run underneath.
 */
class CountingFsAdapter extends FsAdapter {
  readonly reads = new Map<string, number>();
  /** Streamed writes this device made (one per pulled large file). */
  streamedWrites = 0;
  /** Chunks those writes were made of. */
  streamedChunks = 0;

  override async readFile(path: string): Promise<Uint8Array | null> {
    this.reads.set(path, (this.reads.get(path) ?? 0) + 1);
    return await super.readFile(path);
  }

  override async beginWrite(path: string) {
    this.streamedWrites++;
    const inner = await super.beginWrite(path);
    return {
      write: async (chunk: Uint8Array) => {
        this.streamedChunks++;
        await inner.write(chunk);
      },
      close: async () => await inner.close(),
      abort: async () => await inner.abort(),
    };
  }
}

/**
 * One headless sync client: the CLI's real `FsAdapter` (a temp directory)
 * + real `createCliSyncApi` (HTTP to the test server) + the real `SyncEngine`.
 *
 * This is the "device" half of the end-to-end tests — everything except the
 * Obsidian plugin shell, which `plugin.e2e.test.ts` covers with the real
 * plugin class.
 */
export class TestClient {
  /** Build through {@link createTestClient}. */
  constructor(
    readonly dir: string,
    /** Label this client states on its pushes — a plain string, nothing registered. */
    readonly deviceName: string,
    readonly adapter: CountingFsAdapter,
    readonly engine: SyncEngine,
    /** Shared with the engine's `onSaveState` — what a host would persist. */
    readonly state: { json: string | null },
    /** Every decision the engine reported (`onSyncActivity`), in order. */
    readonly activities: SyncActivityEvent[],
    /** The same client the engine pushes through, with an offline switch. */
    private readonly api: SwitchableApi,
    private readonly ownsDir: boolean,
  ) {}

  /** Every push the engine made, with its file count and content bytes. */
  get pushCalls(): ReadonlyArray<{ files: number; contentBytes: number }> {
    return this.api.pushCalls;
  }

  /** Every version content this client downloaded, by content hash. */
  get contentFetches(): ReadonlyArray<string> {
    return this.api.contentFetches;
  }

  /** Every push's per-file verdicts, in order. */
  get pushResults(): ReadonlyArray<
    ReadonlyArray<{ fileId: string; status: string; versionId?: string; currentVersionId?: string }>
  > {
    return this.api.pushResults;
  }

  /** The last 50 pulls, with the chains as the server sent them. */
  get pulls(): ReadonlyArray<{ fileIds: string[]; files: unknown[] }> {
    return this.api.pulls;
  }

  /** Every chunk this client staged (index per content hash). */
  get chunkUploads(): ReadonlyArray<{ contentHash: string; index: number }> {
    return this.api.chunkUploads;
  }

  /** Every ranged content request this client made. */
  get rangeFetches(): ReadonlyArray<{ contentHash: string; start: number; end: number }> {
    return this.api.rangeFetches;
  }

  /** How many times this client read `path` from disk (the stamp cache's evidence). */
  readsOf(path: string): number {
    return this.adapter.reads.get(path) ?? 0;
  }

  /** Streamed writes this device made — one per large download. */
  get streamedWrites(): number {
    return this.adapter.streamedWrites;
  }

  /** How many chunks those streamed writes were made of. */
  get streamedChunks(): number {
    return this.adapter.streamedChunks;
  }

  /** Forget the counters, so a test can measure one operation. */
  resetCounters(): void {
    this.api.pushCalls.length = 0;
    this.api.pushResults.length = 0;
    this.api.pulls.length = 0;
    this.activities.length = 0;
    this.api.contentFetches.length = 0;
    this.api.chunkUploads.length = 0;
    this.api.rangeFetches.length = 0;
    this.adapter.reads.clear();
    this.adapter.streamedWrites = 0;
    this.adapter.streamedChunks = 0;
  }

  // ── Local filesystem (what a user editing notes looks like) ──

  write(path: string, content: string): void {
    const absolute = join(this.dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }

  read(path: string): string | null {
    try {
      return readFileSync(join(this.dir, path), "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Write raw bytes — how a test creates an image, an audio file or a PDF.
   *
   * `read()` decodes as UTF-8, so a binary file has to go in and out through this pair;
   * an assertion on bytes is the only one that proves nothing was re-encoded on the way.
   */
  writeBinary(path: string, bytes: Uint8Array): void {
    const absolute = join(this.dir, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, bytes);
  }

  /** The bytes on disk for `path`, or null when it does not exist. */
  readBytes(path: string): Uint8Array | null {
    try {
      return new Uint8Array(readFileSync(join(this.dir, path)));
    } catch {
      return null;
    }
  }

  remove(path: string): void {
    rmSync(join(this.dir, path), { force: true });
  }

  /**
   * Move a file on disk.
   *
   * A real filesystem rename, not read+write: the read/write pair goes through UTF-8 and
   * would corrupt any binary file this harness moves.
   */
  move(from: string, to: string): void {
    const source = join(this.dir, from);
    if (!existsSync(source)) throw new Error(`move: ${from} does not exist`);
    const target = join(this.dir, to);
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
  }

  async list(): Promise<string[]> {
    return await this.adapter.listSyncableFiles();
  }

  /**
   * Set a file's modification time.
   *
   * A config-folder conflict is settled by "newer modification wins", so a test that
   * exercises it has to state both sides' times explicitly instead of racing two real
   * clocks (or a peer's filesystem against this one's).
   */
  setMtime(path: string, mtimeMs: number): void {
    const time = new Date(mtimeMs);
    utimesSync(join(this.dir, path), time, time);
  }

  /**
   * The conflict files parked in this directory.
   *
   * They never sync, so this is the only trace a resolved conflict leaves on a
   * client — and therefore the honest way to assert "no conflict happened here".
   */
  async conflictFiles(): Promise<string[]> {
    return await this.adapter.listConflictFiles();
  }

  /**
   * The copy the engine parked beside `plainPath` when it resolved a conflict, or null.
   *
   * A copy is named after the second it was parked at, so this cannot be rebuilt from the
   * test's own clock — see {@link conflictCopyOf}.
   */
  async parkedCopyOf(plainPath: string): Promise<string | null> {
    return conflictCopyOf(await this.conflictFiles(), plainPath);
  }

  /**
   * What the engine parked beside `plainPath`, or null when nothing was — the losing side
   * of a conflict, as the user would read it.
   */
  async parkedContentOf(plainPath: string): Promise<string | null> {
    const copy = await this.parkedCopyOf(plainPath);
    return copy === null ? null : this.read(copy);
  }

  // ── Engine driving (the CLI runner calls exactly these) ──

  /** Full reconcile — what a fresh start / reconnect does. */
  async sync(): Promise<void> {
    await this.engine.initialSync();
    await this.engine.whenIdle();
    await assertClientConsistent(this);
  }

  /**
   * The pass that binds the vault (a connect, or a host starting up): a local file
   * the server has no live version of is the user's own and is pushed as a new
   * file, instead of being deleted by the connection.
   *
   * `priorityPaths` is the host's "the user is looking at these" hint; the pass orders
   * its work by it (see `priority.test.ts` and the engine's ordering cases).
   */
  async bind(options: { priorityPaths?: readonly string[] } = {}): Promise<void> {
    await this.engine.initialSync({ firstBind: true, priorityPaths: options.priorityPaths });
    await this.engine.whenIdle();
    await assertClientConsistent(this);
  }

  async change(path: string): Promise<void> {
    await this.engine.handleLocalChange(path);
    await this.engine.whenIdle();
    await assertClientConsistent(this);
  }

  /**
   * The pass a host runs between reconciles to carry local **settings** changes:
   * the config folder fires no vault event, so nothing else would see them.
   */
  async syncSettings(): Promise<void> {
    await this.engine.syncLocalSettings();
    await this.engine.whenIdle();
    await assertClientConsistent(this);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.engine.handleLocalRename(from, to);
    await this.engine.whenIdle();
    await assertClientConsistent(this);
  }

  async removeAndSync(path: string): Promise<void> {
    await this.engine.handleLocalDelete(path);
    await this.engine.whenIdle();
    await assertClientConsistent(this);
  }

  /** Simulate the remote-change WebSocket notification. */
  async remotePushed(
    fileId: string,
    versionId: string,
    options: { settle?: boolean } = {},
  ): Promise<void> {
    await this.engine.handleFilePushed(fileId, versionId);
    // A case that delivers the notification from inside the engine's own write must not
    // wait here: the queue would wait for the write that is waiting for this call.
    if (options.settle === false) return;
    await this.engine.whenIdle();
    await assertClientConsistent(this);
  }

  // ── The connection ──

  /**
   * The network goes away: from here every request fails, so a push triggered by
   * a vault event is lost and no notification can arrive. The engine keeps no
   * queue — the next {@link sync} is what carries the local changes.
   */
  goOffline(): void {
    this.api.offline = true;
  }

  goOnline(): void {
    this.api.offline = false;
  }

  /**
   * Run `fn` inside this client's **next** push, before the request goes out.
   *
   * The engine decides from a chain and then pushes; a real network has room for a
   * peer's push in between, and a conditional push is what keeps that from
   * overwriting it. This is how a test puts a peer's push into exactly that window.
   */
  beforeNextPush(fn: () => Promise<void>): void {
    this.api.beforePush = fn;
  }

  cleanup(): void {
    if (this.ownsDir) rmSync(this.dir, { recursive: true, force: true });
  }
}

export interface CreateClientOptions {
  server: TestServer;
  vaultId: string;
  key: CryptoKey;
  deviceName?: string;
  /** Reuse an existing directory to model a client restarting. */
  dir?: string;
  /**
   * Which config-folder groups this device syncs (default: none).
   * Pass `OBSIDIAN_DEFAULT_GROUPS` for "the switches Obsidian Sync has on" or a
   * hand-written record to test one group at a time.
   */
  settingsGroups?: Partial<SettingsSyncGroups>;
  /**
   * Which vault file types this device syncs. Omitted = the engine's defaults
   * (images/audio/video/PDF on, every other type off), like a real device; pass
   * `NO_FILE_TYPES` for markdown and canvas only.
   */
  fileTypes?: Partial<FileTypeSync>;
  /**
   * Vault folders this device leaves out of sync entirely (default: none).
   * Device-local like the records above.
   */
  excludedFolders?: readonly string[];
  /** Largest file this device moves, in plaintext bytes; omitted = the engine default. */
  maxFileBytes?: number;
  /** Called for a file the size cap skipped, in either direction. */
  onFileTooLarge?: (event: { plainPath: string; sizeBytes: number }) => void;
  /** Called for a file the API's own limits skipped (today: a path too long for it). */
  onFileSkipped?: (event: { plainPath: string; reason: "path-too-long" }) => void;
  /**
   * Called for every config-folder file a peer's version was applied to — what a host
   * turns into "重新加载 Obsidian 后生效".
   */
  onSettingsApplied?: (event: SettingsAppliedEvent) => void;
  /**
   * Called for every decision the engine reports (a version sent, a remote one applied, a
   * path skipped). The client keeps them in {@link TestClient.activities}; this is for a
   * test that wants to observe them as they happen.
   */
  onSyncActivity?: (event: SyncActivityEvent) => void;
}

/** Build a headless sync client that states `deviceName` on its pushes. */
export async function createTestClient(options: CreateClientOptions): Promise<TestClient> {
  const deviceName = options.deviceName ?? "test-device";

  const dir = options.dir ?? mkdtempSync(join(tmpdir(), "courier-client-"));
  const scope: SyncScope = normalizeScope({
    configDir: ".obsidian",
    settingsGroups: options.settingsGroups,
    fileTypes: options.fileTypes,
    excludedFolders: options.excludedFolders,
    maxFileBytes: options.maxFileBytes,
  });
  const adapter = new CountingFsAdapter(dir, scope);
  const api = new SwitchableApi(
    createCliSyncApi({
      serverUrl: options.server.serverUrl,
      userKey: options.server.userKey,
      getDeviceName: () => deviceName,
    }),
  );

  const state: { json: string | null } = { json: null };
  /** Everything the engine reported as applied or parked, in order. */
  const activities: SyncActivityEvent[] = [];
  const engine = new SyncEngine({
    platform: realPlatform,
    vaultId: options.vaultId,
    adapter,
    api,
    encryptionKey: options.key,
    syncScope: scope,
    onFileTooLarge: options.onFileTooLarge,
    onFileSkipped: options.onFileSkipped,
    onSettingsApplied: options.onSettingsApplied,
    onSyncActivity: (event) => {
      activities.push(event);
      options.onSyncActivity?.(event);
    },
    onSaveState: (json) => {
      state.json = json;
    },
  });

  return new TestClient(
    dir,
    deviceName,
    adapter,
    engine,
    // The same object the engine's `onSaveState` writes into.
    state,
    activities,
    api,
    options.dir === undefined,
  );
}
