import { sha256Hex } from "./crypto";
import type { FileStamp } from "./adapter";

/**
 * How long the excluded folders' file listing is reused.
 *
 * The listing exists only to recognise a file that was moved into an excluded folder
 * without a rename event (see {@link ExcludedMoveFinder.find}), and it is consulted before
 * a deletion is published. A burst — a folder removed, or a daemon flushing one batch of
 * events — would otherwise walk the excluded folders once per file; a few seconds of
 * staleness can only make the engine miss a just-created candidate, which falls back to the
 * normal deletion path.
 */
const EXCLUDED_LISTING_TTL_MS = 30_000;

/** What a move into an excluded folder needs from the engine. */
export interface ExcludedMovesHost {
  /** Every file under this device's excluded folders, or nothing when it cannot list them. */
  listExcludedFiles(): Promise<readonly string[]>;
  statFile(path: string): Promise<FileStamp | null>;
  readFile(path: string): Promise<Uint8Array | null>;
  /** Whether a path is claimed by a local chain or by one the server records. */
  isClaimed(path: string): boolean;
  /** The size this device recorded for the chain's current sync point, when it has one. */
  knownSize(fileId: string): number | undefined;
  /** How many folders this device excludes; none means the fallback cannot apply. */
  excludedFolders(): number;
  /** The clock the listing's TTL is measured against. */
  now(): number;
}

/**
 * The file under an excluded folder that is a tracked chain's file, moved there without an
 * event the engine could read as a rename.
 *
 * A host can see a move as "removed at the old path, created at the new one" — an external
 * tool, the CLI's `fs.watch`, a plugin that was not running — and when the destination is an
 * excluded folder the scope drops the created half, so the absence would become a tombstone
 * for a file the user still owns. The match is deliberately narrow: the same file name, the
 * same size when the state recorded one, and exactly one candidate whose bytes hash to the
 * sync point. Anything else falls back to the normal deletion path — a wrong "move" would
 * keep a file every peer has deleted.
 *
 * Deliberately mechanical: it decides nothing about identity, it only answers which path the
 * engine should record instead of deleting. The listing's TTL is the one state it owns.
 */
export class ExcludedMoveFinder {
  private listing: { readonly at: number; readonly byName: Map<string, string[]> } | null = null;

  constructor(private readonly host: ExcludedMovesHost) {}

  /**
   * The path `fileId` moved to under an excluded folder, or null when the move cannot be
   * proven.
   *
   * `oldPath` only supplies the name a move generally keeps; `contentHash` is the sync
   * point the candidate's bytes must still hash to.
   */
  async find(fileId: string, oldPath: string, contentHash: string): Promise<string | null> {
    if (this.host.excludedFolders() === 0) return null;
    const candidates = (await this.byName()).get(fileNameOf(oldPath)) ?? [];
    if (candidates.length === 0) return null;

    const sizeHint = this.host.knownSize(fileId);
    let match: string | null = null;
    for (const candidate of candidates) {
      // A file another chain claims (or this chain already records) is not the move.
      if (this.host.isClaimed(candidate)) continue;
      if (sizeHint !== undefined) {
        const stamp = await this.host.statFile(candidate);
        if (stamp === null || stamp.sizeBytes !== sizeHint) continue;
      }
      const bytes = await this.host.readFile(candidate);
      if (!bytes) continue;
      if ((await sha256Hex(bytes)) !== contentHash) continue;
      if (match !== null) return null; // ambiguous — keep the deletion path
      match = candidate;
    }
    return match;
  }

  /** The excluded folders' files grouped by name, listed at most once per {@link EXCLUDED_LISTING_TTL_MS}. */
  private async byName(): Promise<Map<string, string[]>> {
    const now = this.host.now();
    if (this.listing !== null && now - this.listing.at < EXCLUDED_LISTING_TTL_MS) {
      return this.listing.byName;
    }
    const byName = new Map<string, string[]>();
    // A listing is a fallback for a decision the engine would otherwise make as a deletion:
    // a host that cannot answer must not make the decision fail (and retry forever).
    let listed: readonly string[] = [];
    try {
      listed = await this.host.listExcludedFiles();
    } catch {
      listed = [];
    }
    for (const path of listed) {
      const name = fileNameOf(path);
      const bucket = byName.get(name);
      if (bucket) bucket.push(path);
      else byName.set(name, [path]);
    }
    this.listing = { at: now, byName };
    return byName;
  }
}

/** The last path segment — the name a move generally keeps. */
function fileNameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}
