/**
 * The sync benchmark: the wall clock of the paths a vault actually travels.
 *
 * Opt-in (`COURIER_BENCH=1`); `bun run bench <scenario>` wraps it, and CI runs one
 * scenario per process. It drives the real server (Hono + SQLite + ws), the real
 * `SyncEngine`, the CLI's real `FsAdapter` and a real HTTP loopback, with
 * clocks around the adapter and the API. One process == one measured run: the
 * server, its database and the vaults are created and removed per process, so a
 * median is over independent runs.
 *
 * Scenarios:
 *
 * - `many`  — 5 000 small notes: bind, idle, full pull, then 1% edited four ways.
 * - `large` — one chunked file (128 MiB by default): chunked push and ranged pull.
 * - `churn` — 1 000 notes, then 10% renamed and 10% deleted: moves and tombstones.
 *
 * Every scenario also asserts the invariants it measures (bytes equal, every file
 * landed, the expected request counts), so a run that gets faster by losing data
 * fails instead of looking like an improvement.
 *
 * Env: `BENCH_SCENARIO`, `BENCH_FILES`, `BENCH_CHURN_FILES`, `BENCH_LARGE_MIB`,
 * `BENCH_RUN_ID`, `BENCH_RESULTS_DIR`, `BENCH_TMP`.
 */
import { realPlatform } from "@courier/testing";

import assert from "assert/strict";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "fs";
import { cpus, platform, release, tmpdir, totalmem } from "os";
import { dirname, join, relative, resolve, sep } from "path";
import { Database } from "bun:sqlite";
import { it } from "vitest";
import { deletedFiles, fileVersions, vaultHistory } from "../harness/api";
import { patchTestUser, startTestServer, type TestServer } from "../harness/server";
import { createTestVault, makeVaultMaterial, type VaultMaterial } from "../harness/vault";
import { FsAdapter } from "../../../cli/src/fs-adapter";
import { createCliSyncApi } from "../../../cli/src/api";
import {
  SyncEngine,
  decryptString,
  normalizeScope,
  type FileStamp,
  type PushFile,
  type SyncApi,
  type SyncScope,
} from "../../../engine/src/index";
import {
  BLOB_HEADER_BYTES,
  CHUNK_PLAINTEXT_BYTES,
  parseBlobHeader,
  type SyncPullResponse,
  type SyncPushResponse,
  type VaultSyncIndexResponse,
} from "../../../shared/src/index";

const enabled = process.env.COURIER_BENCH === "1";
const REPO = resolve(import.meta.dirname, "../../../..");
const TEMP_ROOT = process.env.BENCH_TMP ?? join(tmpdir(), "courier-bench-tmp");
const RESULTS_DIR = process.env.BENCH_RESULTS_DIR ?? join(tmpdir(), "courier-bench-results");

const SCENARIO = (() => {
  const value = process.env.BENCH_SCENARIO ?? "many";
  if (value === "many" || value === "large" || value === "churn") return value;
  throw new Error(`BENCH_SCENARIO must be many, large or churn (got ${value})`);
})();
const RUN_ID = (process.env.BENCH_RUN_ID ?? "1").replace(/[^a-zA-Z0-9_-]/g, "_");

const MANY_FILES = Number(process.env.BENCH_FILES ?? "3000");
const INCREMENT_FILES = Math.max(1, Math.round(MANY_FILES * 0.01));
/** 10% renamed and 10% deleted: the same share a hand-sized churn would touch. */
const CHURN_FILES = Number(process.env.BENCH_CHURN_FILES ?? "500");
const RENAME_FILES = Math.max(1, Math.round(CHURN_FILES * 0.1));
const DELETE_FILES = Math.max(1, Math.round(CHURN_FILES * 0.1));
const LARGE_MIB = Number(process.env.BENCH_LARGE_MIB ?? "64");
const LARGE_BYTES = Math.round(LARGE_MIB * 1024 * 1024);
/** Account/device cap used only by the large-file scenario; default product cap is 50 MiB. */
const LARGE_CAP = Number(process.env.BENCH_LARGE_CAP ?? String(1024 * 1024 * 1024));
const LARGE_PATH = "media/large.mp4";

if (enabled) {
  mkdirSync(TEMP_ROOT, { recursive: true });
  mkdirSync(RESULTS_DIR, { recursive: true });
  process.env.TEMP = TEMP_ROOT;
  process.env.TMP = TEMP_ROOT;
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

// ── timing plumbing ─────────────────────────────────────────────────────────

interface ApiSnapshot {
  pushCalls: number;
  pushedFiles: number;
  pushedBytes: number;
  chunkedFiles: number;
  pushMs: number;
  pullCalls: number;
  pullMs: number;
  contentCalls: number;
  contentBytes: number;
  contentMs: number;
  rangeCalls: number;
  rangeBytes: number;
  rangeMs: number;
  chunkCalls: number;
  chunkBytes: number;
  chunkMs: number;
  chunkStatusCalls: number;
  chunkStatusMs: number;
  indexCalls: number;
  indexEntries: number;
  indexMs: number;
  errors: number;
  lastError: string | null;
}

interface AdapterSnapshot {
  listCalls: number;
  listMs: number;
  statCalls: number;
  statMs: number;
  readCalls: number;
  readBytes: number;
  readMs: number;
  writeCalls: number;
  writeBytes: number;
  writeMs: number;
  streamCalls: number;
  streamChunks: number;
  streamBytes: number;
  streamMs: number;
  streamCloseMs: number;
  renameCalls: number;
  renameMs: number;
  deleteCalls: number;
  deleteMs: number;
}

interface MemorySnapshot {
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

class MemoryMonitor {
  baseline: MemorySnapshot = this.sampleNow();
  peak: MemorySnapshot = { ...this.baseline };
  private timer: Timer | null = null;

  constructor(private readonly intervalMs = 20) {}

  start(): void {
    this.baseline = this.sampleNow();
    this.peak = { ...this.baseline };
    this.timer = setInterval(() => this.sample(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): { baselineMiB: MemorySnapshot; peakMiB: MemorySnapshot } {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sample();
    return { baselineMiB: this.toMiB(this.baseline), peakMiB: this.toMiB(this.peak) };
  }

  private sample(): void {
    const current = this.sampleNow();
    this.peak.rss = Math.max(this.peak.rss, current.rss);
    this.peak.heapUsed = Math.max(this.peak.heapUsed, current.heapUsed);
    this.peak.external = Math.max(this.peak.external, current.external);
    this.peak.arrayBuffers = Math.max(this.peak.arrayBuffers, current.arrayBuffers);
  }

  private sampleNow(): MemorySnapshot {
    const usage = process.memoryUsage();
    return {
      rss: usage.rss,
      heapUsed: usage.heapUsed,
      external: usage.external,
      arrayBuffers: usage.arrayBuffers,
    };
  }

  private toMiB(value: MemorySnapshot): MemorySnapshot {
    return {
      rss: round(value.rss / 1024 / 1024, 1),
      heapUsed: round(value.heapUsed / 1024 / 1024, 1),
      external: round(value.external / 1024 / 1024, 1),
      arrayBuffers: round(value.arrayBuffers / 1024 / 1024, 1),
    };
  }
}

class TimedAdapter extends FsAdapter {
  listCalls = 0;
  listMs = 0;
  statCalls = 0;
  statMs = 0;
  readCalls = 0;
  readBytes = 0;
  readMs = 0;
  writeCalls = 0;
  writeBytes = 0;
  writeMs = 0;
  streamCalls = 0;
  streamChunks = 0;
  streamBytes = 0;
  streamMs = 0;
  streamCloseMs = 0;
  renameCalls = 0;
  renameMs = 0;
  deleteCalls = 0;
  deleteMs = 0;

  reset(): void {
    this.listCalls = 0;
    this.listMs = 0;
    this.statCalls = 0;
    this.statMs = 0;
    this.readCalls = 0;
    this.readBytes = 0;
    this.readMs = 0;
    this.writeCalls = 0;
    this.writeBytes = 0;
    this.writeMs = 0;
    this.streamCalls = 0;
    this.streamChunks = 0;
    this.streamBytes = 0;
    this.streamMs = 0;
    this.streamCloseMs = 0;
    this.renameCalls = 0;
    this.renameMs = 0;
    this.deleteCalls = 0;
    this.deleteMs = 0;
  }

  snapshot(): AdapterSnapshot {
    return {
      listCalls: this.listCalls,
      listMs: round(this.listMs, 1),
      statCalls: this.statCalls,
      statMs: round(this.statMs, 1),
      readCalls: this.readCalls,
      readBytes: this.readBytes,
      readMs: round(this.readMs, 1),
      writeCalls: this.writeCalls,
      writeBytes: this.writeBytes,
      writeMs: round(this.writeMs, 1),
      streamCalls: this.streamCalls,
      streamChunks: this.streamChunks,
      streamBytes: this.streamBytes,
      streamMs: round(this.streamMs, 1),
      streamCloseMs: round(this.streamCloseMs, 1),
      renameCalls: this.renameCalls,
      renameMs: round(this.renameMs, 1),
      deleteCalls: this.deleteCalls,
      deleteMs: round(this.deleteMs, 1),
    };
  }

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
      const bytes = await super.readFile(path);
      this.readBytes += bytes?.byteLength ?? 0;
      return bytes;
    } finally {
      this.readMs += performance.now() - started;
    }
  }

  override async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const started = performance.now();
    this.writeCalls++;
    this.writeBytes += bytes.byteLength;
    try {
      await super.writeFile(path, bytes);
    } finally {
      this.writeMs += performance.now() - started;
    }
  }

  /**
   * A streamed download is one logical write made of several chunks, so it is counted
   * separately from `writeFile` — the large-file invariant is "one logical write", and
   * the chunk count is what proves the plaintext never had to exist as one buffer.
   */
  override async beginWrite(path: string) {
    const started = performance.now();
    this.streamCalls++;
    const inner = await super.beginWrite(path);
    try {
      return {
        write: async (chunk: Uint8Array) => {
          const chunkStarted = performance.now();
          this.streamChunks++;
          this.streamBytes += chunk.byteLength;
          try {
            await inner.write(chunk);
          } finally {
            this.streamMs += performance.now() - chunkStarted;
          }
        },
        close: async () => {
          const closeStarted = performance.now();
          try {
            await inner.close();
          } finally {
            this.streamCloseMs += performance.now() - closeStarted;
          }
        },
        abort: async () => {
          await inner.abort();
        },
      };
    } finally {
      this.writeMs += performance.now() - started;
    }
  }

  override async renameFile(from: string, to: string): Promise<void> {
    const started = performance.now();
    this.renameCalls++;
    try {
      await super.renameFile(from, to);
    } finally {
      this.renameMs += performance.now() - started;
    }
  }

  override async deleteFile(path: string): Promise<void> {
    const started = performance.now();
    this.deleteCalls++;
    try {
      await super.deleteFile(path);
    } finally {
      this.deleteMs += performance.now() - started;
    }
  }
}

class TimedApi implements SyncApi {
  pushCalls = 0;
  pushedFiles = 0;
  pushedBytes = 0;
  chunkedFiles = 0;
  pushMs = 0;
  pullCalls = 0;
  pullMs = 0;
  contentCalls = 0;
  contentBytes = 0;
  contentMs = 0;
  rangeCalls = 0;
  rangeBytes = 0;
  rangeMs = 0;
  chunkCalls = 0;
  chunkBytes = 0;
  chunkMs = 0;
  chunkIndices: number[] = [];
  chunkStatusCalls = 0;
  chunkStatusMs = 0;
  indexCalls = 0;
  indexEntries = 0;
  indexMs = 0;
  errors = 0;
  lastError: string | null = null;

  constructor(private readonly inner: SyncApi) {}

  reset(): void {
    this.pushCalls = 0;
    this.pushedFiles = 0;
    this.pushedBytes = 0;
    this.chunkedFiles = 0;
    this.pushMs = 0;
    this.pullCalls = 0;
    this.pullMs = 0;
    this.contentCalls = 0;
    this.contentBytes = 0;
    this.contentMs = 0;
    this.rangeCalls = 0;
    this.rangeBytes = 0;
    this.rangeMs = 0;
    this.chunkCalls = 0;
    this.chunkBytes = 0;
    this.chunkMs = 0;
    this.chunkIndices = [];
    this.chunkStatusCalls = 0;
    this.chunkStatusMs = 0;
    this.indexCalls = 0;
    this.indexEntries = 0;
    this.indexMs = 0;
    this.errors = 0;
    this.lastError = null;
  }

  snapshot(): ApiSnapshot {
    return {
      pushCalls: this.pushCalls,
      pushedFiles: this.pushedFiles,
      pushedBytes: this.pushedBytes,
      chunkedFiles: this.chunkedFiles,
      pushMs: round(this.pushMs, 1),
      pullCalls: this.pullCalls,
      pullMs: round(this.pullMs, 1),
      contentCalls: this.contentCalls,
      contentBytes: this.contentBytes,
      contentMs: round(this.contentMs, 1),
      rangeCalls: this.rangeCalls,
      rangeBytes: this.rangeBytes,
      rangeMs: round(this.rangeMs, 1),
      chunkCalls: this.chunkCalls,
      chunkBytes: this.chunkBytes,
      chunkMs: round(this.chunkMs, 1),
      chunkStatusCalls: this.chunkStatusCalls,
      chunkStatusMs: round(this.chunkStatusMs, 1),
      indexCalls: this.indexCalls,
      indexEntries: this.indexEntries,
      indexMs: round(this.indexMs, 1),
      errors: this.errors,
      lastError: this.lastError,
    };
  }

  private recordError(error: unknown): void {
    this.errors++;
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  async push(vaultId: string, files: PushFile[]): Promise<SyncPushResponse> {
    const started = performance.now();
    this.pushCalls++;
    this.pushedFiles += files.length;
    this.pushedBytes += files.reduce((total, file) => total + (file.content?.byteLength ?? 0), 0);
    this.chunkedFiles += files.filter((file) => (file.contentChunks ?? 0) > 0).length;
    try {
      return await this.inner.push(vaultId, files);
    } catch (error) {
      this.recordError(error);
      throw error;
    } finally {
      this.pushMs += performance.now() - started;
    }
  }

  async pull(vaultId: string, fileIds: string[]): Promise<SyncPullResponse> {
    const started = performance.now();
    this.pullCalls++;
    try {
      return await this.inner.pull(vaultId, fileIds);
    } catch (error) {
      this.recordError(error);
      throw error;
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
    } catch (error) {
      this.recordError(error);
      throw error;
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
    } catch (error) {
      this.recordError(error);
      throw error;
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
    const started = performance.now();
    this.rangeCalls++;
    try {
      const content = await this.inner.getVersionContentRange(vaultId, contentHash, start, end);
      this.rangeBytes += content.byteLength;
      return content;
    } catch (error) {
      this.recordError(error);
      throw error;
    } finally {
      this.rangeMs += performance.now() - started;
    }
  }

  async uploadChunk(
    vaultId: string,
    contentHash: string,
    index: number,
    chunkCount: number,
    plaintextSize: number,
    content: Uint8Array,
  ): Promise<{ received: number }> {
    const started = performance.now();
    this.chunkCalls++;
    this.chunkBytes += content.byteLength;
    this.chunkIndices.push(index);
    try {
      return await this.inner.uploadChunk(
        vaultId,
        contentHash,
        index,
        chunkCount,
        plaintextSize,
        content,
      );
    } catch (error) {
      this.recordError(error);
      throw error;
    } finally {
      this.chunkMs += performance.now() - started;
    }
  }

  async getChunkStatus(
    vaultId: string,
    contentHash: string,
  ): Promise<{ received: number; complete: boolean } | null> {
    const started = performance.now();
    this.chunkStatusCalls++;
    try {
      return await this.inner.getChunkStatus(vaultId, contentHash);
    } catch (error) {
      this.recordError(error);
      throw error;
    } finally {
      this.chunkStatusMs += performance.now() - started;
    }
  }

  async getVaultSyncIndex(vaultId: string): Promise<VaultSyncIndexResponse> {
    const started = performance.now();
    this.indexCalls++;
    try {
      const index = await this.inner.getVaultSyncIndex(vaultId);
      this.indexEntries = index.files.length;
      return index;
    } catch (error) {
      this.recordError(error);
      throw error;
    } finally {
      this.indexMs += performance.now() - started;
    }
  }

  setSessionId(sessionId: string | null): void {
    this.inner.setSessionId?.(sessionId);
  }
}

interface BenchClient {
  dir: string;
  deviceName: string;
  adapter: TimedAdapter;
  api: TimedApi;
  engine: SyncEngine;
  state: { json: string | null };
  progress: { done: number; total: number; calls: number };
  tooLarge: Array<{ plainPath: string; sizeBytes: number }>;
}

function createBenchClient(options: {
  server: Pick<TestServer, "serverUrl" | "userKey">;
  vaultId: string;
  key: CryptoKey;
  dir: string;
  deviceName: string;
  maxFileBytes?: number;
}): BenchClient {
  const scope: SyncScope = normalizeScope({
    configDir: ".obsidian",
    ...(options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes }),
  });
  const adapter = new TimedAdapter(options.dir, scope);
  const api = new TimedApi(
    createCliSyncApi({
      serverUrl: options.server.serverUrl,
      userKey: options.server.userKey,
      getDeviceName: () => options.deviceName,
    }),
  );
  const state: { json: string | null } = { json: null };
  const progress = { done: 0, total: 0, calls: 0 };
  const tooLarge: Array<{ plainPath: string; sizeBytes: number }> = [];
  const engine = new SyncEngine({
    platform: realPlatform,
    vaultId: options.vaultId,
    adapter,
    api,
    encryptionKey: options.key,
    syncScope: scope,
    onSaveState: (json) => {
      state.json = json;
    },
    onProgress: (value) => {
      progress.done = value.done;
      progress.total = value.total;
      progress.calls++;
    },
    onFileTooLarge: (event) => {
      tooLarge.push(event);
    },
  });
  return {
    dir: options.dir,
    deviceName: options.deviceName,
    adapter,
    api,
    engine,
    state,
    progress,
    tooLarge,
  };
}

interface Phase {
  label: string;
  ms: number;
  memory: { baselineMiB: MemorySnapshot; peakMiB: MemorySnapshot };
  clients: Record<string, { api: ApiSnapshot; adapter: AdapterSnapshot; progress: unknown }>;
  error: string | null;
}

async function runPhase(
  label: string,
  clients: Record<string, BenchClient>,
  fn: () => Promise<void>,
): Promise<{ phase: Phase; error: unknown | null }> {
  for (const client of Object.values(clients)) {
    client.api.reset();
    client.adapter.reset();
  }
  const monitor = new MemoryMonitor();
  monitor.start();
  const started = performance.now();
  let error: unknown | null = null;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  const ms = performance.now() - started;
  const memory = monitor.stop();
  return {
    phase: {
      label,
      ms: round(ms, 1),
      memory,
      clients: Object.fromEntries(
        Object.entries(clients).map(([name, client]) => [
          name,
          {
            api: client.api.snapshot(),
            adapter: client.adapter.snapshot(),
            progress: { ...client.progress, tooLarge: client.tooLarge.length },
          },
        ]),
      ),
      error: error === null ? null : error instanceof Error ? error.message : String(error),
    },
    error,
  };
}

/** Fail with the names of the invariants that did not hold, not just "false". */
function assertInvariants(checks: Record<string, any>): void {
  const failed = Object.entries(checks.invariants as Record<string, unknown>)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);
  assert.deepEqual(failed, [], "benchmark invariants failed");
}

async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ── fixtures and verification ───────────────────────────────────────────────

function noteBytes(index: number): Uint8Array {
  // 1–4 KiB: the shape of a normal markdown vault, varied but deterministic.
  const size = 1024 + ((Math.imul(index, 2654435761) >>> 0) % 3073);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = 32 + ((Math.imul(index, 17) + i * 31) % 95);
  const header = new TextEncoder().encode(`# note ${index}\n\n`);
  bytes.set(header.subarray(0, Math.min(header.length, size)), 0);
  return bytes;
}

/** The path of synthetic note `index`, shared by generation and the churn scenario. */
function notePath(index: number): string {
  return `folder-${index % 50}/sub-${index % 7}/note-${String(index).padStart(5, "0")}.md`;
}

function makeManyVault(root: string, count: number): { files: number; bytes: number } {
  let bytes = 0;
  const folders = new Set<string>();
  for (let index = 0; index < count; index++) {
    const relativePath = notePath(index);
    const folder = join(root, dirname(relativePath));
    if (!folders.has(folder)) {
      mkdirSync(folder, { recursive: true });
      folders.add(folder);
    }
    const content = noteBytes(index);
    writeFileSync(join(root, relativePath), content);
    bytes += content.byteLength;
  }
  return { files: count, bytes };
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function treeDigest(root: string): { files: number; bytes: number; sha256: string } {
  const files = walkFiles(root)
    .map((path) => ({ path, relative: relative(root, path).split(sep).join("/") }))
    .toSorted((left, right) => left.relative.localeCompare(right.relative));
  const digest = createHash("sha256");
  let bytes = 0;
  for (const file of files) {
    const content = readFileSync(file.path);
    bytes += content.byteLength;
    digest.update(file.relative);
    digest.update("\0");
    digest.update(String(content.byteLength));
    digest.update("\0");
    digest.update(content);
  }
  return { files: files.length, bytes, sha256: digest.digest("hex") };
}

async function fileSha256(path: string): Promise<string> {
  return await new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolveHash(hash.digest("hex")))
      .on("error", reject);
  });
}

function makeLargeTemplate(path: string, sizeBytes: number): void {
  if (existsSync(path) && statSync(path).size === sizeBytes) return;
  mkdirSync(dirname(path), { recursive: true });
  const block = Buffer.alloc(4 * 1024 * 1024);
  for (let i = 0; i < block.length; i++) block[i] = (Math.imul(i, 31) + (i >>> 8)) & 0xff;
  const fd = openSync(path, "w");
  try {
    let remaining = sizeBytes;
    while (remaining > 0) {
      const take = Math.min(block.length, remaining);
      writeSync(fd, block, 0, take);
      remaining -= take;
    }
  } finally {
    closeSync(fd);
  }
}

function readBlobHeader(path: string): ReturnType<typeof parseBlobHeader> {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(BLOB_HEADER_BYTES);
    const read = readSync(fd, header, 0, BLOB_HEADER_BYTES, 0);
    if (read !== BLOB_HEADER_BYTES) return null;
    return parseBlobHeader(new Uint8Array(header));
  } finally {
    closeSync(fd);
  }
}

function blobStats(
  server: TestServer,
  vaultId: string,
  inspectHeaders: boolean,
  contentHash?: string,
): {
  blobs: number;
  bytes: number;
  flags0: number;
  flags1: number;
  badHeaders: number;
  plaintextBytes: number;
  uploadsDir: boolean;
  stagedHashDir: boolean | null;
} {
  const dir = join(server.rootDir, "blobs", vaultId);
  const uploads = join(dir, "uploads");
  const stagedHashDir = contentHash === undefined ? null : existsSync(join(uploads, contentHash));
  if (!existsSync(dir)) {
    return {
      blobs: 0,
      bytes: 0,
      flags0: 0,
      flags1: 0,
      badHeaders: 0,
      plaintextBytes: 0,
      uploadsDir: existsSync(uploads),
      stagedHashDir,
    };
  }
  let blobs = 0;
  let bytes = 0;
  let flags0 = 0;
  let flags1 = 0;
  let badHeaders = 0;
  let plaintextBytes = 0;
  for (const path of walkFiles(dir)) {
    if (path.startsWith(uploads + sep)) continue;
    blobs++;
    bytes += statSync(path).size;
    if (!inspectHeaders) continue;
    const header = readBlobHeader(path);
    if (header === null) {
      badHeaders++;
      continue;
    }
    if (header.flags === 0) flags0++;
    else if (header.flags === 1) flags1++;
    else badHeaders++;
    plaintextBytes += header.plaintextSize;
  }
  return {
    blobs,
    bytes,
    flags0,
    flags1,
    badHeaders,
    plaintextBytes,
    uploadsDir: existsSync(uploads),
    stagedHashDir,
  };
}

async function enableWal(server: TestServer): Promise<string> {
  const db = new Database(join(server.rootDir, "courier.db"));
  try {
    db.exec("PRAGMA journal_mode = WAL");
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    return row?.journal_mode ?? "unknown";
  } finally {
    db.close();
  }
}

async function serverStats(
  server: TestServer,
  vaultId: string,
  inspectHeaders: boolean,
  contentHash?: string,
): Promise<Record<string, unknown>> {
  const history = await vaultHistory(server, vaultId);
  const versionCount = history.reduce((total, file) => total + file.versions.length, 0);
  const db = new Database(join(server.rootDir, "courier.db"));
  let rows: { versions: number; files: number } | undefined;
  let pageCount: { page_count?: number } | undefined;
  let pageSize: { page_size?: number } | undefined;
  try {
    rows = db
      .prepare(
        "SELECT COUNT(*) AS versions, COUNT(DISTINCT file_id) AS files FROM file_versions WHERE vault_id = ?",
      )
      .get(vaultId) as { versions: number; files: number } | undefined;
    pageCount = db.prepare("PRAGMA page_count").get() as { page_count?: number } | undefined;
    pageSize = db.prepare("PRAGMA page_size").get() as { page_size?: number } | undefined;
  } finally {
    db.close();
  }
  const dbPath = join(server.rootDir, "courier.db");
  return {
    historyChains: history.length,
    historyVersions: versionCount,
    dbVersions: rows?.versions ?? null,
    dbFiles: rows?.files ?? null,
    dbBytes: statSync(dbPath).size,
    dbWalBytes: existsSync(`${dbPath}-wal`) ? statSync(`${dbPath}-wal`).size : 0,
    dbPages: pageCount?.page_count ?? null,
    dbPageSize: pageSize?.page_size ?? null,
    blob: blobStats(server, vaultId, inspectHeaders, contentHash),
  };
}

async function deleteVaultQuietly(
  server: TestServer | null,
  vaultId: string | null,
): Promise<void> {
  if (server === null || vaultId === null) return;
  try {
    const response = await fetch(`${server.serverUrl}/api/vaults/${vaultId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${server.userKey}` },
    });
    if (!response.ok) {
      console.warn(`WARN vault delete answered ${response.status}: ${await response.text()}`);
    }
  } catch (error) {
    console.warn(
      `WARN vault delete failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function safeRemoveTemp(dir: string): void {
  const resolved = resolve(dir);
  if (!resolved.startsWith(resolve(TEMP_ROOT) + sep)) {
    throw new Error(`refusing to remove ${resolved}: outside ${TEMP_ROOT}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

function systemInfo(): Record<string, unknown> {
  let commit = "unknown";
  let status = "unknown";
  try {
    commit = execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    status = execFileSync("git", ["-C", REPO, "status", "--porcelain"], {
      encoding: "utf8",
    }).trim();
  } catch {
    // Git is optional metadata only.
  }
  return {
    platform: platform(),
    release: release(),
    arch: process.arch,
    // `process.version` carries the compatibility version; record the runtime that
    // actually ran the benchmark instead.
    runtime: process.versions.bun ? `bun/${process.versions.bun}` : process.version,
    userAgent: process.env.npm_config_user_agent ?? "unknown",
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    totalMemBytes: totalmem(),
    tempRoot: TEMP_ROOT,
    commit,
    dirty: status.length > 0 ? status.split("\n") : [],
  };
}

function writeResult(result: Record<string, unknown>): string {
  const path = join(RESULTS_DIR, `${SCENARIO}-${RUN_ID}.json`);
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
  return path;
}

async function runMany(
  server: TestServer,
  material: VaultMaterial,
): Promise<Record<string, unknown>> {
  const vault = await createTestVault(server, `perf-many-${RUN_ID}`, material);
  const aDir = mkdtempSync(join(TEMP_ROOT, "many-a-"));
  const bDir = mkdtempSync(join(TEMP_ROOT, "many-b-"));
  const phases: Phase[] = [];
  const checks: Record<string, any> = {};
  const startedAt = new Date().toISOString();
  try {
    const generationStarted = performance.now();
    const generated = makeManyVault(aDir, MANY_FILES);
    const generationMs = performance.now() - generationStarted;
    const source = treeDigest(aDir);
    assert.equal(source.files, MANY_FILES);

    const a = createBenchClient({
      server,
      vaultId: vault.id,
      key: material.key,
      dir: aDir,
      deviceName: "perf-a",
    });
    const b = createBenchClient({
      server,
      vaultId: vault.id,
      key: material.key,
      dir: bDir,
      deviceName: "perf-b",
    });

    const first = await runPhase("A first bind (all creates)", { A: a }, async () => {
      await a.engine.initialSync({ firstBind: true });
    });
    phases.push(first.phase);
    if (first.error) throw first.error;

    const idleA = await runPhase("A idle reconcile", { A: a }, async () => {
      await a.engine.initialSync();
    });
    phases.push(idleA.phase);
    if (idleA.error) throw idleA.error;

    const firstPull = await runPhase("B first pull (whole vault)", { B: b }, async () => {
      await b.engine.initialSync({ firstBind: true });
    });
    phases.push(firstPull.phase);
    if (firstPull.error) throw firstPull.error;

    const idleB = await runPhase("B idle reconcile", { B: b }, async () => {
      await b.engine.initialSync();
    });
    phases.push(idleB.phase);
    if (idleB.error) throw idleB.error;

    const afterInitialA = treeDigest(aDir);
    const afterInitialB = treeDigest(bDir);
    checks.initialTransfer = {
      sourceFiles: source.files,
      sourceBytes: source.bytes,
      aSha256: afterInitialA.sha256,
      bSha256: afterInitialB.sha256,
      aFiles: afterInitialA.files,
      bFiles: afterInitialB.files,
      bytesEqual: source.sha256 === afterInitialA.sha256 && source.sha256 === afterInitialB.sha256,
    };

    // 1% of the vault, written with a different size so the engine's stamp check cannot miss it.
    const changedPaths = Array.from({ length: INCREMENT_FILES }, (_, index) => {
      const fileIndex = Math.floor((index * MANY_FILES) / INCREMENT_FILES);
      return `folder-${fileIndex % 50}/sub-${fileIndex % 7}/note-${String(fileIndex).padStart(5, "0")}.md`;
    });
    const changedContents = new Map<string, Uint8Array>();
    for (const [index, path] of changedPaths.entries()) {
      const content = new TextEncoder().encode(
        `${new TextDecoder().decode(noteBytes(Number(path.match(/note-(\d+)/)?.[1] ?? index)))}\n<!-- perf edit ${RUN_ID} #${index} -->`,
      );
      changedContents.set(path, content);
      writeFileSync(join(aDir, path), content);
    }

    const incrementalA = await runPhase(
      `A incremental push (${INCREMENT_FILES} edits, host-like 4-way)`,
      { A: a },
      async () => {
        await mapLimit(changedPaths, 4, async (path) => {
          await a.engine.handleLocalChange(path);
        });
      },
    );
    phases.push(incrementalA.phase);
    if (incrementalA.error) throw incrementalA.error;

    const incrementalB = await runPhase(
      `B incremental catch-up (${INCREMENT_FILES})`,
      { B: b },
      async () => {
        await b.engine.initialSync();
      },
    );
    phases.push(incrementalB.phase);
    if (incrementalB.error) throw incrementalB.error;

    const finalA = treeDigest(aDir);
    const finalB = treeDigest(bDir);
    checks.incremental = {
      changedFiles: INCREMENT_FILES,
      aSha256: finalA.sha256,
      bSha256: finalB.sha256,
      bytesEqual: finalA.sha256 === finalB.sha256,
      changedContentsMatch: changedPaths.every((path) => {
        const expected = changedContents.get(path);
        return (
          expected !== undefined && readFileSync(join(bDir, path)).equals(Buffer.from(expected))
        );
      }),
    };

    const history = await vaultHistory(server, vault.id);
    const changedFileIds = new Set(changedPaths.map((path) => a.engine.fileIdForPath(path)));
    const changedChains = history.filter((file) => changedFileIds.has(file.fileId));
    checks.chains = {
      chains: history.length,
      changedChains: changedChains.length,
      changedVersions: changedChains.map((file) => file.versions.length),
      actions: [
        ...new Set(changedChains.flatMap((file) => file.versions.map((version) => version.action))),
      ],
      everyChangedHasTwoVersions: changedChains.every((file) => file.versions.length === 2),
    };
    checks.state = {
      aStateKiB: round((a.state.json?.length ?? 0) / 1024, 1),
      bStateKiB: round((b.state.json?.length ?? 0) / 1024, 1),
      aProgress: a.progress,
      bProgress: b.progress,
      aTooLarge: a.tooLarge.length,
      bTooLarge: b.tooLarge.length,
    };
    checks.server = await serverStats(server, vault.id, true);

    const byLabel = Object.fromEntries(phases.map((phase) => [phase.label, phase]));
    const firstPush = byLabel["A first bind (all creates)"].clients.A.api;
    const secondIdle = byLabel["A idle reconcile"].clients.A.api;
    const bPull = byLabel["B first pull (whole vault)"].clients.B.api;
    const aInc =
      byLabel[`A incremental push (${INCREMENT_FILES} edits, host-like 4-way)`].clients.A.api;
    const bInc = byLabel[`B incremental catch-up (${INCREMENT_FILES})`].clients.B.api;
    checks.expectations = {
      firstBindPushRequests: firstPush.pushCalls,
      firstBindPushedFiles: firstPush.pushedFiles,
      firstBindChunkedFiles: firstPush.chunkedFiles,
      idlePushRequests: secondIdle.pushCalls,
      idleContentRequests: secondIdle.contentCalls,
      idleIndexRequests: secondIdle.indexCalls,
      idleReadCalls: byLabel["A idle reconcile"].clients.A.adapter.readCalls,
      idleStatCalls: byLabel["A idle reconcile"].clients.A.adapter.statCalls,
      bPullContentRequests: bPull.contentCalls,
      bPullRangeRequests: bPull.rangeCalls,
      incrementalPushFiles: aInc.pushedFiles,
      incrementalPushRequests: aInc.pushCalls,
      incrementalPullRequests: aInc.pullCalls,
      bIncrementalContentRequests: bInc.contentCalls,
      bIncrementalWriteCalls:
        byLabel[`B incremental catch-up (${INCREMENT_FILES})`].clients.B.adapter.writeCalls,
      bIncrementalRangeRequests: bInc.rangeCalls,
    };
    assert.equal(firstPush.pushedFiles, MANY_FILES);
    assert.equal(firstPush.chunkedFiles, 0);
    assert.equal(secondIdle.pushCalls, 0);
    assert.equal(secondIdle.contentCalls, 0);
    assert.equal(byLabel["A idle reconcile"].clients.A.adapter.readCalls, 0);
    assert.equal(bPull.contentCalls, MANY_FILES);
    assert.equal(bPull.chunkedFiles, 0);
    assert.equal(aInc.pushedFiles, INCREMENT_FILES);
    assert.equal(bInc.contentCalls, INCREMENT_FILES);
    assert.equal(finalA.sha256, finalB.sha256);
    assert.ok(checks.incremental.changedContentsMatch);
    assert.ok(checks.chains.everyChangedHasTwoVersions);

    checks.invariants = {
      bytesEqual: checks.initialTransfer.bytesEqual && checks.incremental.bytesEqual,
      everyFileLanded: finalB.files === MANY_FILES,
      everyChangedHasTwoVersions: checks.chains.everyChangedHasTwoVersions,
      idleReadsNothing:
        byLabel["A idle reconcile"].clients.A.adapter.readCalls === 0 &&
        byLabel["B idle reconcile"].clients.B.adapter.readCalls === 0,
      idlePushesNothing: secondIdle.pushCalls === 0 && secondIdle.contentCalls === 0,
      oneContentRequestPerPulledFile: bPull.contentCalls === MANY_FILES,
    };
    assertInvariants(checks);

    return {
      scenario: "many",
      runId: RUN_ID,
      startedAt,
      finishedAt: new Date().toISOString(),
      generation: {
        files: generated.files,
        bytes: generated.bytes,
        generationMs: round(generationMs, 1),
      },
      scenarioConfig: {
        files: MANY_FILES,
        minFileBytes: 1024,
        generatedMaxFileBytes: 4096,
        totalBytes: generated.bytes,
        incrementFiles: INCREMENT_FILES,
        incrementPercent: 1,
        productDefaultMaxFileBytes: 50 * 1024 * 1024,
        deviceConcurrency: 4,
      },
      phases,
      checks,
      errors: null,
    };
  } finally {
    safeRemoveTemp(aDir);
    safeRemoveTemp(bDir);
    await deleteVaultQuietly(server, vault.id);
  }
}

async function runLarge(
  server: TestServer,
  material: VaultMaterial,
): Promise<Record<string, unknown>> {
  assert.ok(
    LARGE_BYTES > 8 * 1024 * 1024,
    "large scenario must be above the 8 MiB chunk threshold",
  );
  await patchTestUser(server, { maxFileBytes: LARGE_CAP });
  const vault = await createTestVault(server, `perf-large-${RUN_ID}`, material);
  const aDir = mkdtempSync(join(TEMP_ROOT, "large-a-"));
  const bDir = mkdtempSync(join(TEMP_ROOT, "large-b-"));
  const template = join(TEMP_ROOT, "large-template.mp4");
  const phases: Phase[] = [];
  const checks: Record<string, any> = {};
  const startedAt = new Date().toISOString();
  try {
    makeLargeTemplate(template, LARGE_BYTES);
    const sourceHash = await fileSha256(template);
    mkdirSync(join(aDir, "media"), { recursive: true });
    const copyStarted = performance.now();
    copyFileSync(template, join(aDir, LARGE_PATH));
    const copyMs = performance.now() - copyStarted;
    assert.equal(statSync(join(aDir, LARGE_PATH)).size, LARGE_BYTES);

    const a = createBenchClient({
      server,
      vaultId: vault.id,
      key: material.key,
      dir: aDir,
      deviceName: "perf-large-a",
      maxFileBytes: LARGE_CAP,
    });
    const b = createBenchClient({
      server,
      vaultId: vault.id,
      key: material.key,
      dir: bDir,
      deviceName: "perf-large-b",
      maxFileBytes: LARGE_CAP,
    });

    const push = await runPhase(`A push ${LARGE_MIB} MiB (chunked upload)`, { A: a }, async () => {
      await a.engine.initialSync({ firstBind: true });
    });
    phases.push(push.phase);
    if (push.error) throw push.error;

    const fileId = a.engine.fileIdForPath(LARGE_PATH);
    assert.ok(fileId, "large file has no fileId after push");
    const versions = await fileVersions(server, vault.id, fileId);
    const head = versions.at(-1);
    assert.ok(head, "large file has no head version");
    // Loaded after the server started: the store opens the database on import, and the
    // harness points `SQLITE_PATH` / `BLOB_STORE_DIR` at this run's temp directory.
    const store = await import("../../../server/src/lib/blob-store");
    const location = await store.blobLocation(vault.id, head.contentHash);
    assert.ok(location, "large file has no stored blob");
    const frame = readFileSync(location.filePath).subarray(
      location.offset,
      location.offset + location.length,
    );
    const blobSize = frame.byteLength;
    const blobHeader = parseBlobHeader(new Uint8Array(frame.subarray(0, BLOB_HEADER_BYTES)));
    const expectedBlobSize =
      LARGE_BYTES + 28 * Math.ceil(LARGE_BYTES / CHUNK_PLAINTEXT_BYTES) + BLOB_HEADER_BYTES;
    assert.equal(blobSize, expectedBlobSize);
    assert.equal(blobHeader?.flags, 1);
    assert.equal(blobHeader?.chunkSize, CHUNK_PLAINTEXT_BYTES);
    assert.equal(blobHeader?.chunkCount, Math.ceil(LARGE_BYTES / CHUNK_PLAINTEXT_BYTES));
    assert.equal(blobHeader?.plaintextSize, LARGE_BYTES);
    checks.upload = {
      pushCalls: a.api.pushCalls,
      pushedContentBytes: a.api.pushedBytes,
      chunkedFiles: a.api.chunkedFiles,
      chunkCalls: a.api.chunkCalls,
      chunkBytes: a.api.chunkBytes,
      chunkIndicesFirstLast: [a.api.chunkIndices[0], a.api.chunkIndices.at(-1)],
      chunkIndicesSequential: a.api.chunkIndices.every((value, index) => value === index),
      versionId: head.versionId,
      contentHash: head.contentHash,
      action: head.action,
      blobBytes: blobSize,
      blobHeader,
      stagedHashDir: blobStats(server, vault.id, false, head.contentHash).stagedHashDir,
    };

    const pull = await runPhase(`B pull ${LARGE_MIB} MiB (chunked ranges)`, { B: b }, async () => {
      await b.engine.initialSync({ firstBind: true });
    });
    phases.push(pull.phase);
    if (pull.error) throw pull.error;

    const pulledHash = await fileSha256(join(bDir, LARGE_PATH));
    checks.pull = {
      rangeCalls: b.api.rangeCalls,
      rangeBytes: b.api.rangeBytes,
      contentCalls: b.api.contentCalls,
      writeCalls: b.adapter.writeCalls,
      writeBytes: b.adapter.writeBytes,
      streamCalls: b.adapter.streamCalls,
      streamChunks: b.adapter.streamChunks,
      streamBytes: b.adapter.streamBytes,
      pulledHash,
      sourceHash,
      bytesEqual: pulledHash === sourceHash,
    };
    checks.server = await serverStats(server, vault.id, true, head.contentHash);
    checks.state = {
      aStateKiB: round((a.state.json?.length ?? 0) / 1024, 1),
      bStateKiB: round((b.state.json?.length ?? 0) / 1024, 1),
      aProgress: a.progress,
      bProgress: b.progress,
      aTooLarge: a.tooLarge.length,
      bTooLarge: b.tooLarge.length,
    };
    assert.equal(a.api.pushCalls, 1);
    assert.equal(a.api.pushedBytes, 0);
    assert.equal(a.api.chunkCalls, Math.ceil(LARGE_BYTES / CHUNK_PLAINTEXT_BYTES));
    assert.ok(checks.upload.chunkIndicesSequential);
    assert.equal(b.api.contentCalls, 0);
    assert.equal(b.api.rangeCalls, Math.ceil(LARGE_BYTES / CHUNK_PLAINTEXT_BYTES));
    // One logical write: a large download is streamed chunk by chunk into a temporary
    // file and renamed once, so no whole-file write and no whole-file buffer.
    assert.equal(b.adapter.writeCalls, 0);
    assert.equal(b.adapter.streamCalls, 1);
    assert.equal(b.adapter.streamChunks, Math.ceil(LARGE_BYTES / CHUNK_PLAINTEXT_BYTES));
    assert.equal(b.adapter.streamBytes, LARGE_BYTES);
    assert.equal(pulledHash, sourceHash);

    const pushPhase = phases[0];
    const pullPhase = phases[1];
    const pushApi = pushPhase.clients.A.api;
    const pullApi = pullPhase.clients.B.api;
    const pushAdapter = pushPhase.clients.A.adapter;
    const pullAdapter = pullPhase.clients.B.adapter;
    checks.derived = {
      pushMs: pushPhase.ms,
      pushReadMs: pushAdapter.readMs,
      pushChunkUploadMs: pushApi.chunkMs,
      pushFinalRequestMs: pushApi.pushMs,
      pushOtherMs: round(pushPhase.ms - pushAdapter.readMs - pushApi.chunkMs - pushApi.pushMs, 1),
      pullMs: pullPhase.ms,
      pullRangeMs: pullApi.rangeMs,
      pullWriteMs: pullAdapter.writeMs,
      pullStreamChunkMs: pullAdapter.streamMs,
      pullStreamCloseMs: pullAdapter.streamCloseMs,
      pullOtherMs: round(
        pullPhase.ms -
          pullApi.rangeMs -
          pullAdapter.writeMs -
          pullAdapter.streamMs -
          pullAdapter.streamCloseMs,
        1,
      ),
    };

    checks.invariants = {
      bytesEqual: pulledHash === sourceHash,
      chunkedEncoding:
        blobHeader?.flags === 1 &&
        blobHeader.chunkCount === Math.ceil(LARGE_BYTES / CHUNK_PLAINTEXT_BYTES) &&
        blobHeader.plaintextSize === LARGE_BYTES,
      chunkIndicesSequential: checks.upload.chunkIndicesSequential,
      pushBodyEmpty: a.api.pushedBytes === 0,
      pullStreamsOneWrite: b.adapter.writeCalls === 0 && b.adapter.streamCalls === 1,
      pullStreamsEveryChunk:
        b.adapter.streamChunks === Math.ceil(LARGE_BYTES / CHUNK_PLAINTEXT_BYTES) &&
        b.adapter.streamBytes === LARGE_BYTES,
    };
    assertInvariants(checks);

    return {
      scenario: "large",
      runId: RUN_ID,
      startedAt,
      finishedAt: new Date().toISOString(),
      copyMs: round(copyMs, 1),
      scenarioConfig: {
        plaintextBytes: LARGE_BYTES,
        plaintextMiB: LARGE_MIB,
        chunkPlaintextBytes: CHUNK_PLAINTEXT_BYTES,
        chunkCount: Math.ceil(LARGE_BYTES / CHUNK_PLAINTEXT_BYTES),
        chunkedTransferThreshold: 8 * 1024 * 1024,
        accountMaxFileBytes: LARGE_CAP,
        productDefaultMaxFileBytes: 50 * 1024 * 1024,
        serverMaxPushBodyBytes: 256 * 1024 * 1024,
        serverMaxChunkBodyBytes: 8 * 1024 * 1024,
      },
      phases,
      checks,
      errors: null,
    };
  } finally {
    safeRemoveTemp(aDir);
    safeRemoveTemp(bDir);
    await deleteVaultQuietly(server, vault.id);
  }
}

/**
 * Moves and tombstones: rename 10% and delete 10% of a bound vault, then let the
 * peer follow.
 *
 * This is the identity path the other two scenarios never touch: a rename must
 * keep its `fileId` and send no content, a delete must end the chain with a
 * tombstone, and the peer must apply both without re-uploading anything. It is
 * also the only scenario that grows the server's recycle bin.
 */
async function runChurn(
  server: TestServer,
  material: VaultMaterial,
): Promise<Record<string, unknown>> {
  const vault = await createTestVault(server, `perf-churn-${RUN_ID}`, material);
  const aDir = mkdtempSync(join(TEMP_ROOT, "churn-a-"));
  const bDir = mkdtempSync(join(TEMP_ROOT, "churn-b-"));
  const phases: Phase[] = [];
  const checks: Record<string, any> = {};
  const startedAt = new Date().toISOString();
  try {
    const generationStarted = performance.now();
    const generated = makeManyVault(aDir, CHURN_FILES);
    const generationMs = performance.now() - generationStarted;
    const source = treeDigest(aDir);
    assert.equal(source.files, CHURN_FILES);

    const a = createBenchClient({
      server,
      vaultId: vault.id,
      key: material.key,
      dir: aDir,
      deviceName: "perf-churn-a",
    });
    const b = createBenchClient({
      server,
      vaultId: vault.id,
      key: material.key,
      dir: bDir,
      deviceName: "perf-churn-b",
    });

    const bind = await runPhase("A first bind (all creates)", { A: a }, async () => {
      await a.engine.initialSync({ firstBind: true });
    });
    phases.push(bind.phase);
    if (bind.error) throw bind.error;

    const pull = await runPhase("B first pull (whole vault)", { B: b }, async () => {
      await b.engine.initialSync({ firstBind: true });
    });
    phases.push(pull.phase);
    if (pull.error) throw pull.error;

    const renamed = Array.from({ length: RENAME_FILES }, (_, index) => ({
      from: notePath(index),
      to: `moved/note-${String(index).padStart(5, "0")}.md`,
      fileId: a.engine.fileIdForPath(notePath(index)),
    }));
    const deleted = Array.from({ length: DELETE_FILES }, (_, index) => {
      const path = notePath(RENAME_FILES + index);
      return { path, fileId: a.engine.fileIdForPath(path) };
    });
    assert.ok(renamed.every((entry) => entry.fileId !== undefined));
    assert.ok(deleted.every((entry) => entry.fileId !== undefined));

    // A host reports a move as one rename event, and the disk has already moved.
    // The same 4-way bound the plugin and CLI use bounds these events.
    const churn = await runPhase(
      `A rename ${RENAME_FILES} + delete ${DELETE_FILES}`,
      { A: a },
      async () => {
        await mapLimit(renamed, 4, async (entry) => {
          mkdirSync(dirname(join(aDir, entry.to)), { recursive: true });
          renameSync(join(aDir, entry.from), join(aDir, entry.to));
          await a.engine.handleLocalRename(entry.from, entry.to);
        });
        await mapLimit(deleted, 4, async (entry) => {
          rmSync(join(aDir, entry.path), { force: true });
          await a.engine.handleLocalDelete(entry.path);
        });
      },
    );
    phases.push(churn.phase);
    if (churn.error) throw churn.error;

    const catchUp = await runPhase("B applies moves and tombstones", { B: b }, async () => {
      await b.engine.initialSync();
    });
    phases.push(catchUp.phase);
    if (catchUp.error) throw catchUp.error;

    const idle = await runPhase("A idle reconcile", { A: a }, async () => {
      await a.engine.initialSync();
    });
    phases.push(idle.phase);
    if (idle.error) throw idle.error;

    const finalA = treeDigest(aDir);
    const finalB = treeDigest(bDir);
    const history = await vaultHistory(server, vault.id);
    const bin = await deletedFiles(server, vault.id);
    const byId = new Map(history.map((file) => [file.fileId, file]));
    const pathsById = new Map<string, string>();
    for (const file of history) {
      try {
        pathsById.set(file.fileId, await decryptString(material.key, file.encryptedPath));
      } catch {
        // A path encrypted under another key is not this vault's.
      }
    }

    checks.initialTransfer = {
      sourceFiles: source.files,
      sourceBytes: source.bytes,
      aFiles: finalA.files,
      bFiles: finalB.files,
      aSha256: finalA.sha256,
      bSha256: finalB.sha256,
      bytesEqual: finalA.sha256 === finalB.sha256,
    };
    checks.renames = {
      renamed: RENAME_FILES,
      keptFileId: renamed.filter((entry) => a.engine.fileIdForPath(entry.to) === entry.fileId)
        .length,
      bytesReused: renamed.filter((entry) => {
        const versions = byId.get(entry.fileId ?? "")?.versions ?? [];
        return versions.length === 2 && versions[0]?.contentHash === versions[1]?.contentHash;
      }).length,
      currentPathMatches: renamed.filter((entry) => pathsById.get(entry.fileId ?? "") === entry.to)
        .length,
    };
    checks.deletes = {
      deleted: DELETE_FILES,
      tombstoned: deleted.filter(
        (entry) => byId.get(entry.fileId ?? "")?.versions.at(-1)?.action === "delete",
      ).length,
      // A local delete keeps the path → chain mapping on purpose: the tombstone is
      // this device's sync point, so a file created there again is pushed as a
      // `restore` on the same chain rather than forking a second identity.
      stillMappedForRecreate: deleted.filter(
        (entry) => a.engine.fileIdForPath(entry.path) !== undefined,
      ).length,
      recycleBin: bin.length,
    };
    checks.peer = {
      contentCalls: catchUp.phase.clients.B.api.contentCalls,
      rangeCalls: catchUp.phase.clients.B.api.rangeCalls,
      writeCalls: catchUp.phase.clients.B.adapter.writeCalls,
      renameCalls: catchUp.phase.clients.B.adapter.renameCalls,
      deleteCalls: catchUp.phase.clients.B.adapter.deleteCalls,
    };
    checks.expectations = {
      chains: history.length,
      churnPushRequests: churn.phase.clients.A.api.pushCalls,
      churnPayloadBytes: churn.phase.clients.A.api.pushedBytes,
      idlePushRequests: idle.phase.clients.A.api.pushCalls,
      idleReadCalls: idle.phase.clients.A.adapter.readCalls,
    };
    checks.invariants = {
      bytesEqual: finalA.sha256 === finalB.sha256,
      filesLanded: finalA.files === CHURN_FILES - DELETE_FILES && finalB.files === finalA.files,
      chainsStable: history.length === CHURN_FILES,
      everyRenameKeepsItsFileId: checks.renames.keptFileId === RENAME_FILES,
      everyRenameReusesItsBytes: checks.renames.bytesReused === RENAME_FILES,
      everyRenameMovedItsPath: checks.renames.currentPathMatches === RENAME_FILES,
      everyDeleteIsATombstone: checks.deletes.tombstoned === DELETE_FILES,
      everyDeletedPathStaysClaimable:
        checks.deletes.stillMappedForRecreate === DELETE_FILES &&
        checks.deletes.recycleBin === DELETE_FILES,
      movesTransferNothing: churn.phase.clients.A.api.pushedBytes === 0,
      peerAppliesMovesWithoutContent:
        checks.peer.contentCalls === 0 &&
        checks.peer.rangeCalls === 0 &&
        checks.peer.writeCalls === 0 &&
        checks.peer.renameCalls === RENAME_FILES &&
        checks.peer.deleteCalls === DELETE_FILES,
      idleReadsNothing: idle.phase.clients.A.adapter.readCalls === 0,
    };
    assertInvariants(checks);

    return {
      scenario: "churn",
      runId: RUN_ID,
      startedAt,
      finishedAt: new Date().toISOString(),
      generation: {
        files: generated.files,
        bytes: generated.bytes,
        generationMs: round(generationMs, 1),
      },
      scenarioConfig: {
        files: CHURN_FILES,
        renamed: RENAME_FILES,
        deleted: DELETE_FILES,
        churnPercent: 10,
        deviceConcurrency: 4,
      },
      phases,
      checks,
      errors: null,
    };
  } finally {
    safeRemoveTemp(aDir);
    safeRemoveTemp(bDir);
    await deleteVaultQuietly(server, vault.id);
  }
}

it.skipIf(!enabled)(
  `bench ${SCENARIO} ${RUN_ID}`,
  async () => {
    const result: Record<string, unknown> = {
      scenario: SCENARIO,
      runId: RUN_ID,
      system: systemInfo(),
      driver: {
        scenario: SCENARIO,
        manyFiles: MANY_FILES,
        incrementFiles: INCREMENT_FILES,
        churnFiles: CHURN_FILES,
        renameFiles: RENAME_FILES,
        deleteFiles: DELETE_FILES,
        largeMiB: LARGE_MIB,
        largeBytes: LARGE_BYTES,
        largeCap: LARGE_CAP,
      },
    };
    let server: TestServer | null = null;
    let vaultId: string | null = null;
    let material: VaultMaterial | null = null;
    let scenarioResult: Record<string, unknown> | null = null;
    try {
      server = await startTestServer(`perf ${SCENARIO} ${RUN_ID}`);
      vaultId = null;
      result.journalMode = await enableWal(server);
      material = await makeVaultMaterial();
      scenarioResult =
        SCENARIO === "large"
          ? await runLarge(server, material)
          : SCENARIO === "churn"
            ? await runChurn(server, material)
            : await runMany(server, material);
      Object.assign(result, scenarioResult);
      result.ok = true;
    } catch (error) {
      result.ok = false;
      result.failure =
        error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
      throw error;
    } finally {
      result.finishedAt = new Date().toISOString();
      const path = writeResult(result);
      console.log(`BENCH_RESULT ${path}`);
      if (server !== null) {
        // runMany/runLarge/runChurn already delete their vault; this is only a backstop.
        if (vaultId !== null) await deleteVaultQuietly(server, vaultId);
        try {
          await server.close();
        } catch (error) {
          console.warn(
            `WARN server close failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      void material;
      await sleep(50);
    }
  },
  3_600_000,
);
