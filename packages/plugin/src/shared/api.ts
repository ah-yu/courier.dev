import type {
  CreateVaultResponse,
  ListVaultsResponse,
  UpdateVaultRequest,
  UserSummary,
  VaultEncryptionSaltResponse,
  VaultKeyCheckResponse,
  VaultSettingsResponse,
  ListDeletedFilesResponse,
  ClearDeletedResponse,
  FileVersionHistoryResponse,
  SyncPullResponse,
} from "@courier/shared";
import { DEFAULT_SERVER_URL, httpToWsUrl } from "@courier/shared";
import type { SyncApi } from "@courier/engine";
import type { CourierSettings } from "./settings";

/**
 * The plugin's network action types.
 *
 * The implementations live in `shared/actions.ts` (over the shared HTTP client),
 * so this module is types plus the two URL helpers — it stays importable without
 * the Obsidian runtime.
 */

export { DEFAULT_SERVER_URL };

/**
 * Resolve the server REST base URL from settings.
 * Appending the API prefix is NOT done here — the shared client appends `/api`.
 */
export function getServerUrl(settings: CourierSettings): string {
  return settings.serverUrl ?? DEFAULT_SERVER_URL;
}

/** Derive the WebSocket base URL from the server URL (http→ws, https→wss). */
export function getWsUrl(settings: CourierSettings): string {
  return httpToWsUrl(getServerUrl(settings));
}

// ── Vault action types ──

/** Action that creates a vault on the remote server (only public crypto material sent). */
export type CreateVaultAction = (
  name: string,
  encryptionSalt: string,
  keyCheck: string,
) => Promise<CreateVaultResponse>;

/** Action that lists all the user's remote vaults. */
export type ListVaultsAction = () => Promise<ListVaultsResponse>;

/**
 * Action that changes a vault's name and/or its retention limits.
 *
 * The limits are **vault-level** server state, so this is the settings page's write path:
 * the number the server trims with, shared by every device of the vault.
 */
export type UpdateVaultAction = (
  id: string,
  patch: UpdateVaultRequest,
) => Promise<VaultSettingsResponse>;

/**
 * Action that asks the server which account the configured user key belongs to.
 *
 * The plugin holds only a `ck_` key, and the name is not derivable from it — the
 * account row would have nothing to show without this read. It doubles as the
 * cheapest proof that the key still works.
 */
export type GetMeAction = () => Promise<UserSummary>;

/** Action that fetches the encryption salt for a vault. */
export type GetEncryptionSaltAction = (id: string) => Promise<VaultEncryptionSaltResponse>;

/** Action that fetches the key-check canary ciphertext for local password verification. */
export type GetKeyCheckAction = (id: string) => Promise<VaultKeyCheckResponse>;

/** Action that deletes a vault the user owns. */
export type DeleteVaultAction = (id: string) => Promise<void>;

// ── Sync / version history action types ──

/** Action that fetches remote version chains for given files. */
export type SyncPullAction = (
  vaultId: string,
  files: Array<{ fileId: string }>,
) => Promise<SyncPullResponse>;

/**
 * Action that fetches the stored ciphertext of a specific version by content hash:
 * `iv ‖ AES-256-GCM ciphertext ‖ tag`, exactly as the store holds it.
 */
export type GetVersionContentAction = (vaultId: string, contentHash: string) => Promise<Uint8Array>;

/**
 * Action that fetches one inclusive byte range of a version's chunk region.
 *
 * A version above 8 MiB is stored as chunks; its preview reads them back with this
 * instead of the whole-content action (see `shared/version-content.ts`).
 */
export type GetVersionContentRangeAction = (
  vaultId: string,
  contentHash: string,
  start: number,
  end: number,
) => Promise<Uint8Array>;

/** Action that fetches version history for a single file. */
export type GetFileVersionHistoryAction = (
  vaultId: string,
  fileId: string,
) => Promise<FileVersionHistoryResponse>;

/** Action that lists deleted files for the recycle bin. */
export type ListDeletedAction = (vaultId: string) => Promise<ListDeletedFilesResponse>;

/**
 * Action that permanently clears a vault's recycle bin — every chain whose last
 * action is `delete`, plus the blobs only those chains referenced. Irreversible:
 * callers confirm first.
 */
export type ClearDeletedAction = (vaultId: string) => Promise<ClearDeletedResponse>;

/**
 * The set of network actions a plugin instance wires once in `main.ts` and
 * hands to UI panels / the engine host. Tests inject plain `vi.fn()` mocks
 * instead of these wiring implementations (no real network, no module mocking).
 */
export interface PluginActions {
  createVault: CreateVaultAction;
  listVaults: ListVaultsAction;
  updateVault: UpdateVaultAction;
  getMe: GetMeAction;
  getEncryptionSalt: GetEncryptionSaltAction;
  getKeyCheck: GetKeyCheckAction;
  deleteVault: DeleteVaultAction;
  listDeleted: ListDeletedAction;
  clearDeleted: ClearDeletedAction;
  getFileVersionHistory: GetFileVersionHistoryAction;
  getVersionContent: GetVersionContentAction;
  getVersionContentRange: GetVersionContentRangeAction;
  /** Builds the engine's network layer for a given user key. */
  buildSyncApi: (userKey: string) => SyncApi;
}
