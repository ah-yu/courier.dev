/**
 * Device-local storage for a bound vault's encryption key.
 *
 * Kept **out of the plugin's `data.json`** on purpose: `data.json` lives inside
 * the vault (`<vault>/.obsidian/plugins/courier/`), so any vault-level syncing
 * (iCloud, Dropbox, Git, Obsidian Sync) would carry the key off the device and
 * defeat the content encryption. Obsidian's App-level `localStorage` is
 * per-app, per-vault *application data*: it never touches the vault directory
 * and is not part of any sync. `saveLocalStorage(key, null)` clears it.
 *
 * The stored secret is the **derived 32-byte AES key (base64)**, not the vault
 * password — the same tradeoff the headless CLI makes with
 * `encryptionKeyB64` in `~/.courier-cli/config.json` and the plugin's own
 * `.courier/remote.json`. The vault password cannot be changed server-side and
 * the `encryptionSalt` is immutable, so the key is never invalidated by a
 * password change.
 *
 * Available on desktop and mobile alike: both use the same `App` API
 * (`loadLocalStorage`/`saveLocalStorage`, `@since 1.8.7`).
 */

/** The subset of Obsidian's `App` this module needs — injectable for tests. */
export interface CredentialStoreHost {
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown): void;
}

/** A bound vault's locally persisted credential. */
export interface StoredVaultCredential {
  /** The vault this key belongs to, so a stale record is never used blindly. */
  vaultId: string;
  /** Base64 32-byte AES vault key. */
  encryptionKeyB64: string;
}

/**
 * The single App-level localStorage key holding the credential.
 *
 * One record is enough: a device can be bound to exactly one remote vault.
 * Switching vaults overwrites it.
 */
export const VAULT_CREDENTIAL_KEY = "courier-vault-credential";

/**
 * Read the stored credential for `vaultId`.
 *
 * Returns null — and drops the entry — when nothing is stored, when the value
 * is malformed, or when it belongs to a different vault. A dead credential must
 * degrade to "ask for the password", never to a broken start.
 */
export function loadVaultCredential(
  app: CredentialStoreHost,
  vaultId: string,
): StoredVaultCredential | null {
  let raw: unknown;
  try {
    raw = app.loadLocalStorage(VAULT_CREDENTIAL_KEY);
  } catch {
    // A host without a working localStorage must not break plugin startup.
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const candidate = raw as Partial<StoredVaultCredential>;
  if (
    typeof candidate.vaultId !== "string" ||
    typeof candidate.encryptionKeyB64 !== "string" ||
    candidate.encryptionKeyB64.length === 0
  ) {
    clearVaultCredential(app);
    return null;
  }
  if (candidate.vaultId !== vaultId) {
    // Bound to a different vault — not ours to reuse.
    clearVaultCredential(app);
    return null;
  }
  return { vaultId: candidate.vaultId, encryptionKeyB64: candidate.encryptionKeyB64 };
}

/** Persist the derived vault key for `vaultId` on this device. */
export function saveVaultCredential(
  app: CredentialStoreHost,
  vaultId: string,
  encryptionKeyB64: string,
): void {
  const credential: StoredVaultCredential = { vaultId, encryptionKeyB64 };
  try {
    app.saveLocalStorage(VAULT_CREDENTIAL_KEY, credential);
  } catch (err) {
    // Losing the convenience must not fail the unlock that just succeeded.
    console.error("Courier: failed to persist the vault key on this device:", err);
  }
}

/** Forget the stored credential (disconnect, vault deleted, key revoked). */
export function clearVaultCredential(app: CredentialStoreHost): void {
  try {
    app.saveLocalStorage(VAULT_CREDENTIAL_KEY, null);
  } catch (err) {
    console.error("Courier: failed to clear the stored vault key:", err);
  }
}
