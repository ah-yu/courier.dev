import type { HistoryLimits } from "@courier/shared";
import {
  deleteFileVersionRowsByIds,
  isContentHashReferenced,
  listVersionRowsBeyondHistoryLimits,
} from "../db/repositories/file-versions";
import { deleteBlob } from "./blob-store";

/** What a vault-wide trim removed: version rows, and blobs nothing references any more. */
export interface TrimmedHistory {
  rows: number;
  blobs: number;
}

/**
 * Trim every chain of a vault to the limits now in force.
 *
 * A push trims the chain it appends to, which is enough while devices keep editing. This
 * is the other half: when a vault's limit is lowered, a chain nobody pushes again would
 * keep its excess history for ever, so the update handler runs this over the whole vault.
 * It is idempotent — nothing over the bound means one indexed scan and no writes — which
 * is what lets a retried `PATCH` finish a job whose first attempt failed.
 *
 * The rows go first (one transaction), then the blobs they were the last reference to:
 * a hash another chain still names stays, and the batch file is unlinked only with its
 * last row. A failed blob reclaim is not a failed update — the orphan sweep reclaims a
 * blob row no version names, and the trimmed rows are already gone.
 */
export async function trimVaultHistory(
  vaultId: string,
  limits: HistoryLimits,
): Promise<TrimmedHistory> {
  const removed = listVersionRowsBeyondHistoryLimits(vaultId, limits);
  if (removed.length === 0) return { rows: 0, blobs: 0 };

  deleteFileVersionRowsByIds(
    vaultId,
    removed.map((row) => row.id),
  );

  let blobs = 0;
  for (const contentHash of new Set(removed.map((row) => row.contentHash))) {
    try {
      if (await isContentHashReferenced(vaultId, contentHash)) continue;
      await deleteBlob(vaultId, contentHash);
      blobs += 1;
    } catch {
      // See the doc comment: the sweep is the backstop, and the rows are already gone.
    }
  }
  return { rows: removed.length, blobs };
}
