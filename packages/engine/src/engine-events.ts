import type { SyncAction } from "@courier/shared";
import type { SyncApi } from "./api";
import type { SyncAdapter } from "./adapter";
import type { ContentPrefetchLimits } from "./content-prefetch";
import type { OpQueueLimits } from "./op-queue";
import type { Platform } from "./platform";
import type { SettingsGroup, SyncOutOfScopeReason, SyncScopeInput } from "./sync-scope";

/**
 * The types a host sees: the events the engine reports, the options it takes to be built.
 *
 * Their own module because they are the public surface, not the implementation: the
 * activity reporter and the conflict resolver need these types, and importing them from
 * `engine.ts` made those two modules depend on the orchestrator that depends on them (a
 * type-only cycle, but the wrong direction). `engine.ts` re-exports everything here, so
 * `@courier/engine`'s surface is unchanged.
 */

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
