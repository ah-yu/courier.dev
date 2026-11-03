import { z } from "zod";
import { json, withAccessLog, type RouteHandler, type RouteTable } from "../http/router";
import { withErrorMapping, withUserAuth } from "../http/auth";
import { parseJson } from "../http/guards";
import {
  deleteVaultById,
  findVaultById,
  insertVault,
  listVisibleVaults,
  updateVaultSettings as updateVaultSettingsRow,
} from "../db/repositories/vaults";
import type { WsHub } from "../handlers/ws-handlers";
import { findUserByKey } from "../lib/users-db";
import { invalidateStorageUsage, invalidateUserStorageUsage } from "../lib/storage-usage";
import { deleteVaultBlobs } from "../lib/blob-store";
import { trimVaultHistory } from "../lib/history-trim";
import { MAX_HISTORY_LIMIT } from "@courier/shared";
import {
  createVault,
  getEncryptionSalt,
  getKeyCheck,
  listVisibleVaults as listVisibleVaultsHandler,
  updateVaultSettings,
  deleteVaultOwned,
} from "../handlers/vault-handlers";
import { config } from "../config";
import { logger as processLogger } from "../lib/log";
import type { Logger } from "../lib/logger";

/**
 * Vault management over HTTP.
 *
 * The statements live in `db/repositories/vaults.ts` and the rules in
 * `handlers/vault-handlers.ts`; this file is schemas, wiring and status codes — which
 * is what lets a lint rule keep `drizzle-orm` out of it.
 *
 * The fourth module on the Bun route table: four `ck_` endpoints and the two
 * public crypto reads. The delete also tells every subscriber the vault is gone,
 * through the hub the listener owns.
 */

const createVaultSchema = z.object({
  name: z.string().min(1).max(255),
  encryptionSalt: z.string().min(1).max(128),
  keyCheck: z.string().min(1).max(256),
});

/**
 * `PATCH /api/vaults/:id`: rename and/or change the vault's retention limits.
 *
 * Every field is optional, but an empty body is refused — a caller that built its request
 * wrong should hear about it rather than receive a no-op `200`. The limits are the
 * **vault's** (shared by every device), which is why this is the edit path both the
 * plugin's settings page and the CLI use.
 */
const updateVaultSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    historyLimitDocuments: z.number().int().min(1).max(MAX_HISTORY_LIMIT).optional(),
    historyLimitAttachments: z.number().int().min(1).max(MAX_HISTORY_LIMIT).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.historyLimitDocuments !== undefined ||
      body.historyLimitAttachments !== undefined,
    { message: "at least one of name, historyLimitDocuments, historyLimitAttachments is required" },
  );

export function vaultRoutes(hub: WsHub, logger: Logger = processLogger): RouteTable {
  /** Access log → error mapping, the pair every endpoint carries. */
  const wrap = (handler: RouteHandler): RouteHandler =>
    withAccessLog(logger, withErrorMapping(handler, logger), config.LOG_SLOW_MS);

  /** The same pair behind the `ck_` user-key check. */
  const authed = (handler: Parameters<typeof withUserAuth>[1]): RouteHandler =>
    wrap(withUserAuth(findUserByKey, handler));

  return {
    // GET — vaults visible to the authenticated user.
    "/api/vaults": {
      GET: authed(async (_request, user) =>
        json(await listVisibleVaultsHandler(user.id, listVisibleVaults)),
      ),
      // POST — create a vault owned by the authenticated user.
      POST: authed(async (request, user) => {
        const body = await parseJson(request, createVaultSchema);
        const response = await createVault(
          { ...body, ownerUserId: user.id, maxVaults: user.maxVaults },
          insertVault,
        );
        return json(response, 201);
      }),
    },
    "/api/vaults/:id": {
      // PATCH — rename the vault and/or change its retention limits (owner only).
      PATCH: authed(async (request, user) => {
        const body = await parseJson(request, updateVaultSchema);
        const response = await updateVaultSettings(
          request.params.id!,
          user.id,
          body,
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
          body.historyLimitDocuments !== undefined ||
          body.historyLimitAttachments !== undefined
        ) {
          // The trim freed blob bytes, so the cached per-user usage is stale.
          invalidateUserStorageUsage(user.id);
          hub.broadcastVaultSettings(request.params.id!, {
            documents: response.historyLimitDocuments,
            attachments: response.historyLimitAttachments,
          });
        }
        return json(response);
      }),
      // DELETE — delete a vault the user owns.
      DELETE: authed(async (request, user) => {
        const id = request.params.id!;
        await deleteVaultOwned(id, user.id, findVaultById, deleteVaultById);
        // The bytes go with the vault: a deleted vault is never swept again, so
        // leaving its blobs behind would mean the space a host freed stays occupied
        // forever. Both cached usage measurements are stale afterwards.
        await deleteVaultBlobs(id);
        invalidateStorageUsage();
        invalidateUserStorageUsage(user.id);
        // In-band broadcast: every subscriber of this vault learns it is gone from
        // the process that owns the session registry, without a CLI hop.
        hub.broadcastVaultDeleted(id);
        return new Response(null, { status: 204 });
      }),
    },
    // The two public reads: only crypto material, no key.
    "/api/vaults/:id/encryption-salt": {
      GET: wrap(async (request) =>
        json(await getEncryptionSalt(request.params.id!, findVaultById)),
      ),
    },
    "/api/vaults/:id/key-check": {
      GET: wrap(async (request) => json(await getKeyCheck(request.params.id!, findVaultById))),
    },
  };
}
