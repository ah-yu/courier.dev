import { Platform, type DataAdapter } from "obsidian";

/** The directory the lease lives in: a waiter wakes on anything that touches it. */
const LEASE_PARENT = ".courier";

/**
 * Wake a waiting plugin immediately when the vault's lease directory changes.
 *
 * The CLI side runs on Bun, so it can watch this directory directly. Obsidian exposes no
 * filesystem watcher on its adapter; only the desktop `FileSystemAdapter` has a base path,
 * and its `fs` is the one the renderer's Node integration provides. Mobile has no such
 * path, so callers keep the short timer as the fallback and this function resolves to a
 * no-op.
 *
 * The modules are imported **dynamically**, behind `Platform.isDesktop`: a static
 * `import "fs"` is resolved when the plugin loads, and the mobile bundle has no such module.
 */
export async function watchLeaseDirectory(
  adapter: DataAdapter,
  onChange: () => void,
): Promise<() => void> {
  if (!Platform.isDesktop) return () => {};
  // Only the desktop `FileSystemAdapter` has a base path; the mobile adapter has none.
  const getBasePath = (adapter as { getBasePath?: () => string }).getBasePath;
  if (typeof getBasePath !== "function") return () => {};

  try {
    const fs = await import("node:fs");
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
