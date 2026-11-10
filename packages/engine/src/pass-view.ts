import type { VersionChainEntry } from "@courier/shared";
import { remoteHead } from "./decide";
import { orderByPriority } from "./priority";
import type { FileStamp } from "./adapter";
import type { PrefetchCandidate } from "./content-prefetch";
import type { OpQueueLimits, OpWeight } from "./op-queue";
import { weightForSize } from "./op-queue";
import type { RemoteIndex } from "./remote-index";
import type { LocalVersionState } from "./state";

/**
 * The fields of a reconcile pass that the ordering, the path geometry and the read-ahead
 * ask for — a narrowed view of `ReconcilePass`, which the engine passes as-is.
 *
 * Pure functions rather than engine methods: none of them reads or writes the vault, so
 * they can be pinned without a fake adapter. Their input is the pass's snapshot plus the
 * state; their output is an order, a path, a weight or a candidate list.
 */
export interface PassView {
  /** What the server holds, as of this pass (see `RemoteIndex`). */
  readonly remote: RemoteIndex;
  /** plainPath → the stamp this pass listed. */
  readonly localStamps: ReadonlyMap<string, FileStamp>;
  /** fileId → its chain, oldest → newest. */
  readonly chainByFileId: ReadonlyMap<string, readonly VersionChainEntry[]>;
  /** The user's paths, as a rank (see `PrioritizedEntry`). */
  readonly priority: ReadonlyMap<string, number>;
}

export interface ChainPaths {
  /** Where a task reads and writes. */
  plainPath: string | null;
  /** What a pull may move the file to. */
  recordedPath: string | null;
  /** The union, which is what two tasks with an overlapping path claim. */
  claimed: string[];
}

/**
 * Where a chain lives on this device and where the server records it.
 *
 * The two disagree for exactly as long as a peer's move is in flight: the server records
 * the new path, while the file — and this device's identity mapping — is still at the old
 * one.
 */
export function chainPaths(fileId: string, view: PassView, state: LocalVersionState): ChainPaths {
  const entry = state[fileId];
  const recordedPath = view.remote.pathOf(fileId) ?? entry?.plainPath ?? null;
  const plainPath = entry?.plainPath ?? recordedPath;
  const claimed: string[] = [];
  if (plainPath !== null) claimed.push(plainPath);
  if (recordedPath !== null && recordedPath !== plainPath) claimed.push(recordedPath);
  return { plainPath, recordedPath, claimed };
}

/**
 * The path this pass actually holds bytes at, for its stamp and size.
 *
 * The state path is preferred, but the vault may already have applied a peer's move:
 * `plainPath` is then stale and the file sits at `recordedPath`. Only a path this pass
 * listed has a stamp, so the answer is whichever of the two it recorded.
 */
export function listedStampPath(
  plainPath: string | null,
  recordedPath: string | null,
  localStamps: ReadonlyMap<string, FileStamp>,
): string | null {
  if (plainPath !== null && localStamps.has(plainPath)) return plainPath;
  if (recordedPath !== null && localStamps.has(recordedPath)) return recordedPath;
  return null;
}

/**
 * The chain that decides each path when two of them name it.
 *
 * Two live chains at one path is a state the engine accepts: two devices created the same
 * note while out of touch, a peer's move landed beside a file this device created at the
 * vacated path, or a create raced a rename. Exactly one of them may write the file, and
 * every device has to pick the same one — otherwise each device applies the *other*
 * chain's bytes, pushes them back onto its own chain, and the two trade the note's content
 * on every pass (measured: two devices that created `note.md` independently flipped
 * between each other's text forever, one conflict copy each).
 *
 * The winner is the chain whose head the **server** stamped latest: `createdAt` is the
 * server's clock, so the answer is identical everywhere, unlike a local mtime or an
 * arrival order. A chain with a `delete` head owns nothing (a tombstone lives at no path).
 * The fileId breaks a tie, so two heads stamped in the same millisecond still agree
 * everywhere.
 *
 * The loser may still **push** its local bytes (that is how its chain catches up with the
 * winner); it never writes the file.
 */
export function pathOwners(view: PassView, state: LocalVersionState): Map<string, string> {
  const newest = new Map<string, ChainRef>();
  for (const [fileId, chain] of view.chainByFileId) {
    const head = remoteHead(chain);
    if (!head || head.action === "delete") continue;
    const { plainPath, recordedPath } = chainPaths(fileId, view, state);
    const path = recordedPath ?? plainPath;
    if (path === null) continue;
    const current = newest.get(path);
    if (current === undefined || isNewerHead({ fileId, head }, current)) {
      newest.set(path, { fileId, head });
    }
  }
  const owners = new Map<string, string>();
  for (const [path, entry] of newest) owners.set(path, entry.fileId);
  return owners;
}

/** A chain and its live head: the two things the owner rule compares. */
export interface ChainRef {
  fileId: string;
  head: VersionChainEntry;
}

/**
 * Whether `left` is the newer of two chains that name one path (see {@link pathOwners}).
 *
 * The server's `createdAt` decides, and a tie falls back to the fileId so that two heads
 * stamped in the same millisecond still produce the same answer on every device.
 */
export function isNewerHead(left: ChainRef, right: ChainRef): boolean {
  if (left.head.createdAt !== right.head.createdAt) {
    return left.head.createdAt > right.head.createdAt;
  }
  return left.fileId < right.fileId;
}

/**
 * The order a pass works its files in.
 *
 * A remote move in flight puts one chain at two paths — the file on disk at the state's
 * path, the server's record at the other — and in that window the local path is the one on
 * screen. A tracked chain goes before a remote-only one at the same rank (see
 * `PrioritizedEntry.locallyTracked`): while a peer's move is in flight, the chain whose file
 * is on disk has to settle the path before the remote-only chain reads it.
 */
export function orderedFileIds(
  fileIds: readonly string[],
  view: PassView,
  state: LocalVersionState,
): string[] {
  return orderByPriority(
    fileIds.map((fileId, position) => {
      const { plainPath, recordedPath } = chainPaths(fileId, view, state);
      // The local file's **current** stamp is the recency signal for a file the user
      // edits; a remote-only chain has none, so its head's recorded mtime stands in.
      const stampPath = listedStampPath(plainPath, recordedPath, view.localStamps);
      const localMtime = stampPath === null ? undefined : view.localStamps.get(stampPath)?.mtimeMs;
      const head = remoteHead(view.chainByFileId.get(fileId) ?? []);
      return {
        key: fileId,
        paths: [recordedPath, plainPath],
        mtimeMs: localMtime ?? head?.mtimeMs ?? state[fileId]?.stamp?.mtimeMs ?? 0,
        locallyTracked: state[fileId] !== undefined,
        position,
      };
    }),
    view.priority,
  );
}

/**
 * How much memory one file's operation can hold at once.
 *
 * A pull carries a peer's version; a push/rename carries the local bytes. The larger of the
 * two decides whether the file may share the pool with others, so a bind never holds
 * several large payloads at once — the same rule the host's `OpQueue` applies to
 * event-driven work.
 */
export function weightOfFile(
  fileId: string,
  view: PassView,
  state: LocalVersionState,
  limits: OpQueueLimits,
): OpWeight {
  const { plainPath, recordedPath } = chainPaths(fileId, view, state);
  const stampPath = listedStampPath(plainPath, recordedPath, view.localStamps);
  const localSize = stampPath === null ? 0 : (view.localStamps.get(stampPath)?.sizeBytes ?? 0);
  const head = remoteHead(view.chainByFileId.get(fileId) ?? []);
  return weightForSize(limits, Math.max(head?.sizeBytes ?? 0, localSize));
}

/**
 * The versions a pass is about to pull, for the read-ahead, in the order the loop will take
 * them.
 *
 * A file whose head this device already holds is skipped — that is a convergence, not a
 * download — as is one outside the scope: reading it ahead would spend bytes on content the
 * scope says this device does not sync. The order is the loop's own, so a read-ahead in
 * server order does not spend its requests on the files the user is not looking at.
 */
export function prefetchCandidatesForPass(
  ordered: readonly string[],
  view: PassView,
  state: LocalVersionState,
  localHashes: ReadonlyMap<string, string>,
  isSyncable: (path: string) => boolean,
): PrefetchCandidate[] {
  const held = new Set<string>(localHashes.values());
  const candidates: PrefetchCandidate[] = [];
  for (const fileId of ordered) {
    const head = remoteHead(view.chainByFileId.get(fileId) ?? []);
    if (!head || head.action === "delete") continue;
    if (held.has(head.contentHash)) continue;
    const { plainPath } = chainPaths(fileId, view, state);
    if (plainPath === null || !isSyncable(plainPath)) continue;
    candidates.push({ contentHash: head.contentHash, sizeBytes: head.sizeBytes });
  }
  return candidates;
}

/**
 * The same read-ahead for a notification burst, from the chains the batch fetched.
 *
 * `applyPaths` is the path the apply will decide on for each chain — the state's own path when
 * this device tracks it, otherwise the head's recorded path. It is the path the scope check
 * must see: during a peer's move the two differ, and reading ahead for a path the apply will
 * reject would spend bytes on content invariant 8 says this device does not sync.
 */
export function prefetchCandidatesForBurst(
  chains: ReadonlyMap<string, readonly VersionChainEntry[]>,
  applyPaths: ReadonlyMap<string, string | null>,
  state: LocalVersionState,
  isSyncable: (path: string) => boolean,
): PrefetchCandidate[] {
  const candidates: PrefetchCandidate[] = [];
  for (const [fileId, chain] of chains) {
    const head = remoteHead(chain);
    if (!head || head.action === "delete") continue;
    // The head being this device's own sync point is the one case that cannot pull — not
    // the recorded content hash, which a peer can revert to with a newer version.
    if (state[fileId]?.lastKnownVersionId === head.versionId) continue;
    const path = applyPaths.get(fileId) ?? null;
    if (path === null || !isSyncable(path)) continue;
    candidates.push({ contentHash: head.contentHash, sizeBytes: head.sizeBytes });
  }
  return candidates;
}
