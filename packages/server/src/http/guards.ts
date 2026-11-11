import type { ApiKeyScope } from "@courier/shared";
import { InsufficientScopeError, UnauthorizedError } from "../lib/errors";
import { bearerToken } from "../lib/user-credentials";
import { assertApiKeyActive, hasScope } from "../lib/api-key-access";
import type { FindApiKeyFn } from "../handlers/auth-handlers";
import type { RouteHandler } from "./router";

/**
 * The Hono middleware the admin/user routes used, as Bun route wrappers.
 *
 * `withHostAuth` answers the same three refusals the middleware did, in the same
 * order (missing key → inactive key → missing scope). The adapter parses and validates
 * a JSON body and produces the same 422 body `createValidator` produced — including the
 * `details` array, which `docs/api.md` documents.
 */

/** Require an `ak_` host key carrying `scope`, and hand the handler the key row. */
export function withHostAuth<T>(
  findByKey: FindApiKeyFn,
  scope: ApiKeyScope,
  handler: (request: Parameters<RouteHandler>[0], apiKey: T) => Response | Promise<Response>,
): RouteHandler {
  return async (request) => {
    const token = bearerToken(request.headers.get("authorization"), "ak_");
    const apiKey = await findByKey(token);
    if (!apiKey) throw new UnauthorizedError("Invalid or expired API key");
    assertApiKeyActive(apiKey);
    if (!hasScope(apiKey.scopes, scope)) throw new InsufficientScopeError(scope);
    return await handler(request, apiKey as unknown as T);
  };
}
