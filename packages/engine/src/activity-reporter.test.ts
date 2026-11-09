import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityReporter, type ActivityReporterOptions } from "./activity-reporter";
import { normalizeScope, type SyncScope } from "./sync-scope";
import type {
  FileSkippedEvent,
  FileTooLargeEvent,
  SettingsAppliedEvent,
  SyncActivityEvent,
  SyncProgress,
} from "./engine";

/**
 * L0 for `ActivityReporter`: the class itself is real, every host callback is a mock.
 *
 * The engine suites exercise these callbacks end-to-end, but they reach the once-per-pass
 * sets only through a pass that has a reason to report twice, so the de-duplication early
 * returns are pinned here. The three notices are deliberately not isolated (see the class
 * doc) and are tested as such.
 */

const SCOPE: SyncScope = normalizeScope({
  configDir: ".obsidian",
  settingsGroups: { app: true, communityPlugins: true },
});

function makeReporter(options: Partial<ActivityReporterOptions> = {}): ActivityReporter {
  return new ActivityReporter({ scope: SCOPE, ...options });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ActivityReporter — once-per-pass notices", () => {
  it("reports a file over the size cap once per path per pass, and again after beginPass()", () => {
    const onFileTooLarge = vi.fn<(event: FileTooLargeEvent) => void>();
    const reporter = makeReporter({ onFileTooLarge });

    reporter.reportTooLarge("big.mp4", 12);
    reporter.reportTooLarge("big.mp4", 12);
    expect(onFileTooLarge).toHaveBeenCalledTimes(1);
    expect(onFileTooLarge).toHaveBeenCalledWith({ plainPath: "big.mp4", sizeBytes: 12 });

    // The set is keyed by path, so a second file still reports in the same pass.
    reporter.reportTooLarge("other.mp4", 3);
    expect(onFileTooLarge).toHaveBeenCalledTimes(2);

    // A new pass starts with empty sets: the same path is reported again.
    reporter.beginPass();
    reporter.reportTooLarge("big.mp4", 12);
    expect(onFileTooLarge).toHaveBeenCalledTimes(3);
    expect(onFileTooLarge).toHaveBeenLastCalledWith({ plainPath: "big.mp4", sizeBytes: 12 });
  });

  it("reports a skipped path once per pass, carrying the reason to the event", () => {
    const onFileSkipped = vi.fn<(event: FileSkippedEvent) => void>();
    const reporter = makeReporter({ onFileSkipped });
    // The same shape the engine reports: a path over the API's encrypted-path bound.
    const path = `${"a".repeat(600)}.md`;

    reporter.reportSkipped(path, "path-too-long");
    reporter.reportSkipped(path, "path-too-long");
    expect(onFileSkipped).toHaveBeenCalledTimes(1);
    expect(onFileSkipped).toHaveBeenCalledWith({ plainPath: path, reason: "path-too-long" });

    reporter.beginPass();
    reporter.reportSkipped(path, "path-too-long");
    expect(onFileSkipped).toHaveBeenCalledTimes(2);
  });
});

describe("ActivityReporter — settings applied", () => {
  it("reports the owning group of a settings path, and stays silent for a path no group owns", () => {
    const onSettingsApplied = vi.fn<(event: SettingsAppliedEvent) => void>();
    const reporter = makeReporter({ onSettingsApplied });

    reporter.reportSettingsApplied(".obsidian/app.json", "write");
    expect(onSettingsApplied).toHaveBeenCalledWith({
      plainPath: ".obsidian/app.json",
      action: "write",
      group: "app",
    });

    // The group is resolved from the path, not just the file name: a plugin's own
    // settings file belongs to `communityPlugins`.
    reporter.reportSettingsApplied(".obsidian/plugins/calendar/data.json", "rename");
    expect(onSettingsApplied).toHaveBeenLastCalledWith({
      plainPath: ".obsidian/plugins/calendar/data.json",
      action: "rename",
      group: "communityPlugins",
    });

    // Deliberately not once per pass: each application is its own change to what the
    // running app already read.
    reporter.reportSettingsApplied(".obsidian/app.json", "delete");
    expect(onSettingsApplied).toHaveBeenCalledTimes(3);

    // `settingsGroupOf` answers null for a path nothing may sync (`workspace.json` is
    // per-installation state), and for anything outside the config folder.
    reporter.reportSettingsApplied(".obsidian/workspace.json", "write");
    reporter.reportSettingsApplied("notes/a.md", "write");
    expect(onSettingsApplied).toHaveBeenCalledTimes(3);
  });
});

describe("ActivityReporter — activity feed", () => {
  it("forwards an activity event to the listener unchanged", () => {
    const onSyncActivity = vi.fn<(event: SyncActivityEvent) => void>();
    const reporter = makeReporter({ onSyncActivity });
    const event: SyncActivityEvent = {
      direction: "out",
      outcome: "applied",
      fileId: "file-1",
      versionId: "version-1",
      plainPath: "notes/a.md",
      action: "create",
      sizeBytes: 4,
      deviceName: null,
    };

    reporter.reportActivity(event);

    expect(onSyncActivity).toHaveBeenCalledWith(event);
  });

  it("swallows a throwing activity listener, logging it once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reporter = makeReporter({
      onSyncActivity: () => {
        throw new Error("the activity listener blew up");
      },
    });
    const event: SyncActivityEvent = {
      direction: "in",
      outcome: "skipped",
      reason: "settingsGroup",
      fileId: "file-2",
      versionId: "version-2",
      plainPath: ".obsidian/core-plugins.json",
      action: "create",
      sizeBytes: 2,
      deviceName: "Mobile",
    };

    expect(() => reporter.reportActivity(event)).not.toThrow();
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("sync-activity listener failed");
  });
});

describe("ActivityReporter — progress", () => {
  it("reports nothing when the host supplied no progress listener", () => {
    const reporter = makeReporter();

    expect(() => {
      reporter.beginProgress(10);
      reporter.advanceProgress(25);
      reporter.reportProgress(true);
    }).not.toThrow();
  });

  it("reports nothing for a pass with no files", () => {
    const onProgress = vi.fn<(progress: SyncProgress) => void>();
    const reporter = makeReporter({ onProgress });

    reporter.reportProgress(true);
    reporter.reportProgress(false);

    expect(onProgress).not.toHaveBeenCalled();
  });

  it("reports the total when the pass begins, then once per 25 settled files", () => {
    const onProgress = vi.fn<(progress: SyncProgress) => void>();
    const reporter = makeReporter({ onProgress });

    reporter.beginProgress(100);
    expect(onProgress).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenLastCalledWith({ done: 0, total: 100 });

    // The 24th settled file is still inside the first step.
    reporter.advanceProgress(24);
    expect(onProgress).toHaveBeenCalledTimes(1);

    reporter.advanceProgress(1);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith({ done: 25, total: 100 });

    // The rest of that step is silent, then the next 25th reports once.
    reporter.advanceProgress(24);
    expect(onProgress).toHaveBeenCalledTimes(2);

    reporter.advanceProgress(1);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenLastCalledWith({ done: 50, total: 100 });
  });

  it("swallows a throwing progress listener", () => {
    const onProgress = vi.fn<(progress: SyncProgress) => void>(() => {
      throw new Error("the progress listener blew up");
    });
    const reporter = makeReporter({ onProgress });

    expect(() => reporter.beginProgress(3)).not.toThrow();
    expect(() => reporter.advanceProgress(25)).not.toThrow();
    expect(onProgress).toHaveBeenCalledTimes(2);
  });

  it("reports the grown total and the settled count on the final forced report", () => {
    const onProgress = vi.fn<(progress: SyncProgress) => void>();
    const reporter = makeReporter({ onProgress });

    reporter.beginProgress(3);
    expect(onProgress).toHaveBeenLastCalledWith({ done: 0, total: 3 });

    // A bind discovers files as it walks, so the total grows without reporting on its own.
    reporter.addProgressTotal(2);
    reporter.advanceProgress(3);
    reporter.advanceProgress(2);
    expect(onProgress).toHaveBeenCalledTimes(1);

    reporter.reportProgress(true);
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith({ done: 5, total: 5 });
  });
});

describe("ActivityReporter — notices are not isolated", () => {
  it("lets a throwing notice fail the caller", () => {
    const tooLarge = makeReporter({
      onFileTooLarge: () => {
        throw new Error("the too-large listener blew up");
      },
    });
    expect(() => tooLarge.reportTooLarge("big.mp4", 9)).toThrow("the too-large listener blew up");

    const skipped = makeReporter({
      onFileSkipped: () => {
        throw new Error("the skipped listener blew up");
      },
    });
    expect(() => skipped.reportSkipped("deep.md", "path-too-long")).toThrow(
      "the skipped listener blew up",
    );

    const settings = makeReporter({
      onSettingsApplied: () => {
        throw new Error("the settings listener blew up");
      },
    });
    expect(() => settings.reportSettingsApplied(".obsidian/app.json", "write")).toThrow(
      "the settings listener blew up",
    );
  });
});
