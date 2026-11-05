import { posix, win32 } from "path";

/**
 * The OS-specific facts the L3 harness needs, as pure functions.
 *
 * The suite normally runs on the developer's Windows machine, so the Linux and
 * macOS branches are otherwise never executed before CI does. Keeping them here
 * (instead of inline in `cli.ts` / the setup script) lets `platform.test.ts`
 * pin the paths and the launch shapes on every test run.
 */

/**
 * The OS identifier `process.platform` reports, which is what the harness branches on.
 *
 * Only the three hosts this suite runs on are meaningful here; every other value falls
 * through to the Linux branch, exactly like an unrecognized distribution would.
 */
export type HostPlatform = typeof process.platform;

export interface RegistryPathOptions {
  platform: HostPlatform;
  /** `%APPDATA%` on Windows, or the fallback the caller computed. */
  appData: string;
  /** The user's home directory. */
  home: string;
  /** `$XDG_CONFIG_HOME` on Linux, when it is set. */
  xdgConfigHome?: string;
}

/**
 * Where Obsidian keeps its vault registry (`obsidian.json`).
 *
 * Obsidian reads this file only at startup, which is why the setup script must
 * run while the app is closed. The location follows Electron's `userData`:
 * `%APPDATA%` on Windows, `Application Support` on macOS, and
 * `$XDG_CONFIG_HOME` (default `~/.config`) on Linux.
 */
export function obsidianRegistryPath({
  platform,
  appData,
  home,
  xdgConfigHome,
}: RegistryPathOptions): string {
  if (platform === "win32") return win32.join(appData, "obsidian", "obsidian.json");
  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  }
  const configHome =
    xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : posix.join(home, ".config");
  return posix.join(configHome, "obsidian", "obsidian.json");
}

export interface LaunchOptions {
  platform: HostPlatform;
  /**
   * Absolute path to the Obsidian app binary. On Linux it is required to start
   * the app; when it is absent a URI falls back to `xdg-open`.
   */
  appPath?: string;
  /** An `obsidian://open?...` URI to hand to the running (or new) app. */
  uri?: string;
  /** Extra Chromium/Electron flags, CI only (for example `--no-sandbox`). */
  flags?: string[];
}

export interface LaunchCommand {
  command: string;
  args: string[];
}

/**
 * The command that launches Obsidian, or forwards a vault URI to it.
 *
 * Windows is the reason this exists: `Obsidian.com` is a console redirector and
 * `execFile` cannot resolve it from a bare name, while a URI has to go through
 * the `start` protocol handler. Linux launches the app binary directly — CI has
 * no desktop-file handler for `obsidian://` — and `flags` are what make Electron
 * usable there (`--no-sandbox`). macOS uses `open`.
 */
export function obsidianLaunchCommand({
  platform,
  appPath,
  uri,
  flags = [],
}: LaunchOptions): LaunchCommand {
  if (platform === "win32") {
    // `start` reads the first quoted argument as the window title; the empty
    // `""` keeps a quoted path or URI from being consumed as one.
    return {
      command: "cmd",
      args: ["/c", "start", "", ...(uri ? [uri] : appPath ? [appPath, ...flags] : [])],
    };
  }
  if (platform === "darwin") {
    if (uri) return { command: "open", args: [uri] };
    // The app *name* is resolved through LaunchServices, which does not know a bundle
    // that was merely copied into /Applications — a CI runner, where the app never went
    // through the Finder. The path form asks for that bundle directly, so an explicit
    // `COURIER_OBSIDIAN_APP` wins when the harness has one.
    return {
      command: "open",
      args: [
        "-a",
        appPath ? appBundlePath(appPath) : "Obsidian",
        ...(flags.length > 0 ? ["--args", ...flags] : []),
      ],
    };
  }
  if (uri && !appPath) return { command: "xdg-open", args: [uri] };
  return {
    command: appPath ?? "obsidian",
    args: [...flags, ...(uri ? [uri] : [])],
  };
}

/**
 * The application bundle a macOS `open -a` expects.
 *
 * `COURIER_OBSIDIAN_APP` names the app *binary* on Linux and Windows. On macOS `open -a`
 * wants the bundle instead, and a developer (or an older CI action) may still point the
 * variable at `Obsidian.app/Contents/MacOS/Obsidian` — a path `open -a` does not take.
 * Strip back to the `.app` when the path is inside one; anything else passes through.
 */
export function appBundlePath(path: string): string {
  const marker = ".app/Contents/MacOS/";
  const index = path.indexOf(marker);
  return index === -1 ? path : path.slice(0, index + ".app".length);
}

export interface LayoutGateOptions {
  platform: HostPlatform;
  /** `COURIER_OBSIDIAN_E2E_LAYOUT`; `"1"` forces on, `"0"` forces off. */
  override?: string;
  /** `COURIER_OBSIDIAN_LAYOUT_PLATFORM`; defaults to Windows. */
  reference?: string;
}

/**
 * Whether the rendered-geometry (layout) assertions run on this host.
 *
 * Those assertions measure fonts, DPI, the theme and window state, so they are a
 * contract with one **reference platform** — the machine whose UI the design is
 * checked against — not with every OS. The default is Windows because the cases
 * were written and tuned there. `COURIER_OBSIDIAN_LAYOUT_PLATFORM` moves the
 * reference, `COURIER_OBSIDIAN_E2E_LAYOUT=1` forces a trial run anywhere, and
 * `=0` (CI) turns them off.
 */
export function layoutAssertionsEnabled({
  platform,
  override,
  reference = "win32",
}: LayoutGateOptions): boolean {
  if (override === "0") return false;
  if (override === "1") return true;
  return platform === reference;
}
