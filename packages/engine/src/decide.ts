import type { SyncAction, VersionChainEntry } from "@courier/shared";

/**
 * Per-file sync decisions. Kept pure (no adapter/api/crypto) so the core
 * push/pull/conflict logic is unit-testable by hand.
 */

export type FileDecision =
  | { action: "synced" }
  | { action: "push"; pushAction: SyncAction }
  | { action: "pull" }
  | { action: "conflict" }
  | { action: "none" };

/**
 * How to treat a *local* file whose remote chain ends in a `delete`.
 *
 * - `"bind-merge"` — the first pass of a host start (a connect, Obsidian reopening, or a
 *   resume after a pause). A local file this engine has never tracked is the user's own,
 *   so it is pushed as a NEW file. A file it *does* track already merged that tombstone
 *   (see {@link DecideInput.locallyTracked}), and the deletion applies.
 * - `"apply-remote-delete"` — a running client. The server says the file is gone,
 *   so the local copy is removed unless it was changed since the tombstone's
 *   previous version, in which case the two are out of step and conflict.
 */
export type TombstoneHandling = "bind-merge" | "apply-remote-delete";

export interface DecideInput {
  /** Local file presence on disk. */
  localExists: boolean;
  /** SHA-256 of the current local content (null when the file is absent). */
  localContentHash: string | null;
  /** The file's last-known sync point (from persisted state). */
  lastKnown: { versionId: string | null; contentHash: string | null };
  /** Remote version chain, oldest → newest. Empty when untracked remotely. */
  remoteChain: VersionChainEntry[];
  /** See {@link TombstoneHandling}. */
  tombstone: TombstoneHandling;
  /**
   * Whether this engine already holds a state entry for the file (a persisted
   * history point). A `bind-merge` only revives a file the engine has **never**
   * tracked: an entry means this device already merged that tombstone, and
   * treating it as new again on every start would push a fresh chain each time —
   * which is how a note a peer deleted while this device was paused came back.
   * On a running client the flag decides nothing.
   */
  locallyTracked: boolean;
  /**
   * Whether the file's absence locally is **this device's deletion** rather than a
   * remote file it does not have.
   *
   * The filesystem alone cannot tell those apart, so the engine answers it: the file
   * is tracked, it has a sync point, nothing is on disk, and nothing sits at the path
   * the remote head records either (a peer's move that this vault already applied
   * leaves a file *there*, and following it is a pull, not a conflict).
   */
  localDeletion: boolean;
}

/** The part of a state entry a decision needs: the history point both sides agreed on. */
export interface TrackedState {
  lastKnownVersionId: string | null;
  lastKnownContentHash: string | null;
}

/**
 * Everything a per-file decision is made from, before it is spelled as a
 * {@link DecideInput}.
 *
 * It exists because the same input was assembled in four places — the reconcile (twice,
 * once from the pass's snapshot and once from the bytes actually on disk), an
 * incremental event, and a websocket notification — and the subtle part of it,
 * `localDeletion`, was written out twice with different expressions. One builder means
 * one answer to "is this absence this device's own deletion?".
 */
export interface DecideContext {
  /** This device's state entry for the chain, when it tracks it. */
  entry: TrackedState | undefined;
  /** Local file presence on disk. */
  localExists: boolean;
  /** SHA-256 of the current local content (null when the file is absent). */
  localContentHash: string | null;
  /** Remote version chain, oldest → newest. Empty when untracked remotely. */
  remoteChain: VersionChainEntry[];
  /** See {@link TombstoneHandling}. */
  tombstone: TombstoneHandling;
  /**
   * Whether a local file sits at the path the remote head records.
   *
   * A peer's move the vault already applied leaves a file *there*, so a tracked file
   * that is gone from its old path is a move to follow rather than this device's
   * deletion. Callers that cannot know answer `false` when the file is on disk anyway.
   */
  headPathHasLocalFile: boolean;
  /** `sha256("")` — the content hash a `delete` version carries. */
  emptyHash: string;
}

/**
 * Whether a tracked file's absence is this device's own deletion.
 *
 * Three ways it is not: the file is on disk; this device never had a live sync point
 * for it (a chain it only knows remotely); or that sync point is itself a `delete`, so
 * the absence is already on the chain and a newer live head is a peer restoring it.
 */
export function isLocalDeletion(context: DecideContext): boolean {
  if (context.localExists) return false;
  const entry = context.entry;
  if (!entry || entry.lastKnownVersionId == null) return false;
  if (entry.lastKnownContentHash === context.emptyHash) return false;
  return !context.headPathHasLocalFile;
}

/** The {@link DecideInput} for one file, from the context above. */
export function decideInputFrom(context: DecideContext): DecideInput {
  return {
    localExists: context.localExists,
    localContentHash: context.localContentHash,
    lastKnown: {
      versionId: context.entry?.lastKnownVersionId ?? null,
      contentHash: context.entry?.lastKnownContentHash ?? null,
    },
    remoteChain: context.remoteChain,
    tombstone: context.tombstone,
    locallyTracked: context.entry !== undefined,
    localDeletion: isLocalDeletion(context),
  };
}

export function remoteHead(chain: readonly VersionChainEntry[]): VersionChainEntry | undefined {
  return chain.length > 0 ? chain[chain.length - 1] : undefined;
}

/**
 * The version a `delete` head removed, i.e. what the file looked like before it
 * was deleted. `null` when the chain carries no live version at all.
 */
function lastLiveVersion(chain: VersionChainEntry[]): VersionChainEntry | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].action !== "delete") return chain[i];
  }
  return undefined;
}

/**
 * Decide what to do with one file given local state and the remote chain.
 * Alignment is by versionId (the shared history point), not by content hash.
 */
export function decideFile(input: DecideInput): FileDecision {
  const head = remoteHead(input.remoteChain);
  const lastKnown = input.lastKnown;

  // 1. Untracked remotely → push whatever exists locally.
  if (!head) {
    return input.localExists ? { action: "push", pushAction: "create" } : { action: "none" };
  }

  // 2. A `delete` head means the server holds no live version of this file. What
  //    that means for a local file depends on which side is authoritative right
  //    now — see `TombstoneHandling`.
  if (head.action === "delete") {
    if (!input.localExists) return { action: "synced" };
    if (input.tombstone === "bind-merge" && !input.locallyTracked) {
      // Binding the vault for the first time: the local file is the user's, the
      // chain is gone. Push it as a NEW file — its own fileId, nothing to do with
      // the tombstone.
      return { action: "push", pushAction: "create" };
    }
    if (input.locallyTracked && input.lastKnown.versionId === head.versionId) {
      // The tombstone *is* this device's sync point, so this device already knows
      // the file is deleted — it deleted it. A file on disk under that point can
      // only be one the user created afterwards, and the remote side holds no
      // content to compete with: that is a **recreate**, not a conflict. Without
      // this the note just typed would be resolved away as "the remote deletion
      // won" and only survive as a conflict file.
      return { action: "push", pushAction: "restore" };
    }
    // Running client (or a bind over state we already have): apply the deletion
    // unless the local file diverged from the version the tombstone removed, in
    // which case neither side can win silently.
    const previous = lastLiveVersion(input.remoteChain);
    const localUnchanged =
      previous !== undefined && input.localContentHash === previous.contentHash;
    return localUnchanged ? { action: "pull" } : { action: "conflict" };
  }

  // 3. Same history point both sides.
  if (head.versionId === lastKnown.versionId) {
    if (!input.localExists) {
      // Local file removed after the shared point → push the delete.
      return { action: "push", pushAction: "delete" };
    }
    if (input.localContentHash === lastKnown.contentHash) {
      return { action: "synced" };
    }
    return { action: "push", pushAction: "modify" };
  }

  // 4. Remote head exists but it is not the point we know — remote moved ahead
  //    of us (or we were never on its chain — e.g. a fresh binder).
  if (!input.localExists) {
    // Nothing local. A tracked file whose absence is this device's own deletion, on a
    // chain that moved past its sync point, means a peer edited what we deleted:
    // neither side may win silently, so that is a conflict — the same answer the two
    // sides get when they diverge on content. Anything else (a remote file this
    // client never had, or a move it has yet to follow) is a pull.
    return input.localDeletion ? { action: "conflict" } : { action: "pull" };
  }

  // 5. Local untouched since the shared point → remote-only change → pull.
  if (lastKnown.versionId != null && input.localContentHash === lastKnown.contentHash) {
    return { action: "pull" };
  }

  // 6. Both sides hold the same bytes → converged, whatever our sync point says.
  //
  //    Two shapes reach this line, and neither is a divergence. A file this device has
  //    never synced, whose chain was birthed on another device with the same content. And
  //    a race: one operation's push is accepted while a second decision on the same path
  //    has already fetched the chain that push created, but has not yet seen this
  //    device's state adopt it — the local file then holds exactly the head's content (it
  //    *is* the file that was just pushed) while the sync point is the previous version.
  //    Answering "conflict" there parked a copy of the file over itself, wrote the same
  //    bytes back, and told the user a conflict had been resolved when nothing had
  //    diverged. The caller records the head as the sync point instead.
  if (input.localContentHash === head.contentHash) {
    return { action: "synced" };
  }

  // 7. Both sides present and genuinely out of step → conflict.
  return { action: "conflict" };
}

/**
 * A live remote chain that can own a local path or a set of bytes.
 *
 * `head` is the version an identity adoption records; a tombstone is never an owner
 * (see {@link decideNewLocalFile}).
 */
export interface RemoteOwner {
  fileId: string;
  head: VersionChainEntry;
}

/**
 * What the identity lookups found for a local file with no known fileId.
 *
 * The lookups themselves stay in the engine — they read the remote index, the state and
 * the vault listing — but the **order** in which their answers win is a rule, and it
 * lives here so it is tested on its own.
 */
export interface NewLocalFileLookup {
  /** The content hash of the local file being decided. */
  contentHash: string;
  /**
   * The chain of a `delete` this device — or this very job — already decided whose
   * content hash matches. The delete is the other half of a move.
   */
  deletedFileId: string | null;
  /** The live chain the remote index records at the path, when it records one. */
  pathOwner: RemoteOwner | null;
  /**
   * The one live chain elsewhere whose head holds these bytes, whose previous path no
   * longer holds a local file (see `SyncEngine.findRemoteFileIdByContent`).
   */
  contentOwner: RemoteOwner | null;
}

/**
 * The identity a local file with no known fileId takes.
 *
 * Each step of the precedence exists for a specific bug:
 *
 * - a delete this device decided whose bytes reappear is the other half of a move: the
 *   chain is re-pointed at the new path instead of a second chain being created for it;
 * - a live chain the server records at the path — a peer's move this device applied
 *   before its state update — is adopted instead of forking;
 * - the content fallback is the last net, for a rename notification that never arrived;
 * - otherwise the file is genuinely new and gets a chain of its own.
 *
 * A tombstone is deliberately not an identity: the path holds no live version, and a file
 * written there after the deletion is somebody's new file.
 */
export type NewLocalFileDecision =
  | { kind: "rename-on-deleted"; fileId: string }
  | { kind: "adopt"; owner: RemoteOwner; sameContent: boolean }
  | { kind: "create" };

export function decideNewLocalFile(lookup: NewLocalFileLookup): NewLocalFileDecision {
  if (lookup.deletedFileId !== null) {
    return { kind: "rename-on-deleted", fileId: lookup.deletedFileId };
  }
  const owner = lookup.pathOwner ?? lookup.contentOwner;
  if (owner === null) return { kind: "create" };
  // The bytes on disk are the adopted head's: a rename, not an edit.
  return { kind: "adopt", owner, sameContent: owner.head.contentHash === lookup.contentHash };
}

/**
 * Whether a decision taken from the caller's pre-fetched bytes has to be re-taken from a
 * fresh read before it acts.
 *
 * Only a `push` is safe on pre-fetched bytes: it sends what it read, and the caller's
 * stamp check already proved the file did not move. Every other action writes to (pull,
 * conflict) or adopts the file, so it must be taken from bytes read **now** — the chain
 * request in between gave the file time to change, and a same-size edit inside one mtime
 * tick is exactly what the stamp check cannot see. The reconcile re-reads before every
 * pull/conflict for the same reason.
 */
export function needsFreshRead(decision: FileDecision, usedPrefetched: boolean): boolean {
  return usedPrefetched && decision.action !== "push";
}

/** How many times one event-driven decision may be taken before a refusal is reported. */
export const EVENT_DECISION_ATTEMPTS = 2;

/** What an event-driven push does when the server refuses it with `stale_base`. */
export type RefusedPushStep = "re-decide" | "report";

/**
 * Whether a refused push is decided again from the chain the server returned.
 *
 * The re-decision happens **once**: deciding again from the fresh chain while the state
 * still holds the point both sides last agreed on is what turns "the peer's version is
 * what my edit builds on" into the conflict it actually is, instead of a modification
 * that silently replaces their edit. A second refusal is the caller's to report.
 */
export function decideRefusedPush(attempt: number): RefusedPushStep {
  return attempt + 1 < EVENT_DECISION_ATTEMPTS ? "re-decide" : "report";
}
