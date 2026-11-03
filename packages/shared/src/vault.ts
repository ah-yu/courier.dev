import type { ApiErrorCode } from "./errors";
import type { HistoryLimits } from "./sync";

/**
 * Fixed plaintext encrypted with the vault's AES-256-GCM key at creation time.
 * Clients verify a password locally by decrypting the stored keyCheck and
 * comparing with this value — the password itself never reaches the server.
 * Must match the engine's `verifyKeyCheck` in packages/engine/src/crypto.ts and
 * the server's `vaults.key_check` column.
 */
export const KEY_CHECK_VALUE = "courier-key-check";

/**
 * How many versions of each file the **vault** keeps — the server-side retention
 * policy, shared by every device of that vault.
 *
 * Stored on the vault row (not on a device, not on the account): a limit changed on one
 * device applies to the next push from any device, because the number the trim uses is
 * read from the vault by the server, not stated by the pusher. The pusher only states the
 * file's **kind** (`files[].historyKind` in the push frame), which is the one thing the
 * server cannot see inside an encrypted path.
 */
export interface VaultHistorySettings {
  /** Versions kept for each markdown note and `.canvas` file. */
  historyLimitDocuments: number;
  /** Versions kept for every other file (images, audio, video, PDFs, …). */
  historyLimitAttachments: number;
}

/** A vault as the API lists it: identity, name and the two retention limits. */
export type VaultSummary = {
  id: string;
  name: string;
  createdAt: string;
} & VaultHistorySettings;

export interface CreateVaultResponse {
  id: string;
  name: string;
  createdAt: string;
  historyLimitDocuments: number;
  historyLimitAttachments: number;
}

export interface VaultKeyCheckResponse {
  /** base64(iv || ciphertext || authTag) of the fixed key-check plaintext, AES-256-GCM. */
  keyCheck: string;
}

export interface VaultEncryptionSaltResponse {
  encryptionSalt: string;
}

export interface ListVaultsResponse {
  vaults: VaultSummary[];
}

/**
 * `PATCH /api/vaults/:id`: rename the vault and/or change its retention limits.
 *
 * Every field is optional, but a body with none of them is refused — an empty update is
 * a caller that built its request wrong, not a no-op to acknowledge.
 */
export interface UpdateVaultRequest {
  name?: string;
  historyLimitDocuments?: number;
  historyLimitAttachments?: number;
}

/** The vault after an update (or read back), with the limits now in force. */
export type VaultSettingsResponse = {
  id: string;
  name: string;
} & VaultHistorySettings;

/** A vault's two limits as the `HistoryLimits` record the trim and the UI work with. */
export function historyLimitsOf(vault: VaultHistorySettings): HistoryLimits {
  return { documents: vault.historyLimitDocuments, attachments: vault.historyLimitAttachments };
}

export type WsClientMessage =
  | {
      type: "subscribe";
      vaultId: string;
      userKey: string;
      /**
       * The client's self-declared label, passed on to peers in `file_pushed` so a
       * notification can say which machine made the change. Display metadata only:
       * nothing is registered or verified against it.
       */
      deviceName?: string;
    }
  | { type: "unsubscribe"; vaultId: string }
  | { type: "pong" };

export type WsServerMessage =
  | { type: "subscribe_success"; vaultId: string; sessionId: string }
  | {
      type: "subscribe_error";
      vaultId: string;
      message: string;
      /**
       * Why the subscription was refused, in the API's own codes.
       *
       * The message is for a log line; this is what a client matches on. A terminal
       * credential code (`KEY_EXPIRED`, `KEY_DISABLED`, `UNAUTHORIZED`) and `NOT_FOUND`
       * (the vault is gone) end the binding, while anything else is worth retrying.
       * Absent when the refusal came from somewhere that has no code to give.
       */
      code?: ApiErrorCode;
    }
  | { type: "unsubscribed"; vaultId: string }
  | { type: "vault_deleted"; vaultId: string }
  /**
   * The vault's retention limits changed — on another device, or through the API.
   *
   * Sent to every session subscribed to the vault, so an open settings page shows the new
   * numbers without being reopened. The limits are display state for the client (the
   * server applies them itself when it trims); the event is not a sync instruction.
   */
  | { type: "vault_settings"; vaultId: string; historyLimits: HistoryLimits }
  | { type: "api_key_revoked"; vaultId: string }
  /**
   * The account was disabled by the host: the key, its vaults and their data are all
   * still there, but the key authenticates nothing until it is enabled again.
   *
   * Deliberately distinct from `api_key_revoked`: a revoked key is gone for good, so
   * the client drops the binding, while a disabled one is a pause the same key can be
   * resumed from.
   */
  | { type: "api_key_disabled"; vaultId: string }
  | { type: "ping" }
  | {
      type: "file_pushed";
      vaultId: string;
      fileId: string;
      versionId: string;
      /** Label the pushing client stated for itself (for display). */
      deviceName?: string;
    };
