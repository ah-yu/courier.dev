import { settingsGroupOf, type SyncScope } from "./sync-scope";
import type {
  FileSkippedEvent,
  FileTooLargeEvent,
  SettingsAppliedEvent,
  SyncActivityEvent,
  SyncProgress,
} from "./engine";

/** How many settled files a pass reports before its next progress event. */
const PROGRESS_STEP_FILES = 25;

export interface ActivityReporterOptions {
  /** Which paths this device syncs: a settings event names the group that changed. */
  scope: SyncScope;
  onFileTooLarge?: (event: FileTooLargeEvent) => void;
  onFileSkipped?: (event: FileSkippedEvent) => void;
  onSettingsApplied?: (event: SettingsAppliedEvent) => void;
  onSyncActivity?: (event: SyncActivityEvent) => void;
  onProgress?: (progress: SyncProgress) => void;
}

/**
 * Everything the engine tells its host about a pass: the activity feed, the skip notices and
 * the progress counter.
 *
 * It is separate from the decision code because none of it decides anything: the feed is a
 * UI convenience, and the "once per pass" bookkeeping (which paths were already reported) is
 * state that a pass owns, not state a chain owns.
 *
 * Two of the five callbacks are isolated, because they are pure convenience and a host bug
 * must not cost a sync: `onSyncActivity` and `onProgress` swallow a throwing listener (and
 * log the first). The three notices — `onFileTooLarge`, `onFileSkipped`, `onSettingsApplied` —
 * are called directly, so a host that throws there fails the pass exactly as it did before
 * this class existed; changing that would be a host-contract change, not a refactor.
 */
export class ActivityReporter {
  /** Paths reported through `onFileTooLarge` in the current pass (one event each). */
  private tooLargeReported = new Set<string>();
  /** Paths reported through `onFileSkipped` in the current pass (one event each). */
  private skippedReported = new Set<string>();
  /** Files the current pass has settled, and how many it has taken on (see `SyncProgress`). */
  private done = 0;
  private total = 0;
  /** The `done` value the last `onProgress` call reported, so steps are coarse. */
  private emitted = 0;

  constructor(private readonly opts: ActivityReporterOptions) {}

  /** Start a pass: one `onFileTooLarge`/`onFileSkipped` per path per pass, and fresh sets. */
  beginPass(): void {
    this.tooLargeReported.clear();
    this.skippedReported.clear();
  }

  reportTooLarge(plainPath: string, sizeBytes: number): void {
    if (this.tooLargeReported.has(plainPath)) return;
    this.tooLargeReported.add(plainPath);
    this.opts.onFileTooLarge?.({ plainPath, sizeBytes });
  }

  /**
   * Report a local file the size cap keeps out of this device's sync, both ways: the
   * once-per-pass notice and the activity row for the decision itself.
   *
   * The two reports answer different questions — "tell the user once" and "record this
   * decision" — and every site that skips a local file for its size has to do both, in this
   * order. Keeping the pair here is what stops the reconcile scan and the settings poll
   * from drifting on the row's shape (they were copied from each other once already), and
   * it keeps `fileId` where the engine can answer it: the reporter never reads the state.
   */
  reportSkippedForSize(plainPath: string, sizeBytes: number, fileId: string | null): void {
    this.reportTooLarge(plainPath, sizeBytes);
    this.reportActivity({
      direction: "out",
      outcome: "skipped",
      fileId,
      versionId: null,
      plainPath,
      action: null,
      sizeBytes,
      deviceName: null,
      reason: "size",
    });
  }

  /** Report a file this pass left out for a reason that is not its size (once per pass). */
  reportSkipped(plainPath: string, reason: FileSkippedEvent["reason"]): void {
    if (this.skippedReported.has(plainPath)) return;
    this.skippedReported.add(plainPath);
    this.opts.onFileSkipped?.({ plainPath, reason });
  }

  /**
   * Report a settings file this device just applied from the remote.
   *
   * Deliberately not "once per pass": each application is a separate change to a file the
   * running app has already read, so the host needs one event per file — it is the host's
   * own burst notifier that turns a folderful of them into one line.
   */
  reportSettingsApplied(plainPath: string, action: SettingsAppliedEvent["action"]): void {
    // Ownership is the guard, not "is inside the config folder": it answers null for a path
    // nothing may sync (`workspace.json`, `cache/**`, this plugin's own folder), and it
    // gives the host the group it needs to judge the change without knowing the rule.
    const group = settingsGroupOf(plainPath, this.opts.scope);
    if (group === null) return;
    this.opts.onSettingsApplied?.({ plainPath, action, group });
  }

  /**
   * Tell the host one decision this device made (see `SyncActivityEvent`).
   *
   * Deliberately isolated: the activity feed is a UI convenience, so a host listener that
   * throws must never fail the sync pass that reported it.
   */
  reportActivity(event: SyncActivityEvent): void {
    try {
      this.opts.onSyncActivity?.(event);
    } catch (err) {
      console.error("Courier: a sync-activity listener failed:", err);
    }
  }

  /** Begin reporting a pass that already knows `total` files, and report it. */
  beginProgress(total: number): void {
    this.done = 0;
    this.total = total;
    this.emitted = 0;
    this.reportProgress(true);
  }

  /** Take on `count` more files — a create the pass discovered as it walked the vault. */
  addProgressTotal(count: number): void {
    this.total += count;
  }

  /** Mark `count` files settled, and report once enough has moved. */
  advanceProgress(count = 1): void {
    this.done += count;
    this.reportProgress(false);
  }

  /**
   * Report progress, if this pass has anything to report and a step has passed.
   *
   * `force` is for the beginning and the end of a pass: the first tells a host the total,
   * the last tells it the pass is over (`done === total`), which is what a status bar needs
   * to stop showing a counter. A listener that throws is ignored — progress is a courtesy,
   * and a UI bug must not fail the sync that reported it.
   */
  reportProgress(force: boolean): void {
    const listener = this.opts.onProgress;
    if (!listener) return;
    if (this.total === 0 && this.done === 0) return;
    if (!force && this.done - this.emitted < PROGRESS_STEP_FILES) return;
    this.emitted = this.done;
    try {
      listener({ done: this.done, total: this.total });
    } catch {
      // A host callback is not allowed to fail the pass.
    }
  }
}
