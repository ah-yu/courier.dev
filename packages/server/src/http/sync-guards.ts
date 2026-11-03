import { NotFoundError } from "../lib/errors";
import { authenticateUserHeader } from "../lib/user-credentials";
import { canAccessVault } from "../lib/vault-access";
import type { FindVaultByIdFn, VaultRow } from "../handlers/vault-handlers";
import type { FindUserByKeyFn, UserRow } from "../handlers/users-handlers";
import type { RateLimiter } from "../middleware/rate-limit";
import type { RouteHandler } from "./router";

/** The lookups a sync request needs: who the key belongs to, and which vault it names. */
export interface SyncAuthDeps {
  findUserByKey: FindUserByKeyFn;
  findVaultById: FindVaultByIdFn;
}

/**
 * The sync route's two Hono middlewares — the per-vault rate limit and the
 * `ck_` + vault-ownership check — as Bun route wrappers.
 *
 * Both ask the same questions the Hono versions did, and answer the same way: a
 * rate-limited vault gets `RateLimitError`'s 429, and a vault the account cannot
 * see is a **404**, never a 403, because a client reads 403 as "your key is dead"
 * and would drop the credential over a vault that is simply not its business.
 */

/** Spend one request from the vault's window, or throw the documented 429. */
export function withRateLimiter(limiter: RateLimiter, handler: RouteHandler): RouteHandler {
  return (request) => {
    limiter.check(request.params.id ?? "");
    return handler(request);
  };
}

/** What the sync handlers need from auth: the vault (with its retention limits), and the account for quota. */
export interface SyncRequestContext {
  vaultId: string;
  /** The vault row the request was authorized against — its history limits are policy. */
  vault: VaultRow;
  user: UserRow;
}

/**
 * Authenticate the `ck_` key, resolve the vault from `params.id`, check that this
 * account may use it, then run the handler.
 */
export function withSyncAuth(
  deps: SyncAuthDeps,
  handler: (
    request: Parameters<RouteHandler>[0],
    context: SyncRequestContext,
  ) => Response | Promise<Response>,
): RouteHandler {
  return async (request) => {
    const user = await authenticateUserHeader(
      request.headers.get("authorization"),
      deps.findUserByKey,
    );
    const vaultId = request.params.id;
    if (!vaultId) throw new NotFoundError("Vault");
    const vault = await deps.findVaultById(vaultId);
    if (!vault) throw new NotFoundError("Vault");
    if (!canAccessVault(vault, user.id)) throw new NotFoundError("Vault");
    return await handler(request, { vaultId, vault, user });
  };
}
