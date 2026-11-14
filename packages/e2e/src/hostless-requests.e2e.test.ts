import { connect } from "net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestServer, type TestServer } from "./harness/server";

/**
 * The deployed port is scanned continuously, and a scan may send no `Host` header
 * at all (HTTP/1.0) or one Bun cannot parse (`Host: [`). Bun then hands the
 * listener a relative or unparseable `request.url`; the access log and the 404
 * fallback must answer that traffic instead of throwing after the route already
 * answered.
 *
 * The unit cases in `packages/server` build that `Request` by hand. These drive
 * the real listener, the real route table and the real auth wrappers, which is
 * the only place the query parser's refusal can be observed with a credential.
 */

interface RawResponse {
  status: number;
  body: string;
  /** Everything the service wrote to stderr while it handled this request. */
  log: string;
}

/** One raw HTTP/1.0 request; a `Host` line is what makes it HTTP/1.1. */
function rawGet(port: number, path: string, headerLines: string[] = []): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const hasHost = headerLines.some((line) => line.toLowerCase().startsWith("host:"));
    const stderr = vi.spyOn(process.stderr, "write");
    const socket = connect(port, "127.0.0.1");
    let data = "";
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      const log = stderr.mock.calls.map((call) => String(call[0])).join("");
      stderr.mockRestore();
      socket.destroy();
      if (error !== undefined) {
        reject(error);
        return;
      }
      const [, status = "0"] = /^HTTP\/1\.[01] (\d{3})/.exec(data) ?? [];
      const separator = data.indexOf("\r\n\r\n");
      resolve({
        status: Number(status),
        body: separator === -1 ? "" : data.slice(separator + 4),
        log,
      });
    };

    socket.setTimeout(3000, () => finish(new Error("the listener did not answer")));
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () => finish());
    socket.on("connect", () => {
      const requestLine = `GET ${path} ${hasHost ? "HTTP/1.1" : "HTTP/1.0"}`;
      socket.write(
        `${requestLine}\r\n${[...headerLines, "Connection: close"].join("\r\n")}\r\n\r\n`,
      );
    });
  });
}

/** Create the one vault the query route needs, over the real route. */
async function createVault(server: TestServer, name: string): Promise<string> {
  const response = await fetch(`${server.serverUrl}/api/vaults`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.userKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, encryptionSalt: "salt", keyCheck: "canary" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("hostless and malformed-Host scans", () => {
  let server: TestServer;
  let port: number;
  let vaultId: string;

  beforeAll(async () => {
    server = await startTestServer("hostless scan user");
    port = Number(new URL(server.serverUrl).port);
    vaultId = await createVault(server, "scanned");
  });

  afterAll(async () => {
    await server.close();
  });

  it("answers a route-miss probe with the 404 it is, and keeps it out of the default log", async () => {
    const response = await rawGet(port, "/wp-login.php");

    expect(response.status).toBe(404);
    expect(response.log).not.toContain("Unhandled error");
    // A route miss is debug, so the default level writes no access line for it.
    expect(response.log).not.toContain("404 0ms");
  });

  it("serves a real route on a hostless request", async () => {
    const response = await rawGet(port, "/api/health");

    expect(response.status).toBe(200);
    expect(response.log).not.toContain("Unhandled error");
  });

  it("refuses a query-reading route only once the credential passed", async () => {
    const path = `/api/vaults/${vaultId}/sync/versions?limit=1`;

    // Anonymous: the auth wrapper answers first, so the URL is never parsed and the
    // line stays at debug — exactly what a scanner sees.
    const anonymous = await rawGet(port, path);
    expect(anonymous.status).toBe(401);
    expect(anonymous.log).not.toContain("Unhandled error");
    expect(anonymous.log).not.toContain("/sync/versions 401");

    // With a key, the route reads its query and refuses the unparseable URL. Both
    // shapes Bun hands over are covered: no Host at all, and a malformed one.
    for (const host of [null, "["]) {
      const headers = [`Authorization: Bearer ${server.userKey}`];
      if (host !== null) headers.push(`Host: ${host}`);
      const response = await rawGet(port, path, headers);

      expect(response.status).toBe(422);
      expect(response.body).toContain("VALIDATION_ERROR");
      expect(response.body).toContain("Malformed request URL");
      expect(response.log).not.toContain("Unhandled error");
      // One access line, at info: the default level records the refusal once.
      expect(
        response.log.split("\n").filter((line) => line.includes("/sync/versions 422")),
      ).toHaveLength(1);
    }
  });
});
