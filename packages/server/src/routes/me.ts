import { toUserSummary } from "../handlers/users-handlers";
import { userStorageBytes, userVaultCount } from "../lib/users-db";
import type { RouteHandlers } from "../http/contract-routes";

/**
 * "Which account does this user key belong to?"
 *
 * A client that holds only a `ck_` key has no other way to name the account it is
 * signed in as — the admin surface (`/api/users`) is host-key territory and lists
 * every user. This answers for the presented key only, and never returns the key
 * itself, so it is also the cheapest way to prove the key still works.
 *
 * The adapter's `withUserAuth` runs the contract check and the key check; the handler
 * only builds the answer.
 */
export function meHandlers(): Pick<RouteHandlers, "me.get"> {
  return {
    "me.get": async ({ user }) => {
      const current = user!;
      return {
        body: toUserSummary(
          current,
          await userStorageBytes(current.id),
          await userVaultCount(current.id),
        ),
      };
    },
  };
}
