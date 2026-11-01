import type { EventRef, FileManager, TAbstractFile, Vault } from "obsidian";
import { pluginPlatform } from "../platform";
import {
  LEASE_RENEW_MS,
  SyncHost,
  SyncLease,
  normalizeScope,
  type AuthFailureReason,
  type ConflictResolvedEvent,
  type FileTooLargeEvent,
  type LocalVersionState,
  type SettingsAppliedEvent,
  type SyncActivityEvent,
  type SyncApi,
  type SyncEventSource,
  type SyncProgress,
  type SyncScope,
  type SyncScopeInput,
  type WsConnectionState,
} from "@courier/engine";
import { ObsidianVaultAdapter } from "./adapter";
import { watchLeaseDirectory } from "./lease-watch";
import type { CourierSettings } from "../shared/settings";

/**
 * How often the host re-runs a full reconcile as a safety net against missed
 * websocket notifications. Cheap enough to be frequent: one vault listing plus
 * one history request, on top of the per-file hashing the engine already does.
 */
const RECONCILE_INTERVAL_MS = 5 * 60_000;

/**
 * How often the host pushes local changes in the synced settings files.
 *
 * Obsidian keeps its config folder out of the vault index, so **no vault event ever
 * fires** for `app.json`, `hotkeys.json` or a core plugin's state: without a poll those
 * changes would only travel at the next full reconcile, up to five minutes later — and a
 * peer's device would sit on a change the user already made with nothing to explain why.
 *
 * One second, not the engine's thirty: this host can afford it and the delay is what the
 * user sees. `listSyncableFiles` here is Obsidian's own vault index (in memory, no
 * filesystem walk) plus the config-folder walk, which the scope prunes to the groups that
 * are on — measured at **0.7–2 ms per pass**, and 13 ms with every group on and 109 config
 * files, the cost being one `stat` per settings file (0.053 ms; the stamp cache means an
 * unchanged file is never read). The vault's own size barely enters it: mapping 50 000
 * indexed paths costs 0.33 ms.
 *
 * Not shorter: below a second the poll is already faster than the platform's own clamp on a
 * hidden window (and than anything a person can perceive), while each pass is a handful of
 * I/O round trips — on mobile, across the Capacitor bridge. The headless CLI keeps the
 * engine's slower default on purpose: its adapter walks the filesystem, so a one-second pass
 * there would be a real cost.
 */
export const SETTINGS_POLL_INTERVAL_MS = 1_000;

/** How long a restart waits for the previous host's lease drain before parking. */
const LEASE_DRAIN_TIMEOUT_MS = 5_000;

/**
 * How often a host that lost the lease retries it.
 *
 * Exported so the unit test advances the clock by the real period instead of repeating
 * the number: a test that hard-codes it keeps passing if this changes.
 */
export const LEASE_RETRY_MS = 500;

export interface EngineHostOptions {
  vault: Vault;
  /**
   * Obsidian's file manager, for the deletions the sync adapter performs.
   *
   * `Vault.delete` exists and is the wrong call for anything Obsidian itself would delete:
   * it ignores the user's "deleted files" setting, so a note the engine removed would skip
   * the trash. The adapter takes the manager and deletes through it.
   */
  fileManager: FileManager;
  vaultId: string;
  encryptionKey: CryptoKey;
  serverUrl: string;
  wsUrl: string;
  /**
   * Which paths this device syncs — the vault file types and the config-folder groups
   * (both device-local) plus the account's file cap. Read at `start()`, so a change to
   * a switch means restarting the host; the cap is re-read by the caller before it
   * builds one.
   */
  syncScope?: SyncScopeInput;
  getSettings: () => CourierSettings;
  saveSettings: () => Promise<void>;
  createSyncApi: (userKey: string) => SyncApi;
  /**
   * The paths a person is looking at, most important first — the note the app has open,
   * then the recently opened ones. Read by the host at the start of every pass, so a
   * cold start syncs the note on screen before the rest of the vault.
   *
   * Optional: a host that cannot answer simply syncs in its ordinary order.
   */
  getPriorityPaths?: () => readonly string[];
  /**
   * Called once per conflict the engine resolves **outside the config folder** — a
   * config-folder conflict is settled silently by modification time and never reported
   * (see `ConflictResolvedEvent`).
   */
  onConflictResolved?: (event: ConflictResolvedEvent) => void;
  /** Called for a file the size cap skipped, in either direction. */
  onFileTooLarge?: (event: FileTooLargeEvent) => void;
  /**
   * Called for every config-folder file a peer's version was applied to.
   *
   * The plugin turns these into one notice with a reload button: Obsidian read its
   * config at start-up, so the file is right and the running app is not (see
   * `SettingsAppliedEvent`).
   */
  onSettingsApplied?: (event: SettingsAppliedEvent) => void;
  /**
   * One sync decision this host made, already carrying the device label this client
   * used for an outgoing change. The plugin records it in its session log.
   */
  onSyncActivity?: (event: SyncActivityEvent) => void;
  /**
   * How far the current pass has got. The plugin shows it in the status bar's tooltip
   * while the first pass runs; a host that ignores it syncs the same.
   */
  onProgress?: (progress: SyncProgress) => void;
  /**
   * The pass is about to wait out a server rate limiter for `waitMs`. The pass resumes by
   * itself; this exists so the console can say why nothing is happening.
   */
  onRateLimited?: (event: { waitMs: number }) => void;
  onStateChange?: (state: WsConnectionState) => void;
  onVaultDeleted?: () => void;
  /**
   * The credential stopped working: revoked, expired, or disabled.
   *
   * One callback for all three because the host has already stopped either way; what
   * differs is the plugin's policy — a revoked key drops the binding, an expired or
   * disabled one pauses it and keeps everything the user would have to retype.
   */
  onAuthFailure?: (reason: AuthFailureReason) => void;
  /**
   * The bind pass — this host's first look at the vault — could not be completed.
   *
   * A report, not a terminal state: the host stays up and retries, and it is
   * fully wired, unlike the half-built host a thrown `start()` used to leave behind.
   */
  onBindFailed?: (error: unknown) => void;
  /**
   * The per-vault writer lease. When present, `start()` must acquire it before building
   * the engine, and the host is not started while the CLI owns the vault.
   */
  lease?: SyncLease;
  /** Called when the lease makes this host wait, and again when it stops waiting. */
  onLeaseChange?: (waiting: boolean) => void;
}

/** A vault entry's size as Obsidian's index already knows it; null for a folder. */
function sizeOf(file: TAbstractFile): number | null {
  // A folder has no `stat`; reading it structurally keeps this module type-only against
  // `obsidian` (`instanceof TFile` would need a value import, and the package ships types
  // only — the app provides the module at runtime).
  const stat = (file as { stat?: { size?: number } }).stat;
  return stat?.size ?? null;
}

/**
 * The Obsidian side of the sync host.
 *
 * The loop itself — bind, watch, subscribe, reconcile, poll, stop — is
 * `SyncHost` in `@courier/engine`, shared with the headless CLI. What is left
 * here is exactly what is Obsidian-specific: the vault adapter, the vault event
 * wiring, where the state is persisted (the plugin's `data.json`) and where the
 * failures are logged.
 *
 * `settings.deviceName` is the label this client states about itself in the
 * **connected** remote vault's history (each vault keeps its own value) — nothing
 * is registered with the server.
 */
export class EngineHost {
  private host: SyncHost | null = null;
  private readonly syncScope: SyncScope;
  /**
   * Bumped by every `start()`/`stop()`.
   *
   * A stopped host may still have a pass in flight (the engine is not cancellable), and
   * its activity events would otherwise refill the session log after a bind/unbind
   * cleared it. The callback captures the generation it was built for; one from an older
   * generation is dropped, exactly like the engine state writes `SyncHost` already drops.
   */
  private generation = 0;
  private leaseRetry: number | null = null;
  private leaseRenewal: number | null = null;
  private leaseRelease: Promise<void> | null = null;
  private leaseWatch: (() => void) | null = null;
  /**
   * True while a watcher is being loaded but has not been installed yet.
   *
   * `watchLeaseDirectory` awaits the desktop `node:fs` import, so the `leaseWatch` guard
   * alone no longer makes the start single-flight: two callers in the same generation
   * (a failed renewal and the bind's own re-check) would both pass it, both load, and
   * the second assignment would replace the first watcher without ever closing it.
   * The loser of this flag simply leaves the watcher to the pending start; the retry
   * timer still covers the lease.
   */
  private leaseWatchPending = false;
  private waitingForLease = false;

  constructor(private readonly opts: EngineHostOptions) {
    // Normalized once, here: every scope consumer (the engine, the adapter) then
    // reads a complete group record.
    this.syncScope = normalizeScope(opts.syncScope);
  }

  get engine() {
    return this.host?.engine ?? null;
  }

  get wsState(): WsConnectionState {
    return this.host?.wsState ?? "disconnected";
  }

  /** True while this vault's lease belongs to the CLI (or another writer). */
  get leaseWaiting(): boolean {
    return this.waitingForLease;
  }

  /**
   * True until the bind pass has completed.
   *
   * A host is *running* from the moment its engine exists, but until the bind returns it
   * has not connected its socket — so the status bar has to be able to tell "working on
   * the first pass" from "not synced, something is wrong".
   */
  get binding(): boolean {
    return this.host?.binding ?? false;
  }

  /**
   * True only for a vault this device has never synced (see `SyncHost.firstSync`).
   *
   * `binding` is true at the start of every host (the first pass is always a bind pass),
   * so a status surface needs this narrower fact to say "first sync" without claiming it
   * on every Obsidian start.
   */
  get firstSync(): boolean {
    return this.host?.firstSync ?? false;
  }

  /**
   * Record a change of the lease wait, and report **only** a change.
   *
   * A host that cannot take the vault restarts every `LEASE_RETRY_MS`. Each attempt runs
   * the teardown path (no host is built while waiting) and asks again, so a report per
   * attempt would tell the status bar "waiting, not synced, waiting, …": the user sees
   * the lock icon flash against the red not-synced one although nothing about the vault
   * changed between attempts.
   */
  private setLeaseWaiting(waiting: boolean): void {
    if (this.waitingForLease === waiting) return;
    this.waitingForLease = waiting;
    this.opts.onLeaseChange?.(waiting);
  }

  /** Resolve a plain path to its fileId (version-history entry point). */
  fileIdForPath(path: string): string | null {
    return this.host?.fileIdForPath(path) ?? null;
  }

  /** Start (or restart) the engine + vault event wiring. */
  async start(): Promise<void> {
    const settings = this.opts.getSettings();
    const userKey = settings.userKey;
    if (!userKey) throw new Error("Missing user key");

    this.teardown();
    const generation = ++this.generation;

    // The previous host's release is a filesystem write. Wait for it, but never let a
    // hung adapter freeze the plugin: after the timeout park and retry; the old host
    // keeps the lease until its drain actually finishes, so no second writer starts.
    if (this.leaseRelease) {
      const drained = await Promise.race([
        this.leaseRelease.then(() => true),
        new Promise<boolean>((resolve) =>
          window.setTimeout(() => resolve(false), LEASE_DRAIN_TIMEOUT_MS),
        ),
      ]);
      if (generation !== this.generation) return;
      if (!drained) {
        this.setLeaseWaiting(true);
        void this.startLeaseWatch(generation);
        this.scheduleLeaseRetry(generation);
        return;
      }
      this.leaseRelease = null;
    }

    if (this.opts.lease) {
      let acquired = false;
      try {
        acquired = await this.opts.lease.acquire();
      } catch (err) {
        console.error("Courier: acquiring the vault lease failed:", err);
      }
      if (generation !== this.generation) {
        // A pause/disconnect landed while the lease was being acquired; do not leave it
        // held by a host that is no longer starting.
        if (acquired) await this.opts.lease.release();
        return;
      }
      if (!acquired) {
        // The CLI (or another writer) owns this vault. Do not build an engine: waiting is
        // the whole point of the lease.
        this.setLeaseWaiting(true);
        void this.startLeaseWatch(generation);
        this.scheduleLeaseRetry(generation);
        return;
      }
      this.closeLeaseWatch();
      this.setLeaseWaiting(false);
      this.startLeaseRenewal(generation);
    }

    await this.startHost(generation);
  }

  private async startHost(generation: number): Promise<void> {
    const settings = this.opts.getSettings();
    const userKey = settings.userKey;
    if (!userKey) throw new Error("Missing user key");

    const host = new SyncHost({
      vaultId: this.opts.vaultId,
      encryptionKey: this.opts.encryptionKey,
      syncScope: this.syncScope,
      adapter: new ObsidianVaultAdapter(this.opts.vault, this.syncScope, this.opts.fileManager),
      api: this.opts.createSyncApi(userKey),
      wsUrl: this.opts.wsUrl,
      userKey,
      // The renderer's runtime: window timers, and `process` on desktop only.
      platform: pluginPlatform,
      // Read when the socket subscribes: a peer's notification names the label this
      // client had at that moment. The push path reads the setting per push.
      getDeviceName: () => this.opts.getSettings().deviceName,
      getPriorityPaths: this.opts.getPriorityPaths,
      eventSource: this.vaultEvents(),
      stateStore: {
        load: () => JSON.stringify(this.opts.getSettings().syncState?.localVersions ?? {}),
        save: (json) => this.persistState(json),
        loadBindCompleted: () => this.opts.getSettings().syncState?.bindCompleted === true,
        saveBindCompleted: () => this.persistBindCompleted(),
      },
      reconcileIntervalMs: RECONCILE_INTERVAL_MS,
      settingsPollIntervalMs: SETTINGS_POLL_INTERVAL_MS,
      log: (message, err) =>
        err === undefined
          ? console.error(`Courier: ${message}`)
          : console.error(`Courier: ${message}:`, err),
      onConflictResolved: this.opts.onConflictResolved,
      onFileTooLarge: this.opts.onFileTooLarge,
      onSettingsApplied: this.opts.onSettingsApplied,
      // The engine knows the direction and the outcome but not this client's label; the
      // session log wants to show who sent an outgoing change, so it is filled here from
      // the value the push was made under. An incoming event keeps the label the server
      // passed on from the pushing client.
      onSyncActivity: (event) => {
        // A pass that outlived this host must not append to a log a later bind has
        // already cleared (or to the new run's log).
        if (this.generation !== generation) return;
        this.opts.onSyncActivity?.({
          ...event,
          deviceName:
            event.direction === "out" && event.deviceName === null
              ? this.opts.getSettings().deviceName
              : event.deviceName,
        });
      },
      onStateChange: this.opts.onStateChange,
      onVaultDeleted: this.opts.onVaultDeleted,
      onAuthFailure: this.opts.onAuthFailure,
      onBindFailed: this.opts.onBindFailed,
      // The status bar reads this to say how far a first pass has got. Kept here, not in
      // the plugin, so the value dies with the host that produced it: a stopped host's
      // pass can still report for a moment, and a stale counter must not outlive it.
      onProgress: (progress) => {
        if (this.generation !== generation) return;
        this.opts.onProgress?.(progress);
      },
      onRateLimited: this.opts.onRateLimited,
    });

    this.host = host;
    try {
      await host.start();
    } catch (err) {
      // Do not keep the lease (and the CLI waiting) after a failed start.
      this.stop();
      throw err;
    }
    if (this.waitingForLease || generation !== this.generation) {
      // The lease was lost while the bind pass was starting; do not leave an engine
      // running behind a lease this host no longer owns.
      host.stop();
      if (this.host === host) this.host = null;
      return;
    }
    if (this.opts.lease && !(await this.opts.lease.renew().catch(() => false))) {
      // The bind pass can outlive the TTL (a suspended process, a slow adapter). The
      // local flag alone is not evidence of ownership; re-check before keeping the host.
      host.stop();
      if (this.host === host) this.host = null;
      this.setLeaseWaiting(true);
      void this.startLeaseWatch(generation);
      this.scheduleLeaseRetry(generation);
    }
  }

  /** Retry the lease shortly; this is the fallback when the directory watcher is unavailable. */
  private scheduleLeaseRetry(generation: number): void {
    if (this.leaseRetry) return;
    this.leaseRetry = window.setTimeout(() => {
      this.leaseRetry = null;
      if (generation !== this.generation) return;
      void this.start();
    }, LEASE_RETRY_MS);
  }

  /** On desktop, wake as soon as the holder removes the lease directory. */
  private async startLeaseWatch(generation: number): Promise<void> {
    if (this.leaseWatch || this.leaseWatchPending) return;
    this.leaseWatchPending = true;
    try {
      const stop = await watchLeaseDirectory(this.opts.vault.adapter, () => {
        if (generation !== this.generation) return;
        if (this.leaseRetry) window.clearTimeout(this.leaseRetry);
        this.leaseRetry = null;
        this.closeLeaseWatch();
        void this.start();
      });
      // A stop() that landed while the modules were loading wins: the watcher must not
      // outlive the host that asked for it.
      if (generation !== this.generation) {
        stop();
        return;
      }
      this.leaseWatch = stop;
    } finally {
      this.leaseWatchPending = false;
    }
  }

  private closeLeaseWatch(): void {
    this.leaseWatch?.();
    this.leaseWatch = null;
  }

  private startLeaseRenewal(generation: number): void {
    if (!this.opts.lease || this.leaseRenewal) return;
    this.leaseRenewal = window.setInterval(() => {
      void this.renewLease(generation);
    }, LEASE_RENEW_MS);
  }

  private async renewLease(generation: number): Promise<void> {
    if (!this.opts.lease || generation !== this.generation) return;
    const renewed = await this.opts.lease.renew().catch(() => false);
    if (generation !== this.generation || renewed) return;
    // Another writer took over (or the lease file vanished). Stop before doing any more
    // engine work, then wait for the retry loop.
    this.host?.stop();
    this.host = null;
    if (this.leaseRenewal) window.clearInterval(this.leaseRenewal);
    this.leaseRenewal = null;
    this.setLeaseWaiting(true);
    void this.startLeaseWatch(generation);
    this.scheduleLeaseRetry(generation);
  }

  /**
   * Wait up to `timeoutMs` for the last stop's lease release. False means the drain is
   * still running; the caller may build the replacement and let its lease acquisition
   * wait, rather than freezing on a hung adapter.
   */
  async whenStopped(timeoutMs = LEASE_DRAIN_TIMEOUT_MS): Promise<boolean> {
    if (!this.leaseRelease) return true;
    return Promise.race([
      this.leaseRelease.then(() => true),
      new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  /** Unwire vault events, stop the timers and disconnect the WebSocket. */
  stop(): void {
    this.teardown();
    this.setLeaseWaiting(false);
  }

  /**
   * The teardown half of `stop()`: everything that unwires this host, without touching
   * the lease wait.
   *
   * `start()` begins with it, so a restart that will ask for the lease again must not
   * report the wait as over — see `setLeaseWaiting`.
   */
  private teardown(): void {
    // Invalidate the activity callback of the host being stopped before dropping it.
    this.generation += 1;
    if (this.leaseRetry) window.clearTimeout(this.leaseRetry);
    this.leaseRetry = null;
    this.closeLeaseWatch();
    if (this.leaseRenewal) window.clearInterval(this.leaseRenewal);
    this.leaseRenewal = null;
    const stoppedHost = this.host;
    this.host = null;
    stoppedHost?.stop();
    const lease = this.opts.lease;
    if (lease && !this.leaseRelease) {
      // Keep the lease alive until an in-flight pass has drained. Releasing at `stop()`
      // would let the CLI start while the old engine is still writing. A drain already
      // in progress owns the release; do not replace its promise on a later stop.
      const keepAlive = window.setInterval(() => {
        void lease.renew().catch(() => {});
      }, LEASE_RENEW_MS);
      this.leaseRelease = (async () => {
        try {
          await stoppedHost?.whenIdle();
        } finally {
          window.clearInterval(keepAlive);
          await lease.release().catch(() => {});
        }
      })();
    }
  }

  /**
   * Obsidian's vault events as the host's three handlers.
   *
   * Folder events are dropped (`"extension" in file`): the engine safely no-ops on
   * them, but narrowing here keeps the queue clean. The size travels with the event
   * because Obsidian's index already knows it, which is what lets the host's queue
   * run a large file alone instead of four at once.
   */
  private vaultEvents(): SyncEventSource {
    return {
      start: (handlers) => {
        const refs: EventRef[] = [
          this.opts.vault.on("create", (file) => {
            if ("extension" in file) handlers.changed(file.path, sizeOf(file));
          }),
          this.opts.vault.on("modify", (file) => {
            if ("extension" in file) handlers.changed(file.path, sizeOf(file));
          }),
          this.opts.vault.on("delete", (file) => {
            if ("extension" in file) handlers.removed(file.path);
          }),
          this.opts.vault.on("rename", (file, oldPath) => {
            if ("extension" in file) handlers.renamed(oldPath, file.path, sizeOf(file));
          }),
        ];
        return () => {
          for (const ref of refs) this.opts.vault.offref(ref);
        };
      },
    };
  }

  /**
   * Persist the serialized engine state back into settings.
   *
   * The sync-history dialog no longer reads this: its rows are the engine's activity
   * events, recorded as they happen, so a pass that changes nothing produces no row and
   * a five-minute reconcile does not make the log look like it is churning.
   */
  private persistState(json: string): void {
    let localVersions: LocalVersionState = {};
    try {
      localVersions = JSON.parse(json) as LocalVersionState;
    } catch {
      // Keep an empty state on malformed input.
    }
    const previous = this.opts.getSettings().syncState;
    // The completion flag is not part of the engine's state: it is carried over, so a
    // sync-point write does not make a bound vault look unbound again.
    this.opts.getSettings().syncState = {
      ...previous,
      localVersions,
    };
    this.saveSettingsSoon();
  }

  /**
   * Record that the vault is fully bound, beside the per-file state.
   *
   * `SyncHost` calls this once, after the bind pass returns; from then on its own and any
   * later host's `firstSync` is false (see `SyncStateStore.saveBindCompleted`). Nothing
   * is written into `localVersions`: that map is keyed by fileId.
   */
  private persistBindCompleted(): void {
    const settings = this.opts.getSettings();
    settings.syncState = {
      localVersions: settings.syncState?.localVersions ?? {},
      bindCompleted: true,
    };
    this.saveSettingsSoon();
  }

  /**
   * Persist settings without making the pass wait for the disk.
   *
   * Fire and forget: a save failure must not fail the sync pass that produced it.
   */
  private saveSettingsSoon(): void {
    void Promise.resolve()
      .then(() => this.opts.saveSettings())
      .catch((err: unknown) => console.error("Courier: save settings failed:", err));
  }
}
