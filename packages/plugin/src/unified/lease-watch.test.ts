import type { DataAdapter } from "obsidian";
import { Platform } from "obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { watchLeaseDirectory } from "./lease-watch";

/**
 * The desktop wake-up is the difference between a handoff in milliseconds and one bounded
 * by the fallback timer. Obsidian has no adapter watcher, so the plugin reaches `fs` through
 * `window.require` — see the module: a dynamic `import("node:fs")` is the browser's import
 * in the renderer and rejects, which made this watcher a silent no-op on every desktop.
 *
 * The fake is installed on `window.require`, which is the path the module actually takes;
 * mocking the `node:fs` specifier would keep passing while the real app failed.
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

/** What Electron's renderer exposes to a plugin: `window.require` resolving Node builtins. */
function installRequire(resolve: (id: string) => unknown): void {
  (window as unknown as { require?: (id: string) => unknown }).require = resolve;
}

describe("watchLeaseDirectory", () => {
  afterEach(() => {
    listeners = [];
    close.mockClear();
    watch.mockClear();
    Platform.isDesktop = true;
    delete (window as unknown as { require?: unknown }).require;
  });

  it("is a no-op on mobile and without a filesystem adapter", async () => {
    installRequire(() => ({ watch }));
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

  it("is a no-op where the renderer has no require", async () => {
    const adapter = { getBasePath: () => "/vault" } as unknown as DataAdapter;

    await expect(watchLeaseDirectory(adapter, () => {})).resolves.toStrictEqual(
      expect.any(Function),
    );
    expect(watch).not.toHaveBeenCalled();
  });

  it("watches .courier, wakes on a release, and ignores owner renewals", async () => {
    installRequire(() => ({ watch }));
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

  it("falls back to the `fs` spelling when the renderer rejects node:", async () => {
    installRequire((id) => {
      if (id !== "fs") throw new Error(`unknown module ${id}`);
      return { watch };
    });
    const adapter = { getBasePath: () => "/vault" } as unknown as DataAdapter;

    await watchLeaseDirectory(adapter, () => {});

    // The first spelling (`node:fs`) threw, the second one installed the watcher.
    expect(watch).toHaveBeenCalledTimes(1);
  });
});
