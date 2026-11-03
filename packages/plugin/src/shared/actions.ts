import { createCourierClient, type CourierClient, type HttpTransport } from "@courier/shared";
import { createSyncApi } from "@courier/engine";
import { getServerUrl, type PluginActions } from "./api";
import type { CourierSettings } from "./settings";

/**
 * The plugin's network layer, built on the shared HTTP client.
 *
 * This module deliberately does **not** import `obsidian`: the transport is
 * injected, so the whole action surface is unit-testable with a plain function
 * (`actions.test.ts`), and `main.ts` keeps only the ~20-line adapter that turns
 * `requestUrl` into a transport. Before this split, 15 hand-written `requestUrl`
 * blocks lived in `main.ts`, which pulls in the Obsidian runtime and therefore
 * could not be imported by a unit test at all.
 */
export interface PluginActionContext {
  /** How a request is performed — an Obsidian `requestUrl` adapter in production. */
  transport: HttpTransport;
  getSettings: () => CourierSettings;
  getUserKey: () => string | null;
}

export function createPluginActions(ctx: PluginActionContext): PluginActions {
  /** A client bound to one key: the engine host is handed the key it must push under. */
  const clientFor = (getUserKey: () => string | null): CourierClient =>
    createCourierClient({
      // Read per request: changing the server address in the settings page applies
      // to the next call without reloading the plugin.
      baseUrl: () => getServerUrl(ctx.getSettings()),
      getUserKey,
      transport: ctx.transport,
    });

  const client = clientFor(ctx.getUserKey);

  return {
    createVault: (name, encryptionSalt, keyCheck) =>
      client.createVault(name, encryptionSalt, keyCheck),
    listVaults: () => client.listVaults(),
    updateVault: (id, patch) => client.updateVault(id, patch),
    getMe: () => client.getMe(),
    getEncryptionSalt: (id) => client.getEncryptionSalt(id),
    getKeyCheck: (id) => client.getKeyCheck(id),
    deleteVault: (id) => client.deleteVault(id),
    listDeleted: (vaultId) => client.listDeleted(vaultId),
    clearDeleted: (vaultId) => client.clearDeleted(vaultId),
    getFileVersionHistory: (vaultId, fileId) => client.getFileVersionHistory(vaultId, fileId),
    getVersionContent: (vaultId, contentHash) => client.getVersionContent(vaultId, contentHash),
    getVersionContentRange: (vaultId, contentHash, start, end) =>
      client.getVersionContentRange(vaultId, contentHash, start, end),
    // The label is read per push, so renaming the device applies immediately.
    buildSyncApi: (userKey) =>
      createSyncApi(
        clientFor(() => userKey),
        () => ctx.getSettings().deviceName,
      ),
  };
}
