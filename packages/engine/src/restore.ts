import type { VersionChainEntry } from "@courier/shared";
import type { FileStamp } from "./adapter";
import { remoteHead } from "./decide";

/**
 * What a restore would write into, resolved *before* anything is written.
 *
 * A restore resurrects a deleted file at the path it used to live at, but that path can
 * have been taken since — a note created there, or a file this device has not indexed yet.
 * The engine never overwrites in that case; it reports the shape so the caller can offer to
 * restore under another name instead.
 */
export interface RestoreTargetStatus {
  /** Who currently holds the path a restore would write to. */
  kind: "free" | "same-chain" | "other-file" | "unattributed";
  /** The chain holding the path, when another one does (`kind: "other-file"`). */
  holderFileId: string | null;
}

/** Why a restore refused to write. */
export type RestoreBlockReason = "occupied-by-other-file" | "unattributed-local-file";

/**
 * Thrown by {@link Restorer.restore} when the path it was asked to write is not free.
 *
 * Callers turn this into a "restore under another name" dialog rather than overwriting
 * whatever is there.
 */
export class RestoreBlockedError extends Error {
  constructor(
    readonly reason: RestoreBlockReason,
    message: string,
    readonly holderFileId: string | null = null,
  ) {
    super(message);
    this.name = "RestoreBlockedError";
  }
}

/**
 * What a restore needs from the engine.
 *
 * Deliberately narrow: the target check, the chain and the version's bytes are reads; the
 * three writes are ordered, and the order is the rule (see {@link Restorer.restore}). None
 * of them may be taken from the engine's own state directly, because the restore must see
 * the path as the vault does — the engine's identity map and the disk are two views of it.
 */
export interface RestoreHost {
  /** The live path this chain holds on this device, or null when it holds none. */
  pathFor(fileId: string): string | null;
  /** The chain, oldest → newest. */
  chain(fileId: string): Promise<VersionChainEntry[]>;
  /** A version's plaintext, or null when the store cannot provide it. */
  versionBytes(contentHash: string, sizeBytes: number): Promise<Uint8Array | null>;
  /** A local file at `path`, when there is one (a stat, never a read). */
  stat(path: string): Promise<FileStamp | null>;
  /** The chain this device maps `path` to, when one claims it. */
  fileIdAt(path: string): string | null;
  /** One job over the target path, so the check and the write cannot interleave. */
  run<T>(path: string, job: () => Promise<T>): Promise<T>;
  /** Record the write as the engine's own before it fires a vault event. */
  beforeWrite(path: string, bytes: Uint8Array): Promise<void>;
  /** Perform the adapter write with the engine's "own write" marker. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  /** Push `action:"restore"` on the chain's current head, stamped after the write. */
  pushRestore(
    fileId: string,
    target: string,
    bytes: Uint8Array,
    baseVersionId: string | null,
  ): Promise<void>;
  /** Record the sync point and the new path. */
  persist(): void;
}

/**
 * The restore rules: fetch a historical version's content, write it locally, then push
 * `action:"restore"` — and never overwrite a file that is not this chain's own.
 *
 * Split out of `SyncEngine` because a restore is the one operation that is not a pass and
 * not an event: it is a person asking for a version back, and the rules it follows (the
 * free-path check, the chain's live path winning over the path the caller holds, the
 * self-write record before the push) are worth reading in one place. The engine keeps the
 * pieces only it can do — the path job, the identity map, the push.
 */
export class Restorer {
  constructor(private readonly host: RestoreHost) {}

  /**
   * What a restore of `fileId` at `plainPath` would run into, without writing anything.
   *
   * The recycle bin calls this to choose its interaction — restore straight away, or offer
   * a path to restore under instead — and to mark the rows that cannot be restored as-is.
   */
  async inspect(fileId: string, plainPath: string): Promise<RestoreTargetStatus> {
    const holder = this.host.fileIdAt(plainPath);
    if (holder === fileId) return { kind: "same-chain", holderFileId: null };
    if (holder !== null) return { kind: "other-file", holderFileId: holder };
    // A stat, not a read: whether a local file claims the path is the whole question, and
    // reading a 200 MiB attachment to answer it was the cost this used to pay.
    const stamp = await this.host.stat(plainPath);
    if (stamp !== null) return { kind: "unattributed", holderFileId: null };
    return { kind: "free", holderFileId: null };
  }

  /**
   * Restore a file to a historical version (or restore a deleted file): fetch the version's
   * content, write it locally, then push `action:"restore"`.
   *
   * `options.targetPath` brings the file back **under another name**: it is written there
   * instead of at the path it was deleted from, which is what the recycle bin offers when
   * another note has taken the old path. Either way the path being written must be free —
   * an occupied one is refused with {@link RestoreBlockedError} rather than silently
   * overwritten, because that would destroy the occupying file's live content and leave two
   * chains claiming one path.
   *
   * The chain's own live path wins over the `plainPath` argument: a caller (an open
   * version-history dialog) can hold a path a rename has moved on from, and writing at it
   * would leave the chain live at two paths at once. A chain this device holds nothing for
   * — the deleted-file case — falls back to the argument.
   *
   * A restore is the one write allowed to land **outside** this device's sync scope: the
   * recycle bin lists what the server holds whatever this device syncs, and a person asking
   * for a version back is an explicit action, not the automatic scope being bypassed. The
   * version is pushed (that is what makes it live for the other devices), and a path inside
   * an excluded folder stays excluded here afterwards — the local copy is not synced, but
   * the chain it was restored on is. Refusing instead would leave no way to recover such a
   * file from the UI.
   */
  async restore(
    fileId: string,
    plainPath: string,
    contentHash: string,
    options: { targetPath?: string } = {},
  ): Promise<void> {
    const target = options.targetPath ?? this.host.pathFor(fileId) ?? plainPath;
    // One job over the target: the "is it free?" check and the write have to agree, and a
    // reconcile or an event deciding for this path in between would invalidate the "free"
    // the check just returned.
    return await this.host.run(target, async () => {
      const status = await this.inspect(fileId, target);
      if (status.kind === "other-file") {
        throw new RestoreBlockedError(
          "occupied-by-other-file",
          `${target} is already held by another file`,
          status.holderFileId,
        );
      }
      if (status.kind === "unattributed") {
        throw new RestoreBlockedError(
          "unattributed-local-file",
          `${target} already has a local file that no synced chain claims`,
        );
      }

      const chain = await this.host.chain(fileId);
      // A version's size says whether its bytes are chunked, and the chain is the only place
      // this call can learn it: the caller names a content hash, not a size. A hash that is
      // not in the chain cannot be restored — guessing the head's size would read the wrong
      // framing and allocate the wrong buffer — and a pruned version the chain no longer
      // holds is refused the same way.
      const version = chain.find((entry) => entry.contentHash === contentHash);
      if (version === undefined) {
        throw new Error(`Version ${contentHash} is not in this file's history`);
      }
      const bytes = await this.host.versionBytes(contentHash, version.sizeBytes);
      if (!bytes) {
        throw new Error(`Version content not found for ${contentHash}`);
      }
      // The head this restore is decided from is the chain's, not the state's: a chain that
      // this device deleted (applied from a peer) has no state entry at all, and a restore
      // is a new version on top of wherever the chain stands now. A peer pushing in between
      // still gets refused rather than overwritten.
      //
      // The write below fires a vault event the host feeds straight back into
      // `handleLocalChange`, and it can arrive before the push has recorded the new state
      // and path (the push awaits a network round trip). Mark the write as our own first,
      // or the event is mistaken for a user edit: a second `restore` push, and a brand-new
      // fileId when the delete came from a peer.
      await this.host.beforeWrite(target, bytes);
      await this.host.write(target, bytes);
      // The bytes are on disk now, so the version carries their real stamp instead of a
      // "pushed just now" one: a peer compares that time when the file is a config-folder
      // path, and the sync point gets the stamp a later pass needs to skip re-reading it.
      await this.host.pushRestore(fileId, target, bytes, remoteHead(chain)?.versionId ?? null);
      this.host.persist();
    });
  }
}
