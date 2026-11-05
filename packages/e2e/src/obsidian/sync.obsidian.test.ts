import { spawnSync } from "child_process";
import { mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  startTestServer,
  patchTestUser,
  setUserMaxFileBytes,
  type TestServer,
} from "../harness/server";
import { createTestClient } from "../harness/client";
import {
  createTestVault,
  makeVaultMaterial,
  type TestVault,
  type VaultMaterial,
} from "../harness/vault";
import {
  deletedFiles,
  fileVersions,
  filesAtPath,
  updateVaultSettings,
  vaultHistory,
  vaultSettings,
  versionDeviceNames,
} from "../harness/api";
import { waitForAsync } from "../harness/wait";
import { conflictCopyOf } from "../harness/conflict";
import {
  DEFAULT_FILE_TYPES,
  DEFAULT_MAX_FILE_BYTES,
  NO_SETTINGS_GROUPS,
  type SettingsGroup,
} from "../../../engine/src/index";
import { DEFAULT_HISTORY_LIMITS } from "../../../shared/src/index";
import { EXCLUDED_PATH_ROW_CLASS } from "../../../plugin/src/ui/file-explorer-excluded-folders";
import { VERSION_HISTORY_ACTION_CLASS } from "../../../plugin/src/ui/file-explorer-actions";
import { t } from "../../../plugin/src/i18n";
import {
  corePluginRuntimeState,
  evalInVault,
  jsLiteral,
  listVaultFiles,
  readVaultFile,
  reloadCourierPlugin,
} from "./cli";
import { layoutAssertionsEnabled } from "./platform";
import {
  ObsidianVault,
  clickConflictAction,
  clickConflictDialogButton,
  closeConflictDiffs,
  clickOpenModalButton,
  clickPauseRow,
  clickRecycleBinRefresh,
  clickRecycleBinRestore,
  clickStatusBarItem,
  clickStatusMenuRow,
  clickVersionHistoryChip,
  clickVersionHistoryRow,
  closeOpenModals,
  closeVersionHistories,
  configurePluginHost,
  clickSettingsBlank,
  ensurePluginHostRunning,
  expandFileExplorerFolder,
  fileIdForPath,
  fillRestoreName,
  keepSettingsInVaultWindow,
  listConfigFolderInVault,
  clickRecycleBinFile,
  openRecycleBinDialog,
  openSyncHistoryDialog,
  pausePluginHost,
  readConfigFileInVault,
  measureConflictActionNarrow,
  readConflictActionButton,
  readConflictDiff,
  readConflictReplaceConfirm,
  readDeletedContent,
  readFileExplorerRowClass,
  readFileExplorerRowChips,
  readFileMenuTitles,
  readHistoryLimitRow,
  readNotices,
  readPauseRow,
  readPluginStatus,
  readRecycleBinDialog,
  readRecycleBinRefresh,
  readSettingsAccountUsage,
  readRestoreNameField,
  readStatusBar,
  readStatusMenu,
  readStatusMenuPlacement,
  readStatusMenuStorage,
  readStatusMenuStyles,
  readSyncHistoryDialog,
  readVersionHistoryChipBesideTag,
  readVersionHistoryView,
  reconcile,
  removeConfigFileInVault,
  removeConfigFolderInVault,
  restoreSettingsWindow,
  runSettingsPass,
  selectConflictDiffMode,
  setExcludedFoldersInVault,
  setMobileEmulation,
  syncPluginLocale,
  vaultBasePath,
  writeConfigFileInVault,
  editHistoryLimitRow,
  clickHistoryLimitRowLabel,
  clickHistoryLimitRowField,
  measureHistoryLimitRow,
  openHistoryLimitEditor,
  openPluginSettings,
  type PluginHostSetup,
} from "./plugin-control";
import {
  e2eVaults,
  installPluginIntoVault,
  prepareVault,
  repoRoot,
  resetVault,
  type E2eVault,
} from "./vaults";

/**
 * L3 — end-to-end against a **real, running Obsidian**.
 *
 * Two real Obsidian vaults with the real Courier plugin loaded are driven through
 * the official Obsidian CLI (`vault=<name> eval`), against the real in-process
 * server. Files are created/edited/deleted through `app.vault.*` — Obsidian's own
 * file layer, so the plugin sees genuine vault events — and verified by reading
 * the *other* vault back.
 *
 * The vaults are **disposable ones** (`.e2e-vaults/`, see `vaults.ts`), not the
 * developer's own dev vaults: every run wipes their notes and the plugin's
 * `data.json` first. They must be registered with Obsidian once —
 *
 *     bun run e2e:obsidian
 *
 * No screenshots and no human: every assertion is a value.
 *
 * Opt-in gate, because it needs a running Obsidian with the CLI enabled
 * (Settings → General → Command line interface):
 *
 *     bun run verify obsidian       # full suite, including the layout cases
 *     bun run verify obsidian-ci    # the headless-CI subset (layout cases skipped)
 *
 * It skips itself in the default `bun run test` / `bun run verify` run.
 *
 * The **layout** gate covers everything that reads rendered geometry
 * (`getBoundingClientRect`, `getComputedStyle`, `styles.css`, the file explorer's
 * row classes) instead of values: a font metric, a DPI or a theme difference
 * moves those numbers without any product change, and a headless runner may not
 * mount the rows at all. Those assertions are a contract with a **reference
 * platform** (Windows by default; `COURIER_OBSIDIAN_LAYOUT_PLATFORM` moves it) and
 * run only there, or when `COURIER_OBSIDIAN_E2E_LAYOUT=1` forces a trial. The
 * behavioural halves of the same flows run everywhere. A new assertion about
 * pixels, computed style or rendered rows belongs in an `itL` case, never in a
 * value case.
 *
 * Note: the suite's server lives in this same process, so every CLI call is
 * asynchronous — a blocking spawn would deadlock the HTTP request the evaluated
 * plugin code is waiting on.
 */
const enabled = process.env.COURIER_OBSIDIAN_E2E === "1";
/**
 * Does the running Obsidian render its menus into a document?
 *
 * Obsidian 1.14 on macOS opens a `Menu` as a **native** menu: no window's DOM contains
 * `.menu` (checked across every `BrowserWindow`), so the cases that read the real menu
 * cannot run there. They still run on the reference platforms and can be forced with
 * `COURIER_OBSIDIAN_MENU_DOM=1`.
 */
const menuIsDom = process.platform !== "darwin" || process.env.COURIER_OBSIDIAN_MENU_DOM === "1";
const itMenu = menuIsDom ? it : it.skip;

const layoutReference = process.env.COURIER_OBSIDIAN_LAYOUT_PLATFORM ?? "win32";
const layout = layoutAssertionsEnabled({
  platform: process.platform,
  override: process.env.COURIER_OBSIDIAN_E2E_LAYOUT,
  reference: layoutReference,
});
if (enabled && !layout) {
  console.log(
    `[courier:e2e] layout assertions skipped (reference platform: ${layoutReference}; ` +
      `this is ${process.platform})`,
  );
}

/**
 * `it` for the rendered-geometry cases: they run on the reference platform, or
 * when `COURIER_OBSIDIAN_E2E_LAYOUT=1` forces a trial run elsewhere.
 */
const itL = layout ? it : it.skip;

/** Prefix for every file this suite creates, so cleanup can be precise. */
const PROBE_PREFIX = "courier-e2e-";

/**
 * A 1×1 PNG, base64. Written through `app.vault.createBinary` to get a real attachment row:
 * Obsidian draws its extension tag for exactly the files it has no view for, and that tag
 * shares the row's right end with the version-history chip.
 */
const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * Folder the nested-path probe notes live in. It also starts with
 * {@link PROBE_PREFIX}, so the folder itself is cleaned up together with the
 * files inside it.
 */
const PROBE_DIR = "courier-e2e-paths";

/** Build the plugin so the disposable vaults get the current source. */
function buildPlugin(): void {
  const result = spawnSync("bun run --filter @courier/plugin build", {
    cwd: repoRoot(),
    shell: true,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `plugin build failed (exit ${result.status})\n${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
}

/**
 * Poll until `predicate` holds. The predicate may be async (each poll is a CLI
 * round-trip); errors are retried, and the last one is reported on timeout.
 */
async function waitForVaultState(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out: ${message}${lastError ? ` (last error: ${String(lastError)})` : ""}`);
}

/** The vault's own record of which chain lives at `path`. */
async function trackedIn(vault: string, path: string): Promise<string | null> {
  return await fileIdForPath(vault, path);
}

/**
 * Wrap the running engine's adapter so every `renameFile` — the one call a
 * followed move depends on — records its outcome.
 *
 * A failure inside a vault **event handler** is swallowed by design (the host
 * logs it and moves on), so without this a lost move shows up only as "the peer
 * still has the note", with no reason attached. The wrapper lives on the engine
 * instance, so one call before the operation under test is enough.
 */
async function instrumentVault(vault: string): Promise<void> {
  await evalInVault(
    vault,
    `
    window.__courierRenames = [];
    const plugin = app.plugins.plugins.courier;
    const engine = plugin && plugin.host && plugin.host.engine;
    const adapter = engine && engine.opts && engine.opts.adapter;
    if (adapter && !adapter.__courierWrapped) {
      const original = adapter.renameFile.bind(adapter);
      adapter.renameFile = async (from, to) => {
        try {
          await original(from, to);
          window.__courierRenames.push('ok ' + from + ' -> ' + to);
        } catch (e) {
          window.__courierRenames.push('ERR ' + from + ' -> ' + to + ' :: ' + (e && e.message));
          throw e;
        }
      };
      adapter.__courierWrapped = true;
    }
    return true;
  `,
  );
}

/**
 * The engine's own view from inside the renderer: its sync state, the
 * self-write/self-rename suppression records, its in-flight markers and the
 * adapter's move log. Read directly (the fields are `private` in TypeScript
 * only) because a follower that silently drops a notification leaves no other
 * trace.
 */
async function engineInternals(vault: string): Promise<string> {
  const dump = await evalInVault<Record<string, unknown>>(
    vault,
    `
    const plugin = app.plugins.plugins.courier;
    const host = plugin && plugin.host;
    const engine = host && host.engine;
    if (!engine) return { missing: true };
    // The suppression records moved into SelfEventLog; read them through whatever the
    // engine still exposes rather than crashing the diagnosis (which used to hide the
    // real convergence failure behind "Cannot read properties of undefined").
    const keysOf = (value) =>
      value && typeof value.keys === 'function' ? [...value.keys()] : [];
    return {
      ws: host.ws ? host.ws.getState() : null,
      initialized: engine.initialized,
      pass: engine.passStatus,
      states: Object.values(engine.state).map((e) => e.plainPath + '@' + String(e.lastKnownVersionId).slice(0, 8)),
      selfWrites: keysOf(engine.selfEvents && engine.selfEvents.selfWrites).filter((p) => p.includes('courier-e2e')),
      inFlight: keysOf(engine.inFlightPaths),
      renames: (window.__courierRenames || []).filter((line) => line.includes('courier-e2e')),
    };
  `,
  );
  return JSON.stringify(dump);
}

/**
 * The reload card on a vault's screen, as the app itself holds it.
 *
 * Read from the DOM instead of from the plugin, because what the user sees is the claim
 * being tested — and where it sits is part of that claim: the card is the plugin's own
 * element (Obsidian's `Notice` container is anchored top-right), so this also reports the
 * corner it landed in.
 */
async function readReloadPopups(
  vault: string,
): Promise<{ count: number; text: string; corner: { right: number; bottom: number } }> {
  return await evalInVault<{
    count: number;
    text: string;
    corner: { right: number; bottom: number };
  }>(
    vault,
    `const els = Array.from(document.querySelectorAll('.courier-reload-notice'));
     const first = els[0];
     const box = first ? first.getBoundingClientRect() : null;
     return {
       count: els.length,
       text: els.map((el) => el.textContent ?? '').join(' '),
       corner: box
         ? { right: window.innerWidth - box.right, bottom: window.innerHeight - box.bottom }
         : { right: -1, bottom: -1 },
     };`,
  );
}

/** Close them without reloading — what a user does when they are not ready to. */
async function dismissReloadPopups(vault: string): Promise<number> {
  return await evalInVault<number>(
    vault,
    `const els = Array.from(document.querySelectorAll('.courier-reload-notice'));
     for (const el of els) {
       const button = Array.from(el.querySelectorAll('button')).find(
         (b) => b.textContent === ${jsLiteral(t("reload.dismiss"))},
       );
       if (button) button.click();
     }
     await new Promise((r) => setTimeout(r, 300));
     return document.querySelectorAll('.courier-reload-notice').length;`,
  );
}

/** Set a config-folder file's mtime on disk — how a test dates "who edited last". */
function setVaultMtime(vault: string, file: string, mtimeMs: number): void {
  const root = e2eVaults().find((entry) => entry.name === vault)?.path;
  if (!root) throw new Error(`unknown e2e vault ${vault}`);
  const time = new Date(mtimeMs);
  utimesSync(join(root, file), time, time);
}

const report = (label: string, result: { before: unknown; after: unknown }): string =>
  `${label}: the app held ${JSON.stringify(result.before)} and then ${JSON.stringify(result.after)}`;

describe.skipIf(!enabled)("obsidian e2e — two real vaults through the CLI", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let remote: TestVault;
  let disposable: [E2eVault, E2eVault];
  let vaultA: ObsidianVault;
  let vaultB: ObsidianVault;
  let names: { a: string; b: string };
  let setup: Omit<PluginHostSetup, "deviceName">;

  /**
   * Remove only this suite's probe notes and probe folders, leaving the two
   * hosts running.
   *
   * One evaluation, not one CLI call per file. Every `eval` is its own process +
   * socket + `executeJavaScript` round trip, and teardown used to make one call for
   * the listing, one per probe file and one per folder; losing any one of them left
   * the hook waiting on a CLI that never answered. The whole wipe is a single
   * idempotent evaluation now, and the probe folder goes through the data adapter
   * recursively (`removeFolderInVault`'s call) instead of walking `getAllFolders`.
   *
   * Best-effort, like the per-step handling it replaces: a probe that cannot be
   * deleted must not abandon the rest or poison a later case. The file loop and the
   * folder removal each catch their own failure; what cannot be removed is reported.
   */
  async function cleanProbes(vault: string): Promise<void> {
    try {
      const result = await evalInVault<{ removed: number; folder: boolean; left: string[] }>(
        vault,
        `
        const prefix = ${jsLiteral(PROBE_PREFIX)};
        const left = [];
        let removed = 0;
        for (const file of app.vault.getFiles()) {
          if (!(file.path.startsWith(prefix) || file.path.includes('/' + prefix))) continue;
          try {
            await app.vault.delete(file);
            removed++;
          } catch (err) {
            if (await app.vault.adapter.exists(file.path)) left.push(file.path);
          }
        }
        const root = ${jsLiteral(PROBE_DIR)};
        let folder = false;
        if (await app.vault.adapter.exists(root)) {
          try {
            await app.vault.adapter.rmdir(root, true);
            folder = true;
          } catch (err) {
            if (await app.vault.adapter.exists(root)) throw err;
          }
        }
        return { removed, folder, left };
        `,
        90_000,
      );
      if (result.left.length > 0) {
        console.warn(
          `[obsidian-e2e] probe cleanup in ${vault} left ${result.left.length} file(s): ${result.left.join(", ")}`,
        );
      }
    } catch (err) {
      console.warn(`[obsidian-e2e] probe cleanup in ${vault} failed:`, err);
    }
  }

  beforeAll(async () => {
    // Dedicated, disposable vaults — never the developer's own dev vaults.
    disposable = e2eVaults();
    names = { a: disposable[0].name, b: disposable[1].name };
    vaultA = new ObsidianVault(names.a);
    vaultB = new ObsidianVault(names.b);

    // 1. Both disposable vaults must be open (with a window: the CLI can only
    //    run `eval` in one) and out of restricted mode, or the plugin never loads.
    for (const vault of disposable) {
      await prepareVault(vault);
    }

    // 2. Fresh start: build the current plugin, install it, wipe every note and
    //    the plugin's own data.json, then reload so it comes up on defaults.
    buildPlugin();
    for (const vault of disposable) {
      installPluginIntoVault(vault);
      await resetVault(vault);
      await reloadCourierPlugin(vault.name);
    }
    // Close a Settings window an earlier run (or the developer) left open, and pin every
    // later `app.setting.open()` to this window: Obsidian 1.14.4 focuses a settings popout
    // on open, which is what used to pull the app to the front mid-run. Done after the
    // plugin reloads, because switching restricted mode can reload a vault and drop a
    // renderer-level pin with it.
    for (const vault of disposable) await keepSettingsInVaultWindow(vault.name);
    // The plugin follows Obsidian's UI language; make the test's expected labels follow
    // the same language instead of assuming the developer's app is Chinese.
    await syncPluginLocale(names.a);

    // 3. A real server, and a remote vault both Obsidian instances will bind to.
    server = await startTestServer("obsidian e2e user");
    material = await makeVaultMaterial();
    remote = await createTestVault(server, "Obsidian E2E", material);

    setup = {
      serverUrl: server.serverUrl,
      userKey: server.userKey,
      vaultId: remote.id,
      vaultName: remote.name,
      encryptionSalt: material.salt,
      password: material.password,
    };

    const statusA = await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" });
    const statusB = await configurePluginHost(names.b, { ...setup, deviceName: "obsidian-B" });
    expect(statusA.hosting, `${names.a} host did not start`).toBe(true);
    expect(statusB.hosting, `${names.b} host did not start`).toBe(true);
    // Two real plugin instances, each stating its own label.
    expect(statusA.deviceName).toBe("obsidian-A");
    expect(statusB.deviceName).toBe("obsidian-B");

    await waitForVaultState(async () => {
      const [a, b] = [await readPluginStatus(names.a), await readPluginStatus(names.b)];
      if (a.wsState === "connected" && b.wsState === "connected") return true;
      // Throwing makes the observed states part of the timeout message.
      throw new Error(`A=${a.wsState} (${a.deviceName}), B=${b.wsState} (${b.deviceName})`);
    }, "both vaults should establish their sync websocket");
  }, 900_000);

  afterEach(async () => {
    await cleanProbes(names.a);
    await cleanProbes(names.b);
  });

  afterAll(async () => {
    if (!enabled) return;
    // Leave the disposable vaults empty and unbound so the next run starts clean.
    for (const vault of disposable) {
      try {
        await resetVault(vault);
        // `resetVault` removes files only, so the probe folders the nested
        // scenarios created have to go too — empty leftovers would otherwise
        // accumulate across runs.
        await cleanProbes(vault.name);
        await reloadCourierPlugin(vault.name);
        // Put the app's own Settings-in-a-popout behaviour back and close the in-window
        // settings page this run left behind.
        await restoreSettingsWindow(vault.name);
      } catch (err) {
        // Best effort — the suite result must not depend on teardown — but never
        // silent.
        console.warn(`[obsidian-e2e] teardown for ${vault.name} failed:`, err);
      }
    }
    await server?.close();
  });

  it("pushes a note created in vault A to the server", async () => {
    const path = `${PROBE_PREFIX}push.md`;
    await vaultA.write(path, "hello from vault A");

    // The plugin's own vault event -> engine -> HTTP push, over real requestUrl.
    await waitForAsync(
      async () => (await vaultHistory(server, remote.id)).some((file) => file.versions.length > 0),
      "the note created in vault A never reached the server",
      60_000,
    );

    const history = await vaultHistory(server, remote.id);
    expect(history[0].versions.at(-1)?.action).toBe("create");
    expect(await fileIdForPath(names.a, path)).toBe(history[0].fileId);
  });

  it("propagates an edit of a known file from vault A to vault B over the websocket", async () => {
    const path = `${PROBE_PREFIX}edit-a-to-b.md`;
    await vaultA.write(path, "version 1");
    // Seed the file on both sides first, so this case isolates the websocket path
    // for an edit rather than the "brand new file" arrival covered separately.
    await waitForAsync(
      async () => (await vaultHistory(server, remote.id)).some((f) => f.versions.length > 0),
      "the seed note never reached the server",
      60_000,
    );
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "version 1",
      "vault B never pulled the first version",
    );

    await vaultA.write(path, "version 2 edited in A");

    // vault B already tracks the file, so the ws notification alone pulls it.
    await waitForVaultState(
      async () => (await readVaultFile(names.b, path)) === "version 2 edited in A",
      "vault B never pulled the edit made in vault A",
    );
  });

  it("propagates an edit from vault B back to vault A", async () => {
    const path = `${PROBE_PREFIX}edit-b-to-a.md`;
    await vaultA.write(path, "base");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "base",
      "vault B never pulled the base note",
    );

    await vaultB.write(path, "edited in B");

    await waitForVaultState(
      async () => (await readVaultFile(names.a, path)) === "edited in B",
      "vault A never pulled the edit made in vault B",
    );
  });

  it("propagates a delete from vault A to vault B and exposes it to the recycle bin", async () => {
    const path = `${PROBE_PREFIX}delete.md`;
    await vaultA.write(path, "doomed");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "doomed",
      "vault B never pulled the note",
    );

    await vaultA.remove(path);

    await waitForVaultState(
      async () => !(await vaultB.exists(path)),
      "vault B never applied the remote delete",
    );
    await waitForAsync(
      async () => (await deletedFiles(server, remote.id)).length > 0,
      "the delete never reached the server's recycle bin",
      60_000,
    );
    expect(await listVaultFiles(names.a)).not.toContain(path);
  });

  it("lists a deleted note in the real recycle bin dialog and restores it", async () => {
    const path = `${PROBE_PREFIX}restore.md`;
    await vaultA.write(path, "deleted then restored");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "deleted then restored",
      "vault B never pulled the note",
    );
    const fileId = await fileIdForPath(names.a, path);
    expect(fileId).toBeTruthy();

    // 1. Delete it in A; B applies the delete over the real websocket.
    await vaultA.remove(path);
    await waitForVaultState(
      async () => !(await vaultB.exists(path)),
      "vault B never applied the remote delete",
    );
    await waitForAsync(
      async () => (await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
      "the delete never reached the server's recycle bin",
      60_000,
    );

    // 2. The real dialog in B lists it — including its own decryption of the
    //    stored path, which is what a user reads. It is reached through the
    //    plugin's settings page, which is the only entry point left.
    await waitForVaultState(
      () => openRecycleBinDialog(names.b),
      "the plugin settings page never offered the recycle bin dialog",
    );
    await waitForVaultState(
      async () => (await readRecycleBinDialog(names.b)).paths.includes(path),
      "the recycle bin dialog never listed the deleted note",
    );

    // 3. Restore it by pressing the dialog's own button.
    expect(
      await clickRecycleBinRestore(names.b, path),
      "the recycle bin dialog had no 恢复 button for the deleted note",
    ).toBe(true);
    await waitForVaultState(
      async () => (await readVaultFile(names.b, path)) === "deleted then restored",
      "the restored note never appeared in vault B",
    );
    await waitForVaultState(
      async () => (await readVaultFile(names.a, path)) === "deleted then restored",
      "vault A never pulled the restored note back",
    );

    // One path, one identity: the restore left no second chain behind, and its
    // own version is the head.
    expect((await fileVersions(server, remote.id, fileId!)).at(-1)?.action).toBe("restore");
    expect(await filesAtPath(server, remote.id, material.key, path)).toEqual([fileId!]);
    expect(await listVaultFiles(names.b)).toContain(path);
    await closeOpenModals(names.b);
  });

  it("re-reads the real recycle bin in place, without tearing its list down", async () => {
    // The refresh control used to put the dialog back through its loading state: the rows
    // and the footer went away, a skeleton took their place, and the list then refilled row
    // by row. That is the flash a user saw on the desktop and on a phone, so what this case
    // pins is the DOM at the moment of the click: the same row nodes are still on screen.
    const path = `${PROBE_PREFIX}refresh-in-place.md`;
    await vaultA.write(path, "refreshed in place");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "refreshed in place",
      "vault B never pulled the note",
    );
    const fileId = await fileIdForPath(names.a, path);
    expect(fileId).toBeTruthy();

    await vaultA.remove(path);
    await waitForAsync(
      async () => (await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
      "the delete never reached the server's recycle bin",
      60_000,
    );

    await waitForVaultState(
      () => openRecycleBinDialog(names.a),
      "the plugin settings page never offered the recycle bin dialog",
    );
    await waitForVaultState(
      async () => (await readRecycleBinDialog(names.a)).paths.includes(path),
      "the recycle bin dialog never listed the deleted note",
    );

    // One evaluation: the read is still in flight when the click returns, so what it reports
    // is the frame the user would be looking at — nothing blanked, no skeleton, same count.
    const clicked = await clickRecycleBinRefresh(names.a);
    expect(clicked.open, "the recycle bin dialog was gone").toBe(true);
    expect(clicked.clicked, "the header offered no refresh control").toBe(true);
    expect(clicked.kept, "the refresh rebuilt the rows instead of keeping them").toBe(true);
    expect(clicked.skeleton, "the refresh put the dialog back through its skeleton").toBe(0);
    expect(clicked.count).toBe(clicked.countBefore);
    expect(clicked.footer, "the footer disappeared while the read ran").toBe("flex");
    expect(clicked.busy, "the header never said the read was running").toBe(true);

    // …and it settles into the same list, still drawn in place rather than reloaded.
    await waitForVaultState(
      async () => !(await readRecycleBinRefresh(names.a)).busy,
      "the refresh never settled",
    );
    const settled = await readRecycleBinRefresh(names.a);
    expect(settled.paths).toContain(path);
    expect(settled.skeleton).toBe(0);
    expect(settled.count).toBe(clicked.countBefore);
    await closeOpenModals(names.a);
  });

  it("shows this run's sync events with a count, day groups and both arrow directions", async () => {
    // One note written here (an upload for A) and one written in B (a download for A),
    // so the session log has both directions to tell apart in the same list. A's log is
    // in memory and fed by the engine; opening the dialog reads no remote history.
    const mine = `${PROBE_PREFIX}history-out.md`;
    const theirs = `${PROBE_PREFIX}history-in.md`;
    await vaultA.write(mine, "written in A");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(mine)) === "written in A",
      "vault B never pulled the note written in A",
    );
    await vaultB.write(theirs, "written in B");
    await waitForVaultState(
      async () => (await vaultA.read(theirs)) === "written in B",
      "vault A never pulled the note written in B",
    );

    await waitForVaultState(
      () => openSyncHistoryDialog(names.a),
      "the plugin settings page never offered the sync history dialog",
    );
    await waitForVaultState(async () => {
      const dialog = await readSyncHistoryDialog(names.a);
      const paths = dialog.rows.map((row) => row.path);
      return paths.includes(mine) && paths.includes(theirs);
    }, "the sync history dialog never listed both notes");

    const dialog = await readSyncHistoryDialog(names.a);
    expect(dialog.title).toBe(t("dialog.syncHistory.title"));

    // The header is a count, not a template: the dialog used to render the literal
    // `共 {total} 次同步事件。` because the summary template lost its `{total}`. The
    // rendered number follows the UI language, so four digits arrive grouped.
    expect(dialog.count).toMatch(/^[\d,]+$/);
    expect(Number(dialog.count.replace(/,/g, ""))).toBeGreaterThan(0);
    expect(dialog.countLabel).toBe(t("dialog.syncHistory.countLabel.other"));
    expect(dialog.countLabel).not.toContain("{");
    // The header says this is this run's log. The old server-backed dialog had no such
    // note, so this is the assertion that tells the two implementations apart.
    expect(dialog.note).toContain(t("dialog.syncHistory.sessionNote"));

    // Day groups, newest day last: today's header is a word, not a date.
    expect(dialog.days.length).toBeGreaterThan(0);
    expect(dialog.days.at(-1)).toBe(t("dialog.syncHistory.today"));

    // Both directions, told apart by the glyph and by the class that colours it. Neither
    // row is a skip: A sent one and applied the other.
    const own = dialog.rows.find((row) => row.path === mine)!;
    const peer = dialog.rows.find((row) => row.path === theirs)!;
    expect(own.direction).toBe("out");
    expect(own.icon).toContain("lucide-arrow-up");
    expect(own.skipped).toBe(false);
    expect(own.outcome).toBe("");
    expect(peer.direction).toBe("in");
    expect(peer.icon).toContain("lucide-arrow-down");
    expect(peer.skipped).toBe(false);
    expect(peer.outcome).toBe("");

    // The clock reading and the device label sit under the path, not in it.
    const deviceName = (await readPluginStatus(names.a)).deviceName;
    expect(own.meta).toMatch(/^\d{2}:\d{2}:\d{2} · /);
    expect(own.meta).toContain(deviceName);
    expect(peer.meta).toContain((await readPluginStatus(names.b)).deviceName);
    expect(own.action).toBe(t("history.action.create"));

    await closeOpenModals(names.a);
  });

  itL("renders the sync-history list as the dialog's scrolling region", async () => {
    await ensurePluginHostRunning(names.a);
    const path = `${PROBE_PREFIX}history-layout.md`;
    await vaultA.write(path, "layout probe");
    await waitForVaultState(
      () => openSyncHistoryDialog(names.a),
      "the plugin settings page never offered the sync history dialog",
    );
    await waitForVaultState(async () => {
      const dialog = await readSyncHistoryDialog(names.a);
      return dialog.rows.some((row) => row.path === path);
    }, "the sync history dialog never listed the probe note");

    // The list is the scrolling region inside a fixed-height dialog, with its own cap:
    // the modal itself must not scroll as a whole (that is what pushes its title out of
    // view), and this is the one layer where `styles.css` is actually applied.
    const dialog = await readSyncHistoryDialog(names.a);
    expect(dialog.listStyle).not.toBeNull();
    expect(dialog.listStyle!.overflowY).toBe("auto");
    expect(dialog.listStyle!.maxHeight).not.toBe("none");
    expect(dialog.listStyle!.minHeight).toBe("0px");

    await closeOpenModals(names.a);
  });

  it("opens a note's version history from the explorer's chip and reads it", async () => {
    // The desktop entry point end to end: a chip injected into a real file-explorer row, the
    // tab it opens, the chain newest first, and a click that swaps the pane's version without
    // taking the page down with it.
    const path = `${PROBE_PREFIX}history-view.md`;
    await closeVersionHistories(names.a);

    await vaultA.write(path, "first");
    await waitForVaultState(
      async () => (await fileIdForPath(names.a, path)) !== null,
      "the note was never indexed by the running plugin",
      30_000,
    );
    const fileId = (await fileIdForPath(names.a, path))!;
    await waitForVaultState(
      async () => (await fileVersions(server, remote.id, fileId)).length === 1,
      "the note's first version never reached the server",
      30_000,
    );

    // Two more writes, each its own version: the tab should open on the third.
    for (const [index, body] of ["second\nbody two", "third\nbody two"].entries()) {
      await vaultA.write(path, body);
      const expected = index + 2;
      await waitForVaultState(
        async () => (await fileVersions(server, remote.id, fileId)).length >= expected,
        "an edit never reached the server",
        30_000,
      );
    }

    // The chip is in the row as soon as the row is decorated; it is only *drawn* on hover.
    await waitForVaultState(
      () => clickVersionHistoryChip(names.a, path),
      "the file explorer never showed the version-history chip",
      30_000,
    );
    await waitForVaultState(
      async () => {
        const view = await readVersionHistoryView(names.a);
        return view.open && view.rows.length >= 3;
      },
      "the version-history tab never listed the chain",
      30_000,
    );

    const view = await readVersionHistoryView(names.a);
    expect(view.title).toBe(path.split("/").pop()!);
    expect(view.count).toBe(
      t("dialog.versionHistory.countLabel.other", { count: view.rows.length }),
    );
    expect(view.days).toContain(t("dialog.syncHistory.today"));
    // Newest first, and the head is what the pane opens on.
    expect(view.rows.slice(0, 3).map((row) => row.action)).toEqual([
      t("history.action.modify"),
      t("history.action.modify"),
      t("history.action.create"),
    ]);
    expect(view.rows.filter((row) => row.selected)).toHaveLength(1);
    expect(view.rows[0]!.selected).toBe(true);
    expect(view.pane).toContain("third");
    // Only the list scrolls: the pane's foot stays inside the tab.
    expect(view.inside, "the history overflowed its own tab").toBe(true);

    // Selecting the version before the head swaps the pane's content and keeps the page up.
    expect(await clickVersionHistoryRow(names.a, 1)).toBe(true);
    await waitForVaultState(
      async () => (await readVersionHistoryView(names.a)).pane.includes("second"),
      "the older version never reached the pane",
      30_000,
    );
    const afterClick = await readVersionHistoryView(names.a);
    expect(afterClick.rows.filter((row) => row.selected)).toHaveLength(1);
    expect(afterClick.rows[1]!.selected).toBe(true);
    expect(afterClick.paneHeight).toBeGreaterThan(0);
    expect(afterClick.inside).toBe(true);

    await closeVersionHistories(names.a);
  });

  it("asks for a new file name when a deleted note's path was taken in the meantime", async () => {
    const path = `${PROBE_PREFIX}occupied.md`;
    const copyPath = `${PROBE_PREFIX}occupied-1.md`;

    await vaultA.write(path, "old content");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "old content",
      "vault B never pulled the note",
    );
    const fileId = await fileIdForPath(names.a, path);
    expect(fileId).toBeTruthy();

    // 1. Delete it, and let the recycle bin see it.
    await vaultA.remove(path);
    await waitForAsync(
      async () => (await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
      "the delete never reached the server's recycle bin",
      60_000,
    );

    // 2. "Obsidian was closed and reopened": park A's host, write a new note at the
    //    old path, then bring the host back. The bind pass gives that note its own
    //    file, so the path now holds a different file than the one in the bin.
    await pausePluginHost(names.a);
    await vaultA.write(path, "new content");
    await configurePluginHost(
      names.a,
      { ...setup, deviceName: "obsidian-A" },
      { resetSyncState: false },
    );
    await waitForVaultState(
      async () => (await fileIdForPath(names.a, path)) !== fileId,
      "the new note never became its own file",
    );

    // 3. The row does not pre-warn about the collision; the click asks for a name instead
    //    of overwriting the note that took the path.
    await waitForVaultState(
      () => openRecycleBinDialog(names.a),
      "the plugin settings page never offered the recycle bin dialog",
    );
    await waitForVaultState(
      async () => (await readRecycleBinDialog(names.a)).paths.includes(path),
      "the recycle bin dialog never listed the deleted note",
    );
    // No warning at all: the only line a row says up front is the one for a chain with
    // nothing restorable, and this chain has its pre-delete version.
    expect((await readRecycleBinDialog(names.a)).warnings).toEqual([]);

    expect(
      await clickRecycleBinRestore(names.a, path),
      "the recycle bin dialog had no 恢复 button for the deleted note",
    ).toBe(true);
    await waitForVaultState(
      async () => (await readRestoreNameField(names.a)).open,
      "the restore dialog never asked for a file name",
    );
    // The default name is the original plus `-1`, which is what the user is expected to
    // accept; a name that is taken as well is answered in the dialog. The field holds the
    // file name alone — the folder stays the one the note lived in.
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    const copyName = copyPath.slice(copyPath.lastIndexOf("/") + 1);
    expect((await readRestoreNameField(names.a)).value).toBe(copyName);
    expect(await fillRestoreName(names.a, fileName)).toBe(true);
    expect(
      await clickOpenModalButton(names.a, t("dialog.recycleBin.restore")),
      "the restore dialog had no restore button",
    ).toBe(true);
    await waitForVaultState(
      async () => (await readRestoreNameField(names.a)).error.length > 0,
      "a name that is taken too was not answered in the dialog",
    );

    expect(await fillRestoreName(names.a, copyName)).toBe(true);
    expect(
      await clickOpenModalButton(names.a, t("dialog.recycleBin.restore")),
      "the restore dialog had no restore button",
    ).toBe(true);

    // 4. Both notes exist: the restored content under the new name, and the note
    //    that took the path untouched — each under its own identity.
    await waitForVaultState(
      async () => (await readVaultFile(names.a, copyPath)) === "old content",
      "the restored copy never appeared in vault A",
    );
    expect(await readVaultFile(names.a, path)).toBe("new content");
    expect(await fileIdForPath(names.a, path)).not.toBe(fileId);
    expect(await fileIdForPath(names.a, copyPath)).toBe(fileId);
    expect(await filesAtPath(server, remote.id, material.key, path)).toHaveLength(1);
    expect(await filesAtPath(server, remote.id, material.key, copyPath)).toEqual([fileId!]);

    // And the peer gets the restored copy too.
    await waitForVaultState(
      async () => (await readVaultFile(names.b, copyPath)) === "old content",
      "vault B never pulled the restored copy",
    );
    await closeOpenModals(names.a);
  });

  it("previews a deleted note's content in the dialog, rendering its markdown", async () => {
    const path = `${PROBE_PREFIX}preview.md`;
    await vaultA.write(path, "# 标题\n\n正文");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "# 标题\n\n正文",
      "vault B never pulled the note",
    );
    const fileId = await fileIdForPath(names.a, path);
    expect(fileId).toBeTruthy();

    await vaultA.remove(path);
    await waitForAsync(
      async () => (await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
      "the delete never reached the server's recycle bin",
      60_000,
    );

    // Clicking the row (not the button) shows the deleted version. The rendered
    // markdown is Obsidian's own: `MarkdownRenderer.render` produces a
    // `.markdown-rendered` block inside the dialog, which is what a user reads.
    await waitForVaultState(
      () => openRecycleBinDialog(names.b),
      "the plugin settings page never offered the recycle bin dialog",
    );
    await waitForVaultState(
      async () => (await readRecycleBinDialog(names.b)).paths.includes(path),
      "the recycle bin dialog never listed the deleted note",
    );
    expect(
      await clickRecycleBinFile(names.b, path),
      "the recycle bin dialog had no clickable row for the deleted note",
    ).toBe(true);

    await waitForVaultState(
      async () => (await readDeletedContent(names.b)).rendered,
      "the deleted note's content was never rendered as markdown",
    );
    const rendered = await readDeletedContent(names.b);
    expect(rendered.text).toContain("标题");
    // The short title stays put; the path is the header's subject, so a long path wraps
    // in the body instead of being ellipsised in the title bar.
    expect(rendered.title).toBe(t("dialog.recycleBin.contentTitle"));
    expect(rendered.subject).toBe(path);
    expect(rendered.facts).toContain(t("dialog.recycleBin.deletedAt", { time: "" }).trim());

    // Looking at the content restores nothing.
    await waitForVaultState(
      async () => !(await vaultB.exists(path)),
      "previewing the content restored the note",
    );
    await closeOpenModals(names.b);
  });

  it("attributes versions pushed by the two real Obsidian instances to different devices", async () => {
    const path = `${PROBE_PREFIX}attribution.md`;
    await vaultA.write(path, "from A");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "from A",
      "vault B never pulled the note",
    );

    const fileId = await fileIdForPath(names.a, path);
    expect(fileId).toBeTruthy();

    await vaultB.write(path, "from B");
    await waitForAsync(
      async () => (await versionDeviceNames(server, remote.id, fileId!)).length >= 2,
      "the second device's version never reached the server",
      60_000,
    );

    const deviceNames = await versionDeviceNames(server, remote.id, fileId!);
    const unique = new Set(deviceNames.filter(Boolean));
    expect(unique.size).toBe(2);
    expect(unique.has((await readPluginStatus(names.a)).deviceName)).toBe(true);
    expect(unique.has((await readPluginStatus(names.b)).deviceName)).toBe(true);
  });

  it("takes the remote version in a real vault and parks the local one beside it", async () => {
    const path = `${PROBE_PREFIX}conflict.md`;
    await vaultA.write(path, "base");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "base",
      "vault B never pulled the base note",
    );
    const fileId = await fileIdForPath(names.b, path);
    expect(fileId).toBeTruthy();

    // Deterministic conflict: park vault B's host (keeping its binding and sync
    // state, i.e. "Obsidian was closed") so it cannot observe vault A's edit,
    // let both sides diverge, then bring vault B back.
    await pausePluginHost(names.b);
    await vaultA.write(path, "edited in A while B was offline");
    await waitForAsync(
      async () =>
        (await vaultHistory(server, remote.id)).some((file) =>
          file.versions.some((version) => version.action === "modify"),
        ),
      "vault A's edit never reached the server",
      60_000,
    );
    await vaultB.write(path, "edited in B while offline");

    await configurePluginHost(
      names.b,
      { ...setup, deviceName: "obsidian-B" },
      { resetSyncState: false },
    );

    // The remote head wins and the note that lost is written beside it — by the real
    // plugin, into the real vault, with no dialog and no pending decision. The copy is
    // named after the second that plugin parked it at, a clock this process does not
    // share, so it is found in the vault rather than rebuilt (see `conflictCopyOf`).
    await waitForVaultState(async () => {
      const parked = conflictCopyOf(await listVaultFiles(names.b), path);
      return (
        parked !== null && (await readVaultFile(names.b, parked)) === "edited in B while offline"
      );
    }, "the losing note was never parked beside the conflict");
    expect(await vaultB.read(path)).toBe("edited in A while B was offline");

    // The losing side pushed nothing, so the chain still ends at vault A's edit.
    expect((await fileVersions(server, remote.id, fileId!)).map((v) => v.action)).toEqual([
      "create",
      "modify",
    ]);
  });

  /**
   * Identical bytes are not a conflict, even when this vault's sync point is behind the
   * head — the state a second operation on one path leaves behind when it fetches the
   * chain its own push just created, before the state adopts it.
   *
   * That window is hard to open on purpose in a real app, so the same state is built
   * deterministically: stop vault A's host (binding and state stay, like Obsidian being
   * closed), let vault B push the new content, make the *same* edit in A while nothing is
   * listening, then bring A back. A real vault used to park a copy of the note over itself
   * here (two `*.conflict.md` files beside a note edited twice).
   */
  it("converges on identical bytes instead of parking a copy over itself", async () => {
    const path = `${PROBE_PREFIX}same-bytes.md`;
    await vaultA.write(path, "base");
    await reconcile(names.b);
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "base",
      "vault B never pulled the base note",
    );
    const fileId = await fileIdForPath(names.a, path);
    expect(fileId).toBeTruthy();

    await pausePluginHost(names.a);
    await vaultB.write(path, "same edit");
    await waitForAsync(
      async () => (await fileVersions(server, remote.id, fileId!)).length === 2,
      "vault B's edit never reached the server",
      60_000,
    );
    // The very same bytes on this side, made while its host was stopped.
    await vaultA.write(path, "same edit");

    await configurePluginHost(
      names.a,
      { ...setup, deviceName: "obsidian-A" },
      { resetSyncState: false },
    );

    // The bind pass settles the two sides as agreement: no copy, no extra version, and the
    // head becomes this vault's sync point (read back from the plugin's own persisted state).
    const headVersionId = (await fileVersions(server, remote.id, fileId!)).at(-1)!.versionId;
    const recordedVersion = () =>
      evalInVault<string | null>(
        names.a,
        `
        const p = app.plugins.plugins.courier;
        const state = p?.settings?.syncState?.localVersions ?? {};
        return Object.values(state).find((entry) => entry.plainPath === ${jsLiteral(path)})?.lastKnownVersionId ?? null;
        `,
        30_000,
      );
    await waitForVaultState(
      async () => (await recordedVersion()) === headVersionId,
      "the converged head never became vault A's sync point",
    );
    expect(conflictCopyOf(await listVaultFiles(names.a), path)).toBeNull();
    expect(await vaultA.read(path)).toBe("same edit");
    expect((await fileVersions(server, remote.id, fileId!)).map((v) => v.action)).toEqual([
      "create",
      "modify",
    ]);

    // With the head as the sync point, the next edit is an ordinary modify both sides see.
    await vaultA.write(path, "after");
    await waitForVaultState(
      async () => (await vaultB.read(path)) === "after",
      "the edit after the convergence never reached vault B",
    );
    expect(conflictCopyOf(await listVaultFiles(names.a), path)).toBeNull();
  });

  it("shows a note created in the other vault without any manual reconcile", async () => {
    const path = `${PROBE_PREFIX}live-new-file.md`;
    await vaultA.write(path, "created in A");

    // The peer vault's push reaches this plugin over the real websocket; a
    // fileId the engine has never seen is materialised at the path recorded in
    // the pushed version, so the note appears live.
    await waitForVaultState(
      async () => (await readVaultFile(names.b, path)) === "created in A",
      "vault B never picked up the brand new note",
      30_000,
    );
  });

  /**
   * The one case this layer can prove and the layers below cannot: a real socket
   * drop, the plugin's real backoff, and the catch-up reconcile it runs on the
   * way back — with the protocol's server keeping no backlog, so a notification
   * sent while the socket was down is gone for good.
   */
  it("catches up on a push it missed while its websocket was down", async () => {
    const path = `${PROBE_PREFIX}missed-while-down.md`;
    const peer = await createTestClient({
      server,
      vaultId: remote.id,
      key: material.key,
      deviceName: "missed-while-down",
    });
    try {
      // Drop both plugins' sockets without stopping the server. The client's own
      // reconnect is a full second away, so vault B is provably unsubscribed when
      // the peer pushes below — and its `file_pushed` notification is lost.
      server.dropSockets();

      peer.write(path, "pushed while vault B had no socket");
      await peer.sync();
      await peer.change(path);

      // The periodic safety net runs every five minutes, far past this wait, so
      // the reconcile a reconnect runs is the only thing that can bring the note in.
      await waitForVaultState(
        async () => (await readVaultFile(names.b, path)) === "pushed while vault B had no socket",
        "vault B never caught up after its websocket came back",
        30_000,
      );
      expect((await readPluginStatus(names.b)).wsState).toBe("connected");
    } finally {
      peer.cleanup();
    }
  });

  /**
   * The whole point of the credential store: reloading the plugin — which is what
   * starting Obsidian does — must restore the sync host **without** the password
   * dialog. `hosting` can only become true through `autoUnlockOrPrompt()`, because
   * a dialog would be waiting for a password nobody types in this run.
   *
   * Placed here, before the suites that unbind, re-path and delete notes: it needs
   * the two hosts bound exactly as `beforeAll` left them.
   */
  it("resumes syncing after a plugin reload, without asking for the password", async () => {
    await reloadCourierPlugin(names.a);

    await waitForVaultState(
      async () => (await readPluginStatus(names.a)).hosting,
      "the host did not resume from the stored key after the plugin reload",
      60_000,
    );
    await waitForVaultState(
      async () => (await readPluginStatus(names.a)).wsState === "connected",
      "the resumed host never established its websocket",
      60_000,
    );

    // The credential is still there, so the next start is silent too.
    const credential = await evalInVault<{ vaultId: string } | null>(
      names.a,
      `
      const stored = app.loadLocalStorage('courier-vault-credential');
      return stored ? { vaultId: stored.vaultId } : null;
      `,
      20_000,
    );
    expect(credential?.vaultId).toBe(remote.id);

    // And the resumed host is a working one: a note edited in A still reaches B.
    const path = `${PROBE_PREFIX}after-reload.md`;
    await vaultA.write(path, "written after the plugin reloaded");
    await waitForVaultState(
      async () => (await readVaultFile(names.b, path)) === "written after the plugin reloaded",
      "vault B never received the note written after the reload",
    );
  });

  /**
   * The merge matrix against **real Obsidian**: what happens when a vault that
   * already holds notes is bound to a remote that already has content. Obsidian is
   * the only layer that can show a real note appearing in, or surviving, a real
   * vault, so each case asserts on the vault itself as well as on the server.
   *
   * The notes are written through Obsidian's own file layer (the CLI drives
   * `app.vault.create`), which is what makes them notes the plugin can see — a file
   * dropped on disk is not indexed until Obsidian rescans. Each case unbinds first
   * so the bind really starts from "no sync state".
   */
  describe("binding a vault that already has content on both sides", () => {
    /**
     * Unbind the plugin, let `arrange` put the vault in the wanted shape, then bind
     * again — the shape of "connect this vault", always from a clean state.
     *
     * `expectedPath` is awaited in the **same listing the host will read**
     * (`app.vault.getFiles()`) before the host starts. A `create` resolves before
     * its entry is visible to a bind that lists immediately, and a bind that misses
     * the local file pulls the remote over it instead of parking the losing side;
     * the wait models "the note exists" rather than a sleep.
     */
    async function rebind(
      vault: string,
      arrange: () => Promise<void>,
      expectedPath?: string,
    ): Promise<void> {
      await pausePluginHost(vault);
      await arrange();
      if (expectedPath !== undefined) {
        await waitForVaultState(
          () =>
            evalInVault<boolean>(
              vault,
              `return app.vault.getFiles().some((file) => file.path === ${jsLiteral(expectedPath)});`,
            ),
          `${expectedPath} never appeared in the vault listing before the bind`,
          15_000,
        );
      }
      await configurePluginHost(vault, { ...setup, deviceName: `obsidian-${vault}` });
    }

    /**
     * A headless peer that seeds the remote before the vault is bound.
     *
     * Vault A's host is stopped first: a live socket would pull the peer's push
     * immediately, and that in-flight pull can land *after* `rebind` wrote the local
     * version — turning the intended conflict into "both sides already agree". On a
     * fast machine the pull usually wins the race; on a slow runner it does not.
     */
    async function seedPeer(deviceName: string, files: Record<string, string>) {
      await pausePluginHost(names.a);
      const peer = await createTestClient({
        server,
        vaultId: remote.id,
        key: material.key,
        deviceName,
      });
      for (const [path, content] of Object.entries(files)) peer.write(path, content);
      await peer.sync();
      for (const path of Object.keys(files)) await peer.change(path);
      return peer;
    }

    it("1. local only — the local note is created on the server", async () => {
      const path = `${PROBE_PREFIX}matrix-local.md`;

      // The vault already holds the note when the bind happens.
      await rebind(
        names.a,
        async () => {
          await vaultA.write(path, "only on this machine");
        },
        path,
      );

      await waitForVaultState(
        async () => (await fileIdForPath(names.a, path)) !== null,
        "the local note was never tracked after binding",
        30_000,
      );
      const fileId = await fileIdForPath(names.a, path);
      expect((await fileVersions(server, remote.id, fileId!)).map((v) => v.action)).toEqual([
        "create",
      ]);
      expect(await vaultA.read(path)).toBe("only on this machine");
    });

    it("2. remote only — the remote note arrives in the vault", async () => {
      const path = `${PROBE_PREFIX}matrix-remote.md`;
      const peer = await seedPeer("matrix-remote", { [path]: "only on the server" });
      try {
        await rebind(names.a, async () => {});

        await waitForVaultState(
          async () => (await readVaultFile(names.a, path)) === "only on the server",
          "the remote note never landed in the real vault",
          30_000,
        );
        expect(conflictCopyOf(await listVaultFiles(names.a), path)).toBeNull();
      } finally {
        peer.cleanup();
      }
    });

    it("3. same name, different content — the remote note wins in the real vault", async () => {
      const path = `${PROBE_PREFIX}matrix-conflict.md`;
      const peer = await seedPeer("matrix-conflict", { [path]: "remote version" });
      try {
        // The vault holds its own version of that path when the bind happens.
        await rebind(
          names.a,
          async () => {
            await vaultA.write(path, "local version");
          },
          path,
        );

        // The remote head is the truth on this path and the local note is parked
        // beside it — no pending decision, and the chain did not grow.
        await waitForVaultState(
          async () => {
            const parked = conflictCopyOf(await listVaultFiles(names.a), path);
            return parked !== null && (await readVaultFile(names.a, parked)) === "local version";
          },
          "the plugin never parked the losing side of the conflict",
          30_000,
        );
        expect(await vaultA.read(path)).toBe("remote version");
        const fileId = (await fileIdForPath(names.a, path))!;
        expect((await fileVersions(server, remote.id, fileId)).map((v) => v.action)).toEqual([
          "create",
        ]);
      } finally {
        peer.cleanup();
      }
    });

    it("4. same name, same content — one chain, no conflict", async () => {
      const path = `${PROBE_PREFIX}matrix-identical.md`;
      const peer = await seedPeer("matrix-identical", { [path]: "identical" });
      try {
        const chainsBefore = (await vaultHistory(server, remote.id)).length;
        await rebind(
          names.a,
          async () => {
            await vaultA.write(path, "identical");
          },
          path,
        );

        // Same content on both sides is the one case with nothing to reconcile: the
        // plugin learns the file (its path maps to the peer's chain), parks nothing,
        // and no new chain appears.
        expect(await vaultA.read(path)).toBe("identical");
        expect(conflictCopyOf(await listVaultFiles(names.a), path)).toBeNull();
        const fileId = await fileIdForPath(names.a, path);
        expect(fileId).toBe(peer.engine.fileIdForPath(path));
        expect((await vaultHistory(server, remote.id)).length).toBe(chainsBefore);
      } finally {
        peer.cleanup();
      }
    });

    it("5. remote tombstone + local file — the note comes back as a new chain", async () => {
      const path = `${PROBE_PREFIX}matrix-tombstone.md`;
      const peer = await seedPeer("matrix-tombstone", { [path]: "first life" });
      try {
        const deletedFileId = peer.engine.fileIdForPath(path)!;
        peer.remove(path);
        await peer.removeAndSync(path);
        expect((await deletedFiles(server, remote.id)).map((f) => f.fileId)).toContain(
          deletedFileId,
        );

        // A vault that already holds the note binds: the local file is the user's
        // own, so it is pushed as a new file rather than being deleted by the bind.
        await rebind(
          names.a,
          async () => {
            await vaultA.write(path, "second life");
          },
          path,
        );

        await waitForVaultState(
          async () => (await fileIdForPath(names.a, path)) !== null,
          "the local note was never tracked after binding",
          30_000,
        );
        const rebornFileId = (await fileIdForPath(names.a, path))!;
        expect(rebornFileId).not.toBe(deletedFileId);
        expect((await fileVersions(server, remote.id, rebornFileId)).map((v) => v.action)).toEqual([
          "create",
        ]);
        expect((await fileVersions(server, remote.id, deletedFileId)).map((v) => v.action)).toEqual(
          ["create", "delete"],
        );
        expect((await deletedFiles(server, remote.id)).map((f) => f.fileId)).toContain(
          deletedFileId,
        );
        expect(await readVaultFile(names.a, path)).toBe("second life");
        expect(conflictCopyOf(await listVaultFiles(names.a), path)).toBeNull();
      } finally {
        peer.cleanup();
      }
    });

    /**
     * What a user can do with the copy case 3 parks: Obsidian has no per-file hook in its
     * file explorer, so this is the only layer where "the button is really there, on the
     * real row" can be asserted — and the comparison and the replace then run against a
     * real vault, a real renderer and real vault events.
     */
    it("offers the parked copy a comparison and a replace, in the real explorer", async () => {
      const path = `${PROBE_PREFIX}matrix-copy-actions.md`;
      // A comparison tab left behind by an earlier case is a tab of the same type, and the
      // "it closed itself" wait below would never see zero. The case owns the whole set.
      await closeConflictDiffs(names.a);
      await closeConflictDiffs(names.b);
      // The CLI's `read` drops one trailing newline, so the expectations are written the way
      // it answers — otherwise every content assertion below would be about the newline.
      const local = "# Title\nlocal line\nshared";
      const peer = await seedPeer("matrix-copy-actions", {
        [path]: "# Title\nremote line\nshared\n",
      });
      try {
        await rebind(
          names.a,
          async () => {
            await vaultA.write(path, local);
          },
          path,
        );

        await waitForVaultState(
          async () => {
            const parked = conflictCopyOf(await listVaultFiles(names.a), path);
            return parked !== null && (await readVaultFile(names.a, parked)) !== null;
          },
          "the bind never parked a conflict copy in the real vault",
          30_000,
        );
        const parked = conflictCopyOf(await listVaultFiles(names.a), path)!;

        // The action is injected next to the row's name, labelled with the word it performs,
        // and it is a real, laid-out chip inside the row — not a hidden or zero-sized node.
        await waitForVaultState(
          async () => (await readConflictActionButton(names.a, parked)).button,
          "the file explorer never showed the comparison button on the parked copy",
          30_000,
        );
        const action = await readConflictActionButton(names.a, parked);
        expect(action.label).toBe(t("conflict.action.diff.label"));

        // Clicking it compares the copy (left) with the note as it stands (right).
        expect(await clickConflictAction(names.a, parked)).toBe(true);
        let diff = await readConflictDiff(names.a);
        const copyNow = await readVaultFile(names.a, parked);
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && diff.changes.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          diff = await readConflictDiff(names.a);
        }
        expect(
          diff.changes,
          `open=${diff.open} buttons=${JSON.stringify(diff.buttons)} ` +
            `note=${JSON.stringify(await readVaultFile(names.a, path))} ` +
            `copy=${JSON.stringify(copyNow)} ` +
            `button=${JSON.stringify(await readConflictActionButton(names.a, parked))} ` +
            `notices=${JSON.stringify(await readNotices(names.a))}`,
        ).toEqual([{ left: "local line", right: "remote line" }]);
        expect(diff.buttons).toEqual([t("dialog.conflictDiff.replace")]);
        expect(diff.mode).toBe("split");
        // No merge: the engine's conflict rule stands, and the comparison only reads.
        expect(diff.buttons.some((label) => label.includes("合并") || /merge/i.test(label))).toBe(
          false,
        );
        // The header: the note's name, the copy under it, and the line counts.
        expect(diff.titles).toEqual({ original: path, copy: parked });
        expect(diff.stats).toEqual([
          t("dialog.conflictDiff.added", { count: 1 }),
          t("dialog.conflictDiff.removed", { count: 1 }),
        ]);

        // 并排 / 统一 is one segmented control with both states in it.
        expect(diff.layout, "the comparison offered no 并排/统一 control").not.toBeNull();
        expect(diff.layout!.options).toEqual([
          t("dialog.conflictDiff.split"),
          t("dialog.conflictDiff.unified"),
        ]);
        expect(diff.layout!.value).toBe(t("dialog.conflictDiff.split"));

        // The unified presentation of the same pair, chosen from the control.
        expect(await selectConflictDiffMode(names.a, "unified")).toBe(true);
        await waitForVaultState(
          async () => (await readConflictDiff(names.a)).additions.includes("+ remote line"),
          "the unified presentation never rendered the changed line",
          30_000,
        );

        // The confirmation asks the same question the row said it would.
        expect(await clickConflictDialogButton(names.a, t("dialog.conflictDiff.replace"))).toBe(
          true,
        );
        const confirm = await readConflictReplaceConfirm(names.a);
        expect(confirm.open, "the replace confirmation never opened").toBe(true);
        expect(confirm.question).toBe(t("dialog.conflictReplace.textReplace", { path }));

        // The one write: the copy's content replaces the note, and the copy stays.
        expect(
          await clickConflictDialogButton(names.a, t("dialog.conflictReplace.buttonReplace")),
        ).toBe(true);

        // The confirmation and the comparison's tab both close themselves once the write has
        // run; a failure keeps the comparison open and says why in a Notice, so both are
        // read before asserting.
        let replaceNotices: string[] = [];
        await waitForVaultState(
          async () => {
            replaceNotices = (await readNotices(names.a)).filter((text) =>
              text.includes(t("dialog.conflictReplace.buttonReplace")),
            );
            return (await readConflictDiff(names.a)).open === false || replaceNotices.length > 0;
          },
          "the replace never finished",
          30_000,
        );
        expect(
          replaceNotices.some((text) => text.includes("失败") || /failed/i.test(text)),
          `the plugin reported: ${JSON.stringify(replaceNotices)}`,
        ).toBe(false);
        expect(
          await readVaultFile(names.a, path),
          `notices: ${JSON.stringify(replaceNotices)}`,
        ).toBe(local);
        expect(await readVaultFile(names.a, parked)).toBe(local);

        // The write is an ordinary local edit, so the peer gets it as a new version.
        await waitForVaultState(
          async () => (await readVaultFile(names.b, path)) === local,
          "the replaced content never reached the other vault",
          60_000,
        );

        // The comparison's tab closed itself once the write landed; nothing is left over.
        await waitForVaultState(
          async () => (await readConflictDiff(names.a)).open === false,
          "the conflict comparison stayed open after the replace",
          30_000,
        );

        // The chip belongs to the **path**: renaming the copy to a name that is not a
        // parked copy must take the action away, not leave it pointing at the old one.
        const kept = `${PROBE_PREFIX}matrix-copy-actions-kept.md`;
        await evalInVault(
          names.a,
          `
          const from = app.vault.getAbstractFileByPath(${jsLiteral(parked)});
          if (from) await app.fileManager.renameFile(from, ${jsLiteral(kept)});
          return !!from;
          `,
          30_000,
        );
        await waitForVaultState(
          async () => {
            const renamedChip = await readConflictActionButton(names.a, kept);
            return renamedChip.row && !renamedChip.button;
          },
          "the file explorer kept the conflict action on a renamed copy",
          30_000,
        );
      } finally {
        peer.cleanup();
      }
    });

    /**
     * The rendered side of the same flow: the chip is a laid-out node inside the real
     * row, the comparison keeps its header on screen, and the confirmation is one row.
     * These are the assertions another OS cannot measure; they stay on the reference
     * platform (see `layoutAssertionsEnabled`).
     */
    itL("lays out the parked copy's comparison and replace confirmation", async () => {
      const path = `${PROBE_PREFIX}matrix-copy-actions-layout.md`;
      await closeConflictDiffs(names.a);
      await closeConflictDiffs(names.b);
      const local = "# Title\nlocal line\nshared";
      const peer = await seedPeer("matrix-copy-actions-layout", {
        [path]: "# Title\nremote line\nshared\n",
      });
      try {
        await rebind(
          names.a,
          async () => {
            await vaultA.write(path, local);
          },
          path,
        );
        await waitForVaultState(
          async () => {
            const parked = conflictCopyOf(await listVaultFiles(names.a), path);
            return parked !== null && (await readVaultFile(names.a, parked)) !== null;
          },
          "the bind never parked a conflict copy in the real vault",
          30_000,
        );
        const parked = conflictCopyOf(await listVaultFiles(names.a), path)!;
        await waitForVaultState(
          async () => (await readConflictActionButton(names.a, parked)).button,
          "the file explorer never showed the comparison button on the parked copy",
          30_000,
        );

        const action = await readConflictActionButton(names.a, parked);
        expect(action.box, "the action had no rendered box").not.toBeNull();
        expect(action.box!.width).toBeGreaterThan(0);
        expect(action.box!.height).toBeGreaterThan(0);
        expect(action.box!.insideRow, "the action rendered outside its row").toBe(true);
        // `styles.css` keeps it muted until the row is hovered/active; the assertable
        // half is the app's own class (the pointer is a physical state).
        expect(action.opacityWhenActive).toBe("1");

        const narrow = await measureConflictActionNarrow(names.a, parked);
        expect(narrow.lineCount, "the action wrapped on an ordinary row").toBe(1);
        expect(narrow.narrowLineCount, "the action wrapped on a narrow row").toBe(1);
        expect(narrow.narrowBox, "the action had no rendered box on a narrow row").not.toBeNull();
        expect(
          narrow.narrowBox!.width,
          "the action was squeezed by the narrow row",
        ).toBeGreaterThanOrEqual(action.box!.width - 1);
        expect(narrow.narrowBox!.insideRow, "the action left its row when narrowed").toBe(true);

        expect(await clickConflictAction(names.a, parked)).toBe(true);
        await waitForVaultState(
          async () => (await readConflictDiff(names.a)).changes.length > 0,
          "the comparison never rendered the changed line",
          30_000,
        );
        const diff = await readConflictDiff(names.a);
        expect(diff.layout, "the comparison offered no 并排/统一 control").not.toBeNull();
        // The picker is one control, never a column wider than the header it sits in.
        expect(diff.layout!.width, `layout=${JSON.stringify(diff.layout)}`).toBeLessThanOrEqual(
          diff.layout!.headerWidth,
        );
        if (diff.layout!.headerWidth >= 480) {
          expect(diff.layout!.width, `layout=${JSON.stringify(diff.layout)}`).toBeLessThanOrEqual(
            200,
          );
        }
        expect(diff.replaceOnHeaderLine, "the replace button left the header's line").toBe(true);
        expect(
          diff.centreSpread,
          "the header's four groups do not share a centre line",
        ).not.toBeNull();
        if (diff.layout!.headerWidth >= 480) {
          expect(diff.centreSpread!, `layout=${JSON.stringify(diff.layout)}`).toBeLessThanOrEqual(
            2,
          );
        }
        expect(diff.chromeVisible, "the comparison's header scrolled out of the tab").toBe(true);

        expect(await clickConflictDialogButton(names.a, t("dialog.conflictDiff.replace"))).toBe(
          true,
        );
        const confirm = await readConflictReplaceConfirm(names.a);
        expect(confirm.open, "the replace confirmation never opened").toBe(true);
        expect(confirm.toggleBeforeLabel, "the switch came after its own words").toBe(true);
        expect(confirm.dividers, "the confirmation drew a divider line").toBe(0);
        expect(confirm.buttonsOnChoiceRow, "the buttons were not on the choice's row").toBe(true);

        await closeOpenModals(names.a);
        await closeConflictDiffs(names.a);
      } finally {
        peer.cleanup();
      }
    });
  });

  describe("nested paths", () => {
    it("pushes a note created in a deep folder and shows it in the other vault live", async () => {
      const path = `${PROBE_DIR}/deep/note.md`;
      await vaultA.write(path, "nested note created in A");

      // Vault A kept its identity for the nested path (the create went through
      // the plugin's own vault event, not a relabeled reconcile).
      await waitForVaultState(
        async () => (await fileIdForPath(names.a, path)) !== null,
        "vault A never tracked the nested file it created",
        30_000,
      );
      const fileId = await fileIdForPath(names.a, path);

      // Read back through the CLI's own `read` command, independent of the
      // plugin's bookkeeping. This is also where a peer that cannot materialise
      // a nested path fails, so the server assertions follow it instead of
      // polling the server in parallel.
      await waitForVaultState(
        async () => (await readVaultFile(names.b, path)) === "nested note created in A",
        "vault B never picked up the nested note",
        30_000,
      );

      const history = await vaultHistory(server, remote.id);
      const pushed = history.find((file) => file.fileId === fileId);
      expect(pushed?.versions.at(-1)?.action).toBe("create");
    });

    it("propagates nested edits in both directions", async () => {
      const path = `${PROBE_DIR}/nested/edits.md`;

      await vaultA.write(path, "v1 from A");
      await reconcile(names.b);
      await waitForVaultState(
        async () => (await vaultB.read(path)) === "v1 from A",
        "vault B never pulled the nested note",
      );

      // Known file on both sides → the websocket notification alone pulls it.
      await vaultA.write(path, "v2 from A");
      await waitForVaultState(
        async () => (await readVaultFile(names.b, path)) === "v2 from A",
        "vault B never pulled the edit of the nested note",
      );

      await vaultB.write(path, "v3 from B");
      await waitForVaultState(
        async () => (await readVaultFile(names.a, path)) === "v3 from B",
        "vault A never pulled the edit made in vault B",
      );
    });

    it("propagates the delete of a nested note and exposes it to the recycle bin", async () => {
      const path = `${PROBE_DIR}/nested/gone.md`;

      await vaultA.write(path, "nested and doomed");
      await reconcile(names.b);
      await waitForVaultState(
        async () => (await vaultB.read(path)) === "nested and doomed",
        "vault B never pulled the nested note",
      );
      const fileId = await fileIdForPath(names.a, path);
      expect(fileId).toBeTruthy();

      await vaultA.remove(path);

      await waitForVaultState(
        async () => !(await vaultB.exists(path)),
        "vault B never applied the remote delete of the nested note",
      );
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
        "the nested delete never reached the server's recycle bin",
        60_000,
      );
      expect(await listVaultFiles(names.a)).not.toContain(path);
    });

    it("moves a nested note to another folder in the peer vault, keeping its fileId", async () => {
      const from = `${PROBE_DIR}/deep/first.md`;
      const to = `${PROBE_DIR}/moved/second.md`;

      await vaultA.write(from, "moved across folders");
      await reconcile(names.b);
      await waitForVaultState(
        async () => (await vaultB.read(from)) === "moved across folders",
        "vault B never pulled the nested note before the move",
      );
      const fileId = await fileIdForPath(names.a, from);
      expect(fileId).toBeTruthy();

      await vaultA.rename(from, to);

      // Wait for the sending side's push first: the only path a peer can move
      // its own file along is the one recorded in the version it pulls.
      await waitForAsync(
        async () =>
          (await vaultHistory(server, remote.id)).some(
            (file) => file.fileId === fileId && file.versions.at(-1)?.action === "rename",
          ),
        "the nested rename never reached the server",
        60_000,
      );
      await waitForVaultState(
        async () => (await readVaultFile(names.b, to)) === "moved across folders",
        "vault B never moved the nested note to its new folder",
      );

      expect(await vaultB.exists(from)).toBe(false);
      expect(await fileIdForPath(names.b, to)).toBe(fileId);
      const filesInB = await listVaultFiles(names.b);
      expect(filesInB).toContain(to);
      expect(filesInB).not.toContain(from);
    });
  });

  describe("renaming a note at the vault root", () => {
    it("leaves only the new name in the peer, on the original chain", async () => {
      const from = `${PROBE_PREFIX}renamed-from.md`;
      const to = `${PROBE_PREFIX}renamed-to.md`;

      // The note has to be in B *before* the rename, or the "old file left
      // behind" defect is invisible: B would simply pull a file it never had.
      await vaultA.write(from, "renamed while both vaults are open");
      await reconcile(names.b);
      await waitForVaultState(
        async () => (await readVaultFile(names.b, from)) === "renamed while both vaults are open",
        "vault B never pulled the note before the rename",
      );
      const fileId = await fileIdForPath(names.a, from);
      expect(fileId).toBeTruthy();

      await vaultA.rename(from, to);

      await waitForVaultState(
        async () => (await readVaultFile(names.b, to)) === "renamed while both vaults are open",
        "vault B never materialised the renamed note",
      );
      // The defect this pins: the old path came back (or never left), leaving
      // both names in the peer vault for the same content.
      await waitForVaultState(
        async () => !(await vaultB.exists(from)),
        "vault B still has the old name after the rename",
      );

      const filesInB = await listVaultFiles(names.b);
      expect(filesInB).toContain(to);
      expect(filesInB).not.toContain(from);
      expect(await fileIdForPath(names.b, to)).toBe(fileId);
      // One path, one chain: a second chain for the new path is what pushed the
      // duplicate file to the peer in the first place.
      expect(await filesAtPath(server, remote.id, material.key, to)).toEqual([fileId!]);
      expect(await filesAtPath(server, remote.id, material.key, from)).toEqual([]);
      expect((await fileVersions(server, remote.id, fileId!)).at(-1)?.action).toBe("rename");
    });
  });

  /**
   * A folder rename is not one event. Obsidian renames the folder and every
   * descendant with it and reports a **burst** — the folder first, then one
   * `rename` per descendant file, breadth first (verified against this very app
   * with a temporary listener). The plugin drops the folder events
   * (`"extension" in file`) and has to carry every note to its new path itself,
   * while the peer materialises the whole subtree in a folder it may not have.
   *
   * These cases exist because the shape is different from every other rename: the
   * notes are reported one by one, the paths change at several depths at once, and
   * the developer's own dev-vault history shows what goes wrong when it is not
   * handled (duplicate notes at the *old* path, on fresh chains, after the folder
   * had moved).
   *
   * The **delete** burst is the same shape with a different order (Obsidian gives no
   * ordering at all there), and one case covers it for the same reason: the folder
   * events carry nothing, so every note has to be tombstoned by its own event.
   *
   * Deliberately not covered: renaming a folder that contains **no file at all**.
   * Only files are versioned (`docs/api.md`), so an empty folder has nothing to
   * carry its name — a gap in folder support, not a rename defect.
   */
  describe("folder renames and deletes", () => {
    /** Every probe note in a vault, so "exactly these paths" can be asserted. */
    async function probeFiles(vault: string): Promise<string[]> {
      return (await listVaultFiles(vault)).filter((path) => path.startsWith(PROBE_DIR)).toSorted();
    }

    /**
     * What each side actually holds, so a failure names the state instead of only
     * saying that a wait expired.
     */
    async function diagnose(paths: string[]): Promise<string> {
      const lines = [
        `vault A files: ${(await probeFiles(names.a)).join(", ") || "<none>"}`,
        `vault B files: ${(await probeFiles(names.b)).join(", ") || "<none>"}`,
      ];
      for (const path of paths) {
        const chains = await filesAtPath(server, remote.id, material.key, path);
        lines.push(
          `  ${path}: A=${await fileIdForPath(names.a, path)} B=${await fileIdForPath(names.b, path)} chains=[${chains.join(", ")}]`,
        );
      }
      for (const vault of [names.a, names.b]) {
        lines.push(`${vault} internals: ${await engineInternals(vault)}`);
      }
      return lines.join("\n");
    }

    /** `waitForVaultState`, reporting both sides' state when it gives up. */
    async function waitForConvergence(
      predicate: () => Promise<boolean>,
      message: string,
      paths: string[],
      timeoutMs = 30_000,
    ): Promise<void> {
      try {
        await waitForVaultState(predicate, message, timeoutMs);
      } catch (err) {
        throw new Error(`${(err as Error).message}\n${await diagnose(paths)}`, { cause: err });
      }
    }

    it("moves every note of a renamed folder in both vaults, on the original chains", async () => {
      const dir = `${PROBE_DIR}/${PROBE_PREFIX}folder-deep`;
      const renamed = `${PROBE_DIR}/${PROBE_PREFIX}folder-deep-renamed`;
      const one = `${dir}/one.md`;
      const two = `${dir}/deeper/two.md`;
      const oneNew = `${renamed}/one.md`;
      const twoNew = `${renamed}/deeper/two.md`;

      await vaultA.write(one, "first note");
      await vaultA.write(two, "second note");
      await reconcile(names.b);
      await waitForVaultState(
        async () =>
          (await vaultB.read(one)) === "first note" && (await vaultB.read(two)) === "second note",
        "vault B never pulled the notes before the folder rename",
      );
      const oneId = await trackedIn(names.a, one);
      const twoId = await trackedIn(names.a, two);
      expect(oneId).toBeTruthy();
      expect(twoId).toBeTruthy();

      // The folder itself is renamed — Obsidian moves both notes and reports each
      // one, so the plugin's folder-event filter has to leave the children alone
      // and the engine has to move each note on its own chain.
      await instrumentVault(names.a);
      await instrumentVault(names.b);
      await vaultA.rename(dir, renamed);

      await waitForConvergence(
        async () =>
          (await readVaultFile(names.b, oneNew)) === "first note" &&
          (await readVaultFile(names.b, twoNew)) === "second note",
        "vault B never materialised the renamed folder's notes",
        [one, two, oneNew, twoNew],
      );
      await waitForConvergence(
        async () => !(await vaultB.exists(one)) && !(await vaultB.exists(two)),
        "vault B still has the old paths after the folder rename",
        [one, two, oneNew, twoNew],
      );
      await waitForAsync(
        async () =>
          (await filesAtPath(server, remote.id, material.key, oneNew)).length === 1 &&
          (await filesAtPath(server, remote.id, material.key, twoNew)).length === 1,
        "the renamed notes never reached the server at their new paths",
        60_000,
      );

      // One path, one chain — and the chain is the original one.
      expect(await filesAtPath(server, remote.id, material.key, oneNew)).toEqual([oneId!]);
      expect(await filesAtPath(server, remote.id, material.key, twoNew)).toEqual([twoId!]);
      expect(await filesAtPath(server, remote.id, material.key, one)).toEqual([]);
      expect(await filesAtPath(server, remote.id, material.key, two)).toEqual([]);
      expect(await trackedIn(names.a, oneNew)).toBe(oneId);
      expect(await trackedIn(names.b, oneNew)).toBe(oneId);
      expect(await trackedIn(names.b, twoNew)).toBe(twoId);
      // Exactly the new paths, in both vaults: a note left at the old path is the
      // duplicate this case exists to catch.
      expect(await probeFiles(names.a)).toEqual([twoNew, oneNew].toSorted());
      expect(await probeFiles(names.b)).toEqual([twoNew, oneNew].toSorted());
    });

    it("moves a note renamed inside a nested folder", async () => {
      const dir = `${PROBE_DIR}/${PROBE_PREFIX}folder-note`;
      const from = `${dir}/deep/before.md`;
      const to = `${dir}/deep/after.md`;

      await vaultA.write(from, "renamed inside the deepest folder");
      await reconcile(names.b);
      await waitForVaultState(
        async () => (await vaultB.read(from)) === "renamed inside the deepest folder",
        "vault B never pulled the note before the rename",
      );
      const fileId = await trackedIn(names.a, from);
      expect(fileId).toBeTruthy();

      await instrumentVault(names.a);
      await instrumentVault(names.b);
      await vaultA.rename(from, to);

      await waitForConvergence(
        async () => (await readVaultFile(names.b, to)) === "renamed inside the deepest folder",
        "vault B never materialised the renamed note",
        [from, to],
      );
      await waitForConvergence(
        async () => !(await vaultB.exists(from)),
        "vault B still has the note at its old nested path",
        [from, to],
      );
      expect(await filesAtPath(server, remote.id, material.key, to)).toEqual([fileId!]);
      expect(await filesAtPath(server, remote.id, material.key, from)).toEqual([]);
      expect(await trackedIn(names.b, to)).toBe(fileId);
    });

    it("moves the whole tree when a folder above a nested folder is renamed", async () => {
      const outer = `${PROBE_DIR}/${PROBE_PREFIX}folder-outer`;
      const renamed = `${PROBE_DIR}/${PROBE_PREFIX}folder-outer-renamed`;
      const top = `${outer}/top.md`;
      const nested = `${outer}/deep/inner/note.md`;
      const topNew = `${renamed}/top.md`;
      const nestedNew = `${renamed}/deep/inner/note.md`;

      await vaultA.write(top, "top level");
      await vaultA.write(nested, "deeply nested");
      await reconcile(names.b);
      await waitForVaultState(
        async () =>
          (await vaultB.read(top)) === "top level" &&
          (await vaultB.read(nested)) === "deeply nested",
        "vault B never pulled the tree before the rename",
      );
      const topId = await trackedIn(names.a, top);
      const nestedId = await trackedIn(names.a, nested);

      // The renamed folder is *not* the deepest one: its children change path at
      // two different depths, and one of them is a folder that has to move too.
      await instrumentVault(names.a);
      await instrumentVault(names.b);
      await vaultA.rename(outer, renamed);

      await waitForConvergence(
        async () =>
          (await readVaultFile(names.b, topNew)) === "top level" &&
          (await readVaultFile(names.b, nestedNew)) === "deeply nested",
        "vault B never materialised the renamed tree",
        [top, nested, topNew, nestedNew],
      );
      await waitForConvergence(
        async () => !(await vaultB.exists(top)) && !(await vaultB.exists(nested)),
        "vault B still has notes at the old paths of the renamed tree",
        [top, nested, topNew, nestedNew],
      );
      expect(await filesAtPath(server, remote.id, material.key, topNew)).toEqual([topId!]);
      expect(await filesAtPath(server, remote.id, material.key, nestedNew)).toEqual([nestedId!]);
      expect(await filesAtPath(server, remote.id, material.key, top)).toEqual([]);
      expect(await filesAtPath(server, remote.id, material.key, nested)).toEqual([]);
      expect(await probeFiles(names.b)).toEqual([nestedNew, topNew].toSorted());
    });

    /**
     * Empty notes are the shape every new Obsidian note starts in, and they make
     * every note in the vault share **one** content hash (`sha256("")`) — so the
     * identity work that falls back to "the chain whose content matches" cannot
     * tell two of them apart. The dev vaults' own history (two empty notes
     * duplicated at the old path after their folder was renamed) is exactly this
     * shape.
     */
    it("keeps same-content notes apart when their folder is renamed", async () => {
      const dir = `${PROBE_DIR}/${PROBE_PREFIX}folder-empty`;
      const renamed = `${PROBE_DIR}/${PROBE_PREFIX}folder-empty-renamed`;
      const one = `${dir}/one.md`;
      const two = `${dir}/two.md`;
      const oneNew = `${renamed}/one.md`;
      const twoNew = `${renamed}/two.md`;

      await vaultA.write(one, "");
      await vaultA.write(two, "");
      await reconcile(names.b);
      await waitForVaultState(
        async () => (await vaultB.exists(one)) && (await vaultB.exists(two)),
        "vault B never pulled the empty notes",
      );
      const oneId = await trackedIn(names.a, one);
      const twoId = await trackedIn(names.a, two);
      expect(oneId).not.toBe(twoId);

      await instrumentVault(names.a);
      await instrumentVault(names.b);
      await vaultA.rename(dir, renamed);

      await waitForConvergence(
        async () => (await vaultB.exists(oneNew)) && (await vaultB.exists(twoNew)),
        "vault B never materialised the renamed empty notes",
        [one, two, oneNew, twoNew],
      );
      await waitForConvergence(
        async () => !(await vaultB.exists(one)) && !(await vaultB.exists(two)),
        "vault B still has the empty notes at the old paths",
        [one, two, oneNew, twoNew],
      );
      await waitForAsync(
        async () =>
          (await filesAtPath(server, remote.id, material.key, oneNew)).length === 1 &&
          (await filesAtPath(server, remote.id, material.key, twoNew)).length === 1 &&
          (await filesAtPath(server, remote.id, material.key, one)).length === 0 &&
          (await filesAtPath(server, remote.id, material.key, two)).length === 0,
        "the empty notes did not converge on one chain per new path",
        60_000,
      );
      expect(await probeFiles(names.b)).toEqual([twoNew, oneNew].toSorted());
      expect(await trackedIn(names.b, oneNew)).toBe(oneId);
      expect(await trackedIn(names.b, twoNew)).toBe(twoId);
    });

    it("follows a folder moved into another folder, keeping every note on its chain", async () => {
      const outer = `${PROBE_DIR}/${PROBE_PREFIX}folder-move`;
      const moved = `${PROBE_DIR}/${PROBE_PREFIX}folder-destination/inner/moved`;
      const one = `${outer}/one.md`;
      const two = `${outer}/deep/two.md`;
      const oneNew = `${moved}/one.md`;
      const twoNew = `${moved}/deep/two.md`;

      await vaultA.write(one, "moved with its folder");
      await vaultA.write(two, "deeper, moved as well");
      await reconcile(names.b);
      await waitForVaultState(
        async () =>
          (await vaultB.read(one)) === "moved with its folder" &&
          (await vaultB.read(two)) === "deeper, moved as well",
        "vault B never pulled the folder before it moved",
      );
      const oneId = await trackedIn(names.a, one);
      const twoId = await trackedIn(names.a, two);

      // What the file explorer's drag-and-drop does: the folder keeps its name and
      // gains a parent, so every descendant's path changes at once and the peer has
      // to build a folder chain it has never seen.
      await instrumentVault(names.a);
      await instrumentVault(names.b);
      await vaultA.rename(outer, moved);

      await waitForConvergence(
        async () =>
          (await readVaultFile(names.b, oneNew)) === "moved with its folder" &&
          (await readVaultFile(names.b, twoNew)) === "deeper, moved as well",
        "vault B never materialised the moved folder tree",
        [one, two, oneNew, twoNew],
      );
      await waitForConvergence(
        async () => !(await vaultB.exists(one)) && !(await vaultB.exists(two)),
        "vault B still has notes at the old paths of the moved tree",
        [one, two, oneNew, twoNew],
      );
      expect(await filesAtPath(server, remote.id, material.key, oneNew)).toEqual([oneId!]);
      expect(await filesAtPath(server, remote.id, material.key, twoNew)).toEqual([twoId!]);
      expect(await filesAtPath(server, remote.id, material.key, one)).toEqual([]);
      expect(await probeFiles(names.b)).toEqual([twoNew, oneNew].toSorted());
    });

    it("deletes every note when the folder holding them is deleted", async () => {
      const dir = `${PROBE_DIR}/${PROBE_PREFIX}folder-delete`;
      const one = `${dir}/one.md`;
      const two = `${dir}/deep/two.md`;
      const keep = `${PROBE_DIR}/${PROBE_PREFIX}folder-delete-keep.md`;

      await vaultA.write(one, "doomed with its folder");
      await vaultA.write(two, "doomed as well");
      await vaultA.write(keep, "kept");
      await reconcile(names.b);
      await waitForVaultState(
        async () => (await vaultB.read(one)) === "doomed with its folder",
        "vault B never pulled the notes before the folder delete",
      );
      const oneId = await trackedIn(names.a, one);
      const twoId = await trackedIn(names.a, two);

      // The folder is deleted the way the file explorer deletes it — with its
      // contents — so Obsidian reports the folder and every descendant. The folder
      // events are dropped; each note has to become a tombstone of its own.
      await instrumentVault(names.a);
      await instrumentVault(names.b);
      await vaultA.removeTree(dir);

      await waitForConvergence(
        async () => !(await vaultB.exists(one)) && !(await vaultB.exists(two)),
        "vault B never applied the folder's deletions",
        [one, two, keep],
      );
      await waitForAsync(
        async () => {
          const bin = await deletedFiles(server, remote.id);
          return (
            bin.some((file) => file.fileId === oneId) && bin.some((file) => file.fileId === twoId)
          );
        },
        "the folder's notes never reached the server's recycle bin",
        60_000,
      );
      expect(await probeFiles(names.a)).toEqual([keep]);
      expect(await probeFiles(names.b)).toEqual([keep]);
      expect(await vaultB.read(keep)).toBe("kept");
    });

    it("follows a folder renamed in the peer vault, moving its own notes", async () => {
      const dir = `${PROBE_DIR}/${PROBE_PREFIX}folder-from-b`;
      const renamed = `${PROBE_DIR}/${PROBE_PREFIX}folder-from-b-renamed`;
      const one = `${dir}/one.md`;
      const two = `${dir}/deeper/two.md`;
      const oneNew = `${renamed}/one.md`;
      const twoNew = `${renamed}/deeper/two.md`;

      await vaultA.write(one, "created in A");
      await vaultA.write(two, "also created in A");
      await reconcile(names.b);
      await waitForVaultState(
        async () => (await vaultB.read(one)) === "created in A",
        "vault B never pulled the notes",
      );
      // Both notes, not just the first: Obsidian's vault index has to know the nested
      // folder before it can move it, and a pull creates the folder through the adapter.
      // Renaming too early moves only the indexed child and leaves `deeper` behind.
      await waitForVaultState(
        async () => (await vaultB.read(two)) === "also created in A",
        "vault B never pulled the nested note",
      );
      const oneId = await trackedIn(names.a, one);
      const twoId = await trackedIn(names.a, two);
      expect(oneId).toBeTruthy();
      expect(twoId).toBeTruthy();

      // Renamed in B: vault A has to move its own copies, into a folder chain it
      // has never created (`…-renamed`), while B's own rename burst is what reaches
      // it.
      await instrumentVault(names.a);
      await instrumentVault(names.b);
      await vaultB.rename(dir, renamed);

      // The sending side's push comes first: the only path a peer can move its own
      // file along is the one recorded in the version it pulls.
      await waitForConvergence(
        async () =>
          (await fileVersions(server, remote.id, oneId!)).at(-1)?.action === "rename" &&
          (await fileVersions(server, remote.id, twoId!)).at(-1)?.action === "rename",
        "vault B never pushed the folder rename for both notes",
        [one, two, oneNew, twoNew],
      );

      await waitForConvergence(
        async () =>
          (await readVaultFile(names.a, oneNew)) === "created in A" &&
          (await readVaultFile(names.a, twoNew)) === "also created in A",
        "vault A never followed the folder rename made in B",
        [one, two, oneNew, twoNew],
      );
      await waitForConvergence(
        async () => !(await vaultA.exists(one)) && !(await vaultA.exists(two)),
        "vault A still has the notes at the old paths",
        [one, two, oneNew, twoNew],
      );
      expect(await filesAtPath(server, remote.id, material.key, oneNew)).toEqual([oneId!]);
      expect(await trackedIn(names.a, oneNew)).toBe(oneId);
      expect(await probeFiles(names.a)).toEqual([twoNew, oneNew].toSorted());
    });
  });

  /**
   * The Obsidian config folder — the one dot-folder that syncs, and the only
   * place where the real app's behaviour cannot be inferred from a stub:
   *
   * - Obsidian keeps it **out of the vault index**, so `app.vault.read` cannot
   *   see `.obsidian/snippets/x.css` at all; listing and reading it has to go
   *   through `app.vault.adapter` (what the plugin's adapter does).
   * - Files written there fire **no vault event**, so a local settings change is
   *   only visible to the host's settings poll.
   * - The scope is per device: the same remote vault can carry a peer's settings
   *   chain that this device must leave completely alone.
   */
  describe("Obsidian settings files", () => {
    const probe = ".obsidian/snippets/courier-e2e-probe.css";

    /**
     * One probe file per config-folder group a disposable vault can carry without
     * hijacking a file Obsidian itself is using.
     *
     * The groups that own one of Obsidian's *own* files — `app.json`, `appearance.json`,
     * `hotkeys.json`, `core-plugins.json`, `community-plugins.json` — are deliberately not
     * in this table: overwriting `community-plugins.json` in a live vault would unload the
     * plugin under test, and the rest belong to the running instance. `corePlugins` gets
     * its own case below, where the flip is restored, because the state of a core plugin is
     * the one thing this whole feature turns on. The L1/L2 suites cover the full option
     * list; this layer exists for what only a real app can answer.
     */
    const PROBE_GROUPS: Array<{ group: SettingsGroup; path: string; content: string }> = [
      { group: "themes", path: ".obsidian/themes/courier-e2e-probe/theme.css", content: ":root{}" },
      // Deliberately **not** the `probe` file the case below uses: these cases bind a path
      // and then switch its group off, and the case below asserts that a device which does
      // not sync a path has no identity for it. Two cases sharing one path would make that
      // assertion depend on which of them ran first.
      {
        group: "snippets",
        path: ".obsidian/snippets/courier-e2e-probe-matrix.css",
        content: "/* courier e2e matrix probe */",
      },
      {
        group: "corePluginSettings",
        path: ".obsidian/courier-e2e-probe.json",
        content: '{"probe":true}',
      },
      {
        group: "communityPlugins",
        path: ".obsidian/plugins/courier-e2e-probe/main.js",
        content: "module.exports = {};",
      },
      { group: "otherFiles", path: ".obsidian/courier-e2e-probe/state.bin", content: "probe" },
    ];

    /** Core plugins this case may switch off: none of them is needed to run the suite. */
    const FLIPPABLE_CORE_PLUGINS = [
      "word-count",
      "outline",
      "tag-pane",
      "bookmarks",
      "random-note",
    ];

    const CORE_PLUGINS_PATH = ".obsidian/core-plugins.json";

    /**
     * A core plugin to switch off, and the file text that does it.
     *
     * The text is rebuilt the way Obsidian writes the file (two-space JSON), so what this
     * case pushes is shaped exactly like what a real toggle produces.
     */
    function flipEnabledCorePlugin(fileText: string): { id: string; text: string } {
      const parsed = JSON.parse(fileText) as Record<string, unknown>;
      const id =
        FLIPPABLE_CORE_PLUGINS.find((candidate) => parsed[candidate] === true) ??
        Object.entries(parsed).find(([, value]) => value === true)?.[0];
      if (id === undefined) throw new Error("this vault has no enabled core plugin to switch off");
      parsed[id] = false;
      return { id, text: JSON.stringify(parsed, null, 2) };
    }

    /** The disposable vault's folder on disk, by the name Obsidian knows it by. */
    function vaultPathOf(name: string): string {
      const vault = disposable.find((candidate) => candidate.name === name);
      if (!vault) throw new Error(`no disposable vault named ${name}`);
      return vault.path;
    }

    /**
     * Remove this suite's probe files, and only the folders it made for them.
     *
     * Directly on disk, not through the app. The config folder is outside the vault
     * index and fires no vault event, so an adapter call buys nothing here — but it is
     * one more CLI round trip that can lose its answer (the macOS hang this harness is
     * hardening against). The files belong to the suite; the app's settings pass reads
     * the folder from disk anyway, so a removal and an adapter removal are equivalent.
     */
    async function clearGroupProbes(vault: string): Promise<void> {
      const root = vaultPathOf(vault);
      for (const { path } of PROBE_GROUPS) {
        rmSync(join(root, path), { force: true });
        const folder = path.slice(0, path.lastIndexOf("/"));
        const leaf = folder.slice(folder.lastIndexOf("/") + 1);
        // Never a folder the vault owns: `snippets/` holds the user's CSS, and deleting
        // `plugins/` would take this very plugin — the one under test — with it. Only the
        // probe folder itself, which is why it is named with the probe prefix.
        if (!leaf.startsWith(PROBE_PREFIX)) continue;
        rmSync(join(root, folder), { recursive: true, force: true });
      }
    }

    /** Drop every snippets probe file the suite may have left, without a CLI call. */
    function clearSnippetProbes(vault: string): void {
      const snippets = join(vaultPathOf(vault), ".obsidian", "snippets");
      try {
        for (const entry of readdirSync(snippets)) {
          if (entry.includes("courier-e2e-probe")) {
            rmSync(join(snippets, entry), { recursive: true, force: true });
          }
        }
      } catch {
        // No snippets folder: nothing to clear.
      }
    }

    /**
     * Put both hosts back on notes-only and drop the probe files — as **fresh binders**.
     *
     * Wiping the per-file state is the point, not an incidental: a case that bound a probe
     * under a group and then switched the group off leaves an identity for a path this
     * device no longer syncs, and the case below asserts that a device with the group off
     * has no identity for it at all. It also keeps the state from carrying one vault's
     * fileIds into the next case, which uses a different remote vault.
     */
    async function resetSettingsSync(): Promise<void> {
      for (const [name, deviceName] of [
        [names.a, "obsidian-A"],
        [names.b, "obsidian-B"],
      ] as const) {
        clearSnippetProbes(name);
        await clearGroupProbes(name);
        await configurePluginHost(name, { ...setup, deviceName });
      }
    }

    /**
     * Every group whose probe this suite can own, both ways, in a real app.
     *
     * The L1 matrix pins the same rule over the whole option list against a real
     * filesystem; what a real Obsidian adds is the *adapter* half — `DataAdapter.list`
     * really listing `themes/<name>/`, a write through it really landing in the config
     * folder, and the plugin's own settings pass really being the thing that carries it.
     */
    it.each(PROBE_GROUPS)(
      "carries $group to a peer that asked for it, and leaves it alone on a peer that did not",
      async ({ group, path, content }) => {
        try {
          // A fresh binder per step: each case uses its own remote vault, so nothing the
          // previous case recorded is meaningful here.
          await configurePluginHost(
            names.a,
            { ...setup, deviceName: "obsidian-A" },
            {
              settingsGroups: { [group]: true },
            },
          );
          await writeConfigFileInVault(names.a, path, content);
          await runSettingsPass(names.a);

          await waitForAsync(
            async () => (await filesAtPath(server, remote.id, material.key, path)).length === 1,
            `${group}: the probe written in vault A never reached the server`,
            60_000,
          );

          // B asks for nothing: the chain is not pulled, not tracked, not parked.
          await configurePluginHost(names.b, { ...setup, deviceName: "obsidian-B" });
          await reconcile(names.b);
          expect(
            await readConfigFileInVault(names.b, path),
            `${group} arrived with the group off`,
          ).toBeNull();
          expect(await fileIdForPath(names.b, path)).toBeNull();
          // No conflict copy either: a group this device does not sync is not a disagreement.
          const parked = (
            await listConfigFolderInVault(names.b, path.slice(0, path.lastIndexOf("/")))
          ).filter((file) => file.includes("conflict"));
          expect(
            parked,
            `${group} parked a conflict copy on a device that does not sync it`,
          ).toEqual([]);

          // B asks for exactly that group: the bind pass applies it.
          await configurePluginHost(
            names.b,
            { ...setup, deviceName: "obsidian-B" },
            {
              settingsGroups: { [group]: true },
            },
          );
          await waitForVaultState(
            async () => (await readConfigFileInVault(names.b, path)) === content,
            `${group}: vault B never materialised the peer's probe`,
          );
        } finally {
          await clearGroupProbes(names.a).catch(() => undefined);
          await clearGroupProbes(names.b).catch(() => undefined);
          await resetSettingsSync();
        }
      },
    );

    it("carries a settings file to a peer that asked for that group, and never touches a peer's own config", async () => {
      try {
        // A syncs the snippets group only; B stays on notes only.
        await configurePluginHost(
          names.a,
          { ...setup, deviceName: "obsidian-A" },
          { resetSyncState: false, settingsGroups: { snippets: true } },
        );

        // Written through the data adapter, exactly as Obsidian writes it: no
        // vault event, so only the settings pass can carry it.
        await writeConfigFileInVault(names.a, probe, "/* courier e2e probe */");
        await runSettingsPass(names.a);

        await waitForAsync(
          async () => (await filesAtPath(server, remote.id, material.key, probe)).length === 1,
          "the settings file written in vault A never reached the server",
          60_000,
        );
        expect(await fileIdForPath(names.a, probe)).toBeTruthy();
        // This plugin's own data.json holds the device identity and the sync
        // state — it must never be part of what travels, whatever the groups say.
        expect(
          await filesAtPath(server, remote.id, material.key, ".obsidian/plugins/courier/data.json"),
        ).toEqual([]);
        // A does not sync the app settings, so that file stayed on its device even
        // though Obsidian keeps one in every real vault.
        expect(await filesAtPath(server, remote.id, material.key, ".obsidian/app.json")).toEqual(
          [],
        );

        // B has no group on: a full pass must leave the chain completely alone —
        // no pull, no conflict copy, no tracked fileId.
        await configurePluginHost(
          names.b,
          { ...setup, deviceName: "obsidian-B" },
          { resetSyncState: false },
        );
        await reconcile(names.b);
        expect(await readConfigFileInVault(names.b, probe)).toBeNull();
        expect(await fileIdForPath(names.b, probe)).toBeNull();
        const parkedInB = (await listConfigFolderInVault(names.b, ".obsidian/snippets")).filter(
          (file) => file.includes("conflict"),
        );
        expect(parkedInB).toEqual([]);

        // B turns that group on: its bind pass applies what A pushed, and the file
        // lands in the config folder through the data adapter.
        await configurePluginHost(
          names.b,
          { ...setup, deviceName: "obsidian-B" },
          { resetSyncState: false, settingsGroups: { snippets: true } },
        );
        await waitForVaultState(
          async () => (await readConfigFileInVault(names.b, probe)) === "/* courier e2e probe */",
          "vault B never materialised the peer's settings file",
        );
      } finally {
        await resetSettingsSync();
      }
    });

    /**
     * A settings conflict in a real app: the newer modification wins and nothing is parked.
     *
     * The config folder is outside Obsidian's file index, so a `*.conflict.*` copy written
     * there would not appear in the file explorer — there would be nothing for the user to
     * open, compare or replace. The rule is checked on the real filesystem: both vaults hold
     * a divergent copy of the probe, the later edit wins on both, and the config folder of
     * the losing device holds no copy.
     */
    it("settles a settings conflict by modification time, without parking a copy", async () => {
      // Deliberately not named "...conflict..." — the assertion below looks for parked
      // copies by that word, and a probe called that would match itself.
      const path = ".obsidian/snippets/courier-e2e-probe-lww.css";

      try {
        for (const [name, deviceName] of [
          [names.a, "obsidian-A"],
          [names.b, "obsidian-B"],
        ] as const) {
          await configurePluginHost(
            name,
            { ...setup, deviceName },
            {
              settingsGroups: { snippets: true },
            },
          );
        }

        await writeConfigFileInVault(names.a, path, "/* B sees this seed */");
        setVaultMtime(names.a, path, 1_000);
        await runSettingsPass(names.a);
        // A full pass on B rather than relying on the notification: the seed has to be
        // on B's disk before the two divergent edits are written.
        await reconcile(names.b);
        await waitForVaultState(
          async () => (await readConfigFileInVault(names.b, path)) === "/* B sees this seed */",
          "the seed probe never reached vault B",
        );

        // Both edit; A's copy is the later modification, so it has to replace B's.
        await writeConfigFileInVault(names.b, path, "/* B older */");
        setVaultMtime(names.b, path, 2_000);
        await writeConfigFileInVault(names.a, path, "/* A newer */");
        setVaultMtime(names.a, path, 3_000);
        await runSettingsPass(names.a);

        await runSettingsPass(names.b);
        await reconcile(names.b);

        await waitForVaultState(
          async () => (await readConfigFileInVault(names.b, path)) === "/* A newer */",
          "vault B did not take the later probe",
        );
        expect(await readConfigFileInVault(names.a, path)).toBe("/* A newer */");
        const parked = (await listConfigFolderInVault(names.b, ".obsidian/snippets")).filter(
          (file) => file.includes("conflict"),
        );
        expect(parked, "a config-folder conflict parked a copy on the losing device").toEqual([]);
      } finally {
        for (const name of [names.a, names.b]) {
          await removeConfigFileInVault(name, path).catch(() => undefined);
        }
        await resetSettingsSync();
      }
    });

    /**
     * The reload requirement, pinned in a real app.
     *
     * `core-plugins.json` is the file this feature turns on, and the interesting moment is
     * not the transfer — it is what the receiving **instance** does with it. Obsidian reads
     * its config at start-up and works from memory afterwards, so the file can hold exactly
     * what the peer's device holds while the running app still reports the old state. That
     * gap is why the plugin shows a notice with a reload button instead of leaving the user
     * to conclude the sync failed; this case is where the claim is checked, and where it
     * would fail loudly if an Obsidian release ever started applying it live.
     */
    it("lands a core plugin state in the file while the running app keeps its own", async () => {
      const originalA = await readConfigFileInVault(names.a, CORE_PLUGINS_PATH);
      const originalB = await readConfigFileInVault(names.b, CORE_PLUGINS_PATH);
      expect(originalA, `${names.a} has no core-plugins.json to flip`).not.toBeNull();
      const flip = flipEnabledCorePlugin(originalA!);

      try {
        for (const [name, deviceName] of [
          [names.a, "obsidian-A"],
          [names.b, "obsidian-B"],
        ] as const) {
          await configurePluginHost(
            name,
            { ...setup, deviceName },
            {
              settingsGroups: { corePlugins: true },
            },
          );
        }
        // Earlier cases in this file pull other reload-needing settings into B, and the
        // popup they raise has no expiry — so start from a clean screen and let this case
        // prove that *its* change is what brings the popup (and that a dismissed one comes
        // back, which is exactly the flow the user asked for).
        expect(await dismissReloadPopups(names.b)).toBe(0);

        // A real toggle lands in the file; here the file is written directly so the case
        // does not depend on which core plugin Obsidian's own UI happens to offer.
        await writeConfigFileInVault(names.a, CORE_PLUGINS_PATH, flip.text);
        await runSettingsPass(names.a);

        await waitForAsync(
          async () =>
            (await filesAtPath(server, remote.id, material.key, CORE_PLUGINS_PATH)).length >= 1,
          "the flipped core plugin state never reached the server",
          60_000,
        );

        // The transfer worked: B's file holds what A's device wrote…
        await waitForVaultState(
          async () => (await readConfigFileInVault(names.b, CORE_PLUGINS_PATH)) === flip.text,
          "vault B never materialised the peer's core plugin state",
        );

        // …and B's running app has not moved: it still reports the plugin as enabled,
        // because nothing told it to read the file again. This is the state the popup
        // exists for.
        const runtime = await corePluginRuntimeState(names.b, flip.id);
        expect(
          runtime.configured,
          "app.internalPlugins is not readable in this Obsidian build",
        ).not.toBeNull();
        expect(runtime.configured, `the running instance applied ${flip.id} without a reload`).toBe(
          true,
        );
        expect(runtime.loaded, "the plugin should still be running").toBe(true);

        // The card is up in the corner the user asked for, says a reload is what it takes, and
        // names no file.
        const popup = await readReloadPopups(names.b);
        expect(popup.count, "no card asks for the reload").toBe(1);
        expect(popup.text).toContain(t("reload.reload"));
        expect(popup.text).not.toContain("core-plugins.json");
        // Bottom-right: within ~60 px of the right edge and ~100 px of the bottom one (the card
        // is inset 16/40, and its own size is what makes the measurement approximate).
        expect(popup.corner.right, "the card is not at the right edge").toBeLessThan(60);
        expect(popup.corner.bottom, "the card is not at the bottom edge").toBeLessThan(100);

        // And it waits for the user instead of expiring on its own.
        await new Promise((resolve) => setTimeout(resolve, 8_000));
        expect((await readReloadPopups(names.b)).count, "the popup expired by itself").toBe(1);
      } finally {
        await dismissReloadPopups(names.b).catch(() => undefined);
        if (originalA !== null) await writeConfigFileInVault(names.a, CORE_PLUGINS_PATH, originalA);
        if (originalB !== null) await writeConfigFileInVault(names.b, CORE_PLUGINS_PATH, originalB);
        await resetSettingsSync();
      }
    });

    /**
     * Which switches a **running** Obsidian picks up on its own, and which ones it only
     * reads at start-up — measured against the real app, because the plugin's per-switch
     * hints and its reload notice are claims about the platform.
     *
     * The split is not the one the documentation suggests at first reading. Obsidian does
     * watch its config folder, and `app.json`, `hotkeys.json`, a theme *name* in
     * `appearance.json` and the *list* of snippet files are applied live — but a theme
     * folder that arrives, the snippet **enable** list in the same `appearance.json`, a core
     * plugin's state and a community plugin's install/enable are not. That asymmetry is why
     * the settings page marks themes, snippets, core plugins and community plugins, and
     * leaves `app` / `appearance` / `hotkeys` alone.
     *
     * Everything is written through the data adapter (exactly how this plugin writes a
     * pulled file) and put back afterwards; the sync host is paused first, so nothing this
     * case does can reach the server. If a release ever starts applying the second half by
     * itself, this case fails and the hints (not the test) are what must change.
     */
    it("applies the settings the app watches live, and leaves the rest for a reload", async () => {
      await pausePluginHost(names.a);
      /** How long a "the app picked this up" case may take before it counts as not applied. */
      const LIVE_TIMEOUT_MS = 6_000;
      /** How long a "the app ignored this" case waits before believing it. */
      const STALE_WAIT_MS = 3_000;
      const restore = async (path: string, original: string | null): Promise<void> => {
        if (original === null) await removeConfigFileInVault(names.a, path);
        else await writeConfigFileInVault(names.a, path, original);
      };
      /**
       * Write a config file, then watch the app's own value.
       *
       * The watched case polls, because "the app applies it" is a claim about eventually —
       * a busy app answering a second late is not a different behaviour — and the message
       * carries both values so a failure says what the app did instead. The ignored case
       * waits the whole window and reports whether anything moved at all.
       */
      const writeAndWatch = async (
        path: string,
        content: string,
        read: () => Promise<unknown>,
        expectLive: boolean,
      ): Promise<{ moved: boolean; before: unknown; after: unknown }> => {
        const before = await read();
        await writeConfigFileInVault(names.a, path, content);
        const deadline = Date.now() + (expectLive ? LIVE_TIMEOUT_MS : STALE_WAIT_MS);
        let after = before;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          after = await read();
          if (JSON.stringify(after) !== JSON.stringify(before) && expectLive) break;
        }
        return { moved: JSON.stringify(after) !== JSON.stringify(before), before, after };
      };

      // Every read is its own small `eval`: the CLI's transport truncates a big payload,
      // which crashes the app's main process (see `evalInVault`).
      const readMainSetting = () =>
        evalInVault<unknown>(
          names.a,
          `return app.vault.getConfig('attachmentFolderPath') ?? null;`,
        );

      const HOTKEYS = ".obsidian/hotkeys.json";
      const APP_JSON = ".obsidian/app.json";
      const THEME_DIR = ".obsidian/themes/zz-courier-live-probe";
      const SNIPPET = ".obsidian/snippets/zz-courier-live-probe.css";
      const APPEARANCE = ".obsidian/appearance.json";
      const LIST = ".obsidian/community-plugins.json";
      const PLUGIN_DIR = ".obsidian/plugins/zz-courier-live-probe";

      try {
        // 1. hotkeys.json — watched: the app rebinds while it runs.
        //
        // The command id is unique to this run, so "the app followed the file" cannot be
        // confused with a value an earlier run left in the app's memory — which is exactly
        // how the first version of this case passed for the wrong reason once and failed
        // afterwards.
        const hotkeyId = `zz-courier-probe-${Date.now()}`;
        const hotkeysOriginal = await readConfigFileInVault(names.a, HOTKEYS);
        const hotkeys = await writeAndWatch(
          HOTKEYS,
          JSON.stringify({ [hotkeyId]: [{ modifiers: ["Mod", "Alt"], key: "F8" }] }),
          () =>
            evalInVault<unknown>(
              names.a,
              `return app.hotkeyManager.customKeys[${jsLiteral(hotkeyId)}] ?? null;`,
            ),
          true,
        );
        await restore(HOTKEYS, hotkeysOriginal);

        // 2. app.json — watched: read through the app's own config.
        const appOriginal = await readConfigFileInVault(names.a, APP_JSON);
        const appParsed = appOriginal === null ? {} : JSON.parse(appOriginal);
        const mainSetting = await writeAndWatch(
          APP_JSON,
          JSON.stringify({ ...appParsed, attachmentFolderPath: "zz-courier-live-probe" }, null, 2),
          readMainSetting,
          true,
        );
        await restore(APP_JSON, appOriginal);

        // 3. core-plugins.json — a state, read once at start-up.
        const coreOriginal = await readConfigFileInVault(names.a, CORE_PLUGINS_PATH);
        const coreParsed = JSON.parse(coreOriginal ?? "{}") as Record<string, unknown>;
        const coreId =
          FLIPPABLE_CORE_PLUGINS.find((candidate) => coreParsed[candidate] === true) ??
          Object.entries(coreParsed).find(([, value]) => value === true)?.[0];
        if (coreId === undefined) throw new Error("this vault has no core plugin to switch off");
        coreParsed[coreId] = false;
        const corePlugin = await writeAndWatch(
          CORE_PLUGINS_PATH,
          JSON.stringify(coreParsed, null, 2),
          () =>
            evalInVault<boolean>(
              names.a,
              `return app.internalPlugins.config[${jsLiteral(coreId)}] === true;`,
            ),
          false,
        );
        await restore(CORE_PLUGINS_PATH, coreOriginal);

        // 4. a community plugin installed and enabled on disk.
        const listOriginal = await readConfigFileInVault(names.a, LIST);
        await writeConfigFileInVault(
          names.a,
          `${PLUGIN_DIR}/manifest.json`,
          JSON.stringify({
            id: "zz-courier-live-probe",
            name: "zz probe",
            version: "1.0.0",
            minAppVersion: "1.0.0",
            description: "probe",
            author: "probe",
          }),
        );
        await writeConfigFileInVault(
          names.a,
          `${PLUGIN_DIR}/main.js`,
          "module.exports = class { async onload() {} onunload() {} };",
        );
        const communityPlugin = await writeAndWatch(
          LIST,
          JSON.stringify([...JSON.parse(listOriginal ?? "[]"), "zz-courier-live-probe"], null, 2),
          () =>
            evalInVault<boolean>(
              names.a,
              `return Boolean(app.plugins.plugins['zz-courier-live-probe']);`,
            ),
          false,
        );
        await restore(LIST, listOriginal);
        await removeConfigFolderInVault(names.a, PLUGIN_DIR).catch(() => undefined);

        // 5. a theme folder that arrives.
        const themeRead = () =>
          evalInVault<boolean>(
            names.a,
            `return Array.from(app.customCss.themes).includes('zz-courier-live-probe');`,
          );
        const themeBefore = await themeRead();
        await writeConfigFileInVault(
          names.a,
          `${THEME_DIR}/manifest.json`,
          JSON.stringify({
            name: "zz-courier-live-probe",
            version: "1.0.0",
            minAppVersion: "1.0.0",
          }),
        );
        await writeConfigFileInVault(names.a, `${THEME_DIR}/theme.css`, "body{}");
        await new Promise((resolve) => setTimeout(resolve, STALE_WAIT_MS));
        const themeFolder = { before: themeBefore, after: await themeRead(), moved: false };
        themeFolder.moved = themeFolder.before !== themeFolder.after;
        await removeConfigFolderInVault(names.a, THEME_DIR).catch(() => undefined);

        // 6. the snippet **enable** list in appearance.json, with the file present.
        await writeConfigFileInVault(names.a, SNIPPET, ".zz-probe{color:red}");
        const appearanceOriginal = await readConfigFileInVault(names.a, APPEARANCE);
        const appearanceParsed =
          appearanceOriginal === null
            ? {}
            : (JSON.parse(appearanceOriginal) as Record<string, unknown>);
        const snippet = await writeAndWatch(
          APPEARANCE,
          JSON.stringify(
            { ...appearanceParsed, enabledCssSnippets: ["zz-courier-live-probe"] },
            null,
            2,
          ),
          () =>
            evalInVault<boolean>(
              names.a,
              `return Array.from(app.customCss.enabledSnippets).includes('zz-courier-live-probe');`,
            ),
          false,
        );
        await restore(APPEARANCE, appearanceOriginal);
        await removeConfigFileInVault(names.a, SNIPPET);

        // Watched, so these two switches carry no extra line on the settings page.
        expect(hotkeys.moved, report("hotkeys.json is applied live by this build", hotkeys)).toBe(
          true,
        );
        expect(
          mainSetting.moved,
          report("app.json is applied live by this build", mainSetting),
        ).toBe(true);
        // Read at start-up, which is what the hints and the reload notice are about.
        expect(
          corePlugin.moved,
          report("this build applied a core plugin state without a reload", corePlugin),
        ).toBe(false);
        expect(
          communityPlugin.moved,
          report("this build loaded a community plugin without a restart", communityPlugin),
        ).toBe(false);
        expect(
          themeFolder.moved,
          report("this build listed an arrived theme without a reload", themeFolder),
        ).toBe(false);
        expect(
          snippet.moved,
          report("this build applied an enabled snippet without a reload", snippet),
        ).toBe(false);
      } finally {
        await resetSettingsSync();
      }
    });
  });

  /**
   * Non-Markdown files against a **real** Obsidian.
   *
   * The three questions only the real app can answer: does `app.vault.getFiles()` really
   * list attachments (the adapter's listing switch), does `app.vault.createBinary` really
   * put an image where the plugin can see it, and does the file survive the trip
   * **byte for byte**? A stub with a flat `Map` answers none of them — and a text read
   * (`app.vault.read`, the CLI's `read`) would answer the last one wrongly, which is why
   * the bytes come back as base64.
   */
  describe("vault file types", () => {
    /**
     * A PNG-shaped payload: an image's bytes are not valid UTF-8 (21 bytes).
     *
     * Its size matters to the cap case below, which uses a cap between the note and this.
     */
    const PNG_BYTES = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0xff, 0xfe, 0x80, 0x7f,
    ]);
    const PNG_BASE64 = PNG_BYTES.toString("base64");

    /**
     * A **per-case** attachment path.
     *
     * The L3 cases share one remote vault, and the server keeps every chain it has ever
     * been sent, so a path reused across cases would already have history — and an
     * assertion like "the server holds no chain for this path" would be about the earlier
     * case, not this one.
     */
    function asset(name: string, extension: string): string {
      return `${PROBE_DIR}/assets/courier-e2e-${name}.${extension}`;
    }

    /** Delete the probe attachments from both vaults. */
    async function cleanAttachments(): Promise<void> {
      for (const name of [names.a, names.b]) {
        const vault = new ObsidianVault(name);
        for (const path of await vault.listAll()) {
          if (path.startsWith(`${PROBE_DIR}/assets/`)) await vault.remove(path);
        }
        await vault.removeFolder(`${PROBE_DIR}/assets`);
      }
    }

    /** Wait until the server holds a chain for `path` — i.e. the push side is done. */
    async function waitForPushed(path: string, message: string): Promise<void> {
      await waitForAsync(
        async () => (await filesAtPath(server, remote.id, material.key, path)).length > 0,
        message,
        60_000,
      );
    }

    it("carries an image to the other real vault byte for byte", async () => {
      const path = asset("image", "png");
      try {
        await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" });
        await configurePluginHost(names.b, { ...setup, deviceName: "obsidian-B" });

        const a = new ObsidianVault(names.a);
        await a.writeBase64(path, PNG_BASE64);

        await waitForVaultState(
          async () => (await new ObsidianVault(names.b).readBase64(path)) === PNG_BASE64,
          "vault B never materialised the image with identical bytes",
        );
        // The real index lists it — the answer `getMarkdownFiles` could not give.
        expect(await new ObsidianVault(names.b).listAll()).toContain(path);
        expect(await new ObsidianVault(names.b).list()).not.toContain(path);
      } finally {
        await cleanAttachments();
      }
    });

    it("carries canvas by default and an unlisted type only when asked", async () => {
      const canvasPath = asset("board", "canvas");
      const otherPath = asset("archive", "zip");
      const defaults = { images: true, video: true, audio: true, pdf: true, otherTypes: false };
      const withOtherTypes = { ...defaults, otherTypes: true };
      try {
        await configurePluginHost(
          names.a,
          { ...setup, deviceName: "obsidian-A" },
          { fileTypes: defaults },
        );
        await configurePluginHost(
          names.b,
          { ...setup, deviceName: "obsidian-B" },
          { fileTypes: defaults },
        );

        const a = new ObsidianVault(names.a);
        await a.write(canvasPath, '{"nodes":[],"edges":[]}');
        await a.writeBase64(otherPath, PNG_BASE64);
        // The canvas is a switch-free type, so A pushes it while the `.zip` stays put.
        await waitForPushed(canvasPath, "vault A never pushed the canvas");
        expect(await filesAtPath(server, remote.id, material.key, otherPath)).toEqual([]);

        await waitForVaultState(
          async () =>
            (await new ObsidianVault(names.b).read(canvasPath)) === '{"nodes":[],"edges":[]}',
          "vault B never materialised the canvas",
        );
        // `.zip` is an unlisted type: the default scope leaves it on device A, in both
        // directions — B has no chain to pull and does not create one for it either.
        expect(await new ObsidianVault(names.b).exists(otherPath)).toBe(false);
        await reconcile(names.b);
        expect(await filesAtPath(server, remote.id, material.key, otherPath)).toEqual([]);

        // Switching "all other types" on carries it from the device that has the file…
        await configurePluginHost(
          names.a,
          { ...setup, deviceName: "obsidian-A" },
          { resetSyncState: false, fileTypes: withOtherTypes },
        );
        await reconcile(names.a);
        await waitForPushed(otherPath, "vault A never pushed the unlisted type once it was on");
        // …and the peer that switched it on too pulls it, bytes intact.
        await configurePluginHost(
          names.b,
          { ...setup, deviceName: "obsidian-B" },
          { resetSyncState: false, fileTypes: withOtherTypes },
        );
        await waitForVaultState(
          async () => (await new ObsidianVault(names.b).readBase64(otherPath)) === PNG_BASE64,
          "vault B never materialised the unlisted type once it was switched on",
        );
      } finally {
        await cleanAttachments();
      }
    });

    it("keeps a file over the size cap on its own device", async () => {
      const imagePath = asset("capped", "png");
      const notePath = `${PROBE_PREFIX}cap-note.md`;
      try {
        // Above the note and below the image: the note must still travel, or the case
        // would pass for the wrong reason (nothing moving at all).
        const cap = 16;
        const note = "small enough";
        expect(PNG_BYTES.byteLength).toBeGreaterThan(cap);
        expect(Buffer.byteLength(note)).toBeLessThan(cap);
        // The cap is the account key's, not this device's: the administrator sets it
        // and both vaults read it from `GET /api/me` when their hosts start.
        await setUserMaxFileBytes(server, cap);
        await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" });
        await configurePluginHost(names.b, { ...setup, deviceName: "obsidian-B" });

        const a = new ObsidianVault(names.a);
        await a.writeBase64(imagePath, PNG_BASE64);
        await a.write(notePath, note);
        await reconcile(names.a);

        await waitForPushed(
          notePath,
          "the note beside the oversized image never reached the server",
        );
        // The image is over the cap, so this device never even read it: no chain, and the
        // peer has nothing to materialise.
        expect(await filesAtPath(server, remote.id, material.key, imagePath)).toEqual([]);
        expect(await new ObsidianVault(names.b).exists(imagePath)).toBe(false);
      } finally {
        const a = new ObsidianVault(names.a);
        if (await a.exists(notePath)) await a.remove(notePath);
        await cleanAttachments();
        // The service's user outlives this case, so put its cap back before the next one.
        await setUserMaxFileBytes(server, DEFAULT_MAX_FILE_BYTES);
      }
    });

    it("carries a file past the chunk threshold through the real adapter", async () => {
      // Above the engine's 8 MiB whole-payload bound, so a plain push cannot carry it:
      // the only way this file can travel is the chunk endpoints, encrypted one piece at
      // a time by the real adapter, and the peer reads it back in ranges. L1 pins the
      // protocol; this is the pair of real `app.vault.adapter` implementations it runs on.
      const path = asset("chunked", "bin");
      const size = 8 * 1024 * 1024 + 1024;
      try {
        await configurePluginHost(
          names.a,
          { ...setup, deviceName: "obsidian-A" },
          { fileTypes: { otherTypes: true } },
        );
        await configurePluginHost(
          names.b,
          { ...setup, deviceName: "obsidian-B" },
          { fileTypes: { otherTypes: true } },
        );

        // The bytes are generated inside the renderer: 11 MB of base64 in a CLI argument
        // would not fit, and a file dropped on disk is not in Obsidian's index anyway.
        const hash = await evalInVault<string>(
          names.a,
          `
          // Vault.createBinary refuses a folder that is not in the index, like the app does.
          const dir = ${jsLiteral(path.slice(0, path.lastIndexOf("/")))};
          for (const part of [dir.split("/")[0], dir]) {
            if (!app.vault.getAbstractFileByPath(part)) await app.vault.createFolder(part);
          }
          const size = ${size};
          const bytes = new Uint8Array(size);
          for (let i = 0; i < size; i++) bytes[i] = (i * 31) % 251;
          await app.vault.createBinary(${jsLiteral(path)}, bytes.buffer);
          const digest = await crypto.subtle.digest('SHA-256', bytes);
          return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
          `,
          60_000,
        );

        await waitForVaultState(
          async () => (await filesAtPath(server, remote.id, material.key, path)).length === 1,
          "the chunked file never reached the server",
          120_000,
        );
        // One chain, and only a chunked push can have carried it: the wire refuses a
        // whole payload this large, so the server's having it at all is the upload half.
        const fileId = await fileIdForPath(names.a, path);
        expect(fileId, "the plugin never tracked the file it pushed").not.toBeNull();
        expect(await fileVersions(server, remote.id, fileId!)).toHaveLength(1);

        // The peer materialises exactly those bytes — length and hash, not "a file
        // appeared": a chunk reassembled in the wrong order is what this catches.
        await waitForVaultState(
          async () => {
            const reading = await evalInVault<{ size: number; hash: string } | null>(
              names.b,
              `
              const abs = ${jsLiteral(path)};
              if (!app.vault.getAbstractFileByPath(abs)) return null;
              const bytes = new Uint8Array(await app.vault.adapter.readBinary(abs));
              const digest = await crypto.subtle.digest('SHA-256', bytes);
              return {
                size: bytes.byteLength,
                hash: Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''),
              };
              `,
              120_000,
            );
            return reading !== null && reading.size === size && reading.hash === hash;
          },
          "vault B never materialised the chunked file with identical bytes",
          120_000,
        );
        // Identical bytes are never a conflict: the real adapter's two reads must not have
        // parked a copy beside the file.
        const conflicts = (await new ObsidianVault(names.b).listAll()).filter((entry) =>
          entry.includes(".conflict."),
        );
        expect(conflicts).toEqual([]);
      } finally {
        // Leave the shared vaults on the default file types: the next case binds them
        // again, and a lingering `otherTypes` would quietly widen what it tests.
        await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" });
        await configurePluginHost(names.b, { ...setup, deviceName: "obsidian-B" });
        await cleanAttachments();
      }
    }, 300_000);
  });

  /**
   * The row of a file Obsidian has no view for.
   *
   * Obsidian draws its own extension tag (`.nav-file-tag`, `PNG`) for every attachment, at
   * the row's right end; the version-history chip is an in-flow row item just before it that
   * is collapsed until the row is hovered. A note never carries that tag, so an attachment is
   * the row where all three — name, chip and tag — have to share the end.
   */
  describe("attachment rows", () => {
    /**
     * The chip takes its width only while it is shown, and the name truncates in front of it.
     *
     * A narrow explorer is where the old absolute chip painted over the file name. The fix is
     * not a permanently reserved slot either: an idle row must keep its whole width, so the
     * chip is collapsed to zero until the row is hovered or the chip is focused. Shown, it
     * takes its width and the name's laying-out box — which clips its own text — ends where
     * the chip begins. Focus is the half of the shown state a geometry test can drive without
     * a pointer, since CSS `:hover` cannot be simulated; the reader takes a pointer that is
     * already on the row off it (a transform, which `:hover` follows) before the idle read.
     */
    itL("takes the chip's width only while shown, truncating the name in front of it", async () => {
      const path = `${PROBE_PREFIX}version-chip-tag-with-a-name-long-enough-to-truncate.png`;
      await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" });
      const a = new ObsidianVault(names.a);
      await a.writeBinary(path, ONE_PIXEL_PNG_BASE64);
      await waitForVaultState(
        async () =>
          (await readFileExplorerRowChips(names.a, path)).some((cls) =>
            cls.includes(VERSION_HISTORY_ACTION_CLASS),
          ),
        "the attachment row never got its version-history chip",
        30_000,
      );

      const reading = await readVersionHistoryChipBesideTag(names.a, path);
      // The app stores the raw extension; `text-transform: uppercase` is what makes the row
      // read `PNG`.
      expect(reading.tag.toLowerCase(), "the row carried no extension tag").toBe("png");
      expect(reading.idle, "the row was not measured idle").not.toBeNull();
      expect(reading.shown, "the chip was never measured shown").not.toBeNull();
      const idle = reading.idle!;
      const shown = reading.shown!;
      expect(idle.contentClipped, "the test's name was not long enough to truncate").toBe(true);

      // Idle: the chip takes no space, and the name's clipped box runs into the slot the chip
      // will take when it appears. The reader shifts a hovered row out from under the pointer
      // before reading, so these two assertions are unconditional — a regression that keeps
      // the chip expanded cannot hide behind a stray pointer.
      expect(
        reading.idleHovered,
        "the pointer could not be taken off the row to read its idle state",
      ).toBe(false);
      expect(idle.chipWidth, "the idle chip reserved space").toBe(0);
      expect(
        idle.contentRight,
        `name=${JSON.stringify(idle)} shown=${JSON.stringify(shown)}`,
      ).toBeGreaterThanOrEqual(shown.chipLeft);

      // Shown (focused): the chip has taken its width, the name ends in front of it, and the
      // extension tag still follows the chip.
      expect(shown.active, "the chip never took focus").toBe(true);
      expect(shown.opacity, "the focused chip stayed invisible").toBe("1");
      expect(shown.chipWidth).toBeGreaterThan(0);
      expect(shown.insideRow, "the chip rendered outside its row").toBe(true);
      expect(shown.contentClipped, "the shown name was not truncated").toBe(true);
      expect(shown.contentRight, `name=${JSON.stringify(shown)}`).toBeLessThanOrEqual(
        shown.chipLeft + 1,
      );
      expect(shown.chipRight, `chip=${JSON.stringify(shown)}`).toBeLessThanOrEqual(shown.tagLeft);
      expect(shown.tagLeft - shown.chipRight, "the chip drifted away from the tag").toBeLessThan(
        24,
      );

      // Blurred, with the pointer off the row, the chip gives its width back.
      expect(
        reading.afterBlurHovered,
        "the pointer could not be taken off the row after the blur",
      ).toBe(false);
      expect(reading.afterBlurWidth, "the chip stayed wide after the focus was gone").toBe(0);

      // The tag is drawn in every state; the chip is what changes.
      expect(reading.tagIdle, "the tag was not drawn on an idle row").toBe("visible");
      expect(shown.tagVisibility, "the tag hid while the chip was shown").toBe("visible");
    });
  });

  /**
   * Excluded folders, against two real Obsidian vaults.
   *
   * The L0/L1 layers pin the predicate and the engine; this is the part only a real app
   * can show: a note created through `app.vault` in a folder this device excluded never
   * reaches the server, the peer's note in the same folder never appears here, and
   * clearing the list makes both directions catch up.
   */
  describe("excluded folders", () => {
    // A top-level folder, so its row is always visible in the file explorer (a nested
    // folder's row only exists while its parent is expanded).
    const EXCLUDED_DIR = PROBE_DIR;

    it("keeps an excluded folder on its device and carries it once the list is cleared", async () => {
      const excludedA = `${EXCLUDED_DIR}/courier-e2e-excluded-a.md`;
      const excludedB = `${EXCLUDED_DIR}/courier-e2e-excluded-b.md`;
      const publicNote = `${PROBE_PREFIX}excluded-public.md`;

      await configurePluginHost(
        names.a,
        { ...setup, deviceName: "obsidian-A" },
        { excludedFolders: [EXCLUDED_DIR] },
      );
      await configurePluginHost(names.b, { ...setup, deviceName: "obsidian-B" });

      const a = new ObsidianVault(names.a);
      const b = new ObsidianVault(names.b);
      await a.write(excludedA, "from A");
      await a.write(publicNote, "public");
      await reconcile(names.a);

      // The pass ran (the public note went up) and still left the excluded one home.
      await waitForAsync(
        async () => (await filesAtPath(server, remote.id, material.key, publicNote)).length > 0,
        "the public note never reached the server",
        60_000,
      );
      expect(await filesAtPath(server, remote.id, material.key, excludedA)).toEqual([]);
      expect(await b.exists(excludedA)).toBe(false);

      // The file explorer's dimming is a rendered-UI assertion: a headless runner
      // may not mount the rows even though the scope data is right, so it stays
      // behind the layout gate. The data half of this case still runs in CI.
      if (layout) {
        // The file explorer dims the excluded folder (and the files inside it) as soon
        // as the list is saved; the harness changes settings directly, so ask the plugin
        // to re-apply the decoration it would have refreshed from its own write path.
        await evalInVault(
          names.a,
          `
          const p = app.plugins.plugins.courier;
          p.refreshExcludedFolderRows();
          return true;
          `,
          60_000,
        );
        await waitForVaultState(
          async () =>
            (await readFileExplorerRowClass(names.a, EXCLUDED_DIR)).includes(
              EXCLUDED_PATH_ROW_CLASS,
            ),
          "the file explorer never dimmed the excluded folder",
        );

        // Files inside the excluded folder are dimmed as well. Expand the folder first:
        // a collapsed folder has no file rows in the DOM to decorate.
        await expandFileExplorerFolder(names.a, EXCLUDED_DIR);
        await waitForVaultState(
          async () =>
            (await readFileExplorerRowClass(names.a, excludedA)).includes(EXCLUDED_PATH_ROW_CLASS),
          "the file inside the excluded folder was never dimmed in the file explorer",
        );

        // The entry points follow the same rule as the dimming: the excluded file's row
        // carries no Courier action at all — no version history, even though the plugin
        // cannot know from the name whether this device ever synced it — while a note it
        // does sync keeps its chip. The second half is what tells "excluded" apart from
        // "the decoration never ran".
        expect(
          await readFileExplorerRowChips(names.a, excludedA),
          "the excluded file was offered a Courier action in the file explorer",
        ).toEqual([]);
        await waitForVaultState(
          async () =>
            (await readFileExplorerRowChips(names.a, publicNote)).some((cls) =>
              cls.includes(VERSION_HISTORY_ACTION_CLASS),
            ),
          "the in-scope file lost its version-history chip",
        );
      }

      // B has no exclusion: its note is on the server, and A ignores it.
      await b.write(excludedB, "from B");
      await waitForAsync(
        async () => (await filesAtPath(server, remote.id, material.key, excludedB)).length > 0,
        "vault B never pushed its note",
        60_000,
      );
      await reconcile(names.a);
      expect(await a.exists(excludedB)).toBe(false);

      // Clearing A's list opens both directions on the next pass. This goes through the
      // plugin's own write path, which saves and restarts the host — the same door the
      // settings dialog uses, and the one that also re-decorates the explorer.
      await setExcludedFoldersInVault(names.a, []);
      if (layout) {
        await waitForVaultState(
          async () =>
            !(await readFileExplorerRowClass(names.a, EXCLUDED_DIR)).includes(
              EXCLUDED_PATH_ROW_CLASS,
            ) &&
            !(await readFileExplorerRowClass(names.a, excludedA)).includes(EXCLUDED_PATH_ROW_CLASS),
          "the file explorer stayed dimmed after the exclusion was cleared",
        );
        // ...and the entry point comes back with the scope, because the file is this
        // device's to act on again.
        await waitForVaultState(
          async () =>
            (await readFileExplorerRowChips(names.a, excludedA)).some((cls) =>
              cls.includes(VERSION_HISTORY_ACTION_CLASS),
            ),
          "the row never got its version-history chip back after the exclusion was cleared",
        );
      }
      await reconcile(names.a);
      await waitForAsync(
        async () => (await filesAtPath(server, remote.id, material.key, excludedA)).length > 0,
        "vault A never pushed its note once the folder was back in scope",
        60_000,
      );
      await waitForVaultState(
        async () => (await new ObsidianVault(names.a).read(excludedB)) === "from B",
        "vault A never pulled B's note once the folder was back in scope",
      );
      await reconcile(names.b);
      await waitForVaultState(
        async () => (await new ObsidianVault(names.b).read(excludedA)) === "from A",
        "vault B never received A's note once A cleared the exclusion",
      );
    });

    /**
     * An entry point that is already on screen, taken away.
     *
     * The chips are DOM, so this is the layer that can see the transition: the row is
     * decorated while the folder is in scope, then the folder is excluded through the
     * plugin's **own write path** (not by editing settings under it), and that same row —
     * Obsidian reuses it, no rebuild — must lose its chip. Clearing the list must put it
     * back. The dimming rides along, because the same refresh does both.
     */
    itL("takes the chip off a row when its folder becomes excluded, and puts it back", async () => {
      const note = `${EXCLUDED_DIR}/courier-e2e-toggle.md`;
      const inScope = `${PROBE_PREFIX}toggle-public.md`;

      await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" });
      const a = new ObsidianVault(names.a);
      await a.write(note, "note");
      await a.write(inScope, "public");
      await reconcile(names.a);

      await expandFileExplorerFolder(names.a, EXCLUDED_DIR);
      await waitForVaultState(
        async () =>
          (await readFileExplorerRowChips(names.a, note)).some((cls) =>
            cls.includes(VERSION_HISTORY_ACTION_CLASS),
          ),
        "the in-scope file never got its version-history chip",
      );

      await setExcludedFoldersInVault(names.a, [EXCLUDED_DIR]);
      await waitForVaultState(
        async () => (await readFileExplorerRowChips(names.a, note)).length === 0,
        "the chip stayed on the row of a file whose folder was excluded",
      );
      expect(
        (await readFileExplorerRowClass(names.a, note)).includes(EXCLUDED_PATH_ROW_CLASS),
        "the row was not dimmed when its folder became excluded",
      ).toBe(true);

      await setExcludedFoldersInVault(names.a, []);
      await waitForVaultState(
        async () =>
          (await readFileExplorerRowChips(names.a, note)).some((cls) =>
            cls.includes(VERSION_HISTORY_ACTION_CLASS),
          ),
        "the chip never came back after the exclusion was cleared",
      );
      expect(
        (await readFileExplorerRowClass(names.a, note)).includes(EXCLUDED_PATH_ROW_CLASS),
        "the row stayed dimmed after the exclusion was cleared",
      ).toBe(false);
    });

    /**
     * The phone's only entry point, in the real app.
     *
     * A phone has no hover, so the long-press file menu is the whole surface — and the
     * plugin loads there with `Platform.isDesktop` false. `app.emulateMobile` is the app's
     * own switch: it reloads the window, so the plugin really runs its mobile `onload`,
     * and the menu this case builds is the one a long-press would build for a real `TFile`.
     * The exclusion is device-local, so the same rule has to answer here: no Courier action
     * for a file this device keeps out of sync, while an in-scope note keeps its history
     * and an in-scope parked copy keeps its comparison.
     */
    it("offers no Courier action in the phone's file menu for an excluded file", async () => {
      const excluded = `${EXCLUDED_DIR}/courier-e2e-phone.md`;
      const excludedCopy = `${EXCLUDED_DIR}/courier-e2e-phone-2026-02-14-101530.conflict.md`;
      const inScope = `${PROBE_PREFIX}phone-menu-public.md`;
      const inScopeCopy = `${PROBE_PREFIX}phone-menu-2026-02-14-101530.conflict.md`;

      await configurePluginHost(
        names.a,
        { ...setup, deviceName: "obsidian-A" },
        { excludedFolders: [EXCLUDED_DIR] },
      );
      const a = new ObsidianVault(names.a);
      await a.write(excluded, "local");
      await a.write(excludedCopy, "parked");
      await a.write(inScope, "public");
      await a.write(inScopeCopy, "parked");
      await reconcile(names.a);
      // The pass ran (the in-scope note went up), so the exclusion is live on this device.
      await waitForAsync(
        async () => (await filesAtPath(server, remote.id, material.key, inScope)).length > 0,
        "the in-scope note never reached the server",
        60_000,
      );

      const courierTitles = [
        t("menu.versionHistory"),
        t("conflict.action.diff.title"),
        t("conflict.action.replace.title"),
      ];
      try {
        await setMobileEmulation(names.a, true);
        expect(
          await evalInVault<boolean>(names.a, "return app.isMobile === true"),
          "Obsidian did not report itself as mobile after the reload",
        ).toBe(true);
        // The handler registers during the reload's `onload`, so an empty menu proves
        // nothing until it has answered once: the in-scope item is the readiness signal.
        await waitForVaultState(
          async () =>
            (await readFileMenuTitles(names.a, inScope)).includes(t("menu.versionHistory")),
          "the plugin's version-history item never appeared on the phone",
        );

        for (const path of [excluded, excludedCopy]) {
          const titles = await readFileMenuTitles(names.a, path);
          expect(
            courierTitles.filter((title) => titles.includes(title)),
            `${path} was offered a Courier action on the phone (menu: ${titles.join(", ")})`,
          ).toEqual([]);
        }

        // In-scope files keep their actions on a phone: the menu is the only way to reach
        // them there, so hiding it for every file would be a different bug.
        expect(await readFileMenuTitles(names.a, inScopeCopy)).toContain(
          t("conflict.action.diff.title"),
        );
      } finally {
        // Every later case in this file expects the desktop layout back, and the exclusion
        // this case wrote belongs to it: leaving the list set would quietly scope the next
        // case, which configures its own host without touching `excludedFolders`.
        await setMobileEmulation(names.a, false);
        await setExcludedFoldersInVault(names.a, []);
      }
    });
  });

  /**
   * One writer per vault, in the field shape.
   *
   * L1 runs the CLI against the CLI; L2 fakes the other writer's lease on an in-memory
   * adapter. This is the real thing: the record sits on a real vault's disk, the real
   * host loop decides it may not build an engine, and the release arrives through the
   * filesystem — no restart and no second process.
   */
  describe("one writer per vault", () => {
    it("waits for another writer's lease and resumes when the record is released", async () => {
      const notePath = `${PROBE_PREFIX}lease.md`;
      await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" });
      await configurePluginHost(names.b, { ...setup, deviceName: "obsidian-B" });
      const base = await vaultBasePath(names.a);
      const leaseDir = join(base, ".courier", "sync-lease");

      try {
        // A's host stops and releases its lease before the record below takes its place.
        // `stop()` starts the drain and `whenStopped()` is what the app itself awaits, so
        // no pass can still be writing while this case claims the vault is quiet.
        await evalInVault(
          names.a,
          `
          const p = app.plugins.plugins.courier;
          const previous = p.host;
          if (previous) {
            previous.stop();
            await previous.whenStopped();
          }
          p.host = null;
          return true;
          `,
          60_000,
        );
        const now = Date.now();
        mkdirSync(leaseDir, { recursive: true });
        writeFileSync(
          join(leaseDir, "owner.json"),
          JSON.stringify({
            version: 1,
            owner: "cli",
            token: "cli-token",
            // The record names no machine, so liveness is the expiry alone; 0 is the
            // defined "no process table to ask" value rather than a real pid.
            pid: 0,
            acquiredAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
            expiresAt: now + 60_000,
          }),
        );

        const waiting = await evalInVault<{
          hosting: boolean;
          waiting: boolean;
          engine: boolean;
        }>(
          names.a,
          `
          const p = app.plugins.plugins.courier;
          await p.startHost();
          return { hosting: !!p.host, waiting: !!(p.host && p.host.leaseWaiting), engine: !!p.engine };
          `,
          60_000,
        );
        expect(waiting.hosting, "the plugin gave up instead of waiting").toBe(true);
        expect(waiting.waiting, "the host did not report the other writer").toBe(true);
        expect(waiting.engine, "the host built an engine over another writer's vault").toBe(false);

        // Nothing moves while the other writer owns the vault.
        await vaultB.write(notePath, "after the release");
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        expect(await vaultA.read(notePath)).toBeNull();

        // Releasing the record is enough: no reload, no manual reconcile.
        rmSync(leaseDir, { recursive: true, force: true });
        await waitForVaultState(
          async () => (await vaultA.read(notePath)) === "after the release",
          "vault A never resumed syncing after the lease was released",
          60_000,
        );
        expect(
          await evalInVault<boolean>(names.a, `return !!app.plugins.plugins.courier.engine;`),
          "the host never took the lease and built an engine",
        ).toBe(true);

        // The resumed host is a normal participant again: its own write reaches the peer.
        await vaultA.write(notePath, "pushed after takeover");
        await waitForVaultState(
          async () => (await vaultB.read(notePath)) === "pushed after takeover",
          "the resumed host never pushed its own write",
          60_000,
        );
      } finally {
        // Release the other writer's record, then stop the waiting host the same way the
        // case started: the next case expects to bind, not to inherit a lease-waiting one.
        rmSync(leaseDir, { recursive: true, force: true });
        await evalInVault(
          names.a,
          `
          const p = app.plugins.plugins.courier;
          const previous = p.host;
          if (previous) {
            previous.stop();
            await previous.whenStopped();
          }
          p.host = null;
          return true;
          `,
          60_000,
        );
        await vaultA.remove(notePath);
        await vaultB.remove(notePath);
      }
    }, 180_000);
  });

  /**
   * Pausing is a user-facing state with two halves the lower layers cannot see together:
   * the real Obsidian Settings page is the only control (the suite keeps it in the vault
   * window so a run never raises the app), and the stopped host has to mean *nothing*
   * moves in either direction while it is up.
   *
   * Deliberately the last case in the file: it pauses a vault that every earlier case
   * shares, so a failure here must not cascade into them.
   */
  it("changes the vault's history limits from the settings page's pencil icon and Save", async () => {
    // The limits are the vault's; this device edits them through the real row, and the
    // value it shows afterwards is what the server stored.
    const label = t("settings.historyLimit.documents.label");
    const freshScope = {
      resetSyncState: false,
      settingsGroups: NO_SETTINGS_GROUPS,
      fileTypes: DEFAULT_FILE_TYPES,
      excludedFolders: [],
    };
    // Start from the documented defaults, so a failed earlier run cannot mask the read.
    await updateVaultSettings(server, remote.id, {
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
      historyLimitAttachments: DEFAULT_HISTORY_LIMITS.attachments,
    });
    await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" }, freshScope);

    // The row renders the server's number as text, with a button that offers the change.
    await waitForVaultState(() => openPluginSettings(names.a), "the settings page never opened");
    await waitForVaultState(
      async () =>
        (await readHistoryLimitRow(names.a, label))?.value ===
        String(DEFAULT_HISTORY_LIMITS.documents),
      "the settings row never showed the vault's limit",
    );
    const before = (await readHistoryLimitRow(names.a, label))!;
    // The idle control is a pencil icon, not a word; its tooltip carries the label.
    expect(before.icon).toBe(true);
    expect(before.button).toBe("");
    expect(before.tooltip).toBe(t("settings.historyLimit.edit"));
    expect(before.editing).toBe(false);

    // Pressing blank space while the field is open cancels: the row goes back to its text
    // and the number the vault holds is untouched (only the check icon commits).
    await waitForVaultState(
      () => openHistoryLimitEditor(names.a, label),
      "the settings row never entered edit mode",
    );
    expect((await readHistoryLimitRow(names.a, label))?.editing).toBe(true);
    await waitForVaultState(
      () => clickSettingsBlank(names.a),
      "the settings page had no blank space to press",
    );
    await waitForVaultState(
      async () => (await readHistoryLimitRow(names.a, label))?.editing === false,
      "pressing outside never cancelled the edit",
    );
    const cancelled = (await readHistoryLimitRow(names.a, label))!;
    expect(cancelled.icon).toBe(true);
    expect(cancelled.tooltip).toBe(t("settings.historyLimit.edit"));
    expect(cancelled.desc).toBe(t("settings.historyLimit.documents.desc"));
    expect((await vaultSettings(server, remote.id)).historyLimitDocuments).toBe(
      DEFAULT_HISTORY_LIMITS.documents,
    );

    // Pencil → type → check, exactly the interaction a user performs.
    await waitForVaultState(
      () => editHistoryLimitRow(names.a, label, 60),
      "the settings row never offered the pencil/check interaction",
    );
    await waitForVaultState(
      async () => (await vaultSettings(server, remote.id)).historyLimitDocuments === 60,
      "the vault's history limit never changed",
    );
    await waitForVaultState(async () => {
      const row = await readHistoryLimitRow(names.a, label);
      return (
        row?.value === "60" &&
        row.icon === true &&
        row.button === "" &&
        row.tooltip === t("settings.historyLimit.edit") &&
        // The press was the confirmation: the description is the row's own text again.
        row.desc === t("settings.historyLimit.documents.desc")
      );
    }, "the row never showed the saved number and its confirmation");

    // Back to the defaults, so the cases after this one (and the next run) start clean.
    await updateVaultSettings(server, remote.id, {
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
    });
  });

  it("cancels a history-limit edit from the row's label, and keeps it in the field", async () => {
    // The field is the one press that belongs to an edit in progress, and everything else in
    // the row is the user moving on. A narrow pane (a phone's 390 px, or a squeezed window)
    // turns the row into a column with a full-width control, so its label and the space
    // beside the field are most of what the user can press — pressing there has to cancel
    // exactly like pressing outside the row does. The check's own press is the other half of
    // the rule and is pinned by every case that saves through `editHistoryLimitRow`, which
    // now presses before it clicks. The attachments row is the one this case edits, so the
    // number stays at its default and no write has to be undone.
    const label = t("settings.historyLimit.attachments.label");
    const freshScope = {
      resetSyncState: false,
      settingsGroups: NO_SETTINGS_GROUPS,
      fileTypes: DEFAULT_FILE_TYPES,
      excludedFolders: [],
    };
    await updateVaultSettings(server, remote.id, {
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
      historyLimitAttachments: DEFAULT_HISTORY_LIMITS.attachments,
    });
    await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" }, freshScope);
    await waitForVaultState(() => openPluginSettings(names.a), "the settings page never opened");
    await waitForVaultState(
      async () =>
        (await readHistoryLimitRow(names.a, label))?.value ===
        String(DEFAULT_HISTORY_LIMITS.attachments),
      "the attachments row never showed the vault's limit",
    );

    await waitForVaultState(
      () => openHistoryLimitEditor(names.a, label),
      "the attachments row never entered edit mode",
    );
    expect((await readHistoryLimitRow(names.a, label))?.editing).toBe(true);

    // The user goes on typing: a press on the field itself keeps the edit alive, which is
    // the half a dismiss rule that fires too eagerly loses.
    await waitForVaultState(
      () => clickHistoryLimitRowField(names.a, label),
      "the row had no field to press",
    );
    expect(
      (await readHistoryLimitRow(names.a, label))?.editing,
      "pressing the field cancelled the edit",
    ).toBe(true);

    // The press lands on the row's label — inside the row, on neither the field nor the icon.
    await waitForVaultState(
      () => clickHistoryLimitRowLabel(names.a, label),
      "the settings page had no attachments row to press",
    );
    await waitForVaultState(
      async () => (await readHistoryLimitRow(names.a, label))?.editing === false,
      "pressing the row's own label never cancelled the edit",
    );
    const cancelled = (await readHistoryLimitRow(names.a, label))!;
    expect(cancelled.icon).toBe(true);
    expect(cancelled.tooltip).toBe(t("settings.historyLimit.edit"));
    expect(cancelled.desc).toBe(t("settings.historyLimit.attachments.desc"));
    // Cancel means cancel: the edit never reached the vault.
    expect((await vaultSettings(server, remote.id)).historyLimitAttachments).toBe(
      DEFAULT_HISTORY_LIMITS.attachments,
    );
  });

  itL(
    "keeps the history-limit row's number at the trailing edge and centred on its text",
    async () => {
      // Two rules, one row. On a narrow pane the app's container query on the settings pane
      // (under 400 px) turns the row into a column and moves every control to the leading
      // edge, because it is laying out text fields; this row is a number and one icon, so it
      // belongs at the trailing edge, where the switches above and below it sit. On a wide
      // pane the row is horizontal again and the app aligns its **top** edges, which leaves
      // the one-line control up beside the title while the explanation runs on below it — so
      // the two halves share a centre line instead. The pane is resized for each measurement
      // and restored inside the same eval.
      const label = t("settings.historyLimit.documents.label");
      const freshScope = {
        resetSyncState: false,
        settingsGroups: NO_SETTINGS_GROUPS,
        fileTypes: DEFAULT_FILE_TYPES,
        excludedFolders: [],
      };
      await updateVaultSettings(server, remote.id, {
        historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
      });
      await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" }, freshScope);
      await waitForVaultState(() => openPluginSettings(names.a), "the settings page never opened");
      await waitForVaultState(
        async () =>
          (await readHistoryLimitRow(names.a, label))?.value ===
          String(DEFAULT_HISTORY_LIMITS.documents),
        "the settings row never showed the vault's limit",
      );

      // The narrow pane, 380 px: a column with a full-width control under the label.
      const narrow = await measureHistoryLimitRow(names.a, label, 380);
      expect(narrow, "the settings row was not rendered").not.toBeNull();
      const { row, control, value, button } = narrow!;
      expect(control.width, "the narrow pane did not stack the row").toBeGreaterThan(
        row.width * 0.8,
      );
      // The regression this case pins: the number was at the leading edge, under the label's
      // left end. It stays in the trailing half, next to its icon, and the icon closes the row.
      expect(value.left, "the number sits at the row's leading edge").toBeGreaterThan(
        control.left + control.width / 2,
      );
      expect(value.right, "the number is not beside its icon").toBeLessThanOrEqual(button.left + 1);
      // The icon is the last thing on the control's own line, whatever the row's padding is.
      // The 4 px slack covers two independently rounded edges; a control that is not at the
      // trailing edge is off by far more than that.
      expect(button.right, "the icon is not at the control's trailing edge").toBeGreaterThanOrEqual(
        control.right - 4,
      );

      // The wide pane, 720 px: the text on the left, the control on the right, both centred on
      // the same horizontal line. The text block is two lines tall and the reading is one, so
      // a top-aligned control reads as "too high" by half that difference.
      const wide = await measureHistoryLimitRow(names.a, label, 720);
      expect(wide, "the settings row was not rendered at a wide pane").not.toBeNull();
      const wideValue = wide!.value;
      const wideInfo = wide!.info;
      expect(
        wide!.control.left,
        "the wide pane did not put the control on the right",
      ).toBeGreaterThan(wideInfo.left + wideInfo.width / 2);
      const valueCentre = wideValue.top + wideValue.height / 2;
      const textCentre = wideInfo.top + wideInfo.height / 2;
      expect(
        Math.abs(valueCentre - textCentre),
        `the number's centre (${valueCentre}) is off the text block's (${textCentre})`,
      ).toBeLessThanOrEqual(4);
    },
  );

  it("shows a limit changed on the other device without reopening the settings page", async () => {
    // The limits are the vault's; a page already open on B has to follow a change made on
    // A. B never reopens the page and never calls its own write path — the socket's
    // `vault_settings` repaints the row.
    const label = t("settings.historyLimit.documents.label");
    const freshScope = {
      resetSyncState: false,
      settingsGroups: NO_SETTINGS_GROUPS,
      fileTypes: DEFAULT_FILE_TYPES,
      excludedFolders: [],
    };
    await updateVaultSettings(server, remote.id, {
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
      historyLimitAttachments: DEFAULT_HISTORY_LIMITS.attachments,
    });
    await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" }, freshScope);
    await configurePluginHost(names.b, { ...setup, deviceName: "obsidian-B" }, freshScope);
    await waitForVaultState(
      async () =>
        (await readPluginStatus(names.a)).wsState === "connected" &&
        (await readPluginStatus(names.b)).wsState === "connected",
      "one of the two vaults never connected its socket",
    );

    // B's settings page is open on the number the vault holds today.
    await waitForVaultState(() => openPluginSettings(names.b), "the settings page never opened");
    await waitForVaultState(
      async () =>
        (await readHistoryLimitRow(names.b, label))?.value ===
        String(DEFAULT_HISTORY_LIMITS.documents),
      "B's page never showed the vault's limit",
    );

    // A changes it through its own page.
    await waitForVaultState(
      () => editHistoryLimitRow(names.a, label, 45),
      "A's settings page never accepted the change",
    );
    await waitForVaultState(
      async () => (await vaultSettings(server, remote.id)).historyLimitDocuments === 45,
      "the vault's history limit never changed",
    );

    // B's row follows, with no reopen and no manual refresh.
    await waitForVaultState(
      async () => (await readHistoryLimitRow(names.b, label))?.value === "45",
      "B's open settings page never followed the change made on A",
    );

    // Restore the default for the cases after this one.
    await updateVaultSettings(server, remote.id, {
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
    });
  });

  it("re-reads an open version-history page when the vault's limit trims it", async () => {
    // The page is open on the whole chain, with an old version selected; the limit drops and
    // the server reclaims that version. Without the re-read the list would keep the row and
    // the pane would say it cannot fetch the content.
    const path = "history-refresh.md";
    const label = t("settings.historyLimit.documents.label");
    const freshScope = {
      resetSyncState: false,
      settingsGroups: NO_SETTINGS_GROUPS,
      fileTypes: DEFAULT_FILE_TYPES,
      excludedFolders: [],
    };
    await updateVaultSettings(server, remote.id, {
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
      historyLimitAttachments: DEFAULT_HISTORY_LIMITS.attachments,
    });
    await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" }, freshScope);

    await vaultA.write(path, "v1");
    await waitForVaultState(
      async () => (await filesAtPath(server, remote.id, material.key, path)).length === 1,
      "the note never reached the server",
    );
    await waitForVaultState(
      async () => (await fileIdForPath(names.a, path)) !== null,
      "the engine never tracked the note",
    );
    const fileId = (await fileIdForPath(names.a, path))!;
    const chainLength = async (): Promise<number> =>
      (await vaultHistory(server, remote.id)).find((chain) => chain.fileId === fileId)?.versions
        .length ?? 0;
    for (const [index, content] of ["v2", "v3"].entries()) {
      await vaultA.write(path, content);
      await waitForVaultState(
        async () => (await chainLength()) === index + 2,
        `version ${index + 2} never reached the server`,
      );
    }

    await waitForVaultState(
      () => clickVersionHistoryChip(names.a, path),
      "the explorer never offered the version-history action",
    );
    await waitForVaultState(async () => {
      const view = await readVersionHistoryView(names.a);
      return view.open && view.rows.length === 3;
    }, "the version-history page never listed the whole chain");

    // Select the oldest version, which is the one the lowered limit will reclaim.
    await waitForVaultState(
      () => clickVersionHistoryRow(names.a, 2),
      "the oldest version could not be selected",
    );
    await waitForVaultState(async () => {
      const view = await readVersionHistoryView(names.a);
      return view.rows[2]?.selected === true;
    }, "the oldest version was never marked as the selection");

    // Lower the limit from the settings page; this device trims and then re-reads the tab.
    await waitForVaultState(
      () => editHistoryLimitRow(names.a, label, 2),
      "the settings page never accepted the lower limit",
    );
    await waitForVaultState(
      async () => (await vaultSettings(server, remote.id)).historyLimitDocuments === 2,
      "the vault's history limit never changed",
    );

    await waitForVaultState(async () => {
      const view = await readVersionHistoryView(names.a);
      // Two rows, the head selected, and no "cannot fetch" line where the pane now shows
      // the head's content.
      return view.rows.length === 2 && view.rows[0]?.selected === true && view.pane !== "";
    }, "the open history page never re-read the trimmed chain");
    const view = await readVersionHistoryView(names.a);
    // Labels come from the plugin's catalog, so they follow the app's language: assert
    // through `t()` (the suite syncs the test locale to the app) rather than a literal.
    expect(view.rows.map((row) => row.action)).toEqual([
      t("history.action.modify"),
      t("history.action.modify"),
    ]);
    expect(view.pane).not.toContain(t("dialog.versionHistory.contentError"));

    // Restore the default and leave the window as the next case expects to find it.
    await updateVaultSettings(server, remote.id, {
      historyLimitDocuments: DEFAULT_HISTORY_LIMITS.documents,
    });
    await closeVersionHistories(names.a);
  });

  it("pauses and resumes syncing from the settings page's own row", async () => {
    const path = `${PROBE_DIR}/${PROBE_PREFIX}pause.md`;
    const peerPath = `${PROBE_DIR}/${PROBE_PREFIX}pause-peer.md`;

    // Start from a known device scope: earlier cases leave theirs behind (the size-cap
    // case, for one, leaves 16 bytes on both vaults, which would quietly drop the notes
    // this case writes). This is the last case in the file, so it restores before it runs.
    const freshScope = {
      resetSyncState: false,
      settingsGroups: NO_SETTINGS_GROUPS,
      fileTypes: DEFAULT_FILE_TYPES,
      excludedFolders: [],
    };
    await configurePluginHost(names.a, { ...setup, deviceName: "obsidian-A" }, freshScope);
    await configurePluginHost(names.b, { ...setup, deviceName: "obsidian-B" }, freshScope);

    // 1. Pause from the real row — no direct call into the plugin.
    await waitForVaultState(
      () => clickPauseRow(names.a, t("settings.pause.pause")),
      "the plugin settings page never offered the pause action",
    );
    await waitForVaultState(async () => {
      const row = await readPauseRow(names.a);
      return row?.paused === true && row.button === t("settings.pause.resume");
    }, "the settings page never showed the paused state");
    const pausedRow = (await readPauseRow(names.a))!;
    expect(pausedRow.desc).toBe(t("settings.pause.descPaused"));
    expect((await readPluginStatus(names.a)).hosting).toBe(false);

    // 2. Nothing leaves: a note written while paused stays local.
    await vaultA.write(path, "written while paused");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await filesAtPath(server, remote.id, material.key, path)).toEqual([]);

    // 3. Nothing arrives: B's note is on the server, and A has no socket to hear about it.
    await vaultB.write(peerPath, "peer while paused");
    await waitForVaultState(
      async () => (await filesAtPath(server, remote.id, material.key, peerPath)).length === 1,
      "vault B's note never reached the server",
    );
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await vaultA.read(peerPath)).toBeNull();

    // 4. Resume from the same row; the bind pass catches both directions up.
    await waitForVaultState(
      () => clickPauseRow(names.a, t("settings.pause.resume")),
      "the settings page never offered the resume action",
    );
    await waitForVaultState(async () => {
      const row = await readPauseRow(names.a);
      return row?.paused === false && row.button === t("settings.pause.pause");
    }, "the settings page never left the paused state");
    expect((await readPluginStatus(names.a)).hosting).toBe(true);
    await waitForVaultState(
      async () => (await filesAtPath(server, remote.id, material.key, path)).length === 1,
      "the note written while paused never reached the server after resuming",
    );
    await waitForVaultState(
      async () => (await vaultA.read(peerPath)) === "peer while paused",
      "the peer's note never arrived after resuming",
    );
  });

  /**
   * The status bar is the one sync surface that is always on screen, so it is measured
   * where it actually renders. The menu is Obsidian's own `Menu`: this case proves the
   * entries exist and that clicking one reaches the real plugin methods, not that the
   * menu's own pixels are ours.
   *
   * It normally runs right after the pause case, which leaves the shared vault running,
   * but it starts the host itself when that one failed or the case is run alone.
   */
  itMenu(
    "shows the sync state in the status bar and drives pause/resume and settings from its menu",
    async () => {
      await ensurePluginHostRunning(names.a);
      await waitForVaultState(async () => {
        const status = await readPluginStatus(names.a);
        return status.hosting && status.wsState === "connected";
      }, "vault A's sync host was not running before the status-bar case");

      // The account has a quota, so the storage row draws its bar. The suite's user starts
      // unlimited (no bar by design); this is the last case and the server is torn down after.
      await patchTestUser(server, { storageBytesLimit: 10 * 1024 * 1024 * 1024 });

      const bar = await readStatusBar(names.a);
      expect(bar).not.toBeNull();
      expect(bar!.inStatusBar).toBe(true);
      expect(bar!.state).toBe("syncing");
      expect(bar!.icon).toBe("refresh-cw");
      expect(bar!.label).toContain(t("status.state.syncing"));

      // 1. The real menu offers the state, the account rows, pause and settings.
      await waitForVaultState(
        () => clickStatusBarItem(names.a),
        "the status bar was not clickable",
      );
      await waitForVaultState(
        async () => (await readStatusMenu(names.a)).length > 0,
        "the status menu never opened",
      );
      const labels = await readStatusMenu(names.a);
      // The state is the icon's job; no row repeats "syncing".
      expect(labels).not.toContain(t("status.state.syncing"));
      // The row is the value, not "key expires: …"; the key icon names it.
      expect(labels).toContain(t("status.value.expiry.never"));
      // Storage is a bar plus `used/limit`, not a sentence.
      const storage = await readStatusMenuStorage(names.a);
      expect(storage).not.toBeNull();
      expect(storage!.text).toContain("/");
      expect(labels).toContain(t("settings.pause.pause"));
      expect(labels).toContain(t("status.menu.settings"));

      // 2. Pause from the menu: the host stops and the icon follows.
      await waitForVaultState(
        () => clickStatusMenuRow(names.a, t("settings.pause.pause")),
        "the status menu did not offer pause",
      );
      await waitForVaultState(
        async () => !(await readPluginStatus(names.a)).hosting,
        "the menu's pause never stopped the host",
      );
      await waitForVaultState(async () => {
        const paused = await readStatusBar(names.a);
        return paused?.state === "paused" && paused.icon === "pause";
      }, "the status bar never showed the paused state");

      // 3. Resume from the menu; the host comes back and the icon returns to syncing.
      await waitForVaultState(
        () => clickStatusBarItem(names.a),
        "the paused status bar was not clickable",
      );
      await waitForVaultState(
        async () => (await readStatusMenu(names.a)).includes(t("settings.pause.resume")),
        "the paused menu did not offer resume",
      );
      await waitForVaultState(
        () => clickStatusMenuRow(names.a, t("settings.pause.resume")),
        "the status menu did not offer resume",
      );
      await waitForVaultState(async () => {
        const status = await readPluginStatus(names.a);
        return status.hosting && status.wsState === "connected";
      }, "the menu's resume never restarted the host");
      await waitForVaultState(async () => {
        const synced = await readStatusBar(names.a);
        return synced?.state === "syncing";
      }, "the status bar never returned to syncing");

      // 4. The settings row opens Courier's own tab. Pin Settings in this window first: the
      //    real app uses a popout by default in 1.14.4, and a popout would steal focus.
      await keepSettingsInVaultWindow(names.a);
      await waitForVaultState(
        () => clickStatusBarItem(names.a),
        "the status bar was not clickable after resuming",
      );
      await waitForVaultState(
        async () => (await readStatusMenu(names.a)).includes(t("status.menu.settings")),
        "the resumed menu did not offer settings",
      );
      await waitForVaultState(
        () => clickStatusMenuRow(names.a, t("status.menu.settings")),
        "the status menu's settings row could not be pressed",
      );
      await waitForVaultState(
        async () => (await readPauseRow(names.a)) !== null,
        "the settings row never opened Courier's settings page",
      );
      await waitForVaultState(async () => {
        const usage = await readSettingsAccountUsage(names.a);
        return usage !== null && usage.expiry.includes(t("status.value.expiry.never"));
      }, "the settings page never finished reading the account usage");
      const settingsUsage = (await readSettingsAccountUsage(names.a))!;
      expect(settingsUsage.expiry).toContain(t("status.value.expiry.never"));
      expect(settingsUsage.storage).toContain("/");
      await restoreSettingsWindow(names.a);
    },
  );

  /**
   * The rendered half of the status bar: bar geometry, the menu's row typography and
   * the account-usage bars. These are measurements, so they run on the reference
   * platform only (see `layoutAssertionsEnabled`).
   */
  itL("measures the status bar, its menu and the account-usage bars", async () => {
    await ensurePluginHostRunning(names.a);
    await waitForVaultState(async () => {
      const status = await readPluginStatus(names.a);
      return status.hosting && status.wsState === "connected";
    }, "vault A's sync host was not running before the status-bar layout case");
    await patchTestUser(server, { storageBytesLimit: 10 * 1024 * 1024 * 1024 });

    const bar = await readStatusBar(names.a);
    expect(bar).not.toBeNull();
    expect(bar!.height).toBeGreaterThan(0);
    expect(bar!.width).toBeGreaterThan(0);

    // Keep Settings in the vault window before opening the menu: 1.14.4 would render it
    // in a popout and steal focus.
    await keepSettingsInVaultWindow(names.a);
    await waitForVaultState(() => clickStatusBarItem(names.a), "the status bar was not clickable");
    await waitForVaultState(
      async () => (await readStatusMenu(names.a)).length > 0,
      "the status menu never opened",
    );
    const storage = await readStatusMenuStorage(names.a);
    expect(storage).not.toBeNull();
    expect(storage!.hasFill).toBe(true);
    expect(storage!.barWidth).toBeGreaterThan(0);
    expect(storage!.fillWidth).toBeLessThanOrEqual(storage!.barWidth);

    // The placement contract: the status bar sits at the bottom of the window, so the
    // menu opens **above** the item with its right edge on the item's. A menu shown at
    // the mouse event instead hangs below the pointer, over the window's corner — which
    // is where Obsidian's native macOS menu put it.
    const placement = await readStatusMenuPlacement(names.a);
    expect(placement).not.toBeNull();
    expect(placement!.menu.bottom).toBeLessThanOrEqual(placement!.item.top + 3);
    expect(placement!.menu.bottom).toBeLessThan(placement!.item.bottom);
    expect(placement!.menu.right).toBeLessThanOrEqual(placement!.window.width);
    expect(Math.abs(placement!.menu.right - placement!.item.right)).toBeLessThanOrEqual(2);

    // The read-only rows above the separator must read like the actions below it: the
    // label style Obsidian gives them is larger and muted.
    const styles = await readStatusMenuStyles(names.a);
    const action = styles.find((row) => row.text === t("status.menu.settings"));
    expect(action).toBeDefined();
    for (const row of styles.filter(
      (entry) =>
        entry.text !== t("status.menu.settings") && entry.text !== t("settings.pause.pause"),
    )) {
      expect(row.fontSize, `font size of "${row.text}"`).toBe(action!.fontSize);
      expect(row.fontWeight, `font weight of "${row.text}"`).toBe(action!.fontWeight);
      expect(row.color, `colour of "${row.text}"`).toBe(action!.color);
    }

    await waitForVaultState(
      () => clickStatusMenuRow(names.a, t("status.menu.settings")),
      "the status menu's settings row could not be pressed",
    );
    await waitForVaultState(
      async () => (await readPauseRow(names.a)) !== null,
      "the settings row never opened Courier's settings page",
    );
    await waitForVaultState(async () => {
      const usage = await readSettingsAccountUsage(names.a);
      return usage !== null && usage.expiry.includes(t("status.value.expiry.never"));
    }, "the settings page never finished reading the account usage");
    const usage = (await readSettingsAccountUsage(names.a))!;
    expect(usage.storageOnOneLine).toBe(true);
    expect(usage.hasFill).toBe(true);
    expect(usage.barWidth).toBeGreaterThan(0);
    expect(usage.fillWidth).toBeLessThanOrEqual(usage.barWidth);
    await restoreSettingsWindow(names.a);
  });
});
