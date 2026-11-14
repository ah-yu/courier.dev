import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { connect, createServer as createNetServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { connect as tlsConnect } from "tls";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The TLS smoke test: boot the real `startServer()` in TLS mode and talk to it
 * over a real socket.
 *
 * The config module reads `process.env` at import time, so the environment is
 * set here at module scope and `startServer` is imported dynamically inside the
 * tests — the same trick the e2e harness uses.
 *
 * Trust is granted per request (`tls.rejectUnauthorized` on `fetch`), which is the
 * seam this file needs; `SSL_CERT_FILE` is read once at TLS init instead. That last
 * restriction is why the "unmodified client" case runs its client in a child process:
 * there the ambient store is exactly what a deployed client has.
 */

const FIXTURE_DIR = fileURLToPath(new URL("../lib/tls/__fixtures__/", import.meta.url));
/** A self-signed certificate for `IP:127.0.0.1` + `DNS:localhost`, valid to 2076. */
const FIXTURE_CERT = readFileSync(join(FIXTURE_DIR, "cert.pem"), "utf8");
const FIXTURE_KEY = readFileSync(join(FIXTURE_DIR, "key.pem"), "utf8");

const ROOT = mkdtempSync(join(tmpdir(), "courier-start-test-"));
const TLS_DIR = join(ROOT, "tls");
mkdirSync(TLS_DIR, { recursive: true });

/** Every variable this file sets, so the environment survives it. */
const TOUCHED_ENV = [
  "SQLITE_PATH",
  "BLOB_STORE_DIR",
  "PRUNE_INTERVAL_MS",
  "TLS_NAME",
  "TLS_EMAIL",
  "TLS_DIR",
  "ACME_CHALLENGE_PORT",
  "ACME_DIRECTORY_URL",
] as const;
const SAVED_ENV = new Map(TOUCHED_ENV.map((key) => [key, process.env[key]]));

process.env["SQLITE_PATH"] = join(ROOT, "courier.db");
process.env["BLOB_STORE_DIR"] = join(ROOT, "blobs");
// No retention job in a smoke test.
process.env["PRUNE_INTERVAL_MS"] = "0";
process.env["TLS_NAME"] = "127.0.0.1";
process.env["TLS_EMAIL"] = "ops@example.com";
process.env["TLS_DIR"] = TLS_DIR;
// 0 asks the OS for a free port: a test must not need port 80.
process.env["ACME_CHALLENGE_PORT"] = "0";

/**
 * A high port nothing listens on, for the "directory unreachable" case.
 *
 * Low ports (1, 9, …) are on the WHATWG fetch "bad port" list, so undici would
 * refuse the request before dialing and the failure would read `bad port`
 * instead of a refused connection — hiding the ordinary "nothing is listening"
 * case this test exists for.
 */
async function findClosedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

// `config` reads this when it is first imported, which happens inside the first
// `boot()` — after this hook has run.
beforeAll(async () => {
  process.env["ACME_DIRECTORY_URL"] = `http://127.0.0.1:${await findClosedPort()}/directory`;
});

/** Type-only: the module itself is imported dynamically, after the env is set. */
type StartedServer = import("./start").StartedServer;

/** Boot the server on an OS-assigned port and wait until it is serving. */
async function boot(): Promise<{ started: StartedServer; port: number }> {
  const { startServer } = await import("./start");
  const started = startServer({ port: "0" });
  const server = await started.ready;
  return { started, port: server.port ?? 0 };
}

async function shutdown(started: StartedServer): Promise<void> {
  await started.stop();
}

/** A request the app answers with its 404 (no route, no auth, no database). */
async function httpsGet(
  port: number,
  options: { trust: boolean } = { trust: true },
): Promise<{ status: number; body: string }> {
  // Bun's fetch takes the trust decision per request, which is what the old `ca`
  // argument on `https.request` did.
  const response = await fetch(
    `https://127.0.0.1:${port}/`,
    options.trust ? { tls: { rejectUnauthorized: false } } : {},
  );
  return { status: response.status, body: await response.text() };
}

/**
 * One raw HTTP/1.0 request — what a port scanner sends, and the one shape whose
 * missing `Host` header makes Bun hand the listener a relative URL. `secure`
 * reaches a TLS listener, the way the deployed service port is reached.
 */
function hostlessStatus(port: number, path: string, secure = false): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = secure
      ? tlsConnect({ port, host: "127.0.0.1", rejectUnauthorized: false })
      : connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error("the listener did not answer"));
    });
    socket.on("data", (chunk) => {
      data += chunk.toString();
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(data);
      if (match?.[1] !== undefined) {
        socket.destroy();
        resolve(Number(match[1]));
      }
    });
    socket.on("error", reject);
    socket.on(secure ? "secureConnect" : "connect", () =>
      socket.write(`GET ${path} HTTP/1.0\r\n\r\n`),
    );
  });
}

/**
 * The client half of the "unmodified client" case, run by Bun itself: the
 * global `fetch` and the global `WebSocket` are the transports the Obsidian
 * plugin and `courier-cli` use, and neither takes a per-request trust argument.
 *
 * It is a script string rather than an imported module because the trust it
 * needs lives in the process environment, which the TLS stack reads while it
 * initializes — a child process is the only place that happens after this file
 * has already made a TLS connection.
 */
const CLIENT_SCRIPT = `
const port = process.argv[1];
const response = await fetch("https://127.0.0.1:" + port + "/");
console.log("https ok " + response.status);
const socket = new WebSocket("wss://127.0.0.1:" + port);
await new Promise((resolve, reject) => {
  socket.onopen = () => {
    console.log("wss ok");
    resolve();
  };
  socket.onerror = () => reject(new Error("the wss handshake failed"));
});
socket.close();
`;

/**
 * Run that client and collect what it said.
 *
 * The spawn is asynchronous on purpose: the listener under test lives in *this*
 * process, so a blocking `spawnSync` would hold the event loop the child's
 * request is waiting on and the run would deadlock until the client's own
 * timeout — the trap the real-Obsidian suite documents.
 */
function runClient(
  port: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", CLIENT_SCRIPT, String(port)], {
      env: { ...process.env, SSL_CERT_FILE: join(FIXTURE_DIR, "cert.pem") },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

/** A request the app answers with its 404 (no route, no auth, no database). */
function httpsGetUntrusted(port: number): Promise<{ status: number; body: string }> {
  return fetch(`https://127.0.0.1:${port}/`).then(async (response) => ({
    status: response.status,
    body: await response.text(),
  }));
}

afterAll(async () => {
  const { closeDb } = await import("../db/index");
  closeDb();
  for (const key of TOUCHED_ENV) {
    const saved = SAVED_ENV.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
  rmSync(ROOT, { recursive: true, force: true });
});

describe("startServer with TLS_NAME set", () => {
  it("serves the certificate on disk over https and wss", async () => {
    writeFileSync(join(TLS_DIR, "fullchain.pem"), FIXTURE_CERT);
    writeFileSync(join(TLS_DIR, "privkey.pem"), FIXTURE_KEY);

    // The startup lines must name the port the OS bound, not the `0` asked for.
    const stderr = vi.spyOn(process.stderr, "write");
    const { started, port } = await boot();
    const logged = stderr.mock.calls.map((call) => String(call[0])).join("");
    stderr.mockRestore();

    expect(started.server).not.toBeNull();
    expect(port).toBeGreaterThan(0);
    expect(logged).toContain(`Server running at https://127.0.0.1:${port}`);
    expect(logged).toContain(`WebSocket server running at wss://127.0.0.1:${port}`);

    // A client that trusts the certificate gets the app's answer...
    const trusted = await httpsGet(port);
    expect(trusted.status).toBe(404);
    // ...and one that does not is refused by the handshake.
    await expect(httpsGetUntrusted(port)).rejects.toThrow(/self.signed|unable to verify/i);

    // The deployed port is the one scanners hit, and a hostless HTTP/1.0 probe is
    // the shape whose `new URL(request.url)` used to turn an answered 404 into a
    // 500. An unmatched path stays a 404, a real route still answers, and neither
    // writes an error line at the default level.
    const probeLog = vi.spyOn(process.stderr, "write");
    expect(await hostlessStatus(port, "/", true)).toBe(404);
    expect(await hostlessStatus(port, "/api/health", true)).toBe(200);
    const probeLines = probeLog.mock.calls.map((call) => String(call[0])).join("");
    probeLog.mockRestore();
    expect(probeLines).not.toContain("Unhandled error");
    // A route miss and a successful read are both debug lines, so `info` keeps them out.
    expect(probeLines).not.toContain("404 0ms");
    expect(probeLines).not.toContain("/api/health 200");

    // The WebSocket upgrade rides the same TLS listener. Bun's client cannot take a
    // per-connection CA, so this goes through the same child-process client the
    // "own trust store" case uses — which is also how a deployed client behaves.
    const client = await runClient(port);
    expect(client.status).toBe(0);
    expect(client.stdout).toContain("wss ok");

    // A fresh certificate is served as it is: no ACME account was ever created.
    expect(started.tls?.manager.currentCertificate()).not.toBeNull();
    expect(existsSync(join(TLS_DIR, "account.key"))).toBe(false);

    await shutdown(started);
  });

  it("waits for the first certificate instead of binding a listener that cannot serve", async () => {
    rmSync(join(TLS_DIR, "fullchain.pem"), { force: true });
    rmSync(join(TLS_DIR, "privkey.pem"), { force: true });

    const { startServer } = await import("./start");
    const started = startServer({ port: "0" });

    // C: no certificate, no listener. A closed port is the honest "not ready"
    // answer — never a TLS error that reads like a misconfiguration.
    expect(started.server).toBeNull();
    expect(started.tls?.manager.currentCertificate()).toBeNull();

    // The background issuance fails against the unreachable directory with the
    // refused connection named — where a bare `fetch failed` would name nothing.
    await expect(started.tls?.manager.issue()).rejects.toThrow(/ECONNREFUSED/);
    // A failed attempt leaves the service untouched: still no listener.
    expect(started.server).toBeNull();

    // When the certificate arrives, the same call the manager makes binds the
    // listener — and the service serves it immediately.
    started.installCertificate({ cert: FIXTURE_CERT, key: FIXTURE_KEY });
    const server = await started.ready;
    expect(server.port).toBeGreaterThan(0);
    const trusted = await httpsGet(server.port ?? 0);
    expect(trusted.status).toBe(404);

    await shutdown(started);
  });

  it("retries the challenge port on the next attempt instead of giving up on it", async () => {
    const { createChallengeListener } = await import("./start");

    // Hold the port so the listener's first bind fails, the way port 80 is
    // already taken (or not permitted) on a misconfigured server. The blocker is a
    // Bun server on Bun's own default hostname, not a raw socket on `0.0.0.0`:
    // which address family that default resolves to differs by OS, and on macOS an
    // IPv6 wildcard bind is allowed beside an IPv4 one — the listener came up next
    // to the blocker and this case failed on the first macOS CI run. The same
    // runtime asking for the same address keeps the conflict identical everywhere.
    const blocker = Bun.serve({ port: 0, fetch: () => new Response(null) });
    const port = blocker.port;
    if (port === undefined) throw new Error("the port blocker did not bind a port");

    const listener = createChallengeListener(port, (token) =>
      token === "tok" ? "tok.thumb" : null,
    );
    await expect(listener.ensureListening()).rejects.toThrow();
    // The failed attempt is not cached: the next one tries the port again.
    await expect(listener.ensureListening()).rejects.toThrow();

    await blocker.stop(true);
    await listener.ensureListening();

    // The one route the listener answers, with exactly the registered bytes…
    const served = await fetch(`http://127.0.0.1:${port}/.well-known/acme-challenge/tok`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe("tok.thumb");
    // …and nothing else: an unknown token and any other path are a 404.
    expect((await fetch(`http://127.0.0.1:${port}/.well-known/acme-challenge/other`)).status).toBe(
      404,
    );
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);

    // The challenge port is as public as the service port, and a hostless probe
    // reaches this listener as a relative URL. It used to throw before answering;
    // now the path is still read, so the registered token answers and the rest 404s.
    expect(await hostlessStatus(port, "/")).toBe(404);
    expect(await hostlessStatus(port, "/.well-known/acme-challenge/tok")).toBe(200);

    await listener.close();
  });

  it("is reachable by a client whose only trust comes from its own store", async () => {
    writeFileSync(join(TLS_DIR, "fullchain.pem"), FIXTURE_CERT);
    writeFileSync(join(TLS_DIR, "privkey.pem"), FIXTURE_KEY);

    const { started, port } = await boot();

    // No code change and no `ca` argument anywhere: the client trusts the
    // certificate the way it would trust a Let's Encrypt one in production.
    const client = await runClient(port);

    expect(client.stderr).toBe("");
    expect(client.status).toBe(0);
    expect(client.stdout).toContain("https ok 404");
    expect(client.stdout).toContain("wss ok");

    await shutdown(started);
  });
});
