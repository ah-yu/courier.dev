/**
 * The events a sync engine has to recognise as **its own**.
 *
 * Every local write, delete or move the engine performs comes back to it as a vault
 * event (the adapter fires it, and the host feeds it straight back in), and every push
 * comes back as a `files_pushed` echo from the server. Treating any of them as a user
 * action is how a pull pushed its own result back under a second fileId, how applying a
 * peer's delete pushed a second tombstone (which made the file unrestorable), and how
 * following a peer's move pushed a second `rename` version.
 *
 * The records are **time-bounded hints**, not a mute switch: a write is matched by
 * content hash (a genuine edit that lands in the window has different bytes), a rename
 * by its target, and a delete by path. The window has to outlive the gap between the two
 * halves of the event it exists for — which for a bulk move is a whole batch job, not one
 * event (see {@link DEFAULT_RENAME_WINDOW_MS}) — and a record is swept once its window
 * closes, so a host that stays up for weeks does not accumulate them. The clock is
 * injected so a test can move it instead of freezing a global.
 */

import type { FileStamp } from "./adapter";

/**
 * How long a deleted fileId is kept for rename-by-hash matching (ms).
 *
 * A move reaches a host as "this path is gone" and "that path appeared". Those two halves
 * are *not* always in the same batch: the host hands a burst over every
 * `LOCAL_EVENT_BURST_FLUSH_MS`, and a batch that meets the sync allowance spends minutes
 * in the engine before the next one is decided. A window sized for a single event
 * therefore forked one chain per file on a bulk move — a tombstone under the old path and
 * a brand-new chain under the new one — which is exactly what this memory exists to
 * prevent ("one path, one chain"). It is sized to one **pass** interval instead
 * (`DEFAULT_RECONCILE_INTERVAL_MS` in `host.ts`, repeated here because the host imports the
 * engine and not the other way round; a test pins the two together): a full reconcile lists
 * every file and gives it an identity anyway, so outliving one is as long as the record can
 * matter.
 */
export const DEFAULT_RENAME_WINDOW_MS = 5 * 60_000;

/**
 * The most deletes kept for matching, whatever their age.
 *
 * {@link DEFAULT_RENAME_WINDOW_MS} bounds how long a record lives; this bounds how many a
 * burst can leave behind ("cost is bounded"). A bulk move beyond it keeps its newest
 * deletes, so its earliest files are the ones that fork.
 */
export const MAX_PENDING_DELETES = 20_000;

/**
 * How long a path the engine wrote itself keeps suppressing the vault event that write
 * fires (ms). Only needs to outlive the push started by the same code path.
 */
export const DEFAULT_SELF_WRITE_WINDOW_MS = 10_000;

/** A delete this engine performed, kept so a matching `create` can be read as its rename. */
export interface PendingDelete {
  fileId: string;
  contentHash: string;
  deletedAt: number;
  /**
   * The version this device's tombstone pushes, once it has been prepared.
   *
   * A move's create half takes the delete back and is then refused when the tombstone
   * landed first; recognising **its own** tombstone on the fresh chain is what settles
   * that refusal as a recreate instead of applying a deletion. Null until the request is
   * prepared, and never set for a deletion another device is responsible for.
   */
  versionId: string | null;
  /**
   * The chain head the tombstone was decided from.
   *
   * A retry of the same decision — the pass re-preparing a tombstone whose event push
   * answered nothing, or the event path retrying the same deletion — must **reuse**
   * `versionId`: the lost answer may have stored that very version, and a second version
   * for one deletion would leave a create half naming one the server's head is not (see
   * `SyncEngine.settleRefusedMove`). A different base is a new decision.
   */
  baseVersionId: string | null;
  /**
   * Every tombstone version this device minted for this chain, newest last.
   *
   * Bounded by `MAX_DELETE_VERSIONS`: a newer mint moved the state point past the earlier
   * version, so an evicted version cannot be the head a refusal is settled against.
   *
   * A create half can capture the record **before** a newer tombstone is prepared for the
   * same chain (a delete half that re-members while the create half is deciding), so the
   * version it carries is not always the head it is refused against. The settlement
   * recognises the head as this device's own when it is **any** of these, which a peer's
   * tombstone never is.
   */
  versions: string[];
}

/** How many tombstone versions one chain keeps for that recognition (bounded). */
export const MAX_DELETE_VERSIONS = 8;

export interface SelfEventLogOptions {
  /** See {@link DEFAULT_RENAME_WINDOW_MS}. */
  renameWindowMs?: number;
  /** See {@link DEFAULT_SELF_WRITE_WINDOW_MS}. */
  selfWriteWindowMs?: number;
  /** The clock, injectable so the windows are testable without fake timers. */
  now?: () => number;
}

export class SelfEventLog {
  /**
   * Versions this engine pushed, so the `files_pushed` echo of one is never applied as
   * a peer's change (versionId → the deadline it is kept until).
   *
   * Keyed by versionId alone: a version id is a UUID minted by the pushing device, so
   * it identifies the push whoever the file belongs to. It is written **before** the
   * request goes out, because the echo can beat the HTTP response back — and it is
   * swept by deadline, because on the ordinary path **no echo ever arrives**: the
   * server skips the pushing session's own subscription, so nothing else would ever
   * remove the id.
   */
  private readonly pushedVersions = new Map<string, number>();
  /** plainPath → the hash (and, when known, the stamp) of a write this engine performed. */
  private readonly selfWrites = new Map<
    string,
    { contentHash: string; expiresAt: number; stamp?: FileStamp }
  >();
  /** plainPath → expiry of a delete this engine performed. */
  private readonly selfDeletes = new Map<string, number>();
  /** Old path → the new path of a move this engine performed. */
  private readonly selfRenames = new Map<string, { to: string; expiresAt: number }>();
  /** fileId → the delete this engine performed, for rename-by-hash matching. */
  private readonly pendingDeletes = new Map<string, PendingDelete>();

  private readonly renameWindowMs: number;
  private readonly selfWriteWindowMs: number;
  private readonly now: () => number;

  constructor(options: SelfEventLogOptions = {}) {
    this.renameWindowMs = options.renameWindowMs ?? DEFAULT_RENAME_WINDOW_MS;
    this.selfWriteWindowMs = options.selfWriteWindowMs ?? DEFAULT_SELF_WRITE_WINDOW_MS;
    this.now = options.now ?? (() => Date.now());
  }

  // ── Pushed versions (the server's echo) ──

  /** How many echo records are pending right now (diagnostics and tests). */
  get pendingEchoes(): number {
    return this.pushedVersions.size;
  }

  /** Remember a version this engine is about to push, and drop the expired records. */
  rememberPushedVersion(versionId: string): void {
    const now = this.now();
    for (const [known, expiresAt] of this.pushedVersions) {
      if (expiresAt <= now) this.pushedVersions.delete(known);
    }
    this.pushedVersions.set(versionId, now + this.selfWriteWindowMs);
  }

  /**
   * True when this version is the echo of a push this engine made. Consumed once, so
   * the record cannot outlive the echo it exists for.
   */
  consumePushedVersion(versionId: string): boolean {
    if (!this.pushedVersions.has(versionId)) return false;
    this.pushedVersions.delete(versionId);
    return true;
  }

  /** Stop suppressing the echo of a push that never landed. */
  forgetPushedVersion(versionId: string): void {
    this.pushedVersions.delete(versionId);
  }

  // ── Writes ──

  /** Record a write this engine is about to make to the local filesystem. */
  recordSelfWrite(path: string, contentHash: string, stamp?: FileStamp): void {
    const now = this.now();
    for (const [known, entry] of this.selfWrites) {
      if (entry.expiresAt <= now) this.selfWrites.delete(known);
    }
    this.selfWrites.set(path, {
      contentHash,
      expiresAt: now + this.selfWriteWindowMs,
      ...(stamp === undefined ? {} : { stamp: { ...stamp } }),
    });
  }

  /**
   * Whether a write this engine performed is still being suppressed for `path`.
   *
   * A caller that is about to match a vault event can ask this before hashing the
   * bytes: a genuine user edit has no record, and hashing a 40 MiB file only to learn
   * that is the cost this answers. The content match itself still happens in
   * {@link isSelfWrite}.
   */
  hasSelfWrite(path: string): boolean {
    const entry = this.selfWrites.get(path);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.selfWrites.delete(path);
      return false;
    }
    return true;
  }

  /**
   * Whether `stamp` is the file a **streamed** write of this engine left behind.
   *
   * A streamed pull knows the content hash without ever holding the bytes, but the
   * vault event its rename fires still reaches `handleLocalChange`, which would
   * otherwise read the whole file back just to hash it — undoing the memory bound for a
   * file that was just written. The stamp (size + mtime) is what lets that event be
   * recognised without a read: the engine records it immediately after the commit, and
   * a genuine edit moves it. The record is not consumed, because one write can produce
   * more than one event (`create` and `modify`).
   *
   * Only records that actually carry a stamp answer true; a write recorded without one
   * (the ordinary whole-buffer path) falls back to the content-hash match.
   */
  matchesSelfWriteStamp(path: string, stamp: FileStamp): boolean {
    const entry = this.selfWrites.get(path);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.selfWrites.delete(path);
      return false;
    }
    return (
      entry.stamp !== undefined &&
      entry.stamp.sizeBytes === stamp.sizeBytes &&
      entry.stamp.mtimeMs === stamp.mtimeMs
    );
  }

  /**
   * True when `contentHash` is the echo of a write this engine just performed.
   *
   * The record is **not** consumed by the first match, because one write can produce
   * more than one event: Obsidian reports a file the engine created as `create` *and*
   * `modify`, and both are handed to the same handler. Consuming the record on the
   * first of them left the second to be read as a user edit, and an edit that lands
   * before the new sync point is recorded is indistinguishable from a divergence — the
   * engine parked a conflict copy of the content it had just pulled. Matching by
   * content hash is what keeps the longer-lived record honest: a genuine edit has
   * different bytes and is handled normally, and the sweep in {@link recordSelfWrite}
   * drops the record when its window closes.
   *
   * The name says "is", not "consume": the record has to survive for the second event
   * and for a decision that is not an event at all (the conflict path, which asks
   * whether the bytes it is about to park are the engine's own).
   */
  isSelfWrite(path: string, contentHash: string): boolean {
    const entry = this.selfWrites.get(path);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.selfWrites.delete(path);
      return false;
    }
    return contentHash === entry.contentHash;
  }

  // ── Deletes ──

  /**
   * Record a delete this engine is about to perform locally.
   *
   * Applying a peer's delete has no bytes to match on, and the `delete` event arrives
   * before the engine has cleared its path → fileId mapping — so without this the
   * engine pushes a second, redundant tombstone. That tombstone is not cosmetic: the
   * recycle bin reads the version *before* the delete as the restorable one, so the
   * extra tombstone makes the file's `previousContentHash` the hash of an empty string
   * and the file can no longer be restored.
   */
  recordSelfDelete(path: string): void {
    const now = this.now();
    for (const [known, expiresAt] of this.selfDeletes) {
      if (expiresAt <= now) this.selfDeletes.delete(known);
    }
    this.selfDeletes.set(path, now + this.selfWriteWindowMs);
  }

  /**
   * True when this delete is the echo of one the engine just performed. Consumed once;
   * a delete still on the books when its window expires is forgotten, and a following
   * reconcile pushes a genuine local delete it missed.
   */
  consumeSelfDelete(path: string): boolean {
    const expiresAt = this.selfDeletes.get(path);
    if (expiresAt === undefined) return false;
    this.selfDeletes.delete(path);
    return expiresAt > this.now();
  }

  /**
   * Whether a delete this engine performed is still on the books for `path` — **without**
   * consuming it (see `hasSelfWrite`). The host's burst rule asks this before it decides
   * that a vault event is part of a user's bulk write rather than the echo of its own.
   */
  hasSelfDelete(path: string): boolean {
    const expiresAt = this.selfDeletes.get(path);
    if (expiresAt === undefined) return false;
    if (expiresAt <= this.now()) {
      this.selfDeletes.delete(path);
      return false;
    }
    return true;
  }

  // ── Moves ──

  /** Record a move this engine is about to perform locally (same reason as a write). */
  recordSelfRename(from: string, to: string): void {
    const now = this.now();
    for (const [known, entry] of this.selfRenames) {
      if (entry.expiresAt <= now) this.selfRenames.delete(known);
    }
    this.selfRenames.set(from, { to, expiresAt: now + this.selfWriteWindowMs });
  }

  /** True when this move is the echo of one the engine just performed. */
  consumeSelfRename(from: string, to: string): boolean {
    const entry = this.selfRenames.get(from);
    if (!entry) return false;
    this.selfRenames.delete(from);
    return entry.expiresAt > this.now() && entry.to === to;
  }

  /** Whether a move out of `path` is still on the books (see `hasSelfDelete`). */
  hasSelfRename(from: string): boolean {
    const entry = this.selfRenames.get(from);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.selfRenames.delete(from);
      return false;
    }
    return true;
  }

  // ── Deletes awaiting a possible rename ──

  /**
   * Remember a delete so a file appearing with the same content can adopt its chain.
   *
   * `versionId` is the tombstone's version when the caller knows it — the event and pass
   * delete paths both generate it before this call, so a create half that matches the
   * record always has the version a refused `rename` needs to recognise its own tombstone
   * on the fresh chain (`SyncEngine.settleRefusedMove`).
   */
  rememberDelete(
    fileId: string,
    contentHash: string,
    versionId: string | null = null,
    baseVersionId: string | null = null,
  ): void {
    // Re-remembering a chain updates the record in place: the map's insertion order is the
    // ceiling's eviction order, and moving an old chain to the end would keep it above
    // deletes that are actually newer.
    const entry = this.pendingDeletes.get(fileId);
    if (entry === undefined) {
      this.pendingDeletes.set(fileId, {
        fileId,
        contentHash,
        deletedAt: this.now(),
        versionId,
        baseVersionId,
        versions: versionId === null ? [] : [versionId],
      });
    } else {
      entry.contentHash = contentHash;
      entry.deletedAt = this.now();
      // A second deletion of the same chain is a new tombstone, whose version this caller
      // states; the previous one would let a refused rename adopt a tombstone this
      // decision never pushed. Every version stays listed, though: a create half may have
      // captured the record before this call and still be refused against the new head.
      entry.versionId = versionId;
      entry.baseVersionId = baseVersionId;
      if (versionId !== null) {
        entry.versions = entry.versions.filter((known) => known !== versionId);
        entry.versions.push(versionId);
        if (entry.versions.length > MAX_DELETE_VERSIONS) entry.versions.shift();
      }
    }
    while (this.pendingDeletes.size > MAX_PENDING_DELETES) {
      const oldest = this.pendingDeletes.keys().next();
      if (oldest.done) break;
      this.pendingDeletes.delete(oldest.value);
    }
  }

  /**
   * The version already prepared for this same deletion, so a retry reuses it.
   *
   * Same chain, same bytes **and** the same base is the same decision taken twice — the
   * lost-answer retry — and only that: a re-prepare from a newer base is a new tombstone.
   */
  pendingDeleteVersion(
    fileId: string,
    contentHash: string,
    baseVersionId: string | null,
  ): string | null {
    const entry = this.pendingDeletes.get(fileId);
    if (entry === undefined || entry.versionId === null) return null;
    if (entry.contentHash !== contentHash || entry.baseVersionId !== baseVersionId) return null;
    return entry.versionId;
  }

  /** The version of the tombstone this device prepared for `fileId`, whatever its base. */
  pendingDeleteVersionFor(fileId: string): string | null {
    return this.pendingDeletes.get(fileId)?.versionId ?? null;
  }

  /**
   * Every tombstone version this device minted for `fileId` that the record still holds.
   *
   * The settlement asks this so a create half that captured the record before a newer
   * tombstone was prepared still recognises the head as this device's own. A peer's
   * tombstone is never in the list.
   */
  deleteVersionsFor(fileId: string): readonly string[] {
    return this.pendingDeletes.get(fileId)?.versions ?? [];
  }

  /**
   * The most recent delete inside the rename window whose content matches `contentHash`,
   * or null. The match is consumed: one delete explains one new file.
   */
  matchDeletedFile(contentHash: string): PendingDelete | null {
    const now = this.now();
    for (const [key, pending] of this.pendingDeletes) {
      if (now - pending.deletedAt > this.renameWindowMs) {
        this.pendingDeletes.delete(key);
        continue;
      }
      if (pending.contentHash && pending.contentHash === contentHash) {
        this.pendingDeletes.delete(key);
        return pending;
      }
    }
    return null;
  }

  /**
   * Drop the record of a delete **the caller matched itself**, so the same delete cannot
   * explain a second new file.
   *
   * A batch keeps its own hash → fileId map for the deletes it prepares in one job — a
   * per-burst dedupe, not a second time window — and consumes the record here once its
   * create has adopted the chain.
   */
  forgetDelete(fileId: string): void {
    this.pendingDeletes.delete(fileId);
  }
}
