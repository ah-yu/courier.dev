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
 * (`DEFAULT_RECONCILE_INTERVAL_MS`): a full reconcile lists every file and gives it an
 * identity anyway, so outliving one is as long as the record can matter.
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
}

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

  /** Remember a delete so a file appearing with the same content can adopt its chain. */
  rememberDelete(fileId: string, contentHash: string): void {
    // Re-remembering a chain updates the record in place: the map's insertion order is the
    // ceiling's eviction order, and moving an old chain to the end would keep it above
    // deletes that are actually newer.
    const entry = this.pendingDeletes.get(fileId);
    if (entry === undefined) {
      this.pendingDeletes.set(fileId, { fileId, contentHash, deletedAt: this.now() });
    } else {
      entry.contentHash = contentHash;
      entry.deletedAt = this.now();
    }
    while (this.pendingDeletes.size > MAX_PENDING_DELETES) {
      const oldest = this.pendingDeletes.keys().next();
      if (oldest.done) break;
      this.pendingDeletes.delete(oldest.value);
    }
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
   * A batch keeps its own hash → fileId map for the deletes it prepares in one job (the
   * time window is sized for one event, not for a 600-event burst's tail), and consumes
   * the record here once its create has adopted the chain.
   */
  forgetDelete(fileId: string): void {
    this.pendingDeletes.delete(fileId);
  }
}
