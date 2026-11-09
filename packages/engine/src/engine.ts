import type {
  HistoryKind,
  SyncAction,
  SyncPushResponse,
  VaultSyncIndexResponse,
  VersionChainEntry,
} from "@courier/shared";
import {
  CHUNK_STORED_BYTES,
  MAX_PULL_BATCH_FILES,
  MAX_PUSH_BATCH_FILES,
  MAX_ENCRYPTED_PATH_LENGTH,
  chunkAdditionalData,
} from "@courier/shared";
import {
  decryptChunkBytes,
  decryptCombinedBytes,
  decryptString,
  encryptChunkBytes,
  encryptCombinedBytes,
  encryptString,
  Sha256,
  sha256Hex,
  sha256Text,
} from "./crypto";
import { chunkBounds, chunkCountForSize, shouldTransferInChunks } from "./chunked-transfer";
import { ActivityReporter } from "./activity-reporter";
import { ConflictResolver } from "./conflict";
import { ContentReader } from "./content-reader";
import type { Platform } from "./platform";
import { generateFileId, generateVersionId } from "./ids";
import { isConflictFile } from "./conflict-file";
import { historyKindFor } from "./file-types";
import { LocalEventJob, type LocalEventJobHost, type TombstoneLedger } from "./local-event-job";
import { PushBatch, type BatchPushResult } from "./push-batch";
import { ExcludedMoveFinder } from "./excluded-moves";
import {
  isConfigPath,
  isSyncablePath,
  normalizeScope,
  outOfScopeReason,
  syncsAnySettings,
  withinFileSizeCap,
  type SettingsGroup,
  type SyncOutOfScopeReason,
  type SyncScope,
  type SyncScopeInput,
} from "./sync-scope";
import type { LocalVersionState } from "./state";
import { sameStamp } from "./state";
import {
  decideFile,
  decideInputFrom,
  decideNewLocalFile,
  decideRefusedPush,
  classifyPushResult,
  needsFreshRead,
  remoteHead,
  EVENT_DECISION_ATTEMPTS,
  type DecideContext,
  type FileDecision,
  type TombstoneHandling,
} from "./decide";
import { SelfEventLog } from "./self-events";
import { RemoteIndex } from "./remote-index";
import {
  ContentPrefetcher,
  normalizePrefetchLimits,
  type ContentPrefetchLimits,
  type ContentPrefetchStats,
} from "./content-prefetch";
import {
  chainPaths,
  orderedFileIds,
  prefetchCandidatesForBurst,
  prefetchCandidatesForPass,
  weightOfFile,
} from "./pass-view";
import { normalizePriorityPaths, orderByPriority, priorityRanks } from "./priority";
import { DEFAULT_OP_QUEUE_LIMITS, weightForSize, type OpQueueLimits } from "./op-queue";
import { WorkPool } from "./work-pool";
import { PathQueue } from "./path-queue";
import { MAX_RATE_LIMIT_WAITS, isRateLimitError, rateLimitWaitMs, sleep } from "./rate-limit";
import type { PushFile } from "./api";
import type { SyncApi } from "./api";
import type { SyncAdapter } from "./adapter";
import type { FileStamp } from "./adapter";

/**
 * A conflict the engine resolved by **the remote head winning**, with the local side
 * (when there was any) parked as a conflict file.
 *
 * A conflict inside Obsidian's config folder is deliberately not one of these: it is
 * settled by last modification time, silently, because a copy parked there is invisible
 * to the app (see `ConflictResolver`).
 */
export interface ConflictResolvedEvent {
  fileId: string;
  /** The path the local side lived at — the one the conflict was detected on. */
  plainPath: string;
  /** Where the local content was parked, or null when there was none to keep. */
  conflictPath: string | null;
  /** What the remote head did locally: overwrite the file, or delete it. */
  remoteAction: "write" | "delete";
}

/**
 * Why one activity event did not happen: a switch, the account's size cap, or a path
 * the API cannot carry. The first four are the scope's own reasons
 * ({@link SyncOutOfScopeReason}); `pathTooLong` is the API's bound on `encryptedPath`.
 */
export type SyncActivitySkipReason = SyncOutOfScopeReason | "pathTooLong";

/** Whether this device sent a change out, or handled one that came in. */
export type SyncActivityDirection = "out" | "in";

/**
 * One sync decision this device made, reported for the host's own activity log.
 *
 * This is a **host-facing UI feed**, not a sync rule: nothing in the engine decides
 * anything from it, and a host that ignores it syncs exactly the same. It exists because
 * the history dialog used to reconstruct "what happened" from the server's full version
 * chains and the device label; that reconstruction changed whenever a setting or the
 * device name changed, which made a past row look like a different event. A live event
 * carries the answer at the moment the engine decided it, so the row can freeze.
 *
 * `applied` is a push the server accepted (`out`) or a remote version written, moved or
 * deleted locally (`in`). `skipped` is a path this device deliberately left alone; the
 * reason is the switch that fired, at the time it fired.
 */
export interface SyncActivityEventBase {
  direction: SyncActivityDirection;
  fileId: string | null;
  /**
   * The version this decision was about, when there was one. `null` for a local file
   * skipped before a version existed (over the size cap, too long a path).
   */
  versionId: string | null;
  plainPath: string;
  /** What the change was, when the decision got far enough to know. */
  action: SyncAction | null;
  sizeBytes: number;
  /**
   * The label the pushing client stated, when this device knows it.
   *
   * An incoming WebSocket notification supplies the pusher's label; a chain discovered by
   * a reconcile does not (the server's index request omits it). An outgoing event carries
   * `null` from the engine — it does not know this client's current label — and the
   * plugin's host fills it in from the settings the push was made under. Display only:
   * direction never compares it.
   */
  deviceName: string | null;
}

export type SyncActivityEvent =
  | (SyncActivityEventBase & { outcome: "applied" })
  | (SyncActivityEventBase & { outcome: "skipped"; reason: SyncActivitySkipReason });

/** One `file_pushed` notification, as the host coalesced it for a batched pull. */
export interface PushedFileEvent {
  fileId: string;
  versionId: string;
  /** The label the pushing client stated; display metadata only. */
  deviceName?: string | null;
}

export interface EngineOptions {
  vaultId: string;
  adapter: SyncAdapter;
  api: SyncApi;
  encryptionKey: CryptoKey;
  /**
   * Which paths this device syncs: markdown and canvas always, the vault-wide file
   * types it switched on, the config-folder groups it switched on, and the size cap.
   * Defaults to {@link DEFAULT_SYNC_SCOPE}.
   */
  syncScope?: SyncScopeInput;
  /**
   * Called once per conflict the engine resolves **outside the config folder** (see
   * {@link ConflictResolvedEvent}). A config-folder conflict is settled silently by
   * modification time and never reported here.
   */
  onConflictResolved?: (event: ConflictResolvedEvent) => void;
  /**
   * Called for a file this device skipped because it is larger than
   * `SyncScope.maxFileBytes`, in either direction (a local file it will not push, or a
   * peer's version it will not pull). At most once per path per pass.
   */
  onFileTooLarge?: (event: FileTooLargeEvent) => void;
  /**
   * Called for a file this device skipped for a reason that is not its size — today
   * only `path-too-long`: the API bounds `encryptedPath`, and a path over that bound
   * would be refused for the **whole batch** it travelled in, so the file is left
   * out (and the rest of the batch still syncs). At most once per path per pass.
   */
  onFileSkipped?: (event: FileSkippedEvent) => void;
  /**
   * Called once for every file **inside the config folder** this engine applied from
   * the remote (see {@link SettingsAppliedEvent}). Obsidian keeps its own copy of the
   * settings it has already read, so a config file that lands on disk is not what a
   * running Obsidian shows — the host is the only one that can tell the user, and this
   * is the hook it needs. Nothing is reported for the vault's own files.
   */
  onSettingsApplied?: (event: SettingsAppliedEvent) => void;
  /**
   * One decision this device made: a version sent, a remote version applied, or a path
   * it deliberately skipped (see {@link SyncActivityEvent}).
   *
   * The plugin feeds this into its session log. It is optional and the CLI omits it; a
   * listener that throws is logged and does not stop the sync that reported it.
   */
  onSyncActivity?: (event: SyncActivityEvent) => void;
  /**
   * Called when a job queued behind one of the engine's own writes fails.
   *
   * The host that fired the event gets a resolved promise — waiting there would wait for
   * the write that is waiting for the handler — so this is where the failure surfaces.
   * Without it a deferred push/pull failure would only reach the console, which
   * invariant 5 forbids.
   */
  onError?: (error: unknown, paths: readonly string[]) => void;
  /** Called whenever synced state changes so hosts can persist it. */
  onSaveState?: (json: string) => void;
  /**
   * How far the current pass has got (see {@link SyncProgress}).
   *
   * Reported at coarse steps — every 25 settled files, plus one
   * call when the pass starts with a known total and one when it ends — so a host can
   * show "1 200 / 10 000" during a first bind without a callback per file. A pass with
   * nothing to do reports nothing. A listener that throws is ignored, like
   * {@link onSyncActivity}.
   */
  onProgress?: (progress: SyncProgress) => void;
  /**
   * The pass is about to wait out a server rate limiter, for `waitMs`.
   *
   * The pass carries on by itself (see `withRateLimitWaits`), so this is purely "why is
   * nothing happening for a minute": a host should log it, and is free to ignore it.
   * Reported once per wait, not once per refused request.
   */
  onRateLimited?: (event: { waitMs: number }) => void;
  /**
   * How many per-file operations one pass may run at once, and the size at which one
   * runs alone (see `WorkPool`). Defaults to the same limits the host uses for events;
   * a pass and an event burst do not share the pool.
   */
  opLimits?: OpQueueLimits;
  /**
   * How a pass waits out a rate limiter's window (see `withRateLimitWaits`).
   *
   * Defaults to a plain timer. A host that can stop mid-wait supplies a function that
   * rejects when it stops: the refusal is then answered to the caller instead of being
   * retried, because nobody is left to sync for — and the host's background count (and,
   * in a host, the vault lease) must not be held for the whole window.
   */
  wait?: (ms: number) => Promise<void>;
  /**
   * Reading content ahead of the per-file loop (see {@link ContentPrefetcher}).
   *
   * On by default with {@link DEFAULT_CONTENT_PREFETCH_LIMITS}: a cold download's wall
   * clock is `waves × round trip`, and a wave is one `WorkPool` slot, so the read-ahead
   * is the only way to put more files in one round trip without widening the pool (and
   * raising the per-file memory bound with it). `false` turns it off — the benchmark
   * uses that to measure both paths — and an object overrides the limits.
   *
   * It changes no decision: a prefetched file is still decrypted, verified and written
   * by the pull that needs it, and a miss simply reads it the old way.
   */
  contentPrefetch?: false | Partial<ContentPrefetchLimits>;
  /**
   * The runtime this pass runs on (see `Platform`).
   *
   * Required: the engine names no global of its own, so every construction site states
   * which runtime it is on. The default `wait` (the one timer on this path) schedules
   * through it.
   */
  platform: Platform;
}

/**
 * How far one pass has got: files settled / files the pass has taken on.
 *
 * `total` **grows during a pass**: a bind discovers the local files it must create as it
 * walks the vault, so it starts with only the chains it already knows. `done === total`
 * therefore means "this pass is finished" rather than "a fixed job is half done", and a
 * host should show the pair as a counter rather than a fixed-width bar.
 */
export interface SyncProgress {
  /** Files whose decision has been carried out (pushed, pulled, skipped or refused). */
  done: number;
  /** Files this pass has taken on so far. */
  total: number;
}

/** A file the size cap kept out of this sync, and how big it is. */
export interface FileTooLargeEvent {
  plainPath: string;
  sizeBytes: number;
}

/** A file the API's own limits kept out of this sync, and why. */
export interface FileSkippedEvent {
  plainPath: string;
  reason: "path-too-long";
}

/**
 * One settings file this device applied from the remote.
 *
 * The config folder is the one part of a vault the running app does **not** re-read:
 * Obsidian reads `.obsidian/core-plugins.json` and friends at start-up and then works
 * from memory, so applying a peer's copy changes the file and nothing else. Which of
 * those the app picks up on its own is a property of the **platform**, not of this
 * engine, so the event names the path and the group it belongs to and leaves the
 * judgement to the host.
 */
export interface SettingsAppliedEvent {
  /** The path the version was applied at — its new path, when the peer moved the file. */
  plainPath: string;
  /** What the applied version did to this device. */
  action: "write" | "rename" | "delete";
  /**
   * The config-folder group that owns the path (`settingsGroupOf`). Never null: a path
   * only reaches this report through the scope, which gives every syncable config path
   * exactly one owning group.
   */
  group: SettingsGroup;
}

/**
 * What one pass's local scan found, and what it deliberately left alone.
 *
 * A value object rather than five containers threaded through six positional parameters:
 * four of them are collections the compiler tells apart only by their type parameters, and
 * every site that reads the result means "the scan", not "the fourth argument". Its maps are
 * the pass's snapshot — filled here, read-only to everything after it (the create batch
 * reuses a hash only while the bytes it re-read still match that hash's stamp).
 */
interface LocalScan {
  /** plainPath → hash, for the files the scan hashed (or reused a recorded hash for). */
  readonly hashes: Map<string, string>;
  /** plainPath → the stamp its hash was taken at, so a converged file can be stamped. */
  readonly stamps: Map<string, FileStamp>;
  /** Paths the pass leaves exactly as they are (not statable, or over the size cap). */
  readonly skipped: Set<string>;
  /** The subset of {@link skipped} over the **upload** cap (still takes a peer's version). */
  readonly overCap: Set<string>;
  /**
   * Local files the scan did **not** hash, because no chain can claim them: a file with no
   * state entry and no remote chain can only be a `create`, and the create reads it once
   * (see `createUntrackedFiles`). Keeping them out of {@link hashes} is what stops a first
   * bind from reading every file twice.
   */
  readonly untracked: string[];
}

/**
 * Everything one reconcile pass decided from: the snapshot it took when it started
 * (the local listing's hashes and stamps, the remote chains and their paths) plus the
 * paths it must leave alone.
 *
 * Passed as one object rather than seven positional arguments, and it is deliberately
 * read-only: a pass decides from this snapshot and re-reads a file before writing it,
 * which is what keeps it from acting on bytes that moved while it ran.
 */
interface ReconcilePass {
  /** Every fileId the pass considers: the ones this device tracks, plus the server's live paths. */
  fileIds: Set<string>;
  /** plainPath → hash, for the files the pass hashed (or reused a recorded hash for). */
  localHashes: Map<string, string>;
  /** The scan's files it deliberately did not hash (see {@link LocalScan.untracked}). */
  untrackedPaths: readonly string[];
  /** fileId → its chain, oldest → newest. */
  chainByFileId: Map<string, VersionChainEntry[]>;
  /** What the server holds, as of this pass (see `RemoteIndex`). */
  remote: RemoteIndex;
  /** Paths the pass leaves exactly as they are (not statable, or over the size cap). */
  skippedPaths: Set<string>;
  /**
   * The subset of {@link skippedPaths} whose local copy is over the **upload** cap.
   *
   * The cap refuses what this device sends, not what it receives: such a path still has
   * to take a peer's newer version, or the file is silently stale — exactly the failure
   * the upload-only rule exists to remove. It is kept separate from `skippedPaths`
   * because the two need different answers: an unstatable path is left alone entirely,
   * while an over-cap one still gets the pull half (see `applyOverCapRemote`).
   */
  overCapPaths: Set<string>;
  /** plainPath → the stamp its hash was taken at, so a converged file can be stamped. */
  localStamps: Map<string, FileStamp>;
  /**
   * The user's paths, as a rank: the file the app has open first, then the files it
   * opened most recently. A preference only — the pass still decides every file.
   */
  priority: ReadonlyMap<string, number>;
  /**
   * Each chain's sync point when the pass began.
   *
   * Serialization orders the writes, not the snapshots: an event can adopt a newer
   * version after this pass fetched its chain, and the pass's head is then older than
   * the state. A job for such a file would pull its stale head over the event's bytes
   * (a rollback), so it skips: the event settled the file, and the next pass decides
   * from the fresh chain.
   */
  stateAtStart: ReadonlyMap<string, string | null>;
}

/**
 * What {@link SyncEngine.settleSynced} needs once a pass decision is `synced`.
 *
 * A value object rather than eight positional arguments: three of them are nullable paths
 * and one is an optional chain head, which the compiler cannot tell apart.
 */
interface SyncedSettlement {
  fileId: string;
  /** The path this device has the file at, when it has one. */
  plainPath: string | null;
  /** The path the chain's head records, when the server records one. */
  recordedPath: string | null;
  /** The pass's chain for the file, oldest → newest. */
  chain: VersionChainEntry[];
  head: VersionChainEntry | undefined;
  entry: LocalVersionState[string] | undefined;
  localExists: boolean;
  pass: ReconcilePass;
}

/** What {@link SyncEngine.settlePushed} needs once a pass decision is `push`. */
interface PushSettlement {
  fileId: string;
  plainPath: string;
  decision: Extract<FileDecision, { action: "push" }>;
  head: VersionChainEntry | undefined;
  localExists: boolean;
  /** The pass's tombstones, which a deletion adds to. */
  pendingDeletes: PendingTombstone[];
}

/**
 * One tombstone a pass decided on, held for its batched delete push.
 *
 * The base is the head the decision was taken from: the batch re-checks it before the
 * request goes out, so a version a pull adopted while the pass ran is not deleted from
 * under a decision that never saw it.
 */
interface PendingTombstone {
  readonly fileId: string;
  readonly path: string;
  readonly baseVersionId: string | null;
}

/**
 * One version to push, as the callers that decide it describe it.
 *
 * A single object rather than six positional arguments — three of them strings and one
 * nullable, which is a signature nobody can read and the compiler cannot protect
 * (`bytes` and `baseVersionId` are one transposition apart).
 */
interface PushRequest {
  fileId: string;
  plainPath: string;
  action: SyncAction;
  /** The bytes on disk, or undefined for a version that carries no content (`delete`). */
  bytes: Uint8Array | undefined;
  /**
   * The content hash, when the caller already has it for these bytes — or, for a
   * content-less `rename`, when the sync point's stamp proves they have not changed.
   *
   * Omitting it makes {@link SyncEngine.preparePush} hash `bytes` again; a large edit
   * used to hash the same file three times (the echo check, the decision, and here).
   */
  contentHash?: string;
  /**
   * The plaintext size, for a version that carries no `bytes` but is not a `delete`:
   * a `rename` whose bytes the store already holds. Defaults to `bytes.byteLength`, or
   * 0 for a delete.
   */
  sizeBytes?: number;
  /** The chain head this push was decided from; `null` for a file believed to be new. */
  baseVersionId: string | null;
  /** The stamp the bytes were read at, recorded with the sync point on success. */
  stamp: FileStamp | null;
  /**
   * The modification time to record when {@link stamp} cannot supply one.
   *
   * A `delete` has no file to stamp and a restore writes one just before pushing, so
   * those two pass the moment this device acted (a deletion reuses the moment it was
   * decided, see `deletedAtMs`). Everywhere else the stamp the bytes were read at is
   * the answer. Omitting it records `0`, which loses any config-folder conflict against
   * a real version — the honest outcome when this device cannot say when the file was
   * last modified.
   */
  mtimeMs?: number;
}

/**
 * A push that has been decided and prepared but not yet sent — see
 * {@link SyncEngine.preparePush}. A pass collects these so several files can travel
 * in one request.
 */
interface PreparedPush {
  fileId: string;
  plainPath: string;
  action: SyncAction;
  versionId: string;
  encryptedPath: string;
  contentHash: string;
  sizeBytes: number;
  /**
   * Plaintext last modification time that goes on the version (ms since the epoch).
   *
   * For a content-carrying push it is the stamp the bytes were read at; a version with
   * no file behind it — a `delete`, or a restore written a moment ago — carries the
   * moment this device acted (see `PushRequest.mtimeMs`). A peer compares it with its
   * own file stamp to settle a conflict inside Obsidian's config folder by "newer
   * modification wins".
   */
  mtimeMs: number;
  baseVersionId: string | null;
  /** The stamp taken for the version's bytes, recorded with the sync point on success. */
  stamp: FileStamp | null;
  /**
   * The bytes read from disk, kept so the ciphertext can be encrypted on demand.
   * Dropped once the ciphertext exists (see {@link contentFor}), so a batch holds one
   * copy of a file's payload rather than two.
   */
  plainBytes: Uint8Array | undefined;
  /** The ciphertext, encrypted the first time something asks for it. */
  content: Uint8Array | null;
  /** Whether the store already holds `contentHash`, so the payload can be omitted. */
  reusesStoredContent: boolean;
  /**
   * How many chunks the payload travels in, or `0` when it travels in one request.
   *
   * Non-zero only for a content-carrying version above `CHUNKED_TRANSFER_THRESHOLD`;
   * the upload stages them through the chunk endpoints and the push carries
   * `contentChunks` instead of a payload.
   */
  chunkCount: number;
  /**
   * Which of the vault's two retention categories the version belongs to.
   *
   * Decided when the push is prepared — the plaintext path is the only place the category
   * is visible (see `historyKindFor`) — and carried until the request is built, so the
   * wire shape has exactly one source of truth (see {@link wireFile}).
   */
  historyKind: HistoryKind;
}

/**
 * What an event read from disk before deciding: the bytes, and the stamp they came with.
 */
interface LocalChangeRead {
  bytes: Uint8Array;
  stamp: FileStamp;
}

/**
 * One burst of local vault events, as a host collects it.
 *
 * `changed` are paths whose file was created or modified; `deleted` are paths whose file
 * was removed; `renamed` are the moves (`from` → `to`). They are separate because each is
 * decided from a different fact — a change by reading the file, a deletion by its absence,
 * a move by re-pointing the chain at the destination — and mixing them would drop the
 * tombstones, or turn a move into a delete plus a second chain.
 */
export interface LocalEventBatch {
  changed?: readonly string[];
  deleted?: readonly string[];
  renamed?: ReadonlyArray<{ from: string; to: string }>;
}

/**
 * Most ciphertext one batched push may hold.
 *
 * A batch keeps every file's plaintext alive until the request is built, so this is
 * what bounds a bind's memory: files are grouped up to this much and no further, and a
 * file larger than the bound travels alone. The value is deliberately well under the
 * 50 MiB default cap — the point of batching is to save round trips for many small
 * notes, not to hold a vault's attachments at once.
 */
const MAX_PUSH_BATCH_BYTES = 8 * 1024 * 1024;

/**
 * Whether a failed content read means "the store holds nothing for that hash".
 *
 * The content route answers `404` for a hash it does not hold (reclaimed by the recycle
 * bin or retention, or a chain pointing at content no peer can fetch). Every other
 * failure — a 429, a 5xx, a transport error — is a request that did not happen, and the
 * pull has to report it instead of pretending the blob is gone. Duck-typed for the same
 * reason as the rate-limit check: a host may inject any `SyncApi` implementation.
 */
function isMissingContentError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { status?: unknown }).status === 404;
}

/**
 * What a restore would write into, resolved *before* anything is written.
 *
 * A restore resurrects a deleted file at the path it used to live at, but that
 * path can have been taken since — a note created there, or a file this device
 * has not indexed yet. The engine never overwrites in that case; it reports the
 * shape so the caller can offer to restore under another name instead.
 */
export interface RestoreTargetStatus {
  /** Who currently holds the path a restore would write to. */
  kind: "free" | "same-chain" | "other-file" | "unattributed";
  /** The chain holding the path, when another one does (`kind: "other-file"`). */
  holderFileId: string | null;
}

/** Why {@link SyncEngine.restoreFile} refused to write. */
export type RestoreBlockReason = "occupied-by-other-file" | "unattributed-local-file";

/**
 * Thrown by {@link SyncEngine.restoreFile} when the path it was asked to write is
 * not free. Callers turn this into a "restore under another name" dialog rather
 * than overwriting whatever is there.
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
 * Thrown by {@link SyncEngine}'s push path when the server refused a version
 * because the chain's head is not the base the push was decided from
 * (`status: "stale_base"`): a peer pushed while this client was deciding. Nothing
 * was written. `chain` is the chain the server has now, so the caller can decide
 * again from it without a second request.
 */
export class SyncPushBaseError extends Error {
  constructor(
    readonly fileId: string,
    readonly plainPath: string,
    readonly chain: VersionChainEntry[],
  ) {
    super(
      `Push refused for ${plainPath}: the remote chain moved to ${remoteHead(chain)?.versionId ?? "(none)"}`,
    );
    this.name = "SyncPushBaseError";
  }
}

/**
 * The unified TypeScript sync engine. Hosts (Obsidian plugin, headless CLI)
 * inject a filesystem adapter, network API, encryption key and conflict
 * policy; the engine owns scanning, decision, push/pull, echo suppression and
 * conflict handling.
 */
export class SyncEngine {
  private state: LocalVersionState = {};
  private pathToFileId = new Map<string, string>();
  /**
   * What the server holds, as of the last full reconcile: the live path, head and content
   * hash of every chain this device may touch. It lets an incremental local event
   * recognise a path the server already tracks under another identity — the case that
   * used to fork a second chain for a path the vault has (see `adoptRemoteIdentity`) —
   * and lets a file at a path no chain records be matched by content.
   */
  private readonly remoteIndex = new RemoteIndex();
  /**
   * The events this engine has to recognise as its own: the vault event its own write
   * fires, the echo of its own push, the delete it performed (which a new file with the
   * same content may turn out to be the rename of). Time-bounded, content-matched, and
   * on an injected clock — see `self-events.ts`.
   */
  private readonly selfEvents = new SelfEventLog();
  /**
   * Streamed writes whose commit is still in flight (path → the stamp `close` will land).
   *
   * The host's watcher can fire the event for the rename before the adapter has answered
   * `close`, and the event handler must not read the whole file just to discover it was
   * this engine's write. An event that finds a path here waits for the commit's stamp and
   * compares it; see `SelfEventLog.matchesSelfWriteStamp`.
   */
  private readonly streamedCommits = new Map<string, Promise<FileStamp | null>>();
  /**
   * One job queue per path: every operation that may read or write a path runs after the
   * jobs already queued for it, so two operations on one path never interleave.
   *
   * This is what makes the engine's multi-step changes (a pull's write and its sync
   * point, a delete's state and index, a rename's two paths) invisible to another
   * operation: the change is one job, and the next job on that path starts after it.
   */
  private readonly paths = new PathQueue();
  /**
   * Paths this engine is writing right now, so a vault event the write fires can be
   * queued without waiting for it (see `schedule`).
   */
  private readonly writingPaths = new Set<string>();
  /** Tombstone rule for the reconcile currently running (see `TombstoneHandling`). */
  private tombstoneMerge: TombstoneHandling = "apply-remote-delete";
  /** The pass in flight, shared by every call that arrives while it runs. */
  private passPromise: Promise<void> | null = null;
  private initialized = false;
  /**
   * The in-flight (or settled) `sha256("")` — the hash a `delete` version carries.
   * Holding the promise, not the value it settles to, is what lets the first pass's
   * concurrent decisions share one digest instead of one each.
   */
  private emptyHashPromise: Promise<string> | null = null;
  /** Single-flight marker for {@link syncLocalSettings}. */
  private settingsPollRunning = false;

  /** Which paths this device syncs (see `SyncScope`). */
  private readonly scope: SyncScope;
  /** How many per-file operations one pass may run at once (see `WorkPool`). */
  private readonly passLimits: OpQueueLimits;
  /**
   * The read-ahead beside the per-file loop, or `null` when the host turned it off
   * (see {@link EngineOptions.contentPrefetch}).
   */
  private readonly prefetcher: ContentPrefetcher | null;
  /** Batched content reads for every version a pass or a burst pulls (see `ContentReader`). */
  private readonly content: ContentReader;
  /** What this pass tells the host: the activity feed, the skip notices and the progress. */
  private readonly activity: ActivityReporter;
  /** How a conflict is settled: remote wins, the local side parked beside it. */
  private readonly conflicts: ConflictResolver;
  /** The excluded-folder fallback for an event-less move (see `ExcludedMoveFinder`). */
  private readonly excludedMoves: ExcludedMoveFinder;

  constructor(private opts: EngineOptions) {
    this.scope = normalizeScope(opts.syncScope);
    this.passLimits = opts.opLimits ?? DEFAULT_OP_QUEUE_LIMITS;
    const prefetch = opts.contentPrefetch;
    this.prefetcher =
      prefetch === false
        ? null
        : new ContentPrefetcher(
            (contentHashes) => this.content.fetch(contentHashes),
            normalizePrefetchLimits(prefetch),
          );
    this.content = new ContentReader({
      api: opts.api,
      vaultId: opts.vaultId,
      platform: opts.platform,
      maxConcurrent: this.passLimits.maxConcurrent,
      prefetcher: this.prefetcher,
      wait: (send) => this.withRateLimitWaits(send),
    });
    this.activity = new ActivityReporter({
      scope: this.scope,
      onFileTooLarge: opts.onFileTooLarge,
      onFileSkipped: opts.onFileSkipped,
      onSettingsApplied: opts.onSettingsApplied,
      onSyncActivity: opts.onSyncActivity,
      onProgress: opts.onProgress,
    });
    this.conflicts = new ConflictResolver({
      scope: this.scope,
      adapter: opts.adapter,
      onConflictResolved: opts.onConflictResolved,
      applyRemote: (fileId, plainPath, head, localContentHash, deviceName) =>
        this.pullRemote(fileId, plainPath, head, localContentHash, deviceName),
      push: (request) => this.pushFile(request),
      withinSizeCap: (path) => this.withinLocalSizeCap(path),
      readLocal: (path) => this.readWithStamp(path),
      refusalChain: (err) => (err instanceof SyncPushBaseError ? err.chain : null),
    });
    this.excludedMoves = new ExcludedMoveFinder({
      listExcludedFiles: async () => (await opts.adapter.listExcludedFiles?.()) ?? [],
      statFile: (path) => opts.adapter.statFile(path),
      readFile: (path) => opts.adapter.readFile(path),
      isClaimed: (path) => this.pathToFileId.has(path) || this.remoteIndex.fileIdAt(path) !== null,
      knownSize: (fileId) => this.state[fileId]?.stamp?.sizeBytes,
      excludedFolders: () => this.scope.excludedFolders.length,
      now: () => Date.now(),
    });
  }

  /**
   * The single scope guard, applied wherever a path enters or leaves the engine:
   * the local listing and events, and the remote chains a notification or a pass
   * brings in. A path the scope rejects is neither pushed, nor pulled, nor turned
   * into a conflict — which is what keeps a device that has settings sync off
   * completely unaffected by a peer that has it on.
   */
  private isSyncable(path: string): boolean {
    return isSyncablePath(path, this.scope);
  }

  /**
   * The same predicate, as a question a caller outside the engine can ask.
   *
   * One path that reaches the engine comes from a *person* rather than from the vault or
   * the server: the new file name a restore is put under (`restoreFile`'s `targetPath`).
   * The dialog asks here instead of rebuilding a scope from the settings it can see,
   * because the scope is read once, when the engine is built — a host that a switch change
   * has just restarted is the authority on what it syncs, and a second computation from
   * the current settings could disagree with it.
   */
  isSyncablePath(path: string): boolean {
    return this.isSyncable(path);
  }

  /**
   * One snapshot of the download read-ahead, or `null` when the host turned it off.
   *
   * The counters are {@link ContentPrefetcher.stats}'s: requests, hits, misses, and the
   * ciphertext currently buffered. They exist for measurement and diagnostics — the cases
   * in the engine suite use them to pin the read-ahead's drops, and a host that wants to
   * check the read-ahead is paying off before tuning it has the same question — so the
   * accessor keeps that question answerable without reaching inside the engine.
   */
  prefetchStats(): ContentPrefetchStats | null {
    return this.prefetcher?.stats() ?? null;
  }

  /**
   * The local half of the size rule: ask the adapter for the size **before** reading the
   * bytes, which is the whole point — a file over the cap is never loaded into memory.
   * Reports the skip through `onFileTooLarge` (once per path per pass) and answers false
   * for a file that vanished since the listing.
   */
  private async withinLocalSizeCap(path: string): Promise<boolean> {
    if (this.scope.maxFileBytes === 0) return true;
    const stamp = await this.opts.adapter.statFile(path);
    if (stamp === null) return false;
    if (withinFileSizeCap(this.scope, stamp.sizeBytes)) return true;
    this.activity.reportSkippedForSize(path, stamp.sizeBytes, this.pathToFileId.get(path) ?? null);
    return false;
  }

  /**
   * Report a local file that is over the upload cap, once per pass and only when it is
   * not already at its sync point.
   *
   * A file over the cap that is exactly at its sync point has nothing to send: it arrived
   * from a peer (the cap bounds uploads, never downloads) or was synced under a higher cap
   * before the administrator lowered it. Reporting it would nag every pass about a file
   * that is perfectly in sync; only a local change this device cannot push is worth the
   * notice. The reconcile scan and the settings poll share this so the two cannot drift.
   */
  private reportOverCapLocal(path: string, stamp: FileStamp): void {
    if (this.cachedHashFor(path, stamp) !== null) return;
    this.activity.reportSkippedForSize(path, stamp.sizeBytes, this.pathToFileId.get(path) ?? null);
  }

  /**
   * Whether this device already recorded `versionId` as a chain's sync point.
   *
   * A version that is already here is not a new decision: a switch turned off, or the
   * account's size cap lowered, must not report it as "not applied" now. Only a version
   * this device has never handled is worth a row. The engine still skips the chain — the
   * guard is about the activity feed, not the sync decision.
   */
  private versionAlreadyApplied(fileId: string, versionId: string): boolean {
    return this.state[fileId]?.lastKnownVersionId === versionId;
  }

  /**
   * `sha256("")` — the content hash a `delete` version carries.
   *
   * A decision needs it to tell "this device's sync point is a tombstone" from "this
   * device last agreed on content", and hashing an empty string per file per pass was
   * a Web Crypto call for a constant. The promise is cached, not its value, so the
   * decisions a pass starts together await one digest instead of one each; a digest
   * that rejects stays cached too, which is enough for a constant the runtime can
   * either hash or not.
   */
  private emptyContentHash(): Promise<string> {
    return (this.emptyHashPromise ??= sha256Text(""));
  }

  // ── State persistence ──

  loadState(json: string): void {
    try {
      const parsed = JSON.parse(json) as LocalVersionState;
      this.state = parsed ?? {};
    } catch {
      this.state = {};
    }
    this.rebuildPathIndex();
  }

  serializeState(): string {
    return JSON.stringify(this.state);
  }

  /** Resolve a plain path to its fileId (version-history entry point). */
  fileIdForPath(path: string): string | null {
    return this.pathToFileId.get(path) ?? null;
  }

  /**
   * The path this client currently holds for a chain, or `null` when it holds
   * none — the deleted-file case (a peer's delete drops the entry) and any chain
   * this device has never synced.
   *
   * The reverse of {@link fileIdForPath}, for a caller that resolved a fileId
   * earlier and needs to re-check where that chain lives now: a UI holding a path
   * from an open dialog has a path that a rename may have moved on from.
   */
  pathForFileId(fileId: string): string | null {
    return this.state[fileId]?.plainPath ?? null;
  }

  /**
   * What a restore of `fileId` at `plainPath` would run into, without writing
   * anything.
   *
   * The recycle bin calls this to choose its interaction — restore straight away,
   * or offer a path to restore under instead — and to mark the rows that cannot be
   * restored as-is.
   */
  async inspectRestoreTarget(fileId: string, plainPath: string): Promise<RestoreTargetStatus> {
    const holder = this.pathToFileId.get(plainPath);
    if (holder === fileId) return { kind: "same-chain", holderFileId: null };
    if (holder) return { kind: "other-file", holderFileId: holder };
    // A stat, not a read: whether a local file claims the path is the whole question,
    // and reading a 200 MiB attachment to answer it was the cost this used to pay.
    const stamp = await this.opts.adapter.statFile(plainPath);
    if (stamp) return { kind: "unattributed", holderFileId: null };
    return { kind: "free", holderFileId: null };
  }

  /**
   * Restore a file to a historical version (or restore a deleted file):
   * fetch the version's content, write it locally, then push `action:"restore"`.
   *
   * `options.targetPath` brings the file back **under another name**: it is
   * written there instead of at the path it was deleted from, which is what the
   * recycle bin offers when another note has taken the old path. Either way the
   * path being written must be free — an occupied one is refused with
   * {@link RestoreBlockedError} rather than silently overwritten, because that
   * would destroy the occupying file's live content and leave two chains claiming
   * one path.
   *
   * The chain's own live path wins over the `plainPath` argument: a caller (an
   * open version-history dialog) can hold a path a rename has moved on from, and
   * writing at it would leave the chain live at two paths at once. A chain this
   * device holds nothing for — the deleted-file case — falls back to the argument.
   *
   * A restore is the one write allowed to land **outside** this device's sync scope: the
   * recycle bin lists what the server holds whatever this device syncs, and a person
   * asking for a version back is an explicit action, not the automatic scope being
   * bypassed. The version is pushed (that is what makes it live for the other devices),
   * and a path inside an excluded folder stays excluded here afterwards — the local copy
   * is not synced, but the chain it was restored on is. Refusing instead would leave no
   * way to recover such a file from the UI.
   */
  async restoreFile(
    fileId: string,
    plainPath: string,
    contentHash: string,
    options: { targetPath?: string } = {},
  ): Promise<void> {
    const target = options.targetPath ?? this.pathForFileId(fileId) ?? plainPath;
    // One job over the target: the "is it free?" check and the write have to agree, and a
    // reconcile or an event deciding for this path in between would invalidate the "free"
    // the check just returned.
    return await this.paths.run(
      [target],
      async () => {
        const status = await this.inspectRestoreTarget(fileId, target);
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

        const chain = await this.pullChain(fileId);
        // A version's size says whether its bytes are chunked, and the chain is the only
        // place this call can learn it: the caller names a content hash, not a size. A
        // hash that is not in the chain cannot be restored — guessing the head's size
        // would read the wrong framing and allocate the wrong buffer — and a pruned
        // version the chain no longer holds is refused the same way.
        const version = chain.find((entry) => entry.contentHash === contentHash);
        if (version === undefined) {
          throw new Error(`Version ${contentHash} is not in this file's history`);
        }
        const bytes = await this.fetchRemoteVersionBytes(
          this.opts.vaultId,
          contentHash,
          version.sizeBytes,
        );
        if (!bytes) {
          throw new Error(`Version content not found for ${contentHash}`);
        }
        // The head this restore is decided from is the chain's, not the state's: a
        // chain that this device deleted (applied from a peer) has no state entry at
        // all, and a restore is a new version on top of wherever the chain stands now.
        // A peer pushing in between still gets refused rather than overwritten.
        // The write below fires a vault event the host feeds straight back into
        // `handleLocalChange`, and it can arrive before `pushFile` has recorded the
        // new state and path (the push awaits a network round trip). Mark the write
        // as our own first, or the event is mistaken for a user edit: a second
        // `restore` push, and a brand-new fileId when the delete came from a peer.
        await this.recordSelfWrite(target, bytes);
        await this.writing([target], () => this.opts.adapter.writeFile(target, bytes));
        // The bytes are on disk now, so the version carries their real stamp instead of a
        // "pushed just now" one: a peer compares that time when the file is a config-folder
        // path, and the sync point gets the stamp a later pass needs to skip re-reading it.
        await this.pushFile({
          fileId,
          plainPath: target,
          action: "restore",
          bytes,
          baseVersionId: remoteHead(chain)?.versionId ?? null,
          stamp: await this.opts.adapter.statFile(target),
        });
        this.persist();
      },
      "event",
    );
  }

  /**
   * Record a write the engine is about to make to the local filesystem, so the
   * vault event that write fires is not mistaken for a user edit.
   *
   * The hash is what makes this precise rather than a mute switch: a genuine edit that
   * lands in the window has different bytes, so it is still handled normally. The
   * record itself — and its window — live in {@link SelfEventLog}.
   */
  private async recordSelfWrite(path: string, bytes: Uint8Array): Promise<void> {
    this.selfEvents.recordSelfWrite(path, await sha256Hex(bytes));
  }

  /**
   * Record a write whose hash is already known.
   *
   * A streamed download never holds the bytes, so it cannot hash them at the end; the
   * head's content hash is exactly what the vault event will read back.
   */
  private recordSelfWriteHash(path: string, contentHash: string, stamp?: FileStamp): void {
    this.selfEvents.recordSelfWrite(path, contentHash, stamp);
  }

  /**
   * True when `bytes` are the echo of a write this engine just performed.
   *
   * A path with no record is the ordinary user edit: hashing the file to find that out
   * was a full pass over the content for an answer the log already had. The content
   * match still decides when a record exists — a genuine edit inside the window has
   * different bytes.
   */
  private async isOwnWrite(path: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.selfEvents.hasSelfWrite(path)) return false;
    return this.selfEvents.isSelfWrite(path, await sha256Hex(bytes));
  }

  /**
   * Record a delete the engine is about to perform locally.
   *
   * Applying a peer's delete has no bytes to match on, and the `delete` event
   * arrives before the engine has cleared its path → fileId mapping — so without
   * this the engine pushes a second, redundant tombstone. That tombstone is not
   * cosmetic: the recycle bin reads the version *before* the delete as the
   * restorable one, so the extra tombstone makes the file's `previousContentHash`
   * the hash of an empty string and the file can no longer be restored.
   */
  private recordSelfDelete(path: string): void {
    this.selfEvents.recordSelfDelete(path);
  }

  /**
   * True when this delete is the echo of one the engine just performed. Consumed
   * once; a delete still on the books when its window expires is forgotten, and a
   * following reconcile pushes a genuine local delete it missed.
   */
  private consumeSelfDelete(path: string): boolean {
    return this.selfEvents.consumeSelfDelete(path);
  }

  /**
   * Record a move the engine is about to perform locally, for the same reason as
   * {@link recordSelfWrite}: following a peer's move renames the local file, and
   * that event arrives while the engine still maps the old path — so without this
   * the move is pushed back as a second `rename` version.
   */
  private recordSelfRename(from: string, to: string): void {
    this.selfEvents.recordSelfRename(from, to);
  }

  /** True when this move is the echo of one the engine just performed. */
  private consumeSelfRename(from: string, to: string): boolean {
    return this.selfEvents.consumeSelfRename(from, to);
  }

  /**
   * Queue one local event as a job, and answer when it has run.
   *
   * A host can feed the vault event of this engine's own write back *inside* the adapter
   * call that performs it. Waiting for the job there would wait for the write that is
   * waiting for the handler, so such a call queues the job and returns: the write
   * finishes, then the job runs. Its failure is reported here because the caller that
   * would have handled the rejection is the adapter, which has no place for it.
   */
  private schedule(paths: readonly string[], job: () => Promise<void>): Promise<void> {
    const deferred = paths.some((path) => this.writingPaths.has(path));
    // A deferred job's caller returns before it runs, so the job persists its own state:
    // otherwise the state the event applied is only in memory, and a host that reloads
    // from the store (or the tests' `state.json`) sees the version before it.
    const run = deferred
      ? async (): Promise<void> => {
          try {
            await job();
          } finally {
            this.persist();
          }
        }
      : job;
    const running = this.paths.run(paths, run, "event");
    if (deferred) {
      void running.catch((err: unknown) => {
        if (this.opts.onError) this.opts.onError(err, paths);
        else console.error("Courier: a local event failed:", err);
      });
      return Promise.resolve();
    }
    return running;
  }

  /** Resolve once no queued job is running (tests, and a host draining before a stop). */
  async whenIdle(): Promise<void> {
    await this.paths.whenIdle();
  }

  /**
   * Run one adapter write (or delete, or rename) with its paths marked as being written.
   *
   * A host may feed the vault event of the write back before the adapter call resolves;
   * `schedule` sees the mark and queues the event without waiting for it, which is what
   * keeps such a host from deadlocking (see `schedule`).
   */
  private async writing<T>(paths: readonly string[], run: () => Promise<T>): Promise<T> {
    for (const path of paths) this.writingPaths.add(path);
    try {
      return await run();
    } finally {
      for (const path of paths) this.writingPaths.delete(path);
    }
  }

  /**
   * The content currently on disk for `path`, or null when it is gone.
   *
   * A reconcile decides from the hashes it took when it started; this is how it
   * checks that a file it is about to write or delete has not moved since.
   */
  private async currentLocalHash(path: string): Promise<string | null> {
    const bytes = await this.opts.adapter.readFile(path);
    return bytes ? await sha256Hex(bytes) : null;
  }

  private rebuildPathIndex(): void {
    this.pathToFileId.clear();
    for (const [fileId, s] of Object.entries(this.state)) {
      this.pathToFileId.set(s.plainPath, fileId);
    }
  }

  private persist(): void {
    this.opts.onSaveState?.(this.serializeState());
  }

  // ── Local helpers ──

  /**
   * Read a file together with the stamp taken **before** the read.
   *
   * The order matters. A stamp taken after the read could be newer than the bytes it
   * is paired with (the file changed in between), and the next pass would then trust
   * a hash for content that had already moved on. Stamping first means such a race
   * costs a redundant re-read, never a missed edit.
   */
  private async readWithStamp(
    path: string,
  ): Promise<{ bytes: Uint8Array; stamp: FileStamp | null } | null> {
    const stamp = await this.opts.adapter.statFile(path);
    const bytes = await this.opts.adapter.readFile(path);
    return bytes ? { bytes, stamp } : null;
  }

  /**
   * The hash this device already recorded for `path`, when the file's current stamp
   * says it has not changed since that hash was taken.
   *
   * This is the whole of the "do not re-read what has not changed" rule: a pass over a
   * vault of large attachments used to read and hash every byte of every file every
   * five minutes (and on every reconnect) to discover that nothing had happened. Only
   * a stamp that differs — or a missing one — sends the engine back to the file.
   */
  private cachedHashFor(path: string, stamp: FileStamp): string | null {
    const fileId = this.pathToFileId.get(path);
    const entry = fileId ? this.state[fileId] : undefined;
    if (!entry?.lastKnownContentHash || !entry.stamp) return null;
    if (!sameStamp(entry.stamp, stamp)) return null;
    return entry.lastKnownContentHash;
  }

  /**
   * The hash of a file as of `stamp`: the recorded one when the stamp still proves it, the
   * file's own after one read otherwise.
   *
   * `null` means the file is gone — the settings poll's "a read failure is a race, not a
   * change" case. The reconcile scan deliberately does **not** use this: it has to decide
   * whether a file is untracked *before* paying for the read, because an untracked file's
   * bytes are read by its create instead. The settings poll has no untracked question —
   * every config path it lists is tracked or about to be created, and both answers need the
   * hash.
   */
  private async hashForCurrent(path: string, stamp: FileStamp): Promise<string | null> {
    const cached = this.cachedHashFor(path, stamp);
    if (cached !== null) return cached;
    const bytes = await this.opts.adapter.readFile(path);
    if (!bytes) return null;
    return await sha256Hex(bytes);
  }

  /** Record a stamp for the content hash a state entry already holds. */
  private rememberStamp(path: string, stamp: FileStamp | null): void {
    if (!stamp) return;
    const fileId = this.pathToFileId.get(path);
    const entry = fileId ? this.state[fileId] : undefined;
    if (entry) entry.stamp = stamp;
  }

  /**
   * The file's current stamp when the pass's snapshot of it is still current, else null.
   *
   * A pass decides from bytes it hashed when it started, while an incremental event can
   * change and push a file before the pass reaches it. Anything that **records** the pass's
   * chain as this device's sync point therefore has to confirm the file has not moved
   * since: one `stat`, no read. A changed size or mtime — or a path that is gone, whose
   * deletion an event owns — answers null, which leaves the adoption to that event or to
   * the next pass instead of writing a sync point the disk does not back.
   */
  private async currentStampIfUnchanged(
    path: string,
    snapshot: FileStamp | undefined,
  ): Promise<FileStamp | null> {
    if (!snapshot) return null;
    const current = await this.opts.adapter.statFile(path);
    if (!current) return null;
    if (!sameStamp(current, snapshot)) return null;
    return current;
  }

  /**
   * Push one version.
   *
   * `request.baseVersionId` is the chain head this push was decided from — `null` for a
   * file the engine believes has no chain — and the server refuses the push when its own
   * head differs (see {@link SyncPushBaseError}).
   */
  private async pushFile(request: PushRequest): Promise<void> {
    const prepared = await this.preparePush(request);
    // A path the API cannot carry: reported by `preparePush`, and nothing to send.
    if (!prepared) return;
    await this.pushPrepared(prepared);
  }

  /**
   * Send one **prepared** version on its own, and settle its answer.
   *
   * Split from {@link pushFile} so a batch can prepare several versions and then settle
   * each one with exactly this code (see {@link applyLocalChanges}): the refusal handling
   * — a lost response whose bytes the head already holds, a move whose blob the store no
   * longer has — must not exist twice.
   */
  private async pushPrepared(prepared: PreparedPush): Promise<void> {
    const { plainPath } = prepared;

    let content: Uint8Array | null = null;
    let contentChunks = 0;
    if (prepared.chunkCount > 0) {
      // Staged one chunk at a time, resuming from whatever the server already holds; the
      // push then names the upload instead of carrying it.
      await this.uploadChunks(prepared);
      contentChunks = prepared.chunkCount;
      prepared.plainBytes = undefined;
    } else if (!prepared.reusesStoredContent) {
      content = await this.contentFor(prepared);
    }

    let result = (await this.sendPush(prepared, content, contentChunks)).results[0];
    if (classifyPushResult(result) === "content_missing" && prepared.reusesStoredContent) {
      // The store does not hold those bytes after all — a chain whose blob was
      // reclaimed, or a claim that simply did not hold. Nothing was written for the
      // refused attempt, so send the content and finish the move.
      //
      // The bytes are **verified** before they are sent: this path is reached by a
      // stamp-proved move that read nothing, and a file edited since its stamp was taken
      // must not be stored under the old content hash (a blob is content-addressed, so
      // that binding is permanent). A file that vanished or no longer matches throws;
      // the next pass re-reads and decides again.
      const bytes = await this.readVerifiedRetryBytes(prepared, plainPath);
      if (bytes === null) {
        this.forgetPushedVersion(prepared);
        throw new Error(`Version content not found for ${prepared.contentHash}`);
      }
      if (shouldTransferInChunks(prepared.sizeBytes)) {
        // A version above the threshold is framed in chunks; a whole payload would be
        // rejected by the wire and unreadable to every chunk-capable peer.
        prepared.plainBytes = bytes;
        prepared.chunkCount = chunkCountForSize(prepared.sizeBytes);
        await this.uploadChunks(prepared);
        prepared.plainBytes = undefined;
        result = (await this.sendPush(prepared, null, prepared.chunkCount)).results[0];
      } else {
        result = (
          await this.sendPush(
            prepared,
            await encryptCombinedBytes(this.opts.encryptionKey, bytes as Uint8Array<ArrayBuffer>),
          )
        ).results[0];
      }
    }
    const outcome = classifyPushResult(result);
    if (outcome === "stale_base") {
      // A peer moved the chain between the decision and this request; the refusal names
      // the chain it refused against, so no re-send is needed.
      await this.settleStaleBase(prepared);
      return;
    }
    if (outcome !== "ok") {
      // A `content_missing` here is the answer to the retry above — the bytes were sent and
      // the store still does not hold them — or a refusal of any other kind. Neither can
      // be fixed by sending the same claim again: the next pass reads the file and decides.
      this.forgetPushedVersion(prepared);
      throw new Error(`Push failed for ${plainPath}: ${result?.error ?? "unknown error"}`);
    }

    this.applyPushedVersion(prepared);
  }

  /**
   * Settle a push the server refused with `stale_base`, from the chain it refused against.
   *
   * Two answers, and the difference is whether the refusal is real:
   *
   * - the head already holds what this push was carrying — this exact version (its response
   *   was lost) or the same bytes a peer converged on — so the push landed: take the head
   *   as the sync point;
   * - the head is a version this decision never saw: raise {@link SyncPushBaseError} for
   *   the caller, which decides again or resolves the conflict.
   *
   * Split out of {@link pushPrepared} so a batch that gets `stale_base` from the server's
   * answer can settle the same way **without re-sending** the version the server just
   * refused.
   */
  private async settleStaleBase(prepared: PreparedPush): Promise<void> {
    const { fileId, plainPath } = prepared;
    this.forgetPushedVersion(prepared);
    const chain = await this.pullChain(fileId);
    const head = remoteHead(chain);
    // The head already holds the bytes this push was carrying: either this exact
    // push was applied and only its response was lost, or a peer converged on the
    // same content. Nothing to write — take the head as the sync point. A **delete** is
    // settled by its action, not its content: every tombstone carries the empty-content
    // hash, and an empty *live* file must not be mistaken for one that landed. The mirror
    // holds too: a live push whose bytes are empty must not treat a peer's tombstone as
    // its own head (that would resurrect a deleted file on the next pass).
    const landed =
      prepared.action === "delete"
        ? head?.action === "delete"
        : head !== undefined &&
          head.action !== "delete" &&
          head.contentHash === prepared.contentHash;
    if (head && landed) {
      this.adoptRemoteIdentity(fileId, plainPath, head, prepared.stamp ?? null);
      // The head is this very version (the server stores the client's versionId), so
      // the push did land and only its response was lost. A peer that merely converged
      // on the same bytes has a different versionId and is not reported as this
      // device's upload.
      if (head.versionId === prepared.versionId) {
        this.activity.reportActivity({
          direction: "out",
          outcome: "applied",
          fileId,
          versionId: head.versionId,
          plainPath,
          action: prepared.action,
          sizeBytes: prepared.sizeBytes,
          deviceName: null,
        });
      }
      return;
    }
    throw new SyncPushBaseError(fileId, plainPath, chain);
  }

  /**
   * Everything a push needs before its request goes out: the encrypted path, the
   * content hash, the size a peer applies its cap to, the ciphertext itself, and the
   * echo-suppression registration.
   *
   * Split out of {@link pushFile} so a pass can send several prepared pushes in **one**
   * request (see {@link createUntrackedFiles}); the registration has to happen here,
   * before any request, for the same reason it always did — the server broadcasts
   * `file_pushed` while the push is still in flight, and that echo can arrive before
   * the response resolves. Registering afterwards leaves a window in which the engine
   * reads its own change back and pushes it again, which is where the duplicate
   * `modify`/`rename` versions came from.
   */
  private async preparePush(request: PushRequest): Promise<PreparedPush | null> {
    const { fileId, plainPath, action, bytes, baseVersionId, stamp } = request;
    const key = this.opts.encryptionKey;
    const versionId = generateVersionId();
    const encryptedPath = await encryptString(key, plainPath);
    // The API bounds `encryptedPath`, and it refuses an over-long one for the whole
    // **batch** (a 422 on every file that travelled with it) — so a single deep path
    // must not travel at all. Reported once per pass, like a file over the size cap,
    // and the rest of the pass continues; checked here, before the echo-suppression
    // registration below, so nothing is remembered about a version never sent.
    if (encryptedPath.length > MAX_ENCRYPTED_PATH_LENGTH) {
      this.activity.reportSkipped(plainPath, "path-too-long");
      this.activity.reportActivity({
        direction: "out",
        outcome: "skipped",
        fileId,
        versionId: null,
        plainPath,
        action,
        sizeBytes: request.sizeBytes ?? bytes?.byteLength ?? 0,
        deviceName: null,
        reason: "pathTooLong",
      });
      return null;
    }
    const contentHash =
      request.contentHash ?? (bytes === undefined ? await sha256Text("") : await sha256Hex(bytes));
    // Plaintext size, so a peer can decide whether it can hold this version at all
    // (see `SyncScope.maxFileBytes`) without downloading it first. A `rename` records
    // its real size even when it sends no content: a peer that never had the file
    // still has to pull those bytes, and its cap has to apply to them.
    const sizeBytes = request.sizeBytes ?? bytes?.byteLength ?? 0;
    // A content-less version that names a hash is a stamp-proved move: its size is part
    // of the proof (the peer applies its cap to it), so it has to travel with it.
    if (
      bytes === undefined &&
      request.contentHash !== undefined &&
      request.sizeBytes === undefined
    ) {
      throw new Error(`A content-less version of ${plainPath} must state its plaintext size`);
    }
    // The modification time a config-folder conflict is settled by. A version read from
    // disk carries the file's own stamp; one with no file behind it (a `delete`, or the
    // restore this device just wrote) carries the moment it acted, which the caller
    // states explicitly. There is deliberately **no** `Date.now()` fallback here: a pass
    // that retries a tombstone hours later must not make it look like the newer change,
    // and a file this device could not stat has no modification time to claim. Floor to
    // a whole millisecond and never negative: the server stores an integer and a peer
    // compares with a `stat` stamp.
    const mtimeMs = Math.max(0, Math.floor(request.mtimeMs ?? stamp?.mtimeMs ?? 0));

    // A version whose content the store already holds under this hash does not send
    // it again. In practice that is the rename case: the bytes are exactly the ones
    // this file's sync point already records, so the chain head references the same
    // `contentHash` and the blob is there (a blob is only reclaimed once no row
    // references it). Moving a 40 MiB attachment is then one small request instead of
    // a second upload of the whole file. The server verifies the claim rather than
    // trusting it and answers `content_missing`, which is what the retry in
    // {@link pushFile} is for.
    //
    // A caller that supplies `contentHash` **and** no `bytes` is the stamp-proved move
    // (see `applyLocalRename`), and only a `rename` has that shape: a `delete` carries
    // neither a hash nor bytes.
    const reusesStoredContent =
      bytes === undefined
        ? request.contentHash !== undefined && action === "rename"
        : this.state[fileId]?.lastKnownContentHash === contentHash;
    // A payload above the chunking threshold is staged through the chunk endpoints and
    // then named by the push; a version that reuses stored bytes has nothing to stage.
    const chunkCount =
      bytes !== undefined && !reusesStoredContent && shouldTransferInChunks(sizeBytes)
        ? chunkCountForSize(sizeBytes)
        : 0;

    this.rememberPushedVersion(versionId);

    // Which side of the vault's retention split this file falls on. The plaintext path is
    // the only place the category is visible, so the decision is made here and travels
    // with the version (see `PushFileFrame.historyKind`); the server reads the **vault's**
    // limits and trims to them.
    const historyKind = historyKindFor(plainPath);

    return {
      fileId,
      plainPath,
      action,
      versionId,
      encryptedPath,
      contentHash,
      sizeBytes,
      mtimeMs,
      baseVersionId,
      stamp,
      plainBytes: bytes,
      content: null,
      reusesStoredContent,
      chunkCount,
      historyKind,
    };
  }

  /**
   * The wire entry for one prepared version.
   *
   * The prepared version and the request carry the same eleven fields, and keeping a second
   * copy of them on `PreparedPush.file` meant every field added to a push had to be written
   * twice (and every sender rebuilt the entry with its own spread). One builder is what
   * makes "the version on the wire" a single shape: a chunked upload names its chunks
   * instead of carrying a payload, which is the only difference between the two forms.
   */
  private wireFile(
    prepared: PreparedPush,
    content: Uint8Array | null,
    contentChunks = 0,
  ): PushFile {
    return {
      fileId: prepared.fileId,
      encryptedPath: prepared.encryptedPath,
      action: prepared.action,
      versionId: prepared.versionId,
      contentHash: prepared.contentHash,
      sizeBytes: prepared.sizeBytes,
      mtimeMs: prepared.mtimeMs,
      baseVersionId: prepared.baseVersionId,
      historyKind: prepared.historyKind,
      content,
      ...(contentChunks > 0 ? { contentChunks } : {}),
    };
  }

  /**
   * The moment this device decided on a deletion, remembered across retries.
   *
   * A tombstone has no file to stamp, and its `mtimeMs` is what a peer compares with its
   * own file's modification time to settle a config-folder conflict. Recording the moment
   * in the state — rather than reading the clock again when the push is retried, possibly
   * hours later — keeps a deletion made *before* a peer's edit from later claiming to be
   * the newer change. `Date.now()` is the only honest answer when nothing recorded it (the
   * file was deleted with the app closed), and it is then kept for the retries that follow.
   */
  private deleteMoment(entry: LocalVersionState[string] | undefined): number {
    const moment = entry?.deletedAtMs ?? Date.now();
    if (entry) entry.deletedAtMs = moment;
    return moment;
  }

  /**
   * The version a deletion pushes: no bytes, no stamp, and the moment it was decided.
   *
   * Shared by the two sites that build a tombstone to send — the pass's batched delete
   * (`prepareTombstone`) and an event's single one (`resolveLocalDelete`) — so the version's
   * shape is stated once, and the only thing either caller contributes is the base it was
   * decided from.
   */
  private tombstoneRequest(
    fileId: string,
    plainPath: string,
    baseVersionId: string | null,
    mtimeMs: number,
  ): PushRequest {
    return {
      fileId,
      plainPath,
      action: "delete",
      bytes: undefined,
      baseVersionId,
      stamp: null,
      mtimeMs,
    };
  }

  /**
   * The ciphertext for a prepared push, encrypted on first use.
   *
   * Lazy on purpose: a `rename` that reuses content the store already holds never
   * needs it, and encrypting 40 MiB to then not send it is work (and memory) for
   * nothing. The retry path and every content-carrying push ask for it here.
   *
   * The plaintext reference is dropped once the ciphertext exists: nothing needs both,
   * and a batch holding twenty files would otherwise hold forty payloads. The retry
   * path (`pushFile`) re-encrypts from nothing only if `plainBytes` were still there —
   * it is not, which is why a `content_missing` refusal is answered from `content`.
   */
  private async contentFor(prepared: PreparedPush): Promise<Uint8Array | null> {
    if (prepared.plainBytes === undefined) return prepared.content;
    prepared.content ??= await encryptCombinedBytes(
      this.opts.encryptionKey,
      prepared.plainBytes as Uint8Array<ArrayBuffer>,
    );
    prepared.plainBytes = undefined;
    return prepared.content;
  }

  /**
   * The file's bytes for a `content_missing` retry, proven to be the version's content.
   *
   * A stamp-proved move never read the file, so this is its one read on that path. The
   * hash check is the point: the refusal is answered only when the bytes still hash to
   * `prepared.contentHash`; otherwise the file changed since the move was decided, and
   * sending it under the old hash would rewrite what that hash means. A vanished file
   * answers `null` for the same reason.
   */
  private async readVerifiedRetryBytes(
    prepared: PreparedPush,
    path: string,
  ): Promise<Uint8Array | null> {
    const bytes = prepared.plainBytes ?? (await this.readWithStamp(path))?.bytes ?? null;
    if (bytes === null) return null;
    return (await sha256Hex(bytes)) === prepared.contentHash ? bytes : null;
  }

  /**
   * Stage a large payload, one encrypted chunk at a time.
   *
   * The server reports the contiguous prefix it already holds, so a retry after a drop
   * continues there instead of starting over — that is the whole point of the chunk
   * endpoints. Each chunk is encrypted with its position bound into the AEAD (see
   * `chunkAdditionalData`), so a reader can neither reorder nor mix uploads. A failure
   * leaves the staged chunks on the server; the next pass re-reads the file, rehashes it
   * and resumes at `received`.
   */
  private async uploadChunks(prepared: PreparedPush): Promise<void> {
    const bytes = prepared.plainBytes;
    if (bytes === undefined) {
      throw new Error(`Cannot upload ${prepared.plainPath} in chunks: its bytes are not in memory`);
    }
    const count = prepared.chunkCount;
    const size = prepared.sizeBytes;
    const status = await this.opts.api.getChunkStatus(this.opts.vaultId, prepared.contentHash);
    let index = status?.received ?? 0;
    while (index < count) {
      const { start, end } = chunkBounds(index, size);
      const stored = await encryptChunkBytes(
        this.opts.encryptionKey,
        bytes.subarray(start, end) as Uint8Array<ArrayBuffer>,
        chunkAdditionalData(prepared.contentHash, index, count, size),
      );
      const ack = await this.opts.api.uploadChunk(
        this.opts.vaultId,
        prepared.contentHash,
        index,
        count,
        size,
        stored,
      );
      index = Math.max(index + 1, ack.received);
    }
  }

  /**
   * Send a prepared chunked create, without going through {@link pushFile}.
   *
   * A bind prepares every new file itself (so it can batch them), and a chunked file
   * cannot travel in a batch: it stages its chunks and sends one content-less push. A
   * refusal is returned rather than thrown, for the same reason the batch collects
   * them — one file the server will not take must not end the pass.
   */
  private async sendPreparedChunked(prepared: PreparedPush): Promise<unknown> {
    try {
      await this.uploadChunks(prepared);
      prepared.plainBytes = undefined;
      const result = (await this.sendPush(prepared, null, prepared.chunkCount)).results[0];
      // A chunked create names `baseVersionId: null`, so the server has no base to refuse
      // as stale: every answer other than `ok` is a refusal.
      if (classifyPushResult(result) !== "ok") {
        this.forgetPushedVersion(prepared);
        this.dropPendingCreate(prepared);
        return new Error(
          `Push failed for ${prepared.plainPath}: ${result?.error ?? result?.status ?? "no result"}`,
        );
      }
      this.applyPushedVersion(prepared);
      return null;
    } catch (err) {
      this.forgetPushedVersion(prepared);
      this.dropPendingCreate(prepared);
      return err;
    }
  }

  /**
   * Send one prepared push on its own. A failure drops its echo-suppression entry.
   *
   * A rate limit is waited out here too, so a single-file push (a rename, an edit while
   * a large bind is in flight) is not turned into a failed pass by a window boundary.
   */
  private async sendPush(
    prepared: PreparedPush,
    content: Uint8Array | null,
    contentChunks = 0,
  ): Promise<SyncPushResponse> {
    const file = this.wireFile(prepared, content, contentChunks);
    return await this.withRateLimitWaits(() => this.opts.api.push(this.opts.vaultId, [file])).catch(
      (err: unknown) => {
        this.forgetPushedVersion(prepared);
        throw err;
      },
    );
  }

  /** Remember a version this engine is about to push (see `SelfEventLog`). */
  private rememberPushedVersion(versionId: string): void {
    this.selfEvents.rememberPushedVersion(versionId);
  }

  /** Stop suppressing the echo of a push that never landed. */
  private forgetPushedVersion(prepared: PreparedPush): void {
    this.selfEvents.forgetPushedVersion(prepared.versionId);
  }

  /**
   * Record a version the server accepted as this file's sync point.
   *
   * The stamp travels with the hash it was taken for — that pairing is what lets a
   * later pass skip re-reading the file — and the remote identity index learns the new
   * head too, so a later local event at another path adopts this chain (by path or by
   * content) instead of forking a second one.
   */
  private applyPushedVersion(prepared: PreparedPush): void {
    const { fileId, plainPath, contentHash, versionId, encryptedPath, action, sizeBytes } =
      prepared;
    this.state[fileId] = {
      lastKnownVersionId: versionId,
      lastKnownContentHash: contentHash,
      plainPath,
      // A delete's sync point is the *absence* of the file, so it carries no stamp:
      // the next file to appear at that path must not look already-synced. Every other
      // version records the stamp its bytes were read at — including a content-less
      // `rename`, whose bytes were only proved by that stamp.
      ...(prepared.stamp === null ? {} : { stamp: prepared.stamp }),
    };
    // A delete keeps the path mapped to this chain so a file written there later is a
    // restore — unless another chain already owns the path (a move in the same job just
    // claimed it, and this tombstone must not take it back).
    if (action !== "delete" || this.pathToFileId.get(plainPath) === undefined) {
      this.pathToFileId.set(plainPath, fileId);
    }
    this.activity.reportActivity({
      direction: "out",
      outcome: "applied",
      fileId,
      versionId,
      plainPath,
      action,
      sizeBytes,
      deviceName: null,
    });
    // A `delete` has no live path, so it is dropped from the identity index rather than
    // remembered under one (the state entry above keeps the recreate rule working).
    if (action === "delete") {
      this.remoteIndex.forget(fileId);
      return;
    }
    this.remoteIndex.remember(
      fileId,
      {
        versionId,
        contentHash,
        encryptedPath,
        action,
        sizeBytes,
        mtimeMs: prepared.mtimeMs,
        createdAt: new Date().toISOString(),
      },
      plainPath,
    );
  }

  // ── Full reconcile ──

  /**
   * Full reconcile.
   *
   * `options.firstBind` marks the pass that **binds** this vault: a connect, or a
   * host starting up (including a resume after a pause). On that pass a local file
   * the server has no live version of **and this engine has never tracked** is the
   * user's own, so it is pushed as a new file instead of being deleted by the
   * connection. A chain this device does track is compared against its sync point
   * as usual: the deletion is applied, or a divergent local copy is parked.
   *
   * Every other pass — scheduled reconciles, and a plain `initialSync()` — applies
   * what other devices did, deletions included. See `TombstoneHandling`.
   *
   * `priorityPaths` states which files a person is looking at / opened most recently.
   * The pass uses it only to **order** its work (see `priority.ts`), so a cold start
   * brings the note on screen up to date before the rest of the vault.
   */
  async initialSync(
    options: {
      firstBind?: boolean;
      priorityPaths?: readonly string[];
    } = {},
  ): Promise<void> {
    // One pass at a time. A call while a pass is in flight joins it (a bind only joins a
    // bind; a bind requested while a plain pass runs waits for it and then binds), so a
    // second pass can never overwrite the bind rule (`tombstoneMerge`), the remote index or
    // the create batch of the pass already running. The bind's merge rule is what keeps
    // a connect from deleting notes the server already deleted.
    while (this.passPromise !== null) {
      if (options.firstBind !== true) return await this.passPromise;
      await this.passPromise;
    }
    // A bind runs wherever the caller asks for one (every host start, a reconnect, a
    // local event before the first pass), but the merge it performs only revives files
    // this engine has never tracked. Only the pass itself is single-flight here.
    const run = this.runInitialSync({
      ...options,
      firstBind: options.firstBind === true,
    });
    const tracked = run.finally(() => {
      if (this.passPromise === tracked) this.passPromise = null;
    });
    this.passPromise = tracked;
    return await tracked;
  }

  /** The pass itself; `initialSync` owns the first-bind gate and the single flight. */
  private async runInitialSync(options: {
    firstBind?: boolean;
    priorityPaths?: readonly string[];
  }): Promise<void> {
    const firstBind = options.firstBind === true;
    this.tombstoneMerge = firstBind ? "bind-merge" : "apply-remote-delete";
    try {
      await this.reconcile(options.priorityPaths ?? []);
      this.initialized = true;
    } finally {
      // Whatever the pass established is recorded even when part of it failed: the sync
      // points it did take are real, and a host whose bind threw must not lose them (nor
      // keep deciding from a state older than what is already on the server). The
      // `initialized` flag deliberately stays false for a failed bind, so the settings
      // poll — which must not run before the pass that decides which settings files are
      // the user's own — keeps waiting, and the next pass runs as a bind again.
      this.persist();
    }
  }

  /**
   * Push local changes in the synced settings files.
   *
   * Obsidian's config folder is not part of the vault index, so **no vault event
   * ever fires** for `app.json`, `hotkeys.json` or a plugin's `data.json` — a host
   * that only listened for events would push those files at the next full
   * reconcile (`RECONCILE_INTERVAL_MS`, five minutes in the plugin). This is the
   * cheap pass a host runs between reconciles: it lists, hashes and reads only the
   * settings paths, never the notes.
   *
   * Deliberately does nothing before the first bind: the bind pass is what decides
   * which local settings files are the user's own, and an early poll would run a
   * non-bind `initialSync()` in its place.
   *
   * A file an event is already handling is serialised through the path queue, and a
   * listing that lags a write cannot become a deletion here
   * either: the tombstone branch re-reads the file first.
   */
  async syncLocalSettings(): Promise<void> {
    // Nothing to do when no config-folder group is on — and, importantly, nothing
    // to spend on a listing either.
    if (!this.initialized) return;
    if (!syncsAnySettings(this.scope)) return;
    // A poll that overlaps a previous one would read the same bytes twice and push
    // twice; against a reconcile it is harmless (the path queue covers that).
    if (this.settingsPollRunning) return;
    this.settingsPollRunning = true;
    this.activity.beginPass();
    try {
      const listed = (await this.opts.adapter.listSyncableFiles()).filter((p) =>
        this.isSyncable(p),
      );
      const settings = new Set(listed.filter((p) => isConfigPath(p, this.scope)));

      for (const path of settings) {
        // One `stat` decides the cap and whether this pass has to read the file at
        // all: a settings file that has not changed since the hash recorded for it
        // needs nothing (and the poll runs every 30 seconds, so "nothing" is the
        // answer that matters).
        const stamp = await this.opts.adapter.statFile(path);
        if (stamp === null) continue;
        if (!withinFileSizeCap(this.scope, stamp.sizeBytes)) {
          // Same rule as the reconcile scan, so an over-cap settings file is not reported
          // twice a minute for being in sync.
          this.reportOverCapLocal(path, stamp);
          continue;
        }
        const hash = await this.hashForCurrent(path, stamp);
        // The listing says the file exists; a read failure is a race, not a change.
        if (hash === null) continue;
        const fileId = this.pathToFileId.get(path);
        const known = fileId ? this.state[fileId] : undefined;
        if (!known || known.lastKnownContentHash !== hash) await this.handleLocalChange(path);
      }

      // A tracked settings file that vanished from the listing was deleted while
      // nothing was watching (this is the only host that can see it at all).
      for (const entry of Object.values(this.state)) {
        const path = entry.plainPath;
        if (!this.isSyncable(path) || !isConfigPath(path, this.scope)) continue;
        if (settings.has(path)) continue;
        // Re-read before believing the listing: a vault listing can lag a write,
        // and a lagging listing must never become a tombstone.
        if (await this.opts.adapter.readFile(path)) continue;
        await this.handleLocalDelete(path);
      }
    } finally {
      this.settingsPollRunning = false;
    }
  }

  private async reconcile(priorityPaths: readonly string[]): Promise<void> {
    const { adapter, api, vaultId } = this.opts;
    // The host's list is a preference; normalize it once for the whole pass.
    const priority = priorityRanks(normalizePriorityPaths(priorityPaths));
    this.activity.beginPass();
    // The sync points this pass starts from, read before its first await: an event that
    // adopts a newer version at any point during the pass (even while it lists or hashes)
    // makes this pass's chain stale for that file, and its job must skip rather than pull
    // the stale head over the event's bytes (see `ReconcilePass.stateAtStart`).
    const stateAtStart = new Map(
      Object.entries(this.state).map(([fileId, entry]) => [fileId, entry.lastKnownVersionId]),
    );
    // The adapter lists what exists; the scope decides what this device syncs.
    const localPaths = (await adapter.listSyncableFiles()).filter((p) => this.isSyncable(p));
    const visiblePaths = localPaths.filter((p) => !isConflictFile(p));

    // Pull the server-side index: one row per chain (its head), plus the last live
    // version of a tombstoned chain. The pass decides from the head; the full chain is
    // fetched only for the rare convergence adoption that needs its ancestry.
    //
    // It comes **before** the local scan on purpose. The scan hashes a file only when a
    // chain or a state entry can claim it (`scanLocalHashes`), because an untracked file
    // with no chain can only become a `create` — and `createUntrackedFiles` reads it
    // once, with the bytes in hand. Reading the index first is what lets the scan tell
    // those apart, and a first bind then reads the vault once instead of twice
    // (measured: `docs/first-bind-performance.md`). A failed index read also no longer
    // costs a full scan.
    const index = await api.getVaultSyncIndex(vaultId);

    const headByFileId = new Map<string, VersionChainEntry>();
    const previousLiveByFileId = new Map<string, VersionChainEntry>();
    for (const entry of index.files) {
      headByFileId.set(entry.fileId, entry.head);
      if (entry.previousLive) previousLiveByFileId.set(entry.fileId, entry.previousLive);
    }

    const chainByFileId = new Map<string, VersionChainEntry[]>();
    for (const [fileId, head] of headByFileId) {
      const previous = previousLiveByFileId.get(fileId);
      // `decideFile` walks the chain only to find the version a tombstone removed, so
      // `[previousLive, head]` carries everything this pass can decide from.
      chainByFileId.set(fileId, head.action === "delete" && previous ? [previous, head] : [head]);
    }

    // Chains whose last version is a `delete` hold no live file — the fileId is
    // only a tombstone. Mapping their path would claim the local file for a chain
    // that no longer exists, which is wrong in both modes: a bind pushes an untracked
    // file as a new one, and a device that tracks the chain applies the deletion.
    const liveFileIds = new Set(
      index.files.filter((entry) => entry.head.action !== "delete").map((entry) => entry.fileId),
    );

    // The identity indexes: which path each live chain lives at, what its head is, and
    // which content hash belongs to which chain. Kept on the instance, because the
    // incremental event handlers use them to tell "a path the server already tracks
    // under another fileId" from "a genuinely new file".
    this.remoteIndex.clear();
    for (const entry of index.files) {
      if (!liveFileIds.has(entry.fileId)) continue;
      const head = entry.head;
      try {
        const plain = await decryptString(this.opts.encryptionKey, head.encryptedPath);
        // A chain this device does not sync — a peer's settings file while this
        // device has settings off, or anything under a hard-excluded path — must
        // not enter the identity indexes either: a local note could otherwise
        // adopt a chain it is not allowed to touch, and the per-file loop would
        // keep deciding about a path it will never write.
        if (!this.isSyncable(plain)) {
          // Not activity: a chain discovered by a pass was already on the server before
          // this run. The log records what this device did *now* — a push, an applied
          // pull, or a skip reported by a live notification (`handleFilePushed`). Logging
          // the discovery here would repeat an old "not applied" row on every plugin
          // start, which is a scan result, not a sync event.
          continue;
        }
        // A chain whose local copy this device has moved into a path outside its scope
        // (an excluded folder, or a file type it turned off) is parked there: the server
        // still records the old path, but a file at that path is not this chain's. Keeping
        // it in the index would reserve the old path for a chain that is not there — a new
        // note created there would be skipped as "already tracked", and a local event could
        // hand the parked chain an identity whose bytes live somewhere else.
        const localPath = this.state[entry.fileId]?.plainPath;
        if (localPath !== undefined && localPath !== plain && !this.isSyncable(localPath)) {
          continue;
        }
        // A chain's size never takes it out of the indexes: the cap bounds what this
        // device **sends**, and a version a peer already uploaded is part of the vault
        // every device must be able to materialise (see `withinLocalSizeCap`).
        this.remoteIndex.remember(entry.fileId, head, plain);
      } catch {
        // Undecryptable path — skip (wrong key or legacy row).
      }
    }

    // Local hashes for the files this pass can decide about. One `stat` per visible path
    // decides three things at once: whether the file is over the size cap (left out here
    // — before anything is read), whether this pass can reuse the hash it recorded last
    // time (`cachedHashFor`), and — when it cannot — the stamp that goes with the hash it
    // is about to compute.
    //
    // A path the adapter cannot stat is **not** treated as absent, even though the
    // listing says it exists: Obsidian's index lags the disk (and never holds the config
    // folder at all), so a file can be present and readable while `statFile` answers
    // null. "Not statable" therefore means "this pass leaves the path alone", exactly
    // like a file over the cap — not "gone", which the loop below would read as this
    // device's deletion and then try to overwrite with a pull that fails with
    // `File already exists.` because the file is in fact still there.
    const scan = await this.scanLocalFiles(visiblePaths);

    // A move made without an event is found by content (`repairMovedFile`), which needs
    // the hashes the scan skipped. That is only worth paying for when a tracked file has
    // actually gone missing: on a first bind there is no such file, and on an ordinary
    // pass every syncable file is tracked.
    if (scan.untracked.length > 0 && this.anyTrackedPathUnhashed(scan)) {
      const pool = new WorkPool(this.passLimits);
      await Promise.all(
        scan.untracked.map((p) =>
          pool.run("small", async () => {
            const bytes = await adapter.readFile(p);
            if (!bytes) return;
            const hash = await sha256Hex(bytes);
            scan.hashes.set(p, hash);
            this.rememberStamp(p, scan.stamps.get(p) ?? null);
          }),
        ),
      );
      scan.untracked.length = 0;
    }

    // Re-point the chains whose file was moved locally without an event reaching
    // the engine, so neither the tombstone branch nor the untracked branch below
    // mistakes a move for "deleted here, created there".
    for (const [fileId, entry] of Object.entries(this.state)) {
      await this.repairMovedFile(fileId, entry, scan.hashes, liveFileIds, this.remoteIndex);
    }

    // Every fileId we know about, plus every live chain the server knows. A tracked
    // tombstone is decided like any other chain: `decideFile` reads `locallyTracked`,
    // applies the deletion (or parks a divergent local copy), and only a local file the
    // engine has never tracked is the user's own on a bind. Retiring those entries on
    // the bind pass instead made every start a "vault I have never seen" — a pause
    // followed by a resume, or Obsidian reopening after a peer deleted a note, pushed the
    // surviving local copy back as a new chain and every device downloaded it again.
    const allFileIds = new Set<string>([...Object.keys(this.state), ...this.remoteIndex.fileIds()]);

    const failure = await this.reconcileLoop({
      fileIds: allFileIds,
      localHashes: scan.hashes,
      untrackedPaths: scan.untracked,
      chainByFileId,
      remote: this.remoteIndex,
      skippedPaths: scan.skipped,
      overCapPaths: scan.overCap,
      localStamps: scan.stamps,
      priority,
      stateAtStart,
    });
    // Raised only now: the pass has done everything it still could (see `reconcileLoop`).
    // A refusal is an `Error` in practice; the wrap keeps a host that threw something else
    // from turning this into a `throw` of a non-error value, and `cause` keeps whatever
    // detail it did carry (a status, a body) available to the host that reports it.
    if (failure !== null) {
      throw failure instanceof Error
        ? failure
        : new Error("the reconcile pass failed", { cause: failure });
    }
  }

  /**
   * The per-file half of a pass, run through a `WorkPool`.
   *
   * It **answers** the first failure rather than throwing it, because one file the
   * server will not take must not end the pass: the files after it — pulls included —
   * were then skipped, so a device that is simply out of quota stopped receiving its
   * peers' edits while still looking connected. The caller raises the failure once the
   * pass is done, so the host still logs it exactly as before.
   *
   * The pool bounds how many per-file operations are in flight (one large file at a
   * time); each one is a different fileId, so the state they mutate is disjoint. The
   * ordering is the user's paths first (see `orderedFileIds`), not the server's answer
   * order. Two different chains can still name one path while a peer's move is in flight,
   * so the tasks that may write the same path take turns through the engine's path queue;
   * everything else runs concurrently.
   *
   * Its whole snapshot arrives as one {@link ReconcilePass}: seven positional arguments
   * of four different container types was a call nobody could read (or get right).
   */
  private async reconcileLoop(pass: ReconcilePass): Promise<unknown> {
    // The set answers "which files does this pass consider"; the array is what gives
    // the user's own files a head start (see `orderedFileIds`).
    const ordered = orderedFileIds([...pass.fileIds], pass, this.state);
    // Progress starts from the chains this pass already knows about; the creates add
    // themselves as the vault is walked (see `createUntrackedFiles`).
    this.activity.beginProgress(ordered.length);
    // Read ahead of the loop: the pool runs four files at a time, so without this a
    // cold download costs one round trip per four files whatever the batch route groups
    // (see `prefetchForPass`).
    this.prefetchForPass(pass, ordered);
    const pool = new WorkPool(this.passLimits);
    // Two chains can name one path while a peer's move is in flight; the tasks that
    // may write the same path take turns through the engine's path queue. Everything
    // else still runs concurrently.
    let firstFailure: unknown = null;
    // The tombstones this pass decided on. They are pushed together after every per-file
    // job has settled: a deletion discovered by a pass is one request per file otherwise,
    // which is what a thousand files deleted with the app closed costs against the sync
    // allowance (see `pushTombstones`).
    const pendingDeletes: PendingTombstone[] = [];

    // Every task is a different fileId, so the state mutations they make are disjoint;
    // the pool only decides how many may be in flight, and runs a large file alone.
    // Paths, unlike fileIds, are not disjoint for a moment after a peer's move — which
    // is what the queue serialises.
    await Promise.all(
      ordered.map((fileId) =>
        pool.run(weightOfFile(fileId, pass, this.state, this.passLimits), async () => {
          const claim = chainPaths(fileId, pass, this.state).claimed;
          try {
            const failure = await this.paths.run(
              claim,
              () => this.reconcileOne(fileId, pass, pendingDeletes),
              "pass",
            );
            if (failure !== null) firstFailure ??= failure;
          } catch (err) {
            // An unexpected failure (an adapter that cannot read a path, say) is
            // collected like a refused push: the other files are already in flight and
            // the pass still has work worth finishing. The caller raises it once every
            // task has settled.
            firstFailure ??= err;
          } finally {
            this.activity.advanceProgress();
          }
        }),
      ),
    );

    // Every pull of the pass has happened, so a candidate nobody asked for is a guess that
    // did not pay off: stop reading it and release the bytes it held, before the create
    // phase starts uploading. Only this pass's entries go — a burst that is applying
    // meanwhile has its own read-ahead. Requests already sent are not cancelled (a read is
    // read-only and settles on its own), but nothing new is started for this pass.
    this.prefetcher?.dropSpeculative("pass");

    // Untracked local files (no fileId anywhere) → create on the server. Its own batch
    // failures are collected inside it, for the same reason the push sites above are.
    //
    // Tombstones go first, creations second. The two are independent — a path this pass
    // deletes holds no file, so it cannot also be created in the same pass — and the
    // order only keeps a pass's deletions ahead of its creations.
    const deleteFailure = await this.pushTombstones(pendingDeletes);
    const batchFailure = await this.createUntrackedFiles(pass);
    // The pass is over: report the final pair, whose `done === total` tells a host to stop
    // showing a counter (a create that a limiter left unsent was counted and dropped).
    this.activity.reportProgress(true);
    return firstFailure ?? deleteFailure ?? batchFailure;
  }

  /**
   * Start reading, ahead of the loop, the versions this pass is about to pull.
   *
   * A download's wall clock is `waves × round trip`, where a wave is one `WorkPool` slot
   * — four files — and the batch route groups a wave's reads without changing the number
   * of waves (`docs/first-bind-performance.md` measures both at ~9.3 s for 1 000 files at
   * 30 ms). Reading ahead is what puts more files in one round trip without widening the
   * pool, and the pool's bound is deliberately untouched: it is what protects a phone's
   * memory for pushes, deletes and large files alike. The read-ahead holds ciphertext
   * only (see {@link ContentPrefetcher}).
   *
   * The candidates come from the same index the loop decides from: a live chain whose
   * head content is not among the hashes the scan just took, in the loop's own order.
   * That is a **superset** of the pulls in the ordinary case — a wrong guess (a conflict
   * copy, a local edit that decides as a push, a path the size cap refuses) costs bytes
   * that are dropped, never a decision. It is not a strict superset: bytes this device
   * holds at *another* path, or at a path the scan could not stat, are not in that set, so
   * a pull for them is simply read the old way. A wrong guess is cheap; a missed guess
   * costs one on-demand request.
   *
   * Note it is **only** the hashes the scan took, not the state's recorded sync points: a
   * record outlives the bytes it describes (a local edit, a delete), and treating it as
   * content this device holds would leave exactly the pulls that matter — a peer's revert,
   * a conflict resolved in the remote's favour — outside the read-ahead.
   *
   * The order is the loop's own (`orderedFileIds`), so the files it touches first are the
   * ones whose bytes go on the wire first; a read-ahead in server order would spend its
   * requests on the files the user is not looking at.
   */
  private prefetchForPass(pass: ReconcilePass, ordered: readonly string[]): void {
    if (this.prefetcher === null) return;
    this.prefetcher.request(
      prefetchCandidatesForPass(ordered, pass, this.state, pass.localHashes, (path) =>
        this.isSyncable(path),
      ),
      "pass",
    );
  }

  /**
   * The same read-ahead for a notification burst, from the chains the batch fetched.
   *
   * A peer that pushes 1 000 files sends 1 000 notifications; they arrive coalesced, and
   * this is the download the whole burst costs. The apply loop runs four files at a time,
   * so without a read-ahead every four files are one round trip.
   *
   * `headPaths` is the decrypted path of each head — the same set the caller's apply loop
   * has to compute anyway for its path check — because a chain outside this device's scope
   * is never applied, and reading it ahead would spend bytes on content invariant 8 says
   * this device does not sync.
   */
  private prefetchPushedChains(
    chains: ReadonlyMap<string, readonly VersionChainEntry[]>,
    applyPaths: ReadonlyMap<string, string | null>,
  ): void {
    if (this.prefetcher === null) return;
    this.prefetcher.request(
      prefetchCandidatesForBurst(chains, applyPaths, this.state, (path) => this.isSyncable(path)),
      "burst",
    );
  }

  /**
   * Hash the local files a pass can decide about, and leave the rest to the create path.
   *
   * Both halves of the scan used to read every syncable file: the hash here, and the bytes
   * again in `createUntrackedFiles` (which needs them to push). A file with **no state
   * entry and no chain at its path** cannot be pulled, conflicted or renamed — the only
   * thing it can become is a `create` — so this pass records its stamp and skips the
   * read, and the create reads it once. On a first bind that halves the reads of the
   * whole vault (`docs/first-bind-performance.md`).
   *
   * The stat rules are unchanged: a path the adapter cannot stat, or one over the size
   * cap, is recorded in `skipped` and left exactly as it is. An over-cap path is also
   * recorded in `overCap`, because the pass still has to *receive* a newer version for it
   * (see `applyOverCapRemote`).
   */
  private async scanLocalFiles(visiblePaths: readonly string[]): Promise<LocalScan> {
    const scan: LocalScan = {
      hashes: new Map(),
      stamps: new Map(),
      skipped: new Set(),
      overCap: new Set(),
      untracked: [],
    };
    // Small files read and hash concurrently, through the same pool the per-file half of
    // a pass uses: the loop used to await one file at a time, which on a 10 000-file
    // first bind is 10 000 serial read/hash pairs.
    const pool = new WorkPool(this.passLimits);
    await Promise.all(
      visiblePaths.map((path) => pool.run("small", () => this.scanLocalFile(path, scan))),
    );
    return scan;
  }

  private async scanLocalFile(path: string, scan: LocalScan): Promise<void> {
    const stamp = await this.opts.adapter.statFile(path);
    if (stamp === null) {
      scan.skipped.add(path);
      return;
    }
    if (!withinFileSizeCap(this.scope, stamp.sizeBytes)) {
      scan.skipped.add(path);
      // Over the **upload** cap: the pass must not push it, but it still has to take a
      // peer's newer version (`applyOverCapRemote`).
      scan.overCap.add(path);
      this.reportOverCapLocal(path, stamp);
      return;
    }
    // The stamp is kept for every statable file, not only the hashed ones: it orders the
    // create work (recently edited first) and it is what `createUntrackedFiles` re-checks
    // before reusing a hash.
    scan.stamps.set(path, stamp);
    const cached = this.cachedHashFor(path, stamp);
    if (cached !== null) {
      // The hash was recorded at exactly this stamp (`cachedHashFor` checked it), so it
      // is the one those bytes were hashed at — the adoption path below may trust it.
      scan.hashes.set(path, cached);
      return;
    }
    if (!this.pathToFileId.has(path) && this.remoteIndex.fileIdAt(path) === null) {
      scan.untracked.push(path);
      return;
    }
    const bytes = await this.opts.adapter.readFile(path);
    if (!bytes) return;
    const hash = await sha256Hex(bytes);
    scan.hashes.set(path, hash);
    // The file was read and hashed: if that hash is the one the state already records,
    // the stamp belongs to it and can be kept, which is what saves the next pass from
    // reading the file again. A hash that *differs* must not be stamped — the entry
    // still describes the old content, and pairing it with the new file's stamp would
    // make the next pass trust the old hash for the new bytes.
    const fileId = this.pathToFileId.get(path);
    if (fileId && this.state[fileId]?.lastKnownContentHash === hash) {
      this.rememberStamp(path, stamp);
    }
  }

  /**
   * Whether a tracked file's bytes are missing from this pass's hashes.
   *
   * `repairMovedFile` matches an event-less move by content, and the moved-to file has
   * no chain (that is the point) — so its hash is one the scan skipped. That fallback
   * only matters when a tracked file really has no hash this pass; anywhere else the
   * skipped hashes are pure savings.
   */
  private anyTrackedPathUnhashed(scan: LocalScan): boolean {
    for (const entry of Object.values(this.state)) {
      const path = entry.plainPath;
      if (!this.isSyncable(path)) continue;
      if (scan.skipped.has(path)) continue;
      if (!scan.hashes.has(path)) return true;
    }
    return false;
  }

  /**
   * One file of a pass.
   *
   * Split out of `reconcileLoop` so the per-file work can run through a `WorkPool`: the
   * decisions inside are per-fileId and the state it mutates is keyed by fileId/path, so
   * several of these can run together. Its caller serialises the ones whose paths
   * overlap (the engine's path queue). A failure is **returned** rather than thrown — the
   * pool's caller collects the first one and the rest of the pass still runs, exactly as
   * the serial loop did.
   *
   * A deletion it decides on is **collected**, not pushed: the pass sends every tombstone
   * it found in one batched job once the per-file work has settled (see `pushTombstones`).
   */
  private async reconcileOne(
    fileId: string,
    pass: ReconcilePass,
    pendingDeletes: PendingTombstone[],
  ): Promise<unknown> {
    const { localHashes, chainByFileId } = pass;
    const { skippedPaths, localStamps } = pass;

    // An event settled this file after the pass fetched its chain: its job owns the
    // file, and this pass's head may be older than the state it left behind (see
    // `ReconcilePass.stateAtStart`). The next pass decides from the fresh chain.
    if (
      (this.state[fileId]?.lastKnownVersionId ?? null) !== (pass.stateAtStart.get(fileId) ?? null)
    ) {
      return null;
    }

    const chain = chainByFileId.get(fileId) ?? [];
    const head = remoteHead(chain);
    const entry = this.state[fileId];
    // The path the chain's head records, which can differ from the one this
    // device has the file at — see the `synced` branch below. A chain the server
    // holds no path for falls back to whatever this device knows, which is also
    // what keeps the comparison below from firing on a missing path.
    const { plainPath, recordedPath } = chainPaths(fileId, pass, this.state);

    // A chain this device does not sync — settings files while the switch is
    // off, or a hard-excluded path — is left completely alone: not pulled, not
    // deleted, not turned into a conflict. Its state entry (if any) is kept, so
    // switching the sync scope on later resumes from where it stopped.
    // A tracked chain whose local file moved out of scope is parked: the chain may still
    // be in the remote index, but this device is not syncing the local path. No activity
    // row is emitted — the index loop reports a chain whose *remote* path is out of scope,
    // and this local-only move is remembered by the state rather than by the log.
    if (plainPath && !this.isSyncable(plainPath)) return null;

    // A tombstone this device itself pushed is its sync point for a deleted file, and
    // the entry is kept so a new local file at that path is a recreate (see `decideFile`).
    // Ownership settles that question: the path belongs to another chain once this device
    // maps it there (a pull adopted it) **or** the pass's server index records a live chain
    // there (a peer's new note this device has not pulled yet — a tombstone itself is never
    // in that index). Retiring the entry stops the pass from reading the new note as the
    // file under this device's delete point; a `restore` pushed from it would put the
    // deleted note back on top of the peer's and leave two live chains naming one path.
    if (
      head?.action === "delete" &&
      entry !== undefined &&
      entry.lastKnownVersionId === head.versionId &&
      plainPath !== null
    ) {
      const localOwner = this.pathToFileId.get(plainPath) ?? null;
      const remoteOwner = pass.remote.fileIdAt(plainPath);
      if (
        (localOwner !== null && localOwner !== fileId) ||
        (remoteOwner !== null && remoteOwner !== fileId)
      ) {
        delete this.state[fileId];
        if (localOwner === fileId) this.pathToFileId.delete(plainPath);
        return null;
      }
    }

    // A path this pass could not hash is left alone — except when the reason is the
    // **upload** cap, which must not stop this device from receiving a peer's newer
    // version. An unstatable path is left entirely as it is: an index that lags the disk
    // must not look like a deletion.
    if (plainPath && skippedPaths.has(plainPath)) {
      if (!pass.overCapPaths.has(plainPath)) return null;
      return await this.applyOverCapRemote(fileId, plainPath, head, entry);
    }

    let localExists = plainPath !== null && localHashes.has(plainPath);
    let localContentHash = plainPath === null ? null : (localHashes.get(plainPath) ?? null);
    // The decision context: what is on disk, what this device last agreed on, and
    // whether a peer's move already put a file where the head records one. The
    // subtle half — "is this absence this device's own deletion?" — is answered by
    // `isLocalDeletion`, once, for every path that asks it.
    const context: DecideContext = {
      entry,
      localExists,
      localContentHash,
      remoteChain: chain,
      tombstone: this.tombstoneMerge,
      headPathHasLocalFile: recordedPath !== null && localHashes.has(recordedPath),
      emptyHash: await this.emptyContentHash(),
    };
    let decision = decideFile(decideInputFrom(context));

    // `pull` and `conflict` both write to (or delete) the local file, and the
    // half of that decision which says "the local copy is untouched" comes from
    // the hashes this pass took when it started — a big vault takes long enough
    // that the user can type in the meantime. If the stamp moved, re-read the file
    // and decide once more from what is actually there: that turns "pull over an
    // edit made during the pass" into the conflict it is, instead of silently
    // overwriting the edit. An unchanged stamp keeps the pass's hash, so a large
    // attachment is not read once more before every pull. `push` reads its bytes
    // fresh anyway, so it needs none of this.
    if ((decision.action === "pull" || decision.action === "conflict") && plainPath) {
      const snapshot = localStamps.get(plainPath);
      const unchanged =
        snapshot !== undefined &&
        (await this.currentStampIfUnchanged(plainPath, snapshot)) !== null;
      if (!unchanged) {
        const freshHash = await this.currentLocalHash(plainPath);
        if (freshHash !== localContentHash) {
          localExists = freshHash !== null;
          localContentHash = freshHash;
          decision = decideFile(decideInputFrom({ ...context, localExists, localContentHash }));
        }
      }
    }

    // No event can be handling this path now: this job holds it, and an event's job for
    // the same path either ran before it or waits behind it (see `PathQueue`).

    switch (decision.action) {
      case "synced":
        return await this.settleSynced({
          fileId,
          plainPath,
          recordedPath,
          chain,
          head,
          entry,
          localExists,
          pass,
        });
      case "none":
        break;
      case "push":
        // Only a push that names a path can be sent; a decision without one has nothing
        // to write to.
        if (!plainPath) break;
        return await this.settlePushed({
          fileId,
          plainPath,
          decision,
          head,
          localExists,
          pendingDeletes,
        });
      case "pull": {
        if (!head || !plainPath) break;
        await this.pullRemote(fileId, plainPath, head, localContentHash);
        break;
      }
      case "conflict": {
        // A `false` answer (the remote side could not be applied) is tolerated here for the
        // same reason the `pull` case above tolerates it: a pass is the retry, and the next
        // one decides again from the same bytes.
        await this.conflicts.resolve(fileId, plainPath, head, localExists);
        break;
      }
    }
    return null;
  }

  /**
   * The `synced` half of a pass decision: record the identity the pass converged on, and
   * push the one thing a version match cannot carry — a rename this device made while it
   * could not reach the server.
   */
  private async settleSynced(settlement: SyncedSettlement): Promise<unknown> {
    const { fileId, plainPath, recordedPath, chain, head, entry, localExists, pass } = settlement;
    const { localStamps } = pass;
    let failure: unknown = null;

    // A `delete` head with no local file means the deletion has already happened here: the
    // file was removed while nothing was watching, or the peer deleted it before this
    // device ever materialised it. The entry's sync point is then a version of a file that
    // is not on disk, and neither the chain nor the path is this device's any more.
    // Retiring it keeps the state honest (an entry naming a path with no file) and lets the
    // next note at the freed path become a `create` instead of being decided against a
    // chain this device no longer has. The one exception is the recreate case: a sync point
    // that IS the tombstone keeps its entry, so a file the user writes there is pushed as a
    // `restore`.
    if (head?.action === "delete" && entry !== undefined && !localExists) {
      if (entry.lastKnownVersionId !== head.versionId) {
        delete this.state[fileId];
        if (plainPath !== null && this.pathToFileId.get(plainPath) === fileId) {
          this.pathToFileId.delete(plainPath);
        }
      }
      return null;
    }

    // Nothing to transfer, but the identity still has to be recorded. That covers two
    // shapes: a file that converges on the content it already had (the common case when
    // binding a vault whose remote holds the same note), and a sync point that is one
    // version behind a head already holding the bytes on disk — the race `decideFile`
    // answers "synced" for. Leaving the state behind would make the next edit conflict with
    // a version this device itself pushed. A tombstone is recorded on the state (so a later
    // file at that path is a recreate) but not in the remote index, which answers "which
    // chain lives here".
    if (head && plainPath && head.action !== "delete") {
      const current = this.state[fileId];
      if ((current?.lastKnownVersionId ?? null) !== head.versionId) {
        // Adopting a head records "the bytes on disk are this version", so the pass has to
        // be sure they still are. It decided from hashes taken when it started, while an
        // incremental event can change and push a file during the same pass — and adopting
        // over that would move the sync point *backwards* under a push that had already
        // succeeded, which turns the next edit into a conflict with this device's own
        // version. Two cheap checks: the file is still at the stamp this pass saw, and the
        // version the state now holds is one this pass's chain contains (a version created
        // during the pass is not). Re-reading `this.state` after the stat closes the last
        // await boundary.
        //
        // A `delete` head is not adopted at all: a tombstone lives at no path, so recording
        // one here would put a dead identity into `pathToFileId` (the recycle bin and the
        // version history would then find a chain for a file that is not there). The state
        // entry that says "this device deleted it" is written where the tombstone is
        // pushed, not by a pass.
        const unchanged = await this.currentStampIfUnchanged(plainPath, localStamps.get(plainPath));
        if (unchanged) {
          const latest = this.state[fileId]?.lastKnownVersionId ?? null;
          let pointIsKnown =
            latest === null || chain.some((version) => version.versionId === latest);
          let verified: FileStamp | null = unchanged;
          if (!pointIsKnown) {
            // The pass only carries the head (and a tombstone's previous live version), so
            // a sync point several versions back cannot be proven from it. Fetch this one
            // file's chain rather than skipping the adoption: the adoption is what keeps
            // the next edit from conflicting with a version this device itself pushed. The
            // request is rare — it is only reached when a peer's head already holds exactly
            // the bytes on disk while this device's sync point is behind it.
            try {
              const fetched = await this.pullChain(fileId);
              const headIndex = fetched.findIndex(
                (version) => version.versionId === head.versionId,
              );
              const latestIndex = fetched.findIndex((version) => version.versionId === latest);
              // The point has to be at or **before** this pass's head. A version created by
              // an event during the pass sits after it in the fetched chain, and adopting
              // the head over that one would move the sync point backwards under the
              // device's own successful push.
              pointIsKnown = headIndex >= 0 && latestIndex >= 0 && latestIndex <= headIndex;
            } catch {
              // The ancestry could not be fetched (offline, or a failed request). Leaving
              // the state where it is costs at most a conflict the next pass resolves;
              // moving the sync point on a chain nobody read would be worse, and failing
              // the file would turn a convergence race into a failed pass.
              pointIsKnown = false;
            }
            if (pointIsKnown) {
              // The fetch was an await, so the bytes this adoption would claim may have
              // changed, and an event may have pushed a newer version. Re-check both; the
              // state read happens after the stat with no await between it and the
              // adoption.
              verified = await this.currentStampIfUnchanged(plainPath, localStamps.get(plainPath));
              pointIsKnown =
                verified !== null && (this.state[fileId]?.lastKnownVersionId ?? null) === latest;
            }
          }
          if (pointIsKnown) {
            this.adoptRemoteIdentity(fileId, plainPath, head, verified);
          }
        }
      }
    }

    // A version match is not a path match. Every version records the path it was written
    // at, so a rename this device made while it could not reach the server is still missing
    // from the chain — and no other branch of this pass carries it, because the content and
    // the versionId both agree. Push it here; that is exactly the version an incremental
    // rename pushes.
    if (
      entry &&
      head &&
      head.action !== "delete" &&
      plainPath &&
      localExists &&
      recordedPath &&
      recordedPath !== plainPath &&
      !isConflictFile(recordedPath)
    ) {
      const read = await this.readWithStamp(plainPath);
      if (read) {
        // Decided from this pass's chain: that head is the base, so a peer that pushed
        // during the pass has its version refused rather than built over.
        try {
          await this.pushFile({
            fileId,
            plainPath,
            action: "rename",
            bytes: read.bytes,
            baseVersionId: head.versionId,
            stamp: read.stamp,
          });
        } catch (err) {
          if (err instanceof SyncPushBaseError) {
            await this.decideIncremental(fileId, plainPath);
          } else {
            // A push that failed is retried by the next pass; this one keeps going.
            failure = err;
          }
        }
      }
    }
    return failure;
  }

  /**
   * The `push` half of a pass decision: a tombstone the server never heard about, or the
   * bytes of an edit decided from this pass's chain.
   */
  private async settlePushed(settlement: PushSettlement): Promise<unknown> {
    const { fileId, plainPath, decision, head, localExists, pendingDeletes } = settlement;
    const { adapter } = this.opts;

    // A local deletion the server never heard about decides as `push: delete`: the
    // tombstone is pushed while it could not be (offline), or the file was deleted with the
    // app closed. There are no bytes to read for it, so it takes its own branch instead of
    // the content one below.
    if (decision.pushAction === "delete") {
      // Confirm with the adapter rather than trusting the listing: a listing that lags a
      // just-written file must never become a deletion. If the file is there, the next
      // reconcile makes the same call again. A stat is enough — the file's bytes are not
      // part of "is it gone?".
      if (await adapter.statFile(plainPath)) return null;
      // An event queued behind this job (the user moved or recreated the file while this
      // pass was deciding) owns the path: its job runs after this one and its decision is
      // newer, so a tombstone pushed now would be decided from a snapshot the event has
      // already invalidated.
      if (this.paths.hasQueued(plainPath, "event")) return null;
      // A move into a path outside the scope can land while this pass is deciding: the
      // chain now records the new path and nothing was deleted. The pass read `plainPath`
      // from a snapshot that is no longer true, so leave it to the next pass instead of
      // pushing a tombstone for a file the user still owns.
      if (this.state[fileId]?.plainPath !== plainPath) return null;
      // The tombstone keeps the moment this device decided on the deletion. When the
      // deletion happened with the app closed nothing recorded it, so it is taken now — the
      // best this pass can say — and remembered for the retries that follow (see
      // `applyLocalDelete`).
      this.deleteMoment(this.state[fileId]);
      // Held for the pass's one batched delete push (see `pushTombstones`): a pass that
      // finds a thousand files gone must not spend a thousand requests on them. The base is
      // the head this decision was taken from; the batch re-checks it, so a version a pull
      // adopts before the batch runs is not deleted from under a decision that never saw it.
      pendingDeletes.push({
        fileId,
        path: plainPath,
        baseVersionId: head?.versionId ?? null,
      });
      return null;
    }

    if (!localExists) return null;
    const read = await this.readWithStamp(plainPath);
    if (!read) return null;
    try {
      await this.pushFile({
        fileId,
        plainPath,
        action: decision.pushAction,
        bytes: read.bytes,
        baseVersionId: head?.versionId ?? null,
        stamp: read.stamp,
      });
      return null;
    } catch (err) {
      // A peer pushed while this pass was running: the decision above was taken from a
      // chain that has moved, so decide again from the chain the server just showed us
      // (which turns "overwrite it" into a conflict).
      if (err instanceof SyncPushBaseError) {
        await this.decideIncremental(fileId, plainPath);
        return null;
      }
      // A push that failed is retried by the next pass; this one keeps going.
      return err;
    }
  }

  /**
   * Create every untracked local file on the server, in **batches**.
   *
   * This is the pass that binds a vault, so it is the one that can be asked to create
   * a thousand files at once — and one request per file meant a thousand round trips
   * (the round trip, not the encryption, is what a first bind over a real network
   * spends its time on). The server has always accepted up to 100 files per push; the
   * engine simply never used it.
   *
   * The batching is bounded twice, by file count and by bytes: every file in a batch
   * stays in memory until the request is built, so a file over the byte bound travels
   * alone and a batch never grows past {@link MAX_PUSH_BATCH_BYTES}.
   *
   * Three things a refusal must not cost (each was measured; see
   * `docs/first-bind-performance.md`):
   *
   * - **the rest of the pass.** `flush()` is always awaited before its failure is
   *   recorded; the old `firstFailure ??= await flush()` short-circuited the call itself,
   *   so one refused batch silently dropped every batch after it.
   * - **the file's identity.** A create writes its state entry before the request (so a
   *   concurrent vault event adopts the same chain); a refused file drops that entry
   *   again, which keeps it "untracked" and therefore retried **in a batch** instead of
   *   one request per file.
   * - **the pass, on a rate limit.** A 429 is waited out (the server states the window)
   *   and the same batch is re-sent; only after {@link MAX_RATE_LIMIT_WAITS} waits does
   *   the pass stop and leave the remaining files to the next one.
   */
  private async createUntrackedFiles(pass: ReconcilePass): Promise<unknown> {
    const { localHashes, localStamps, untrackedPaths, priority } = pass;
    // Both sources are candidates: the hashes the scan took (a file a chain or a state
    // entry claims, or one the move-repair fallback hashed) and the paths the scan only
    // stamped. The latter is the common case on a first bind — the create reads each of
    // them once, where the scan used to have read it too.
    const candidates = [...localHashes.keys(), ...untrackedPaths];
    const ordered = orderByPriority(
      candidates.map((path, position) => ({
        key: path,
        paths: [path],
        mtimeMs: localStamps.get(path)?.mtimeMs ?? 0,
        // Every file here is untracked by definition; the tie-break is stated so a
        // reader does not have to infer it from the call site.
        locallyTracked: false,
        position,
      })),
      priority,
    );
    // The whole batch is one job over its paths: an event on a file this batch is
    // creating waits for it (and is applied after the create), so the batch cannot fork
    // a second chain for a path an event already owns.
    return await this.paths.run(
      ordered,
      () => this.createUntrackedFilesLocked(ordered, pass),
      "batch",
    );
  }

  /** The work of {@link createUntrackedFiles}, running inside its paths' job. */
  private async createUntrackedFilesLocked(
    ordered: readonly string[],
    pass: ReconcilePass,
  ): Promise<unknown> {
    const { localHashes, localStamps, remote } = pass;
    const batch = this.createBatch();

    // The order is the pass's (a note the user just created or opened first); it was
    // computed by the caller, which also queued this job for every candidate path.
    try {
      for (const path of ordered) {
        if (batch.rateLimited) break;
        if (this.pathToFileId.has(path) || remote.fileIdAt(path) !== null) continue;
        const read = await this.readWithStamp(path);
        if (!read) continue;
        // The pass may already have hashed this file. Reuse that hash only while the bytes
        // just read are the ones it hashed — the same size and mtime — because a file
        // edited between the listing and here must be hashed again, or the version would
        // name content the push does not carry.
        const scannedStamp = localStamps.get(path);
        const knownHash =
          scannedStamp !== undefined && read.stamp !== null && sameStamp(scannedStamp, read.stamp)
            ? localHashes.get(path)
            : undefined;

        const fileId = generateFileId();
        // A fileId this engine just generated cannot have a chain: base null. Prepared
        // **before** the state entry is written: a file the API cannot carry (its
        // encrypted path is over the limit) must not be left looking tracked with no
        // version — the next pass would read it as a divergence.
        const prepared = await this.preparePush({
          fileId,
          plainPath: path,
          action: "create",
          bytes: read.bytes,
          contentHash: knownHash,
          baseVersionId: null,
          stamp: read.stamp,
        });
        if (!prepared) continue;
        this.state[fileId] = {
          plainPath: path,
          lastKnownVersionId: null,
          lastKnownContentHash: null,
        };
        this.pathToFileId.set(path, fileId);
        // The pass has taken this file on: it is counted from here, so the last progress
        // report of a bind ends at `done === total` even when a limiter cuts it short.
        this.activity.addProgressTotal(1);
        // The batch owns the bounds and the request window: a chunked file travels alone
        // through `sendAlone`, a large one after the small files, and the next batch is
        // prepared while the previous request is on the wire (`pipelined`).
        const outcome = await batch.add(prepared, undefined, { pipelined: true });
        if (outcome === "dropped") break;
      }
    } catch (err) {
      // A throw from the adapter or the encryption must not leave the batch's pending
      // entries (or the request on the wire) behind: that is the stranded-file path again.
      await batch.settle();
      batch.abandon();
      throw err;
    }

    // The last full batch, then the tail of the vault.
    await batch.drain();
    return batch.failure;
  }

  /**
   * The batch a bind's creates travel in.
   *
   * Everything here is a create's own rule: its echo record and pending identity go
   * together when the server will not take it (`dropPendingCreate`), its progress row is
   * settled exactly once, and a chunked file stages its chunks before naming the upload.
   * The bounds and the request window are {@link PushBatch}'s.
   */
  private createBatch(): PushBatch<PreparedPush, void> {
    return new PushBatch<PreparedPush, void>(
      {
        send: async (prepared) => {
          const response = await this.withRateLimitWaits(() =>
            this.opts.api.push(
              this.opts.vaultId,
              prepared.map((one) => this.wireFile(one, one.content)),
            ),
          );
          return response.results;
        },
        contentFor: (prepared) => this.contentFor(prepared),
        sendAlone: async (prepared) => {
          const failure = await this.sendPreparedChunked(prepared);
          this.activity.advanceProgress();
          return failure;
        },
        applied: (prepared) => {
          this.applyPushedVersion(prepared);
          this.activity.advanceProgress();
        },
        refused: async (prepared, _meta, result) => {
          // A create names `baseVersionId: null`, so a stale base cannot reach it; every
          // non-`ok` answer is a refusal the next pass retries in a batch.
          return new Error(
            `Push failed for ${prepared.plainPath}: ${result?.error ?? result?.status ?? "no result"}`,
          );
        },
        forget: (prepared) => {
          this.forgetPushedVersion(prepared);
          this.dropPendingCreate(prepared);
          this.activity.advanceProgress();
        },
      },
      { maxFiles: MAX_PUSH_BATCH_FILES, maxBytes: MAX_PUSH_BATCH_BYTES },
    );
  }

  /**
   * Push the tombstones a pass decided on, in **batches**.
   *
   * A deletion a pass discovers — a file removed while nothing watched it, or one deleted
   * with the app closed — is content-less and used to be pushed one request per file.
   * Against the deployed 600 requests/minute allowance that is a thousand requests for a
   * thousand files, so a peer sees the deletions arrive over minutes; the same files
   * deleted while the host is running travel 100 per request through the event burst
   * (see `applyLocalEvents`). This is the same bound on the pass's side.
   *
   * The batch is one job over every path it names, so an event for any of them queues
   * behind it and its decision (a recreate, say) is applied after the tombstone. Every
   * entry is re-checked here instead of trusted from the pass's snapshot: the file is
   * still gone, the state still holds it at that path, no event owns the path, and the
   * sync point is still the head the decision was taken from.
   */
  private async pushTombstones(pending: readonly PendingTombstone[]): Promise<unknown> {
    if (pending.length === 0) return null;
    return await this.paths.run(
      pending.map((entry) => entry.path),
      () => this.pushTombstonesLocked(pending),
      "batch",
    );
  }

  /** The work of {@link pushTombstones}, running inside its paths' job. */
  private async pushTombstonesLocked(pending: readonly PendingTombstone[]): Promise<unknown> {
    const batch = this.tombstoneBatch();
    for (const entry of pending) {
      if (batch.rateLimited) break;
      try {
        // Prepare the next tombstone only once the queued request has landed: its guards
        // re-check the disk, and a file can be written back (or an event can claim the
        // path) while the batch is on the wire — the 101st tombstone of a 101-file
        // deletion must see that.
        if (batch.atCapacity) await batch.drain();
        if (batch.rateLimited) break;
        const prepared = await this.prepareTombstone(entry);
        if (!prepared) continue;
        if ((await batch.add(prepared, undefined)) === "dropped") break;
      } catch (err) {
        // A stat or an encryption that fails for one path is that path's problem: the
        // batch keeps the tombstones it already holds and the pass still creates.
        batch.recordFailure(err);
      }
    }
    await batch.drain();
    return batch.failure;
  }

  /**
   * The batch a pass's tombstones travel in.
   *
   * A tombstone is content-less and names the head it was decided from: its only answer
   * that is not a refusal is `stale_base`, settled from the chain the server refused
   * against (see {@link settleTombstoneRefusal}). The bounds and the request window are
   * {@link PushBatch}'s.
   */
  private tombstoneBatch(): PushBatch<PreparedPush, void> {
    return new PushBatch<PreparedPush, void>(
      {
        send: async (prepared) => {
          const response = await this.withRateLimitWaits(() =>
            this.opts.api.push(
              this.opts.vaultId,
              prepared.map((one) => this.wireFile(one, one.content)),
            ),
          );
          return response.results;
        },
        contentFor: (prepared) => this.contentFor(prepared),
        applied: (prepared) => this.applyPushedVersion(prepared),
        refused: (prepared, _meta, result) => this.settleTombstoneRefusal(prepared, result),
        forget: (prepared) => this.forgetPushedVersion(prepared),
      },
      { maxFiles: MAX_PUSH_BATCH_FILES, maxBytes: MAX_PUSH_BATCH_BYTES },
    );
  }

  /**
   * Settle a refused tombstone, answering the failure to record.
   *
   * `stale_base` means a peer pushed after the point the deletion was decided from: the
   * remote side wins and, the local file already being gone, there is nothing to park, so
   * the peer's version simply comes back. Any other answer is a refusal the pass reports.
   */
  private async settleTombstoneRefusal(
    prepared: PreparedPush,
    result: BatchPushResult | undefined,
  ): Promise<unknown> {
    if (classifyPushResult(result) !== "stale_base") {
      return new Error(
        `Push failed for ${prepared.plainPath}: ${result?.error ?? result?.status ?? "no result"}`,
      );
    }
    try {
      await this.settleStaleBase(prepared);
      return null;
    } catch (err) {
      if (!(err instanceof SyncPushBaseError)) return err;
      // The tombstone lost a race with a peer's edit: the remote side wins and there is
      // nothing local to park — the single-file path's answer, applied here too.
      try {
        const applied = await this.conflicts.resolve(
          prepared.fileId,
          prepared.plainPath,
          remoteHead(err.chain),
          false,
        );
        return applied ? null : err;
      } catch (conflictErr) {
        return conflictErr;
      }
    }
  }

  /**
   * The tombstone one deleted path needs, or null when that decision no longer holds.
   *
   * Re-checked here rather than trusted from the pass's snapshot: the pass released the
   * path after deciding, so a pull, an event or the user can have changed it before the
   * batch runs.
   */
  private async prepareTombstone(entry: PendingTombstone): Promise<PreparedPush | null> {
    const { fileId, path, baseVersionId } = entry;
    // The state entry is the record, not the path map: a locally deleted file keeps its
    // entry (the tombstone is retried from it) while the path mapping is already gone, so
    // a file written there later is a recreate rather than a resurrected chain.
    const stateEntry = this.state[fileId];
    if (!stateEntry || stateEntry.plainPath !== path) return null;
    // A version a pull adopted while the pass ran wins: this decision never saw it.
    if ((stateEntry.lastKnownVersionId ?? null) !== baseVersionId) return null;
    // An event queued behind the batch owns the path (the user recreated or moved the
    // file); its job decides after this one.
    if (this.paths.hasQueued(path, "event")) return null;
    // Confirm with the adapter rather than trusting the pass's listing: a file written
    // back between the decision and the batch is not a deletion.
    if (await this.opts.adapter.statFile(path)) return null;
    return await this.preparePush(
      this.tombstoneRequest(fileId, path, baseVersionId, this.deleteMoment(stateEntry)),
    );
  }

  /**
   * Remove the state entry a create wrote before its push was answered, when that push
   * was refused.
   *
   * `createUntrackedFiles` records the path → fileId mapping **before** the request so a
   * vault event that lands while the push is in flight adopts the same identity instead
   * of forking a second chain. A refusal has to undo exactly that: leaving the entry
   * behind made the file look tracked with no version, and the next pass then pushed it
   * one request at a time (`reconcileOne`'s `push` branch) — measured as 201 requests
   * for 201 files, against 100 files per request on the batched path.
   *
   * Only the *pending* shape is dropped. An event that pushed the same file successfully
   * while the batch was in flight has set a version (or a hash), and that sync point must
   * survive; the same goes for a path another identity has claimed since.
   */
  private dropPendingCreate(prepared: PreparedPush): void {
    const entry = this.state[prepared.fileId];
    if (!entry) return;
    if (entry.lastKnownVersionId !== null || entry.lastKnownContentHash !== null) return;
    // A pending entry goes even when its path now belongs to another identity (an
    // adoption, or a rename of this chain): leaving it behind makes the next pass push
    // this file one request at a time. Only the path mapping is somebody else's.
    delete this.state[prepared.fileId];
    if (this.pathToFileId.get(prepared.plainPath) === prepared.fileId) {
      this.pathToFileId.delete(prepared.plainPath);
    }
  }

  /**
   * Answer a refused tombstone the way every delete path must.
   *
   * A peer pushed after the point the delete was decided from, so the tombstone would have
   * removed a version this device never saw: a **deletion that raced an edit**. The remote
   * side wins and — the local file already being gone — there is nothing to park, so the
   * peer's version simply comes back. The single event and the burst share this so a
   * batched refusal cannot settle differently from an unbatched one.
   */
  private async settleRefusedTombstone(prepared: PreparedPush): Promise<void> {
    try {
      await this.pushPrepared(prepared);
    } catch (err) {
      if (!(err instanceof SyncPushBaseError)) throw err;
      await this.conflicts.resolve(
        prepared.fileId,
        prepared.plainPath,
        remoteHead(err.chain),
        false,
      );
    }
  }

  /**
   * Run one request, waiting out a rate limiter's window up to
   * {@link MAX_RATE_LIMIT_WAITS} times.
   *
   * The wait is the server's `Retry-After` when it sent one, otherwise a full window —
   * a shorter guess is refused again and burns an attempt. Everything else (a stale
   * base, a missing blob, a dropped connection) is answered to the caller immediately:
   * those are decisions, not "not now".
   *
   * Used for every request a pass makes in bulk — pushes, and a bind's content reads —
   * because a limiter window is a "wait", not a "no" for either of them. A first
   * download of a large remote vault is the same burst as a first upload, and used to
   * fail its pass at the transfer allowance instead of waiting for the next window.
   */
  private async withRateLimitWaits<T>(send: () => Promise<T>): Promise<T> {
    for (let waits = 0; ; waits++) {
      try {
        return await send();
      } catch (err) {
        if (!isRateLimitError(err) || waits >= MAX_RATE_LIMIT_WAITS) throw err;
        const waitMs = rateLimitWaitMs(err);
        try {
          this.opts.onRateLimited?.({ waitMs });
        } catch {
          // A host callback is not allowed to fail the pass.
        }
        try {
          await (this.opts.wait ?? ((ms: number) => sleep(ms, this.opts.platform)))(waitMs);
        } catch {
          // The wait was cancelled (the host stopped): answer the refusal it was waiting
          // out rather than retrying for a pass nobody is waiting for.
          throw err;
        }
      }
    }
  }

  /**
   * The stored ciphertext of one version, decrypted — or null when the store has nothing
   * to give.
   *
   * Only two answers are "nothing to apply": the store does not hold this hash (`404`,
   * the blob was reclaimed or the chain points at content no peer can fetch), and bytes
   * that do not decrypt (a wrong key, a truncated read). Everything else — a rate limit,
   * a 5xx, a dropped connection — is a **failed pull** and is rethrown: a pass that
   * silently skipped those reported success while the device stayed incomplete, which is
   * exactly what a 10 000-file first download did before this rule
   * (`docs/first-bind-performance.md`).
   */
  private async fetchRemoteBytes(
    contentHash: string,
    plaintextSize: number,
  ): Promise<Uint8Array | null> {
    // The API hands back the stored ciphertext itself; there is nothing to decode first,
    // so a pull decrypts the bytes it received and no more. Reads are batched by
    // `ContentReader`: a pass or a notification burst fetches several versions in one
    // request instead of one per file, and the read-ahead beside the loop may already hold
    // them (see `ContentPrefetcher`). A failure — a rate limit that outlasted its waits, a
    // 5xx, a dropped connection — is a failed pull and is rethrown; only a `null` (the store
    // holds nothing, or the bytes do not decrypt) is "nothing to apply".
    const stored = await this.content.read(contentHash, plaintextSize);
    if (stored === null) return null;
    try {
      return await decryptCombinedBytes(this.opts.encryptionKey, stored);
    } catch {
      // Undecryptable: not a store a peer can use, and retrying cannot fix it.
      return null;
    }
  }

  /**
   * Write a remote version's plaintext to `target`, whole or in chunks.
   *
   * The streaming branch is the one that keeps a large download bounded: the adapter
   * writes each decrypted chunk to a temporary file and renames it into place at the
   * end, so peak memory is a couple of 4 MiB chunks instead of the whole plaintext.
   * A host without {@link SyncAdapter.beginWrite} — or a version at or below the
   * chunking threshold — still gets the one-buffer path, which is what every host had
   * before this existed.
   */
  private async writeRemoteVersion(target: string, head: VersionChainEntry): Promise<boolean> {
    if (this.opts.adapter.beginWrite !== undefined && shouldTransferInChunks(head.sizeBytes)) {
      try {
        return await this.streamRemoteVersion(target, head);
      } catch {
        // A host whose sink fails — an `appendBinary` that exists but is unsupported on
        // a platform, a `rename` that refuses the target, a transient alias — must not
        // turn every retry of a large pull into a failure while the old whole-buffer
        // path would still work. The stream aborted itself; fall back once.
      }
    }
    const bytes = await this.fetchRemoteVersionBytes(
      this.opts.vaultId,
      head.contentHash,
      head.sizeBytes,
    );
    if (!bytes) return false;
    // The writer records the hash of what it is about to write, so the vault event the
    // write fires is recognised as this engine's own (see `recordSelfWrite`).
    await this.recordSelfWrite(target, bytes);
    await this.writing([target], () => this.opts.adapter.writeFile(target, bytes));
    return true;
  }

  /**
   * Write a chunked remote version through {@link SyncAdapter.beginWrite}.
   *
   * The target appears only when `close` renames the temporary file into place, so a
   * watcher never sees a half-written file and the engine's "one write = one event =
   * one hash" rule holds: the one event carries the hash recorded here. `abort` is
   * called on every failure, including a failed decryption and a failed `close`, so a
   * dropped download never leaves a truncated file that the next pass would read as a
   * local edit.
   *
   * Integrity is checked twice: each chunk's AEAD additional data names the version's
   * content hash, its index, the chunk count and the plaintext size (so a chunk from
   * another file, another position or a reordered upload fails to decrypt), and a
   * streaming SHA-256 over the decrypted chunks proves the concatenation is the
   * version's content before `close` makes it visible. The second check is what the
   * whole-buffer path's final hash does; it cannot use Web Crypto's one-shot digest
   * without holding the file, hence {@link Sha256}.
   */
  private async streamRemoteVersion(target: string, head: VersionChainEntry): Promise<boolean> {
    // Bound once: the adapter method reads its own state, and a bare reference is what
    // `@typescript-eslint/unbound-method` exists to catch (the `.call` below was the
    // workaround; binding says the same thing in the type system).
    const adapter = this.opts.adapter;
    const beginWrite = adapter.beginWrite?.bind(adapter);
    if (beginWrite === undefined) return false;
    const count = chunkCountForSize(head.sizeBytes);
    const hasher = adapter.createHasher?.() ?? new Sha256();
    const writer = await beginWrite(target);
    // The host's watcher can report the rename while `close` is still resolving. An
    // event that finds this promise waits for the stamp rather than reading the file.
    let settle!: (stamp: FileStamp | null) => void;
    const committedStamp = new Promise<FileStamp | null>((resolve) => {
      settle = resolve;
    });
    this.streamedCommits.set(target, committedStamp);
    let committed = false;
    try {
      for (let index = 0; index < count; index++) {
        const chunk = await this.fetchRemoteChunk(
          this.opts.vaultId,
          head.contentHash,
          index,
          count,
          head.sizeBytes,
        );
        if (chunk === null) return false;
        hasher.update(chunk);
        await writer.write(chunk);
      }
      if (hasher.digestHex() !== head.contentHash) return false;
      // Recorded before `close`: closing performs the rename that fires the event. The
      // stamp is added below, once the committed file can be stat'ed; until then the
      // hash record is the fallback (it costs a read, but it is correct).
      this.recordSelfWriteHash(target, head.contentHash);
      await this.writing([target], () => writer.close());
      committed = true;
      let stamp: FileStamp | null = null;
      try {
        stamp = await this.opts.adapter.statFile(target);
      } catch {
        // The commit landed; a stat failure only means the event cannot use the fast
        // path, so the content-hash record above still recognises it.
      }
      if (stamp !== null) this.recordSelfWriteHash(target, head.contentHash, stamp);
      settle(stamp);
      return true;
    } finally {
      this.streamedCommits.delete(target);
      if (!committed) {
        settle(null);
        await writer.abort().catch(() => {});
      }
    }
  }

  /**
   * One decrypted chunk of a remote version, or null when the store cannot provide it.
   *
   * Only two answers are "nothing to apply": the store does not hold this range (`404`)
   * and bytes that do not decrypt at this position (wrong key, a swapped or truncated
   * chunk). A rate limit, a 5xx or a dropped connection is a **failed pull** and is
   * rethrown, exactly as in {@link fetchRemoteBytes}.
   */
  private async fetchRemoteChunk(
    vaultId: string,
    contentHash: string,
    index: number,
    count: number,
    plaintextSize: number,
  ): Promise<Uint8Array | null> {
    const { start, end } = chunkBounds(index, plaintextSize);
    const storedStart = index * CHUNK_STORED_BYTES;
    const storedEnd = storedStart + (end - start) + 28 - 1;
    let stored: Uint8Array;
    try {
      stored = await this.withRateLimitWaits(() =>
        this.opts.api.getVersionContentRange(vaultId, contentHash, storedStart, storedEnd),
      );
    } catch (err) {
      if (isMissingContentError(err)) return null;
      throw err;
    }
    let chunk: Uint8Array;
    try {
      chunk = await decryptChunkBytes(
        this.opts.encryptionKey,
        stored,
        chunkAdditionalData(contentHash, index, count, plaintextSize),
      );
    } catch {
      return null;
    }
    if (chunk.byteLength !== end - start) return null;
    return chunk;
  }

  /**
   * The plaintext of a remote version, fetched one chunk at a time when it is large.
   *
   * Used by the whole-buffer path (a host without a streaming sink, and a restore,
   * which has to carry the bytes to its push). The plaintext is assembled into one
   * buffer, but the ciphertext is never held for more than one chunk, which is what
   * keeps a 200 MiB download out of the server and the client's HTTP layer.
   */
  private async fetchRemoteVersionBytes(
    vaultId: string,
    contentHash: string,
    plaintextSize: number,
  ): Promise<Uint8Array | null> {
    if (!shouldTransferInChunks(plaintextSize)) {
      return this.fetchRemoteBytes(contentHash, plaintextSize);
    }
    const count = chunkCountForSize(plaintextSize);
    const plaintext = new Uint8Array(plaintextSize);
    for (let index = 0; index < count; index++) {
      const chunk = await this.fetchRemoteChunk(vaultId, contentHash, index, count, plaintextSize);
      if (chunk === null) return null;
      const { start } = chunkBounds(index, plaintextSize);
      plaintext.set(chunk, start);
    }
    // Each chunk authenticates its own place, but only the whole-file hash proves the
    // bytes are the version's. The one pass is cheap next to the download and closes
    // the gap a server that swapped two same-sized blobs would otherwise leave.
    if ((await sha256Hex(plaintext)) !== contentHash) return null;
    return plaintext;
  }

  /**
   * The pull half for a path whose local copy is over the **upload** cap.
   *
   * The cap is exactly why the scan refused to read this file, so the decision has to
   * work without its bytes. The state's recorded stamp is the one test available, and it
   * answers "are the bytes on disk still the ones this device synced?":
   *
   * - unchanged, and a newer live head → apply it. The cap bounds what this device
   *   sends, not what it receives; leaving it would make the file silently stale, which
   *   is the failure the upload-only rule exists to remove.
   * - changed → the local edit is one this device can never send (the cap refuses it) and
   *   it must not be overwritten silently. The scan has already reported it; this pass
   *   leaves it alone.
   * - a `delete` head → never applied. Deleting a file this pass could not read would
   *   destroy content it never saw, and a conflict copy cannot be parked without the
   *   bytes.
   */
  private async applyOverCapRemote(
    fileId: string,
    plainPath: string,
    head: VersionChainEntry | undefined,
    entry: LocalVersionState[string] | undefined,
  ): Promise<unknown> {
    if (!head || head.action === "delete") return null;
    if (entry?.lastKnownContentHash === head.contentHash) return null;
    const recorded = entry?.stamp;
    if (!recorded) return null;
    const stamp = await this.opts.adapter.statFile(plainPath);
    if (stamp === null) return null;
    if (!sameStamp(stamp, recorded)) return null;
    const applied = await this.pullRemote(fileId, plainPath, head);
    return applied
      ? null
      : new Error(`Could not read the content of ${plainPath} (${head.contentHash})`);
  }

  /**
   * Apply a remote head locally, and answer whether the local side now matches
   * it.
   *
   * `false` means the version's content could not be read — the store does not
   * hold it, or it came back unusable (a truncated read decrypts to nothing) —
   * so nothing was written and the caller can say so instead of leaving the
   * vault quietly out of date. A deletion transfers no content and is answered
   * `true`.
   *
   * There is no size refusal here: the cap bounds uploads, and a version a peer
   * already stored is part of this vault (see `withinLocalSizeCap`).
   */
  private async pullRemote(
    fileId: string,
    plainPath: string,
    head: VersionChainEntry,
    localContentHash: string | null = null,
    deviceName: string | null = null,
  ): Promise<boolean> {
    // A delete head means "apply the remote delete locally".
    if (head.action === "delete") {
      this.recordSelfDelete(plainPath);
      await this.writing([plainPath], () => this.opts.adapter.deleteFile(plainPath));
      delete this.state[fileId];
      this.pathToFileId.delete(plainPath);
      // The chain has no live path any more. Keeping the index entry would make a file
      // written here later adopt this dead identity (see `RemoteIndex.forget`).
      this.remoteIndex.forget(fileId);
      // A settings file that disappeared is as much a change to what the app has
      // already read as one that arrived.
      this.activity.reportSettingsApplied(plainPath, "delete");
      this.activity.reportActivity({
        direction: "in",
        outcome: "applied",
        fileId,
        versionId: head.versionId,
        plainPath,
        action: head.action,
        sizeBytes: head.sizeBytes,
        deviceName,
      });
      return true;
    }

    // Whether this version is already this device's sync point *before* the write below.
    // A second pull of the same head applies nothing new, so
    // it must not report the same version twice.
    const alreadyHeld = this.state[fileId]?.lastKnownVersionId === head.versionId;

    // A version records the path it was created at, so a remote rename/move is
    // visible here even though this client never saw a `rename` notification.
    const { path: target, moved } = await this.followRemotePath(fileId, plainPath, head);

    // A head whose content this device already holds needs no download at all. That is
    // the rename case: a peer moved a file, the bytes never changed, and this device is
    // being asked to move its copy — downloading 40 MiB to write it where the file
    // already sits (or where the vault just moved it) is pure waste.
    //
    // What makes skipping safe is knowing the bytes belong to the file at `target`:
    // either the vault moved that very file there (`moved`), or the head records the
    // path whose content the caller hashed. Anything else — a peer's path already
    // occupied by a *different* local file — is a pull like any other, which is what
    // keeps this from adopting content nobody compared.
    if (
      localContentHash !== null &&
      localContentHash === head.contentHash &&
      (moved || target === plainPath)
    ) {
      const stamp = await this.opts.adapter.statFile(target);
      if (stamp !== null && stamp.sizeBytes === head.sizeBytes) {
        this.adoptRemoteIdentity(fileId, target, head, stamp);
        // The bytes were already here, but a settings file the peer **moved** now sits
        // at a path the app has not read — the same reload as one that arrived.
        if (moved) {
          this.activity.reportSettingsApplied(target, "rename");
          this.activity.reportActivity({
            direction: "in",
            outcome: "applied",
            fileId,
            versionId: head.versionId,
            plainPath: target,
            action: head.action,
            sizeBytes: head.sizeBytes,
            deviceName,
          });
        }
        return true;
      }
    }

    // A large version is written through the adapter's streaming sink when it has
    // one, so the plaintext never exists as one buffer; a small one, or a host
    // without a sink, still takes the whole-file path.
    const written = await this.writeRemoteVersion(target, head);
    if (!written) return false;
    return await this.adoptApplied(fileId, target, head, moved, deviceName, alreadyHeld);
  }

  /**
   * Record `applied` as this chain's sync point at `target`, and report it.
   *
   * The report is skipped when the device already held this version before the write: a
   * second pull of one head applied nothing new, and reporting
   * it again would give the CLI's activity log a duplicate row.
   */
  private async adoptApplied(
    fileId: string,
    target: string,
    applied: VersionChainEntry,
    moved: boolean,
    deviceName: string | null,
    alreadyHeld: boolean,
  ): Promise<boolean> {
    // The new sync point is recorded **in the same turn as the write**, before any
    // further `await`: a host can deliver more than one event for one write (Obsidian
    // reports a `create` and a `modify`), and an event that lands between the write and
    // this line reads the bytes the engine just wrote as a divergent local edit — which
    // resolves as a conflict against the very version that was just pulled, parking a
    // copy of the new content beside the note. The stamp is filled in afterwards,
    // because it costs a stat and nothing depends on it being there yet.
    this.adoptRemoteIdentity(fileId, target, applied);
    this.rememberStamp(target, await this.opts.adapter.statFile(target));
    if (!alreadyHeld) {
      this.activity.reportSettingsApplied(target, moved ? "rename" : "write");
      this.activity.reportActivity({
        direction: "in",
        outcome: "applied",
        fileId,
        versionId: applied.versionId,
        plainPath: target,
        action: applied.action,
        sizeBytes: applied.sizeBytes,
        deviceName,
      });
    }
    return true;
  }

  /**
   * Re-point a chain whose file was moved locally without the engine hearing about
   * it: the path the state records is gone from disk, but a local file that no
   * chain claims holds exactly the content this file was last synced at.
   *
   * The move can be event-less — the plugin was disabled while the file was
   * dragged, the app was killed before a failed rename push was persisted, or an
   * external tool moved the file. Without this the reconcile reads the chain as
   * "deleted locally" (and pushes a tombstone) and the file at its new path as a
   * brand-new file: one note, two chains, and a duplicate on every peer.
   *
   * A move whose destination is an **excluded folder** cannot be found in the pass's
   * listing (the scope drops it): {@link ExcludedMoveFinder} answers that half,
   * and the chain records the path without pushing, exactly like a rename event into
   * the same folder.
   *
   * Only a **live** head is repaired, so the bind-merge rule for tombstones is
   * untouched, and the candidate has to be unambiguous — exactly one unclaimed
   * local file with that content. Two files that merely share bytes must stay two
   * chains (see `findRemoteFileIdByContent`).
   */
  private async repairMovedFile(
    fileId: string,
    entry: LocalVersionState[string],
    localHashes: Map<string, string>,
    liveFileIds: Set<string>,
    remote: RemoteIndex,
  ): Promise<void> {
    const oldPath = entry.plainPath;
    // A chain this device leaves out of its scope is not "missing from disk": its file
    // may still be there, in a folder this device has excluded. Matching it to another
    // local file by content would hand the chain to a copy the user never moved.
    if (!this.isSyncable(oldPath)) return;
    if (localHashes.has(oldPath) || !liveFileIds.has(fileId)) return;
    const syncedHash = entry.lastKnownContentHash;
    if (!syncedHash) return;

    let candidate: string | null = null;
    for (const [path, hash] of localHashes) {
      if (hash !== syncedHash) continue;
      if (this.pathToFileId.has(path) || remote.fileIdAt(path) !== null) continue;
      if (candidate !== null) return; // ambiguous — leave both sides alone
      candidate = path;
    }
    if (candidate === null) {
      const excluded = await this.excludedMoves.find(fileId, oldPath, syncedHash);
      if (excluded === null) return;
      // Recorded, not pushed: the destination is outside this device's sync scope, and
      // the recorded path is what turns the move back into a `rename` when the folder
      // returns to scope. Dropping the chain here would make the old path a tombstone
      // for every peer.
      await this.paths.run(
        [oldPath],
        async () => {
          this.recordLocalPathMove(oldPath, excluded);
        },
        "pass",
      );
      return;
    }

    // Claim the candidate inside its path job: an event that adopted or created it while
    // this pass was scanning owns it, and the claim must not race that job. The content
    // is checked again because the scan's hash is a snapshot.
    await this.paths.run([oldPath, candidate], async () => {
      if (this.pathToFileId.has(candidate) || remote.fileIdAt(candidate) !== null) return;
      const bytes = await this.opts.adapter.readFile(candidate);
      if (!bytes || (await sha256Hex(bytes)) !== syncedHash) return;
      this.pathToFileId.delete(oldPath);
      this.pathToFileId.set(candidate, fileId);
      entry.plainPath = candidate;
    });
  }

  /**
   * The plain path a version was stored at, or null when it cannot be decrypted
   * (wrong key, or a legacy row).
   */
  private async decryptPath(entry: VersionChainEntry): Promise<string | null> {
    try {
      return await decryptString(this.opts.encryptionKey, entry.encryptedPath);
    } catch {
      return null;
    }
  }

  /**
   * Record `path` as this fileId's local identity and sync point.
   *
   * Used both when following a peer's move and when adopting a remote identity
   * for a path this engine was not tracking: in the adoption case the old path
   * mapping must be dropped here, or the *next* reconcile reads the file as
   * untracked again and forks a second chain — which is the defect that left an
   * old file behind after a peer renamed it.
   */
  private adoptRemoteIdentity(
    fileId: string,
    path: string,
    head: VersionChainEntry,
    stamp: FileStamp | null = null,
  ): void {
    // The mapping to drop is the one this chain was recorded under. The state is the
    // authority on where the local file lives; a chain adopted for the first time has no
    // state yet, and the remote index holds the path it was last stored at. Scanning
    // `pathToFileId` for every adoption made a bind of K pulls O(K·N) in vault size.
    const previous = this.state[fileId]?.plainPath ?? this.remoteIndex.pathOf(fileId);
    if (previous !== undefined && previous !== path) this.pathToFileId.delete(previous);
    this.pathToFileId.set(path, fileId);
    this.state[fileId] = {
      lastKnownVersionId: head.versionId,
      lastKnownContentHash: head.contentHash,
      plainPath: path,
      // Only a caller that knows the file on disk holds these bytes passes a stamp —
      // the pull that just wrote them, or the move that carried them there. Adopting
      // an identity for a path nobody has read leaves it absent, which costs the next
      // pass one read and never a wrong hash.
      ...(stamp === null ? {} : { stamp }),
    };
    this.remoteIndex.remember(fileId, head, path);
  }

  /**
   * Bring the local file to the path the remote head records, and report where the
   * caller should write — plus whether this call **moved** the file there.
   *
   * `moved` is what lets a pull know that the bytes at the returned path are the bytes
   * that were at the old one (see `pullRemote`): a rename of the file is proof, a path
   * that merely happens to exist is not.
   *
   * The returned path is always one this engine may write. Falling back to the
   * old `plainPath` when the local file is already gone recreates the very file
   * the peer moved away from, leaving both paths on disk — so when there is
   * nothing left to move, the pull has to land at the remote path.
   */
  private async followRemotePath(
    fileId: string,
    plainPath: string,
    head: VersionChainEntry,
  ): Promise<{ path: string; moved: boolean }> {
    const remotePath = await this.decryptPath(head);
    if (!remotePath || remotePath === plainPath || !this.isSyncable(remotePath)) {
      return { path: plainPath, moved: false };
    }

    // The vault already put a file at the peer's path: our own earlier rename, an
    // event Obsidian delivered first, or a diverged file. Either way there is
    // nothing to move — the caller writes the remote bytes there, and the state
    // has to move with it, or the old mapping survives to fork a second chain.
    //
    // `statFile`, not `readFile`: only "is a file there?" is being answered, and a
    // move of a large attachment would otherwise read both sides of it whole just to
    // follow a path.
    if (await this.opts.adapter.statFile(remotePath)) {
      // No stamp: the bytes here were never read or hashed, and a stamp may only be
      // recorded with the hash of the bytes at that stamp (a missing stamp costs one
      // re-read, and a failed pull then retries instead of looking synced).
      this.adoptRemoteIdentity(fileId, remotePath, head);
      return { path: remotePath, moved: false };
    }

    // Nothing local to move either: the peer's path is where the file belongs.
    const localStamp = await this.opts.adapter.statFile(plainPath);
    if (!localStamp) return { path: remotePath, moved: false };

    this.recordSelfRename(plainPath, remotePath);
    await this.writing([plainPath, remotePath], () =>
      this.opts.adapter.renameFile(plainPath, remotePath),
    );
    this.pathToFileId.delete(plainPath);
    this.pathToFileId.set(remotePath, fileId);
    return { path: remotePath, moved: true };
  }

  // ── Incremental local events ──

  async handleLocalChange(path: string): Promise<void> {
    // Conflict files and anything outside this device's scope (a settings file
    // while the switch is off, a path in a dot-folder) are not this engine's.
    if (!this.isSyncable(path)) return;
    // The first bind runs **outside** the path queue: its per-file jobs queue on the
    // paths they decide, so a bind started from inside this event's job would wait for
    // the job that is waiting for it. Not when the event is the echo of a write this
    // engine is performing: that write is the bind's own work, and binding again would
    // wait for it.
    if (!this.initialized && !this.writingPaths.has(path))
      await this.initialSync({ firstBind: true });
    // A pull decided for this file can apply at the path the head records (a peer move),
    // so claim that path too when the chain already names one.
    const fileId = this.pathToFileId.get(path);
    const recorded = fileId ? this.remoteIndex.pathOf(fileId) : null;
    const claim = recorded !== null && recorded !== path ? [path, recorded] : [path];
    return this.schedule(claim, () => this.applyLocalChange(path));
  }

  /** The work of {@link handleLocalChange}, running inside its path job. */
  private async applyLocalChange(path: string): Promise<void> {
    // The bind covers every file it scans; a deferred event that runs before it finishes
    // must not push an identity of its own.
    if (!this.initialized) return;
    const read = await this.readLocalChange(path);
    if (!read) return;

    const fileId = this.pathToFileId.get(path);
    if (!fileId) {
      const hash = await sha256Hex(read.bytes);
      // The identity fallback's listing: one vault listing only pays for itself when the
      // identity is genuinely unknown, and a batch computes it once for every path.
      const localPaths = new Set(await this.opts.adapter.listSyncableFiles());
      const outcome = await this.resolveNewLocalFile(
        path,
        read.bytes,
        read.stamp,
        hash,
        localPaths,
      );
      if (outcome.kind === "prepared" || outcome.kind === "rename") {
        await this.pushPrepared(outcome.prepared);
      }
      this.persist();
      return;
    }

    // Existing tracked file — incremental decide. The bytes just read are handed on so
    // the decision does not read (and hash) the same file a second time; it re-checks
    // the stamp before trusting them (see `decideIncremental`).
    await this.decideIncremental(fileId, path, read);
    this.persist();
  }

  /**
   * Carry out a batch of local vault events as **one job**.
   *
   * A bulk write — an agent, a script, a folder operation — reaches a host as one event
   * per file. Handled one at a time that is one `POST /sync/push` per file, which the sync
   * route's per-vault allowance refuses after about a minute (1 000 generated notes
   * measured 1 000 pushes; 300 edits to existing notes measured 300 chain reads *and* 300
   * pushes). This job makes the same per-path decisions as {@link handleLocalChange} but
   * collects the versions they produce and sends them 100 files per request; it reads the
   * vault listing once instead of once per new file, and fetches tracked files' chains 200
   * per request.
   *
   * It is a job over every path it is given, so an event for one of those paths queues
   * behind it rather than deciding from a half-applied batch — the same rule the pass's
   * create batch follows (`PathQueue`).
   *
   * Paths need not be syncable or distinct; anything outside this device's scope is
   * dropped here, before the listing is paid for.
   */
  async handleLocalEvents(batch: LocalEventBatch): Promise<void> {
    const changed = [...new Set(batch.changed ?? [])].filter((path) => this.isSyncable(path));
    const deleted = [...new Set(batch.deleted ?? [])].filter((path) => this.isSyncable(path));
    // A pair is kept when either side is this device's: a move *out* of the scope still
    // has to re-point the chain (see `rememberMoveOutOfScope`), which is what keeps a
    // later pass from reading the old path as a deletion.
    const renamed = (batch.renamed ?? []).filter(
      (pair) => pair.from !== pair.to && (this.isSyncable(pair.from) || this.isSyncable(pair.to)),
    );
    if (changed.length === 0 && deleted.length === 0 && renamed.length === 0) return;
    const all = [...changed, ...deleted, ...renamed.flatMap((pair) => [pair.from, pair.to])];
    // A batch while this host has never completed a bind runs one first, exactly as the
    // single event does — and never from inside the engine's own write (see
    // `handleLocalChange`).
    if (!this.initialized && !all.some((path) => this.writingPaths.has(path))) {
      await this.initialSync({ firstBind: true });
    }
    if (!this.initialized) return;
    // A pull decided for one of these files can apply at the path the head records (a
    // peer's move), so the job claims that path too, as the single event does.
    const claims = new Set<string>(all);
    for (const path of all) {
      const fileId = this.pathToFileId.get(path);
      const recorded = fileId ? this.remoteIndex.pathOf(fileId) : null;
      if (recorded !== null) claims.add(recorded);
    }
    return this.schedule([...claims], () => this.applyLocalEvents(changed, deleted, renamed));
  }

  /**
   * The work of {@link handleLocalEvents}, running inside its paths' job.
   *
   * Everything from disk to a prepared version happens here (so the listing and the
   * ciphertext are paid once), and the versions leave in batches of
   * {@link MAX_PUSH_BATCH_FILES} / {@link MAX_PUSH_BATCH_BYTES} — the same bounds the
   * pass's create batch uses, because the server accepts the same 100-file request.
   */
  private async applyLocalEvents(
    paths: readonly string[],
    deleted: readonly string[],
    renamed: ReadonlyArray<{ from: string; to: string }>,
  ): Promise<void> {
    if (!this.initialized) return;
    const job = new LocalEventJob<PreparedPush>(
      this.localEventHost(),
      { changed: paths, deleted, renamed },
      { maxFiles: MAX_PUSH_BATCH_FILES, maxBytes: MAX_PUSH_BATCH_BYTES },
    );
    try {
      await this.applyRenames(job);
      await this.prepareDeletions(job);
      await this.applyChangedFiles(job);
      await this.settleTrackedFiles(job);
      await job.drainTombstones();
      await job.complete();
    } catch (err) {
      // Anything that throws outside the send — a chain read, a prepare, an encryption, a
      // chunk upload, the restore-owner check — leaves the versions prepared so far
      // unsent. Their state entries were recorded before the request (so a concurrent
      // event adopts the identity), and a pass that finds them would push them **one
      // request per file**: the regression `dropPendingCreate` exists to prevent. Drop
      // every one of them, and persist the state without them — `flush` may already have
      // written the whole state, this entry included.
      job.abandon();
      this.persist();
      throw err;
    }
  }

  /** What the job may ask of this engine; every sync rule stays behind these. */
  private localEventHost(): LocalEventJobHost<PreparedPush> {
    return {
      contentFor: (prepared) => this.contentFor(prepared),
      push: async (prepared) => {
        const response = await this.withRateLimitWaits(() =>
          this.opts.api.push(
            this.opts.vaultId,
            prepared.map((one) => this.wireFile(one, one.content)),
          ),
        );
        return response.results;
      },
      applied: (prepared) => this.applyPushedVersion(prepared),
      refused: async (prepared, kind) => {
        if (kind === "create") {
          // The bytes may already be stored (a lost response) or the state entry was just
          // dropped again: `pushPrepared` owns both answers.
          await this.pushPrepared(prepared);
          return;
        }
        if (kind === "delete") {
          await this.settleRefusedTombstone(prepared);
          return;
        }
        if (kind === "rename") {
          // The move is already on disk, so a refused `rename` is decided again from the
          // chain the server showed us — the same answer the single event gives.
          try {
            await this.pushPrepared(prepared);
          } catch (err) {
            if (!(err instanceof SyncPushBaseError)) throw err;
            await this.decideIncremental(prepared.fileId, prepared.plainPath);
          }
          return;
        }
        // A tracked chain: decide again from the fresh chain, exactly as the single
        // event does on a refusal.
        await this.decideIncremental(prepared.fileId, prepared.plainPath);
      },
      forget: (prepared) => {
        this.forgetPushedVersion(prepared);
        this.dropPendingCreate(prepared);
      },
      sendAlone: (prepared) => this.pushPrepared(prepared),
      persist: () => this.persist(),
    };
  }

  /**
   * Moves first: a move re-points its chain, so the destination is this chain's path from
   * here on — which is also what keeps the delete phase from reading the old path as a
   * deletion. A move whose source this device never tracked is a create at the
   * destination, so it joins the change list instead of paying for a job of its own.
   */
  private async applyRenames(job: LocalEventJob<PreparedPush>): Promise<void> {
    // A path this job deletes **and** a move lands on: the file that was there is gone, so
    // its chain's tombstone must reach the server before the move's version — otherwise a
    // peer writes the moved bytes and then applies a delete at the same path. Captured up
    // front, because the move re-points the mapping for the destination.
    for (const path of job.deletions) {
      const fileId = this.pathToFileId.get(path);
      if (fileId !== undefined) job.captureReplacedDestination(path, fileId);
    }
    for (const pair of job.renames) {
      if (job.rateLimited) break;
      if (!this.isSyncable(pair.to)) {
        // The file left this device's sync set: keep its chain, remember where it went,
        // push nothing. A tracked chain whose recorded path went stale would look like a
        // local deletion (and a tombstone) once the folder comes back into scope.
        this.rememberMoveOutOfScope(pair.from, pair.to);
        this.persist();
        continue;
      }
      // The engine following a peer's move fires this same event.
      if (this.consumeSelfRename(pair.from, pair.to)) continue;
      const replaced = job.replacedDestination(pair.to);
      if (replaced !== undefined) {
        // The destination's chain is going away, and the move writes over it: the
        // tombstone must reach the server **before** the move's version, or a peer applies
        // the rename and then deletes the bytes at the same path. It is pushed on its own
        // here, so the move is only prepared when the destination really is retired — a
        // refused or failed tombstone leaves the destination chain live, and the local file
        // is settled against it by the next pass instead of forking a second chain.
        const tombstone = await this.resolveLocalDelete(pair.to, replaced);
        job.forgetReplacedDestination(pair.to);
        job.markDeleteConsumed(pair.to);
        if (tombstone.kind === "prepared") {
          try {
            await this.pushPrepared(tombstone.prepared);
          } catch (err) {
            // The destination's chain did not retire, so it keeps the path: roll the local
            // deletion bookkeeping back first (the state still names it at P, and the path
            // mapping must too), then let the single-event rule settle the local file
            // against that chain — a peer's version wins and the moved bytes are parked.
            this.selfEvents.forgetDelete(replaced);
            if (this.state[replaced] !== undefined) delete this.state[replaced].deletedAtMs;
            this.pathToFileId.set(pair.to, replaced);
            if (err instanceof SyncPushBaseError) {
              const head = remoteHead(err.chain);
              // The refused head may already hold exactly the bytes on disk (the two
              // devices converged): identical bytes are never a conflict, so adopt it
              // instead of parking a copy of the same content.
              const localBytes = await this.opts.adapter.readFile(pair.to);
              const localHash = localBytes === null ? null : await sha256Hex(localBytes);
              if (head && localHash !== null && localHash === head.contentHash) {
                this.adoptRemoteIdentity(replaced, pair.to, head, null);
              } else {
                const applied = await this.conflicts.resolve(replaced, pair.to, head, true);
                // A peer version that cannot be applied is a failed push, not a settled
                // one: the pass is the retry (the same rule the delete refusal follows).
                if (!applied) job.recordFailure(err);
              }
            } else {
              // An uncertain failure (a transport error, a limiter): the tombstone may or
              // may not have landed. Report it so the pass retries the decision.
              job.recordFailure(err);
            }
            this.persist();
            continue;
          }
          // The tombstone landed: the path is free, and the moved bytes are a new chain at
          // it (or, when they are the deleted content, a take-back rename below).
          this.pathToFileId.delete(pair.to);
        }
      }
      const outcome = await this.resolveLocalRename(pair.from, pair.to);
      if (outcome.kind === "handled") {
        this.persist();
        continue;
      }
      if (outcome.kind === "change") {
        job.noteChange(pair.to);
        continue;
      }
      await job.add(outcome.prepared, "rename");
    }
  }

  /**
   * Deletions next. A batch has no arrival order to lean on, and a delete that raced the
   * create replacing its file (a temp-file save, a folder move, the CLI's `fs.watch`)
   * must be recorded before the create is decided: that record is how a moved file is
   * recognised as a rename instead of a second chain. The tombstone itself is only
   * **prepared** here — it is queued once every change has been decided, so a create
   * that turns out to be the other half of the move can take it back.
   */
  private async prepareDeletions(job: LocalEventJob<PreparedPush>): Promise<void> {
    for (const path of job.deletions) {
      if (job.rateLimited) break;
      // A destination this job already tombstoned for a move: the path now holds the moved
      // chain, and resolving it again would tombstone that one.
      if (job.isDeleteConsumed(path)) continue;
      // The engine applying a peer's delete fires this same event; it must not be echoed
      // back to the server as a second tombstone.
      if (this.consumeSelfDelete(path)) continue;
      // A removal and a rewrite of the same path can share a window (a tool replacing a
      // file, a watcher that reports both halves of a move). A path this batch is also
      // rewriting is not a deletion — but only while the file is **still there**: a write
      // followed by a delete inside one window leaves the change unreadable, and then the
      // tombstone is the only record of what happened. The single-event path keeps its own
      // rule (it sees the two events in order, tombstone included).
      if (job.hasPendingChange(path) && (await this.opts.adapter.statFile(path)) !== null) {
        continue;
      }
      const outcome = await this.resolveLocalDelete(path);
      if (outcome.kind === "handled") {
        this.persist();
        continue;
      }
      const contentHash = this.state[outcome.prepared.fileId]?.lastKnownContentHash ?? "";
      job.noteTombstone(path, outcome.prepared, contentHash);
    }
  }

  /**
   * The changes: one vault listing for the whole job (the identity fallback asks whether a
   * chain's recorded path still holds a file), and tracked files collected for the job's
   * one bulk chain read.
   */
  private async applyChangedFiles(job: LocalEventJob<PreparedPush>): Promise<void> {
    // Read only when a decision needs it, and only once: a burst of 1 000 used to walk the
    // vault 1 000 times. Lazy, because a job whose only work is an untracked move appends
    // its destination after the move phase — the listing has to include that file. A pure
    // deletion batch pays nothing.
    let localPaths: Set<string> | null = null;
    const listing = async (): Promise<Set<string>> =>
      (localPaths ??= new Set(await this.opts.adapter.listSyncableFiles()));
    for (const path of job.changes) {
      if (job.rateLimited) break;
      const read = await this.readLocalChange(path);
      if (!read) continue;

      const knownFileId = this.pathToFileId.get(path);
      if (knownFileId) {
        job.track(knownFileId, path, read);
        continue;
      }

      // The file reappeared after this job prepared the tombstone of the chain that used
      // to sit here, with different bytes (a write and a delete in one window). Take the
      // tombstone back and decide the path as the tracked chain it still is: deciding it as
      // a new file would read the remote index's stale live head and park the new bytes as
      // a conflict with the version this job was going to delete.
      const tombstoneFileId = job.tombstoneAt(path);
      if (tombstoneFileId !== null && this.state[tombstoneFileId]?.plainPath === path) {
        job.takeBackTombstone(tombstoneFileId);
        this.selfEvents.forgetDelete(tombstoneFileId);
        if (this.state[tombstoneFileId] !== undefined) {
          delete this.state[tombstoneFileId].deletedAtMs;
        }
        this.pathToFileId.set(path, tombstoneFileId);
        job.track(tombstoneFileId, path, read);
        continue;
      }

      const hash = await sha256Hex(read.bytes);
      const outcome = await this.resolveNewLocalFile(
        path,
        read.bytes,
        read.stamp,
        hash,
        await listing(),
        job,
      );
      if (outcome.kind === "handled") {
        this.persist();
        continue;
      }
      await job.add(outcome.prepared, outcome.kind === "rename" ? "rename" : "create");
    }
  }

  /** The tracked files, decided from the job's one bulk chain read. */
  private async settleTrackedFiles(job: LocalEventJob<PreparedPush>): Promise<void> {
    if (job.tracked.length === 0 || job.rateLimited) return;
    const chains = await this.pullChains(job.tracked.map((entry) => entry.fileId));
    // One index read for every restore in the job: the owner check asks the server which
    // chain holds a recreated path, and a burst of recreates must not cost one read each.
    let restoreIndex: Promise<VaultSyncIndexResponse> | null = null;
    const loadRestoreIndex = (): Promise<VaultSyncIndexResponse> =>
      (restoreIndex ??= this.withRateLimitWaits(() =>
        this.opts.api.getVaultSyncIndex(this.opts.vaultId),
      ));
    for (const { fileId, path, read } of job.tracked) {
      if (job.rateLimited) break;
      const outcome = await this.decideTrackedPush(
        fileId,
        path,
        chains.get(fileId) ?? [],
        read,
        loadRestoreIndex,
      );
      if (outcome.kind === "retry") {
        // The file moved while the chain was being fetched: the single-file path re-reads
        // it and decides again (it fetches that one chain itself).
        await this.decideIncremental(fileId, path);
        this.persist();
        continue;
      }
      if (outcome.kind === "handled") {
        this.persist();
        continue;
      }
      const prepared = await this.preparePush(outcome.request);
      if (!prepared) continue;
      await job.add(prepared, "tracked");
    }
  }

  /**
   * The chains of several files in as few requests as the protocol allows
   * ({@link MAX_PULL_BATCH_FILES} per request).
   *
   * A refused request is waited out like any other bulk read: a burst that trips the sync
   * allowance at its chain reads must not fail the whole batch.
   */
  private async pullChains(fileIds: readonly string[]): Promise<Map<string, VersionChainEntry[]>> {
    const chains = new Map<string, VersionChainEntry[]>();
    for (let start = 0; start < fileIds.length; start += MAX_PULL_BATCH_FILES) {
      const chunk = fileIds.slice(start, start + MAX_PULL_BATCH_FILES);
      const response = await this.withRateLimitWaits(() =>
        this.opts.api.pull(this.opts.vaultId, [...chunk]),
      );
      for (const file of response.files) chains.set(file.fileId, file.versions);
    }
    return chains;
  }

  /**
   * Everything an event needs from disk before it decides: the size cap, a streamed
   * commit still landing, the file's stamp, and the two checks that keep the engine's own
   * write from being read as a user edit.
   *
   * Null means "this event has nothing to do": over the cap, gone, or the echo of a write
   * this engine performed. Shared by the single event and the batch so the two cannot
   * drift on the rules that keep an engine's own write out of its own sync.
   */
  private async readLocalChange(path: string): Promise<LocalChangeRead | null> {
    // The size cap is checked before the read, so an oversized file is never loaded.
    if (!(await this.withinLocalSizeCap(path))) return null;
    // A streamed commit may have renamed the target already while its stamp is still
    // being taken. Waiting here is what lets the event below avoid reading the file.
    const pendingCommit = this.streamedCommits.get(path);
    if (pendingCommit) await pendingCommit;
    const stamp = await this.opts.adapter.statFile(path);
    if (stamp === null) return null;
    // A streamed write records its stamp as well as its hash: the event this very write
    // fires is then recognised without reading a file that was just written in chunks.
    // A genuine edit inside the window moves the stamp and takes the ordinary path.
    if (this.selfEvents.matchesSelfWriteStamp(path, stamp)) return null;
    const bytes = await this.opts.adapter.readFile(path);
    if (!bytes) return null;

    // A write this engine performed echoes back as a vault event, and the host's
    // handler runs before the engine's own state update lands (the write and that
    // update are separate async hops). Treating the echo as a user edit is what
    // produced a phantom conflict, a duplicate restore and a duplicate fileId.
    if (await this.isOwnWrite(path, bytes)) return null;
    return { bytes, stamp };
  }

  /**
   * What a local file with no known fileId becomes: a rename on a chain this device
   * deleted, an adoption of a remote chain at that path (or one already holding these
   * bytes), or a **new chain's create** — prepared, and returned rather than sent so a
   * batch can put up to 100 of them in one request.
   *
   * The versions on an existing chain are returned as `rename` (the batch queues them like
   * any other version, so a burst's moves travel together); only the conflict branch acts
   * here, because it writes to disk as part of deciding.
   *
   * *Which* identity wins — a delete's chain, the path's live owner, the content fallback,
   * or a new chain — is {@link decideNewLocalFile}; this method only performs the choice.
   */
  private async resolveNewLocalFile(
    path: string,
    bytes: Uint8Array,
    stamp: FileStamp,
    hash: string,
    localPaths: Set<string>,
    ledger?: TombstoneLedger,
  ): Promise<
    | { kind: "prepared"; prepared: PreparedPush }
    | { kind: "rename"; prepared: PreparedPush }
    | { kind: "handled" }
  > {
    // The identity lookups, in the order `decideNewLocalFile` ranks them: a delete this
    // same job prepared is matched from the job's own ledger (the self-event log's window
    // is sized for one event, and a burst's tail can outlive it); then the live chain the
    // server records at the path; then the content fallback, which needs the caller's
    // listing so two coexisting copies are never merged.
    const deletedFileId =
      ledger?.deletedFileIdForHash(hash) ?? this.selfEvents.matchDeletedFile(hash)?.fileId ?? null;
    const known = this.remoteIndex.fileIdAt(path);
    const knownHead = known ? this.remoteIndex.headOf(known) : undefined;
    const pathOwner =
      known && knownHead && knownHead.action !== "delete"
        ? { fileId: known, head: knownHead }
        : null;
    const contentOwner = pathOwner ? null : this.findRemoteFileIdByContent(hash, localPaths);
    const decision = decideNewLocalFile({
      contentHash: hash,
      deletedFileId,
      pathOwner,
      contentOwner,
    });

    if (decision.kind === "rename-on-deleted") {
      const { fileId } = decision;
      const oldPath = this.state[fileId]?.plainPath;
      if (oldPath) this.pathToFileId.delete(oldPath);
      this.state[fileId] = { ...this.state[fileId], plainPath: path };
      this.pathToFileId.set(path, fileId);
      // The chain never left the tree: the delete event this create is the other half of
      // must not reach the server, so its tombstone is taken back (and the moment it was
      // decided goes with it — a later deletion dates itself then). Consumed whichever
      // ledger answered: one delete explains one new file.
      ledger?.takeBackTombstone(fileId);
      this.selfEvents.forgetDelete(fileId);
      if (this.state[fileId] !== undefined) delete this.state[fileId].deletedAtMs;
      const prepared = await this.preparePush({
        fileId,
        plainPath: path,
        action: "rename",
        bytes,
        contentHash: hash,
        baseVersionId: this.state[fileId].lastKnownVersionId,
        stamp,
      });
      return prepared === null ? { kind: "handled" } : { kind: "rename", prepared };
    }

    if (decision.kind === "adopt") {
      // The server already tracks this path (or this content) under a fileId we are not
      // tracking locally — a peer renamed or moved a file, and our vault event for the new
      // path won the race against the state update that would have claimed it. Adopt that
      // identity instead of forking a second chain for the same path.
      const { fileId, head } = decision.owner;
      this.adoptRemoteIdentity(fileId, path, head, stamp);
      if (decision.sameContent) {
        // Same content at the peer's path: a rename, not an edit. The head just adopted
        // is the base.
        const prepared = await this.preparePush({
          fileId,
          plainPath: path,
          action: "rename",
          bytes,
          contentHash: hash,
          baseVersionId: head.versionId,
          stamp,
        });
        return prepared === null ? { kind: "handled" } : { kind: "rename", prepared };
      }
      const chain = await this.pullChain(fileId);
      await this.conflicts.resolve(fileId, path, remoteHead(chain), true);
      return { kind: "handled" };
    }

    // A fileId this engine just generated cannot have a chain: base null. The state entry
    // is written **before** the request so an event that lands while the batch is in
    // flight adopts this identity instead of forking a second chain; a refusal drops it
    // again (`dropPendingCreate`).
    const fileId = generateFileId();
    const prepared = await this.preparePush({
      fileId,
      plainPath: path,
      action: "create",
      bytes,
      contentHash: hash,
      baseVersionId: null,
      stamp,
    });
    if (!prepared) return { kind: "handled" };
    this.state[fileId] = {
      plainPath: path,
      lastKnownVersionId: null,
      lastKnownContentHash: null,
    };
    this.pathToFileId.set(path, fileId);
    return { kind: "prepared", prepared };
  }

  /**
   * Decide what to do with a file this device already tracks, then act on it.
   *
   * A decision is only valid for the chain it was taken from, so when the server
   * refuses the push because a peer moved that chain in the meantime, this decides
   * again from the chain the server just showed us — once. Deciding again from the
   * *fresh* chain while the state still holds the point both sides last agreed on
   * is what turns "the peer's version is what my edit builds on" into the conflict
   * it actually is, instead of a modification that silently replaces their edit.
   *
   * A user edit is never a bind: a tombstone on this chain applies the deletion (or
   * asks the user when the content diverged).
   *
   * `prefetched` is the caller's read of the file (`applyLocalChange` reads it once for
   * its own checks). It is reused while the file still carries the stamp it was read at
   * — the same size+mtime hint a pass trusts — so a large edit costs one read and one
   * hash instead of two of each. A stamp that moved, or a second attempt after a
   * refusal, sends this back to the file.
   */
  private async decideIncremental(
    fileId: string,
    path: string,
    prefetched?: { bytes: Uint8Array; stamp: FileStamp | null },
  ): Promise<void> {
    let chain: VersionChainEntry[] | null = null;

    for (let attempt = 0; attempt < EVENT_DECISION_ATTEMPTS; attempt++) {
      chain ??= await this.pullChain(fileId);
      // Only the first attempt may reuse the prefetched bytes: a `stale_base` retry
      // fetched the chain again, so they have had another network round trip to age.
      const outcome = await this.decideTrackedPush(
        fileId,
        path,
        chain,
        attempt === 0 ? prefetched : undefined,
      );
      if (outcome.kind === "handled") return;
      // The file moved while its chain was being read: decide again from disk (which
      // fetches that one chain itself), as this path always has.
      if (outcome.kind === "retry") return await this.decideIncremental(fileId, path);
      try {
        await this.pushFile(outcome.request);
        return;
      } catch (err) {
        if (!(err instanceof SyncPushBaseError)) throw err;
        if (decideRefusedPush(attempt) === "report") throw err;
        chain = err.chain;
      }
    }
  }

  /**
   * The live chain the server records at `path`, other than `exceptFileId`, or null.
   *
   * The incremental decision is taken from the tracked chain alone, and the in-memory
   * `RemoteIndex` can be stale when a peer's `file_pushed` never arrived (the socket was
   * down) and no pass has run since. A `restore` is the event push that resurrects a chain
   * this device deleted, so that is the one case worth a server read before pushing; an
   * untracked create cannot afford this on every new note (see the docs for the limit that
   * leaves). The read is the request a pass starts with, and the scan decrypts each live
   * head's path — O(chains) crypto, paid once per recreate, not on ordinary edits. A failed
   * read is a failed event, retried by the next pass.
   *
   * `loadIndex` lets one job answer every restore it decides from **one** read (a bulk
   * recreate is a bulk write, and one index request per file would spend the allowance the
   * batch exists to stay inside); without it the read waits out a limiter window like every
   * other bulk read.
   */
  private async findLiveChainAtPath(
    path: string,
    exceptFileId: string,
    loadIndex?: () => Promise<VaultSyncIndexResponse>,
  ): Promise<{ fileId: string; head: VersionChainEntry } | null> {
    const index = await (
      loadIndex ??
      (() => this.withRateLimitWaits(() => this.opts.api.getVaultSyncIndex(this.opts.vaultId)))
    )();
    for (const entry of index.files) {
      if (entry.fileId === exceptFileId) continue;
      if (entry.head.action === "delete") continue;
      let plainPath: string | null = null;
      try {
        plainPath = await decryptString(this.opts.encryptionKey, entry.head.encryptedPath);
      } catch {
        continue;
      }
      if (plainPath === path && this.isSyncable(plainPath)) {
        return { fileId: entry.fileId, head: entry.head };
      }
    }
    return null;
  }

  /**
   * Hand a recreated path to the chain that already owns it.
   *
   * The same rule a pass applies: the other chain keeps the path, the local copy either
   * becomes the other head (identical bytes) or is parked as a conflict when it diverged,
   * and only once that apply succeeded is this device's tombstone entry retired so no later
   * event or pass restores it. A failed apply answers `false` with the state untouched — the
   * caller reports it, and the next pass retries from the same decision.
   */
  private async resolveRecreateAgainstOwner(
    other: { fileId: string; head: VersionChainEntry },
    fileId: string,
    path: string,
    hash: string,
    stamp: FileStamp | null,
  ): Promise<boolean> {
    this.remoteIndex.remember(other.fileId, other.head, path);
    if (other.head.contentHash === hash) {
      // The recreated bytes are already the owner's version: adopt it, no conflict.
      this.adoptRemoteIdentity(other.fileId, path, other.head, stamp);
    } else {
      const applied = await this.conflicts.resolve(other.fileId, path, other.head, true);
      if (!applied) return false;
    }
    if (this.state[fileId]?.plainPath === path) {
      delete this.state[fileId];
      // The apply above may already have given the mapping to the owner; only drop a stale
      // one that still names the dead chain.
      if (this.pathToFileId.get(path) === fileId) this.pathToFileId.delete(path);
    }
    return true;
  }

  /**
   * Decide what one **tracked** file's change is, without sending anything.
   *
   * The whole of `decideIncremental` except the push itself: the version to send is
   * *returned*, so a batch can put it in the same request as the burst's creates, and
   * everything a decision can do to the file (adopt the head as synced, pull the remote
   * version, resolve a conflict) happens here.
   *
   * Three outcomes: `push` carries the version and its base, `handled` means the decision
   * already acted on the file or had nothing to do, and `retry` means the bytes moved while
   * the chain was read — the caller decides again from disk (a prefetched read is only
   * trusted while its stamp still holds, and a non-push decision must be taken from the
   * file as it is *now*, because it may overwrite it).
   */
  private async decideTrackedPush(
    fileId: string,
    path: string,
    chain: VersionChainEntry[],
    prefetched?: { bytes: Uint8Array; stamp: FileStamp | null },
    loadRestoreIndex?: () => Promise<VaultSyncIndexResponse>,
  ): Promise<{ kind: "push"; request: PushRequest } | { kind: "handled" } | { kind: "retry" }> {
    const head = remoteHead(chain);
    // The caller's read stands only while the file still carries the stamp it was taken
    // at — the same size+mtime hint a pass trusts.
    const stampHolds =
      prefetched !== undefined &&
      prefetched.stamp !== null &&
      (await this.currentStampIfUnchanged(path, prefetched.stamp)) !== null;
    const read =
      stampHolds && prefetched !== undefined ? prefetched : await this.readWithStamp(path);
    // Only an event-driven pass reaches here without bytes, and a change event for a file
    // that cannot be read is not evidence of a deletion (the host's delete event is). Stay
    // put rather than pushing a tombstone.
    if (!read) return { kind: "handled" };
    const { bytes: readBytes, stamp: readStamp } = read;
    let hash = await sha256Hex(readBytes);
    let decision = decideFile(
      decideInputFrom({
        entry: this.state[fileId],
        // The file is on disk (read above), so this cannot be a deletion.
        localExists: true,
        localContentHash: hash,
        remoteChain: chain,
        // An incremental event is never a bind: a tombstone applies the deletion.
        tombstone: "apply-remote-delete",
        headPathHasLocalFile: false,
        emptyHash: await this.emptyContentHash(),
      }),
    );
    let bytes = readBytes;
    let stamp = readStamp;

    // A non-push decision acts on the file (it may overwrite it, or adopt the remote head
    // as synced), so it must be taken from bytes read **now**, not from the caller's
    // pre-fetch that the chain request has had time to age. If the file moved, the caller
    // decides again.
    if (needsFreshRead(decision, stampHolds)) {
      const fresh = await this.readWithStamp(path);
      if (!fresh) return { kind: "handled" };
      const freshHash = await sha256Hex(fresh.bytes);
      if (freshHash !== hash) return { kind: "retry" };
      bytes = fresh.bytes;
      stamp = fresh.stamp;
      hash = freshHash;
    }

    if (decision.action === "push") {
      // A `restore` resurrects a chain this device deleted, so before pushing one the engine
      // asks the server whether another chain already owns the path. The in-memory index can
      // be stale (a peer's `file_pushed` never arrived and no pass has run since), and this is
      // the event push worth one index read: an untracked create cannot afford it on every new
      // note, which is why the check lives here and not on that branch. A chain the index names
      // wins the path exactly as it would on a pass: this device's tombstone is retired, and
      // the local copy is adopted or parked.
      if (decision.pushAction === "restore") {
        const other = await this.findLiveChainAtPath(path, fileId, loadRestoreIndex);
        if (other) {
          const applied = await this.resolveRecreateAgainstOwner(other, fileId, path, hash, stamp);
          if (!applied) {
            // A failed apply must be visible, not swallowed: the pass is the retry (the same
            // rule the notification path follows). The local file is still on disk.
            throw new Error(`Could not read the content of ${path} (${other.head.contentHash})`);
          }
          return { kind: "handled" };
        }
      }
      // The stamp travels with the push, so the sync point it records is one the next pass
      // can trust without reading the file back — and the hash it just computed is the one
      // the version carries, so `preparePush` does not hash the file a third time.
      return {
        kind: "push",
        request: {
          fileId,
          plainPath: path,
          action: decision.pushAction,
          bytes,
          contentHash: hash,
          baseVersionId: head?.versionId ?? null,
          stamp,
        },
      };
    }
    if (decision.action === "synced") {
      // The head already holds the bytes on disk, while our sync point is behind it:
      // another operation on this path pushed them and this decision fetched the chain
      // before that push's response landed (see `decideFile`). Take the head as the sync
      // point — a tombstone has no live identity to adopt, and a delete head with a local
      // file on disk never decides as verifiable-synced anyway.
      if (
        head &&
        head.action !== "delete" &&
        this.state[fileId]?.lastKnownVersionId !== head.versionId
      ) {
        this.adoptRemoteIdentity(fileId, path, head, stamp);
      }
    } else if (decision.action === "conflict") {
      await this.conflicts.resolve(fileId, path, head, true);
    } else if (decision.action === "pull" && head) {
      await this.pullRemote(fileId, path, head, hash);
    }
    return { kind: "handled" };
  }

  async handleLocalDelete(path: string): Promise<void> {
    if (!this.isSyncable(path)) return;
    // The engine applying a peer's delete fires this same event; it must not be
    // echoed back to the server as a second tombstone.
    if (this.consumeSelfDelete(path)) return;
    return this.schedule([path], () => this.applyLocalDelete(path));
  }

  /** The work of {@link handleLocalDelete}, running inside its path job. */
  private async applyLocalDelete(path: string): Promise<void> {
    const outcome = await this.resolveLocalDelete(path);
    if (outcome.kind === "handled") {
      this.persist();
      return;
    }
    await this.settleRefusedTombstone(outcome.prepared);
    this.persist();
  }

  /**
   * Prepare the tombstone one deleted path needs, or null when it needs none.
   *
   * The single delete and the burst share this: the move-out-of-scope rule, the
   * rename-by-hash record and the `deletedAtMs` a peer compares are all decided here, so
   * a batched tombstone cannot differ from an unbatched one.
   */
  private async resolveLocalDelete(
    path: string,
    explicitFileId?: string,
  ): Promise<{ kind: "prepared"; prepared: PreparedPush } | { kind: "handled" }> {
    const fileId = explicitFileId ?? this.pathToFileId.get(path);
    if (!fileId) return { kind: "handled" };
    // A delete event can be half of a move the host could not report as a rename (an
    // external tool, the CLI's `fs.watch`, a plugin that was not running). When the
    // destination is inside a folder this device excludes, the created half never
    // reaches the engine — so the absence must not become a tombstone for a file the
    // user still owns. Record the new path and push nothing; un-excluding the folder is
    // what turns the move back into a `rename`.
    const contentHash = this.state[fileId]?.lastKnownContentHash ?? "";
    if (contentHash !== "") {
      const movedTo = await this.excludedMoves.find(fileId, path, contentHash);
      if (movedTo !== null) {
        this.recordLocalPathMove(path, movedTo);
        return { kind: "handled" };
      }
    }
    // Remember the delete so a file that appears with this content can be read as its
    // rename rather than as a brand-new chain.
    this.selfEvents.rememberDelete(fileId, this.state[fileId]?.lastKnownContentHash ?? "");
    // Only drop the mapping while it still names this chain: a move can have taken the path
    // in the same job, and the tombstone of the chain that used to be there must not remove
    // the new owner's mapping.
    if (this.pathToFileId.get(path) === fileId) this.pathToFileId.delete(path);
    // The state entry survives until the server accepts the tombstone (`applyPushedVersion`
    // then rewrites it to the delete version). Dropping it here would leave a failed push
    // — the network is down, or the app is closed before the next attempt — with a fileId
    // the engine no longer tracks but the server still holds live, and the next reconcile
    // would read that as "a remote file this device is missing" and pull the deletion back.
    //
    // When the deletion was decided rides along with it: a tombstone has no file to
    // stamp, and a peer compares its `mtimeMs` with its own file's modification time.
    // Reading the clock again on a retry (the next pass, possibly hours later) would let a
    // deletion made *before* a peer's edit outrank that edit.
    const prepared = await this.preparePush(
      this.tombstoneRequest(
        fileId,
        path,
        this.state[fileId]?.lastKnownVersionId ?? null,
        this.deleteMoment(this.state[fileId]),
      ),
    );
    return prepared === null ? { kind: "handled" } : { kind: "prepared", prepared };
  }

  async handleLocalRename(oldPath: string, newPath: string): Promise<void> {
    const newSyncable = this.isSyncable(newPath);
    // The destination is outside the scope: the file has left this device's sync set (or
    // both ends were already outside it). Keep its chain, remember where it went, and
    // push nothing — a tracked chain whose recorded path went stale would look like a
    // local deletion (and a tombstone) once the folder comes back into scope, and leaving
    // the scope deletes nothing on either side. Checked before the self-rename rule: the
    // engine never moves a file out of scope itself, so an event here is the user's.
    if (!newSyncable) {
      // One job over both paths: the state change must not race a pass or an event
      // deciding for either of them.
      return await this.schedule([oldPath, newPath], async () => {
        this.rememberMoveOutOfScope(oldPath, newPath);
      });
    }
    // The first bind runs outside the queue, exactly as `handleLocalChange` does: a rename
    // handled before the bind would push a create for content the server may already hold.
    // Not for the echo of a write this engine is performing (see `handleLocalChange`).
    if (!this.initialized && !this.writingPaths.has(oldPath) && !this.writingPaths.has(newPath)) {
      await this.initialSync({ firstBind: true });
    }
    // The engine following a peer's move fires this same event.
    if (this.consumeSelfRename(oldPath, newPath)) return;
    // Both paths are marked: a reconcile can meet this move as either "the old
    // path vanished" or "an unclaimed file appeared at the new one".
    return this.schedule([oldPath, newPath], () => this.applyLocalRename(oldPath, newPath));
  }

  /**
   * Record and persist a move that leaves (or stays entirely outside) this device's
   * sync scope.
   *
   * The caller runs it inside the two paths' job, so a pass that started before the
   * event cannot decide a tombstone for the old path from its snapshot while the state
   * is being re-pointed.
   */
  private rememberMoveOutOfScope(oldPath: string, newPath: string): void {
    if (this.recordLocalPathMove(oldPath, newPath)) this.persist();
  }

  /**
   * Move a tracked chain's recorded path without telling the server.
   *
   * Used when a file is moved into (or within) a folder this device does not sync, and
   * by the two event-less move paths (`repairMovedFile` and `applyLocalDelete`). The
   * chain keeps its head and its sync point; only the local identity moves. The remote
   * index forgets the chain, so a brand-new file that appears at the old path is not
   * handed an identity whose bytes now live somewhere else. When the folder comes back
   * into scope, the next pass sees the recorded path differ from the remote one and
   * pushes the move as a `rename`.
   */
  private recordLocalPathMove(oldPath: string, newPath: string): boolean {
    const fileId = this.pathToFileId.get(oldPath);
    if (!fileId) return false;
    const entry = this.state[fileId];
    if (!entry) return false;
    this.pathToFileId.delete(oldPath);
    this.pathToFileId.set(newPath, fileId);
    this.state[fileId] = { ...entry, plainPath: newPath };
    this.remoteIndex.forget(fileId);
    return true;
  }

  /** The work of {@link handleLocalRename}, running inside its two paths' job. */
  private async applyLocalRename(oldPath: string, newPath: string): Promise<void> {
    const trackedFileId = this.pathToFileId.get(oldPath) ?? null;
    const outcome = await this.resolveLocalRename(oldPath, newPath);
    if (outcome.kind === "change") {
      // Untracked source: the destination is a plain create. Called directly, because this
      // job already holds `newPath` — scheduling the event would wait for the job that is
      // waiting for it.
      await this.applyLocalChange(newPath);
      return;
    }
    if (outcome.kind === "handled") {
      // The chain was re-pointed (or there was nothing to record); a move is a disk fact.
      this.persist();
      return;
    }
    try {
      await this.pushPrepared(outcome.prepared);
    } catch (err) {
      if (!(err instanceof SyncPushBaseError)) throw err;
      await this.decideIncremental(trackedFileId ?? outcome.prepared.fileId, newPath);
    } finally {
      this.persist();
    }
  }
  /**
   * What one move needs, decided without sending anything.
   *
   * The single rename and the burst share this: the chain is re-pointed at the destination
   * (the state records it even when the push fails, because the move is already on disk),
   * the version carries the content hash the sync point already holds (so a move of a large
   * attachment is one small request, not a second upload), and a source this device never
   * tracked becomes a `change` at the destination — the batch decides that one with the
   * rest of its changes, where the single event creates it on the spot.
   */
  private async resolveLocalRename(
    oldPath: string,
    newPath: string,
  ): Promise<
    { kind: "prepared"; prepared: PreparedPush } | { kind: "handled" } | { kind: "change" }
  > {
    const fileId = this.pathToFileId.get(oldPath);
    if (!fileId) {
      // Untracked: a plain create at the new path, once this host has bound.
      if (this.pathToFileId.has(newPath)) return { kind: "handled" };
      // Uninitialised, this would push a create without the remote index; the bind (or the
      // next pass) creates the file instead.
      if (!this.initialized) return { kind: "handled" };
      return { kind: "change" };
    }
    this.pathToFileId.delete(oldPath);
    this.pathToFileId.set(newPath, fileId);
    this.state[fileId] = { ...this.state[fileId], plainPath: newPath };
    // The version records the content's hash (and its size, which a peer applies its own
    // cap to). The bytes themselves are usually *not* sent: the chain's head already holds
    // this content, so the push reuses it.
    //
    // A move changes neither content nor stamp, so the sync point's recorded hash is
    // already the answer: reading (and hashing) 40 MiB only to decide not to send it was
    // the whole cost of a move. `cachedHashFor` requires the size *and* mtime it recorded,
    // and a stamp that moved (edited and renamed with no event in between) falls back to
    // reading the file.
    const stamp = await this.opts.adapter.statFile(newPath);
    const knownHash = stamp === null ? null : this.cachedHashFor(newPath, stamp);
    const read = knownHash === null ? await this.readWithStamp(newPath) : null;
    const prepared = await this.preparePush({
      fileId,
      plainPath: newPath,
      action: "rename",
      bytes: read?.bytes,
      ...(knownHash === null || stamp === null
        ? {}
        : { contentHash: knownHash, sizeBytes: stamp.sizeBytes }),
      baseVersionId: this.state[fileId]?.lastKnownVersionId ?? null,
      stamp: knownHash === null || stamp === null ? (read?.stamp ?? null) : stamp,
    });
    return prepared === null ? { kind: "handled" } : { kind: "prepared", prepared };
  }

  /**
   * True when `versionId` is one this engine pushed, and consumes the record.
   *
   * A host calls this **when the notification arrives**, not when the work runs: a
   * coalesced batch can be applied seconds later, and the echo record has a deadline
   * (see `SelfEventLog`). Consuming late turns the engine's own versions into "peer"
   * ones, which is one `POST /sync/pull` each — the storm this batching exists to
   * avoid.
   */
  consumeOwnPush(versionId: string): boolean {
    return this.selfEvents.consumePushedVersion(versionId);
  }

  /**
   * Whether `path` carries a live record of a **write** this engine performed.
   *
   * A cheap hint, not a decision: the engine still matches the bytes (or the stamp) before
   * it ignores an event. A host uses it to tell a burst of the user's writes from the vault
   * events its own pull fires — a 1 000-file pull produces 1 000 `modify` events, and a
   * host that counted them as a burst would run a pass behind every large download (see
   * `SyncHost`'s local-burst rule).
   */
  hasSelfWriteHint(path: string): boolean {
    return this.selfEvents.hasSelfWrite(path);
  }

  /** The same for a delete this engine performed (see {@link hasSelfWriteHint}). */
  hasSelfDeleteHint(path: string): boolean {
    return this.selfEvents.hasSelfDelete(path);
  }

  /** The same for a move this engine performed out of `path` (see {@link hasSelfWriteHint}). */
  hasSelfRenameHint(path: string): boolean {
    return this.selfEvents.hasSelfRename(path);
  }

  /** Remote change notification (WS `file_pushed`). */
  async handleFilePushed(
    fileId: string,
    versionId: string,
    deviceName: string | null = null,
  ): Promise<void> {
    // Echo suppression: skip a version this engine pushed itself. The id is consumed so
    // the record cannot outlive the echo it exists for — and when no echo comes at all
    // (the server skips the pushing session's subscription), the deadline sweep in
    // `SelfEventLog.rememberPushedVersion` is what keeps the map from growing forever.
    if (this.selfEvents.consumePushedVersion(versionId)) return;
    await this.applyPushedChain(fileId, versionId, deviceName, await this.pullChain(fileId));
    this.persist();
  }

  /**
   * Remote change notifications in one call, with one chain request per batch.
   *
   * A first bind of a large vault broadcasts one `file_pushed` per file. Applying them
   * one at a time cost one `POST /sync/pull` per file, which is 5 000 requests against
   * a 600/minute limiter: a peer that was online during the bind landed 548 of 5 000
   * files and then sat refused until the next pass. The host coalesces the burst and
   * the chains of up to {@link MAX_PULL_BATCH_FILES} notifications travel together;
   * each is still applied in arrival order, from the head the server answered with.
   */
  async handleFilePushedBatch(events: readonly PushedFileEvent[]): Promise<void> {
    // One apply per file: two notifications for one chain both decide from its latest
    // head, so the earlier one has nothing to add.
    const latest = new Map<string, PushedFileEvent>();
    for (const event of events) {
      if (this.selfEvents.consumePushedVersion(event.versionId)) continue;
      latest.set(event.fileId, event);
    }
    const pending = [...latest.values()];

    try {
      for (let start = 0; start < pending.length; start += MAX_PULL_BATCH_FILES) {
        const chunk = pending.slice(start, start + MAX_PULL_BATCH_FILES);
        const response = await this.withRateLimitWaits(() =>
          this.opts.api.pull(
            this.opts.vaultId,
            chunk.map((event) => event.fileId),
          ),
        );
        const chains = new Map(response.files.map((file) => [file.fileId, file.versions]));

        // The apply touches up to two paths: the head's recorded path and the path this
        // device already holds the chain at (a rename being applied). Compute both before
        // running anything; if any path repeats inside the chunk, the whole chunk applies
        // in order, one file at a time. That is the conservative version of the path queue:
        // a peer's move can leave two chains naming one path for a moment, and the two
        // decisions must not interleave. With no shared path, four files at a time.
        //
        // A single event's two names are deduplicated first: for a file this device
        // tracks, the head's path and the state's path are the same string, and counting
        // it twice made every tracked-file burst — every delete, every edit — look like a
        // shared path and fall back to the serial apply.
        const seenPaths = new Set<string>();
        const applyPaths = new Map<string, string | null>();
        let sharesPath = false;
        for (const event of chunk) {
          const head = remoteHead(chains.get(event.fileId) ?? []);
          const headPath = head ? await this.decryptPath(head) : null;
          // The path the apply will decide on (`applyPushedChainLocked` prefers the state's
          // own path over the head's), kept for the read-ahead: a chain outside this
          // device's scope is never applied, and the prefetch must not read it either.
          applyPaths.set(event.fileId, this.state[event.fileId]?.plainPath ?? headPath);
          for (const path of new Set([headPath, this.state[event.fileId]?.plainPath ?? null])) {
            if (path === null) continue;
            if (seenPaths.has(path)) sharesPath = true;
            seenPaths.add(path);
          }
        }

        // The burst's read-ahead starts before the first file is applied: the apply loop
        // runs four at a time, and these are the bytes all of them are about to pull.
        this.prefetchPushedChains(chains, applyPaths);

        const failures: unknown[] = [];
        const applyOne = async (event: PushedFileEvent): Promise<void> => {
          await this.applyPushedChain(
            event.fileId,
            event.versionId,
            event.deviceName ?? null,
            chains.get(event.fileId) ?? [],
          );
        };
        if (sharesPath) {
          for (const event of chunk) {
            try {
              await applyOne(event);
            } catch (err) {
              failures.push(err);
            }
          }
        } else {
          const pool = new WorkPool(this.passLimits);
          await Promise.all(
            chunk.map(async (event) => {
              const head = remoteHead(chains.get(event.fileId) ?? []);
              const weight = weightForSize(this.passLimits, head ? head.sizeBytes : null);
              try {
                await pool.run(weight, () => applyOne(event));
              } catch (err) {
                failures.push(err);
              }
            }),
          );
        }
        // One state write for the batch. Persisting per file rewrote the whole
        // (megabyte-scale) state once per file, which was most of a live pull's cost.
        this.persist();
        if (failures.length > 0) throw failures[0];
      }
    } finally {
      // The burst is over, however it ended: what is left of its read-ahead is a guess the
      // apply loop did not pull, so release it — otherwise it keeps the room the next pass
      // or burst needs. A failed chunk throws above, and this still runs.
      this.prefetcher?.dropSpeculative("burst");
    }
  }

  /** Apply one notification from the chain its batch already fetched. */
  private async applyPushedChain(
    fileId: string,
    versionId: string,
    deviceName: string | null,
    chain: VersionChainEntry[],
  ): Promise<void> {
    const head = remoteHead(chain);
    if (!head) return;
    // The paths this apply may touch, read before it queues: the path this device holds
    // the chain at, and the path the pushed version records (a peer's move). The job
    // starts after the jobs already queued for them, so the apply is one turn.
    const headPath = await this.decryptPath(head);
    // Read the state after the decrypt: the claim must be the paths the job will touch,
    // and the state may have moved while the head was being decrypted.
    const statePath = this.state[fileId]?.plainPath ?? null;
    const paths = [statePath, headPath].filter((path): path is string => path !== null);
    return this.schedule(paths, () =>
      this.applyPushedChainLocked(fileId, versionId, deviceName, chain),
    );
  }

  /** The work of {@link applyPushedChain}, running inside its path job. */
  private async applyPushedChainLocked(
    fileId: string,
    versionId: string,
    deviceName: string | null,
    chain: VersionChainEntry[],
  ): Promise<void> {
    const head = remoteHead(chain);
    if (!head) return;
    // The notification names the client that pushed `versionId`. A newer head may have
    // arrived in the meantime, so the label only belongs to this event when it is the
    // head this device is about to apply.
    const peerName = head.versionId === versionId ? deviceName : null;

    // A file this client has never seen: take its path from the pushed version
    // so a note created on another device arrives without a full reconcile.
    let plainPath: string | null = this.state[fileId]?.plainPath ?? null;
    if (!plainPath) {
      plainPath = await this.decryptPath(head);
      if (!plainPath) return;
    }
    // A push for a path this device does not sync (a peer's settings file while
    // the switch is off) is dropped here, before anything is remembered or written.
    if (!this.isSyncable(plainPath)) {
      // A version this device already holds is not a new decision; see the same guard in
      // `reconcile`, where a switch turned off after a sync must not rewrite history.
      if (!this.versionAlreadyApplied(fileId, head.versionId)) {
        this.activity.reportActivity({
          direction: "in",
          outcome: "skipped",
          fileId,
          versionId: head.versionId,
          plainPath,
          action: head.action,
          sizeBytes: head.sizeBytes,
          deviceName: peerName,
          reason: outOfScopeReason(plainPath, this.scope, head.sizeBytes) ?? "fileType",
        });
      }
      return;
    }

    // Keep the remote identity index fresh: the vault event for this path (should the
    // adapter fire one) must recognise it as this fileId, not as a new file. A
    // **tombstone** records no live path, so it is deliberately left out — the index
    // answers "which chain lives here", and a chain this notification is about to
    // delete does not live here any more. Remembering it would make the next local
    // file at that path adopt a dead identity and become a conflict with the deletion.
    if (head.action !== "delete") this.remoteIndex.remember(fileId, head, plainPath);

    // What this device holds for that path. The stamp answers two questions at once —
    // is the file there at all, and has it changed since the hash the state recorded —
    // so a notification about a file this device has not touched costs one `stat`
    // instead of reading (and hashing) the whole file, which for an attachment is the
    // entire cost of the notification.
    const stamp = await this.opts.adapter.statFile(plainPath);
    const cached = stamp === null ? null : this.cachedHashFor(plainPath, stamp);
    const localBytes =
      cached === null && stamp !== null ? await this.opts.adapter.readFile(plainPath) : null;
    const localExists = stamp !== null && (cached !== null || localBytes !== null);
    const localContentHash = cached ?? (localBytes ? await sha256Hex(localBytes) : null);
    // …unless the head records a path this vault already holds a file at: that is a
    // peer's move the vault applied before the notification (or a move whose
    // notification was dropped), and following it is a pull. A sync point that is
    // itself a `delete` means the absence is already on the chain, so a newer live
    // head is a peer restoring the file — also a pull.
    const entry = this.state[fileId];
    const headPath = await this.decryptPath(head);
    const headPathHasLocalFile =
      headPath !== null &&
      headPath !== plainPath &&
      (await this.opts.adapter.statFile(headPath)) !== null;
    const decision = decideFile(
      decideInputFrom({
        entry,
        localExists,
        localContentHash,
        remoteChain: chain,
        // A pushed notification is never a bind: a tombstone on it applies the
        // deletion (a local file the user still owns reaches the server again on
        // the next bind, or as a conflict when it diverged).
        tombstone: "apply-remote-delete",
        headPathHasLocalFile,
        emptyHash: await this.emptyContentHash(),
      }),
    );

    if (decision.action === "pull") {
      // A notification whose content cannot be read is not a no-op: the file
      // never arrives and — unlike a pass, which retries in five minutes with
      // nothing else to do — this was the only thing that would have pulled it
      // now. Fail so the host says so (the same "a dropped event is never lost
      // without a trace" rule the push side follows).
      const applied = await this.pullRemote(fileId, plainPath, head, localContentHash, peerName);
      if (!applied) {
        throw new Error(`Could not read the content of ${plainPath} (${head.contentHash})`);
      }
    } else if (decision.action === "conflict") {
      // A notification is a reconcile in miniature: it resolves the conflict the same way
      // (remote wins, local content parked), not merely records it. And, exactly like the
      // pull above, a resolution that could not be carried out is not a no-op — this was the
      // only thing that would have applied it now, and the user must not be told a conflict
      // was resolved when the note still holds their text.
      const applied = await this.conflicts.resolve(
        fileId,
        plainPath,
        head,
        localBytes !== null,
        peerName,
      );
      if (!applied) {
        throw new Error(`Could not apply the conflict for ${plainPath} (${head.contentHash})`);
      }
    } else if (
      decision.action === "synced" &&
      head.action !== "delete" &&
      this.state[fileId]?.lastKnownVersionId !== head.versionId
    ) {
      // The head holds the bytes on disk while this device's sync point is behind it — a
      // push whose response this notification outraced. Record the head instead of leaving
      // the gap that would make the next edit conflict with our own version.
      this.adoptRemoteIdentity(fileId, plainPath, head, stamp);
    }
  }

  // ── Internals ──

  /**
   * The live remote chain whose head content matches `hash`, whose previous path
   * no longer holds a local file, and which is held by exactly one chain.
   *
   * This is the identity net for a local file at a path no remote chain records:
   * when a rename notification is lost, the old chain is all the server has, and
   * creating a second chain for the same content is what left both an old and a
   * new file on disk.
   *
   * Two restrictions keep it from merging unrelated files that merely share
   * content: the chain's previous path must be gone locally (a move, not a second
   * live copy of the same bytes), and the lookup is a single map hit — an
   * ambiguous case creates a new chain rather than adopting the wrong identity.
   */
  private findRemoteFileIdByContent(
    hash: string,
    localPaths: Set<string>,
  ): { fileId: string; head: VersionChainEntry } | null {
    const fileId = this.remoteIndex.fileIdForHash(hash);
    if (!fileId) return null;
    const head = this.remoteIndex.headOf(fileId);
    if (!head || head.contentHash !== hash) return null;
    // A `delete` version's hash is the hash of an **empty string**, not an identity:
    // adopting it would make an empty note written at a deleted path a conflict with
    // that deletion (and park a copy of it) instead of a file of its own.
    if (head.action === "delete") return null;
    const previousPath = this.state[fileId]?.plainPath;
    if (previousPath && localPaths.has(previousPath)) return null;
    return { fileId, head };
  }

  private async pullChain(fileId: string): Promise<VersionChainEntry[]> {
    const res = await this.withRateLimitWaits(() =>
      this.opts.api.pull(this.opts.vaultId, [fileId]),
    );
    return res.files.find((f) => f.fileId === fileId)?.versions ?? [];
  }
}

// Re-exported for host code that reads version chains directly.
export type { VersionChainEntry };
