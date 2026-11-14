/**
 * The Bun-native HTTP layer: route tables and response helpers.
 *
 * A route module exports a {@link RouteTable} — plain `path → { METHOD: handler }` —
 * and the listener passes it to `Bun.serve({ routes })`. A request no entry matches
 * reaches the listener's `fetch`, which answers 404 or performs the WebSocket upgrade.
 */
import { requestLevel } from "../middleware/request-log";
import type { Logger } from "../lib/logger";

/**
 * What a route handler gets: Bun's request, which carries the parsed path
 * parameters (`/api/vaults/:id` → `params.id`).
 */
export interface RouteRequest extends Request {
  readonly params: Record<string, string>;
}

/** One method of one path. */
export type RouteHandler = (request: RouteRequest) => Response | Promise<Response>;

/** The methods a table may name. A method it does not name reaches `fetch`. */
export interface RouteMethods {
  GET?: RouteHandler;
  POST?: RouteHandler;
  PUT?: RouteHandler;
  PATCH?: RouteHandler;
  DELETE?: RouteHandler;
  HEAD?: RouteHandler;
  OPTIONS?: RouteHandler;
}

/** One module's routes: `"/api/thing/:id": { GET: … }`. */
export type RouteTable = Record<string, RouteMethods>;

/** A JSON response, the shape every route answers with. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A JSON error body: `{ error, code }`, as `docs/api.md` documents it. */
export function jsonError(code: string, message: string, status: number): Response {
  return json({ error: message, code }, status);
}

/**
 * The parsed request URL, or null when Bun could not build one.
 *
 * `Bun.serve` composes `request.url` from the `Host` header, so a scan that sends
 * none (an HTTP/1.0 probe) arrives as a bare path (`/health`), and a malformed one
 * (`Host: [`) as an origin that is not a URL (`http://[/health`). Both are somebody
 * else's traffic, and `new URL` refusing them must not turn a 404 — or the access
 * line that records it — into a 500 with a stack.
 */
export function requestUrl(request: Request): URL | null {
  try {
    return new URL(request.url);
  } catch {
    return null;
  }
}

/** A request's path, falling back to what the peer sent when there is no parsed URL. */
export function requestPath(request: Request): string {
  const url = requestUrl(request);
  if (url !== null) return url.pathname;
  // The raw string is the only thing left to log; keep its query out of the path field.
  const [raw] = request.url.split("?");
  return raw === undefined || raw === "" ? "/" : raw;
}

/**
 * Wrap a route handler with the access log.
 *
 * `Bun.serve` has no middleware chain, so a route table entry would otherwise lose its
 * access line. This applies the log per route, and the level rules stay in one place:
 * {@link requestLevel} decides what a request is and how slowly it may answer.
 */
export function withAccessLog(
  logger: {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  },
  handler: RouteHandler,
  slowMs = 500,
): RouteHandler {
  return async (request) => {
    const started = performance.now();
    const response = await handler(request);
    const ms = Math.round(performance.now() - started);
    const path = requestPath(request);
    const level = requestLevel({
      method: request.method,
      path,
      status: response.status,
      ms,
      slowMs,
      routeMiss: false,
      hasAuthorization: (request.headers.get("authorization") ?? "").trim() !== "",
    });
    const write = logger[level] as (message: string) => void;
    write(`${request.method} ${path} ${response.status} ${ms}ms`);
    return response;
  };
}

/**
 * The listener's fallback for a path no route table entry matched.
 *
 * Same body Hono's 404 produced ("404 Not Found"), and the same access-log rule:
 * an unmatched path is somebody else's traffic (the public port is scanned all
 * day), so it stays at `debug` however slow the probe was.
 */
export function notFound(request: Request, logger: Logger, slowMs = 500): Response {
  const path = requestPath(request);
  const level = requestLevel({
    method: request.method,
    path,
    status: 404,
    ms: 0,
    slowMs,
    routeMiss: true,
    hasAuthorization: (request.headers.get("authorization") ?? "").trim() !== "",
  });
  const write = logger[level] as (message: string) => void;
  write(`${request.method} ${path} 404 0ms`);
  return new Response("404 Not Found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=UTF-8" },
  });
}

/**
 * Read a JSON body, or throw the caller's error when the body is not JSON.
 *
 * The parser is a parameter so a route can keep throwing its own error type
 * (`PayloadTooLargeError`, `BadRequestError`) instead of a bare `SyntaxError`.
 */
export async function readJson(request: Request, onInvalid: () => Error): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw onInvalid();
  }
}
