import { watch, type FSWatcher } from "fs";
import { hostname } from "os";
import {
  LEASE_RENEW_MS,
  SyncEngine,
  SyncHost,
  SyncLease,
  importRawKey,
  isSyncablePath,
  type ConflictResolvedEvent,
  type FileTooLargeEvent,
  type SyncApi,
  type SyncEventSource,
  type SyncLeaseInfo,
  type SyncScope,
} from "@courier/engine";
import { httpToWsUrl } from "@courier/shared";
import { plural, t } from "./i18n";
import { FsAdapter } from "./fs-adapter";
import { createCliClient, createCliSyncApi } from "./api";
import { LeaseStore, watchLeaseRelease } from "./lease";
import {
  loadBindCompleted,
  loadConfig,
  loadState,
  saveBindCompleted,
  saveState,
  syncScopeOf,
  vaultDeviceName,
  vaultLabel,
  type CliConfig,
  type CliVault,
} from "./config";
import { RuntimeWriter } from "./runtime";
import { cliPlatform } from "./platform";
import { clearActivityLog, recordRunActivity } from "./history";

/**
 * How long a burst of filesystem events is collected before it is answered.
 *
 * `fs.watch` reports several events per write and does not say which kind it was,
 * so the burst is coalesced and each path is then answered by reading it.
 */
const WATCH_DEBOUNCE_MS = 300;

/**
 * How often a process that could not take the vault lease retries it.
 *
 * There is no cross-process notification for a released filesystem lock, so the waiter
 * polls. Half a second keeps a handoff imperceptible without turning a waiting vault into
 * a busy loop; the read is one small file.
 */
const LEASE_RETRY_MS = 500;

export interface RunOptions {
  once?: boolean;
  intervalMinutes?: number;
  onLog?: (message: string) => void;
  /** Lease retry period; shorter in tests. */
  leaseRetryMs?: number;
  /**
   * Lease TTL; shorter in tests.
   *
   * The renewal period is derived from it, so a test can watch several renewals inside a
   * pass that would otherwise outlast the record.
   */
  leaseTtlMs?: number;
  /**
   * Take the vault from the writer that holds it, once, the first time it is refused.
   *
   * This is the headless half of the plugin's takeover: it exists for a writer the user
   * cannot end, and it is never implicit. It happens **once per process** — a run that
   * loses the vault afterwards waits for it like any other, so two `--take-over` daemons
   * cannot end up taking it back from each other forever.
   */
  takeOver?: boolean;
  /**
   * Called when a failure after the first attempt stops the daemon (the CLI exits
   * non-zero). A failure before the first attempt rejects `runDaemon` instead.
   */
  onFatal?: (err: Error) => void;
}

export interface RunnerHandle {
  /** Null until the first pass starts, and again while another writer holds the lease. */
  engine: SyncEngine | null;
  /** Stops the host and releases the vault lease; resolve before exiting the process. */
  stop(): Promise<void>;
}

/** Resolve after `ms`; a stopped daemon exits without waiting for the timer. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(opts: RunOptions, message: string): void {
  (opts.onLog ?? console.log)(message);
}

/** The message of an unknown thrown value, for a translated log/error line. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The writer a takeover is about to displace, in words.
 *
 * A headless takeover prints it **before** the record is replaced: the log is the only
 * place a user can find out afterwards whose process was ended, and a `--take-over` that
 * silently displaced the wrong writer is a support question with no evidence left.
 */
function leaseHolderLabel(info: SyncLeaseInfo | null): string {
  if (info === null) return t("cli.lease.holderUnknown");
  const parts = [t(info.owner === "cli" ? "cli.lease.ownerCli" : "cli.lease.ownerPlugin")];
  if (info.pid > 0) parts.push(t("cli.lease.pid", { pid: String(info.pid) }));
  if (info.host) parts.push(t("cli.lease.host", { host: info.host }));
  return parts.join(" · ");
}

/**
 * One line per resolved conflict, for the daemon's log.
 *
 * The CLI has no UI: journald is where a user finds out that a note was overwritten
 * by the remote version and where their own text went.
 */
function conflictLogLine(event: ConflictResolvedEvent): string {
  if (!event.conflictPath) {
    return event.remoteAction === "delete"
      ? t("cli.log.conflict.remoteDelete", { path: event.plainPath })
      : t("cli.log.conflict.remoteAdopted", { path: event.plainPath });
  }
  return t("cli.log.conflict.parked", {
    path: event.plainPath,
    conflictPath: event.conflictPath,
  });
}

/**
 * One line per file the size cap skipped, for the daemon's log.
 *
 * Without it a large attachment simply never arrives and nothing says why; `status`
 * reports the same files when the daemon is not running.
 */
function tooLargeLogLine(event: FileTooLargeEvent): string {
  const megabytes = (event.sizeBytes / (1024 * 1024)).toFixed(1);
  return t("cli.log.tooLarge", { path: event.plainPath, megabytes });
}

/** The conflict files parked in one vault — the CLI's only durable conflict trail. */
async function parkedConflictFiles(vault: CliVault, maxFileBytes: number): Promise<string[]> {
  return new FsAdapter(vault.vaultPath, syncScopeOf(vault, maxFileBytes)).listConflictFiles();
}

/**
 * The account's administrator-set file cap, read from `GET /api/me` at startup.
 *
 * It is not a CLI option: the administrator sets it per key, and a process must use
 * the current value before it reads any file. Every vault on this machine shares the
 * same user key, so each process makes this one read for itself. A failed read keeps the
 * cached value (`register`/`vault connect` wrote it) or the engine default, and reports
 * once — the bind pass reports the outage itself.
 */
async function accountMaxFileBytes(
  config: CliConfig,
  vault: CliVault,
  opts: RunOptions,
): Promise<number> {
  try {
    const me = await createCliClient({
      serverUrl: config.serverUrl,
      userKey: config.userKey,
    }).getMe();
    return me.maxFileBytes;
  } catch (err) {
    const cached = syncScopeOf(vault, config.accountMaxFileBytes).maxFileBytes;
    log(
      opts,
      t("cli.log.limitsUnavailable", { error: String(err), megabytes: cached / (1024 * 1024) }),
    );
    return cached;
  }
}

/** Build a sync engine for one vault. */
async function buildEngine(
  config: CliConfig,
  vault: CliVault,
  opts: RunOptions,
  maxFileBytes: number,
  api?: SyncApi,
): Promise<SyncEngine> {
  const key = await importRawKey(vault.encryptionKeyB64);
  const scope = syncScopeOf(vault, maxFileBytes);
  const adapter = new FsAdapter(vault.vaultPath, scope);
  const syncApi = api ?? createCliSyncApi(cliSyncApiOptions(config, vault));
  const engine = new SyncEngine({
    vaultId: vault.vaultId,
    platform: cliPlatform,
    adapter,
    api: syncApi,
    encryptionKey: key,
    syncScope: scope,
    onConflictResolved: (event) => log(opts, conflictLogLine(event)),
    onFileTooLarge: (event) => log(opts, tooLargeLogLine(event)),
    // No run history for `run --once`: a supervisor has no process or row for it, so its
    // events would land in the previous daemon run's file.
    onSaveState: (json) => saveState(vault.vaultId, json),
  });
  return engine;
}

/**
 * The sync API for this machine.
 *
 * The device label is read from the config file on **every push**, because
 * `courier-cli device rename` is a separate process: a daemon that captured the
 * name at startup would keep stamping the old one into the sync history until it
 * was restarted.
 */
function cliSyncApiOptions(
  config: CliConfig,
  vault: CliVault,
): {
  serverUrl: string;
  userKey: string;
  getDeviceName: () => string;
} {
  return {
    serverUrl: config.serverUrl,
    userKey: config.userKey,
    // Per binding, read fresh on every push: `vault update --device-name` and
    // `device rename` are separate processes.
    getDeviceName: () => {
      const fresh = loadConfig() ?? config;
      return vaultDeviceName(
        fresh,
        fresh.vaults.find((entry) => entry.vaultId === vault.vaultId) ?? vault,
      );
    },
  };
}

/**
 * The pass a process runs when it starts: a **bind**, because the process arrives with no
 * live sync state, so a file the server no longer has is the user's own.
 *
 * It throws when the pass fails. `run --once` wants exactly that; the daemon does not —
 * see {@link runDaemon}.
 */
async function runBindPass(
  vault: CliVault,
  opts: RunOptions,
  engine: SyncEngine,
  maxFileBytes: number,
): Promise<void> {
  const persisted = loadState(vault.vaultId);
  if (persisted) engine.loadState(persisted);
  const t0 = Date.now();
  await engine.initialSync({ firstBind: true });
  // A one-shot process still finishes the bind: the next daemon must not call its own
  // startup scan a first sync just because this process did not stay alive to say so.
  saveBindCompleted(vault.vaultId);
  const parked = await parkedConflictFiles(vault, maxFileBytes);
  log(
    opts,
    plural("cli.log.reconciled.one", "cli.log.reconciled.other", parked.length, {
      milliseconds: Date.now() - t0,
      count: parked.length,
    }),
  );
}

/**
 * One-shot reconcile pass (used by `run --once` and the daemon startup).
 *
 * An optional `api` lets the daemon share the client that carries the WebSocket
 * session id. A one-shot process has no socket, so its pushes are neither
 * identified nor excluded — the engine's own echo suppression covers that case.
 */
export async function runOnceSync(
  config: CliConfig,
  vault: CliVault,
  opts: RunOptions = {},
  api?: SyncApi,
): Promise<SyncEngine> {
  // First come, first served. A one-shot pass has no supervisor to park it, so it refuses
  // when the lease is already held; running under Obsidian is fine when the lease is free.
  const lease = new SyncLease({
    store: new LeaseStore(vault.vaultPath),
    owner: "cli",
    // Recorded so a reader can tell whether this pid is evidence on its own machine.
    host: hostname(),
    process: cliPlatform.process,
    ...(opts.leaseTtlMs === undefined ? {} : { ttlMs: opts.leaseTtlMs }),
  });
  let acquired: boolean;
  try {
    acquired = await lease.acquire();
    if (!acquired && opts.takeOver) {
      log(
        opts,
        t("cli.log.takingOver", {
          holder: leaseHolderLabel(await lease.read()),
          vault: vaultLabel(vault),
        }),
      );
      acquired = await lease.takeOver();
      if (!acquired) log(opts, t("cli.error.takeOverFailed"));
    }
  } catch (err) {
    throw new Error(t("cli.error.leaseFailed", { error: errorMessage(err) }), { cause: err });
  }
  if (!acquired) throw new Error(t("cli.error.syncLocked"));
  // A one-shot pass has no loop to renew from; see `keepLeaseFresh`.
  const renewDuringPass = keepLeaseFresh(lease);
  try {
    const maxFileBytes = await accountMaxFileBytes(config, vault, opts);
    const engine = await buildEngine(config, vault, opts, maxFileBytes, api);
    await runBindPass(vault, opts, engine, maxFileBytes);
    return engine;
  } finally {
    // The one-shot pass is done; the engine is not going to run a loop.
    renewDuringPass();
    await lease.release();
  }
}

/**
 * Keep a one-shot pass's lease fresh until its pass ends, and answer the function that
 * stops it.
 *
 * `run --once` has no loop to renew from, and a pass over a large vault runs for minutes —
 * far longer than the record's TTL. Without this the writer the takeover displaced, still
 * waiting and still retrying, takes the vault back in the middle of the pushes: two engines
 * on one folder, which is exactly the rule the lease exists to keep. The period is a
 * quarter of the TTL so a slow pass cannot let the record lapse between two renewals.
 */
export function keepLeaseFresh(lease: SyncLease): () => void {
  const timer = setInterval(
    () => void lease.renew().catch(() => false),
    Math.max(25, Math.floor(lease.ttlMs / 4)),
  );
  return () => clearInterval(timer);
}

/**
 * Watch one vault folder, keep its WebSocket connected, and re-reconcile on an
 * interval so the headless machine stays in sync even when Obsidian is closed.
 *
 * One process owns one vault: two vaults mean two processes (and two runtimes, two
 * logs, two starts/stops). That is deliberate — a failure or a restart of one vault
 * must not touch another, and a supervisor shows each one on its own row.
 *
 * The loop itself is `SyncHost` (`@courier/engine`) — the same one the Obsidian
 * plugin runs, with the same rules about bind passes, single-flight reconciles and
 * reconnects. What is left here is what a headless machine is: an `fs.watch` event
 * source, a config-file state store, and log lines.
 *
 * A **startup** pass that fails does not end the daemon: the loop it is about to
 * build — the watcher, the socket, the interval — is exactly what retries it.
 */
export async function runDaemon(
  config: CliConfig,
  vault: CliVault,
  opts: RunOptions = {},
): Promise<RunnerHandle> {
  const vaultPath = vault.vaultPath;
  const retryMs = opts.leaseRetryMs ?? LEASE_RETRY_MS;
  // A vault this machine has never finished binding has no completion record, even when a
  // killed bind left part of its state behind: that is what makes the coming pass a *first*
  // sync rather than a startup scan of a bound vault.
  const firstSync = (): boolean => !loadBindCompleted(vault.vaultId);
  const runtime = new RuntimeWriter(
    vault,
    config.serverUrl,
    vaultDeviceName(config, vault),
    () => new Date(),
    firstSync(),
  );
  const lease = new SyncLease({
    store: new LeaseStore(vault.vaultPath),
    owner: "cli",
    // Recorded so a reader can tell whether this pid is evidence on its own machine.
    host: hostname(),
    process: cliPlatform.process,
  });
  let host: SyncHost | null = null;
  let stopped = false;
  let fatal = false;
  let startupError: Error | null = null;
  let leaseHeld = false;
  let leaseWaiting = false;
  /** `--take-over` asks once and is spent by that answer; see the loop below. */
  let takeOverAsked = false;
  /** Cleared once, when this run first gets the vault: the history describes this run. */
  let historyStarted = false;
  let renewal: ReturnType<typeof setInterval> | null = null;
  let leaseWatchStop: (() => void) | null = null;
  let wakeLeaseWait: (() => void) | null = null;
  let wakeHostWait: (() => void) | null = null;

  const closeLeaseWatch = (): void => {
    leaseWatchStop?.();
    leaseWatchStop = null;
  };

  /**
   * One watcher, two roles: wake a waiter when the holder releases, and let the holder
   * notice a takeover in milliseconds instead of at its next renewal.
   *
   * The holder branch only **reads** the record (`stillOwner`); the five-second renewal
   * stays what keeps this process's record fresh for every other writer. A watcher that
   * renewed would be woken by its own heartbeat on every tick.
   */
  const onLeaseDirectoryChange = (): void => {
    if (leaseHeld) {
      void checkLeaseOwnership();
      return;
    }
    wakeLeaseWait?.();
  };

  /**
   * The watcher, installed for whichever role this process is in.
   *
   * While waiting it is what turns a release into an immediate start; while holding it is
   * what turns a takeover into an immediate stop. The timer paths (500 ms retry, 5 s
   * renewal) stay as the fallback for a filesystem that reports nothing.
   */
  const watchLease = (): void => {
    if (leaseWatchStop) return;
    leaseWatchStop = watchLeaseRelease(vaultPath, onLeaseDirectoryChange);
  };

  const waitForLease = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      watchLease();
      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (wakeLeaseWait === finish) wakeLeaseWait = null;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, ms);
      wakeLeaseWait = finish;
    });

  const stopRenewal = (): void => {
    if (renewal) clearInterval(renewal);
    renewal = null;
  };

  /**
   * Drop the running host, and wake the loop that is waiting on it.
   *
   * Both ways out of a running host — a lost lease and `stop()` — go through here, so the
   * wait below cannot be left polling for a host that is already gone.
   */
  const clearHost = (): void => {
    host = null;
    wakeHostWait?.();
  };

  /**
   * Wait until the running host is gone.
   *
   * The host outlives a successful start until its lease stops renewing (another writer
   * took over) or the process is stopped; both clear `host` and call the wake above. The
   * timer is the fallback for a wake that never comes (a suspended process, a lost event):
   * it re-arms while a host is still running, so a missed wake can only delay this wait,
   * never let a second host start over the live one.
   */
  const waitUntilHostGone = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        if (host !== null && !stopped && !fatal) {
          timer = setTimeout(finish, ms);
          return;
        }
        if (wakeHostWait === finish) wakeHostWait = null;
        resolve();
      };
      let timer: ReturnType<typeof setTimeout> = setTimeout(finish, ms);
      wakeHostWait = finish;
    });

  /**
   * The vault is gone: stop the engine before it writes anything else, and go back to
   * waiting. Shared by the renewal and by the watcher's read-only check, because both are
   * answering the same question and a second copy of this sequence would drift.
   */
  const loseLease = (): void => {
    leaseHeld = false;
    stopRenewal();
    host?.stop();
    clearHost();
    runtime.set({ phase: "waiting", reason: "other-writer", lastError: "" });
    log(opts, t("cli.log.leaseWaiting", { vault: vaultLabel(vault) }));
  };

  /**
   * Ask the record whether this process still holds the vault, without renewing it.
   *
   * This is what the directory watcher runs. It is the fast path only: a missed event
   * costs one renewal period, never correctness, and the 5-second renewal remains the
   * thing that keeps the record fresh for the other writers.
   */
  const checkLeaseOwnership = async (): Promise<void> => {
    if (!leaseHeld) return;
    // A failed read is not evidence of a takeover: only a record that was read and
    // belongs to somebody else ends this run's ownership.
    if (await lease.stillOwner().catch(() => true)) return;
    if (!leaseHeld) return;
    loseLease();
  };

  const renewLease = async (): Promise<void> => {
    if (!leaseHeld) return;
    const renewed = await lease.renew().catch(() => false);
    if (!leaseHeld) return; // released while the renewal was in flight
    if (renewed) return;
    loseLease();
  };

  // Releasing is terminal and has to be single-flight. The stop path and the run loop's
  // own cleanup can both ask — a signal and the supervisor's pipe closing are two events —
  // and a second call that returned at once would let the caller exit the process while the
  // first is still deleting the lease, leaving the directory (and its owner record) behind
  // for the plugin to wait on.
  let releasePromise: Promise<void> | null = null;
  const releaseLease = (): Promise<void> => {
    releasePromise ??= (async () => {
      leaseHeld = false;
      closeLeaseWatch();
      stopRenewal();
      await lease.release().catch(() => {});
    })();
    return releasePromise;
  };

  runtime.start();

  // The first attempt is awaited before the handle is returned. Callers (and the e2e
  // suite) may rely on a started daemon having either an engine or a lease-wait state
  // when `runDaemon` resolves; the later reconnects and resumes stay asynchronous.
  let resolveFirstAttempt: (() => void) | null = null;
  const firstAttempt = new Promise<void>((resolve) => {
    resolveFirstAttempt = resolve;
  });
  let firstSettled = false;
  const settleFirst = (): void => {
    if (firstSettled) return;
    firstSettled = true;
    resolveFirstAttempt?.();
  };
  /** The last progress tenth this run logged, so a pass prints at most eleven lines. */
  let lastProgressPercent = -10;

  /**
   * Build and start one host. The account's file cap is read here rather than once at
   * process start: the daemon may have waited hours for another writer's lease, and a cap an
   * administrator changed in the meantime must apply before the first file is read.
   */
  const startHost = async (): Promise<SyncHost | null> => {
    const maxFileBytes = await accountMaxFileBytes(config, vault, opts);
    // The lease may have been lost while the account read was in flight. Renew once
    // before building: a sleep longer than the TTL can let a contender take over while
    // the local flag still says "held".
    if (!leaseHeld || stopped || fatal) return null;
    if (!(await lease.renew().catch(() => false))) {
      leaseHeld = false;
      return null;
    }
    if (!historyStarted) {
      clearActivityLog(vault.vaultId);
      historyStarted = true;
    }
    const scope = syncScopeOf(vault, maxFileBytes);
    const next = new SyncHost({
      vaultId: vault.vaultId,
      encryptionKey: await importRawKey(vault.encryptionKeyB64),
      syncScope: scope,
      adapter: new FsAdapter(vaultPath, scope),
      api: createCliSyncApi(cliSyncApiOptions(config, vault)),
      wsUrl: httpToWsUrl(config.serverUrl),
      userKey: config.userKey,
      // Bun's timers, unref'd so an idle daemon can still exit.
      platform: cliPlatform,
      // Read from the config file, so `device rename` applies without a restart.
      getDeviceName: () => loadConfig()?.deviceName ?? config.deviceName,
      eventSource: fsWatchEventSource(vaultPath, scope, opts),
      stateStore: {
        load: () => loadState(vault.vaultId),
        save: (json) => saveState(vault.vaultId, json),
        loadBindCompleted: () => loadBindCompleted(vault.vaultId),
        saveBindCompleted: () => saveBindCompleted(vault.vaultId),
      },
      reconcileIntervalMs: (opts.intervalMinutes ?? 30) * 60_000,
      // No `settingsPollIntervalMs`: this host's scope never enables a config-folder
      // group, so the engine starts no settings poll on it (see `syncScopeOf`).
      log: (message, err) => log(opts, err === undefined ? message : `${message}: ${String(err)}`),
      onConflictResolved: (event) => log(opts, conflictLogLine(event)),
      onFileTooLarge: (event) => log(opts, tooLargeLogLine(event)),
      onFileSkipped: (event) => log(opts, t("cli.log.fileSkipped", { path: event.plainPath })),
      onSyncActivity: (event) => {
        runtime.touchActivity();
        recordRunActivity(vault.vaultId, event);
      },
      // A pass that waits out a limiter window says so: a minute of silence otherwise
      // looks like a hang, and the daemon's log is all a headless user has.
      onRateLimited: ({ waitMs }) =>
        log(opts, t("cli.log.rateLimited", { seconds: Math.ceil(waitMs / 1000) })),
      // A first pass over a large vault runs for a minute or more with nothing else to
      // show for it: the record carries the counter (a supervisor shows it) and the
      // log gets one line per tenth for a headless user.
      onProgress: (progress) => {
        runtime.setProgress(progress.done, progress.total);
        if (progress.total === 0) return;
        const percent = Math.min(100, Math.floor((progress.done / progress.total) * 100));
        if (percent < lastProgressPercent + 10 && percent < 100) return;
        lastProgressPercent = percent;
        log(opts, t("cli.log.progress", { done: progress.done, total: progress.total, percent }));
      },
      onStateChange: (state) => {
        if (state === "connected") {
          runtime.set({ phase: "syncing", reason: "running", lastError: "" });
          log(
            opts,
            t("cli.log.connected", {
              deviceName: cliSyncApiOptions(config, vault).getDeviceName(),
            }),
          );
        }
      },
      onBindFailed: (err) => {
        runtime.set({ lastError: String(err) });
        log(opts, t("cli.log.bindFailed", { error: String(err) }));
      },
      onAuthFailure: (reason) => {
        // The host stopped itself before reporting. All three end this process: a daemon
        // that keeps running against a dead credential only fills the log. Expired and
        // disabled are resumable, so the record says which one it was and the next start
        // (after the host fixes it) picks the vault up again.
        fatal = true;
        runtime.set({
          phase: "stopped",
          reason:
            reason === "revoked"
              ? "key-revoked"
              : reason === "expired"
                ? "key-expired"
                : "key-disabled",
        });
        log(
          opts,
          reason === "revoked"
            ? t("cli.log.keyRevoked")
            : reason === "expired"
              ? t("cli.log.keyExpired")
              : t("cli.log.keyDisabled"),
        );
      },
      onVaultDeleted: () => {
        fatal = true;
        runtime.set({ phase: "stopped", reason: "vault-deleted" });
        log(opts, t("cli.log.vaultDeleted"));
      },
    });
    try {
      await next.start();
    } catch (err) {
      next.stop();
      throw err;
    }
    // The bind pass can outlive the lease (a suspended process, a slow adapter). Check
    // the record again after it; the local flag alone is not evidence of ownership.
    if (stopped || fatal || !leaseHeld || !(await lease.renew().catch(() => false))) {
      // A lease lost during the bind pass must not leave an engine running behind it.
      leaseHeld = false;
      next.stop();
      return null;
    }
    host = next;
    runtime.set({ phase: "syncing", reason: "running", lastError: "" });

    // A line a headless user can find in journald: what this machine is syncing, and
    // whether a previous run left conflict copies behind.
    let parked: string[] = [];
    try {
      parked = await parkedConflictFiles(vault, maxFileBytes);
    } catch (err) {
      log(opts, t("cli.log.eventFailed", { path: vaultPath, error: String(err) }));
    }
    log(
      opts,
      plural("cli.log.watching.one", "cli.log.watching.other", parked.length, {
        vaultPath,
        count: parked.length,
      }),
    );
    return next;
  };

  const run = async (): Promise<void> => {
    while (true) {
      if (stopped || fatal) break;

      // First come, first served. The plugin takes the same lease; neither side observes
      // the other to decide who may run. If the lease is taken, build no host at all.
      if (!leaseHeld) {
        let acquired: boolean;
        try {
          acquired = await lease.acquire();
          // `--take-over` asks **once**, on the first refusal, and is spent by that answer
          // either way. A daemon that kept taking the vault back would fight every other
          // writer forever, and a refused rename retried every half second is the same
          // fight with a slower clock. A refusal is reported and the process then waits
          // like any other.
          if (!acquired && opts.takeOver && !takeOverAsked) {
            takeOverAsked = true;
            log(
              opts,
              t("cli.log.takingOver", {
                holder: leaseHolderLabel(await lease.read()),
                vault: vaultLabel(vault),
              }),
            );
            acquired = await lease.takeOver();
            if (!acquired) log(opts, t("cli.error.takeOverFailed"));
          }
        } catch (err) {
          // A filesystem failure is not another writer. Waiting would hide it forever:
          // the daemon would sit in the "other-writer" phase with no way to recover.
          const detail = errorMessage(err);
          const failure = new Error(t("cli.error.leaseFailed", { error: detail }), { cause: err });
          fatal = true;
          runtime.set({ phase: "stopped", reason: "failed", lastError: detail });
          if (!firstSettled) {
            startupError = failure;
            settleFirst();
          } else {
            log(opts, failure.message);
            opts.onFatal?.(failure);
          }
          break;
        }
        if (!acquired) {
          if (!leaseWaiting) {
            leaseWaiting = true;
            runtime.set({ phase: "waiting", reason: "other-writer", lastError: "" });
            log(opts, t("cli.log.leaseWaiting", { vault: vaultLabel(vault) }));
          }
          settleFirst();
          await waitForLease(retryMs);
          continue;
        }
        // Keep the watcher: while holding, an event means somebody is taking the vault
        // (see `onLeaseDirectoryChange`). It replaces the one the wait installed.
        leaseHeld = true;
        if (leaseWaiting) {
          leaseWaiting = false;
          log(opts, t("cli.log.leaseResumed", { vault: vaultLabel(vault) }));
        }
        closeLeaseWatch();
        watchLease();
        stopRenewal();
        renewal = setInterval(() => void renewLease(), LEASE_RENEW_MS);
      }

      let next: SyncHost | null;
      try {
        next = await startHost();
      } catch (err) {
        runtime.set({ lastError: String(err) });
        log(opts, t("cli.log.startFailed", { error: String(err) }));
        settleFirst();
        await sleep(retryMs);
        continue;
      }
      settleFirst();
      if (!next) {
        if (stopped || fatal) break;
        // The lease was lost while the host was being built; loop and reacquire.
        await waitForLease(retryMs);
        continue;
      }

      // The lease is the only authority. Keep the engine alive until it is lost or the
      // process is stopped; a failed renewal clears the host and wakes this wait.
      await waitUntilHostGone(retryMs);
    }
    const finalHost = host;
    host = null;
    finalHost?.stop();
    await finalHost?.whenIdle();
    await releaseLease();
    if (stopped) runtime.clear();
  };

  void run();
  await firstAttempt;
  if (startupError) throw startupError;

  return {
    get engine() {
      return host?.engine ?? null;
    },
    stop: async () => {
      stopped = true;
      settleFirst();
      const stoppedHost = host;
      clearHost();
      stoppedHost?.stop();
      // Keep renewing while the last pass drains: an expiry during shutdown would let a
      // new host in before this one has stopped writing.
      await stoppedHost?.whenIdle();
      stopRenewal();
      runtime.clear();
      await releaseLease();
    },
  };
}

/**
 * The daemon's event source: `fs.watch`, coalesced, turned into the host's
 * three-way handler set.
 *
 * The coalescing is deliberate. `fs.watch` reports "something happened to this
 * path" — several times per write, and with no distinction between a create, a
 * modify, a delete or a rename — so a burst is collected for
 * {@link WATCH_DEBOUNCE_MS} and each path is then answered by reading it: a file
 * that exists is a change, one that does not is a removal. That read is also what
 * makes the answer honest rather than a guess.
 *
 * A folder the scope cannot sync is dropped here, with the same predicate the
 * engine applies to a listing.
 */
function fsWatchEventSource(
  vaultPath: string,
  scope: SyncScope,
  opts: RunOptions,
): SyncEventSource {
  return {
    start: (handlers) => {
      let watcher: FSWatcher | null = null;
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const pending = new Set<string>();

      const flush = async (): Promise<void> => {
        const batch = [...pending];
        pending.clear();
        for (const raw of batch) {
          const rel = raw.replace(/\\/g, "/");
          if (!isSyncablePath(rel, scope)) continue;
          let exists: boolean;
          try {
            exists = (await new FsAdapter(vaultPath, scope).readFile(rel)) !== null;
          } catch (err) {
            log(opts, t("cli.log.eventFailed", { path: rel, error: String(err) }));
            continue;
          }
          // The size is unknown until the engine stats the file, so it travels as
          // `null` — the host's queue treats that as the worst case.
          if (exists) handlers.changed(rel, null);
          else handlers.removed(rel);
        }
      };

      try {
        watcher = watch(vaultPath, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          pending.add(String(filename));
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(() => void flush(), WATCH_DEBOUNCE_MS);
        });
      } catch (err) {
        // Not recursive on Linux: the interval reconcile is the fallback.
        log(opts, t("cli.log.watchUnavailable", { error: String(err) }));
      }

      return () => {
        watcher?.close();
        if (debounce) clearTimeout(debounce);
      };
    },
  };
}
