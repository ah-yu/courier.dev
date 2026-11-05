import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { basename, join } from "path";
import { fileURLToPath } from "url";
import { isConflictFile } from "../../../engine/src/index";
import {
  enableCommunityPlugins,
  ensureObsidianRunning,
  evalInVault,
  openVaultInObsidian,
  vaultIsReachable,
} from "./cli";

/**
 * The disposable Obsidian vaults the real-app end-to-end suite drives.
 *
 * They are deliberately **not** the developer's `vault_a` / `vault_b` dev vaults:
 * the suite wipes every note and resets the plugin before each run, which would
 * be hostile to a vault someone is actually using. These two exist only for the
 * suite, live in a gitignored folder, and can be deleted at any time (run
 * `bun run e2e:obsidian setup --clean` while Obsidian is closed).
 *
 * Obsidian reads its vault registry once at startup, so a vault has to be
 * registered and Obsidian restarted before the CLI can address it — that is what
 * `packages/e2e/scripts/setup-obsidian-vaults.ts` does, once.
 *
 * ## Why the names carry the checkout
 *
 * Obsidian routes `obsidian://open?vault=<name>` and the CLI's `vault=<name>` **by
 * name**, and one name resolves to one folder in its registry. Two checkouts that
 * both used `courier-e2e-a` would therefore share one window: the suite would write
 * and assert on this checkout's folder while the plugin it drives ran against the
 * other one. Suffixing the worktree name keeps every checkout's pair its own, which
 * is what lets two worktrees run L3 at the same time.
 */
export const E2E_VAULT_ROOT = fileURLToPath(new URL("../../../../.e2e-vaults/", import.meta.url));

export interface E2eVault {
  /** Name Obsidian knows the vault by (its folder name). */
  name: string;
  /** Absolute path of the vault folder. */
  path: string;
}

/**
 * The directory name of the checkout, sanitized for a vault name.
 *
 * Every checkout gets its own suffix, the primary one included: Obsidian resolves a vault
 * by **folder name**, and two primary checkouts (the same repository cloned twice, or the
 * open-source repository beside a private one) would otherwise register the same name twice
 * and one of them would drive the other's folder. `.git` being a directory or a file is
 * irrelevant here — only the directory name is used — so this needs no git process. The dev
 * loop uses the same rule for its own vaults (`packages/plugin/scripts/dev-setup.ts`).
 */
export function checkoutSlug(
  root = fileURLToPath(new URL("../../../../", import.meta.url)),
): string {
  return basename(root.replace(/[\\/]+$/, ""))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

/** The two e2e vaults of this checkout, honouring the env overrides of the dev loop. */
export function e2eVaults(): [E2eVault, E2eVault] {
  const suffix = checkoutSlug();
  const names = suffix
    ? [`courier-e2e-a-${suffix}`, `courier-e2e-b-${suffix}`]
    : ["courier-e2e-a", "courier-e2e-b"];
  const a = process.env.COURIER_E2E_VAULT_A ?? names[0]!;
  const b = process.env.COURIER_E2E_VAULT_B ?? names[1]!;
  return [
    { name: a, path: join(E2E_VAULT_ROOT, a) },
    { name: b, path: join(E2E_VAULT_ROOT, b) },
  ];
}

/** Where the plugin lives inside a vault. */
export function pluginDir(vault: E2eVault): string {
  return join(vault.path, ".obsidian", "plugins", "courier");
}

/** Where the plugin persists its settings. */
export function pluginDataFile(vault: E2eVault): string {
  return join(pluginDir(vault), "data.json");
}

/** Repo root, for locating the built plugin. */
export function repoRoot(): string {
  return fileURLToPath(new URL("../../../../", import.meta.url));
}

/**
 * Create the vault folder (if needed) and install the current plugin build into
 * it, enabling it via `community-plugins.json` exactly like the dev-loop
 * installer does for `vault_a` / `vault_b`.
 *
 * Requires `packages/plugin/dist/main.js` to exist — run the plugin build first.
 */
export function installPluginIntoVault(vault: E2eVault): void {
  const pluginRoot = join(repoRoot(), "packages", "plugin");
  const dist = join(pluginRoot, "dist", "main.js");
  const manifest = join(pluginRoot, "manifest.json");
  const styles = join(pluginRoot, "styles.css");
  if (!existsSync(dist)) {
    throw new Error(`Plugin build not found at ${dist} — build @courier/plugin first.`);
  }
  if (!existsSync(styles)) {
    throw new Error(`Plugin styles not found at ${styles} — the plugin folder needs styles.css.`);
  }

  const target = pluginDir(vault);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "main.js"), readFileSync(dist));
  writeFileSync(join(target, "manifest.json"), readFileSync(manifest));
  // Obsidian loads `styles.css` from the plugin folder; without it the row action and the
  // comparison tab lose their layout and colours — the same kind of hard requirement as
  // `main.js`, which is why a missing file throws instead of silently shipping no styles.
  writeFileSync(join(target, "styles.css"), readFileSync(styles));

  const enabledFile = join(vault.path, ".obsidian", "community-plugins.json");
  let enabled: string[] = [];
  if (existsSync(enabledFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(enabledFile, "utf8"));
      if (Array.isArray(parsed)) enabled = parsed as string[];
    } catch {
      // Unreadable/corrupt — start fresh rather than aborting.
    }
  }
  if (!enabled.includes("courier")) enabled.push("courier");
  writeFileSync(enabledFile, `${JSON.stringify(enabled, null, 2)}\n`);
}

/**
 * Wipe a vault back to an empty, unbound state: every note removed and the
 * plugin's `data.json` deleted, so the next `plugin:reload` starts from
 * `DEFAULT_SETTINGS`.
 *
 * Called both before a run (fresh state) and after it (leave nothing behind).
 * The folder itself stays because Obsidian has the vault open and keeps handles
 * on it — the CLI has no "close vault" command.
 *
 * A path the watcher still lists but the disk has already lost is skipped, not an
 * error: `Vault.delete` updates the index through the file watcher, so a peer's
 * propagated delete (or a delete a previous run left in the watcher's queue) can
 * remove a file between this loop's listing and its unlink. The wipe's job is the
 * absence, and an ENOENT whose path is no longer on disk has already done its part.
 */
export async function resetVault(vault: E2eVault): Promise<void> {
  await evalInVault(
    vault.name,
    `
    const files = app.vault.getFiles();
    let removed = 0;
    for (const file of files) {
      try {
        await app.vault.delete(file);
        removed++;
      } catch (err) {
        if (await app.vault.adapter.exists(file.path)) throw err;
      }
    }
    return removed;
    `,
    180_000,
  );
  rmSync(pluginDataFile(vault), { force: true });
  for (const copy of configConflictCopies(vault)) rmSync(copy, { force: true });
}

/**
 * The conflict copies the config folder holds, which the wipe above cannot reach.
 *
 * `getFiles()` is the **vault index**, and the config folder is deliberately not in it (see
 * `docs/sync-scope.md`): a leftover file at `.obsidian/core-plugins-….conflict.json` survives the delete,
 * and the next run would read it as its own — the settings cases assert that a device which
 * does not sync a group parks **nothing**, so one stale copy fails that run. No current code
 * path parks one (a config-folder conflict is settled by modification time and leaves no
 * file), so this clears what an older build or a hand-placed file left behind, which is the
 * same reason `data.json` is deleted. Copies are never synced, so removing them is safe.
 */
function configConflictCopies(vault: E2eVault): string[] {
  const configDir = join(vault.path, ".obsidian");
  if (!existsSync(configDir)) return [];
  return readdirSync(configDir, { recursive: true })
    .map((entry) => join(configDir, String(entry)))
    .filter((path) => isConflictFile(basename(path)) && statSync(path).isFile());
}

/**
 * The operations {@link prepareVault} uses, injectable so "an already-open vault is
 * never re-opened" can be unit-tested without Obsidian running.
 */
export interface PrepareVaultDeps {
  /** Make sure a running Obsidian answers the CLI, launching it when it is down. */
  ensureRunning: () => Promise<void>;
  /** True when the vault already has a window an `eval` can run in. */
  isReachable: (name: string) => Promise<boolean>;
  /** Open (or focus) a vault window through the `obsidian://open` URI. */
  openWindow: (name: string) => void;
  /** The folder the app actually has open under this vault name. */
  vaultPath: (name: string) => Promise<string>;
  /** Switch off restricted mode for the vault. */
  enablePlugins: (name: string) => Promise<void>;
  /** Sleep between reachability polls. */
  wait: (ms: number) => Promise<void>;
}

const DEFAULT_PREPARE_DEPS: PrepareVaultDeps = {
  ensureRunning: ensureObsidianRunning,
  isReachable: vaultIsReachable,
  openWindow: openVaultInObsidian,
  vaultPath: (name) => evalInVault<string>(name, "return app.vault.adapter.getBasePath();", 60_000),
  enablePlugins: enableCommunityPlugins,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A path as it compares: separators and, on Windows, case. */
function comparablePath(value: string): string {
  const folded = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? folded.toLowerCase() : folded;
}

/** Compare the way the filesystem does. */
function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

/**
 * Make a registered vault usable by the suite: give it a window and switch off
 * restricted mode.
 *
 * Both steps matter and neither is obvious:
 *   - the CLI can only run `eval` in a vault that has a window, and
 *   - a vault Obsidian has never opened comes up in **restricted mode**, which
 *     keeps every community plugin (including Courier) from loading even though
 *     `community-plugins.json` lists it.
 *
 * The window is created **only when the vault has none**. `obsidian://open` makes
 * Obsidian restore a minimized window and focus an existing one, which would raise the
 * app over whatever the developer is doing; the CLI's own `eval` path asks for
 * `focus: false`, so every later call leaves the window where it is. A warm run (the
 * normal L3 state) therefore never reaches the URI handler at all.
 *
 * The folder is then **verified**: a name shared with another checkout resolves to that
 * checkout's folder, and every assertion afterwards would silently describe the wrong
 * vault. Naming the pair after the checkout avoids that; this check catches a registry
 * that still points somewhere else (an older checkout's registration, a moved folder).
 */
export async function prepareVault(
  vault: E2eVault,
  timeoutMs = 180_000,
  deps: Partial<PrepareVaultDeps> = {},
): Promise<void> {
  const d = { ...DEFAULT_PREPARE_DEPS, ...deps };
  await d.ensureRunning();

  if (await d.isReachable(vault.name)) {
    // Already has a window: leave it exactly where it is (possibly behind other
    // windows, or minimized).
    console.log(`[courier:e2e] ${vault.name} is already open — leaving its window in place`);
  } else {
    // No window yet. The URI handler creates one and has to show it, which is the only
    // moment this harness can raise the app.
    d.openWindow(vault.name);
    const deadline = Date.now() + timeoutMs;
    let announced = false;
    let reachable = false;
    while (Date.now() < deadline) {
      if (await d.isReachable(vault.name)) {
        reachable = true;
        break;
      }
      if (!announced) {
        announced = true;
        console.log(`[courier:e2e] waiting for vault "${vault.name}" to open in Obsidian ...`);
      }
      await d.wait(2_000);
    }
    if (!reachable) {
      throw new Error(
        `Obsidian never became reachable in "${vault.name}". Is it running, with the CLI ` +
          `enabled and ${vault.path} registered as a vault? Run \`bun run e2e:obsidian\`.`,
      );
    }
  }

  const opened = await d.vaultPath(vault.name);
  if (!samePath(opened, vault.path)) {
    throw new Error(
      `Obsidian has "${vault.name}" open at ${opened}, but this run owns ${vault.path}.\n` +
        "Obsidian resolves a vault by name, so this checkout's pair is not what the app " +
        "opened — another checkout is registered under that name, or this folder was " +
        "re-created after it was registered.\n" +
        "Close Obsidian and run `bun run e2e:obsidian` in this checkout.",
    );
  }

  await d.enablePlugins(vault.name);
}
