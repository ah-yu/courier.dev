#!/usr/bin/env bun
/**
 * Bundle the Obsidian plugin with Bun's own bundler.
 *
 * Obsidian loads exactly one file, `dist/main.js`, as CommonJS, with `obsidian`
 * (and Electron's module surface) provided by the app at runtime. That is the
 * whole contract this build has to keep: one CJS file, those specifiers left as
 * `require(...)`, and the plugin class as `module.exports`.
 *
 * `--watch` rebuilds on a change under `src/` and, in development, copies the
 * result into this checkout's two development vaults and asks the running
 * Obsidian to reload the plugin (see `scripts/dev-vaults.ts`).
 *
 * The development fixtures are loaded **on demand**, never at the top level: a release
 * build runs from a checkout that has this script and nothing else beside it (the
 * publishing mirror), and a static import of `dev-vaults.ts` would make the build fail
 * there before it ever reached the bundler.
 */
import { copyFileSync, existsSync, mkdirSync, watch } from "fs";
import { join } from "path";

const pluginDir = join(import.meta.dir, "..");
const prod = process.argv.includes("--production");
const watching = process.argv.includes("--watch");

/** Bundle once. Returns false when the bundler reported an error. */
async function build(): Promise<boolean> {
  const result = await Bun.build({
    entrypoints: [join(pluginDir, "src", "plugin-entry.ts")],
    outdir: join(pluginDir, "dist"),
    naming: "main.js",
    format: "cjs",
    target: "browser",
    // Obsidian supplies these at runtime; bundling them would ship a second copy.
    //
    // `node:fs` is here for the lease watcher, which imports it **dynamically** behind
    // `Platform.isDesktop` (`src/unified/lease-watch.ts`). Left to the bundler it is
    // resolved to a browser shim, so it stays a runtime import that only the desktop
    // branch ever evaluates. The path is built by hand there; `node:path` is not imported.
    external: ["obsidian", "electron", "node:fs", "@codemirror/*", "@lezer/*"],
    sourcemap: prod ? "none" : "inline",
    minify: prod,
    // One file, as Obsidian's loader expects.
    splitting: false,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    return false;
  }
  return true;
}

/** Copy the built plugin into every development vault's plugin folder. */
/** One development vault: the folder to copy into, and the name Obsidian knows it by. */
type DevVault = { path: string; name: string };

/**
 * The checkout's development vaults.
 *
 * A dynamic import on purpose — see the header: the release build runs where this script
 * is the only thing in `scripts/`.
 */
async function loadDevVaults(): Promise<DevVault[]> {
  const { devVaults } = await import("./dev-vaults.ts");
  return devVaults();
}

function syncToDevVaults(vaults: readonly DevVault[]): void {
  const files = [
    { from: join(pluginDir, "dist", "main.js"), to: "main.js" },
    { from: join(pluginDir, "manifest.json"), to: "manifest.json" },
    // Obsidian loads `styles.css` from the plugin folder; it is source, not build output.
    { from: join(pluginDir, "styles.css"), to: "styles.css" },
  ];
  for (const vault of vaults) {
    const target = join(vault.path, ".obsidian", "plugins", "courier");
    mkdirSync(target, { recursive: true });
    for (const { from, to } of files) {
      if (existsSync(from)) copyFileSync(from, join(target, to));
    }
  }
}

let cliChecked = false;
let cliAvailable = false;

/** Whether the official Obsidian CLI is on PATH (probed at most once). */
function checkCliAvailable(): boolean {
  if (cliChecked) return cliAvailable;
  cliChecked = true;
  try {
    const probe = Bun.spawnSync(["obsidian", "--version"], { stdout: "ignore", stderr: "ignore" });
    cliAvailable = probe.exitCode === 0;
  } catch {
    cliAvailable = false;
  }
  if (!cliAvailable) {
    console.warn(
      "[courier:dev] obsidian CLI not found on PATH — hot reload disabled. " +
        "Install it / add it to PATH, or set COURIER_DEV_RELOAD=0 to silence this message.",
    );
  }
  return cliAvailable;
}

/** Ask every open development vault to reload the plugin; best effort, never fatal. */
function reloadVaults(vaults: readonly DevVault[]): void {
  if (process.env.COURIER_DEV_RELOAD === "0") return;
  if (!checkCliAvailable()) return;
  for (const vault of vaults) {
    for (const command of ["plugin:enable", "plugin:reload"]) {
      const child = Bun.spawn(["obsidian", `vault=${vault.name}`, command, "id=courier"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      void child.exited;
    }
  }
}

/** What a development build does after bundling: copy into the vaults, ask for a reload. */
async function afterDevBuild(): Promise<void> {
  const vaults = await loadDevVaults();
  syncToDevVaults(vaults);
  reloadVaults(vaults);
}

if (!(await build())) process.exit(1);
if (!prod) await afterDevBuild();

if (watching) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(join(pluginDir, "src"), { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (await build()) {
        if (!prod) await afterDevBuild();
      }
    }, 100);
  });
  console.log("[courier:dev] watching src/ for changes");
}
