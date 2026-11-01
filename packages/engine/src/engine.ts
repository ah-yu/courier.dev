import type { SyncAction, SyncPushResponse, VersionChainEntry } from "@courier/shared";
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
import type { Platform } from "./platform";
import { generateFileId, generateVersionId } from "./ids";
import { isConflictFile, conflictFilePath } from "./conflict-file";
import {
  isConfigPath,
  isSyncablePath,
  normalizeScope,
  outOfScopeReason,
  settingsGroupOf,
  syncsAnySettings,
  withinFileSizeCap,
  type SettingsGroup,
  type SyncOutOfScopeReason,
  type SyncScope,
  type SyncScopeInput,
} from "./sync-scope";
import type { LocalVersionState } from "./state";
import {
  decideFile,
  decideInputFrom,
  remoteHead,
  type DecideContext,
  type TombstoneHandling,
} from "./decide";
import { SelfEventLog } from "./self-events";
import { RemoteIndex } from "./remote-index";
import { normalizePriorityPaths, orderByPriority, priorityRanks } from "./priority";
import {
  DEFAULT_OP_QUEUE_LIMITS,
  weightForSize,
  type OpQueueLimits,
  type OpWeight,
} from "./op-queue";
import { WorkPool } from "./work-pool";
import { PathClaims } from "./path-claims";
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
 * to the app (see `handleConflict`).
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
  /** Called whenever synced state changes so hosts can persist it. */
  onSaveState?: (json: string) => void;
  /**
   * How far the current pass has got (see {@link SyncProgress}).
   *
   * Reported at coarse steps — every {@link PROGRESS_STEP_FILES} settled files, plus one
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
  /**
   * Local files the pass did **not** hash, because no chain can claim them: a file with
   * no state entry and no remote chain can only be a `create`, and the only thing that
   * needs its hash is the create itself — which reads it once
   * (see `createUntrackedFiles`). Keeping them out of {@link localHashes} is what stops
   * a first bind from reading every file twice.
   */
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
  /** The wire entry, with `content` filled in when the request is built. */
  file: PushFile;
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
 * How long the excluded folders' file listing is reused.
 *
 * The listing exists only to recognise a file that was moved into an excluded folder
 * without a rename event (see `findExcludedMoveCandidate`), and it is consulted before
 * a deletion is published. A burst — a folder removed, or a daemon flushing one batch
 * of events — would otherwise walk the excluded folders once per file; a few seconds of
 * staleness can only make the engine miss a just-created candidate, which falls back to
 * the normal deletion path.
 */
const EXCLUDED_LISTING_TTL_MS = 30_000;

/**
 * How many settled files a pass may go through before it reports progress again.
 *
 * A bind's counter has to move often enough to look alive and rarely enough not to make a
 * host repaint for every note: 25 files is a visible step on any vault, and a 10 000-file
 * bind reports ~400 times instead of 10 000.
 */
const PROGRESS_STEP_FILES = 25;

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
   * Paths an incremental event is handling right now (path → nesting depth).
   *
   * A reconcile decides from the snapshot it took when it started — the vault
   * listing, the hashes of that moment, the chains as they were — and the vault
   * keeps firing events while it runs. Both would then act on the same path, the
   * reconcile from stale bytes: at best a duplicate `modify`/`rename`/`delete`
   * version, at worst a pull overwriting an edit that landed after the snapshot.
   * The reconcile therefore **skips** a path an event is already handling; the
   * event brings that file to the right state on its own, and the next pass picks
   * up whatever it left behind.
   *
   * Deliberately not a lock: nothing ever waits on it. A host whose adapter awaits
   * the vault event its own write fires (the tests' `FakeAdapter` does) cannot
   * deadlock, because the skipped side never blocks on the other.
   */
  private inFlightPaths = new Map<string, number>();
  /** Tombstone rule for the reconcile currently running (see `TombstoneHandling`). */
  private tombstoneMerge: TombstoneHandling = "apply-remote-delete";
  /** True during the single pass that binds the vault (see {@link initialSync}). */
  private firstBind = false;
  private initialized = false;
  /** Paths reported through `onFileTooLarge` in the current pass (one event each). */
  private tooLargeReported = new Set<string>();
  /** Paths reported through `onFileSkipped` in the current pass (one event each). */
  private skippedReported = new Set<string>();
  /** `sha256("")` — the hash a `delete` version carries. Computed once, lazily. */
  private emptyHash: string | null = null;
  /** Single-flight marker for {@link syncLocalSettings}. */
  private settingsPollRunning = false;
  /** Files the current pass has settled, and how many it has taken on (see `SyncProgress`). */
  private progressDone = 0;
  private progressTotal = 0;
  /** The `done` value the last `onProgress` call reported, so steps are coarse. */
  private progressEmitted = 0;
  /**
   * The files under this device's excluded folders, grouped by file name, with the
   * moment the listing was taken. See {@link findExcludedMoveCandidate}.
   */
  private excludedFiles: { readonly at: number; readonly byName: Map<string, string[]> } | null =
    null;

  /** Which paths this device syncs (see `SyncScope`). */
  private readonly scope: SyncScope;
  /** How many per-file operations one pass may run at once (see `WorkPool`). */
  private readonly passLimits: OpQueueLimits;

  constructor(private opts: EngineOptions) {
    this.scope = normalizeScope(opts.syncScope);
    this.passLimits = opts.opLimits ?? DEFAULT_OP_QUEUE_LIMITS;
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
    this.reportTooLarge(path, stamp.sizeBytes);
    this.reportActivity({
      direction: "out",
      outcome: "skipped",
      fileId: this.pathToFileId.get(path) ?? null,
      versionId: null,
      plainPath: path,
      action: null,
      sizeBytes: stamp.sizeBytes,
      deviceName: null,
      reason: "size",
    });
    return false;
  }

  private reportTooLarge(plainPath: string, sizeBytes: number): void {
    if (this.tooLargeReported.has(plainPath)) return;
    this.tooLargeReported.add(plainPath);
    this.opts.onFileTooLarge?.({ plainPath, sizeBytes });
  }

  /**
   * Tell the host one decision this device made (see {@link SyncActivityEvent}).
   *
   * Deliberately isolated: the activity feed is a UI convenience, so a host listener
   * that throws must never fail the sync pass that reported it.
   */
  private reportActivity(event: SyncActivityEvent): void {
    try {
      this.opts.onSyncActivity?.(event);
    } catch (err) {
      console.error("Courier: a sync-activity listener failed:", err);
    }
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

  /** Report a file this pass left out for a reason that is not its size (once per pass). */
  private reportSkipped(plainPath: string, reason: FileSkippedEvent["reason"]): void {
    if (this.skippedReported.has(plainPath)) return;
    this.skippedReported.add(plainPath);
    this.opts.onFileSkipped?.({ plainPath, reason });
  }

  /**
   * Report a settings file this device just applied from the remote.
   *
   * Deliberately not "once per pass": each application is a separate change to a file
   * the running app has already read, so the host needs one event per file — it is the
   * host's own burst notifier that turns a folderful of them into one line.
   */
  private reportSettingsApplied(plainPath: string, action: SettingsAppliedEvent["action"]): void {
    // Ownership is the guard, not "is inside the config folder": it answers null for a
    // path nothing may sync (`workspace.json`, `cache/**`, this plugin's own folder), and
    // it gives the host the group it needs to judge the change without knowing the rule.
    const group = settingsGroupOf(plainPath, this.scope);
    if (group === null) return;
    this.opts.onSettingsApplied?.({ plainPath, action, group });
  }

  /** Start a pass: one `onFileTooLarge`/`onFileSkipped` per path per pass, and fresh skip sets. */
  private beginPass(): void {
    this.tooLargeReported.clear();
    this.skippedReported.clear();
  }

  // ── Progress (see `SyncProgress`) ──

  /** Begin reporting a pass that already knows `total` files, and report it. */
  private beginProgress(total: number): void {
    this.progressDone = 0;
    this.progressTotal = total;
    this.progressEmitted = 0;
    this.reportProgress(true);
  }

  /** Take on `count` more files — a create the pass discovered as it walked the vault. */
  private addProgressTotal(count: number): void {
    this.progressTotal += count;
  }

  /** Mark `count` files settled, and report once enough has moved. */
  private advanceProgress(count = 1): void {
    this.progressDone += count;
    this.reportProgress(false);
  }

  /**
   * Report progress, if this pass has anything to report and a step has passed.
   *
   * `force` is for the beginning and the end of a pass: the first tells a host the total,
   * the last tells it the pass is over (`done === total`), which is what a status bar
   * needs to stop showing a counter. A listener that throws is ignored — progress is a
   * courtesy, and a UI bug must not fail the sync that reported it.
   */
  private reportProgress(force: boolean): void {
    const listener = this.opts.onProgress;
    if (!listener) return;
    if (this.progressTotal === 0 && this.progressDone === 0) return;
    if (!force && this.progressDone - this.progressEmitted < PROGRESS_STEP_FILES) return;
    this.progressEmitted = this.progressDone;
    try {
      listener({ done: this.progressDone, total: this.progressTotal });
    } catch {
      // A host callback is not allowed to fail the pass.
    }
  }

  /**
   * `sha256("")` — the content hash a `delete` version carries.
   *
   * A decision needs it to tell "this device's sync point is a tombstone" from "this
   * device last agreed on content", and hashing an empty string per file per pass was
   * a Web Crypto call for a constant.
   */
  private async emptyContentHash(): Promise<string> {
    return (this.emptyHash ??= await sha256Text(""));
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
    // Marked before the target is inspected, not just before the write: the check
    // and the write have to agree, and a reconcile deciding for this path in
    // between would invalidate the "free" the check just returned.
    const release = this.beginLocalOp(target);
    try {
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
      await this.opts.adapter.writeFile(target, bytes);
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
    } finally {
      release();
    }
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
  private async consumeSelfWrite(path: string, bytes: Uint8Array): Promise<boolean> {
    if (!this.selfEvents.hasSelfWrite(path)) return false;
    return this.selfEvents.consumeSelfWrite(path, await sha256Hex(bytes));
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
   * Mark `path` as being handled by an incremental event, and return the release.
   * See {@link inFlightPaths} for why the reconcile skips such paths instead of
   * waiting for them.
   */
  private beginLocalOp(path: string): () => void {
    this.inFlightPaths.set(path, (this.inFlightPaths.get(path) ?? 0) + 1);
    return () => {
      const remaining = (this.inFlightPaths.get(path) ?? 1) - 1;
      if (remaining > 0) this.inFlightPaths.set(path, remaining);
      else this.inFlightPaths.delete(path);
    };
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
    if (entry.stamp.sizeBytes !== stamp.sizeBytes || entry.stamp.mtimeMs !== stamp.mtimeMs) {
      return null;
    }
    return entry.lastKnownContentHash;
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
    if (current.sizeBytes !== snapshot.sizeBytes || current.mtimeMs !== snapshot.mtimeMs) {
      return null;
    }
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
    const { fileId, plainPath } = request;
    const prepared = await this.preparePush(request);
    // A path the API cannot carry: reported by `preparePush`, and nothing to send.
    if (!prepared) return;

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
    if (result?.status === "content_missing" && prepared.reusesStoredContent) {
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
    if (result?.status === "stale_base") {
      this.forgetPushedVersion(prepared);
      const chain = await this.pullChain(fileId);
      const head = remoteHead(chain);
      // The head already holds the bytes this push was carrying: either this exact
      // push was applied and only its response was lost, or a peer converged on the
      // same content. Nothing to write — take the head as the sync point.
      if (head && head.contentHash === prepared.contentHash) {
        this.adoptRemoteIdentity(fileId, plainPath, head);
        // The head is this very version (the server stores the client's versionId), so
        // the push did land and only its response was lost. A peer that merely converged
        // on the same bytes has a different versionId and is not reported as this
        // device's upload.
        if (head.versionId === prepared.versionId) {
          this.reportActivity({
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
    if (result?.status !== "ok") {
      this.forgetPushedVersion(prepared);
      throw new Error(`Push failed for ${plainPath}: ${result?.error ?? "unknown error"}`);
    }

    this.applyPushedVersion(prepared);
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
      this.reportSkipped(plainPath, "path-too-long");
      this.reportActivity({
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
      file: {
        fileId,
        encryptedPath,
        action,
        versionId,
        contentHash,
        sizeBytes,
        mtimeMs,
        baseVersionId,
        content: null,
      },
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
      if (result?.status !== "ok") {
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
    const file: PushFile = {
      ...prepared.file,
      content,
      ...(contentChunks > 0 ? { contentChunks } : {}),
    };
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
    this.pathToFileId.set(plainPath, fileId);
    this.reportActivity({
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
   * host starting up. On that one pass a local file the server has no live version
   * of is the user's own, so it is pushed as a new file instead of being deleted
   * by the connection (and the tombstone is left out of the comparison entirely).
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
    this.firstBind = options.firstBind === true;
    this.tombstoneMerge = this.firstBind ? "bind-merge" : "apply-remote-delete";
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
   * A file an event is already handling is skipped by `handleLocalChange`'s own
   * in-flight marker, and a listing that lags a write cannot become a deletion here
   * either: the tombstone branch re-reads the file first.
   */
  async syncLocalSettings(): Promise<void> {
    // Nothing to do when no config-folder group is on — and, importantly, nothing
    // to spend on a listing either.
    if (!this.initialized) return;
    if (!syncsAnySettings(this.scope)) return;
    // A poll that overlaps a previous one would read the same bytes twice and push
    // twice; against a reconcile it is harmless (the in-flight markers cover that).
    if (this.settingsPollRunning) return;
    this.settingsPollRunning = true;
    this.beginPass();
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
          // Same rule as the reconcile scan: a file that is exactly at its sync point has
          // nothing to send, so an over-cap settings file is not reported twice a minute
          // for being in sync. Only a local change this device cannot push is worth the
          // notice.
          if (this.cachedHashFor(path, stamp) === null) {
            this.reportTooLarge(path, stamp.sizeBytes);
            this.reportActivity({
              direction: "out",
              outcome: "skipped",
              fileId: this.pathToFileId.get(path) ?? null,
              versionId: null,
              plainPath: path,
              action: null,
              sizeBytes: stamp.sizeBytes,
              deviceName: null,
              reason: "size",
            });
          }
          continue;
        }
        const cached = this.cachedHashFor(path, stamp);
        const bytes = cached === null ? await this.opts.adapter.readFile(path) : null;
        const hash = cached ?? (bytes ? await sha256Hex(bytes) : null);
        // The listing says the file exists; a read failure is a race, not a change.
        if (!hash) continue;
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
    this.beginPass();
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
    // that no longer exists, which is wrong in both modes: a bind pushes it as a
    // new file, a running client applies the deletion.
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

    // On the bind pass, a chain the server deleted is not a history point to merge
    // against at all: the tombstone is dropped from the comparison, so a local file
    // still occupying its path is "untracked" and the new-file branch below gives it
    // a fresh fileId. (Its own state entry is dropped with it, or the retired
    // fileId would still be iterated over from the snapshot below.)
    if (this.firstBind) {
      let retired = false;
      for (const fileId of Object.keys(this.state)) {
        // Only chains the server knows and that end in a delete — a fileId we hold
        // with no server chain at all is a local file still waiting to be pushed.
        if (liveFileIds.has(fileId) || !chainByFileId.has(fileId)) continue;
        const { plainPath } = this.state[fileId];
        delete this.state[fileId];
        this.pathToFileId.delete(plainPath);
        retired = true;
      }
      if (retired) this.persist();
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
    const localHashes = new Map<string, string>();
    const localStamps = new Map<string, FileStamp>();
    const skippedPaths = new Set<string>();
    const overCapPaths = new Set<string>();
    const untrackedPaths: string[] = [];
    await this.scanLocalFiles(
      visiblePaths,
      localHashes,
      localStamps,
      skippedPaths,
      overCapPaths,
      untrackedPaths,
    );

    // A move made without an event is found by content (`repairMovedFile`), which needs
    // the hashes the scan skipped. That is only worth paying for when a tracked file has
    // actually gone missing: on a first bind there is no such file, and on an ordinary
    // pass every syncable file is tracked.
    if (untrackedPaths.length > 0 && this.anyTrackedPathUnhashed(localHashes, skippedPaths)) {
      const pool = new WorkPool(this.passLimits);
      await Promise.all(
        untrackedPaths.map((p) =>
          pool.run("small", async () => {
            const bytes = await adapter.readFile(p);
            if (!bytes) return;
            const hash = await sha256Hex(bytes);
            localHashes.set(p, hash);
            this.rememberStamp(p, localStamps.get(p) ?? null);
          }),
        ),
      );
      untrackedPaths.length = 0;
    }

    // Re-point the chains whose file was moved locally without an event reaching
    // the engine, so neither the tombstone branch nor the untracked branch below
    // mistakes a move for "deleted here, created there".
    for (const [fileId, entry] of Object.entries(this.state)) {
      await this.repairMovedFile(fileId, entry, localHashes, liveFileIds, this.remoteIndex);
    }

    // Every fileId we know about (so a tombstone we already synced stays synced),
    // plus every live chain the server knows. A tombstone is skipped on the bind
    // pass, because merging against it is exactly what that pass does not do.
    const allFileIds = new Set<string>([
      ...Object.keys(this.state).filter(
        (fileId) => !(this.firstBind && chainByFileId.has(fileId) && !liveFileIds.has(fileId)),
      ),
      ...this.remoteIndex.fileIds(),
    ]);

    const failure = await this.reconcileLoop({
      fileIds: allFileIds,
      localHashes,
      untrackedPaths,
      chainByFileId,
      remote: this.remoteIndex,
      skippedPaths,
      overCapPaths,
      localStamps,
      priority,
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
   * ordering is the user's paths first (see `orderFileIds`), not the server's answer
   * order. Two different chains can still name one path while a peer's move is in flight,
   * so the tasks that may write the same path take turns through {@link PathClaims};
   * everything else runs concurrently.
   *
   * Its whole snapshot arrives as one {@link ReconcilePass}: seven positional arguments
   * of four different container types was a call nobody could read (or get right).
   */
  private async reconcileLoop(pass: ReconcilePass): Promise<unknown> {
    // The set answers "which files does this pass consider"; the array is what gives
    // the user's own files a head start (see `orderFileIds`).
    const ordered = this.orderFileIds([...pass.fileIds], pass);
    // Progress starts from the chains this pass already knows about; the creates add
    // themselves as the vault is walked (see `createUntrackedFiles`).
    this.beginProgress(ordered.length);
    const pool = new WorkPool(this.passLimits);
    // Two chains can name one path while a peer's move is in flight; the tasks that
    // may write the same path take turns (see `PathClaims`). Everything else still
    // runs concurrently.
    const claims = new PathClaims();
    let firstFailure: unknown = null;

    // Every task is a different fileId, so the state mutations they make are disjoint;
    // the pool only decides how many may be in flight, and runs a large file alone.
    // Paths, unlike fileIds, are not disjoint for a moment after a peer's move — which
    // is what the claims serialise.
    await Promise.all(
      ordered.map((fileId) =>
        pool.run(this.weightForFile(fileId, pass), async () => {
          const claim = this.resolvePaths(fileId, pass).claimed;
          await claims.acquire(claim);
          try {
            const failure = await this.reconcileOne(fileId, pass);
            if (failure !== null) firstFailure ??= failure;
          } catch (err) {
            // An unexpected failure (an adapter that cannot read a path, say) is
            // collected like a refused push: the other files are already in flight and
            // the pass still has work worth finishing. The caller raises it once every
            // task has settled.
            firstFailure ??= err;
          } finally {
            claims.release(claim);
            this.advanceProgress();
          }
        }),
      ),
    );

    // Untracked local files (no fileId anywhere) → create on the server. Its own batch
    // failures are collected inside it, for the same reason the push sites above are.
    const batchFailure = await this.createUntrackedFiles(
      pass.localHashes,
      pass.untrackedPaths,
      pass.remote,
      pass.localStamps,
      pass.priority,
    );
    // The pass is over: report the final pair, whose `done === total` tells a host to stop
    // showing a counter (a create that a limiter left unsent was counted and dropped).
    this.reportProgress(true);
    return firstFailure ?? batchFailure;
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
   * cap, is recorded in `skippedPaths` and left exactly as it is. An over-cap path is
   * also recorded in `overCapPaths`, because the pass still has to *receive* a newer
   * version for it (see `applyOverCapRemote`).
   */
  private async scanLocalFiles(
    visiblePaths: readonly string[],
    localHashes: Map<string, string>,
    localStamps: Map<string, FileStamp>,
    skippedPaths: Set<string>,
    overCapPaths: Set<string>,
    untrackedPaths: string[],
  ): Promise<void> {
    // Small files read and hash concurrently, through the same pool the per-file half of
    // a pass uses: the loop used to await one file at a time, which on a 10 000-file
    // first bind is 10 000 serial read/hash pairs.
    const pool = new WorkPool(this.passLimits);
    await Promise.all(
      visiblePaths.map((path) =>
        pool.run("small", () =>
          this.scanLocalFile(
            path,
            localHashes,
            localStamps,
            skippedPaths,
            overCapPaths,
            untrackedPaths,
          ),
        ),
      ),
    );
  }

  private async scanLocalFile(
    path: string,
    localHashes: Map<string, string>,
    localStamps: Map<string, FileStamp>,
    skippedPaths: Set<string>,
    overCapPaths: Set<string>,
    untrackedPaths: string[],
  ): Promise<void> {
    const stamp = await this.opts.adapter.statFile(path);
    if (stamp === null) {
      skippedPaths.add(path);
      return;
    }
    if (!withinFileSizeCap(this.scope, stamp.sizeBytes)) {
      skippedPaths.add(path);
      // Over the **upload** cap: the pass must not push it, but it still has to take a
      // peer's newer version (`applyOverCapRemote`).
      overCapPaths.add(path);
      // A file over the cap that is exactly at its sync point has nothing to send: it
      // arrived from a peer (the cap bounds uploads, never downloads) or was synced under
      // a higher cap before the administrator lowered it. Reporting it would nag, every
      // pass, about a file that is perfectly in sync; only a local change this device
      // cannot push is worth the notice.
      if (this.cachedHashFor(path, stamp) === null) {
        this.reportTooLarge(path, stamp.sizeBytes);
        this.reportActivity({
          direction: "out",
          outcome: "skipped",
          fileId: this.pathToFileId.get(path) ?? null,
          versionId: null,
          plainPath: path,
          action: null,
          sizeBytes: stamp.sizeBytes,
          deviceName: null,
          reason: "size",
        });
      }
      return;
    }
    // The stamp is kept for every statable file, not only the hashed ones: it orders the
    // create work (recently edited first) and it is what `createUntrackedFiles` re-checks
    // before reusing a hash.
    localStamps.set(path, stamp);
    const cached = this.cachedHashFor(path, stamp);
    if (cached !== null) {
      // The hash was recorded at exactly this stamp (`cachedHashFor` checked it), so it
      // is the one those bytes were hashed at — the adoption path below may trust it.
      localHashes.set(path, cached);
      return;
    }
    if (!this.pathToFileId.has(path) && this.remoteIndex.fileIdAt(path) === null) {
      untrackedPaths.push(path);
      return;
    }
    const bytes = await this.opts.adapter.readFile(path);
    if (!bytes) return;
    const hash = await sha256Hex(bytes);
    localHashes.set(path, hash);
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
  private anyTrackedPathUnhashed(
    localHashes: Map<string, string>,
    skippedPaths: Set<string>,
  ): boolean {
    for (const entry of Object.values(this.state)) {
      const path = entry.plainPath;
      if (!this.isSyncable(path)) continue;
      if (skippedPaths.has(path)) continue;
      if (!localHashes.has(path)) return true;
    }
    return false;
  }

  /**
   * One file of a pass.
   *
   * Split out of `reconcileLoop` so the per-file work can run through a `WorkPool`: the
   * decisions inside are per-fileId and the state it mutates is keyed by fileId/path, so
   * several of these can run together. Its caller serialises the ones whose paths
   * overlap ({@link PathClaims}). A failure is **returned** rather than thrown — the
   * pool's caller collects the first one and the rest of the pass still runs, exactly as
   * the serial loop did.
   */
  private async reconcileOne(fileId: string, pass: ReconcilePass): Promise<unknown> {
    const { localHashes, chainByFileId } = pass;
    const { skippedPaths, localStamps } = pass;
    const { adapter } = this.opts;
    let failure: unknown = null;

    const chain = chainByFileId.get(fileId) ?? [];
    const head = remoteHead(chain);
    const entry = this.state[fileId];
    // The path the chain's head records, which can differ from the one this
    // device has the file at — see the `synced` branch below. A chain the server
    // holds no path for falls back to whatever this device knows, which is also
    // what keeps the comparison below from firing on a missing path.
    const { plainPath, recordedPath } = this.resolvePaths(fileId, pass);

    // A chain this device does not sync — settings files while the switch is
    // off, or a hard-excluded path — is left completely alone: not pulled, not
    // deleted, not turned into a conflict. Its state entry (if any) is kept, so
    // switching the sync scope on later resumes from where it stopped.
    // A tracked chain whose local file moved out of scope is parked: the chain may still
    // be in the remote index, but this device is not syncing the local path. No activity
    // row is emitted — the index loop reports a chain whose *remote* path is out of scope,
    // and this local-only move is remembered by the state rather than by the log.
    if (plainPath && !this.isSyncable(plainPath)) return null;

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

    // An event that started while this pass was working owns the file now; the
    // event itself brings it to the right state (see `inFlightPaths`). The head's path
    // counts too: a pull applies (and may write) there when the peer moved the file.
    if (
      (plainPath !== null && this.inFlightPaths.has(plainPath)) ||
      (recordedPath !== null && this.inFlightPaths.has(recordedPath))
    ) {
      return null;
    }

    switch (decision.action) {
      case "synced": {
        // Nothing to transfer, but the identity still has to be recorded. That covers
        // two shapes: a file that converges on the content it already had (the common
        // case when binding a vault whose remote holds the same note), and a sync point
        // that is one version behind a head already holding the bytes on disk — the race
        // `decideFile` answers "synced" for. Leaving the state behind would make the
        // next edit conflict with a version this device itself pushed. A tombstone is
        // recorded on the state (so a later file at that path is a recreate) but not in
        // the remote index, which answers "which chain lives here".
        if (head && plainPath && head.action !== "delete") {
          const current = this.state[fileId];
          if ((current?.lastKnownVersionId ?? null) !== head.versionId) {
            // Adopting a head records "the bytes on disk are this version", so the
            // pass has to be sure they still are. It decided from hashes taken when
            // it started, while an incremental event can change and push a file during
            // the same pass — and adopting over that would move the sync point
            // *backwards* under a push that had already succeeded, which turns the
            // next edit into a conflict with this device's own version. Two cheap
            // checks: the file is still at the stamp this pass saw, and the version
            // the state now holds is one this pass's chain contains (a version created
            // during the pass is not). Re-reading `this.state` after the stat closes
            // the last await boundary.
            //
            // A `delete` head is not adopted at all: a tombstone lives at no path, so
            // recording one here would put a dead identity into `pathToFileId` (the
            // recycle bin and the version history would then find a chain for a file
            // that is not there). The state entry that says "this device deleted it"
            // is written where the tombstone is pushed, not by a pass.
            const unchanged = await this.currentStampIfUnchanged(
              plainPath,
              localStamps.get(plainPath),
            );
            if (unchanged) {
              const latest = this.state[fileId]?.lastKnownVersionId ?? null;
              let pointIsKnown =
                latest === null || chain.some((version) => version.versionId === latest);
              let verified: FileStamp | null = unchanged;
              if (!pointIsKnown) {
                // The pass only carries the head (and a tombstone's previous live
                // version), so a sync point several versions back cannot be proven
                // from it. Fetch this one file's chain rather than skipping the
                // adoption: the adoption is what keeps the next edit from conflicting
                // with a version this device itself pushed. The request is rare — it is
                // only reached when a peer's head already holds exactly the bytes on
                // disk while this device's sync point is behind it.
                try {
                  const fetched = await this.pullChain(fileId);
                  const headIndex = fetched.findIndex(
                    (version) => version.versionId === head.versionId,
                  );
                  const latestIndex = fetched.findIndex((version) => version.versionId === latest);
                  // The point has to be at or **before** this pass's head. A version
                  // created by an event during the pass sits after it in the fetched
                  // chain, and adopting the head over that one would move the sync
                  // point backwards under the device's own successful push.
                  pointIsKnown = headIndex >= 0 && latestIndex >= 0 && latestIndex <= headIndex;
                } catch {
                  // The ancestry could not be fetched (offline, or a failed request).
                  // Leaving the state where it is costs at most a conflict the next
                  // pass resolves; moving the sync point on a chain nobody read would
                  // be worse, and failing the file would turn a convergence race into a
                  // failed pass.
                  pointIsKnown = false;
                }
                if (pointIsKnown) {
                  // The fetch was an await, so the bytes this adoption would claim may
                  // have changed, and an event may have pushed a newer version. Re-check
                  // both; the state read happens after the stat with no await between it
                  // and the adoption.
                  verified = await this.currentStampIfUnchanged(
                    plainPath,
                    localStamps.get(plainPath),
                  );
                  pointIsKnown =
                    verified !== null &&
                    (this.state[fileId]?.lastKnownVersionId ?? null) === latest;
                }
              }
              if (pointIsKnown) {
                this.adoptRemoteIdentity(fileId, plainPath, head, verified);
              }
            }
          }
        }
        // A version match is not a path match. Every version records the path it
        // was written at, so a rename this device made while it could not reach
        // the server is still missing from the chain — and no other branch of
        // this pass carries it, because the content and the versionId both agree.
        // Push it here; that is exactly the version an incremental rename pushes.
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
            // Decided from this pass's chain: that head is the base, so a peer
            // that pushed during the pass has its version refused rather than
            // built over.
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
                failure ??= err;
              }
            }
          }
        }
        break;
      }
      case "none":
        break;

      case "push": {
        if (!plainPath) break;
        // A local deletion the server never heard about decides as `push: delete`:
        // the tombstone is pushed while it could not be (offline), or the file was
        // deleted with the app closed. There are no bytes to read for it, so it
        // takes its own branch instead of the content one below.
        if (decision.pushAction === "delete") {
          // Confirm with the adapter rather than trusting the listing: a listing
          // that lags a just-written file must never become a deletion. If the
          // file is there, the next reconcile makes the same call again. A stat is
          // enough — the file's bytes are not part of "is it gone?".
          if (await adapter.statFile(plainPath)) break;
          // A move into a path outside the scope can land while this pass is deciding:
          // the chain now records the new path and nothing was deleted. The pass read
          // `plainPath` from a snapshot that is no longer true, so leave it to the next
          // pass instead of pushing a tombstone for a file the user still owns.
          if (this.state[fileId]?.plainPath !== plainPath) break;
          // The tombstone keeps the moment this device decided on the deletion. When
          // the deletion happened with the app closed nothing recorded it, so it is
          // taken now — the best this pass can say — and remembered for the retries
          // that follow (see `applyLocalDelete`).
          const stateEntry = this.state[fileId];
          const deletedAtMs = stateEntry?.deletedAtMs ?? Date.now();
          if (stateEntry) stateEntry.deletedAtMs = deletedAtMs;
          try {
            await this.pushFile({
              fileId,
              plainPath,
              action: "delete",
              bytes: undefined,
              baseVersionId: head?.versionId ?? null,
              stamp: null,
              mtimeMs: deletedAtMs,
            });
          } catch (err) {
            if (err instanceof SyncPushBaseError) {
              // The tombstone lost a race with a peer's edit: the remote side wins, the
              // peer's version comes back and there is nothing local to park. That is
              // `handleConflict(…, false)`, exactly as the local-delete path resolves it
              // — `decideIncremental` cannot answer here because it returns early when
              // the file is gone, which is this branch's precondition. When the peer's
              // content cannot be read, the refusal stays the pass's failure, so the
              // next pass (the retry) is what reports it.
              const applied = await this.handleConflict(
                fileId,
                plainPath,
                remoteHead(err.chain),
                false,
              );
              if (!applied) failure ??= err;
            } else {
              failure ??= err;
            }
          }
          break;
        }
        if (!localExists) break;
        const read = await this.readWithStamp(plainPath);
        if (!read) break;
        try {
          await this.pushFile({
            fileId,
            plainPath,
            action: decision.pushAction,
            bytes: read.bytes,
            baseVersionId: head?.versionId ?? null,
            stamp: read.stamp,
          });
        } catch (err) {
          // A peer pushed while this pass was running: the decision above was
          // taken from a chain that has moved, so decide again from the chain the
          // server just showed us (which turns "overwrite it" into a conflict).
          if (err instanceof SyncPushBaseError) {
            await this.decideIncremental(fileId, plainPath);
          } else {
            failure ??= err;
          }
        }
        break;
      }

      case "pull": {
        if (!head || !plainPath) break;
        await this.pullRemote(fileId, plainPath, head, localContentHash);
        break;
      }

      case "conflict": {
        // A `false` answer (the remote side could not be applied) is tolerated here for the
        // same reason the `pull` case above tolerates it: a pass is the retry, and the next
        // one decides again from the same bytes.
        await this.handleConflict(fileId, plainPath, head, localExists);
        break;
      }
    }
    return failure;
  }

  /**
   * The order the pass works through its files.
   *
   * Two cheap signals decide it, and both already exist: the host states the paths the
   * user has open (its `getPriorityPaths`), and the state records the stamp of the bytes
   * this device last synced, so the files edited most recently float up even when a host
   * states nothing. A chain is ranked by the **better** of the path the server records
   * and the path the local file has, because those two disagree for exactly as long as a
   * rename is in flight — and in that window the local path is the one on screen.
   *
   * A tracked chain goes before a remote-only one at the same rank (see
   * `PrioritizedEntry.locallyTracked`): while a peer's move is in flight, the chain whose
   * file is on disk has to settle the path before the remote-only chain reads it.
   */
  private orderFileIds(fileIds: readonly string[], pass: ReconcilePass): string[] {
    return orderByPriority(
      fileIds.map((fileId, position) => {
        const { plainPath, recordedPath } = this.resolvePaths(fileId, pass);
        // The local file's **current** stamp is the recency signal for a file the user
        // edits; a remote-only chain has none, so its head's recorded mtime stands in.
        // The file can sit at the recorded path when the vault applied a peer's move
        // before the engine processed it, so look for the stamp on either path.
        const stampPath = this.localStampPath(plainPath, recordedPath, pass);
        const localMtime =
          stampPath === null ? undefined : pass.localStamps.get(stampPath)?.mtimeMs;
        const head = remoteHead(pass.chainByFileId.get(fileId) ?? []);
        return {
          key: fileId,
          paths: [recordedPath, plainPath],
          mtimeMs: localMtime ?? head?.mtimeMs ?? this.state[fileId]?.stamp?.mtimeMs ?? 0,
          locallyTracked: this.state[fileId] !== undefined,
          position,
        };
      }),
      pass.priority,
    );
  }

  /**
   * Where a chain lives on this device and where the server records it.
   *
   * The two disagree for exactly as long as a peer's move is in flight: the server
   * records the new path, while the file — and this device's identity mapping — is still
   * at the old one. `plainPath` is where a task reads and writes; `recordedPath` is what
   * a pull may move the file to. `claimed` is the union, which is what two tasks with an
   * overlapping path claim ({@link PathClaims}).
   */
  private resolvePaths(
    fileId: string,
    pass: ReconcilePass,
  ): { plainPath: string | null; recordedPath: string | null; claimed: string[] } {
    const entry = this.state[fileId];
    const recordedPath = pass.remote.pathOf(fileId) ?? entry?.plainPath ?? null;
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
  private localStampPath(
    plainPath: string | null,
    recordedPath: string | null,
    pass: ReconcilePass,
  ): string | null {
    if (plainPath !== null && pass.localStamps.has(plainPath)) return plainPath;
    if (recordedPath !== null && pass.localStamps.has(recordedPath)) return recordedPath;
    return null;
  }

  /**
   * How much memory one file's operation can hold at once.
   *
   * A pull carries a peer's version; a push/rename carries the local bytes. The larger
   * of the two decides whether the file may share the pool with others, so a bind never
   * holds several large payloads at once — the same rule the host's `OpQueue` applies to
   * event-driven work.
   */
  private weightForFile(fileId: string, pass: ReconcilePass): OpWeight {
    const { plainPath, recordedPath } = this.resolvePaths(fileId, pass);
    const stampPath = this.localStampPath(plainPath, recordedPath, pass);
    const localSize = stampPath === null ? 0 : (pass.localStamps.get(stampPath)?.sizeBytes ?? 0);
    const head = remoteHead(pass.chainByFileId.get(fileId) ?? []);
    return weightForSize(this.passLimits, Math.max(head?.sizeBytes ?? 0, localSize));
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
  private async createUntrackedFiles(
    localHashes: Map<string, string>,
    untrackedPaths: readonly string[],
    remote: RemoteIndex,
    localStamps: Map<string, FileStamp>,
    priority: ReadonlyMap<string, number>,
  ): Promise<unknown> {
    let batch: PreparedPush[] = [];
    let batchBytes = 0;
    let firstFailure: unknown = null;
    let rateLimitedOut = false;

    /** The batch on the wire, if any: the next one is prepared while it flies. */
    let inFlight: Promise<unknown> | null = null;

    /**
     * Send one prepared batch and apply its per-file verdicts.
     *
     * Answers the first refusal, and marks the pass as rate-limited-out when the limiter
     * outlasted its waits. Everything the caller needs to record is recorded here, so the
     * caller can start the request and keep preparing the next batch.
     */
    const sendBatchNow = async (sending: PreparedPush[]): Promise<unknown> => {
      let results;
      try {
        const response = await this.withRateLimitWaits(() =>
          this.opts.api.push(
            this.opts.vaultId,
            sending.map((prepared) => ({ ...prepared.file, content: prepared.content })),
          ),
        );
        results = response.results;
      } catch (err) {
        // The whole request failed: nothing landed, so no echo can arrive for any of
        // these versions and none of them may stay suppressed. The batch is dropped —
        // its files are retried by the next pass — and the failure is answered to the
        // caller while the creates that follow still get their chance.
        for (const prepared of sending) {
          this.forgetPushedVersion(prepared);
          this.dropPendingCreate(prepared);
        }
        // A limiter that outlasted the waits ends the pass: every further batch would
        // be refused too, and the files are better left untracked than half-created.
        if (isRateLimitError(err)) rateLimitedOut = true;
        this.advanceProgress(sending.length);
        return err;
      }

      let failure: unknown = null;
      for (const [index, prepared] of sending.entries()) {
        const result = results[index];
        if (result?.status === "ok") {
          this.applyPushedVersion(prepared);
          this.advanceProgress();
          continue;
        }
        // A refused file is retried by the next pass, through the batched create path:
        // dropping the pending entry is what keeps it from being pushed one request at a
        // time by `reconcileOne` (see `dropPendingCreate`).
        this.forgetPushedVersion(prepared);
        this.dropPendingCreate(prepared);
        this.advanceProgress();
        failure ??= new Error(
          `Push failed for ${prepared.plainPath}: ${result?.error ?? result?.status ?? "no result"}`,
        );
      }
      return failure;
    };

    /**
     * Hand the current batch to the wire **without waiting for it**.
     *
     * Preparing a batch (read, hash, encrypt path and content) is a millisecond per file
     * on its own, so waiting for the previous request before reading the next files left
     * the network idle for half of a bind (measured: ~0.3 s per 100-file batch at 50 000
     * files, of which the server was 0.05 s). The batch being prepared is at most one, so
     * a bind holds at most two batches — one on the wire, one under construction — and a
     * file over the byte bound still travels alone (see the loop).
     */
    const flush = (): void => {
      if (batch.length === 0) return;
      const sending = batch;
      batch = [];
      batchBytes = 0;
      inFlight = sendBatchNow(sending);
    };

    /**
     * Wait for the batch in flight and fold its failure in.
     *
     * Answers whether the pass has to stop. Called at every point where the next thing to
     * send would otherwise overlap something it must not (a chunked upload, a large file,
     * or the next batch's own request), which is where the overlap is capped at one batch.
     */
    const settle = async (): Promise<boolean> => {
      if (inFlight === null) return rateLimitedOut;
      const promise = inFlight;
      inFlight = null;
      // Not `firstFailure ??= await promise`: `??=` skips the `await` itself once an
      // earlier batch failed, orphaning this one — it would still be on the wire when the
      // pass returned, and the next `flush()` would overwrite its slot.
      const failure = await promise;
      if (firstFailure === null) firstFailure = failure;
      return rateLimitedOut;
    };

    // The same order the tracked half used: a note the user just created or opened is
    // created on the server before the rest of a bind. Its stamp is the file's own
    // modification time, the only recency signal an untracked file has.
    //
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

    try {
      for (const path of ordered) {
        if (rateLimitedOut) break;
        if (this.pathToFileId.has(path) || remote.fileIdAt(path) !== null) continue;
        // A brand-new file whose `create` event is still in flight belongs to that
        // event: pushing it here is the second chain this pass must not create.
        if (this.inFlightPaths.has(path)) continue;
        const read = await this.readWithStamp(path);
        if (!read) continue;
        // The pass may already have hashed this file. Reuse that hash only while the bytes
        // just read are the ones it hashed — the same size and mtime — because a file
        // edited between the listing and here must be hashed again, or the version would
        // name content the push does not carry.
        const scannedStamp = localStamps.get(path);
        const knownHash =
          scannedStamp !== undefined &&
          read.stamp !== null &&
          scannedStamp.sizeBytes === read.stamp.sizeBytes &&
          scannedStamp.mtimeMs === read.stamp.mtimeMs
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
        this.addProgressTotal(1);
        // A file above the chunking threshold is staged through the chunk endpoints and
        // named by its push; it never joins a batch (its frame carries no bytes anyway).
        if (prepared.chunkCount > 0) {
          // A chunk upload is its own sequence of requests: let the batch in flight finish
          // first rather than interleaving the two.
          if (await settle()) {
            this.abandonUnsent(prepared);
            break;
          }
          const failure = await this.sendPreparedChunked(prepared);
          firstFailure ??= failure;
          // A chunked create's refusal is a limiter answer too: three more >8 MiB files
          // must not each burn another round of waits.
          if (isRateLimitError(failure)) rateLimitedOut = true;
          this.advanceProgress();
          continue;
        }
        // Every other create carries its content, so the batch knows exactly what it holds.
        prepared.content = await this.contentFor(prepared);
        const size = prepared.content?.byteLength ?? 0;

        // A file that is itself over the bound is sent on its own, before and after a
        // flush: a bind must never hold two large files at the same time.
        if (size > MAX_PUSH_BATCH_BYTES) {
          if (await settle()) {
            this.abandonUnsent(prepared);
            break;
          }
          // Whatever small files are queued go first: the large one travels alone.
          flush();
          batch.push(prepared);
          batchBytes = size;
          flush();
          // Alone, and finished before the next file is read: the memory bound above.
          await settle();
          continue;
        }
        if (batch.length >= MAX_PUSH_BATCH_FILES || batchBytes + size > MAX_PUSH_BATCH_BYTES) {
          // The batch that is full goes out now; this file starts the next one, which is
          // prepared while the request flies.
          if (await settle()) {
            this.abandonUnsent(prepared);
            break;
          }
          flush();
        }
        batch.push(prepared);
        batchBytes += size;
      }
    } catch (err) {
      // A throw from the adapter or the encryption must not leave this batch's pending
      // entries (or the request on the wire) behind: that is the stranded-file path again.
      // The normal path keeps atch for the tail flush below.
      await settle();
      for (const prepared of batch) this.abandonUnsent(prepared);
      throw err;
    }

    // The last full batch, then the tail of the vault.
    await settle();
    if (rateLimitedOut) {
      for (const prepared of batch) this.abandonUnsent(prepared);
      batch = [];
    } else {
      flush();
      await settle();
    }
    return firstFailure;
  }

  /**
   * Give up on a file whose create was prepared but never sent.
   *
   * The loop writes the pending state entry and registers the echo suppression *before*
   * it knows whether the batch that holds the file will go out. When a limiter ends the
   * pass at that point, this file has no batch waiting for it: both records have to go,
   * or the next pass sees a file that is "tracked" with no version and pushes it one
   * request at a time — the exact cost `dropPendingCreate` exists to avoid.
   */
  private abandonUnsent(prepared: PreparedPush): void {
    this.forgetPushedVersion(prepared);
    this.dropPendingCreate(prepared);
    // It was counted as taken on, and it is settled now (as "not sent"): the pass's final
    // `done === total` has to hold even when a limiter stopped it.
    this.advanceProgress();
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
   * Resolve a conflict. There are two rules, decided by the path.
   *
   * **A config-folder path** (`settingsGroupOf` answers a group) resolves by **last
   * modification time** and reports nothing: a conflict copy parked in `.obsidian/` is
   * invisible to Obsidian's file explorer, so there is no way for the user to see or
   * act on it. The newer side wins — the local file is pushed over the head when it is
   * newer, the remote head is applied when it is not — and no `onConflictResolved`
   * event is raised, because nothing the host could say would be actionable.
   *
   * **Everywhere else** the remote head wins, and the local content — when there is
   * any — is parked beside the file as a conflict copy so nothing the user wrote is
   * thrown away.
   *
   * The remote side is applied with {@link pullRemote}, which already knows both
   * shapes: a live head is written at the path that version records (following a
   * peer's move), and a `delete` head removes the local file. A local side that no
   * longer exists — this device deleted the file and a peer edited it — has nothing
   * to park; the file simply comes back.
   *
   * `plainPath` is where the local side lived; that is the path the conflict file is
   * named after, even when the remote head records a different one.
   */
  private async handleConflict(
    fileId: string,
    plainPath: string | null,
    head: VersionChainEntry | undefined,
    localExists: boolean,
    deviceName: string | null = null,
  ): Promise<boolean> {
    const { adapter } = this.opts;
    if (!head) return true;
    if (!plainPath) return true;

    // Ownership is the test, not "is inside the config folder": it answers null for a
    // path nothing may sync, and a path in a group this device has off never reaches a
    // conflict at all (the scope guard drops it upstream).
    if (settingsGroupOf(plainPath, this.scope) !== null) {
      return await this.resolveSettingsConflict(fileId, plainPath, head, localExists, deviceName);
    }

    // The local bytes are read **before** the remote side is applied — that write (or
    // deletion) is what would otherwise destroy the only copy of them — but the copy is
    // parked, and the conflict announced, only once the remote head is really in place. It
    // used to be the other way round, which meant a conflict whose content could not be read
    // (a missing or truncated blob, a request that failed) was reported as "the remote
    // version won, your copy is at …" while the note still held the local text — and, since
    // the same decision came up from the same bytes, it parked one more copy on every pass.
    const localBytes = localExists ? await adapter.readFile(plainPath) : null;
    if (localExists && !localBytes) return true;

    const applied = await this.pullRemote(fileId, plainPath, head, null, deviceName);
    if (!applied) return false;

    const conflictPath =
      localBytes === null ? null : await this.parkConflictFile(plainPath, localBytes);
    this.opts.onConflictResolved?.({
      fileId,
      plainPath,
      conflictPath,
      remoteAction: head.action === "delete" ? "delete" : "write",
    });
    return true;
  }

  /**
   * Settle a config-folder conflict by **last modification time**, with no copy and no
   * event.
   *
   * The local file's stamp is compared with the head's `mtimeMs` — the modification time
   * the pushing device recorded — so the answer is "who changed it last", not "who
   * pushed last". That is what makes an edit made offline win over a peer's later push
   * when it really was the later edit. A tie, a missing stamp or an unreadable file
   * resolves to the remote head: both devices apply the same rule, so a tie converges
   * instead of letting them push past each other.
   *
   * A local side that no longer exists — this device deleted the file and a peer edited
   * it — has nothing to compare or keep, so the remote head is applied. A deletion this
   * device never pushed carries no timestamp to argue with.
   *
   * The local-won branch is a normal conditional push (`baseVersionId` = the head). It
   * pushes at **the path the local file actually has**, not at the path the head records:
   * a version names the path its bytes live at, and writing one for a path whose file
   * sits somewhere else is how one chain ends up claiming two paths. A peer that moved
   * the file while this device edited it therefore follows the win back to this path —
   * the same "the winning side's content, at the winning side's path" the vault-file rule
   * gives when the remote side wins.
   *
   * A refusal is answered by deciding again from the chain the server just showed us.
   * A second refusal is contention, not failure — nothing was written and nothing was
   * lost — so it is answered `true` and left to the next pass, which the settings poll
   * runs every second. Answering `false` there would make a notification report a failed
   * conflict for a race the engine simply lost twice.
   */
  private async resolveSettingsConflict(
    fileId: string,
    plainPath: string,
    head: VersionChainEntry,
    localExists: boolean,
    deviceName: string | null = null,
  ): Promise<boolean> {
    if (!localExists) return await this.pullRemote(fileId, plainPath, head, null, deviceName);

    let currentHead = head;
    for (let attempt = 0; attempt < 2; attempt++) {
      // The local half of the size cap, asked **before** the read and for the same
      // reason as everywhere else: the engine hashes and encrypts the whole file in
      // memory. A file that grew past the cap between the listing and this conflict is
      // skipped and reported, exactly like one the list already filtered out.
      if (!(await this.withinLocalSizeCap(plainPath))) {
        // `false` is "too large" (reported) or "vanished since the listing", and the
        // next pass decides the latter.
        return true;
      }
      const read = await this.readWithStamp(plainPath);
      // The file vanished between the size check and here: the next pass decides.
      if (!read) return true;
      const { bytes, stamp } = read;
      // A missing stamp is treated as "no usable modification time", which loses to any
      // real remote version — the same answer a tie gets.
      const localMtimeMs = Math.max(0, Math.floor(stamp?.mtimeMs ?? 0));
      if (localMtimeMs <= currentHead.mtimeMs) {
        // No content hash is offered: the losing side's bytes differ from the head's by
        // definition, so `pullRemote`'s "this device already holds them" shortcut cannot
        // apply. It has to write the winner's bytes over them.
        return await this.pullRemote(fileId, plainPath, currentHead, null, deviceName);
      }
      try {
        await this.pushFile({
          fileId,
          plainPath,
          // A live head is modified; a tombstone means the file is being brought back,
          // which is a `restore` on the same chain (the recycle bin's own action).
          action: currentHead.action === "delete" ? "restore" : "modify",
          bytes,
          baseVersionId: currentHead.versionId,
          stamp,
        });
        return true;
      } catch (err) {
        // Anything but a refusal means the push could not be made at all (the file could
        // not be read, the network is down): the callers report that instead of assuming
        // the conflict was settled.
        if (!(err instanceof SyncPushBaseError)) return false;
        // A second refusal: a third party keeps pushing. Nothing was written, so this is
        // not a failure — the next pass decides again from the newer chain.
        if (attempt === 1) return true;
        const fresh = remoteHead(err.chain);
        if (!fresh) return true;
        currentHead = fresh;
      }
    }
    return true;
  }

  /**
   * Write the local side of a conflict beside the original and return where it landed.
   *
   * The name is `{stem}-{YYYY-MM-DD-HHmmss}.conflict{ext}` — the extension the original
   * has, because the copy has to open in the app that owns it — with a counter when that
   * name is already taken: two copies parked inside the same second must not overwrite
   * each other. The timestamp is taken once, so every candidate this call tries names the
   * same instant.
   */
  private async parkConflictFile(plainPath: string, bytes: Uint8Array): Promise<string> {
    const now = new Date();
    for (let index = 1; ; index++) {
      const candidate = conflictFilePath(plainPath, now, index);
      if ((await this.opts.adapter.statFile(candidate)) === null) {
        await this.opts.adapter.writeFile(candidate, bytes);
        return candidate;
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
  private async fetchRemoteBytes(vaultId: string, contentHash: string): Promise<Uint8Array | null> {
    let stored: Uint8Array;
    try {
      // The API hands back the stored ciphertext itself; there is nothing to decode
      // first, so a pull decrypts the bytes it received and no more.
      stored = await this.withRateLimitWaits(() =>
        this.opts.api.getVersionContent(vaultId, contentHash),
      );
    } catch (err) {
      if (isMissingContentError(err)) return null;
      throw err;
    }
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
    await this.opts.adapter.writeFile(target, bytes);
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
      await writer.close();
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
      return this.fetchRemoteBytes(vaultId, contentHash);
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
    if (stamp.sizeBytes !== recorded.sizeBytes || stamp.mtimeMs !== recorded.mtimeMs) return null;
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
      await this.opts.adapter.deleteFile(plainPath);
      delete this.state[fileId];
      this.pathToFileId.delete(plainPath);
      // The chain has no live path any more. Keeping the index entry would make a file
      // written here later adopt this dead identity (see `RemoteIndex.forget`).
      this.remoteIndex.forget(fileId);
      // A settings file that disappeared is as much a change to what the app has
      // already read as one that arrived.
      this.reportSettingsApplied(plainPath, "delete");
      this.reportActivity({
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
          this.reportSettingsApplied(target, "rename");
          this.reportActivity({
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
    // The new sync point is recorded **in the same turn as the write**, before any
    // further `await`: a host can deliver more than one event for one write (Obsidian
    // reports a `create` and a `modify`), and an event that lands between the write and
    // this line reads the bytes the engine just wrote as a divergent local edit — which
    // resolves as a conflict against the very version that was just pulled, parking a
    // copy of the new content beside the note. The stamp is filled in afterwards,
    // because it costs a stat and nothing depends on it being there yet.
    this.adoptRemoteIdentity(fileId, target, head);
    this.rememberStamp(target, await this.opts.adapter.statFile(target));
    this.reportSettingsApplied(target, moved ? "rename" : "write");
    this.reportActivity({
      direction: "in",
      outcome: "applied",
      fileId,
      versionId: head.versionId,
      plainPath: target,
      action: head.action,
      sizeBytes: head.sizeBytes,
      deviceName,
    });
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
   * listing (the scope drops it): {@link findExcludedMoveCandidate} answers that half,
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
      // A path an event is handling belongs to that event, not to this chain.
      if (this.inFlightPaths.has(path)) continue;
      if (candidate !== null) return; // ambiguous — leave both sides alone
      candidate = path;
    }
    if (candidate === null) {
      const excluded = await this.findExcludedMoveCandidate(fileId, oldPath, syncedHash, remote);
      if (excluded === null) return;
      // Recorded, not pushed: the destination is outside this device's sync scope, and
      // the recorded path is what turns the move back into a `rename` when the folder
      // returns to scope. Dropping the chain here would make the old path a tombstone
      // for every peer.
      this.recordLocalPathMove(oldPath, excluded);
      return;
    }

    this.pathToFileId.delete(oldPath);
    this.pathToFileId.set(candidate, fileId);
    entry.plainPath = candidate;
  }

  /**
   * The file under an excluded folder that is this chain's file, moved there without an
   * event the engine could read as a rename.
   *
   * A host can see a move as "removed at the old path, created at the new one" — an
   * external tool, the CLI's `fs.watch`, a plugin that was not running — and when the
   * destination is an excluded folder the scope drops the created half, so the absence
   * would become a tombstone for a file the user still owns. The match is deliberately
   * narrow: the same file name, the same size when the state recorded one, and exactly
   * one candidate whose bytes hash to the sync point. Anything else falls back to the
   * normal deletion path — a wrong "move" would keep a file every peer has deleted.
   */
  private async findExcludedMoveCandidate(
    fileId: string,
    oldPath: string,
    contentHash: string,
    remote: RemoteIndex,
  ): Promise<string | null> {
    if (this.scope.excludedFolders.length === 0) return null;
    const candidates = (await this.excludedFilesByName()).get(this.fileNameOf(oldPath)) ?? [];
    if (candidates.length === 0) return null;

    const sizeHint = this.state[fileId]?.stamp?.sizeBytes;
    let match: string | null = null;
    for (const candidate of candidates) {
      // A file another chain claims (or this chain already records) is not the move.
      if (this.pathToFileId.has(candidate) || remote.fileIdAt(candidate) !== null) continue;
      if (this.inFlightPaths.has(candidate)) continue;
      if (sizeHint !== undefined) {
        const stamp = await this.opts.adapter.statFile(candidate);
        if (stamp === null || stamp.sizeBytes !== sizeHint) continue;
      }
      const bytes = await this.opts.adapter.readFile(candidate);
      if (!bytes) continue;
      if ((await sha256Hex(bytes)) !== contentHash) continue;
      if (match !== null) return null; // ambiguous — keep the deletion path
      match = candidate;
    }
    return match;
  }

  /**
   * The excluded folders' files grouped by name, listed at most once per burst.
   *
   * A host that cannot list them answers none, and a move it never saw stays a
   * deletion — the same behaviour as before the listing existed.
   */
  private async excludedFilesByName(): Promise<Map<string, string[]>> {
    const now = Date.now();
    if (this.excludedFiles !== null && now - this.excludedFiles.at < EXCLUDED_LISTING_TTL_MS) {
      return this.excludedFiles.byName;
    }
    const byName = new Map<string, string[]>();
    // A listing is a fallback for a decision the pass would otherwise make as a deletion:
    // a host that cannot answer must not make the pass fail (and retry forever).
    let listed: string[] = [];
    try {
      listed = (await this.opts.adapter.listExcludedFiles?.()) ?? [];
    } catch {
      listed = [];
    }
    for (const path of listed) {
      const name = this.fileNameOf(path);
      const bucket = byName.get(name);
      if (bucket) bucket.push(path);
      else byName.set(name, [path]);
    }
    this.excludedFiles = { at: now, byName };
    return byName;
  }

  /** The last path segment — the name a move generally keeps. */
  private fileNameOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash === -1 ? path : path.slice(slash + 1);
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
      this.adoptRemoteIdentity(fileId, remotePath, head);
      return { path: remotePath, moved: false };
    }

    // Nothing local to move either: the peer's path is where the file belongs.
    const localStamp = await this.opts.adapter.statFile(plainPath);
    if (!localStamp) return { path: remotePath, moved: false };

    this.recordSelfRename(plainPath, remotePath);
    await this.opts.adapter.renameFile(plainPath, remotePath);
    this.pathToFileId.delete(plainPath);
    this.pathToFileId.set(remotePath, fileId);
    return { path: remotePath, moved: true };
  }

  // ── Incremental local events ──

  async handleLocalChange(path: string): Promise<void> {
    // Conflict files and anything outside this device's scope (a settings file
    // while the switch is off, a path in a dot-folder) are not this engine's.
    if (!this.isSyncable(path)) return;
    const release = this.beginLocalOp(path);
    try {
      await this.applyLocalChange(path);
    } finally {
      release();
    }
  }

  /** The work of {@link handleLocalChange}, running under its in-flight marker. */
  private async applyLocalChange(path: string): Promise<void> {
    if (!this.initialized) {
      await this.initialSync();
      return;
    }
    // The size cap is checked before the read, so an oversized file is never loaded.
    if (!(await this.withinLocalSizeCap(path))) return;
    // A streamed commit may have renamed the target already while its stamp is still
    // being taken. Waiting here is what lets the event below avoid reading the file.
    const pendingCommit = this.streamedCommits.get(path);
    if (pendingCommit) await pendingCommit;
    const stamp = await this.opts.adapter.statFile(path);
    if (stamp === null) return;
    // A streamed write records its stamp as well as its hash: the event this very write
    // fires is then recognised without reading a file that was just written in chunks.
    // A genuine edit inside the window moves the stamp and takes the ordinary path.
    if (this.selfEvents.matchesSelfWriteStamp(path, stamp)) return;
    const bytes = await this.opts.adapter.readFile(path);
    if (!bytes) return;

    // A write this engine performed echoes back as a vault event, and the host's
    // handler runs before the engine's own state update lands (the write and that
    // update are separate async hops). Treating the echo as a user edit is what
    // produced a phantom conflict, a duplicate restore and a duplicate fileId.
    if (await this.consumeSelfWrite(path, bytes)) return;

    let fileId = this.pathToFileId.get(path);

    // New local file — look for a rename first (same hash as a deleted file).
    if (!fileId) {
      const hash = await sha256Hex(bytes);
      const renamed = this.selfEvents.matchDeletedFile(hash);
      if (renamed) {
        fileId = renamed.fileId;
        const oldPath = this.state[fileId]?.plainPath;
        if (oldPath) this.pathToFileId.delete(oldPath);
        this.state[fileId] = { ...this.state[fileId], plainPath: path };
        this.pathToFileId.set(path, fileId);
        await this.pushFile({
          fileId,
          plainPath: path,
          action: "rename",
          bytes,
          contentHash: hash,
          baseVersionId: this.state[fileId].lastKnownVersionId,
          stamp,
        });
        this.persist();
        return;
      }

      // The server already tracks this path (or this content) under a fileId we
      // are not tracking locally — a peer renamed or moved a file, and our vault
      // event for the new path won the race against the state update that would
      // have claimed it. Adopt that identity instead of forking a second chain
      // for the same path: a second chain here is exactly the "both a.md and
      // b.md exist" outcome.
      //
      // A **tombstone** is not an identity to adopt: the path holds no live version,
      // and a file written there after the deletion is somebody's new file (the same
      // answer `decideFile` gives for a tombstone that is this device's own sync
      // point). Adopting it would turn "restore the parked copy" into a conflict
      // against the deletion that had just been applied.
      const known = this.remoteIndex.fileIdAt(path);
      const knownHead = known ? this.remoteIndex.headOf(known) : undefined;
      let remote =
        known && knownHead && knownHead.action !== "delete"
          ? { fileId: known, head: knownHead }
          : null;
      if (!remote) {
        // One vault listing only pays for itself when the identity is genuinely
        // unknown: the fallback has to know whether the chain's previous path
        // still holds a file, or two coexisting copies would be merged.
        const localPaths = new Set(await this.opts.adapter.listSyncableFiles());
        remote = this.findRemoteFileIdByContent(hash, localPaths);
      }
      if (remote) {
        this.adoptRemoteIdentity(remote.fileId, path, remote.head, stamp);
        if (hash === remote.head.contentHash) {
          // Same content at the peer's path: a rename, not an edit. The head just
          // adopted is the base.
          await this.pushFile({
            fileId: remote.fileId,
            plainPath: path,
            action: "rename",
            bytes,
            contentHash: hash,
            baseVersionId: remote.head.versionId,
            stamp,
          });
        } else {
          const chain = await this.pullChain(remote.fileId);
          await this.handleConflict(remote.fileId, path, remoteHead(chain), true);
        }
        this.persist();
        return;
      }

      fileId = generateFileId();
      this.state[fileId] = {
        plainPath: path,
        lastKnownVersionId: null,
        lastKnownContentHash: null,
      };
      this.pathToFileId.set(path, fileId);
      // A fileId this engine just generated cannot have a chain: base null.
      await this.pushFile({
        fileId,
        plainPath: path,
        action: "create",
        bytes,
        contentHash: hash,
        baseVersionId: null,
        stamp,
      });
      this.persist();
      return;
    }

    // Existing tracked file — incremental decide. The bytes just read are handed on so
    // the decision does not read (and hash) the same file a second time; it re-checks
    // the stamp before trusting them (see `decideIncremental`).
    await this.decideIncremental(fileId, path, { bytes, stamp });
    this.persist();
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

    for (let attempt = 0; attempt < 2; attempt++) {
      chain ??= await this.pullChain(fileId);
      const head = remoteHead(chain);
      // Only the first attempt may reuse the prefetched bytes: a `stale_base` retry
      // fetched the chain again, so they have had another network round trip to age.
      const candidate = attempt === 0 ? prefetched : undefined;
      const read =
        candidate !== undefined &&
        candidate.stamp !== null &&
        (await this.currentStampIfUnchanged(path, candidate.stamp)) !== null
          ? candidate
          : await this.readWithStamp(path);
      // Only an event-driven pass reaches here without bytes, and a change event
      // for a file that cannot be read is not evidence of a deletion (the host's
      // delete event is). Stay put rather than pushing a tombstone.
      if (!read) return;
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

      // A non-push decision acts on the file (it may overwrite it, or adopt the remote
      // head as synced), so it must be taken from bytes read **now**, not from the
      // caller's pre-fetch that the chain request has had time to age. A same-size edit
      // inside one mtime tick is exactly what the stamp check cannot see; the reconcile
      // re-reads before every pull/conflict for the same reason. If the file moved, the
      // decision is taken again from disk, once.
      if (decision.action !== "push" && read === candidate) {
        const fresh = await this.readWithStamp(path);
        if (!fresh) return;
        const freshHash = await sha256Hex(fresh.bytes);
        if (freshHash !== hash) {
          return await this.decideIncremental(fileId, path);
        }
        bytes = fresh.bytes;
        stamp = fresh.stamp;
        hash = freshHash;
      }

      try {
        if (decision.action === "push") {
          // The stamp travels with the push, so the sync point it records is one the
          // next pass can trust without reading the file back. This is the path every
          // edit a user makes takes — and the hash it just computed is the one the
          // version carries, so `preparePush` does not hash the file a third time.
          await this.pushFile({
            fileId,
            plainPath: path,
            action: decision.pushAction,
            bytes,
            contentHash: hash,
            baseVersionId: head?.versionId ?? null,
            stamp,
          });
        } else if (decision.action === "synced") {
          // The head already holds the bytes on disk, while our sync point is behind it:
          // another operation on this path pushed them and this decision fetched the chain
          // before that push's response landed (see `decideFile`). Take the head as the
          // sync point — a tombstone has no live identity to adopt, and a delete head with
          // a local file on disk never decides as verifiable-synced anyway.
          if (
            head &&
            head.action !== "delete" &&
            this.state[fileId]?.lastKnownVersionId !== head.versionId
          ) {
            this.adoptRemoteIdentity(fileId, path, head, stamp);
          }
        } else if (decision.action === "conflict") {
          await this.handleConflict(fileId, path, head, true);
        } else if (decision.action === "pull" && head) {
          await this.pullRemote(fileId, path, head, hash);
        }
        return;
      } catch (err) {
        if (!(err instanceof SyncPushBaseError) || attempt === 1) throw err;
        chain = err.chain;
      }
    }
  }

  async handleLocalDelete(path: string): Promise<void> {
    if (!this.isSyncable(path)) return;
    // The engine applying a peer's delete fires this same event; it must not be
    // echoed back to the server as a second tombstone.
    if (this.consumeSelfDelete(path)) return;
    const release = this.beginLocalOp(path);
    try {
      await this.applyLocalDelete(path);
    } finally {
      release();
    }
  }

  /** The work of {@link handleLocalDelete}, running under its in-flight marker. */
  private async applyLocalDelete(path: string): Promise<void> {
    const fileId = this.pathToFileId.get(path);
    if (!fileId) return;
    // A delete event can be half of a move the host could not report as a rename (an
    // external tool, the CLI's `fs.watch`, a plugin that was not running). When the
    // destination is inside a folder this device excludes, the created half never
    // reaches the engine — so the absence must not become a tombstone for a file the
    // user still owns. Record the new path and push nothing; un-excluding the folder is
    // what turns the move back into a `rename`.
    const contentHash = this.state[fileId]?.lastKnownContentHash ?? "";
    if (contentHash !== "") {
      const movedTo = await this.findExcludedMoveCandidate(
        fileId,
        path,
        contentHash,
        this.remoteIndex,
      );
      if (movedTo !== null) {
        this.recordLocalPathMove(path, movedTo);
        this.persist();
        return;
      }
    }
    // Remember the delete so a file that appears with this content can be read as its
    // rename rather than as a brand-new chain.
    this.selfEvents.rememberDelete(fileId, this.state[fileId]?.lastKnownContentHash ?? "");
    this.pathToFileId.delete(path);
    // The state entry survives until the server accepts the tombstone (`pushFile`
    // then rewrites it to the delete version). Dropping it here would leave a
    // failed push — the network is down, or the app is closed before the next
    // attempt — with a fileId the engine no longer tracks but the server still
    // holds live, and the next reconcile would read that as "a remote file this
    // device is missing" and pull the deletion back.
    //
    // When the deletion was decided rides along with it: a tombstone has no file to
    // stamp, and a peer compares its `mtimeMs` with its own file's modification time.
    // Reading the clock again on a retry (the next pass, possibly hours later) would
    // let a deletion made *before* a peer's edit outrank that edit.
    const entry = this.state[fileId];
    const deletedAtMs = entry?.deletedAtMs ?? Date.now();
    if (entry) entry.deletedAtMs = deletedAtMs;
    try {
      await this.pushFile({
        fileId,
        plainPath: path,
        action: "delete",
        bytes: undefined,
        baseVersionId: this.state[fileId]?.lastKnownVersionId ?? null,
        stamp: null,
        mtimeMs: deletedAtMs,
      });
    } catch (err) {
      if (!(err instanceof SyncPushBaseError)) throw err;
      // A peer pushed after the point this delete was decided from, so the tombstone
      // would have removed a version this device never saw: a **deletion that raced
      // an edit**. The remote side wins, and — because the local file is already gone
      // — there is nothing to park; the peer's version simply comes back.
      await this.handleConflict(fileId, path, remoteHead(err.chain), false);
    }
    this.persist();
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
      this.rememberMoveOutOfScope(oldPath, newPath);
      return;
    }
    // The engine following a peer's move fires this same event.
    if (this.consumeSelfRename(oldPath, newPath)) return;
    // Both paths are marked: a reconcile can meet this move as either "the old
    // path vanished" or "an unclaimed file appeared at the new one".
    const releaseOld = this.beginLocalOp(oldPath);
    const releaseNew = this.beginLocalOp(newPath);
    try {
      await this.applyLocalRename(oldPath, newPath);
    } finally {
      releaseNew();
      releaseOld();
    }
  }

  /**
   * Record and persist a move that leaves (or stays entirely outside) this device's
   * sync scope, with both paths marked as in-flight while the state changes.
   *
   * The marker is the same one a syncable rename takes: a pass that started before the
   * event can still be deciding a tombstone for the old path from its snapshot, and the
   * re-check in its delete branch only closes part of that window. Here the run is
   * short and awaits nothing, so marking costs nothing.
   */
  private rememberMoveOutOfScope(oldPath: string, newPath: string): void {
    const releaseOld = this.beginLocalOp(oldPath);
    const releaseNew = this.beginLocalOp(newPath);
    try {
      if (this.recordLocalPathMove(oldPath, newPath)) this.persist();
    } finally {
      releaseNew();
      releaseOld();
    }
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

  /** The work of {@link handleLocalRename}, running under both in-flight markers. */
  private async applyLocalRename(oldPath: string, newPath: string): Promise<void> {
    const fileId = this.pathToFileId.get(oldPath);
    if (!fileId) {
      // Untracked — treat as a plain create path.
      if (this.pathToFileId.has(newPath)) return;
      await this.handleLocalChange(newPath);
      return;
    }
    this.pathToFileId.delete(oldPath);
    this.pathToFileId.set(newPath, fileId);
    this.state[fileId] = { ...this.state[fileId], plainPath: newPath };
    // Read the file so the version can record the content's hash (and its size, which a
    // peer applies its own cap to). The bytes themselves are usually *not* sent: the
    // chain's head already holds this content, so `pushFile` reuses it — a move of a
    // large attachment is one small request rather than a second upload.
    //
    // A move changes neither content nor stamp, so the sync point's recorded hash is
    // already the answer: reading (and hashing) 40 MiB only to decide not to send it
    // was the whole cost of a move. `cachedHashFor` requires the size *and* mtime it
    // recorded, and a stamp that moved (edited and renamed with no event in between)
    // falls back to reading the file.
    const stamp = await this.opts.adapter.statFile(newPath);
    const knownHash = stamp === null ? null : this.cachedHashFor(newPath, stamp);
    const read = knownHash === null ? await this.readWithStamp(newPath) : null;
    try {
      await this.pushFile({
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
    } catch (err) {
      if (!(err instanceof SyncPushBaseError)) throw err;
      // A peer pushed while the move was being recorded: decide again from the chain
      // the server just showed us, which either records the move on top of their
      // version or turns the two into a conflict — never a rename built on a version
      // this device never saw.
      await this.decideIncremental(fileId, newPath);
    } finally {
      // The move already happened on disk, so the state has to record it even when
      // the push fails. Leaving the old path behind (the push is what would have
      // persisted it) makes a later pass read the chain as "deleted locally" plus
      // "this path is a brand-new file" — one note, two chains, and a duplicate on
      // every peer. With the new path recorded, the reconcile sees the chain's
      // recorded path disagree and pushes the rename.
      this.persist();
    }
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

    for (let start = 0; start < pending.length; start += MAX_PULL_BATCH_FILES) {
      const chunk = pending.slice(start, start + MAX_PULL_BATCH_FILES);
      const response = await this.opts.api.pull(
        this.opts.vaultId,
        chunk.map((event) => event.fileId),
      );
      const chains = new Map(response.files.map((file) => [file.fileId, file.versions]));

      // The apply touches up to two paths: the head's recorded path and the path this
      // device already holds the chain at (a rename being applied). Compute both before
      // running anything; if any path repeats inside the chunk, the whole chunk applies
      // in order, one file at a time. That is the conservative version of `PathClaims`:
      // a peer's move can leave two chains naming one path for a moment, and the two
      // decisions must not interleave. With no shared path, four files at a time.
      const seenPaths = new Set<string>();
      let sharesPath = false;
      for (const event of chunk) {
        const head = remoteHead(chains.get(event.fileId) ?? []);
        const headPath = head ? await this.decryptPath(head) : null;
        for (const path of [headPath, this.state[event.fileId]?.plainPath ?? null]) {
          if (path === null) continue;
          if (seenPaths.has(path)) sharesPath = true;
          seenPaths.add(path);
        }
      }

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
        this.reportActivity({
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
      const applied = await this.handleConflict(
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
    const res = await this.opts.api.pull(this.opts.vaultId, [fileId]);
    return res.files.find((f) => f.fileId === fileId)?.versions ?? [];
  }
}

// Re-exported for host code that reads version chains directly.
export type { VersionChainEntry };
