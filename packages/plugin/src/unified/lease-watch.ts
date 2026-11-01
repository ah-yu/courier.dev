import type { DataAdapter } from "obsidian";

/**
 * Wake a waiting plugin immediately when the vault's lease directory changes.
 *
 * The CLI side runs on Bun, so it can watch this directory directly. Obsidian exposes no
 * filesystem watcher on its adapter; on desktop the adapter is a `FileSystemAdapter` and
 * Electron's `window.require` gives us the desktop `fs`. Mobile has no such path, so callers
 * keep the short timer as the fallback and this function simply returns a no-op.
 */
export function watchLeaseDirectory(adapter: DataAdapter, onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const require =
    (window as unknown as { require?: (id: string) => unknown }).require ??
    (window as unknown as { require?: (id: string) => unknown }).require;
  if (!require) return () => {};
  // Only the desktop `FileSystemAdapter` has a base path; the mobile adapter has none.
  const getBasePath = (adapter as { getBasePath?: () => string }).getBasePath;
  if (typeof getBasePath !== "function") return () => {};

  try {
    const fs = require("fs") as {
      watch(
        path: string,
        options: { persistent: boolean },
        listener: (event: string, filename: string | null) => void,
      ): { close(): void; on(event: "error", listener: () => void): void };
    };
    const path = require("path") as { join(...parts: string[]): string };
    const watcher = fs.watch(
      path.join(getBasePath.call(adapter), ".courier"),
      { persistent: false },
      // Wake on every lease-directory event. Release removes several files and a platform
      // may report only one of them; an extra retry on a renewal is cheaper than missing
      // the release and waiting for the fallback timer.
      () => onChange(),
    );
    watcher.on("error", () => {});
    return () => watcher.close();
  } catch {
    // The directory may not exist yet, or the runtime refuses those modules; the retry
    // timer still covers it.
    return () => {};
  }
}
