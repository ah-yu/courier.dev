import { AppError, ValidationError } from "../lib/errors";
import { logger as processLogger } from "../lib/log";
import type { Logger } from "../lib/logger";
import { authenticateUserHeader } from "../lib/user-credentials";
import type { FindUserByKeyFn, UserRow } from "../handlers/users-handlers";
import { requireContract } from "./contract";
import { json, type RouteHandler, type RouteRequest } from "./router";

/**
 * Route wrappers for the Bun route table: what Hono's middleware chain used to
 * provide (auth, error mapping) as plain higher-order functions.
 *
 * They are deliberately small. The questions they ask — "which user is this
 * key", "what does this error look like on the wire" — already live in
 * `lib/user-credentials.ts` and `lib/errors.ts`; these only adapt them to a
 * handler that returns a `Response`.
 */

/**
 * Answer with the same body, status and headers the Hono error handler produces.
 *
 * One mapping matters: a client cannot tell which router answered it, and
 * `docs/api.md` documents these shapes.
 */
export function toErrorResponse(err: unknown, log: Logger = processLogger): Response {
  if (err instanceof AppError) {
    // The access log already records the status; this adds the code the client
    // received, at debug so a failed request is still one line by default.
    log.debug(`${err.statusCode} ${err.code}: ${err.message}`);
    const body: Record<string, unknown> = { error: err.code, message: err.message };
    if (err instanceof ValidationError && err.details) body.details = err.details;
    if (err.extra) Object.assign(body, err.extra);
    return json(body, err.statusCode, err.headers);
  }
  const error = err instanceof Error ? err : new Error(String(err));
  log.error(`Unhandled error: ${error.stack ?? error.message}`);
  return json({ error: "INTERNAL_ERROR", message: "An unexpected error occurred" }, 500);
}

/** Run a handler, turning a thrown `AppError` into its documented response. */
export function withErrorMapping(handler: RouteHandler, log: Logger): RouteHandler {
  return async (request: RouteRequest) => {
    try {
      return await handler(request);
    } catch (err) {
      return toErrorResponse(err, log);
    }
  };
}

/**
 * Wrap a handler with the `ck_` user-key check and hand it the account.
 *
 * `authenticateUserHeader` is the same call the sync routes and the WebSocket
 * `subscribe` use, so expiry, disabling and "an `ak_` key is not a user key" all
 * behave identically here and there.
 *
 * The contract check runs first: it is the other thing that can make a request
 * impossible, and "upgrade the server" is a different answer from "your credential is
 * wrong". This wrapper and `withSyncAuth` are the whole `ck_` surface, so the two of them
 * are where the check belongs — a route that adds auth gets it without remembering.
 */
export function withUserAuth(
  findUserByKey: FindUserByKeyFn,
  handler: (request: RouteRequest, user: UserRow) => Response | Promise<Response>,
): RouteHandler {
  return async (request) => {
    requireContract(request);
    const user = await authenticateUserHeader(request.headers.get("authorization"), findUserByKey);
    return await handler(request, user);
  };
}
