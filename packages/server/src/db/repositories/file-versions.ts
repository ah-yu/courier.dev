import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Statement } from "bun:sqlite";
import type { HistoryLimits, SyncAction } from "@courier/shared";
import { db, sqlite } from "../../db";
import { fileVersions } from "../../db/schema";
import type {
  DbVersionRow,
  DeleteFileVersionsByFileIdsFn,
  GetLatestVersionIdsFn,
  GetVersionChainFn,
  IsContentHashReferencedFn,
  ListDeletedChainsFn,
  ListDeletedFileIdsFn,
  ListFileHeadsByVaultIdFn,
  ListFilesByVaultIdFn,
  TryInsertFileVersionsFn,
} from "../../handlers/sync-handlers";

/**
 * Every statement the sync API makes about version rows.
 *
 * The handlers own the protocol and take these as injected functions; this module
 * is the only place that knows SQL, which is what keeps a handler test free of a
 * database. Two things it must never get wrong:
 *
 * - **the chain order** is `(created_at, rowid)`, oldest first. `created_at` is
 *   millisecond ISO text, so two pushes in the same instant are ordered by
 *   `rowid`; every reader of "the head" — the conditional insert, the push
 *   pre-check, the pull, retention pruning — has to agree, or a client whose
 *   `baseVersionId` came from one of them is refused forever by another.
 * - **the conditional insert is one transaction per batch**, because the blob writes
 *   between the handler's pre-check and the insert are real asynchronous I/O (see
 *   {@link TryInsertFileVersionsFn}).
 */

/** The version columns every read selects, so the row shape is written once. */
const versionColumns = {
  versionId: fileVersions.versionId,
  contentHash: fileVersions.contentHash,
  encryptedPath: fileVersions.encryptedPath,
  action: fileVersions.action,
  sizeBytes: fileVersions.sizeBytes,
  mtimeMs: fileVersions.mtimeMs,
  deviceName: fileVersions.deviceName,
  createdAt: fileVersions.createdAt,
};

/** A row as the driver hands it back: `created_at` is the ISO text it stores. */
interface RawVersionRow {
  versionId: string;
  contentHash: string;
  encryptedPath: string;
  action: string;
  sizeBytes: number;
  mtimeMs: number;
  deviceName: string | null;
  createdAt: string;
}

function toVersionRow(row: RawVersionRow): DbVersionRow {
  return {
    ...row,
    action: row.action as SyncAction,
    createdAt: new Date(row.createdAt),
  };
}

/**
 * How many ids one `IN (…)` list carries.
 *
 * Well under SQLite's parameter limit, and the loops that use it run inside one
 * transaction, so a vault with a very large recycle bin is still cleared
 * atomically rather than statement by statement.
 */
const ID_CHUNK = 500;

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** `?, ?, …` for an `IN` list of `count` ids. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

// ── The conditional insert ──

/**
 * Append a batch of versions, one transaction for all of them.
 *
 * Each row is still checked against its own chain's head inside the transaction — the
 * check is per row, only the commit is per batch. The callback is synchronous, so the
 * whole batch runs in one tick and stays atomic against another writer's push.
 *
 * A batch is a single `BEGIN … COMMIT`: at 100 files that is one fsync instead of a
 * hundred, which is where most of a first bind's server time used to go (see
 * `docs/first-bind-performance.md`).
 *
 * The same transaction also **trims** each chain to the limit the handler resolved from
 * the vault's two values and the version's kind — the newest N rows, the row just
 * appended included — and answers the content hashes of the rows it removed, so the
 * caller can reclaim the blobs those rows were the last reference to (`handleSyncPush`).
 * Doing it here rather than in a later pass is what makes the limit hold: the chain never
 * outgrows N between a push and a sweep, and nothing else can append to it while the
 * insert runs.
 */
export const tryInsertFileVersions: TryInsertFileVersionsFn = async (rows) => {
  if (rows.length === 0) return [];
  // Prepared once per batch, not once per row: a bind pushes 100 versions in one request,
  // and compiling the trim statement 100 times is the kind of per-row cost the batch
  // path exists to avoid.
  const trimStatement = sqlite.prepare(
    `SELECT id, content_hash AS contentHash
     FROM file_versions
     WHERE vault_id = ? AND file_id = ?
     ORDER BY created_at DESC, rowid DESC
     LIMIT -1 OFFSET ?`,
  );
  return db.transaction((tx) =>
    rows.map((data) => {
      const { baseVersionId, historyLimit, ...row } = data;
      const head = tx
        .select({ versionId: fileVersions.versionId })
        .from(fileVersions)
        .where(and(eq(fileVersions.vaultId, row.vaultId), eq(fileVersions.fileId, row.fileId)))
        .orderBy(desc(fileVersions.createdAt), desc(sql`rowid`))
        .limit(1)
        .get();
      if (head !== undefined && head.versionId !== baseVersionId) {
        return { status: "stale_base" as const, currentVersionId: head.versionId };
      }
      tx.insert(fileVersions).values(row).run();

      // One index scan of this chain, oldest rows skipped: under the limit it finds
      // nothing and costs a handful of index entries.
      const removed = rowsBeyondHistoryLimit(trimStatement, row.vaultId, row.fileId, historyLimit);
      if (removed.length === 0) return { status: "ok" as const };
      for (const batch of chunks(
        removed.map((entry) => entry.id),
        ID_CHUNK,
      )) {
        tx.delete(fileVersions).where(inArray(fileVersions.id, batch)).run();
      }
      return {
        status: "ok" as const,
        prunedContentHashes: [...new Set(removed.map((entry) => entry.contentHash))],
      };
    }),
  );
};

/**
 * The rows of one chain beyond its newest `historyLimit`.
 *
 * Ordered by `(created_at, rowid)` descending — the order every reader of the chain
 * calls "newest", so the rows kept are the ones the head check and the pull treat as
 * the current ones — and skipping the newest `historyLimit` of them. `LIMIT -1` is
 * SQLite's "no upper bound": every row past the offset is answered. The caller prepares
 * the statement once per batch (see {@link tryInsertFileVersions}).
 */
function rowsBeyondHistoryLimit(
  statement: Statement,
  vaultId: string,
  fileId: string,
  historyLimit: number,
): Array<{ id: string; contentHash: string }> {
  return statement.all(vaultId, fileId, Math.max(1, Math.floor(historyLimit))) as Array<{
    id: string;
    contentHash: string;
  }>;
}

// ── Reads ──

export const getVersionChain: GetVersionChainFn = async (vaultId, fileId) => {
  const rows = await db
    .select(versionColumns)
    .from(fileVersions)
    .where(and(eq(fileVersions.vaultId, vaultId), eq(fileVersions.fileId, fileId)))
    .orderBy(asc(fileVersions.createdAt), asc(sql`rowid`));
  return rows.map(toVersionRow);
};

/**
 * The head of every chain in `fileIds`, in one statement per {@link ID_CHUNK} ids.
 *
 * The window function picks the same row the conditional insert checks
 * (`created_at` then `rowid`, descending), so a batch whose pre-check passes is
 * still checked by the transaction that actually writes.
 */
export const getLatestVersionIds: GetLatestVersionIdsFn = async (vaultId, fileIds) => {
  const heads = new Map<string, string>();
  const unique = [...new Set(fileIds)];
  if (unique.length === 0) return heads;

  const statement = (count: number) =>
    sqlite.prepare(
      `SELECT file_id AS fileId, version_id AS versionId FROM (
         SELECT file_id, version_id,
                ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC, rowid DESC) AS rn
         FROM file_versions
         WHERE vault_id = ? AND file_id IN (${placeholders(count)})
       ) WHERE rn = 1`,
    );

  for (const batch of chunks(unique, ID_CHUNK)) {
    const rows = statement(batch.length).all(vaultId, ...batch) as Array<{
      fileId: string;
      versionId: string;
    }>;
    for (const row of rows) heads.set(row.fileId, row.versionId);
  }
  return heads;
};

/**
 * Every version row of a vault, grouped into one chain per fileId, in one query.
 *
 * A vault index is pulled by every client on every reconcile and every startup, so
 * this is the N+1 this replaced: a per-file query would spend the pass in round
 * trips to SQLite rather than in the sync it was there to do.
 */
export const listFilesByVaultId: ListFilesByVaultIdFn = async (vaultId) => {
  const rows = await db
    .select({ fileId: fileVersions.fileId, ...versionColumns })
    .from(fileVersions)
    .where(eq(fileVersions.vaultId, vaultId))
    .orderBy(asc(fileVersions.fileId), asc(fileVersions.createdAt), asc(sql`rowid`));

  const chains = new Map<string, Awaited<ReturnType<ListFilesByVaultIdFn>>[number]>();
  for (const row of rows) {
    const { fileId, ...version } = row;
    let chain = chains.get(fileId);
    if (!chain) {
      chain = {
        fileId,
        currentVersionId: "",
        currentContentHash: "",
        encryptedPath: "",
        versions: [],
      };
      chains.set(fileId, chain);
    }
    chain.versions.push(toVersionRow(version));
  }

  // The last row of each chain is its head — the same row every other reader
  // treats as "latest".
  for (const chain of chains.values()) {
    const head = chain.versions.at(-1)!;
    chain.currentVersionId = head.versionId;
    chain.currentContentHash = head.contentHash;
    chain.encryptedPath = head.encryptedPath;
  }
  return [...chains.values()];
};

/**
 * The one row a pass needs per chain: its head, and — for a tombstone — the last live
 * version it removed.
 *
 * `/sync/history` answers every version of every file, which is right for the history
 * dialog opened on demand and wrong for every client's every pass: the payload grows
 * with the vault's age, not with what changed. Two window functions pick the same head
 * the conditional insert checks (`created_at`, then `rowid`), and the latest non-delete
 * row for the chains whose head is a delete.
 *
 * The database work does not shrink: SQLite still reads the vault's version rows to
 * compute the windows. What shrinks is the response and the client's parse — the read
 * still walks the index, so a hosted vault at the million-row scale pays hundreds of
 * milliseconds of synchronous `bun:sqlite` time per pass.
 */
export const listFileHeadsByVaultId: ListFileHeadsByVaultIdFn = async (vaultId) => {
  const rows = sqlite
    .prepare(
      `SELECT file_id AS fileId, version_id AS versionId, content_hash AS contentHash,
              encrypted_path AS encryptedPath, action, size_bytes AS sizeBytes,
              mtime_ms AS mtimeMs, device_name AS deviceName, created_at AS createdAt, rn
       FROM (
         SELECT file_id, version_id, content_hash, encrypted_path, action, size_bytes,
                mtime_ms, device_name, created_at,
                ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC, rowid DESC) AS rn,
                ROW_NUMBER() OVER (PARTITION BY file_id, (action = 'delete')
                                   ORDER BY created_at DESC, rowid DESC) AS live_rn
         FROM file_versions
         WHERE vault_id = ?
       )
       WHERE rn = 1 OR (live_rn = 1 AND action <> 'delete')
       ORDER BY file_id, rn`,
    )
    .all(vaultId) as unknown as Array<RawVersionRow & { fileId: string; rn: number }>;

  const chains = new Map<string, { head: DbVersionRow; previousLive: DbVersionRow | null }>();
  for (const row of rows) {
    // `rn` is the query's ordering marker, not part of the version.
    const { fileId, rn: _rn, ...versionRow } = row;
    const version = toVersionRow(versionRow);
    const chain = chains.get(fileId);
    if (!chain) chains.set(fileId, { head: version, previousLive: null });
    else chain.previousLive = version;
  }
  return [...chains.entries()].map(([fileId, chain]) => ({ fileId, ...chain }));
};

/**
 * Every chain whose last action is `delete`: its head, plus the newest **non-delete**
 * row — the version the recycle bin restores.
 *
 * A window function picks the head inside SQLite, so a vault with years of history
 * loads one or two rows per deleted file instead of every chain it ever wrote. The
 * second window picks the newest live row, not simply the second-newest row: a chain
 * can carry consecutive deletes, and the row immediately before the head is then another
 * tombstone (with the empty-string content hash and no blob), which the recycle bin
 * could not restore.
 *
 * The result is ordered **newest deletion first**, with `rowid` breaking a tie. Two
 * deletes can land in the same millisecond, and the recycle bin's own sort is stable:
 * without the tie-break the same two files could come back in either order between two
 * reads, which is exactly how the "newest first" test became flaky.
 */
export const listDeletedChains: ListDeletedChainsFn = async (vaultId) => {
  const rows = sqlite
    .prepare(
      `SELECT file_id AS fileId, version_id AS versionId, content_hash AS contentHash,
              encrypted_path AS encryptedPath, action, size_bytes AS sizeBytes,
              mtime_ms AS mtimeMs, device_name AS deviceName, created_at AS createdAt, rn,
              live_rn, rowId
       FROM (
         SELECT file_id, version_id, content_hash, encrypted_path, action, size_bytes,
                mtime_ms, device_name, created_at, rowid AS rowId,
                ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC, rowid DESC) AS rn,
                ROW_NUMBER() OVER (PARTITION BY file_id, (action = 'delete')
                                   ORDER BY created_at DESC, rowid DESC) AS live_rn
         FROM file_versions
         WHERE vault_id = ?
       )
       WHERE rn = 1 OR (live_rn = 1 AND action <> 'delete')
       ORDER BY createdAt DESC, rowId DESC`,
    )
    .all(vaultId) as unknown as Array<
    RawVersionRow & { fileId: string; rn: number; live_rn: number; rowId: number }
  >;

  const chains = new Map<string, { previous: DbVersionRow | null; last: DbVersionRow }>();
  for (const row of rows) {
    // `rowId` is the tie-break, not part of the version; keep it out of the row the
    // handler sees.
    const { rowId: _rowId, ...versionRow } = row;
    const version = toVersionRow(versionRow);
    if (row.rn === 1) chains.set(row.fileId, { previous: null, last: version });
    else if (row.live_rn === 1 && row.action !== "delete") {
      chains.get(row.fileId)!.previous = version;
    }
  }

  return [...chains.entries()]
    .filter(([, chain]) => chain.last.action === "delete")
    .map(([fileId, chain]) => ({ fileId, ...chain }));
};

/**
 * The deleted chains' fileIds **and every content hash they hold** — what clearing
 * the recycle bin needs, because a blob may be referenced only by a version that is
 * about to be removed.
 */
export const listDeletedFileIds: ListDeletedFileIdsFn = async (vaultId) => {
  const rows = sqlite
    .prepare(
      `SELECT file_id AS fileId, content_hash AS contentHash
       FROM file_versions
       WHERE vault_id = ? AND file_id IN (
         SELECT file_id FROM (
           SELECT file_id, action,
                  ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC, rowid DESC) AS rn
           FROM file_versions
           WHERE vault_id = ?
         ) WHERE rn = 1 AND action = 'delete'
       )
       ORDER BY file_id, created_at, rowid`,
    )
    .all(vaultId, vaultId) as Array<{ fileId: string; contentHash: string }>;

  const chains = new Map<string, string[]>();
  for (const row of rows) {
    const hashes = chains.get(row.fileId);
    if (hashes) hashes.push(row.contentHash);
    else chains.set(row.fileId, [row.contentHash]);
  }
  return [...chains.entries()].map(([fileId, contentHashes]) => ({ fileId, contentHashes }));
};

// ── Deletes ──

/** Every content hash at least one row of this vault still references. */
export async function listReferencedContentHashes(vaultId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ contentHash: fileVersions.contentHash })
    .from(fileVersions)
    .where(eq(fileVersions.vaultId, vaultId));
  return rows.map((row) => row.contentHash);
}

/**
 * Whether **any** row of this vault still names `contentHash`.
 *
 * The question a history trim asks before it reclaims a blob: the hash a removed row
 * held may also be the content of another file (two copies of one image), and deleting
 * a blob another chain still points at would turn it into a `content_missing`. Answered
 * by the `(vault_id, content_hash)` index rather than by reading every version row of
 * the vault, because this runs on the push path of every file past its limit.
 */
export const isContentHashReferenced: IsContentHashReferencedFn = async (vaultId, contentHash) =>
  db
    .select({ id: fileVersions.id })
    .from(fileVersions)
    .where(and(eq(fileVersions.vaultId, vaultId), eq(fileVersions.contentHash, contentHash)))
    .limit(1)
    .get() !== undefined;

/**
 * Every version row of a vault that sits past its chain's limit, with the content each
 * one held — what a vault-wide trim deletes.
 *
 * The bound is the chain's: the kind is read from the chain's **head** (`history_kind`
 * of the newest row), because a chain is one file whose category does not change from
 * version to version, and the ranking is the `(created_at, rowid)` order every reader
 * calls newest. Used when a vault's limits are lowered — chains no device pushes again
 * would otherwise keep their old history for ever.
 */
export function listVersionRowsBeyondHistoryLimits(
  vaultId: string,
  limits: HistoryLimits,
): Array<{ id: string; contentHash: string }> {
  return sqlite
    .prepare(
      `WITH head_kind AS (
         SELECT file_id, history_kind FROM (
           SELECT file_id, history_kind,
                  ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC, rowid DESC) AS rn
           FROM file_versions
           WHERE vault_id = ?
         ) WHERE rn = 1
       ), ranked AS (
         SELECT file_id, id, content_hash,
                ROW_NUMBER() OVER (PARTITION BY file_id ORDER BY created_at DESC, rowid DESC) AS rn
         FROM file_versions
         WHERE vault_id = ?
       )
       SELECT ranked.id AS id, ranked.content_hash AS contentHash
       FROM ranked JOIN head_kind ON head_kind.file_id = ranked.file_id
       WHERE ranked.rn > CASE WHEN head_kind.history_kind = 'documents' THEN ? ELSE ? END`,
    )
    .all(vaultId, vaultId, limits.documents, limits.attachments) as Array<{
    id: string;
    contentHash: string;
  }>;
}

/** Remove version rows by their primary keys, in one transaction (see {@link ID_CHUNK}). */
export function deleteFileVersionRowsByIds(vaultId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  db.transaction((tx) => {
    for (const batch of chunks([...new Set(ids)], ID_CHUNK)) {
      tx.delete(fileVersions)
        .where(and(eq(fileVersions.vaultId, vaultId), inArray(fileVersions.id, batch)))
        .run();
    }
  });
}

/** Remove every row of every listed chain, atomically (see {@link ID_CHUNK}). */
export const deleteFileVersionsByFileIds: DeleteFileVersionsByFileIdsFn = async (
  vaultId,
  fileIds,
) => {
  if (fileIds.length === 0) return;
  db.transaction((tx) => {
    for (const batch of chunks([...new Set(fileIds)], ID_CHUNK)) {
      tx.delete(fileVersions)
        .where(and(eq(fileVersions.vaultId, vaultId), inArray(fileVersions.fileId, batch)))
        .run();
    }
  });
};
