/**
 * Shared timing harness for the research benchmarks under `packages/e2e/src/research/`.
 *
 * It is the real `SyncEngine`, the real CLI `FsAdapter` and a real server; the
 * only additions are counters and clocks around the adapter and the API, so a run can
 * say **where** a first bind spends its time instead of only how long it took.
 */
import { realPlatform } from "@courier/testing";
import { mkdirSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type { TestServer } from "../harness/server";
import { FsAdapter } from "../../../cli/src/fs-adapter";
import { createCliSyncApi } from "../../../cli/src/api";
import {
  SyncEngine,
  normalizeScope,
  type FileStamp,
  type PushFile,
  type SyncApi,
  type SyncScope,
} from "../../../engine/src/index";
import type {
  SyncPullResponse,
  SyncPushResponse,
  VaultSyncIndexResponse,
} from "../../../shared/src/index";

export const scope: SyncScope = normalizeScope({ configDir: ".obsidian" });

/** One file's shape: 0.8–4 KiB, deterministic, so two runs compare. */
function noteBytes(index: number): Uint8Array {
  const size = 800 + ((index * 2654435761) % 3200);
  return new Uint8Array(size).fill(97 + (index % 26));
}

/** Write `count` notes across 40 folders, plus one 1 MiB attachment, into `root`. */
export function makeVault(root: string, count: number): number {
  let bytes = 0;
  for (let i = 0; i < count; i++) {
    const relative = `folder-${i % 40}/sub-${i % 11}/note-${i}.md`;
    const absolute = join(root, relative);
    mkdirSync(dirname(absolute), { recursive: true });
    const content = noteBytes(i);
    writeFileSync(absolute, content);
    bytes += content.byteLength;
  }
  const attachment = new Uint8Array(1024 * 1024).fill(7);
  mkdirSync(join(root, "attachments"), { recursive: true });
  writeFileSync(join(root, "attachments", "photo.png"), attachment);
  bytes += attachment.byteLength;
  return bytes;
}

/** How many regular files exist under `root` (what actually landed on disk). */
export function countFiles(root: string): number {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
      else total++;
    }
  }
  return total;
}

/** A `SyncAdapter` that counts and times the engine's own I/O. */
export class TimedAdapter extends FsAdapter {
  listCalls = 0;
  listMs = 0;
  statCalls = 0;
  statMs = 0;
  readCalls = 0;
  readMs = 0;

  override async listSyncableFiles(): Promise<string[]> {
    const started = performance.now();
    this.listCalls++;
    try {
      return await super.listSyncableFiles();
    } finally {
      this.listMs += performance.now() - started;
    }
  }

  override async statFile(path: string): Promise<FileStamp | null> {
    const started = performance.now();
    this.statCalls++;
    try {
      return await super.statFile(path);
    } finally {
      this.statMs += performance.now() - started;
    }
  }

  override async readFile(path: string): Promise<Uint8Array | null> {
    const started = performance.now();
    this.readCalls++;
    try {
      return await super.readFile(path);
    } finally {
      this.readMs += performance.now() - started;
    }
  }
}

/** A `SyncApi` that counts and times the engine's requests. */
export class TimedApi implements SyncApi {
  start = 0;
  firstIndexOffsetMs: number | null = null;
  pushCalls = 0;
  pushedFiles = 0;
  pushedBytes = 0;
  pushMs = 0;
  pushErrors = 0;
  /** How many files each push request carried, so a batching regression is visible. */
  pushSizes: number[] = [];
  pullCalls = 0;
  pullMs = 0;
  pullErrors = 0;
  contentCalls = 0;
  contentBytes = 0;
  contentMs = 0;
  contentErrors = 0;
  lastError: string | null = null;
  indexCalls = 0;
  indexMs = 0;

  constructor(private readonly inner: SyncApi) {}

  markStart(): void {
    this.start = performance.now();
    this.firstIndexOffsetMs = null;
  }

  async push(vaultId: string, files: PushFile[]): Promise<SyncPushResponse> {
    const started = performance.now();
    this.pushCalls++;
    this.pushSizes.push(files.length);
    this.pushedFiles += files.length;
    this.pushedBytes += files.reduce((total, file) => total + (file.content?.byteLength ?? 0), 0);
    try {
      return await this.inner.push(vaultId, files);
    } catch (err) {
      this.pushErrors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.pushMs += performance.now() - started;
      // Scaling diagnostics: a per-batch time that grows with the files already sent is
      // a quadratic path (a scan, a re-parse, an unindexed query), not bandwidth.
      if (process.env.COURIER_BENCH_PROGRESS === "1" && this.pushCalls % 50 === 0) {
        console.log(
          `BENCH-PROGRESS push=${this.pushCalls} files=${this.pushedFiles} ` +
            `totalMs=${Math.round(this.pushMs)} lastBatchMs=${Math.round(
              performance.now() - started,
            )}`,
        );
      }
    }
  }

  async pull(vaultId: string, fileIds: string[]): Promise<SyncPullResponse> {
    const started = performance.now();
    this.pullCalls++;
    try {
      return await this.inner.pull(vaultId, fileIds);
    } catch (err) {
      this.pullErrors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.pullMs += performance.now() - started;
    }
  }

  async getVersionContents(
    vaultId: string,
    contentHashes: readonly string[],
  ): Promise<Array<Uint8Array | null>> {
    const started = performance.now();
    this.contentCalls += contentHashes.length;
    try {
      const contents = await this.inner.getVersionContents(vaultId, contentHashes);
      for (const content of contents) this.contentBytes += content?.byteLength ?? 0;
      return contents;
    } catch (err) {
      this.contentErrors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.contentMs += performance.now() - started;
    }
  }

  async getVersionContent(vaultId: string, contentHash: string): Promise<Uint8Array> {
    const started = performance.now();
    this.contentCalls++;
    try {
      const content = await this.inner.getVersionContent(vaultId, contentHash);
      this.contentBytes += content.byteLength;
      return content;
    } catch (err) {
      this.contentErrors++;
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      this.contentMs += performance.now() - started;
    }
  }

  async getVersionContentRange(
    vaultId: string,
    contentHash: string,
    start: number,
    end: number,
  ): Promise<Uint8Array> {
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
    return await this.inner.getChunkStatus(vaultId, contentHash);
  }

  async getVaultSyncIndex(vaultId: string): Promise<VaultSyncIndexResponse> {
    const started = performance.now();
    this.indexCalls++;
    this.firstIndexOffsetMs ??= started - this.start;
    try {
      return await this.inner.getVaultSyncIndex(vaultId);
    } finally {
      this.indexMs += performance.now() - started;
    }
  }

  setSessionId(sessionId: string | null): void {
    this.inner.setSessionId?.(sessionId);
  }
}

/** Zero the counters, so one pass can be measured on its own. */
export function resetAdapter(adapter: TimedAdapter): void {
  adapter.listCalls = 0;
  adapter.listMs = 0;
  adapter.statCalls = 0;
  adapter.statMs = 0;
  adapter.readCalls = 0;
  adapter.readMs = 0;
}

export function resetApi(api: TimedApi): void {
  api.pushCalls = 0;
  api.pushedFiles = 0;
  api.pushedBytes = 0;
  api.pushMs = 0;
  api.pushErrors = 0;
  api.pushSizes = [];
  api.pullCalls = 0;
  api.pullMs = 0;
  api.pullErrors = 0;
  api.contentCalls = 0;
  api.contentBytes = 0;
  api.contentMs = 0;
  api.contentErrors = 0;
  api.lastError = null;
  api.indexCalls = 0;
  api.indexMs = 0;
}

export interface BindResult {
  label: string;
  files: number;
  bytes: number;
  totalMs: number;
  /** Milliseconds until the first `GET /sync/index`: the local scan + hash phase. */
  scanMs: number | null;
  adapter: TimedAdapter;
  api: TimedApi;
  engine: SyncEngine;
  state: { json: string | null };
  error: string | null;
  stateJsonBytes: number;
  /** Files present in the local vault after the pass — what actually landed. */
  filesOnDisk: number;
}

export interface RunOptions {
  dir: string;
  server: Pick<TestServer, "serverUrl" | "userKey">;
  vaultId: string;
  key: CryptoKey;
  files: number;
  bytes: number;
  firstBind: boolean;
  /** Reuse the engine of a previous run — a second pass over the same state. */
  previous?: BindResult;
  /** Skip writing the state through `onSaveState` (kept for symmetry). */
  deviceName?: string;
}

/** Bind (or re-run) one engine over `dir` and report where the time went. */
export async function runEngine(label: string, options: RunOptions): Promise<BindResult> {
  const adapter = options.previous?.adapter ?? new TimedAdapter(options.dir, scope);
  const api =
    options.previous?.api ??
    new TimedApi(
      createCliSyncApi({
        serverUrl: options.server.serverUrl,
        userKey: options.server.userKey,
        getDeviceName: () => options.deviceName ?? "bench",
      }),
    );
  const state = options.previous?.state ?? { json: null };
  const engine =
    options.previous?.engine ??
    new SyncEngine({
      platform: realPlatform,
      vaultId: options.vaultId,
      adapter,
      api,
      encryptionKey: options.key,
      syncScope: scope,
      onSaveState: (json) => {
        state.json = json;
      },
    });

  resetAdapter(adapter);
  resetApi(api);
  api.markStart();
  const started = performance.now();
  let error: string | null = null;
  try {
    await engine.initialSync({ firstBind: options.firstBind });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const totalMs = performance.now() - started;

  return {
    label,
    files: options.files,
    bytes: options.bytes,
    totalMs,
    scanMs: api.firstIndexOffsetMs,
    adapter,
    api,
    engine,
    state,
    error,
    stateJsonBytes: state.json?.length ?? 0,
    filesOnDisk: countFiles(options.dir),
  };
}

/** `{ "100": 12, "1": 3 }` — how many requests carried how many files. */
function histogram(sizes: readonly number[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const size of sizes) counts[size] = (counts[size] ?? 0) + 1;
  return counts;
}

/** One machine-readable line per pass, so runs can be compared by eye or pasted. */
export function report(result: BindResult, journal = "delete"): void {
  const { adapter, api } = result;
  const row = {
    label: result.label,
    files: result.files,
    MiB: Number((result.bytes / 1024 / 1024).toFixed(1)),
    journal,
    totalMs: Math.round(result.totalMs),
    perFileMs: Number((result.totalMs / Math.max(1, result.files)).toFixed(2)),
    scanMs: result.scanMs === null ? null : Math.round(result.scanMs),
    listMs: Math.round(adapter.listMs),
    stat: `${adapter.statCalls}/${Math.round(adapter.statMs)}ms`,
    read: `${adapter.readCalls}/${Math.round(adapter.readMs)}ms`,
    index: `${api.indexCalls}/${Math.round(api.indexMs)}ms`,
    push: `${api.pushCalls}req ${api.pushedFiles}f ${Math.round(
      api.pushedBytes / 1024 / 1024,
    )}MiB ${Math.round(api.pushMs)}ms`,
    pushErrors: api.pushErrors,
    pushSizes: histogram(api.pushSizes),
    pull: `${api.pullCalls}req ${Math.round(api.pullMs)}ms`,
    pullErrors: api.pullErrors,
    content: `${api.contentCalls}req ${Math.round(api.contentBytes / 1024 / 1024)}MiB ${Math.round(
      api.contentMs,
    )}ms`,
    contentErrors: api.contentErrors,
    lastError: api.lastError,
    filesOnDisk: result.filesOnDisk,
    stateKiB: Math.round(result.stateJsonBytes / 1024),
    error: result.error,
  };
  console.log(`BENCH ${JSON.stringify(row)}`);
}
