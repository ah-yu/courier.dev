/**
 * Build the Bun route table from the shared wire registry.
 *
 * This is the piece that makes the contract gate load-bearing: `start.ts` serves exactly
 * `toRouteTable(HTTP, handlers)`, so a route that is not in `HTTP` cannot be served, a
 * handler that is missing is a startup error, and the auth wrapper, body parser, status
 * code and response validation all come from the same declaration the surface is
 * serialized from.
 *
 * The handler receives a plain body (not a `Response`), so a JSON response can be
 * validated against its schema before it is serialized. The two streaming/binary routes
 * are the exception: their handler returns the `Response`/bytes it built, and the
 * contract records the framing instead of a JSON shape.
 */
import { type HttpContract, type HttpContractId, type WireSchema } from "@courier/shared/wire";
import { config } from "../config";
import type { FindApiKeyFn } from "../handlers/auth-handlers";
import type { FindUserByKeyFn, UserRow } from "../handlers/users-handlers";
import type { FindVaultByIdFn, VaultRow } from "../handlers/vault-handlers";
import { NotFoundError, PayloadTooLargeError, ValidationError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { validationDetails } from "../lib/validator";
import {
  createRateLimiter,
  syncRateLimitOptions,
  syncTransferRateLimitOptions,
  type RateLimiter,
} from "../middleware/rate-limit";
import { withErrorMapping, withUserAuth } from "./auth";
import { withHostAuth } from "./guards";
import { readPushBody } from "./push-body";
import {
  json,
  readJson,
  withAccessLog,
  type RouteHandler,
  type RouteRequest,
  type RouteTable,
} from "./router";
import { withRateLimiter, withSyncAuth } from "./sync-guards";

/** Whether responses and statuses are checked. Off in a production build for cost. */
const STRICT = process.env.NODE_ENV !== "production";

/** What a route handler gets: the parsed request, plus whatever its auth wrapper added. */
export interface RouteContext {
  request: RouteRequest;
  params: Record<string, string>;
  query: unknown;
  body: unknown;
  user?: UserRow;
  vault?: VaultRow;
  vaultId?: string;
  apiKey?: unknown;
}

/** A handler's answer: a body to serialize, or a `Response` for a stream. */
export type RouteResult =
  | { status?: number; body?: unknown; headers?: Record<string, string> }
  | Response;

export type RouteHandlerBody = (context: RouteContext) => RouteResult | Promise<RouteResult>;

/** Every contract has exactly one handler. A missing key fails the assignment in `start.ts`. */
export type RouteHandlers = { [K in HttpContractId]: RouteHandlerBody };

/**
 * The three lookups the auth wrappers need.
 *
 * Injected rather than imported: the adapter is otherwise pure, and a route test can
 * build one table without opening the database.
 */
export interface RouteDeps {
  findUserByKey: FindUserByKeyFn;
  findVaultById: FindVaultByIdFn;
  findByKey: FindApiKeyFn;
}

interface AuthContext {
  user?: UserRow;
  vault?: VaultRow;
  vaultId?: string;
  apiKey?: unknown;
}

interface Limits {
  sync: RateLimiter;
  transfer: RateLimiter;
}

/**
 * Turn the registry into the table `Bun.serve` takes.
 *
 * Every handler id is checked against the contracts and every contract against the
 * handlers: an orphan in either direction is a startup error, not a route that silently
 * answers 404 or a surface entry nobody serves.
 */
export function toRouteTable(
  contracts: readonly HttpContract[],
  handlers: Partial<RouteHandlers>,
  logger: Logger,
  deps: RouteDeps,
): RouteTable {
  const limits: Limits = {
    sync: createRateLimiter(syncRateLimitOptions()),
    transfer: createRateLimiter(syncTransferRateLimitOptions()),
  };
  const ids = new Set(contracts.map((contract) => contract.id));
  for (const id of Object.keys(handlers)) {
    if (!ids.has(id)) throw new Error(`contract: handler "${id}" has no route`);
  }

  const table: RouteTable = {};
  for (const contract of contracts) {
    const handler = handlers[contract.id as HttpContractId];
    if (handler === undefined) throw new Error(`contract: no handler for "${contract.id}"`);
    const entry = (table[contract.path] ??= {});
    if (entry[contract.method] !== undefined) {
      throw new Error(`contract: duplicate route ${contract.method} ${contract.path}`);
    }
    entry[contract.method] = wrap(contract, handler, logger, limits, deps);
  }
  return table;
}

function wrap(
  contract: HttpContract,
  handler: RouteHandlerBody,
  logger: Logger,
  limits: Limits,
  deps: RouteDeps,
): RouteHandler {
  const run = (request: RouteRequest, auth: AuthContext): Promise<Response> =>
    handle(contract, handler, request, auth);

  let route: RouteHandler;
  switch (contract.auth) {
    case "none":
      route = (request) => run(request, {});
      break;
    case "user":
      route = withUserAuth(deps.findUserByKey, (request, user) => run(request, { user }));
      break;
    case "sync":
      route = withSyncAuth(
        { findUserByKey: deps.findUserByKey, findVaultById: deps.findVaultById },
        (request, context) => run(request, context),
      );
      break;
    case "host": {
      if (contract.scope === undefined) {
        throw new Error(`contract: ${contract.id} needs a host-key scope`);
      }
      route = withHostAuth(deps.findByKey, contract.scope, (request) => run(request, {}));
      break;
    }
  }

  if (contract.rateLimit !== undefined) {
    route = withRateLimiter(contract.rateLimit === "sync" ? limits.sync : limits.transfer, route);
  }
  return withAccessLog(logger, withErrorMapping(route, logger), config.LOG_SLOW_MS);
}

async function handle(
  contract: HttpContract,
  handler: RouteHandlerBody,
  request: RouteRequest,
  auth: AuthContext,
): Promise<Response> {
  const params = contract.params === undefined ? request.params : parseParams(contract, request);
  const query = contract.query === undefined ? undefined : parseQuery(contract.query, request);
  const body = await parseBody(contract, request);
  const result = await handler({ request, params, query, body, ...auth });
  return respond(contract, result);
}

function parseParams(contract: HttpContract, request: RouteRequest): Record<string, string> {
  const parsed = contract.params!.safeParse(request.params);
  if (!parsed.success) {
    // A content route treats a malformed hash as "nothing by that name": 404 keeps it
    // indistinguishable from a blob the store does not hold.
    if (contract.paramFailure === "not-found") throw new NotFoundError("Version content");
    throw new ValidationError("Validation failed", validationDetails(parsed.error.issues));
  }
  return parsed.data as Record<string, string>;
}

function parseQuery(schema: WireSchema, request: RouteRequest): unknown {
  const raw = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Validation failed", validationDetails(parsed.error.issues));
  }
  return parsed.data;
}

async function parseBody(contract: HttpContract, request: RouteRequest): Promise<unknown> {
  switch (contract.body.kind) {
    case "none":
      return undefined;
    case "json":
      return parseJsonBody(contract.body.schema, request);
    case "push":
      return readPushBody(request);
    case "bytes":
      return readBytes(request, config.SYNC_MAX_CHUNK_BYTES);
  }
}

async function parseJsonBody(schema: WireSchema, request: RouteRequest): Promise<unknown> {
  const raw = await readJson(request, () => new ValidationError("Expected a JSON body"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError("Validation failed", validationDetails(parsed.error.issues));
  }
  return parsed.data;
}

async function readBytes(request: RouteRequest, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new PayloadTooLargeError(`chunk body exceeds ${limit} bytes`);
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > limit) {
    throw new PayloadTooLargeError(`chunk body exceeds ${limit} bytes`);
  }
  return body;
}

function respond(contract: HttpContract, result: RouteResult): Response {
  if (result instanceof Response) {
    if (contract.response.kind !== "stream") {
      throw new Error(`contract: ${contract.id} returned a raw Response for a JSON route`);
    }
    assertStatus(contract, result.status);
    return result;
  }

  const status = result.status ?? contract.status[0]!;
  assertStatus(contract, status);

  switch (contract.response.kind) {
    case "none":
      return new Response(null, { status });
    case "json":
      validateResponse(contract, result.body);
      return json(result.body, status, result.headers);
    case "binary": {
      if (!(result.body instanceof Uint8Array)) {
        throw new Error(`contract: ${contract.id} must return bytes`);
      }
      // The runtime accepts a BufferSource; the server tsconfig and the tooling tsconfig
      // name that type differently, so the cast is confined to this boundary.
      return new Response(result.body as unknown as ArrayBuffer, {
        status,
        headers: {
          "Content-Type": contract.response.contentType,
          "Content-Length": String(result.body.byteLength),
          ...result.headers,
        },
      });
    }
    case "stream":
      throw new Error(`contract: ${contract.id} must return a Response`);
  }
}

function assertStatus(contract: HttpContract, status: number): void {
  if (!STRICT) return;
  if (!contract.status.includes(status)) {
    throw new Error(
      `contract: ${contract.id} answered ${status}, declared ${contract.status.join(", ")}`,
    );
  }
}

function validateResponse(contract: HttpContract, body: unknown): void {
  if (!STRICT || contract.response.kind !== "json") return;
  const parsed = contract.response.schema.safeParse(body);
  if (parsed.success) return;
  const details = validationDetails(parsed.error.issues)
    .map((issue) => `${issue.field || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new Error(`contract: ${contract.id} response does not match its schema: ${details}`);
}
