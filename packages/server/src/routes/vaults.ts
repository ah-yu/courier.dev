import type { CreateVaultRequest, UpdateVaultRequest } from "@courier/shared";
import type { RouteHandlers } from "../http/contract-routes";
import {
  createVault,
  deleteVaultOwned,
  getEncryptionSalt,
  getKeyCheck,
  listVisibleVaults as listVisibleVaultsHandler,
  updateVaultSettings,
} from "../handlers/vault-handlers";
import type { WsHub } from "../handlers/ws-handlers";
import { deleteVaultBlobs } from "../lib/blob-store";
import { trimVaultHistory } from "../lib/history-trim";
import { invalidateStorageUsage, invalidateUserStorageUsage } from "../lib/storage-usage";
import {
  deleteVaultById,
  findVaultById,
  insertVault,
  listVisibleVaults,
  updateVaultSettings as updateVaultSettingsRow,
} from "../db/repositories/vaults";

/**
 * Vault management over HTTP.
 *
 * The statements live in `db/repositories/vaults.ts` and the rules in
 * `handlers/vault-handlers.ts`; this file is the wiring — the adapter supplies auth,
 * body parsing, status codes and response validation from the registry.
 *
 * Four `ck_` endpoints and the two public crypto reads. The delete also tells every
 * subscriber the vault is gone, through the hub the listener owns.
 */
export function vaultHandlers(
  hub: WsHub,
): Pick<
  RouteHandlers,
  | "vaults.list"
  | "vaults.create"
  | "vaults.update"
  | "vaults.delete"
  | "vaults.encryptionSalt"
  | "vaults.keyCheck"
> {
  return {
    // GET — vaults visible to the authenticated user.
    "vaults.list": async ({ user }) => ({
      body: await listVisibleVaultsHandler(user!.id, listVisibleVaults),
    }),

    // POST — create a vault owned by the authenticated user.
    "vaults.create": async ({ user, body }) => {
      const current = user!;
      const input = body as CreateVaultRequest;
      return {
        status: 201,
        body: await createVault(
          { ...input, ownerUserId: current.id, maxVaults: current.maxVaults },
          insertVault,
        ),
      };
    },

    // PATCH — rename the vault and/or change its retention limits (owner only).
    "vaults.update": async ({ user, params, body }) => {
      const current = user!;
      const id = params.id!;
      const patch = body as UpdateVaultRequest;
      const response = await updateVaultSettings(
        id,
        current.id,
        patch,
        findVaultById,
        updateVaultSettingsRow,
        // A lowered limit has to reach chains no device pushes again; the handler
        // decides when, this is how (rows, then the blobs only they referenced).
        trimVaultHistory,
      );
      // The limits are the vault's: every device subscribed to it has to see the new
      // numbers without reopening its settings page. A rename alone changes nothing a
      // page shows live, so it does not broadcast — and it trims nothing either, so the
      // cached usage only has to be dropped when a limit was stated.
      if (
        patch.historyLimitDocuments !== undefined ||
        patch.historyLimitAttachments !== undefined
      ) {
        // The trim freed blob bytes, so the cached per-user usage is stale.
        invalidateUserStorageUsage(current.id);
        hub.broadcastVaultSettings(id, {
          documents: response.historyLimitDocuments,
          attachments: response.historyLimitAttachments,
        });
      }
      return { body: response };
    },

    // DELETE — delete a vault the user owns.
    "vaults.delete": async ({ user, params }) => {
      const id = params.id!;
      await deleteVaultOwned(id, user!.id, findVaultById, deleteVaultById);
      // The bytes go with the vault: a deleted vault is never swept again, so leaving
      // its blobs behind would mean the space a host freed stays occupied forever. Both
      // cached usage measurements are stale afterwards.
      await deleteVaultBlobs(id);
      invalidateStorageUsage();
      invalidateUserStorageUsage(user!.id);
      // In-band broadcast: every subscriber of this vault learns it is gone from the
      // process that owns the session registry, without a CLI hop.
      hub.broadcastVaultDeleted(id);
      return { status: 204 };
    },

    // The two public reads: only crypto material, no key.
    "vaults.encryptionSalt": async ({ params }) => ({
      body: await getEncryptionSalt(params.id!, findVaultById),
    }),

    "vaults.keyCheck": async ({ params }) => ({
      body: await getKeyCheck(params.id!, findVaultById),
    }),
  };
}
