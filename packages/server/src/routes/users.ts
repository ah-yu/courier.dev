import type { CreateUserRequest, UpdateUserRequest } from "@courier/shared";
import type { RouteHandlers } from "../http/contract-routes";
import type { WsHub } from "../handlers/ws-handlers";
import {
  createUser,
  deleteUser,
  listUsers,
  revealUserKey,
  updateUser,
} from "../handlers/users-handlers";
import { deleteVaultBlobs } from "../lib/blob-store";
import { logger as processLogger } from "../lib/log";
import { invalidateStorageUsage, invalidateUserStorageUsage } from "../lib/storage-usage";
import {
  deleteUser as deleteUserDb,
  findUserById,
  insertUser,
  listUsers as listUsersDb,
  updateUser as updateUserDb,
  userStorageBytes,
  userVaultCount,
} from "../lib/users-db";

/**
 * The host-key user surface: create, list, reveal a key, patch, delete.
 *
 * Every endpoint is `ak_` territory with the `users` scope; the adapter applies
 * `withHostAuth` from the registry's `auth`/`scope`, so a route cannot be added without
 * the check. This file is the rules and the wiring, not the HTTP shape.
 */
export function userHandlers(
  hub: WsHub,
): Pick<
  RouteHandlers,
  "users.list" | "users.create" | "users.revealKey" | "users.update" | "users.delete"
> {
  return {
    "users.list": async () => ({
      body: await listUsers(listUsersDb, userStorageBytes, userVaultCount),
    }),

    "users.create": async ({ body }) => ({
      status: 201,
      body: await createUser(body as CreateUserRequest, insertUser),
    }),

    "users.revealKey": async ({ params }) => ({
      body: await revealUserKey(params.id!, findUserById),
    }),

    "users.update": async ({ params, body }) => {
      const id = params.id!;
      const patch = body as UpdateUserRequest;
      // The handler owns the three "this would make the account unusable" rules (a cap
      // below usage, an allowance below the vaults that exist, an expiry in the past);
      // this route only supplies the facts they need.
      const response = await updateUser(id, patch, {
        find: findUserById,
        update: updateUserDb,
        usedBytes: userStorageBytes,
        vaultCount: userVaultCount,
      });
      // Disabling is an in-band stop, like deleting: the account keeps everything it
      // owns, so its sessions are told the key was **disabled** (a pause the same key
      // can be resumed from), never that it was revoked.
      if (patch.disabled === true) hub.revokeUserSessions(id, "disabled");
      return { body: response };
    },

    "users.delete": async ({ params }) => {
      const id = params.id!;
      // "Delete this key" is "delete this account": its vaults go with it. A vault left
      // behind would be an owner-less row every other account can use
      // (`canAccessVault`), while its blobs are charged to nobody and never reclaimed.
      const vaultIds = await deleteUser(id, findUserById, deleteUserDb);
      // The account is gone, so its devices are told **before** the slow part:
      // reclaiming megabytes of blobs must not delay the one message that stops them
      // writing into a vault that no longer exists.
      hub.revokeUserSessions(id, "deleted");
      invalidateStorageUsage();
      invalidateUserStorageUsage(id);
      // The rows are gone, so nothing names these directories any more: their bytes are
      // reclaimed the way a vault deletion reclaims them. A failure here is **not** a
      // failed delete — the account and its chains are already committed, and answering
      // 500 would leave the caller with a request that can only be retried into a 404 —
      // so it is logged and the bytes become the sweeper's problem.
      for (const vaultId of vaultIds) {
        try {
          await deleteVaultBlobs(vaultId);
        } catch (err) {
          processLogger.error(
            `reclaiming the blobs of deleted vault ${vaultId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      return { status: 204 };
    },
  };
}
