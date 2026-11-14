import { describe, expect, it } from "vitest";
import { requestLevel, requestMessage, type RequestFacts } from "./request-log";
import { notFound, requestPath, withAccessLog } from "../http/router";
import type { Logger, LogLevel } from "../lib/logger";

/**
 * A logger that keeps only the records its level would write, so "invisible at
 * the default level" is asserted the way the real logger decides it.
 */
function recordingLogger(level: LogLevel = "debug") {
  const records: Array<{ level: LogLevel; message: string }> = [];
  const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const enabled = (candidate: LogLevel) => order[candidate] >= order[level];
  const write = (candidate: LogLevel, message: string) => {
    if (enabled(candidate)) records.push({ level: candidate, message });
  };
  const logger: Logger = {
    level,
    enabled,
    debug: (message) => write("debug", message),
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
  };
  return { logger, records };
}

/** Facts for a request that matched a route and carried a credential. */
function facts(overrides: Partial<RequestFacts> = {}): RequestFacts {
  return {
    method: "GET",
    path: "/api/vaults",
    status: 200,
    ms: 1,
    slowMs: 500,
    routeMiss: false,
    hasAuthorization: true,
    ...overrides,
  };
}

/**
 * A request shaped the way `Bun.serve` hands a missing or malformed `Host` to
 * `fetch`: `url` is the raw relative or unparseable string, which `new Request()`
 * itself refuses to build. Checked against Bun 1.4.4 — a hostless HTTP/1.0 probe
 * arrives as `/path`, and `Host: [` as `http://[/path` — and only `.url`, `.method`
 * and `.headers` are read by the code under test.
 */
function requestWithRawUrl(rawUrl: string, init?: RequestInit): Request {
  const request = new Request("http://placeholder/", init);
  Object.defineProperty(request, "url", { value: rawUrl });
  return request;
}

describe("requestLevel", () => {
  it("treats a server failure as an error", () => {
    expect(requestLevel(facts({ status: 500 }))).toBe("error");
    expect(requestLevel(facts({ status: 503 }))).toBe("error");
    // A failure on a path no route answered is still this service failing.
    expect(requestLevel(facts({ status: 500, routeMiss: true }))).toBe("error");
  });

  it("keeps an ordinary client error out of the warning view", () => {
    expect(requestLevel(facts({ status: 404 }))).toBe("info");
    expect(requestLevel(facts({ status: 422 }))).toBe("info");
  });

  it("drops a path no route answered to debug, however slow the probe", () => {
    // The service is scanned continuously on its public port: `GET /` and
    // `GET /.git/HEAD` are somebody else's paths, not this service's problem.
    expect(requestLevel(facts({ status: 404, routeMiss: true }))).toBe("debug");
    expect(requestLevel(facts({ status: 404, routeMiss: true, ms: 900 }))).toBe("debug");
    expect(requestLevel(facts({ method: "POST", status: 404, routeMiss: true }))).toBe("debug");
  });

  it("treats a presented credential as a warning and an anonymous probe as debug", () => {
    expect(requestLevel(facts({ status: 401 }))).toBe("warn");
    expect(requestLevel(facts({ status: 403 }))).toBe("warn");
    expect(requestLevel(facts({ status: 401, hasAuthorization: false }))).toBe("debug");
    expect(requestLevel(facts({ status: 403, hasAuthorization: false }))).toBe("debug");
  });

  it("calls a slow request a warning whatever it answered", () => {
    expect(requestLevel(facts({ status: 200, ms: 500 }))).toBe("warn");
    expect(requestLevel(facts({ status: 200, ms: 5000 }))).toBe("warn");
    expect(requestLevel(facts({ status: 404, ms: 900 }))).toBe("warn");
    // A 5xx is still worse than slow.
    expect(requestLevel(facts({ status: 500, ms: 900 }))).toBe("error");
    // Slow is decided before the credential, so even an anonymous probe that
    // slowed the service is worth a line.
    expect(requestLevel(facts({ status: 401, hasAuthorization: false, ms: 900 }))).toBe("warn");
  });

  it("treats a bare 400 as a client error too", () => {
    // `>= 400` includes 400 itself; `> 400` would file it as a healthy read.
    expect(requestLevel(facts({ status: 400 }))).toBe("info");
  });

  it("keeps a healthy read at debug", () => {
    expect(requestLevel(facts({ status: 200 }))).toBe("debug");
  });

  it("records a successful mutation at info", () => {
    // "I deleted a key" has to leave a line at the default level.
    expect(requestLevel(facts({ method: "DELETE", path: "/api/users/u_1", status: 200 }))).toBe(
      "info",
    );
    expect(requestLevel(facts({ method: "PUT", path: "/api/users/u_1", status: 200 }))).toBe(
      "info",
    );
    // Only the push endpoint itself is traffic, not a path that merely starts with it.
    expect(
      requestLevel(facts({ method: "POST", path: "/api/vaults/v_1/sync/push/extra", status: 200 })),
    ).toBe("info");
    expect(requestLevel(facts({ method: "POST", path: "/api/users", status: 201 }))).toBe("info");
    expect(requestLevel(facts({ method: "PATCH", path: "/api/users/u_1", status: 200 }))).toBe(
      "info",
    );
    expect(requestLevel(facts({ method: "DELETE", path: "/api/vaults/v_1", status: 204 }))).toBe(
      "info",
    );
    expect(
      requestLevel(
        facts({ method: "POST", path: "/api/vaults/v_1/sync/deleted/clear", status: 200 }),
      ),
    ).toBe("info");
  });

  it("keeps a successful push at debug, where the route logs its refusals", () => {
    expect(
      requestLevel(facts({ method: "POST", path: "/api/vaults/v_1/sync/push", status: 200 })),
    ).toBe("debug");
  });

  it("renders the one access-log line", () => {
    expect(requestMessage("GET", "/api/health", 200, 3)).toBe("GET /api/health 200 3ms");
  });
});

describe("requestPath", () => {
  it("returns the pathname of a parsed URL", () => {
    expect(requestPath(new Request("http://x/api/health?full=1"))).toBe("/api/health");
  });

  it("keeps what the peer sent when Bun could not build a URL", () => {
    // A relative URL from a hostless probe still has its path in it; a malformed
    // Host leaves only the raw string, and that is what the log should name.
    expect(requestPath(requestWithRawUrl("/api/health?full=1"))).toBe("/api/health");
    expect(requestPath(requestWithRawUrl("http://[/api/health?full=1"))).toBe(
      "http://[/api/health",
    );
    expect(requestPath(requestWithRawUrl(""))).toBe("/");
  });
});

/**
 * The Bun route table's access log.
 *
 * Hono used to mount one middleware for this; a Bun route handler never passes
 * through it, so `withAccessLog` wraps each entry instead. These cases pin that it
 * still decides the level the same way — and that the 404 fallback is not traffic.
 */
describe("withAccessLog", () => {
  it("logs a successful read at debug and an unauthenticated 401 at debug", async () => {
    const { logger, records } = recordingLogger("debug");
    const handler = withAccessLog(logger, () => new Response(null, { status: 200 }));
    await handler(Object.assign(new Request("http://x/api/health"), { params: {} }));
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("debug");
    expect(records[0]!.message).toBe("GET /api/health 200 0ms");
  });

  it("logs a rejected credential at warn, which the default level keeps", async () => {
    const loud = recordingLogger("debug");
    const unauthorized = withAccessLog(loud.logger, () => new Response(null, { status: 401 }));
    await unauthorized(
      Object.assign(new Request("http://x/api/me", { headers: { authorization: "Bearer ck_x" } }), {
        params: {},
      }),
    );
    expect(loud.records[0]!.level).toBe("warn");

    // A refused credential is the one client error worth a line at the default
    // level: it means an operator's key expired or a device is using an old one.
    const quiet = recordingLogger("info");
    const quietHandler = withAccessLog(quiet.logger, () => new Response(null, { status: 401 }));
    await quietHandler(
      Object.assign(new Request("http://x/api/me", { headers: { authorization: "Bearer ck_x" } }), {
        params: {},
      }),
    );
    expect(quiet.records).toHaveLength(1);
    expect(quiet.records[0]!.level).toBe("warn");
  });

  it("logs a mutation at info", async () => {
    const { logger, records } = recordingLogger("info");
    const handler = withAccessLog(logger, () => new Response(null, { status: 204 }));
    await handler(
      Object.assign(new Request("http://x/api/vaults/v1", { method: "DELETE" }), { params: {} }),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe("info");
  });

  it("logs a request whose URL Bun could not build instead of failing it", async () => {
    // The access line used to be the one place a scan could turn an answered request
    // into a 500: `new URL` threw after the handler had already produced a response.
    const { logger, records } = recordingLogger("debug");
    const handler = withAccessLog(logger, () => new Response(null, { status: 200 }));
    const response = await handler(Object.assign(requestWithRawUrl("/api/health"), { params: {} }));
    expect(response.status).toBe(200);
    expect(records).toHaveLength(1);
    expect(records[0]!.message).toBe("GET /api/health 200 0ms");
  });
});

describe("notFound", () => {
  it("answers Hono's body and keeps the path out of the default view", async () => {
    const quiet = recordingLogger("info");
    const response = notFound(new Request("http://x/api/nope"), quiet.logger);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 Not Found");
    expect(quiet.records).toHaveLength(0);

    const loud = recordingLogger("debug");
    await notFound(new Request("http://x/api/nope"), loud.logger);
    expect(loud.records).toHaveLength(1);
    expect(loud.records[0]!.level).toBe("debug");
    expect(loud.records[0]!.message).toContain("GET /api/nope 404");
  });

  it("answers a request whose URL Bun could not build instead of throwing", () => {
    // Port scanners send HTTP/1.0 with no Host header (a relative URL) and,
    // occasionally, a Host that is not a host. The 404 fallback sees both, and it
    // must answer them as the 404 they are rather than logging an internal error.
    const loud = recordingLogger("debug");

    const relative = notFound(requestWithRawUrl("/api/nope"), loud.logger);
    expect(relative.status).toBe(404);
    expect(loud.records[0]!.level).toBe("debug");
    expect(loud.records[0]!.message).toContain("GET /api/nope 404");

    loud.records.length = 0;
    const malformed = notFound(requestWithRawUrl("http://[/api/nope"), loud.logger);
    expect(malformed.status).toBe(404);
    expect(loud.records[0]!.message).toContain("GET http://[/api/nope 404");
  });
});
