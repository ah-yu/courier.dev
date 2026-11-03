import type {
  CreateVaultResponse,
  ListVaultsResponse,
  UpdateVaultRequest,
  VaultEncryptionSaltResponse,
  VaultKeyCheckResponse,
  VaultSettingsResponse,
} from "@courier/shared";
import { normalizeHistoryLimit, type HistoryLimits } from "@courier/shared";
import { generateVaultId } from "../lib/token";
import { NotFoundError, VaultLimitReachedError } from "../lib/errors";
import { canAccessVault } from "../lib/vault-access";

// ── Action types (db operations injected by the caller) ──

/** A vault row as the handlers see it, with both timestamps already `Date`. */
export interface VaultRow {
  id: string;
  name: string;
  ownerUserId: string | null;
  encryptionSalt: string | null;
  keyCheck: string | null;
  /** Versions kept for each markdown note and canvas file. */
  historyLimitDocuments: number;
  /** Versions kept for every other file. */
  historyLimitAttachments: number;
  createdAt: Date;
  updatedAt: Date;
}

export type InsertVaultFn = (data: {
  id: string;
  name: string;
  encryptionSalt: string;
  keyCheck: string;
  ownerUserId: string | null;
  /** The owner's allowance (`0` = unlimited); the insert enforces it atomically. */
  maxVaults: number;
}) => Promise<
  | {
      createdAt: Date;
      historyLimitDocuments: number;
      historyLimitAttachments: number;
    }
  | undefined
>;

export type FindVaultByIdFn = (id: string) => Promise<VaultRow | undefined>;

export type DeleteVaultByIdFn = (id: string) => Promise<void>;

/** List vaults a user may access: their own or legacy (owner-less) ones. */
export type ListVisibleVaultsFn = (userId: string) => Promise<
  Array<{
    id: string;
    name: string;
    createdAt: Date;
    historyLimitDocuments: number;
    historyLimitAttachments: number;
  }>
>;

export type UpdateVaultSettingsFn = (
  id: string,
  patch: UpdateVaultRequest,
) => Promise<VaultSettingsResponse | undefined>;

/**
 * Trim every chain of a vault to the limits now in force, answering what it removed.
 *
 * Injected because a lowered limit has to reach chains no device may push again; the
 * handler owns "when", `lib/history-trim.ts` owns "how" (rows, then blobs).
 */
export type TrimVaultHistoryFn = (
  vaultId: string,
  limits: HistoryLimits,
) => Promise<{ rows: number; blobs: number }>;

// ── Create Vault ──

interface CreateVaultInput {
  name: string;
  encryptionSalt: string;
  keyCheck: string;
  ownerUserId: string | null;
  /** How many vaults the owner may have (`0` = unlimited). */
  maxVaults: number;
}

/**
 * Create a vault, within its owner's allowance.
 *
 * The count and the insert happen in one transaction inside `insertVault`, so
 * two requests for the same key cannot both see a free slot; the `undefined`
 * result is "the allowance is full", not a database failure.
 */
export async function createVault(
  input: CreateVaultInput,
  insertVault: InsertVaultFn,
): Promise<CreateVaultResponse> {
  const id = generateVaultId();

  const created = await insertVault({
    id,
    name: input.name,
    encryptionSalt: input.encryptionSalt,
    keyCheck: input.keyCheck,
    ownerUserId: input.ownerUserId,
    maxVaults: input.maxVaults,
  });
  if (!created) {
    throw new VaultLimitReachedError(
      `This user key already owns ${input.maxVaults} vault${input.maxVaults === 1 ? "" : "s"}, ` +
        `its limit. Raise maxVaults on the account to create another.`,
    );
  }

  return {
    id,
    name: input.name,
    createdAt: created.createdAt.toISOString(),
    historyLimitDocuments: created.historyLimitDocuments,
    historyLimitAttachments: created.historyLimitAttachments,
  };
}

// ── Get Encryption Salt ──

export async function getEncryptionSalt(
  id: string,
  findById: FindVaultByIdFn,
): Promise<VaultEncryptionSaltResponse> {
  const vault = await findById(id);
  if (!vault) {
    throw new NotFoundError("Vault");
  }
  if (!vault.encryptionSalt) {
    throw new NotFoundError("Encryption salt");
  }
  return { encryptionSalt: vault.encryptionSalt };
}

// ── Get Key Check ──

export async function getKeyCheck(
  id: string,
  findById: FindVaultByIdFn,
): Promise<VaultKeyCheckResponse> {
  const vault = await findById(id);
  if (!vault) {
    throw new NotFoundError("Vault");
  }
  if (!vault.keyCheck) {
    throw new NotFoundError("Key check");
  }
  return { keyCheck: vault.keyCheck };
}

// ── List Vaults ──

/** List vaults visible to a user: their own plus legacy (owner-less) vaults. */
export async function listVisibleVaults(
  userId: string,
  listFn: ListVisibleVaultsFn,
): Promise<ListVaultsResponse> {
  const vaults = await listFn(userId);
  return {
    vaults: vaults.map((v) => ({
      id: v.id,
      name: v.name,
      createdAt: v.createdAt.toISOString(),
      historyLimitDocuments: v.historyLimitDocuments,
      historyLimitAttachments: v.historyLimitAttachments,
    })),
  };
}

async function requireManageableVault(
  id: string,
  userId: string,
  findFn: FindVaultByIdFn,
): Promise<VaultRow> {
  const vault = await findFn(id);
  if (!vault) {
    throw new NotFoundError("Vault");
  }
  // A vault this account cannot see is answered exactly like one that does not exist:
  // its existence is not this account's business, and the sync routes give the same
  // answer so a client never reads "not yours" as "your key is dead".
  if (!canAccessVault(vault, userId)) {
    throw new NotFoundError("Vault");
  }
  return vault;
}

// ── Rename / retention update ──

/**
 * Update a vault's name and/or its history limits, then trim what a lowered limit
 * orphaned.
 *
 * The limits are **vault-level**, so this is the one write path every device of the vault
 * uses (the plugin's settings page and the CLI's `vault update`); the server applies the
 * new numbers to the next push from any device, and the trim below applies them to the
 * chains already stored.
 *
 * **Only the fields the request states are written.** The row is read here for access
 * control and for the fallback a nonsense value needs, but writing both limits back would
 * make two PATCHes that touch different halves race: each read the other's old value at
 * `requireManageableVault` and would write it back over the newer one (the same for a
 * rename racing a limit change). The repository's `returning` is what tells the caller
 * what the row now holds, and the trim uses that, not the pre-update row.
 *
 * The trim runs whenever the request states a limit — not only when the value went down.
 * It is idempotent and cheap when nothing is over the bound, and this way a PATCH retried
 * after a failed trim (the update itself had already committed) still finishes the job;
 * keying it on "the value decreased" would make that retry a silent no-op.
 */
export async function updateVaultSettings(
  id: string,
  userId: string,
  patch: UpdateVaultRequest,
  findFn: FindVaultByIdFn,
  updateFn: UpdateVaultSettingsFn,
  trimFn: TrimVaultHistoryFn,
): Promise<VaultSettingsResponse> {
  const vault = await requireManageableVault(id, userId, findFn);
  const updated = await updateFn(id, {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.historyLimitDocuments === undefined
      ? {}
      : {
          historyLimitDocuments: normalizeHistoryLimit(
            patch.historyLimitDocuments,
            vault.historyLimitDocuments,
          ),
        }),
    ...(patch.historyLimitAttachments === undefined
      ? {}
      : {
          historyLimitAttachments: normalizeHistoryLimit(
            patch.historyLimitAttachments,
            vault.historyLimitAttachments,
          ),
        }),
  });

  const statesLimit =
    patch.historyLimitDocuments !== undefined || patch.historyLimitAttachments !== undefined;
  if (!updated) {
    // Deleted between the access-control read and the update: answer like any other
    // missing vault instead of dereferencing undefined (which would be a 500).
    throw new NotFoundError("Vault");
  }
  if (statesLimit) {
    await trimFn(id, {
      documents: updated.historyLimitDocuments,
      attachments: updated.historyLimitAttachments,
    });
  }
  return updated;
}

// ── Delete Vault ──

export async function deleteVaultOwned(
  id: string,
  userId: string,
  findFn: FindVaultByIdFn,
  deleteById: DeleteVaultByIdFn,
): Promise<void> {
  await requireManageableVault(id, userId, findFn);
  await deleteById(id);
}
