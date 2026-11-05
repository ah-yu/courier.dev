/**
 * Research benchmark: the **production** limits a first bind meets.
 *
 * The e2e harness raises the sync rate limiter to 20 000 requests/min on purpose
 * (two real Obsidian instances burst past the deployed allowance), so the other
 * benchmark file can never show what a deployed service does. This one boots the
 * same real server **without** those overrides, so `syncRateLimitOptions()` and
 * `syncTransferRateLimitOptions()` answer their defaults (600/min and 60 000/min).
 *
 * It measures three things:
 *  1. the server's marginal cost per file (blob write + conditional insert),
 *  2. where each limiter actually trips,
 *  3. what a bind of more files than one window allows does end to end.
 *
 * ```bash
 * COURIER_BENCH=1 bun --bun vitest run packages/e2e/src/research/first-bind-limits.bench.test.ts
 * ```
 */
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { removeDirWithRetry } from "@courier/testing";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createTestVault, makeVaultMaterial, type VaultMaterial } from "../harness/vault";
import { pushFilesRaw } from "../harness/api";
import { runMigrations } from "../../../server/src/db/migrations";
import { sha256Hex, sha256Text } from "../../../engine/src/index";
import { makeVault, report, runEngine } from "./timing";

const enabled = process.env.COURIER_BENCH === "1";
const BIG_FILES = Number(process.env.COURIER_BENCH_FILES ?? "12500");
/** The host key the schema seeds, so a user can be created over HTTP. */
const HOST_KEY = "ak_bench_host_key";

interface BenchServer {
  serverUrl: string;
  userKey: string;
  userId: string;
  rootDir: string;
  close: () => Promise<void>;
}

/**
 * Boot the real server with **production defaults**.
 *
 * The harness's `startTestServer` sets `SYNC_RATE_LIMIT_MAX_ATTEMPTS=20000` before
 * importing the server; this one deliberately does not, so the limiters answer
 * their configured defaults. Everything else (migrations, routes, ws, blob store)
 * is the same code path.
 */
async function startDefaultServer(name: string): Promise<BenchServer> {
  const rootDir = mkdtempSync(join(tmpdir(), "courier-bench-limits-"));
  const sqlitePath = join(rootDir, "courier.db");
  mkdirSync(join(rootDir, "blobs"), { recursive: true });
  const schema = new Database(sqlitePath);
  try {
    // The deployed shape: `courier migrate` puts the database in WAL mode before it
    // applies the chain (`packages/server/src/commands/migrate.ts`).
    schema.exec("PRAGMA journal_mode = WAL");
    schema.exec("PRAGMA foreign_keys = ON");
    runMigrations(schema);
    schema
      .prepare("INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)")
      .run("bench-host-key", "bench host key", HOST_KEY);
  } finally {
    schema.close();
  }

  // Port 0: the listener asks the OS for a free port itself. Probing one and binding it
  // afterwards leaves a window for another process to take it (see the e2e harness).
  process.env.SQLITE_PATH = sqlitePath;
  process.env.BLOB_STORE_DIR = join(rootDir, "blobs");
  process.env.PORT = "0";
  delete process.env.SYNC_RATE_LIMIT_MAX_ATTEMPTS;
  delete process.env.SYNC_RATE_LIMIT_WINDOW_MS;
  delete process.env.SYNC_TRANSFER_RATE_LIMIT_MAX_ATTEMPTS;
  delete process.env.SYNC_TRANSFER_RATE_LIMIT_WINDOW_MS;

  const { startServer } = await import("../../../server/src/commands/start");
  const started = startServer({ port: "0" });
  const server = await started.ready;
  const port = server.port;
  if (!port) throw new Error("the bench listener did not report a port");

  const serverUrl = `http://127.0.0.1:${port}`;
  const response = await fetch(`${serverUrl}/api/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${HOST_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, maxVaults: 0 }),
  });
  if (!response.ok) throw new Error(`create user: ${response.status} ${await response.text()}`);
  const user = (await response.json()) as { id: string; key: string };

  return {
    serverUrl,
    userKey: user.key,
    userId: user.id,
    rootDir,
    close: async () => {
      await started.stop();
      const { closeDb } = await import("../../../server/src/db/index");
      closeDb();
      await removeDirWithRetry(rootDir);
    },
  };
}

/** Time one `pushFilesRaw` batch. */
async function timedPush(
  server: BenchServer,
  vaultId: string,
  files: Parameters<typeof pushFilesRaw>[2],
): Promise<number> {
  const started = performance.now();
  const results = await pushFilesRaw(server, vaultId, files);
  const elapsed = performance.now() - started;
  const refused = results.filter((result) => result.status !== "ok");
  if (refused.length > 0) {
    throw new Error(`${refused.length} of ${files.length} files refused: ${refused[0]?.status}`);
  }
  return elapsed;
}

/**
 * Build `count` raw push entries, all `create`, sharing one stored payload.
 *
 * The wire carries the **ciphertext** (`iv ‖ plaintext ‖ tag`), so the content is the
 * plaintext plus 28 bytes and `sizeBytes` states the plaintext size — the route
 * refuses anything else as `size_mismatch`.
 */
function rawCreates(count: number, tag: string, content: Uint8Array, contentHash: string) {
  const stored = new Uint8Array(content.byteLength + 28);
  stored.set(content, 12);
  return Array.from({ length: count }, (_, index) => ({
    fileId: `bench-${tag}-${index}`,
    encryptedPath: `enc-${tag}-${index}`,
    versionId: `ver-${tag}-${index}`,
    contentHash,
    sizeBytes: content.byteLength,
    mtimeMs: 1_700_000_000_000,
    action: "create" as const,
    content: stored,
    baseVersionId: null,
  }));
}

describe.skipIf(!enabled)("research — deployed limits and per-file server cost", () => {
  let server: BenchServer;
  let material: VaultMaterial;
  const dirs: string[] = [];

  beforeAll(async () => {
    server = await startDefaultServer("bench limits user");
    material = await makeVaultMaterial();
  }, 300_000);

  afterAll(async () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await server.close();
  }, 120_000);

  it("measures the server's marginal cost per file", async () => {
    const vault = await createTestVault(server, "server-cost", material);
    const unique = new Uint8Array(2048).fill(1);
    const uniqueHash = await sha256Hex(unique);
    const shared = new Uint8Array(2048).fill(2);
    const sharedHash = await sha256Hex(shared);

    // 100 distinct blobs: the full cost (blob write + fsync + insert commit).
    const createsUnique = await timedPush(
      server,
      vault.id,
      rawCreates(100, "unique", unique, uniqueHash),
    );
    // 100 files sharing one blob: only the inserts are left.
    const createsShared = await timedPush(
      server,
      vault.id,
      rawCreates(100, "shared", shared, sharedHash),
    );
    // 100 tombstones: inserts only, no blob at all.
    const emptyHash = await sha256Text("");
    const deletes = await timedPush(
      server,
      vault.id,
      Array.from({ length: 100 }, (_, index) => ({
        fileId: `bench-unique-${index}`,
        encryptedPath: `enc-delete-${index}`,
        versionId: `ver-delete-${index}`,
        contentHash: emptyHash,
        sizeBytes: 0,
        mtimeMs: 1_700_000_000_000,
        action: "delete" as const,
        content: null,
        baseVersionId: `ver-unique-${index}`,
      })),
    );

    console.log(
      `BENCH ${JSON.stringify({
        label: "server marginal cost per 100-file batch",
        journal: "delete",
        distinctBlobsMs: Math.round(createsUnique),
        sharedBlobMs: Math.round(createsShared),
        tombstonesMs: Math.round(deletes),
        perFileMs: Number((createsUnique / 100).toFixed(2)),
      })}`,
    );
  }, 300_000);

  it("finds where the deployed rate limits trip", async () => {
    const vault = await createTestVault(server, "rate-limits", material);
    // One stored blob, so the content route has something to answer.
    const content = new Uint8Array(16).fill(3);
    await pushFilesRaw(server, vault.id, rawCreates(1, "probe", content, await sha256Hex(content)));
    const headers = { Authorization: `Bearer ${server.userKey}` };

    let firstIndexRefusal = 0;
    for (let index = 1; index <= 650; index++) {
      const response = await fetch(`${server.serverUrl}/api/vaults/${vault.id}/sync/index`, {
        headers,
      });
      if (response.status !== 200 && firstIndexRefusal === 0) {
        firstIndexRefusal = index;
        console.log(
          `BENCH ${JSON.stringify({
            label: "sync limiter (index requests)",
            firstRefusalAt: index,
            status: response.status,
            retryAfter: response.headers.get("retry-after"),
            body: (await response.text()).slice(0, 160),
          })}`,
        );
        break;
      }
    }

    // The transfer budget is now 60 000/min, so a 2 100-request probe stays inside it:
    // the point of this line is that a first download is no longer cut off at 2 000
    // files, and the allowed value is pinned by `rate-limit.test.ts`.
    const contentHash = await sha256Hex(content);
    let firstContentRefusal = 0;
    for (let index = 1; index <= 2100; index++) {
      const response = await fetch(
        `${server.serverUrl}/api/vaults/${vault.id}/sync/versions/${contentHash}/content`,
        { method: "HEAD", headers },
      );
      if (response.status !== 200) {
        firstContentRefusal = index;
        break;
      }
    }
    console.log(
      `BENCH ${JSON.stringify({
        label: "rate limits",
        indexRefusalAt: firstIndexRefusal,
        contentRefusalAt: firstContentRefusal,
      })}`,
    );
  }, 300_000);

  it("binds more local files than one rate-limit window allows", async () => {
    const vault = await createTestVault(server, "big-bind", material);
    const dir = mkdtempSync(join(tmpdir(), "courier-bench-limits-upload-"));
    dirs.push(dir);
    const bytes = makeVault(dir, BIG_FILES);

    const first = await runEngine("big upload bind (one window)", {
      dir,
      server,
      vaultId: vault.id,
      key: material.key,
      files: BIG_FILES + 1,
      bytes,
      firstBind: true,
    });
    report(first, "wal");
    const entries = Object.values(
      JSON.parse(first.state.json ?? "{}") as Record<string, { lastKnownVersionId: string | null }>,
    );
    console.log(
      `BENCH ${JSON.stringify({
        label: "big bind progress",
        files: BIG_FILES + 1,
        pushedRequests: first.api.pushCalls,
        pushSizes: first.api.pushSizes.length,
        pushErrors: first.api.pushErrors,
        stateEntries: entries.length,
        stateEntriesWithoutVersion: entries.filter((e) => e.lastKnownVersionId === null).length,
        stateKiB: Math.round(first.stateJsonBytes / 1024),
        error: first.error,
        lastError: first.api.lastError,
      })}`,
    );

    // A failed bind is retried by the next periodic reconcile — five minutes in
    // the plugin. Wait out the rate-limit window instead (60 s) and run the pass
    // the next reconcile would run, to measure what that retry costs.
    await new Promise((resolve) => setTimeout(resolve, 65_000));
    const retry = await runEngine("big upload bind (next window)", {
      dir,
      server,
      vaultId: vault.id,
      key: material.key,
      files: BIG_FILES + 1,
      bytes,
      firstBind: true,
      previous: first,
    });
    report(retry);
  }, 900_000);
});
