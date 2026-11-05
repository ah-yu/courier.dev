import { mkdirSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { removeDirWithRetry } from "@courier/testing";
import { Database } from "bun:sqlite";
import { runMigrations } from "../../../server/src/db/migrations";

/**
 * Boots the **real** Courier server in-process against a throwaway SQLite
 * database and blob store, then hands out the URLs + credentials the tests
 * need. Nothing is mocked: migrations, Hono routes, the WebSocket server,
 * drizzle/bun:sqlite and the blob store are the production code paths.
 *
 * The server reads `SQLITE_PATH` / `BLOB_STORE_DIR` from `process.env` at
 * import time (`packages/server/src/config.ts`), so the env must be set
 * *before* the dynamic imports below — and the schema must exist before the
 * server opens the database.
 */

/** Host (admin) key seeded into the fresh database so tests can create users. */
export const TEST_HOST_KEY = "ak_e2e_host_key";

export interface TestServer {
  /** `http://127.0.0.1:<port>` — the real listening base URL. */
  serverUrl: string;
  /** `ws://127.0.0.1:<port>` — the same server's WebSocket endpoint. */
  wsUrl: string;
  /** User key (`ck_...`) created over the real `POST /api/users` route. */
  userKey: string;
  /** User id of the created user. */
  userId: string;
  /** Host key seeded into `api_keys`. */
  hostKey: string;
  /** The throwaway directory holding the SQLite file and blobs. */
  rootDir: string;
  /**
   * Drop every live WebSocket without touching the server — what a network blip
   * looks like to a client. The client's own reconnect logic takes it from there,
   * so this is how "the connection went away for a moment" is reproduced.
   */
  dropSockets: () => void;
  /** Stop the HTTP + WebSocket server and remove the temp directory. */
  close: () => Promise<void>;
}

/**
 * Give a fresh database the production schema.
 *
 * The harness runs the server's own `runMigrations`, not a copy of it: a test
 * database is migrated exactly like a deployed one — same chain, same
 * `courier_migrations` ledger — which is also what keeps the two from drifting.
 */
function applySchema(sqlitePath: string): void {
  const sqlite = new Database(sqlitePath);
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    runMigrations(sqlite);
    sqlite
      .prepare("INSERT INTO api_keys (id, name, key) VALUES (?, ?, ?)")
      .run("e2e-host-key", "e2e host key", TEST_HOST_KEY);
  } finally {
    sqlite.close();
  }
}

/** Create a user over the real HTTP API and return its credentials. */
async function createTestUser(serverUrl: string, name: string) {
  const response = await fetch(`${serverUrl}/api/users`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TEST_HOST_KEY}`,
      "Content-Type": "application/json",
    },
    // The harness account is a fixture for suites that create several vaults
    // (a describe block may create one per case), so it gets no vault allowance
    // at all. Tests about the allowance itself create their own accounts.
    body: JSON.stringify({ name, maxVaults: 0 }),
  });
  if (!response.ok) {
    throw new Error(`Failed to create test user: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { id: string; key: string };
}

/** The administrator-writable user fields the e2e suites change. */
export interface TestUserPatch {
  maxFileBytes?: number;
  maxVaults?: number;
  storageBytesLimit?: number | null;
  expiresAt?: string | null;
  disabled?: boolean;
}

/**
 * Change the test user's limits the way an administrator does.
 *
 * The plugin reads these from `GET /api/me`, so a case that needs a capped account or a
 * key expiry sets them on the server before the host starts (or before the status menu
 * reads them).
 */
export async function patchTestUser(server: TestServer, patch: TestUserPatch): Promise<void> {
  const response = await fetch(`${server.serverUrl}/api/users/${server.userId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${server.hostKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(`Failed to patch the test user: ${response.status} ${await response.text()}`);
  }
}

/**
 * Change the test user's per-key file cap, the way an administrator does.
 *
 * The cap is no longer a device setting, so a case that needs a small cap has to
 * set it on the server before the host starts (the host reads `GET /api/me`).
 */
export async function setUserMaxFileBytes(server: TestServer, maxFileBytes: number): Promise<void> {
  await patchTestUser(server, { maxFileBytes });
}

/**
 * Start a real server on a throwaway database.
 *
 * Each call gets its own temp directory, port and user, so test files can run
 * without sharing state.
 */
export async function startTestServer(name = "e2e user"): Promise<TestServer> {
  const rootDir = mkdtempSync(join(tmpdir(), "courier-e2e-"));
  const sqlitePath = join(rootDir, "courier.db");
  mkdirSync(join(rootDir, "blobs"), { recursive: true });
  applySchema(sqlitePath);

  // Port 0: the listener asks the OS for a free port itself. Probing with a separate
  // socket and binding the real one afterwards leaves a window in which another process
  // can take the port — a macOS CI run hit it three times in one file ("Failed to start
  // server. Is port 51790 in use?"), and the window only widens as the machine gets
  // busier.
  process.env.SQLITE_PATH = sqlitePath;
  process.env.BLOB_STORE_DIR = join(rootDir, "blobs");
  process.env.PORT = "0";
  // A scenario drives two clients through operations back-to-back, and each side
  // answers the other's push with its own pull (measured: ~3 requests per edit,
  // ~200 for the whole real-Obsidian suite). That is honest traffic, but it leaves
  // the production sync-route allowance (120/min, sized for one user's devices)
  // far behind, and a 429 mid-scenario reads as a sync failure rather than the
  // rate limit it is. Raise the ceiling generously: a runaway loop still trips it
  // long before a run ends. The limiter and its defaults are otherwise untouched.
  process.env.SYNC_RATE_LIMIT_MAX_ATTEMPTS = "20000";
  process.env.SYNC_RATE_LIMIT_WINDOW_MS = "60000";

  const { startServer } = await import("../../../server/src/commands/start");
  const started = startServer({ port: "0" });
  // The listener is up once `ready` resolves (immediately: this harness never
  // configures TLS, so there is no certificate wait) — and that is also when the port
  // the OS picked is known.
  const server = await started.ready;
  const port = server.port;
  if (!port) throw new Error("the test listener did not report a port");
  const serverUrl = `http://127.0.0.1:${port}`;
  const user = await createTestUser(serverUrl, name);

  return {
    serverUrl,
    wsUrl: serverUrl.replace(/^http/, "ws"),
    userKey: user.key,
    userId: user.id,
    hostKey: TEST_HOST_KEY,
    rootDir,
    dropSockets: () => started.dropSockets(),
    close: async () => {
      // `stop(true)` drops upgraded sockets as well as keep-alive ones. That matters
      // twice: a plugin host that closed its socket a moment ago (or a second host
      // that replaced it) would otherwise hang the run in `afterAll`, and a pooled
      // `fetch` connection that outlives its server gets reused by the next file's
      // fetch — the OS hands the same port back — surfacing as an ECONNRESET inside
      // undici, where nothing is around to handle it.
      await started.stop();
      // Release the SQLite handle before deleting: on Windows an open handle
      // keeps the database file locked, so `rmSync` would fail with EPERM.
      // Imported dynamically because `src/db/index.ts` reads `SQLITE_PATH` at
      // import time and must see the env this function just set.
      const { closeDb } = await import("../../../server/src/db/index");
      closeDb();
      await removeDirWithRetry(rootDir);
    },
  };
}
