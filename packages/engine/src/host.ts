import {
  SyncEngine,
  type ConflictResolvedEvent,
  type EngineOptions,
  type FileSkippedEvent,
  type FileTooLargeEvent,
  type PushedFileEvent,
  type SettingsAppliedEvent,
  type SyncActivityEvent,
  type SyncProgress,
} from "./engine";
import type { HistoryLimits, HealthResponse, ContractVerdict } from "@courier/shared";
import { contractVerdict } from "@courier/shared";
import type { SyncAdapter } from "./adapter";
import type { SyncApi } from "./api";
import { DEFAULT_OP_QUEUE_LIMITS, OpQueue, weightForSize, type OpQueueLimits } from "./op-queue";
import {
  normalizeScope,
  syncsAnySettings,
  type SyncScope,
  type SyncScopeInput,
} from "./sync-scope";
import type { Platform, TimerHandle } from "./platform";
import { SyncWebSocket, type WsConnectionState, type WsEvent } from "./websocket";

/**
 * The host loop both clients run: bind, watch, subscribe, reconcile, poll, stop.
 *
 * It used to exist twice — `EngineHost` in the plugin and `runDaemon` in the CLI —
 * and the copies had already drifted (the CLI never stopped on a revoked key, and
 * read its settings-poll failure flag from a second copy of the same code). Every
 * rule in here is one of the ones the e2e suites exist to protect:
 *
 * - the **bind pass** is the host's first look at a vault (`firstBind`), and a
 *   pass that has never completed one must still be a bind — the other direction
 *   deletes notes;
 * - a reconcile is **never re-entered** (it decides from a snapshot and pushes as
 *   it goes, so two at once duplicate versions), and it runs on a **re**connect,
 *   never on the first connect (which sits right behind the bind pass);
 * - the config folder fires no events, so a settings change needs its own **poll**,
 *   and a poll that fails every 30 seconds reports once, not 120 times an hour;
 * - event-driven work goes through an **`OpQueue`**, because a folder dropped into
 *   a vault arrives as one synchronous event per file;
 * - a bind pass that fails leaves a **fully wired** host that retries, rather than
 *   a half-built one whose only way back is a setting the user has to guess at.
 *
 * What is *not* here is anything host-specific: where events come from (Obsidian's
 * vault, Bun's `fs.watch`), how state is persisted (plugin `data.json`, the CLI's
 * `sync_state.json`), how the network is built (`requestUrl`, `fetch`) and what a
 * log line looks like. Those are injected.
 */

/** How often a host re-runs a full reconcile as a safety net against missed notifications. */
export const DEFAULT_RECONCILE_INTERVAL_MS = 5 * 60_000;

/** How long a bind may take before the host runs one ordinary reconcile behind it.
 *
 * The bind pass is the host's first look at the vault, and the event source is wired
 * only after it returns. An edit made while a slow bind runs would otherwise wait for
 * the periodic pass — five minutes in the plugin — so a bind that took at least this
 * long gets one immediate catch-up pass once the host is fully wired. The pass is cheap
 * when nothing changed (the stamp cache and one index request), and a fast bind does
 * not pay for it at all.
 *
 * `0` makes the catch-up unconditional (tests); `Infinity` disables it.
 */
export const DEFAULT_POST_BIND_RECONCILE_AFTER_MS = 5_000;

/**
 * Whether a persisted state holds no sync point at all.
 *
 * The state is the `localVersions` map; an empty object (or an unreadable one, which the
 * engine treats as empty) means this device has never recorded a file for the vault. It
 * is the fallback answer for a `SyncStateStore` that keeps no completion flag: a state
 * with entries is evidence a bind got somewhere, but only the flag can say it finished.
 */
export function isEmptyState(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as unknown;
    return typeof parsed !== "object" || parsed === null || Object.keys(parsed).length === 0;
  } catch {
    return true;
  }
}

/**
 * Resolve after `ms`, or reject as soon as `signal` is aborted.
 *
 * What a host hands the engine as its rate-limit wait. A limiter window is measured in
 * minutes (up to three five-minute waits per request), and `stop()` cannot cancel work
 * already inside a pass — so the one part of that work that is idle has to be
 * interruptible, or a stopped host (and the vault lease it holds) waits it out.
 */
function waitForAbort(ms: number, signal: AbortSignal, platform: Platform): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("the host stopped while waiting out the rate limit"));
      return;
    }
    const cancel = (): void => {
      timer.cancel();
      signal.removeEventListener("abort", cancel);
      reject(new Error("the host stopped while waiting out the rate limit"));
    };
    const timer = platform.after(ms, () => {
      signal.removeEventListener("abort", cancel);
      resolve();
    });
    timer.unref?.();
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/**
 * How soon a **failed** bind is retried, and how far that backs off.
 *
 * The periodic reconcile is the only other retry, and it is five minutes away — but the
 * failures a bind actually meets are transient by nature: a rate-limiter window (the
 * server states when it ends), an outage, a server still starting. Waiting five minutes
 * for each of those made a large vault's first connect take hours rather than minutes
 * (see `docs/first-bind-performance.md`). Backoff keeps an offline laptop from being
 * retried every 30 seconds forever, and a successful bind cancels it.
 */
export const BIND_RETRY_INITIAL_MS = 30_000;

/** The longest gap between bind retries: the periodic pass takes over from here. */
export const BIND_RETRY_MAX_MS = DEFAULT_RECONCILE_INTERVAL_MS;

/**
 * How often the host pushes local changes in the synced settings files.
 *
 * Obsidian keeps its config folder out of the vault index, so **no vault event
 * ever fires** for `app.json`, `hotkeys.json` or a plugin's `data.json`: without a
 * poll those changes would only travel at the next full reconcile. The pass is
 * cheap by construction — it lists, hashes and reads only the settings paths — but how
 * cheap depends on the host's listing: Obsidian's is an in-memory index and its plugin
 * asks for one second (`packages/plugin/src/unified/host.ts`). This 30-second value is
 * the conservative fallback for a host that does not choose one; the CLI never starts
 * the poll at all, because its scope has no config-folder group.
 */
export const DEFAULT_SETTINGS_POLL_INTERVAL_MS = 30_000;
/**
 * `file_pushed` notifications held before one batched chain pull.
 *
 * A first bind of a large vault announces one version per file; applying each
 * notification on its own cost one `POST /sync/pull` per file, which is 5 000 requests
 * against a 600/minute limiter. Filling one protocol batch (200) is when the burst is
 * obviously not a single edit.
 */
export const PUSH_NOTIFICATION_BATCH = 200;

/**
 * How long a lone notification waits for company.
 *
 * A single remote edit should not wait for a full batch, and a burst arrives within
 * milliseconds anyway (the pushing client sends 100 files per request), so a short
 * timer groups one bind into a handful of requests without adding latency a user
 * could notice.
 */
export const PUSH_NOTIFICATION_FLUSH_MS = 25;

/**
 * How many **local** vault events inside one window mean "a bulk write", not "an edit".
 *
 * An agent, a script or a folder operation writes hundreds of files in a few seconds, and
 * the file watcher reports each one as its own event. Handled one at a time, every file is
 * its own push request: 1 000 generated notes measured 1 000 `POST /sync/push` calls, and
 * the sync route's 600/minute allowance refuses that burst after about a minute (the host
 * then waits out windows and the files it could not push wait for the next pass). A burst
 * is handed to **one pass** instead, whose creates travel 100 files per request
 * (`createUntrackedFiles`) — 1 000 files in 10 requests.
 *
 * Four in {@link LOCAL_EVENT_BURST_WINDOW_MS} is eight events a second. That is a
 * heuristic, not a request bound: one tracked edit on the unbatched path costs a chain read
 * and a push (about three requests), so a steady stream below the threshold can still
 * approach the allowance — it then waits out a limiter window instead of being refused
 * (or, once it crosses the threshold, the batched job costs one request per 100 files). It
 * is above what one save produces (Obsidian reports a
 * create as `create` and `modify`, a rename as `delete` + `create`), so an ordinary edit
 * keeps its immediate per-path push.
 */
export const LOCAL_EVENT_BURST_SIZE = 4;

/** The window {@link LOCAL_EVENT_BURST_SIZE} counts events in (ms). */
export const LOCAL_EVENT_BURST_WINDOW_MS = 500;

/**
 * How long a detected burst waits before its paths go to the engine (ms).
 *
 * The engine's batch job reads each file as it goes, so this is not a wait for files to
 * land — it is how much of a burst is handed over at once. A longer window means fewer,
 * larger batches (and fewer vault listings); a shorter one starts the sync sooner. 50 ms
 * is below what a person notices and long enough that a watcher reporting a whole folder
 * within one tick travels as one job.
 */
export const LOCAL_EVENT_BURST_FLUSH_MS = 50;

/**
 * Where a host's file events come from.
 *
 * The handler set is deliberately three-way and the source answers with what it
 * knows: Obsidian distinguishes create/modify/delete/rename and can state a size
 * (its index already has it), while `fs.watch` reports "something happened" and
 * the source has to stat the file to answer. An unknown size is `null`, which the
 * queue treats as the worst case.
 *
 * `start` returns the function that stops it; the host calls it on `stop()`.
 */
export interface SyncEventSource {
  start(handlers: {
    changed(path: string, sizeBytes: number | null): void;
    removed(path: string): void;
    renamed(from: string, to: string, sizeBytes: number | null): void;
  }): () => void;
}

/**
 * Where the engine's per-file state lives between runs.
 *
 * `load`/`save` carry the engine's serialized state **verbatim**: that JSON is the
 * `localVersions` map keyed by fileId, so a key added to it would be read as a chain.
 * Anything else a host has to remember about the vault therefore lives beside it — which
 * is why the bind's completion has its own pair below.
 */
export interface SyncStateStore {
  /** The persisted state JSON, or null when this host has none yet. */
  load(): string | null;
  /** Persist it. Called on every sync-point change, so it must not block. */
  save(json: string): void;
  /**
   * Whether a bind pass for this vault has **ever completed** on this device.
   *
   * The flag outlives the state's emptiness on purpose: a bind killed after persisting
   * part of the vault leaves a non-empty map, but the vault is still half-bound and the
   * next pass is still the first sync (see `firstSync`).
   *
   * A store that keeps no such record leaves this out; the host then falls back to
   * reading the state's own emptiness with {@link isEmptyState}, the heuristic this flag
   * replaces.
   */
  loadBindCompleted?(): boolean;
  /**
   * Record that a bind pass completed. Called once per device and vault.
   *
   * Implementations must keep it out of the `localVersions` JSON above (see the
   * interface comment); this is state about the sync, not a chain.
   */
  saveBindCompleted?(): void;
}

export interface SyncHostOptions {
  vaultId: string;
  encryptionKey: CryptoKey;
  /** Which paths this device syncs — read once, when the host is built. */
  syncScope?: SyncScopeInput;
  adapter: SyncAdapter;
  /** The engine's network layer, built by the caller (it owns the credential). */
  api: SyncApi;
  wsUrl: string;
  /** The single `ck_` user key this host's socket subscribes with. */
  userKey: string;
  /** The label this client states for itself, read when the socket subscribes. */
  getDeviceName: () => string;
  /**
   * The paths a person is looking at right now, most important first — the note the app
   * has open, then the ones it opened most recently.
   *
   * A preference only: the engine orders its work by it (see `priority.ts`) and still
   * decides every file. A host that has no such notion (the CLI) simply omits it.
   */
  getPriorityPaths?: () => readonly string[];
  eventSource: SyncEventSource;
  stateStore: SyncStateStore;
  /**
   * The runtime this host runs on (see `Platform`).
   *
   * Required: the host that builds a `SyncHost` says which runtime it is on, so no timer
   * and no `process` probe on the sync path depends on the ambient one. (`WebSocket`,
   * `console` and `Date.now` are still the runtime's — the port is about the two things
   * that differ in behaviour between the plugin and the CLI, not about sealing the
   * engine off from the platform.)
   */
  platform: Platform;
  /** Full-reconcile interval in ms; `0` disables the periodic pass. */
  reconcileIntervalMs?: number;
  /** Settings-poll interval in ms; `0` disables the poll. */
  settingsPollIntervalMs?: number;
  /** How long a bind may take before one catch-up reconcile follows it (see the constant). */
  postBindReconcileAfterMs?: number;
  opLimits?: OpQueueLimits;
  /** Where failures go. Defaults to `console.error` with a `Courier:` prefix. */
  log?: (message: string, err?: unknown) => void;
  onConflictResolved?: (event: ConflictResolvedEvent) => void;
  onFileTooLarge?: (event: FileTooLargeEvent) => void;
  /** A file the API's own limits kept out of this sync (see `EngineOptions`). */
  onFileSkipped?: (event: FileSkippedEvent) => void;
  /**
   * A config-folder file the engine applied from the remote (see
   * `SettingsAppliedEvent`): Obsidian keeps its own copy of the settings it has already
   * read, so a host that says nothing leaves the user watching a change that arrived
   * look like one that never did.
   */
  onSettingsApplied?: (event: SettingsAppliedEvent) => void;
  /**
   * One decision this device made: a version sent, a remote version applied, or a path
   * it deliberately skipped (see `SyncActivityEvent`). The plugin's session log reads it;
   * a host that omits it syncs the same.
   */
  onSyncActivity?: (event: SyncActivityEvent) => void;
  /**
   * How far the current pass has got (see `SyncProgress`). A bind of a large vault can
   * run for a minute or more, and this is the only signal a host gets while it does.
   */
  onProgress?: (progress: SyncProgress) => void;
  /**
   * The pass is about to wait out a server rate limiter for `waitMs`.
   *
   * The pass resumes by itself; this exists so a host's log can say why nothing is
   * happening instead of leaving a minute of silence looking like a hang.
   */
  onRateLimited?: (event: { waitMs: number }) => void;
  onStateChange?: (state: WsConnectionState) => void;
  onVaultDeleted?: () => void;
  /**
   * The vault's retention limits changed — on another device, or through the API.
   *
   * The engine never reads these numbers (the server trims with its own copy), so this is
   * display state: a host forwards it to whatever shows the limits, which is how an open
   * settings page follows a change made elsewhere without being reopened.
   */
  onVaultSettings?: (limits: HistoryLimits) => void;
  /**
   * The credential this host runs on stopped working — over the WebSocket, or on an
   * HTTP request that came back 401/403.
   *
   * One callback for the three ways that happens, because the host's own reaction is
   * the same (it stops first, then reports) and only the host's *policy* differs: a
   * revoked key is gone and the binding goes with it, while an expired or disabled one
   * is a pause the same key can be resumed from.
   */
  onAuthFailure?: (reason: AuthFailureReason) => void;
  /**
   * This build and the server do not speak the same contract generation.
   *
   * The host has already stopped and built nothing — no engine, no bind, no write — so a
   * caller that holds a resource (the vault lease) has to release it, and one with a user
   * in front of it has to say which side must move. Nothing retries on its own: a
   * mismatch does not resolve itself, and a pass cannot fix it.
   */
  onContractMismatch?: (info: ContractMismatchInfo) => void;
  /** The bind pass could not be completed. A report, not a terminal state. */
  onBindFailed?: (error: unknown) => void;
}

/** Which side is too old, and what the server said about itself. */
export interface ContractMismatchInfo {
  verdict: Exclude<ContractVerdict, "ok">;
  serverGeneration: number;
  serverMinClient: number;
  /** The server's release version; null on a build old enough not to report one. */
  serverVersion: string | null;
}

/** Why a credential stopped working, as a host has to act on it. */
export type AuthFailureReason = "revoked" | "expired" | "disabled";

/**
 * The reason an error is a terminal credential failure, or null when it is not.
 *
 * Matched on the API's code rather than its status where possible. `401` is the fallback
 * for a credential the server no longer accepts at all — a key whose account was deleted
 * answers it. It is deliberately **not** the answer for "this vault is not yours": the
 * server answers that with `404`, so a client never drops a valid key over a binding that
 * merely points at the wrong vault. Everything else — a 5xx, a dropped connection, a
 * rate limiter — is transient and must keep being retried.
 */
export function authFailureReason(err: unknown): AuthFailureReason | null {
  if (typeof err !== "object" || err === null) return null;
  const { code, status } = err as { code?: unknown; status?: unknown };
  if (code === "KEY_EXPIRED") return "expired";
  if (code === "KEY_DISABLED") return "disabled";
  if (code === "UNAUTHORIZED" || status === 401) return "revoked";
  return null;
}

/**
 * Whether the error says the vault itself is gone (or is not this account's).
 *
 * The server answers both with `404`, so the binding is dead either way: a host drops it
 * and keeps the key. Only the sync routes can produce it here — a missing blob is
 * handled inside the engine as "content missing", not thrown to the host.
 */
export function isVaultGone(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const { code, status } = err as { code?: unknown; status?: unknown };
  return code === "NOT_FOUND" || status === 404;
}

export class SyncHost {
  private engineInstance: SyncEngine | null = null;
  /**
   * The engine a stopped host is still draining.
   *
   * A stopped host cannot cancel work already inside the engine, and a deferred event job
   * (queued while the engine writes) is not counted by `background`. Releasing the vault
   * lease before that queue drains would let the next host start on top of a write that is
   * still coming.
   */
  private readonly drainingEngines = new Set<SyncEngine>();
  private ws: SyncWebSocket | null = null;
  private stopEvents: (() => void) | null = null;
  private reconcileTimer: TimerHandle | null = null;
  private settingsTimer: TimerHandle | null = null;
  private reconciling = false;
  /** Background jobs started from events, reconciles or settings polls. */
  private background = 0;
  /** Whether a bind pass has ever completed; until one has, every pass is a bind. */
  private bindCompleted = false;
  /**
   * Whether a bind ever completed for this vault **before** this start, from the state
   * store's flag (see `SyncStateStore.loadBindCompleted`). Cleared once this host's own
   * bind completes.
   */
  private bindEverCompleted = false;
  /** `file_pushed` notifications waiting for the next batched chain pull. */
  private pendingPushes: PushedFileEvent[] = [];
  /** The short timer that flushes {@link pendingPushes}; `null` when none is scheduled. */
  private pushFlushTimer: TimerHandle | null = null;
  /** Local vault events counted in the current window (see {@link LOCAL_EVENT_BURST_SIZE}). */
  private localEventsInWindow = 0;
  /** When the current counting window opened (`Date.now()`, the runtime's clock). */
  private localEventWindowStart = 0;
  /**
   * Paths of a burst waiting for the engine's batch job.
   *
   * A set, because a watcher can report the same path twice for one write (`create` then
   * `modify`); the engine re-reads the file anyway, so one entry is enough. Changes and
   * deletions are kept apart: a change is decided by reading the file, a deletion by its
   * absence, and mixing them would drop every tombstone in the batch.
   */
  private pendingBurstChanges = new Set<string>();
  private pendingBurstDeletes = new Set<string>();
  /** A burst's moves, keyed by their source (a later event for it wins). */
  private pendingBurstRenames = new Map<string, string>();
  /**
   * A burst job is owed: paths arrived after the last hand-off (or while one ran).
   *
   * Set by every burst event, cleared only when a hand-off actually happens, so the host
   * converges on the last file the burst wrote.
   */
  private localBurstOwed = false;
  /** The timer that hands the collected paths to the engine; `null` when none is armed. */
  private localBurstTimer: TimerHandle | null = null;
  /** True while a burst job is running, so a new hand-off waits for it (single-flight). */
  private localBurstRunning = false;
  /** True once the socket has been subscribed at least once — see `handleWsEvent`. */
  private socketHasConnected = false;
  /** True while the last settings poll failed, so an outage is reported once. */
  private settingsPollFailed = false;
  /** A retry scheduled because a bind pass failed (see `scheduleBindRetry`). */
  private bindRetryTimer: TimerHandle | null = null;
  /** The delay the next failed-bind retry uses; doubles up to the periodic interval. */
  private bindRetryMs = BIND_RETRY_INITIAL_MS;
  /** True between `stop()` and the next `start()`, so a late callback is ignored. */
  private stopped = true;
  /**
   * Cancels the wait of the pass this start is running.
   *
   * A pass that waits out a rate limiter would otherwise hold its background count — and
   * a host's vault lease with it — for the whole window (up to three five-minute waits).
   * `stop()` aborts it, and the engine answers the refusal instead of retrying.
   */
  private waitAbort: AbortController | null = null;
  /**
   * Bumped by every `start()`/`stop()`.
   *
   * A pass is not cancellable once it is running (nothing in the engine waits on a path),
   * so a stopped host can still have one in flight. The generation is what keeps that
   * pass from writing the state it read before the stop over the state a restarted host
   * has already saved.
   */
  private generation = 0;
  private readonly scope: SyncScope;
  private readonly opLimits: OpQueueLimits;
  private readonly ops: OpQueue;

  /** The runtime this host was given (see `SyncHostOptions.platform`). */
  private get platform(): Platform {
    return this.opts.platform;
  }

  constructor(private readonly opts: SyncHostOptions) {
    this.scope = normalizeScope(opts.syncScope);
    this.opLimits = opts.opLimits ?? DEFAULT_OP_QUEUE_LIMITS;
    this.ops = new OpQueue(this.opLimits, (label, err) => {
      this.fail(label, err);
    });
  }

  get engine(): SyncEngine | null {
    return this.engineInstance;
  }

  get wsState(): WsConnectionState {
    return this.ws?.getState() ?? "disconnected";
  }

  /** Resolve a plain path to its fileId (version-history entry point). */
  fileIdForPath(path: string): string | null {
    return this.engineInstance?.fileIdForPath(path) ?? null;
  }

  /**
   * Whether the server this host talks to can serve this build.
   *
   * A probe that cannot reach the server is **not** a mismatch: the pass that follows
   * reports the outage the ordinary way and the host keeps its retry loop. Only a server
   * that answers, and answers with a window this build is outside, stops the host — which
   * is why the answer is read from `/api/health` rather than inferred from a failed call.
   */
  private async serverContractMismatch(): Promise<ContractMismatchInfo | null> {
    const api = this.opts.api;
    if (api.getServerInfo === undefined) return null;

    let health: HealthResponse;
    try {
      health = await api.getServerInfo();
    } catch {
      return null;
    }

    const verdict = contractVerdict(health);
    if (verdict === "ok") return null;

    const serverGeneration = health.generation ?? 1;
    const serverMinClient = health.minClient ?? 1;
    const serverVersion = health.version ?? null;
    this.log(
      `the server speaks contract ${serverGeneration} (serves clients >= ${serverMinClient}); ` +
        `this build cannot use it (${verdict})`,
    );
    return { verdict, serverGeneration, serverMinClient, serverVersion };
  }

  /** Start (or restart) the engine, the event source and the vault WebSocket. */
  async start(): Promise<void> {
    this.stop();

    // Before anything is built or written: can these two builds work together at all?
    // A mismatch is not a transient failure — retrying it every pass produces a client
    // that looks like it is syncing while nothing it sends can be read, the same shape as
    // a dead credential. Nothing is constructed on this path, so there is nothing to drain.
    const mismatch = await this.serverContractMismatch();
    if (mismatch !== null) {
      this.opts.onContractMismatch?.(mismatch);
      return;
    }

    const generation = ++this.generation;
    // One controller per start: a stopped pass keeps its own (aborted) signal, so a
    // restarted host cannot accidentally cancel — or fail to cancel — the wrong pass.
    const waitAbort = new AbortController();
    this.waitAbort = waitAbort;
    const engine = new SyncEngine(this.engineOptions(generation, waitAbort));
    this.engineInstance = engine;
    this.stopped = false;
    const loaded = this.opts.stateStore.load() ?? "{}";
    // "This is a first sync" is a fact about the **vault**, not about this process: it is
    // about whether a bind ever finished here. The state store's flag answers that; a
    // store with no flag is judged by its state's emptiness, and a device with neither is
    // meeting the remote for the first time.
    this.bindEverCompleted = this.opts.stateStore.loadBindCompleted?.() ?? !isEmptyState(loaded);
    engine.loadState(loaded);

    // A bind that fails must not leave a **half-built** host: everything below is
    // wired either way, and the periodic (or a reconnect) reconcile retries. Until
    // one of those passes completes they run as bind passes (`bindCompleted`), so a
    // first connection can never apply a tombstone it has not merged against yet.
    this.bindCompleted = false;
    this.cancelBindRetry();
    const bindStartedAt = Date.now();
    try {
      await engine.initialSync({
        firstBind: true,
        priorityPaths: this.priorityPaths(),
      });
      this.markBindCompleted();
    } catch (err) {
      // A dead credential — or a vault that is gone — is not a bind that will succeed on
      // the next retry: the host stops (see `fail`) and the caller decides what the
      // binding is worth.
      if (authFailureReason(err) !== null || isVaultGone(err)) {
        this.fail("the bind pass", err);
        return;
      }
      this.log("the bind pass failed", err);
      this.opts.onBindFailed?.(err);
      // The periodic pass is five minutes away; a limiter window or a server that is
      // still starting is not.
      this.scheduleBindRetry();
    }
    if (this.stopped) return;

    this.stopEvents = this.opts.eventSource.start({
      // The label carries the path: a failure line has to say *which* file could not
      // be pushed, or a headless user has nothing to act on.
      changed: (path, sizeBytes) =>
        this.dispatchLocalEvent(
          "changed",
          `push ${path}`,
          path,
          null,
          sizeBytes,
          engine.hasSelfWriteHint(path),
          () => engine.handleLocalChange(path),
        ),
      removed: (path) =>
        // Deleting transfers no content, so it never needs to run alone.
        this.dispatchLocalEvent(
          "deleted",
          `delete ${path}`,
          path,
          null,
          0,
          engine.hasSelfDeleteHint(path),
          () => engine.handleLocalDelete(path),
        ),
      renamed: (from, to, sizeBytes) =>
        this.dispatchLocalEvent(
          "renamed",
          `rename ${from} → ${to}`,
          from,
          to,
          sizeBytes,
          engine.hasSelfRenameHint(from),
          () => engine.handleLocalRename(from, to),
        ),
    });

    // The session id is only known once the socket is up, so it is handed to the
    // api here and on every event — a push identifies itself with it and the server
    // then skips echoing that push back to this same device.
    this.socketHasConnected = false;
    this.ws = new SyncWebSocket({
      wsUrl: this.opts.wsUrl,
      vaultId: this.opts.vaultId,
      userKey: this.opts.userKey,
      // Read once per socket: a peer's notification names the label this client had
      // when it subscribed.
      deviceName: this.opts.getDeviceName(),
      platform: this.platform,
      onEvent: (event) => this.handleWsEvent(event),
    });
    this.ws.connect();
    this.syncSessionId();

    const reconcileMs = this.opts.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    if (reconcileMs > 0) {
      this.reconcileTimer = this.platform.every(reconcileMs, () =>
        this.runReconcile("periodic reconcile"),
      );
      this.reconcileTimer.unref?.();
    }

    // Settings files fire no vault event (the config folder is not in Obsidian's
    // index), so a change to one is picked up by polling rather than by an event.
    // Nothing to poll when every config-folder group is off.
    const pollMs = this.opts.settingsPollIntervalMs ?? DEFAULT_SETTINGS_POLL_INTERVAL_MS;
    if (pollMs > 0 && syncsAnySettings(this.scope)) {
      this.settingsTimer = this.platform.every(pollMs, () => this.runSettingsPoll());
      this.settingsTimer.unref?.();
    }

    // The event source was wired only after the bind returned, so an edit made while a
    // slow bind ran was never seen by it. One ordinary pass now carries it out — the
    // periodic pass would do the same thing five minutes later. A fast bind pays
    // nothing; `Infinity` disables the catch-up, `0` makes it unconditional.
    const catchUpAfter = this.opts.postBindReconcileAfterMs ?? DEFAULT_POST_BIND_RECONCILE_AFTER_MS;
    if (this.bindCompleted && Date.now() - bindStartedAt >= catchUpAfter) {
      this.runReconcile("post-bind catch-up");
    }
  }

  /**
   * Resolve once no event, reconcile or settings job is in flight.
   *
   * `stop()` cannot cancel work already inside the engine — it only stops new work — and
   * a vault lease must not be released while that work is still writing. A handoff that
   * releases early lets the next host start on top of an in-flight pass, which is exactly
   * what the lease exists to prevent.
   */
  async whenIdle(): Promise<void> {
    for (;;) {
      // Every engine this host stopped stays under watch for the whole loop: an
      // OpQueue job enqueued before `stop()` can still call into it, and the deferred
      // job that follows is not counted by `background`.
      const engines =
        this.engineInstance !== null
          ? [...this.drainingEngines, this.engineInstance]
          : [...this.drainingEngines];
      const draining = this.drainingEngines.size;
      for (const engine of engines) await engine.whenIdle();
      const idle =
        this.background === 0 &&
        !this.reconciling &&
        !this.localBurstOwed &&
        !this.localBurstRunning &&
        this.ops.running === 0 &&
        this.ops.queued === 0;
      if (!idle) {
        await new Promise<void>((resolve) => {
          this.platform.after(50, resolve);
        });
        continue;
      }
      // The counters are zero; drain once more in case an OpQueue job that finished
      // while they were read queued a deferred engine job, then re-read both.
      for (const engine of engines) await engine.whenIdle();
      if (
        this.background === 0 &&
        !this.reconciling &&
        !this.localBurstOwed &&
        !this.localBurstRunning &&
        this.ops.running === 0 &&
        this.ops.queued === 0 &&
        this.drainingEngines.size === draining
      ) {
        // Remove exactly the engines this pass watched: a `stop()` that ran during
        // the drain added a new one, and the loop starts over for it.
        for (const engine of engines) this.drainingEngines.delete(engine);
        return;
      }
    }
  }

  /** Stop the event source, the timers and the WebSocket, and drop the engine. */
  stop(): void {
    this.generation++;
    this.stopped = true;
    // A pass waiting out a rate limiter must not hold this host (and its lease) for the
    // server's window: the wait rejects at once and the pass reports its refusal.
    this.waitAbort?.abort();
    this.waitAbort = null;
    this.stopEvents?.();
    this.stopEvents = null;
    this.cancelBindRetry();
    if (this.localBurstTimer !== null) {
      this.localBurstTimer.cancel();
      this.localBurstTimer = null;
    }
    // A restart's bind pass scans the whole vault, so a burst this host had not carried
    // out yet has nothing to wait for.
    this.localBurstOwed = false;
    this.pendingBurstChanges.clear();
    this.pendingBurstDeletes.clear();
    this.pendingBurstRenames.clear();
    this.localEventsInWindow = 0;
    this.localEventWindowStart = 0;
    if (this.pushFlushTimer !== null) {
      this.pushFlushTimer.cancel();
      this.pushFlushTimer = null;
    }
    // The socket is gone: notifications held for it are dropped, and the next pass
    // reads the index instead.
    this.pendingPushes = [];
    if (this.reconcileTimer !== null) {
      this.reconcileTimer.cancel();
      this.reconcileTimer = null;
    }
    if (this.settingsTimer !== null) {
      this.settingsTimer.cancel();
      this.settingsTimer = null;
    }
    this.settingsPollFailed = false;
    this.ws?.disconnect();
    this.ws = null;
    // The socket is gone, so a push started from a stale api must not claim a
    // session the server no longer has open.
    this.opts.api.setSessionId?.(null);
    if (this.engineInstance !== null) this.drainingEngines.add(this.engineInstance);
    this.engineInstance = null;
  }

  // ── Internals ──

  private engineOptions(generation: number, waitAbort: AbortController): EngineOptions {
    return {
      vaultId: this.opts.vaultId,
      adapter: this.opts.adapter,
      api: this.opts.api,
      encryptionKey: this.opts.encryptionKey,
      syncScope: this.scope,
      // The pass and the event queue are separate pools, but both are sized for the same
      // host: a phone gets four small operations and one large file at a time in either.
      opLimits: this.opLimits,
      // `stop()` aborts this: a pass waiting out a limiter window must not outlive the
      // host that asked for it (see `waitAbort`).
      wait: (ms) => waitForAbort(ms, waitAbort.signal, this.platform),
      platform: this.platform,
      onConflictResolved: this.opts.onConflictResolved,
      onFileTooLarge: this.opts.onFileTooLarge,
      onFileSkipped: this.opts.onFileSkipped,
      onSettingsApplied: this.opts.onSettingsApplied,
      onSyncActivity: this.opts.onSyncActivity,
      onProgress: this.opts.onProgress,
      onRateLimited: this.opts.onRateLimited,
      // A deferred event's push/pull has no other surface; the host's failure path logs
      // it and stops on an auth failure, like every other background failure.
      onError: (err, paths) => this.fail(`a queued local event for ${paths.join(", ")}`, err),
      // A pass that outlived its host must not write the state it read back over what a
      // restarted host has already saved. The engine cannot be cancelled between files,
      // so the write is what is dropped.
      onSaveState: (json) => {
        if (this.stopped || this.generation !== generation) return;
        this.opts.stateStore.save(json);
      },
    };
  }

  private log(message: string, err?: unknown): void {
    if (this.opts.log) this.opts.log(message, err);
    else if (err === undefined) console.error(`Courier: ${message}`);
    else console.error(`Courier: ${message}:`, err);
  }

  /**
   * Report a failed piece of work, stopping the host when the credential — or the
   * binding itself — is gone.
   *
   * Every failure path goes through here, because a dead credential is not one more
   * transient error: retrying it every pass produced a client that looked like it was
   * syncing while every request it made was refused. A 401/403 stops the host first and
   * reports after, the same order the WebSocket path has always used. A `404` means the
   * vault is gone (or was never this account's), which ends the binding but keeps the
   * key: it is reported as a deleted vault, not as a revoked credential.
   */
  private fail(label: string, err: unknown): void {
    const reason = authFailureReason(err);
    if (reason === null) {
      if (isVaultGone(err)) {
        if (this.stopped) return;
        this.log(`${label} failed: the vault is gone`, err);
        this.stop();
        this.opts.onVaultDeleted?.();
        return;
      }
      // An ordinary failure is reported even after `stop()`: the pass that was in
      // flight when the host stopped still owes its refusal to the log.
      this.log(`${label} failed`, err);
      return;
    }
    // Already stopped: this is a second pass reporting the same dead credential, and
    // reporting it again would call the host back for an event it has handled.
    if (this.stopped) return;
    this.log(`${label} failed: the credential is no longer usable (${reason})`, err);
    this.stop();
    this.opts.onAuthFailure?.(reason);
  }

  /**
   * True until a bind pass has completed.
   *
   * A failed bind keeps this true: the host retries as a bind, and until one succeeds
   * every pass merges rather than applies. A status surface can use it to say "first sync
   * in progress" instead of "not synced" — the two look identical otherwise, and the
   * second one reads as a fault.
   */
  get binding(): boolean {
    return this.engineInstance !== null && !this.bindCompleted;
  }

  /**
   * True only while the pass is a vault's **first** sync.
   *
   * `binding` is true on every start (the first pass of every process is a bind pass,
   * which is what merges instead of applying deletions). This is the narrower fact a
   * status surface needs to say "first sync" honestly, and it is about the vault rather
   * than this process: it holds only while that pass is still a bind **and** no bind has
   * ever completed here (the state store's flag). A bind killed after 30 000 of 50 000
   * files therefore still reports a first sync on the next start — the vault is not bound
   * yet, however much state the killed pass managed to persist.
   */
  get firstSync(): boolean {
    return this.binding && !this.bindEverCompleted;
  }

  /**
   * Record that a bind pass completed.
   *
   * Written to the state store once per device and vault: from the next start on,
   * `firstSync` is false even while that start's bind pass is still running.
   */
  private markBindCompleted(): void {
    const firstCompletion = !this.bindEverCompleted;
    this.bindCompleted = true;
    this.bindEverCompleted = true;
    if (!firstCompletion) return;
    try {
      this.opts.stateStore.saveBindCompleted?.();
    } catch (err) {
      // A store that cannot record the flag costs a repeated "first sync" label, never
      // the pass itself.
      this.log("recording the completed bind failed", err);
    }
  }

  private syncSessionId(): void {
    this.opts.api.setSessionId?.(this.ws?.getSessionId() ?? null);
  }

  /**
   * Run a sync triggered by an app event.
   *
   * Vault events and websocket messages are synchronous, so nothing can await
   * these calls: their failures have to be handled right here, or one dropped
   * connection turns every later push into an unhandled rejection. The next event
   * or reconcile picks the file up again.
   */
  private runInBackground(label: string, run: () => Promise<unknown> | undefined): void {
    this.background += 1;
    void Promise.resolve()
      .then(run)
      .catch((err: unknown) => this.fail(label, err))
      .finally(() => {
        this.background -= 1;
      });
  }

  /**
   * Hold one `file_pushed` for the next batched chain pull.
   *
   * A full batch goes out immediately; a lone notification waits
   * {@link PUSH_NOTIFICATION_FLUSH_MS}, which is far below what a user can notice and
   * far above the gap between two notifications of the same bind.
   */
  private queuePushedFile(event: { fileId: string; versionId: string; deviceName?: string }): void {
    // Consume the echo now, while its record is fresh: the batch may not be applied
    // until seconds later, and the record has a deadline.
    if (this.engineInstance?.consumeOwnPush(event.versionId) === true) return;
    this.pendingPushes.push({
      fileId: event.fileId,
      versionId: event.versionId,
      deviceName: event.deviceName ?? null,
    });
    if (this.pendingPushes.length >= PUSH_NOTIFICATION_BATCH) {
      this.flushPushedFiles();
      return;
    }
    this.pushFlushTimer ??= this.platform.after(PUSH_NOTIFICATION_FLUSH_MS, () =>
      this.flushPushedFiles(),
    );
  }

  /** Send the held notifications as one batch; a no-op when nothing is held. */
  private flushPushedFiles(): void {
    if (this.pushFlushTimer !== null) {
      this.pushFlushTimer.cancel();
      this.pushFlushTimer = null;
    }
    if (this.pendingPushes.length === 0) return;
    const batch = this.pendingPushes;
    this.pendingPushes = [];
    const engine = this.engineInstance;
    if (!engine) return;
    this.runQueued("pull", null, () => engine.handleFilePushedBatch(batch));
  }

  /**
   * The same, but through {@link OpQueue}: bounded, with the large files serialised.
   *
   * An event handler cannot wait, so without this a folder dropped into the vault —
   * one event per file, all in the same tick — starts a full-file read, hash and
   * encryption for every file at once. The weight comes from the file's size when
   * the event carries one; an unknown size is treated as exclusive.
   */
  private runQueued(
    label: string,
    sizeBytes: number | null,
    run: () => Promise<unknown> | undefined,
  ): void {
    this.ops.enqueue(label, weightForSize(this.opLimits, sizeBytes), run);
  }

  /**
   * Hand one local vault event to the engine, or hold it for a burst batch.
   *
   * A single edit keeps its immediate per-path push. Once this window holds more events
   * than {@link LOCAL_EVENT_BURST_SIZE}, the host stops pushing one file at a time and
   * collects their paths; {@link LOCAL_EVENT_BURST_FLUSH_MS} later the engine carries them
   * out as **one job**, whose creates travel 100 files per request
   * (`SyncEngine.handleLocalChanges`). That is what keeps a bulk write inside the server's
   * sync allowance without a full pass — the vault is never scanned.
   *
   * `own` marks an event the engine itself caused (its own pull's write). Those are queued
   * exactly as before but never counted: a 1 000-file pull fires 1 000 `modify` events, and
   * counting them would batch behind every large download.
   *
   * A held event is not queued: the batch job re-reads its file from disk and decides it
   * exactly as the event would have (including the rename and adoption rules), so nothing
   * is lost by waiting for the batch.
   */
  private dispatchLocalEvent(
    kind: "changed" | "deleted" | "renamed",
    label: string,
    from: string,
    to: string | null,
    sizeBytes: number | null,
    own: boolean,
    run: () => Promise<unknown> | undefined,
  ): void {
    if (own) {
      this.runQueued(label, sizeBytes, run);
      return;
    }
    const now = Date.now();
    if (now - this.localEventWindowStart > LOCAL_EVENT_BURST_WINDOW_MS) {
      this.localEventWindowStart = now;
      this.localEventsInWindow = 0;
    }
    this.localEventsInWindow += 1;
    if (this.localEventsInWindow > LOCAL_EVENT_BURST_SIZE) {
      if (kind === "deleted") this.pendingBurstDeletes.add(from);
      else if (kind === "renamed" && to !== null) this.pendingBurstRenames.set(from, to);
      else if (kind === "changed") this.pendingBurstChanges.add(from);
      this.scheduleLocalBurst();
      return;
    }
    this.runQueued(label, sizeBytes, run);
  }

  /**
   * Ask for the collected burst paths to be carried out, once.
   *
   * At most one hand-off is armed, and one job runs at a time: paths that arrive while a
   * job runs set the flag again and the job's tail arms the next hand-off, so the vault
   * converges on the last file the burst wrote however long the burst lasts — without two
   * jobs deciding about the same paths concurrently.
   */
  private scheduleLocalBurst(): void {
    // A late event from a host that has been stopped owes nothing: nothing would run the
    // job, and `whenIdle` would wait for it forever.
    if (this.stopped) return;
    this.localBurstOwed = true;
    if (this.localBurstTimer !== null || this.localBurstRunning) return;
    const timer = this.platform.after(LOCAL_EVENT_BURST_FLUSH_MS, () => {
      this.localBurstTimer = null;
      this.runLocalBurst();
    });
    timer.unref?.();
    this.localBurstTimer = timer;
  }

  /** Hand the collected paths to the engine, unless a job is already running. */
  private runLocalBurst(): void {
    if (this.stopped || !this.localBurstOwed) return;
    const engine = this.engineInstance;
    if (engine === null) return;
    if (this.localBurstRunning) return;
    const changed = [...this.pendingBurstChanges];
    const deleted = [...this.pendingBurstDeletes];
    const renamed = [...this.pendingBurstRenames].map(([from, to]) => ({ from, to }));
    this.pendingBurstChanges.clear();
    this.pendingBurstDeletes.clear();
    this.pendingBurstRenames.clear();
    this.localBurstOwed = false;
    if (changed.length === 0 && deleted.length === 0 && renamed.length === 0) return;
    // Say how big the burst was: a host that logs this after one save is looking at a
    // watcher that reports one save as a burst (the threshold is 4 events in 500 ms; an
    // ordinary save is one, a create at most two).
    this.log(
      `local burst: ${changed.length} changed, ${deleted.length} deleted, ` +
        `${renamed.length} renamed in one batched push`,
    );
    this.localBurstRunning = true;
    // One job for the whole batch: it reads, decides and sends 100 files per request.
    // Unknown size (null) makes it exclusive, like a notification batch — the job itself
    // bounds how much it holds.
    this.runQueued("local burst", null, async () => {
      try {
        await engine.handleLocalEvents({ changed, deleted, renamed });
      } finally {
        this.localBurstRunning = false;
        // Paths that arrived while this job ran were not covered by it.
        if (this.localBurstOwed) this.scheduleLocalBurst();
      }
    });
  }

  /**
   * Run one full reconcile, never two at once.
   *
   * Two callers want this at unrelated moments — the periodic safety net and a
   * WebSocket that just came back — and a reconcile is not reentrant, so the second
   * caller is dropped rather than queued: whatever it would have found is found by
   * the pass already running.
   */
  private runReconcile(label: string): void {
    const engine = this.engineInstance;
    if (!engine || this.reconciling) return;
    this.reconciling = true;
    this.runInBackground(label, async () => {
      try {
        // A pass that has never completed a bind has to *be* one: `bind-merge` is
        // what keeps a first connection from applying a tombstone to a local file it
        // never merged against. Erring this way is deliberate — the other direction
        // deletes notes.
        await engine.initialSync({
          firstBind: !this.bindCompleted,
          priorityPaths: this.priorityPaths(),
        });
        this.markBindCompleted();
        // A completed bind cancels the retry loop: the JSDoc says so, and a timer left
        // armed fires one extra pass behind a reconnect that already finished the job.
        this.cancelBindRetry();
      } finally {
        this.reconciling = false;
        // Still no completed bind: retry on the fast schedule instead of waiting for
        // the periodic pass. A rejection is logged by `runInBackground`.
        if (!this.bindCompleted) this.scheduleBindRetry();
      }
    });
  }

  /**
   * Retry a failed bind after a backoff, unless one is already scheduled.
   *
   * The delay doubles up to the periodic interval, which is where it stops being useful:
   * the periodic pass already covers that gap.
   */
  private scheduleBindRetry(): void {
    if (this.stopped || this.bindRetryTimer !== null) return;
    const delay = this.bindRetryMs;
    this.bindRetryMs = Math.min(BIND_RETRY_MAX_MS, this.bindRetryMs * 2);
    const timer = this.platform.after(delay, () => {
      this.bindRetryTimer = null;
      if (this.stopped) return;
      this.runReconcile("bind retry");
    });
    timer.unref?.();
    this.bindRetryTimer = timer;
  }

  /** Drop a scheduled bind retry (a later pass succeeded, or the host is stopping). */
  private cancelBindRetry(): void {
    if (this.bindRetryTimer !== null) {
      this.bindRetryTimer.cancel();
      this.bindRetryTimer = null;
    }
    this.bindRetryMs = BIND_RETRY_INITIAL_MS;
  }

  /**
   * The user's paths for this pass, or none when the host has no such notion.
   *
   * A workspace lookup can throw on a host that is shutting down; a preference must
   * never be the reason a sync pass fails, so the failure is logged and the pass runs
   * in its ordinary order.
   */
  private priorityPaths(): readonly string[] {
    try {
      return this.opts.getPriorityPaths?.() ?? [];
    } catch (err) {
      this.log("reading the priority paths failed", err);
      return [];
    }
  }

  /**
   * Push local changes in the synced settings files.
   *
   * Its own error handling rather than {@link runInBackground}: this runs every 30
   * seconds, and a machine that is simply offline would otherwise log the same
   * failure 120 times an hour.
   */
  private runSettingsPoll(): void {
    const engine = this.engineInstance;
    if (!engine) return;
    // Tracked like every other background pass: a lease must not be released while a
    // settings write is still in flight.
    this.background += 1;
    void engine
      .syncLocalSettings()
      .then(
        () => {
          this.settingsPollFailed = false;
        },
        (err: unknown) => {
          // A dead credential must not be retried every 30 seconds: the poll is a pass
          // like any other, so it goes through the same terminal check. An ordinary
          // outage is reported once per run of failures, as before.
          if (authFailureReason(err) !== null || isVaultGone(err)) {
            this.fail("the settings poll", err);
            return;
          }
          if (this.settingsPollFailed) return;
          this.settingsPollFailed = true;
          this.log("settings poll failed", err);
        },
      )
      .finally(() => {
        this.background -= 1;
      });
  }

  private handleWsEvent(event: WsEvent): void {
    switch (event.type) {
      case "file_pushed":
        // Coalesced, not applied one by one: a bind announces one version per file, and
        // one chain request per notification is what tripped the sync limiter on a live
        // peer (`handleFilePushedBatch`). The burst is queued as unknown-size work, which
        // is treated as exclusive — a peer's 50 MiB attachment arrives on this path.
        this.queuePushedFile(event);
        break;
      case "state_change":
        this.opts.onStateChange?.(event.state);
        if (event.state === "connected") {
          // A reconnect is the one moment the vault can be arbitrarily stale: the
          // server keeps no backlog, so every `file_pushed` sent while the socket was
          // down is gone, and the periodic pass is minutes away.
          //
          // The *first* connect is not that moment — it is the socket `start()` just
          // opened, right behind the bind pass, so there is nothing to catch up on.
          // Reconciling there used to race the user's own first edits.
          if (this.socketHasConnected) this.runReconcile("reconnect reconcile");
          this.socketHasConnected = true;
        }
        break;
      case "user_key_revoked":
        // The credential is dead: everything this host runs would keep failing, so
        // it stops first and reports after (the CLI used to only log "Sync stopped"
        // while its watcher and interval kept running against a dead key).
        this.stop();
        this.opts.onAuthFailure?.("revoked");
        return;
      case "user_key_disabled":
        // The key is paused, not gone: the host stops the same way, and the host's
        // policy decides that the binding (and the data behind it) stays.
        this.stop();
        this.opts.onAuthFailure?.("disabled");
        return;
      case "subscribe_error": {
        // The socket reconnects by itself; a refusal that names a dead credential, or a
        // vault that no longer exists, is the host's to act on. Anything else (a server
        // still starting, a rate limiter) is logged and left to the next attempt.
        const reason = authFailureReason({ code: event.code });
        if (reason !== null) {
          this.stop();
          this.opts.onAuthFailure?.(reason);
          return;
        }
        if (event.code === "NOT_FOUND") {
          this.stop();
          this.opts.onVaultDeleted?.();
          return;
        }
        this.log(`subscribing to the vault failed: ${event.message}`);
        break;
      }
      case "vault_deleted":
        this.stop();
        this.opts.onVaultDeleted?.();
        return;
      case "vault_settings":
        // Display state only: the server trims by the numbers it stores, so a host that
        // ignores this event syncs exactly the same.
        this.opts.onVaultSettings?.(event.historyLimits);
        break;
    }
    this.syncSessionId();
  }
}
