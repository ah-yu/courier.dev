import type { DataAdapter } from "obsidian";
import { Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchLeaseDirectory } from "./lease-watch";

/**
 * The desktop wake-up is the difference between a handoff in milliseconds and one bounded
 * by the fallback timer. Obsidian has no adapter watcher, so this is the one place the
 * plugin reaches for a desktop-only module; the no-op paths are what keep mobile and the
 * test runtime safe.
 *
 * The modules are imported dynamically (`await import("fs")`), so the fakes are installed
 * with `vi.mock` rather than through `window.require`.
 */
const watch = vi.fn(
  (
    _path: string,
    _options: { persistent: boolean },
    callback: (event: string, filename: string | null) => void,
  ) => {
    listeners.push(callback);
    return { close, on: vi.fn() };
  },
);
let listeners: Array<(event: string, filename: string | null) => void> = [];
const close = vi.fn();

vi.mock("fs", () => ({ watch }));
vi.mock("path", () => ({ join: (...parts: string[]) => parts.join("/") }));

describe("watchLeaseDirectory", () => {
  afterEach(() => {
    listeners = [];
    close.mockClear();
    watch.mockClear();
    Platform.isDesktop = true;
  });

  it("is a no-op on mobile and without a filesystem adapter", async () => {
    Platform.isDesktop = false;
    await expect(watchLeaseDirectory({} as DataAdapter, () => {})).resolves.toStrictEqual(
      expect.any(Function),
    );
    expect(watch).not.toHaveBeenCalled();

    Platform.isDesktop = true;
    await expect(watchLeaseDirectory({} as DataAdapter, () => {})).resolves.toStrictEqual(
      expect.any(Function),
    );
    expect(watch).not.toHaveBeenCalled();
  });

  it("watches .courier, wakes on a release, and ignores owner renewals", async () => {
    const onChange = vi.fn();
    const adapter = { getBasePath: () => "/vault" } as unknown as DataAdapter;

    const stop = await watchLeaseDirectory(adapter, onChange);

    expect(watch).toHaveBeenCalledWith(
      "/vault/.courier",
      { persistent: false },
      expect.any(Function),
    );
    const listener = listeners[0]!;
    listener("rename", "sync-lease");
    listener("change", "sync-lease/owner.json");
    listener("change", null);
    expect(onChange).toHaveBeenCalledTimes(3);

    stop();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
