import { Platform, type DataAdapter } from "obsidian";

/** The directory the lease lives in: a waiter wakes on anything that touches it. */
const LEASE_PARENT = ".courier";

/** The one `fs` method this module uses, so it needs no Node types. */
interface LeaseWatcher {
  on(event: string, listener: () => void): void;
  close(): void;
}
interface LeaseFs {
  watch(path: string, options: { persistent: boolean }, listener: () => void): LeaseWatcher;
}

/**
 * `fs`, loaded the way Obsidian's desktop renderer actually provides it.
 *
 * It has to be `require`. A dynamic `import("node:fs")` here is the **browser's** import:
 * Obsidian evaluates the plugin in a renderer, where it rejects with "Failed to fetch
 * dynamically imported module: node:fs". That failure was caught and reported as "no
 * watcher", so every desktop session silently fell back to the retry timer — the waiter
 * after a release, and a holder after a takeover, both waited five seconds for an event
 * that was never coming. Electron exposes Node to the renderer through `window.require`.
 *
 * Mobile has neither, so this answers null and the callers keep their timers.
 */
function loadLeaseFs(): LeaseFs | null {
  if (!Platform.isDesktop) return null;
  const requireFn = (window as unknown as { require?: (id: string) => unknown }).require;
  if (typeof requireFn !== "function") return null;
  for (const id of ["node:fs", "fs"]) {
    try {
      const fs = requireFn(id) as Partial<LeaseFs> | undefined;
      if (fs && typeof fs.watch === "function") return fs as LeaseFs;
    } catch {
      // Try the other spelling; a renderer may know only one of them.
    }
  }
  return null;
}

/**
 * Wake a waiting plugin immediately when the vault's lease directory changes.
 *
 * The CLI side runs on Bun, so it can watch this directory directly. Obsidian exposes no
 * filesystem watcher on its adapter; only the desktop `FileSystemAdapter` has a base path,
 * and the renderer reaches `fs` through `require` (see {@link loadLeaseFs}). Mobile has no
 * such path, so callers keep the short timer as the fallback and this function resolves to
 * a no-op.
 */
export async function watchLeaseDirectory(
  adapter: DataAdapter,
  onChange: () => void,
): Promise<() => void> {
  const fs = loadLeaseFs();
  if (fs === null) return () => {};
  // Only the desktop `FileSystemAdapter` has a base path; the mobile adapter has none.
  const getBasePath = (adapter as { getBasePath?: () => string }).getBasePath;
  if (typeof getBasePath !== "function") return () => {};

  try {
    // Joined by hand rather than through `node:path`: a bundled `path` shim would be the
    // bundler's idea of the separator, not this machine's, and `fs.watch` accepts forward
    // slashes on every platform Node supports.
    const base = getBasePath.call(adapter).replace(/[\\/]+$/, "");
    const watcher = fs.watch(
      `${base}/${LEASE_PARENT}`,
      { persistent: false },
      // Wake on every lease-directory event. Release removes several files and a platform
      // may report only one of them; an extra retry on a renewal is cheaper than missing
      // the release and waiting for the fallback timer.
      () => onChange(),
    );
    watcher.on("error", () => {});
    return () => watcher.close();
  } catch (error) {
    // The directory may not exist yet, or the runtime refuses those modules; the retry timer
    // still covers it. Say so once: a silent failure here looks exactly like a slow release.
    console.warn("Courier: could not watch the sync lease directory:", error);
    return () => {};
  }
}
