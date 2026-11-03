import { evalInVault, jsLiteral, vaultIsReachable } from "./cli";
import { waitForAsync } from "../harness/wait";
import { resolveObsidianLocale, setLocale, t } from "../../../plugin/src/i18n";
import {
  CONFLICT_ACTION_CLASS,
  VERSION_HISTORY_ACTION_CLASS,
} from "../../../plugin/src/ui/file-explorer-actions";
import type { FileTypeSync, SettingsSyncGroups } from "../../../engine/src/index";

/**
 * Read the running Obsidian's UI language and apply it to the plugin catalog in this
 * test process.
 *
 * The plugin inside Obsidian has its own module state and already resolved the language
 * in `onload`; this only makes the test's expected labels agree with what the app is
 * rendering. `document.documentElement.lang` is the value Obsidian sets from its UI
 * language (verified against 1.14.4); `window.moment.locale()` is the fallback, and
 * Chinese is the historical default when neither answers.
 */
export async function syncPluginLocale(vault: string): Promise<string> {
  let language = "zh";
  try {
    language = await evalInVault<string>(
      vault,
      `return (
        document.documentElement.lang ||
        (window.moment && window.moment.locale && window.moment.locale()) ||
        'zh'
      )`,
      20_000,
    );
  } catch {
    // Keep the historical Chinese default when the probe itself cannot run.
  }
  setLocale(resolveObsidianLocale(language));
  return language;
}

/** Directory part of a vault path (`""` when the file sits at the vault root). */
function parentDir(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Create the folder chain for a vault-relative path inside a vault, outermost
 * first and guarded step by step: `app.vault.create` is not documented to create
 * missing parents, and `createFolder` throws when the folder already exists.
 * Only **files** emit the events the plugin listens to, so preparing folders
 * does not disturb sync.
 */
export async function ensureFolderInVault(vault: string, path: string): Promise<void> {
  if (!path) return;
  await evalInVault(
    vault,
    `
    const segments = ${jsLiteral(path)}.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = current ? current + '/' + segment : segment;
      if (app.vault.getFolderByPath(current)) continue;
      await app.vault.createFolder(current);
    }
    return current;
    `,
    60_000,
  );
}

/**
 * Delete a folder through Obsidian's data adapter.
 *
 * Deliberately not `app.vault.delete(TFolder)`: that drops the folder from the
 * vault index while leaving the directory on disk, and the next access fails with
 * `EISDIR: rm returned EISDIR` — which is how the nested-path probes used to
 * leave unremovable leftovers behind. `adapter.rmdir(..., true)` removes the
 * directory itself.
 */
export async function removeFolderInVault(vault: string, path: string): Promise<void> {
  await evalInVault(
    vault,
    `
    if (!app.vault.getFolderByPath(${jsLiteral(path)})) return false;
    await app.vault.adapter.rmdir(${jsLiteral(path)}, true);
    return true;
    `,
    60_000,
  );
}

/**
 * Control the **real** Courier plugin running inside a real Obsidian vault, and
 * mutate that vault, by evaluating code in the vault's renderer through the
 * Obsidian CLI.
 *
 * Every write goes through `app.vault.*`, i.e. Obsidian's own file layer, so the
 * vault events the plugin listens to are the genuine ones — not a fake emitter.
 *
 * Everything here is async: the test server shares the suite's process, so
 * blocking it would deadlock the very requests the evaluated code awaits.
 */

export interface PluginHostSetup {
  /** Base URL of the running sync server, e.g. `http://127.0.0.1:52341`. */
  serverUrl: string;
  userKey: string;
  vaultId: string;
  vaultName: string;
  /** Base64 vault salt; the password is only used to derive the AES key locally. */
  encryptionSalt: string;
  password: string;
  deviceName: string;
}

export interface PluginHostStatus {
  /** The label this vault's plugin states on its pushes (no identity is registered). */
  deviceName: string;
  hosting: boolean;
  wsState: string;
  /** The plugin's persisted pause flag (a paused host is intentionally not hosting). */
  syncPaused: boolean;
}

export interface PluginHostOptions {
  /**
   * Clear the persisted per-file sync state before starting. `true` (default)
   * gives a clean binder; `false` keeps the previous run's state, which is what
   * makes a deterministic offline-conflict scenario possible.
   */
  resetSyncState?: boolean;
  /**
   * Which config-folder groups this real vault syncs. Omitted (or `{}`) means
   * notes only, exactly like a freshly installed plugin.
   */
  settingsGroups?: Partial<SettingsSyncGroups>;
  /**
   * Which vault file types this real vault syncs. Omitted means the defaults the engine
   * ships with (images/audio/video/PDF on, every other type off).
   */
  fileTypes?: Partial<FileTypeSync>;
  /**
   * Vault folders this real vault leaves out of sync entirely (default: none).
   * Device-local, exactly like the plugin's own switches.
   */
  excludedFolders?: readonly string[];
}

/**
 * Point the plugin at the test server, derive the vault key in the renderer and
 * start the sync host.
 *
 * This deliberately skips the password dialog: the flow under test is syncing,
 * and the dialog itself is covered by `plugin.e2e.test.ts`. Everything after the
 * dialog — `saveSettings()`, key derivation, the device-local credential that
 * makes the next start silent, `startHost()`, device registration, `EngineHost`
 * doing `initialSync()` over real `requestUrl` — is the real code.
 */
export async function configurePluginHost(
  vault: string,
  setup: PluginHostSetup,
  options: PluginHostOptions = {},
): Promise<PluginHostStatus> {
  const resetSyncState = options.resetSyncState ?? true;
  const body = `
    const p = app.plugins.plugins.courier;
    if (!p) throw new Error('the courier plugin is not loaded in this vault');
    p.host && p.host.stop();
    const enc = new TextEncoder();
    const saltBytes = Uint8Array.from(atob(${jsLiteral(setup.encryptionSalt)}), (c) => c.charCodeAt(0));
    const material = await crypto.subtle.importKey('raw', enc.encode(${jsLiteral(setup.password)}), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: 600000, hash: 'SHA-256' },
      material, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    p.settings.serverUrl = ${jsLiteral(setup.serverUrl)};
    p.settings.userKey = ${jsLiteral(setup.userKey)};
    // The settings page names the account the key belongs to, which the plugin learns
    // from the account read at sign-in — do the same read, so the page this harness
    // leaves behind is the page a real sign-in leaves behind.
    p.settings.userName = (await p.actions.getMe()).name;
    p.settings.deviceName = ${jsLiteral(setup.deviceName)};
    // The setup dialog stores the label and folder scope per remote vault; this harness
    // bypasses the dialog, so it writes the same record the dialog would.
    p.settings.vaultConnections = p.settings.vaultConnections || {};
    p.settings.vaultConnections[${jsLiteral(setup.vaultId)}] = {
      deviceName: ${jsLiteral(setup.deviceName)},
      excludedFolders: JSON.parse(${jsLiteral(
        JSON.stringify((options.excludedFolders ?? []).slice()),
      )}),
    };
    p.settings.connectedVaultId = ${jsLiteral(setup.vaultId)};
    p.settings.connectedVaultName = ${jsLiteral(setup.vaultName)};
    p.settings.encryptionSalt = ${jsLiteral(setup.encryptionSalt)};
    // A connection always starts syncing, exactly like \`bindVault()\`: a flag left over
    // from an earlier pause describes the binding that is being replaced.
    p.settings.syncPaused = false;
    p.settings.settingsGroups = JSON.parse(${jsLiteral(
      JSON.stringify(options.settingsGroups ?? {}),
    )});
    ${
      options.fileTypes === undefined
        ? ""
        : `p.settings.fileTypes = JSON.parse(${jsLiteral(JSON.stringify(options.fileTypes))});`
    }
    ${
      options.excludedFolders === undefined
        ? ""
        : `p.settings.excludedFolders = JSON.parse(${jsLiteral(
            JSON.stringify(options.excludedFolders),
          )});`
    }
    ${resetSyncState ? "p.settings.syncState = undefined;" : ""}
    await p.saveSettings();
    // Mirror an unlock-with-remember: keep the derived key on this device, so
    // reloading the plugin (= reopening Obsidian) resumes without a dialog.
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    let binary = '';
    for (let i = 0; i < raw.length; i += 0x8000) binary += String.fromCharCode(...raw.subarray(i, i + 0x8000));
    app.saveLocalStorage('courier-vault-credential', {
      vaultId: ${jsLiteral(setup.vaultId)},
      encryptionKeyB64: btoa(binary),
    });
    p.encryptionKey = key;
    await p.startHost();
    return {
      deviceName: p.settings.deviceName,
      hosting: !!p.host,
      wsState: p.wsState,
      syncPaused: p.settings.syncPaused,
    };
  `;
  return await evalInVault<PluginHostStatus>(vault, body, 180_000);
}

/**
 * Stop the sync host but keep the vault binding and the persisted sync state.
 *
 * This models "Obsidian was closed" — the engine's last-known versionIds and
 * paths survive, so restarting with {@link configurePluginHost} and
 * `resetSyncState: false` reproduces a genuine offline divergence rather than a
 * fresh binder.
 */
export async function pausePluginHost(vault: string): Promise<void> {
  await evalInVault(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p) return null;
    p.host && p.host.stop();
    p.host = null;
    return true;
    `,
    60_000,
  );
}

/**
 * Make sure a vault's plugin host is running before a case that only measures the UI.
 *
 * A case that starts from "the host the previous case left running" fails for an
 * unrelated reason when run alone or after an earlier failure. This brings the host back
 * the way the settings page's 继续同步 does, without re-deriving the vault key or resetting
 * the sync state (which {@link configurePluginHost} would do).
 */
export async function ensurePluginHostRunning(vault: string): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p) return false;
    if (p.host) return true;
    if (p.settings.syncPaused) await p.resumeSync();
    else await p.startHost();
    return !!p.host;
    `,
    180_000,
  );
}

/** Stop the sync host and forget the vault binding (leaves the plugin enabled). */
export async function stopPluginHost(vault: string): Promise<void> {
  await evalInVault(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p) return null;
    p.host && p.host.stop();
    p.host = null;
    p.settings.connectedVaultId = null;
    p.settings.connectedVaultName = null;
    p.settings.encryptionSalt = null;
    p.settings.syncState = undefined;
    await p.saveSettings();
    return true;
    `,
    60_000,
  );
}

/**
 * The vault's absolute path on disk, as Obsidian sees it.
 *
 * The suite uses it to snapshot and restore the plugin's `data.json` **as a
 * file**, rather than round-tripping settings through `eval`: the engine writes
 * that file from several places, so a byte-for-byte restore after the host is
 * stopped is the only version that cannot race.
 */
export async function vaultBasePath(vault: string): Promise<string> {
  return await evalInVault<string>(vault, `return app.vault.adapter.getBasePath();`, 60_000);
}

/** Live plugin state, read from the running instance. */ export async function readPluginStatus(
  vault: string,
): Promise<PluginHostStatus> {
  return await evalInVault(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p) throw new Error('the courier plugin is not loaded in this vault');
    return {
      deviceName: p.settings.deviceName,
      hosting: !!p.host,
      wsState: p.wsState,
      syncPaused: p.settings.syncPaused,
    };
    `,
    60_000,
  );
}

/** The live status-bar icon, as the app rendered it. */
export interface StatusBarReading {
  state: string | null;
  icon: string | null;
  label: string | null;
  inStatusBar: boolean;
  width: number;
  height: number;
}

/**
 * Read the plugin's status-bar item from the real app.
 *
 * `inStatusBar` and the non-zero box are the geometry assertions the L3 layer owns: a
 * styled icon in the DOM but outside Obsidian's status bar (or collapsed to 0×0) is not
 * the feature the user asked for. `state` and `icon` are the plugin's own data attributes,
 * so the assertion does not depend on icon markup or localization.
 */
export async function readStatusBar(vault: string): Promise<StatusBarReading | null> {
  return await evalInVault<StatusBarReading | null>(
    vault,
    `
    const el = document.querySelector('.courier-status-bar');
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return {
      state: el.getAttribute('data-courier-status'),
      icon: el.getAttribute('data-courier-icon'),
      label: el.getAttribute('aria-label'),
      inStatusBar: !!el.closest('.status-bar'),
      width: Math.round(box.width),
      height: Math.round(box.height),
    };
    `,
    60_000,
  );
}

/**
 * Dispatch a click on the status-bar item.
 *
 * A real `MouseEvent` rather than `el.click()`: it carries coordinates and `isTrusted`
 * is false either way, so this is the path a synthetic click takes in the app. The menu
 * is anchored to the status bar (not the pointer), which is what
 * {@link readStatusMenuPlacement} measures. Returns `false` while the item has not
 * rendered, so the test waits instead of polling here.
 */
export async function clickStatusBarItem(vault: string): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const el = document.querySelector('.courier-status-bar');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: 24,
      clientY: 24,
    }));
    return true;
    `,
    60_000,
  );
}

/**
 * Run `source` in whichever window currently holds an open menu.
 *
 * Obsidian 1.14 on macOS renders a `Menu` in its own `BrowserWindow`, so the vault
 * window's document does not contain it; older builds — and Windows/Linux CI — render it
 * in the vault document itself. `executeJavaScript` runs the same source in every window,
 * which covers both, and the fallback is returned when no window has a non-empty answer.
 */
async function inMenuWindow<T>(vault: string, source: string, fallback: T): Promise<T> {
  return await evalInVault<T>(
    vault,
    `
    const remote = require('@electron/remote');
    const source = ${JSON.stringify(source)};
    for (const win of remote.BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try {
        const value = await win.webContents.executeJavaScript(source);
        const empty = Array.isArray(value) ? value.length === 0 : !value;
        if (!empty) return value;
      } catch (err) {
        // A window without a page (devtools, splash) cannot answer; keep looking.
      }
    }
    return ${JSON.stringify(fallback)};
    `,
    60_000,
  );
}

/** The labels of the currently open menu, in render order. */
export async function readStatusMenu(vault: string): Promise<string[]> {
  return await inMenuWindow<string[]>(
    vault,
    "Array.from(document.querySelectorAll('.menu .menu-item')).map((el) => (el.textContent || '').trim()).filter(Boolean)",
    [],
  );
}

/** Where the open status menu and the item it belongs to sit, in the window's pixels. */
export interface StatusMenuPlacement {
  item: { left: number; top: number; right: number; bottom: number };
  menu: { left: number; top: number; right: number; bottom: number };
  window: { width: number; height: number };
}

/**
 * Measure the open status menu against its item.
 *
 * This is the placement contract the DOM menu gives us: the status bar is at the bottom
 * of the window, so the menu opens **above** the item and its right edge lands on the
 * item's (Obsidian's `width` + `overlap` anchor form). A menu shown at the mouse event
 * instead — which is what the native macOS menu did — hangs below the pointer, over the
 * window's corner, and fails both readings.
 */
export async function readStatusMenuPlacement(vault: string): Promise<StatusMenuPlacement | null> {
  return await inMenuWindow<StatusMenuPlacement | null>(
    vault,
    `(function () {
    const item = document.querySelector('.courier-status-bar');
    const menu = document.querySelector('.menu');
    if (!item || !menu) return null;
    const i = item.getBoundingClientRect();
    const m = menu.getBoundingClientRect();
    return {
      item: { left: i.left, top: i.top, right: i.right, bottom: i.bottom },
      menu: { left: m.left, top: m.top, right: m.right, bottom: m.bottom },
      window: { width: innerWidth, height: innerHeight },
    };
    })()`,
    null,
  );
}

/** One menu row's rendered text style, read from the real app. */
export interface StatusMenuTextStyle {
  text: string;
  fontSize: string;
  fontWeight: string;
  color: string;
}

/**
 * The rendered text style of every row in the open status menu.
 *
 * Read from the element that actually holds the text, not always the title wrapper: the
 * read-only rows carry a plugin span so their typography can match the actionable rows
 * below the separator.
 */
export async function readStatusMenuStyles(vault: string): Promise<StatusMenuTextStyle[]> {
  return await inMenuWindow<StatusMenuTextStyle[]>(
    vault,
    "Array.from(document.querySelectorAll('.menu .menu-item')).map((item) => { const title = item.querySelector('.menu-item-title'); if (!title) return null; const target = title.querySelector('.courier-status-menu-row, .courier-storage-usage-value') || title; const style = getComputedStyle(target); return { text: (target.textContent || '').trim(), fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color }; }).filter(Boolean)",
    [],
  );
}

/** The storage row's quota bar and value, read from the open menu. */
export interface StatusMenuStorage {
  text: string;
  barWidth: number;
  fillWidth: number;
  hasFill: boolean;
}

/**
 * Read the storage row's progress bar from the real menu.
 *
 * This is the part of the row a text assertion cannot see: the menu carries a
 * `DocumentFragment` with a real track and fill, and a class-only assertion would pass even
 * if the bar rendered at zero width or outside the menu.
 */
export async function readStatusMenuStorage(vault: string): Promise<StatusMenuStorage | null> {
  return await inMenuWindow<StatusMenuStorage | null>(
    vault,
    "(function () { const root = document.querySelector('.courier-status-menu-storage'); if (!root) return null; const bar = root.querySelector('.courier-storage-usage-bar'); const fill = root.querySelector('.courier-storage-usage-fill'); const value = root.querySelector('.courier-storage-usage-value'); const barBox = bar ? bar.getBoundingClientRect() : null; const fillBox = fill ? fill.getBoundingClientRect() : null; return { text: value ? (value.textContent || '').trim() : '', barWidth: barBox ? barBox.width : 0, fillWidth: fillBox ? fillBox.width : 0, hasFill: !!fill }; })()",
    null,
  );
}

/** Press one entry of the currently open menu by its exact label. */
export async function clickStatusMenuRow(vault: string, label: string): Promise<boolean> {
  return await inMenuWindow<boolean>(
    vault,
    `(function () { const wanted = ${JSON.stringify(label)}; const item = Array.from(document.querySelectorAll('.menu .menu-item')).find((el) => (el.textContent || '').trim() === wanted); if (!item) return false; item.click(); return true; })()`,
    false,
  );
}

// ── The config folder (Obsidian's data adapter) ──

/**
 * Read a file inside the vault's config folder.
 *
 * Deliberately through `app.vault.adapter` and not `app.vault.read`: Obsidian
 * keeps the config folder out of its file index, so `.obsidian/app.json` is not
 * a `TFile` and the vault API cannot see it — the same reason the plugin's own
 * adapter has to reach for the data adapter to sync these files at all.
 */
export async function readConfigFileInVault(vault: string, path: string): Promise<string | null> {
  return await evalInVault<string | null>(
    vault,
    `
    if (!(await app.vault.adapter.exists(${jsLiteral(path)}))) return null;
    return await app.vault.adapter.read(${jsLiteral(path)});
    `,
    60_000,
  );
}

/**
 * Write a file inside the config folder, through the data adapter.
 *
 * This is how Obsidian itself writes its settings, and it matters that the write
 * goes through here: the data adapter fires **no vault event**, so the plugin
 * cannot learn about the change from an event — only from its settings poll.
 */
export async function writeConfigFileInVault(
  vault: string,
  path: string,
  content: string,
): Promise<void> {
  await evalInVault(
    vault,
    `
    const segments = ${jsLiteral(path)}.split('/').slice(0, -1).filter(Boolean);
    let current = '';
    for (const segment of segments) {
      current = current ? current + '/' + segment : segment;
      if (!(await app.vault.adapter.exists(current))) await app.vault.adapter.mkdir(current);
    }
    await app.vault.adapter.write(${jsLiteral(path)}, ${jsLiteral(content)});
    return true;
    `,
    60_000,
  );
}

/** Delete a file inside the config folder (best-effort; missing is not an error). */
export async function removeConfigFileInVault(vault: string, path: string): Promise<void> {
  await evalInVault(
    vault,
    `
    if (await app.vault.adapter.exists(${jsLiteral(path)})) await app.vault.adapter.remove(${jsLiteral(path)});
    return true;
    `,
    60_000,
  );
}

/**
 * Delete a folder inside the config folder, files and all.
 *
 * Through the **data adapter**, not `Vault.delete`: the config folder is outside the vault
 * index, so `getAbstractFileByPath` answers null for a folder under it and the vault API
 * cannot remove one — a probe folder deleted that way survives the run and shows up in the
 * next one.
 */
export async function removeConfigFolderInVault(vault: string, dir: string): Promise<void> {
  await evalInVault(
    vault,
    `
    if (await app.vault.adapter.exists(${jsLiteral(dir)})) await app.vault.adapter.rmdir(${jsLiteral(dir)}, true);
    return true;
    `,
    60_000,
  );
}

/** Files directly inside a config folder (`[]` when the folder does not exist). */
export async function listConfigFolderInVault(vault: string, dir: string): Promise<string[]> {
  return await evalInVault<string[]>(
    vault,
    `
    if (!(await app.vault.adapter.exists(${jsLiteral(dir)}))) return [];
    return (await app.vault.adapter.list(${jsLiteral(dir)})).files;
    `,
    60_000,
  );
}

/**
 * Run the host's settings pass now.
 *
 * The host polls on its own timer (three seconds in the plugin — the config folder fires no
 * vault event), which is a long time to wait inside a test; this is the same call the timer
 * makes.
 */
export async function runSettingsPass(vault: string): Promise<void> {
  await evalInVault(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p || !p.host) throw new Error('the courier host is not running');
    await p.host.engine.syncLocalSettings();
    return true;
    `,
    60_000,
  );
}

/** The engine's fileId for a path, or null when it does not track the file. */
export async function fileIdForPath(vault: string, path: string): Promise<string | null> {
  return await evalInVault<string | null>(
    vault,
    `
    const p = app.plugins.plugins.courier;
    const engine = p && p.host ? p.host.engine : null;
    if (!engine) return null;
    return engine.fileIdForPath(${jsLiteral(path)});
    `,
    60_000,
  );
}

/**
 * The class string on a **folder or file** row in the real file explorer.
 *
 * The explorer row is the only place the dimming preference is visible, so this is how the
 * L3 case proves the decoration reached the app's own tree rather than only the plugin's
 * data. An empty string means the row is not in the explorer (yet, or because its parent
 * is collapsed); a missing class on an existing row is what "not dimmed" looks like.
 */
export async function readFileExplorerRowClass(vault: string, path: string): Promise<string> {
  return await evalInVault<string>(
    vault,
    `
    const row = document.querySelector(
      '.nav-folder-title[data-path="' + ${jsLiteral(path)} + '"], .nav-file-title[data-path="' + ${jsLiteral(path)} + '"]'
    );
    return row ? row.className : "";
    `,
    60_000,
  );
}

/**
 * The Courier action chips on one **file** row in the real file explorer, by class name.
 *
 * The chips are the desktop entry point, and the exclusion rule is only visible in the
 * app's own tree: a file under an excluded folder must carry none, whatever its name looks
 * like. An empty array means "no chip" — including a row that is not in the explorer (yet,
 * or because its folder is collapsed), which is why a caller asserts on an expanded folder
 * and checks the in-scope row separately.
 */
export async function readFileExplorerRowChips(vault: string, path: string): Promise<string[]> {
  return await evalInVault<string[]>(
    vault,
    `
    const row = document.querySelector('.nav-file-title[data-path="' + ${jsLiteral(path)} + '"]');
    if (!row) return [];
    return Array.from(
      row.querySelectorAll('.${CONFLICT_ACTION_CLASS}, .${VERSION_HISTORY_ACTION_CLASS}')
    ).map((el) => el.className);
    `,
    60_000,
  );
}

/**
 * The titles the app's `file-menu` handler contributes to one file's menu.
 *
 * This is the **mobile** entry point — a phone has no hover, so the long-press menu is the
 * only way to reach an action. Obsidian builds that menu through a `Menu` instance the
 * caller supplies, so this hands the event a chainable stand-in and triggers the app's own
 * `file-menu` event: every registered handler runs (core plugins included, which is why a
 * caller asserts on Courier's own titles rather than on the whole list), and nothing is
 * drawn — no pointer, no layout, no invoker.
 */
export async function readFileMenuTitles(vault: string, path: string): Promise<string[]> {
  return await evalInVault<string[]>(
    vault,
    `
    const file = app.vault.getAbstractFileByPath(${jsLiteral(path)});
    if (!file) throw new Error('no vault file at ' + ${jsLiteral(path)});
    const items = [];
    const makeItem = (record) => {
      const api = new Proxy(record, {
        get(target, key) {
          if (key === 'title') return target.title;
          if (key === 'setTitle') return (value) => { target.title = value; return api; };
          if (key === 'onClick') return (fn) => { target.onClick = fn; return api; };
          return () => api;
        },
      });
      return api;
    };
    const menu = new Proxy({}, {
      get(target, key) {
        if (key === 'addItem') return (build) => {
          const record = { title: '' };
          const item = makeItem(record);
          build(item);
          items.push(record);
          return item;
        };
        return () => menu;
      },
    });
    app.workspace.trigger('file-menu', menu, file);
    return items.map((item) => item.title);
    `,
    60_000,
  );
}

/**
 * Turn Obsidian's own **mobile emulation** on or off for one vault.
 *
 * `app.emulateMobile` is what the app's dev tools use; it is not in the public typings, it
 * stores a flag and reloads the window. The reload is the point: the plugin's `onload` runs
 * again with `Platform.isDesktop` false, which is the condition of a real phone rather than
 * a flag poked from outside the app.
 *
 * The toggle call can lose its answer to the reload it triggers, and the app is only usable
 * again once the window is back — so the mode is confirmed rather than assumed: the helper
 * waits until the vault answers, reports the requested `app.isMobile`, and has the plugin
 * loaded. A caller must turn it back off: every later case in the suite expects a desktop
 * app.
 */
export async function setMobileEmulation(vault: string, enabled: boolean): Promise<void> {
  try {
    await evalInVault<boolean>(
      vault,
      `app.emulateMobile(${enabled ? "true" : "false"}); return true;`,
      30_000,
    );
  } catch {
    // Expected half the time: the eval's answer races the navigation it caused. What the
    // app settles in is checked below, so a lost answer is not a lost toggle.
  }
  await waitForAsync(
    async () => {
      if (!(await vaultIsReachable(vault))) return false;
      try {
        return await evalInVault<boolean>(
          vault,
          `return app.isMobile === ${enabled ? "true" : "false"} && !!app.plugins.plugins.courier;`,
          20_000,
        );
      } catch {
        // Mid-reload: the next poll asks again.
        return false;
      }
    },
    `Obsidian did not settle in ${enabled ? "mobile" : "desktop"} mode with the plugin loaded`,
    120_000,
  );
}

/**
 * Click an excluded folder open in the real file explorer, so its rows exist in the DOM.
 *
 * A collapsed folder has no file rows: every rendered-row assertion (dimming, chips) needs
 * this first. Clicking the title is what a person does, and the app's own tree handles it.
 *
 * The row is awaited first: a folder recreated by a write appears in the tree on the app's
 * own schedule, and clicking a title that is not there yet would silently do nothing.
 */
export async function expandFileExplorerFolder(vault: string, path: string): Promise<void> {
  await waitForAsync(
    async () => {
      try {
        return await evalInVault<boolean>(
          vault,
          `return !!document.querySelector('.nav-folder-title[data-path="' + ${jsLiteral(path)} + '"]');`,
          20_000,
        );
      } catch {
        return false;
      }
    },
    `the file explorer never showed a row for ${path}`,
    60_000,
  );
  await evalInVault<boolean>(
    vault,
    `
    const title = document.querySelector(
      '.nav-folder-title[data-path="' + ${jsLiteral(path)} + '"]'
    );
    const folder = title && title.closest('.nav-folder');
    if (title && folder && folder.classList.contains('is-collapsed')) title.click();
    return true;
    `,
    60_000,
  );
}

/**
 * Apply an excluded-folder list through the plugin's own write path.
 *
 * `CourierPlugin.setExcludedFolders` is what the settings dialog calls: it saves, restarts
 * the host so the scope is read again, and re-decorates the explorer. Using it in a case
 * (rather than changing `settings` under a running plugin) is what makes the change a real
 * one, including the row updates the plugin does itself.
 */
export async function setExcludedFoldersInVault(
  vault: string,
  folders: readonly string[],
): Promise<void> {
  await evalInVault<boolean>(
    vault,
    `
    const p = app.plugins.plugins.courier;
    await p.setExcludedFolders(JSON.parse(${jsLiteral(JSON.stringify(folders.slice()))}));
    return true;
    `,
    120_000,
  );
}

/**
 * The document the recycle-bin dialogs live in, as an expression the eval bodies inline.
 *
 * The suite keeps Settings in the vault window (see {@link keepSettingsInVaultWindow}), so
 * a dialog opened from its rows is created in this document. The document is still
 * remembered at click time: a popout left open by a hand-run Obsidian would put the dialog
 * in *that* window's document, and an eval body runs in the vault window, so a query
 * against its own `document` would find nothing.
 */
const DIALOG_DOC_EXPR = `(window.__courierE2eDialogDoc || (activeWindow && activeWindow.document) || document)`;

/** The dialog on top of the stack, within {@link DIALOG_DOC_EXPR}. */
const DIALOG_EXPR = `(() => {
      const containers = Array.from(${DIALOG_DOC_EXPR}.querySelectorAll('.modal-container'));
      return containers.length > 0 ? containers[containers.length - 1] : null;
    })()`;

/**
 * Fails the eval when `app.setting.open()` still produced a popout window.
 *
 * A future Obsidian build that stops honouring the pinned `shouldUsePopout()` would
 * otherwise focus a window again and turn the whole suite into a foreground activity;
 * failing the case names the broken assumption instead.
 */
const SETTINGS_IN_WINDOW_ASSERTION = `if (app.setting.isInPopoutWindow && app.setting.isInPopoutWindow()) {
      throw new Error('Settings opened in a popout window — the e2e harness must keep it in the vault window so the app is not raised');
    }`;

/**
 * Keep Obsidian's Settings modal in this vault window, so opening it never raises the app.
 *
 * 1.14.4 renders Settings in a **popout window** by default (`shouldUsePopout()` reads the
 * vault's `settingsPopoutWindow`), and every `app.setting.open()` on an existing popout
 * calls `this.popout.win.electronWindow.focus()`. That is what used to pull Obsidian to the
 * front mid-run. The same Settings modal renders inside the current window when the popout
 * is refused — its base `Modal.open()` only touches the DOM — so the choice is pinned here
 * once per renderer. An already-open popout takes its `focus()` branch before that check,
 * hence the `close()` first (which sets `popout = null`).
 *
 * {@link restoreSettingsWindow} puts the original method back in teardown.
 */
export async function keepSettingsInVaultWindow(vault: string): Promise<void> {
  await evalInVault(
    vault,
    `
    const setting = app.setting;
    if (setting.__courierE2eInWindow) return true;
    setting.__courierE2eInWindow = true;
    setting.__courierE2eShouldUsePopout = setting.shouldUsePopout;
    setting.shouldUsePopout = () => false;
    setting.close();
    return true;
    `,
    30_000,
  );
}

/**
 * Undo {@link keepSettingsInVaultWindow}: close the in-window Settings modal and put the
 * app's own popout decision back, so the vault behaves as it did before the run.
 */
export async function restoreSettingsWindow(vault: string): Promise<void> {
  await evalInVault(
    vault,
    `
    const setting = app.setting;
    if (!setting.__courierE2eInWindow) return false;
    setting.close();
    setting.shouldUsePopout = setting.__courierE2eShouldUsePopout;
    delete setting.__courierE2eInWindow;
    delete setting.__courierE2eShouldUsePopout;
    return true;
    `,
    30_000,
  );
}

/**
 * Open the plugin's recycle bin — the settings page's 回收站 row, whose 「查看」 button
 * opens the dialog — and leave it on screen.
 *
 * This is the whole entry point: the recycle bin has no ribbon icon and no sidebar view
 * any more, so driving the settings page is what proves a user can still reach it.
 *
 * Returns `false` while the settings tab has not rendered its row yet, so the **test** is
 * the one that waits (`waitForVaultState`): polling inside the eval would need
 * `window.sleep`, and Obsidian's window is in the background during a run, where Chromium
 * throttles a 50 ms timer to about once a minute — which is how a ten-second inner loop
 * turned into a 60-second CLI timeout.
 */
export async function openRecycleBinDialog(vault: string): Promise<boolean> {
  await keepSettingsInVaultWindow(vault);
  return await evalInVault<boolean>(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p) throw new Error('the Courier plugin is not loaded');
    app.setting.open();
    app.setting.openTabById(p.manifest.id);
    // The page is drawn from the definitions it cached when the tab was added; the harness
    // changes the plugin state outside its own actions, so it asks for a re-render the way
    // the plugin does on every user action.
    if (p.settingTab && p.settingTab.update) p.settingTab.update();
    ${SETTINGS_IN_WINDOW_ASSERTION}
    // The settings page renders in this window, and everything it opens stays here.
    const doc = (activeWindow && activeWindow.document) || document;
    window.__courierE2eDialogDoc = doc;
    for (const row of doc.querySelectorAll('.modal.mod-settings .setting-item')) {
      const name = row.querySelector('.setting-item-name');
      if (!name || (name.textContent || '').trim() !== ${jsLiteral(t("settings.recycleBin.name"))}) continue;
      const button = Array.from(row.querySelectorAll('button')).find(
        (candidate) => (candidate.textContent || '').trim() === ${jsLiteral(t("settings.recycleBin.view"))},
      );
      if (!button) return false;
      button.click();
      return true;
    }
    return false;
    `,
    60_000,
  );
}

/**
 * Open the plugin's sync history — the settings page's 同步历史 row, whose 「查看」 button
 * opens the dialog — and leave it on screen.
 *
 * The same entry point and the same document bookkeeping as {@link openRecycleBinDialog}:
 * the suite keeps Settings in this window ({@link keepSettingsInVaultWindow}), so the
 * dialog is created in this document, and the document is remembered when the row is
 * clicked.
 *
 * Returns `false` while the row has not rendered, so the **test** waits rather than the
 * eval (a background window throttles timers).
 */
export async function openSyncHistoryDialog(vault: string): Promise<boolean> {
  await keepSettingsInVaultWindow(vault);
  return await evalInVault<boolean>(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p) throw new Error('the Courier plugin is not loaded');
    app.setting.open();
    app.setting.openTabById(p.manifest.id);
    // The page is drawn from the definitions it cached when the tab was added; the harness
    // changes the plugin state outside its own actions, so it asks for a re-render the way
    // the plugin does on every user action.
    if (p.settingTab && p.settingTab.update) p.settingTab.update();
    ${SETTINGS_IN_WINDOW_ASSERTION}
    const doc = (activeWindow && activeWindow.document) || document;
    window.__courierE2eDialogDoc = doc;
    for (const row of doc.querySelectorAll('.modal.mod-settings .setting-item')) {
      const name = row.querySelector('.setting-item-name');
      if (!name || (name.textContent || '').trim() !== ${jsLiteral(t("settings.history.name"))}) continue;
      const button = Array.from(row.querySelectorAll('button')).find(
        (candidate) => (candidate.textContent || '').trim() === ${jsLiteral(t("settings.history.view"))},
      );
      if (!button) return false;
      button.click();
      return true;
    }
    return false;
    `,
    60_000,
  );
}

/**
 * The sync-history dialog as a user reads it: the header's count and note, the day
 * groups, one entry per row with the direction arrow's own class, and the computed
 * style of the list region.
 *
 * Read from the real DOM because the things this feature is — the count actually showing
 * a number, the day headers, the direction marks and a list that scrolls inside a fixed
 * dialog — are exactly the things a stub cannot tell you are on screen. `direction` comes
 * from the class the row carries (`is-out` / `is-in`), which is also what colours it;
 * `skipped` and `outcome` are the frozen "not applied / not sent" decision; the list style
 * is here because only a real browser applies `styles.css`.
 */
export async function readSyncHistoryDialog(vault: string): Promise<{
  open: boolean;
  title: string;
  count: string;
  countLabel: string;
  note: string;
  days: string[];
  listStyle: { overflowY: string; maxHeight: string; minHeight: string } | null;
  rows: Array<{
    path: string;
    action: string;
    meta: string;
    direction: string;
    icon: string | null;
    skipped: boolean;
    outcome: string;
  }>;
}> {
  return await evalInVault<{
    open: boolean;
    title: string;
    count: string;
    countLabel: string;
    note: string;
    days: string[];
    listStyle: { overflowY: string; maxHeight: string; minHeight: string } | null;
    rows: Array<{
      path: string;
      action: string;
      meta: string;
      direction: string;
      icon: string | null;
      skipped: boolean;
      outcome: string;
    }>;
  }>(
    vault,
    `
    const container = ${DIALOG_EXPR};
    const empty = {
      open: false,
      title: '',
      count: '',
      countLabel: '',
      note: '',
      days: [],
      listStyle: null,
      rows: [],
    };
    if (!container) return empty;
    const text = (element) => (element && element.textContent ? element.textContent.trim() : '');
    const list = container.querySelector('.courier-history-list');
    const style = list ? getComputedStyle(list) : null;
    const rows = [];
    for (const row of container.querySelectorAll('.courier-history-row')) {
      const arrow = row.querySelector('.courier-history-arrow');
      const svg = arrow ? arrow.querySelector('svg') : null;
      rows.push({
        path: text(row.querySelector('.courier-history-path')),
        action: text(row.querySelector('.courier-history-action')),
        meta: text(row.querySelector('.courier-history-meta')),
        direction: arrow ? (arrow.classList.contains('is-out') ? 'out' : 'in') : '',
        // Obsidian renders the icon as a Lucide svg with a class like lucide-arrow-up.
        icon: svg ? svg.getAttribute('class') : null,
        skipped: row.classList.contains('is-skipped'),
        outcome: text(row.querySelector('.courier-history-outcome')),
      });
    }
    return {
      open: true,
      title: text(container.querySelector('.modal-title')),
      count: text(container.querySelector('.courier-history-count')),
      countLabel: text(container.querySelector('.courier-history-count-label')),
      note: text(container.querySelector('.courier-history-note')),
      days: Array.from(container.querySelectorAll('.courier-history-day-title')).map((day) => text(day)),
      listStyle: style
        ? { overflowY: style.overflowY, maxHeight: style.maxHeight, minHeight: style.minHeight }
        : null,
      rows: rows,
    };
    `,
    60_000,
  );
}

/**
 * The document the plugin's settings page lives in, remembered when its tab is opened.
 *
 * Like {@link DIALOG_DOC_EXPR}: the suite keeps Settings in the vault window
 * ({@link keepSettingsInVaultWindow}), but the document is remembered at open time so a
 * popout that was already up is read from wherever it actually rendered.
 */
const SETTINGS_DOC_EXPR = `(window.__courierE2eSettingsDoc || (activeWindow && activeWindow.document) || document)`;

/**
 * The settings page's 同步 row — the pause/resume control — read from its real DOM.
 *
 * Returns `null` while the page has not rendered the row, so the **test** waits for it
 * (the same reason {@link openRecycleBinDialog} answers a boolean instead of polling
 * inside the eval: Obsidian's background window throttles timers).
 */
export async function readPauseRow(vault: string): Promise<{
  /** The plugin's own persisted flag, not a guess from the button label. */
  paused: boolean;
  desc: string;
  button: string;
} | null> {
  return await evalInVault<{ paused: boolean; desc: string; button: string } | null>(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p) throw new Error('the Courier plugin is not loaded');
    const doc = ${SETTINGS_DOC_EXPR};
    for (const row of doc.querySelectorAll('.modal.mod-settings .setting-item')) {
      const name = row.querySelector('.setting-item-name');
      if (!name || (name.textContent || '').trim() !== ${jsLiteral(t("settings.pause.name"))}) continue;
      const descEl = row.querySelector('.setting-item-description');
      const button = Array.from(row.querySelectorAll('button')).find(
        (candidate) => (candidate.textContent || '').trim() === ${jsLiteral(t("settings.pause.pause"))} ||
          (candidate.textContent || '').trim() === ${jsLiteral(t("settings.pause.resume"))},
      );
      return {
        paused: !!p.settings.syncPaused,
        desc: descEl ? (descEl.textContent || '').trim() : '',
        button: button ? (button.textContent || '').trim() : '',
      };
    }
    return null;
    `,
    60_000,
  );
}

/** The settings page's account usage rows, as rendered. */
export interface SettingsAccountUsage {
  expiry: string;
  storage: string;
  /** The storage label and its value share one visual row (the grid columns line up). */
  storageOnOneLine: boolean;
  barWidth: number;
  fillWidth: number;
  hasFill: boolean;
}

/**
 * Read the account row's key-expiry and storage lines from the real settings page.
 *
 * Both live in the row's `courier-account-details` description; the storage line carries
 * the same quota bar as the status menu, so this is how the settings surface is held to
 * the same reading and the same geometry. Returns null until the description renders.
 */
export async function readSettingsAccountUsage(
  vault: string,
): Promise<SettingsAccountUsage | null> {
  return await evalInVault<SettingsAccountUsage | null>(
    vault,
    `
    const doc = ${SETTINGS_DOC_EXPR};
    const details = doc.querySelector('.modal.mod-settings .courier-account-details');
    if (!details) return null;
    const expiry = details.querySelector('.courier-account-key-expiry');
    const storage = details.querySelector('.courier-account-storage');
    if (!expiry || !storage) return null;
    const bar = storage.querySelector('.courier-storage-usage-bar');
    const fill = storage.querySelector('.courier-storage-usage-fill');
    const barBox = bar ? bar.getBoundingClientRect() : null;
    const fillBox = fill ? fill.getBoundingClientRect() : null;
    const storageLabel = Array.from(details.querySelectorAll('.courier-account-label'))
      .find((el) => (el.textContent || '').trim() === ${jsLiteral(t("settings.account.storage"))});
    const labelBox = storageLabel ? storageLabel.getBoundingClientRect() : null;
    const valueBox = storage.getBoundingClientRect();
    const centre = (box) => box.top + box.height / 2;
    return {
      expiry: expiry ? (expiry.textContent || '').trim() : '',
      storage: storage ? (storage.textContent || '').trim() : '',
      storageOnOneLine: !!labelBox && Math.abs(centre(labelBox) - centre(valueBox)) <= 6,
      barWidth: barBox ? barBox.width : 0,
      fillWidth: fillBox ? fillBox.width : 0,
      hasFill: !!fill,
    };
    `,
    60_000,
  );
}

/**
 * Press 暂停同步 or 继续同步 on the settings page's real 同步 row.
 *
 * Returns `false` while the row or that button is missing, so the caller can wait and
 * report which page state it saw instead of guessing.
 */
export async function clickPauseRow(vault: string, label: string): Promise<boolean> {
  await keepSettingsInVaultWindow(vault);
  return await evalInVault<boolean>(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p) throw new Error('the Courier plugin is not loaded');
    app.setting.open();
    app.setting.openTabById(p.manifest.id);
    // The page is drawn from the definitions it cached when the tab was added; the harness
    // changes the plugin state outside its own actions, so it asks for a re-render the way
    // the plugin does on every user action.
    if (p.settingTab && p.settingTab.update) p.settingTab.update();
    ${SETTINGS_IN_WINDOW_ASSERTION}
    const doc = (activeWindow && activeWindow.document) || document;
    // The settings page renders in this window; later reads find it through this.
    window.__courierE2eSettingsDoc = doc;
    const wanted = ${jsLiteral(label)};
    for (const row of doc.querySelectorAll('.modal.mod-settings .setting-item')) {
      const name = row.querySelector('.setting-item-name');
      if (!name || (name.textContent || '').trim() !== ${jsLiteral(t("settings.pause.name"))}) continue;
      const button = Array.from(row.querySelectorAll('button')).find(
        (candidate) => (candidate.textContent || '').trim() === wanted,
      );
      if (!button) return false;
      button.click();
      return true;
    }
    return false;
    `,
    60_000,
  );
}

/**
 * The deleted paths and per-row warnings the recycle-bin dialog renders, read from its
 * real DOM.
 *
 * The dialog decrypts each stored path before rendering it, so this asserts what a user
 * reads, not what the server stored.
 */
export async function readRecycleBinDialog(
  vault: string,
): Promise<{ open: boolean; paths: string[]; warnings: string[] }> {
  return await evalInVault<{ open: boolean; paths: string[]; warnings: string[] }>(
    vault,
    `
    const container = ${DIALOG_EXPR};
    if (!container) return { open: false, paths: [], warnings: [] };
    const paths = [];
    const warnings = [];
    for (const item of container.querySelectorAll('.courier-deleted-file-item')) {
      const pathEl = item.querySelector('.courier-deleted-path');
      if (pathEl && pathEl.textContent) paths.push(pathEl.textContent.trim());
      const warningEl = item.querySelector('.courier-deleted-warning');
      if (warningEl && warningEl.textContent) warnings.push(warningEl.textContent.trim());
    }
    return { open: true, paths: paths, warnings: warnings };
    `,
    60_000,
  );
}

/**
 * Press the recycle-bin dialog's header control — the only way to re-read the bin — and
 * answer the dialog's DOM **at the instant the click returns**.
 *
 * The read that click starts is still in flight then, which is what makes this readable as
 * a flash assertion: `kept` is true only when the rows on screen are the very nodes that
 * were there before the click, and `skeleton` is the loading state a re-read must not
 * enter (the skeleton belongs to the first read, when there is nothing to keep).
 */
export async function clickRecycleBinRefresh(vault: string): Promise<{
  open: boolean;
  clicked: boolean;
  kept: boolean;
  skeleton: number;
  countBefore: string;
  count: string;
  footer: string;
  busy: boolean;
}> {
  return await evalInVault(
    vault,
    `
    const container = ${DIALOG_EXPR};
    if (!container) return { open: false, clicked: false, kept: false, skeleton: 0, countBefore: '', count: '', footer: '', busy: false };
    const bin = container.querySelector('.courier-recycle-bin');
    if (!bin) return { open: false, clicked: false, kept: false, skeleton: 0, countBefore: '', count: '', footer: '', busy: false };
    const button = bin.querySelector('.courier-recycle-bin-header .extra-setting-button');
    if (!button) return { open: true, clicked: false, kept: false, skeleton: 0, countBefore: '', count: '', footer: '', busy: false };
    const rows = () => Array.from(bin.querySelectorAll('.courier-deleted-file-item'));
    const text = (selector) => {
      const el = bin.querySelector(selector);
      return el ? (el.textContent || '').trim() : '';
    };
    const footer = bin.querySelector('.courier-recycle-bin-footer');
    const before = rows();
    const countBefore = text('.courier-recycle-bin-count');
    button.click();
    const after = rows();
    return {
      open: true,
      clicked: true,
      kept: before.length === after.length && before.every((el, index) => el === after[index]),
      skeleton: bin.querySelectorAll('.courier-recycle-bin-skeleton').length,
      countBefore: countBefore,
      count: text('.courier-recycle-bin-count'),
      footer: footer ? footer.style.display : '',
      busy: bin.classList.contains('is-refreshing'),
    };
    `,
    60_000,
  );
}

/**
 * What the recycle-bin dialog shows now: its rows, its header count and whether the header
 * still says a read is running (the marker {@link clickRecycleBinRefresh} starts).
 */
export async function readRecycleBinRefresh(vault: string): Promise<{
  busy: boolean;
  skeleton: number;
  paths: string[];
  count: string;
}> {
  return await evalInVault(
    vault,
    `
    const container = ${DIALOG_EXPR};
    const empty = { busy: false, skeleton: 0, paths: [], count: '' };
    if (!container) return empty;
    const bin = container.querySelector('.courier-recycle-bin');
    if (!bin) return empty;
    const count = bin.querySelector('.courier-recycle-bin-count');
    const paths = [];
    for (const item of bin.querySelectorAll('.courier-deleted-file-item')) {
      const pathEl = item.querySelector('.courier-deleted-path');
      if (pathEl && pathEl.textContent) paths.push(pathEl.textContent.trim());
    }
    return {
      busy: bin.classList.contains('is-refreshing'),
      skeleton: bin.querySelectorAll('.courier-recycle-bin-skeleton').length,
      paths: paths,
      count: count ? (count.textContent || '').trim() : '',
    };
    `,
    60_000,
  );
}

/**
 * Press the dialog's 恢复 button for one listed file, the way a user does. Returns false
 * when the row or the button is missing, so the caller can say which.
 */
export async function clickRecycleBinRestore(vault: string, path: string): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const container = ${DIALOG_EXPR};
    if (!container) return false;
    const wanted = ${jsLiteral(path)};
    for (const item of container.querySelectorAll('.courier-deleted-file-item')) {
      const pathEl = item.querySelector('.courier-deleted-path');
      if (!pathEl || (pathEl.textContent || '').trim() !== wanted) continue;
      for (const button of item.querySelectorAll('button')) {
        if ((button.textContent || '').trim() === ${jsLiteral(t("dialog.recycleBin.restore"))}) {
          button.click();
          return true;
        }
      }
      return false;
    }
    return false;
    `,
    60_000,
  );
}

/**
 * Click the dialog's row for one listed file — the path line, not the button — which is
 * what opens the deleted version's content.
 */
export async function clickRecycleBinFile(vault: string, path: string): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const container = ${DIALOG_EXPR};
    if (!container) return false;
    const wanted = ${jsLiteral(path)};
    for (const item of container.querySelectorAll('.courier-deleted-file-item')) {
      const pathEl = item.querySelector('.courier-deleted-path');
      if (!pathEl || (pathEl.textContent || '').trim() !== wanted) continue;
      const info = item.querySelector('.courier-deleted-info');
      if (!info) return false;
      info.click();
      return true;
    }
    return false;
    `,
    60_000,
  );
}

/**
 * What the content dialog shows: its short title, the subject (the path) and facts line
 * in its header, and whether the content came out as Obsidian's rendered markdown (the
 * `.markdown-rendered` block `MarkdownRenderer` produces) or as an inline media element.
 *
 * The answers together are the difference between "the plugin decoded the bytes itself"
 * and "Obsidian rendered the note", which is the whole point of the preview.
 */
export async function readDeletedContent(vault: string): Promise<{
  open: boolean;
  title: string;
  subject: string;
  facts: string;
  rendered: boolean;
  text: string;
  image: boolean;
  placeholder: string;
}> {
  return await evalInVault<{
    open: boolean;
    title: string;
    subject: string;
    facts: string;
    rendered: boolean;
    text: string;
    image: boolean;
    placeholder: string;
  }>(
    vault,
    `
    const container = ${DIALOG_EXPR};
    if (!container) {
      return {
        open: false, title: '', subject: '', facts: '',
        rendered: false, text: '', image: false, placeholder: '',
      };
    }
    const text = (element) => (element && element.textContent ? element.textContent.trim() : '');
    const block = container.querySelector('.courier-file-preview-markdown');
    return {
      open: true,
      title: text(container.querySelector('.modal-title')),
      subject: text(container.querySelector('.courier-file-preview-subject')),
      facts: text(container.querySelector('.courier-file-preview-facts')),
      rendered: !!block && (block.textContent || '').trim().length > 0,
      text: text(block),
      image: !!container.querySelector('.courier-file-preview-image'),
      placeholder: text(container.querySelector('.courier-file-preview-placeholder')),
    };
    `,
    60_000,
  );
}

/**
 * The restore dialog's file-name field: whether it is up, what it is pre-filled with, and
 * the inline error it is currently showing (empty when there is none).
 */
export async function readRestoreNameField(
  vault: string,
): Promise<{ open: boolean; value: string; error: string }> {
  return await evalInVault<{ open: boolean; value: string; error: string }>(
    vault,
    `
    const container = ${DIALOG_EXPR};
    if (!container) return { open: false, value: '', error: '' };
    const input = container.querySelector('input[type="text"]');
    const errorEl = container.querySelector('.courier-restore-path-error');
    return {
      open: true,
      value: input ? input.value : '',
      error: errorEl && errorEl.textContent ? errorEl.textContent.trim() : '',
    };
    `,
    60_000,
  );
}

/**
 * Type a file name into the restore dialog, the way a user does.
 *
 * `input` is dispatched because that is the event Obsidian's `TextComponent.onChange`
 * listens for — assigning `.value` alone would leave the dialog's own state on the old
 * name and let the test pass without the plugin ever seeing the new one.
 */
export async function fillRestoreName(vault: string, name: string): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const container = ${DIALOG_EXPR};
    if (!container) return false;
    const input = container.querySelector('input[type="text"]');
    if (!input) return false;
    input.value = ${jsLiteral(name)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
    `,
    60_000,
  );
}

/**
 * Close the modals on screen — the name prompt and the list under it. The settings page
 * lives in the same document now, so its own close button is clicked too; the next case
 * reopens its tab anyway.
 */
export async function closeOpenModals(vault: string): Promise<number> {
  return await evalInVault<number>(
    vault,
    `
    const closers = Array.from(
      ${DIALOG_DOC_EXPR}.querySelectorAll('.modal-container .modal-close-button'),
    );
    for (const closer of closers) closer.click();
    return closers.length;
    `,
    60_000,
  );
}

/**
 * Press a button by its label in the dialog Obsidian is currently showing.
 *
 * Scoped like every other driver here: the settings page holds the recycle bin that opened
 * the dialog, so the newest `.modal-container` in its document is the one to press.
 */
export async function clickOpenModalButton(vault: string, label: string): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const container = ${DIALOG_EXPR};
    if (!container) return false;
    const wanted = ${jsLiteral(label)};
    for (const button of container.querySelectorAll('button')) {
      if ((button.textContent || '').trim() === wanted) {
        button.click();
        return true;
      }
    }
    return false;
    `,
    60_000,
  );
}

// ── Conflict-copy actions (the file explorer's own row) ──

/**
 * The conflict-copy action button on a file-explorer row, as the real explorer renders it.
 *
 * The button is injected into Obsidian's own file explorer — there is no public per-file
 * hook — so this reads the row by its `data-path` and answers what a user sees: the button,
 * its label, where it sits relative to the extension tag, and whether it is actually
 * rendered (a **box** inside the row, and the `styles.css` opacity that keeps it muted
 * until the row is hovered or active). The opacity is read twice because CSS `:hover`
 * cannot be simulated: the second reading adds the `is-active` class the app itself puts
 * on the open file's row, which is the rule that makes the button visible. The first
 * reading is **not** a reliable "hidden by default" assertion — a live pointer hovering
 * the row makes it 1, so it is returned for diagnostics only.
 *
 * Scoped to the vault window's `document`; the explorer lives in the main window, and the
 * recycle-bin drivers remember that same document now that Settings renders in it too
 * ({@link keepSettingsInVaultWindow}).
 */
export async function readConflictActionButton(
  vault: string,
  path: string,
): Promise<{
  row: boolean;
  button: boolean;
  label: string;
  tagAfter: boolean;
  /** The rendered box, or null when the button is not laid out at all. */
  box: { width: number; height: number; insideRow: boolean } | null;
  /** Computed opacity as the row stands — 1 too when a live pointer hovers it. */
  opacity: string;
  /** Computed opacity with the app's `is-active` class on the row. */
  opacityWhenActive: string;
}> {
  return await evalInVault<{
    row: boolean;
    button: boolean;
    label: string;
    tagAfter: boolean;
    box: { width: number; height: number; insideRow: boolean } | null;
    opacity: string;
    opacityWhenActive: string;
  }>(
    vault,
    `
    const row = Array.from(document.querySelectorAll('.nav-file-title[data-path]')).find(
      (el) => el.getAttribute('data-path') === ${jsLiteral(path)},
    );
    const button = row ? row.querySelector('.courier-conflict-action') : null;
    const next = button ? button.nextElementSibling : null;
    let box = null;
    let opacity = '';
    let opacityWhenActive = '';
    if (row && button) {
      // The chip is injected with an opacity transition, so a reading taken the moment it
      // appears is a mid-transition value (0.23 has been observed). Let it settle first.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const rowBox = row.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      box = {
        width: Math.round(buttonBox.width),
        height: Math.round(buttonBox.height),
        insideRow:
          buttonBox.width > 0 &&
          buttonBox.height > 0 &&
          buttonBox.left >= rowBox.left - 1 &&
          buttonBox.right <= rowBox.right + 1,
      };
      opacity = getComputedStyle(button).opacity;
      // The class is only ever added, never removed: on a row the app already marked
      // active, taking it away would change the app's own selection state.
      const wasActive = row.classList.contains('is-active');
      // \`styles.css\` transitions opacity over 100 ms, and an earlier version waited
      // 400 ms for it — long enough for a background explorer re-render to replace the
      // row, or drop the class, between adding it and reading the computed value. That
      // was the one flaky assertion in this case. Suppress the transition and read in
      // the same tick instead: no other JS can run in between, so the measurement
      // cannot move under us, and the case still fails when the rule is really gone.
      const transition = button.style.transition;
      button.style.transition = 'none';
      if (!wasActive) row.classList.add('is-active');
      void button.offsetWidth; // flush the style change before reading it
      opacityWhenActive = getComputedStyle(button).opacity;
      if (!wasActive) row.classList.remove('is-active');
      button.style.transition = transition;
    }
    return {
      row: !!row,
      button: !!button,
      label: button ? (button.textContent || '').trim() : '',
      // The extension tag has to stay the row's rightmost item, with the action before it.
      tagAfter: !!next && next.classList.contains('nav-file-tag'),
      box,
      opacity,
      opacityWhenActive,
    };
    `,
    60_000,
  );
}

/** The width a row is temporarily squeezed to when checking that the chip does not wrap. */
const NARROW_CONFLICT_ROW_WIDTH = 120;

/**
 * How the conflict-copy chip lays out when its explorer row is narrow.
 *
 * A separate, deliberately small `eval` (one step per call — a multi-kilobyte body is
 * truncated by the Obsidian CLI on its way to the main process, see `evalInVault`) because
 * the row-decoration read above already sits near that budget. With a long conflict name
 * the row has to ellipsize the file name and keep the chip on one line; a chip that takes
 * part in the flex shrink wraps `对比` / `replace` one character per line. The row's inline
 * width and flex are restored before the eval returns.
 */
export async function measureConflictActionNarrow(
  vault: string,
  path: string,
): Promise<{
  lineCount: number;
  narrowBox: { width: number; height: number; insideRow: boolean } | null;
  narrowLineCount: number;
}> {
  return await evalInVault<{
    lineCount: number;
    narrowBox: { width: number; height: number; insideRow: boolean } | null;
    narrowLineCount: number;
  }>(
    vault,
    `
    const row = Array.from(document.querySelectorAll('.nav-file-title[data-path]')).find(
      (el) => el.getAttribute('data-path') === ${jsLiteral(path)},
    );
    const button = row ? row.querySelector('.courier-conflict-action') : null;
    if (!row || !button) return { lineCount: 0, narrowBox: null, narrowLineCount: 0 };
    // One client rect per rendered line, so two distinct tops mean the label wrapped.
    const lines = (el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      return new Set(
        Array.from(range.getClientRects())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => Math.round(rect.top)),
      ).size;
    };
    const lineCount = lines(button);
    const previousWidth = row.style.width;
    const previousFlex = row.style.flex;
    row.style.width = ${NARROW_CONFLICT_ROW_WIDTH} + 'px';
    row.style.flex = '0 0 ' + ${NARROW_CONFLICT_ROW_WIDTH} + 'px';
    void button.offsetWidth;
    const rowBox = row.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    const narrowBox = {
      width: Math.round(buttonBox.width),
      height: Math.round(buttonBox.height),
      insideRow:
        buttonBox.width > 0 &&
        buttonBox.height > 0 &&
        buttonBox.left >= rowBox.left - 1 &&
        buttonBox.right <= rowBox.right + 1,
    };
    const narrowLineCount = lines(button);
    row.style.width = previousWidth;
    row.style.flex = previousFlex;
    void button.offsetWidth;
    return { lineCount, narrowBox, narrowLineCount };
    `,
    60_000,
  );
}

/** Press that button, the way a user does. */
export async function clickConflictAction(vault: string, path: string): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const row = Array.from(document.querySelectorAll('.nav-file-title[data-path]')).find(
      (el) => el.getAttribute('data-path') === ${jsLiteral(path)},
    );
    const button = row ? row.querySelector('.courier-conflict-action') : null;
    if (!button) return false;
    button.click();
    return true;
    `,
    60_000,
  );
}

/**
 * Click the version-history chip on a file's explorer row, the way a user does.
 *
 * The chip is only *drawn* on hover, but it is in the row's DOM from the moment the row is
 * decorated, so a programmatic click is the same call the pointer would make.
 */
export async function clickVersionHistoryChip(vault: string, path: string): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const row = Array.from(document.querySelectorAll('.nav-file-title[data-path]')).find(
      (el) => el.getAttribute('data-path') === ${jsLiteral(path)},
    );
    const chip = row ? row.querySelector('.courier-version-history-action') : null;
    if (!chip) return false;
    chip.click();
    return true;
    `,
    60_000,
  );
}

/**
 * The version-history view, read from its real DOM.
 *
 * Payload-stingy for the same reason as {@link readConflictDiff}: the `eval` body travels to
 * Obsidian's main process over a socket. What it answers: whether a history tab is open, the
 * header (title, count, day groups), the rows (action, clock reading, which one is selected,
 * whether it can be selected at all) and the pane (its text, the height its head and body
 * take, and whether the list — not the page — is what scrolls).
 */
export interface VersionHistoryReading {
  open: boolean;
  title: string;
  count: string;
  days: string[];
  rows: Array<{ action: string; time: string; selected: boolean; selectable: boolean }>;
  /** The reading pane's text, cut to its first 80 characters. */
  pane: string;
  /** The pane head's and body's heights together, in pixels. */
  paneHeight: number;
  /** Whether the list has more rows than fit (only the list scrolls). */
  listScrolls: boolean;
  /** Whether the pane's foot is inside the leaf (the page did not overflow the tab). */
  inside: boolean;
}

const NO_VERSION_HISTORY: VersionHistoryReading = {
  open: false,
  title: "",
  count: "",
  days: [],
  rows: [],
  pane: "",
  paneHeight: 0,
  listScrolls: false,
  inside: false,
};

export async function readVersionHistoryView(vault: string): Promise<VersionHistoryReading> {
  const reading = await evalInVault<Partial<VersionHistoryReading>>(
    vault,
    `
    const open = app.workspace.getLeavesOfType('courier-version-history');
    const leaf = open.length > 0 ? open[open.length - 1] : null;
    const rt = leaf ? leaf.containerEl.querySelector('.courier-version-history-view') : null;
    if (!rt) return { open: false };
    const txt = (e) => (e && e.textContent ? e.textContent.trim() : '');
    const bx = (e) => e.getBoundingClientRect();
    const body = rt.querySelector('.courier-vh-pane-body');
    const head = rt.querySelector('.courier-vh-pane-head');
    const list = rt.querySelector('.courier-vh-list');
    const le = rt.closest('.workspace-leaf') || rt;
    const lb = bx(le);
    return {
      open: true,
      title: txt(rt.querySelector('.courier-vh-title-text')),
      count: txt(rt.querySelector('.courier-vh-count')),
      days: Array.from(rt.querySelectorAll('.courier-vh-day-title')).map(txt),
      rows: Array.from(rt.querySelectorAll('.courier-vh-version')).map((r) => ({
        action: txt(r.querySelector('.courier-vh-action')),
        time: txt(r.querySelector('.courier-vh-time')),
        selected: r.classList.contains('is-selected'),
        selectable: r.classList.contains('is-selectable'),
      })),
      pane: txt(body).slice(0, 80),
      paneHeight: head && body ? Math.round(bx(head).height + bx(body).height) : 0,
      listScrolls: list ? list.scrollHeight > list.clientHeight : false,
      inside: !!(body && bx(rt).top >= lb.top - 1 && bx(body).bottom <= lb.bottom + 1),
    };
    `,
    60_000,
  );
  return { ...NO_VERSION_HISTORY, ...reading };
}

/** Select one row of an open version history, by its position (0 = the newest). */
export async function clickVersionHistoryRow(vault: string, index: number): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const open = app.workspace.getLeavesOfType('courier-version-history');
    const leaf = open.length > 0 ? open[open.length - 1] : null;
    const rows = leaf ? leaf.containerEl.querySelectorAll('.courier-vh-version') : [];
    const row = rows[${index}];
    if (!row) return false;
    row.click();
    return true;
    `,
    60_000,
  );
}

/** Close every version-history tab in a vault (the case owns the whole set). */
export async function closeVersionHistories(vault: string): Promise<number> {
  return await evalInVault<number>(
    vault,
    `
    const open = app.workspace.getLeavesOfType('courier-version-history');
    for (const leaf of open) leaf.detach();
    return open.length;
    `,
    60_000,
  );
}

/**
 * Close every comparison tab in a vault.
 *
 * A case that asserts "the comparison closed itself" can only see that if it owns the whole
 * set: a tab left behind by an earlier case (or by a manual probe while developing) is a
 * `courier-conflict-diff` leaf too, and it would keep `readConflictDiff().open` true.
 */
export async function closeConflictDiffs(vault: string): Promise<number> {
  return await evalInVault<number>(
    vault,
    `
    const open = app.workspace.getLeavesOfType('courier-conflict-diff');
    for (const leaf of open) leaf.detach();
    return open.length;
    `,
    60_000,
  );
}

/**
 * The conflict dialogs on screen, across the windows Obsidian may put them in.
 *
 * Found by the marker class each dialog puts on its own content (`courier-conflict-replace`)
 * rather than by "the newest `.modal-container`": another dialog — the recycle bin, left open
 * by an earlier case — may still be up, in a window of its own, and the newest container
 * would then be that one.
 *
 * Kept deliberately small: an `eval` body travels to Obsidian's main process over a socket
 * and a large one has been seen truncated (see `evalInVault`).
 */
const CONFLICT_DIALOGS_EXPR = `Array.from(new Set([
      document,
      (() => { try { return activeWindow.document } catch { return null } })(),
      (() => { try { return window.__courierE2eDialogDoc } catch { return null } })(),
    ].filter(Boolean))).flatMap((d) =>
      Array.from(d.querySelectorAll('.modal-container')).filter((c) =>
        c.querySelector('.courier-conflict-replace')))`;

/**
 * The comparison views on screen, in every window.
 *
 * A comparison is a **main-area tab**, so it is found by the leaf's own type attribute
 * (`data-type="courier-conflict-diff"`) and not by a modal container — "is it open" then
 * means "is there a tab for it", which is exactly what the user sees. Written to stay small
 * for the same reason as {@link CONFLICT_DIALOGS_EXPR}.
 */
const CONFLICT_DIFF_VIEWS_EXPR = `Array.from(new Set([
      document,
      (() => { try { return activeWindow.document } catch { return null } })(),
    ].filter(Boolean))).flatMap((d) =>
      Array.from(d.querySelectorAll('[data-type="courier-conflict-diff"].workspace-leaf-content')))`;

/**
 * The conflict-comparison **view**, read from its real DOM: the header (names, line counts,
 * the 并排/统一 control and the replace button), the changed rows (left = the parked copy,
 * right = the file as it stands) and the unified presentation's additions.
 *
 * The `eval` body is kept deliberately terse — no comments, short names — because it travels
 * to Obsidian's main process over a socket and a payload this size must stay small (see
 * `evalInVault`; an oversized one is truncated and takes the process down). What it computes:
 *
 * - `titles`: the note's name and the parked copy's, the header's two lines.
 * - `stats`: the header's `+n` / `−n`, in render order.
 * - `layout`: the segmented control's two labels, the chosen one, and the track's measured
 *   width — the control must stay narrow rather than stretching across the header.
 * - `replaceOnHeaderLine`: the button's box lies inside the header's box, so it sits on the
 *   header's line instead of in a footer.
 * - `centreSpread`: the largest difference between the vertical centres of the names' block,
 *   the counts, the layout control and the button — the alignment the stylesheet promises.
 * - `chromeVisible`: the tab's header and the comparison's header are on screen with the rows,
 *   and the rows' foot is inside the leaf (only the rows scroll).
 */
export interface ConflictDiffReading {
  open: boolean;
  /** The header's real buttons (the layout options are chips, not actions). */
  buttons: string[];
  mode: "split" | "unified" | null;
  /** The two names the header shows: the note, and the parked copy under it. */
  titles: { original: string; copy: string } | null;
  /** The header's `+n` / `−n`, in render order. */
  stats: string[];
  /** The 并排/统一 segmented control, measured. */
  layout: {
    options: string[];
    value: string;
    width: number;
    headerWidth: number;
  } | null;
  /** The replace button is on the header's line, not in a footer. */
  replaceOnHeaderLine: boolean;
  /** How far apart the header's four groups sit from one shared centre line, in pixels. */
  centreSpread: number | null;
  changes: Array<{ left: string; right: string }>;
  additions: string[];
  chromeVisible: boolean;
}

/**
 * What the reader answers when there is no comparison tab.
 *
 * The `eval` body returns only `{ open: false }` — the payload budget rules out sending a
 * full empty shape — so the fields are filled in here. Spreading it means every caller sees
 * the declared shape even when it reads `open` first.
 */
const NO_CONFLICT_DIFF: ConflictDiffReading = {
  open: false,
  buttons: [],
  mode: null,
  titles: null,
  stats: [],
  layout: null,
  replaceOnHeaderLine: false,
  centreSpread: null,
  changes: [],
  additions: [],
  chromeVisible: false,
};

export async function readConflictDiff(vault: string): Promise<ConflictDiffReading> {
  const reading = await evalInVault<Partial<ConflictDiffReading>>(
    vault,
    `
const ls = ${CONFLICT_DIFF_VIEWS_EXPR};
const lf = ls[ls.length - 1];
const rt = lf ? lf.querySelector('.courier-conflict-diff') : null;
if (!rt) return { open: false };
const txt = (e) => (e && e.textContent ? e.textContent.trim() : '');
const bx = (e) => e.getBoundingClientRect();
const q = (s) => rt.querySelector(s);
const hd = q('.courier-conflict-diff-header');
const sb = q('.courier-conflict-diff-subtitle');
const tt = q('.courier-conflict-diff-title-text');
const st = q('.courier-conflict-diff-stats');
const sg = hd ? hd.querySelector('.courier-segmented') : null;
const so = sg ? Array.from(sg.querySelectorAll('.courier-segmented-option')) : [];
const si = so.findIndex((o) => o.classList.contains('is-active'));
const bt = q('.courier-conflict-diff-replace');
const gs = [q('.courier-conflict-diff-title'), st, sg, bt].filter(Boolean);
const cs = gs.map((g) => { const b = bx(g); return b.top + b.height / 2; });
const hb = hd ? bx(hd) : null;
const bb = bt ? bx(bt) : null;
const rw = q('.courier-diff-rows');
const le = lf.closest('.workspace-leaf');
const th = le ? le.querySelector('.view-header') : null;
const lb = bx(lf);
const tb = th ? bx(th) : null;
const vb = hd ? bx(hd) : null;
const ct = (row, side) => {
  const cell = row.querySelector('.courier-diff-cell.courier-diff-' + side);
  return cell ? txt(cell.querySelector('.courier-diff-text')) : '';
};
return {
  open: true,
  buttons: Array.from(rt.querySelectorAll('button:not(.courier-segmented-option)')).map(txt),
  mode: sg ? (si === 1 ? 'unified' : 'split') : null,
  titles: tt && sb ? { original: txt(tt), copy: txt(sb) } : null,
  stats: Array.from(rt.querySelectorAll('.courier-conflict-diff-stat')).map(txt),
  layout: sg ? {
    options: so.map(txt),
    value: si >= 0 ? txt(so[si]) : '',
    width: Math.round(bx(sg).width),
    headerWidth: hd ? Math.round(bx(hd).width) : 0,
  } : null,
  replaceOnHeaderLine: !!(hb && bb && bb.height > 0 && bb.top >= hb.top - 1 && bb.bottom <= hb.bottom + 1),
  centreSpread: cs.length === 4 ? Math.max(...cs) - Math.min(...cs) : null,
  changes: Array.from(rt.querySelectorAll('.courier-diff-row-change')).map((r) => ({
    left: ct(r, 'left'), right: ct(r, 'right') })),
  additions: Array.from(rt.querySelectorAll('.courier-diff-line-add')).map((l) =>
    txt(l.querySelector('.courier-diff-sigil')) + ' ' + txt(l.querySelector('.courier-diff-text'))),
  chromeVisible: !!(tb && vb) && tb.height > 0 && vb.top >= lb.top - 1 &&
    vb.bottom <= lb.bottom + 1 && (!rw || bx(rw).bottom <= lb.bottom + 1),
};
    `,
    60_000,
  );
  return { ...NO_CONFLICT_DIFF, ...reading };
}

/**
 * The replace confirmation, read from its real DOM.
 *
 * Two of its properties are only visible as rendering: the switch comes **before** the words
 * it is about (one row's left half), and nothing draws a divider line under the sentence — a
 * `setting-item` border there reads as an underline of the sentence.
 */
export async function readConflictReplaceConfirm(vault: string): Promise<{
  open: boolean;
  question: string | null;
  /** The choice's switch is the first thing in its half, its words after it. */
  toggleBeforeLabel: boolean;
  /** Elements inside the dialog that draw a top border: 0, or the dialog underlines itself. */
  dividers: number;
  /** The buttons share the choice's row instead of sitting under it. */
  buttonsOnChoiceRow: boolean;
}> {
  return await evalInVault<{
    open: boolean;
    question: string | null;
    toggleBeforeLabel: boolean;
    dividers: number;
    buttonsOnChoiceRow: boolean;
  }>(
    vault,
    `
    const containers = ${CONFLICT_DIALOGS_EXPR};
    const bodies = containers.filter((c) => c.querySelector('.courier-conflict-replace'));
    const content =
      bodies.length > 0 ? bodies[bodies.length - 1].querySelector('.courier-conflict-replace') : null;
    if (!content) {
      return {
        open: false, question: null, toggleBeforeLabel: false, dividers: 0, buttonsOnChoiceRow: false,
      };
    }
    const question = content.querySelector('.courier-conflict-replace-question');
    const choice = content.querySelector('.courier-conflict-replace-choice');
    const first = choice ? choice.firstElementChild : null;
    const last = choice ? choice.lastElementChild : null;
    const toggleBeforeLabel =
      !!first &&
      !!last &&
      first !== last &&
      (first.matches('.checkbox-container') || !!first.querySelector('input[type=checkbox]'));
    const dividers = Array.from(content.querySelectorAll('hr, .setting-item')).filter(
      (el) => parseFloat(getComputedStyle(el).borderTopWidth) > 0,
    ).length;
    const actions = content.querySelector('.courier-conflict-replace-actions');
    let buttonsOnChoiceRow = false;
    if (choice && actions) {
      const choiceBox = choice.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      buttonsOnChoiceRow =
        Math.abs(choiceBox.top + choiceBox.height / 2 - (actionsBox.top + actionsBox.height / 2)) < 4;
    }
    return {
      open: true,
      question: question ? (question.textContent || '').trim() : null,
      toggleBeforeLabel,
      dividers,
      buttonsOnChoiceRow,
    };
    `,
    60_000,
  );
}

/**
 * Pick 并排 or 统一 in the comparison's header, the way a user does.
 *
 * `mode` is the internal name (`split` / `unified`); the option is chosen by its index,
 * because the label is translated copy.
 */
export async function selectConflictDiffMode(
  vault: string,
  mode: "split" | "unified",
): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const leaves = ${CONFLICT_DIFF_VIEWS_EXPR};
    const leaf = leaves.length > 0 ? leaves[leaves.length - 1] : null;
    const group = leaf ? leaf.querySelector('.courier-conflict-diff-header .courier-segmented') : null;
    if (!group) return false;
    const wanted = ${jsLiteral(mode)} === 'unified' ? 1 : 0;
    const target = Array.from(group.querySelectorAll('.courier-segmented-option'))[wanted];
    if (!target) return false;
    target.click();
    const after = Array.from(leaf.querySelectorAll('.courier-conflict-diff-header .courier-segmented-option'));
    return after.findIndex((o) => o.classList.contains('is-active')) === wanted;
    `,
    60_000,
  );
}

/**
 * Press one of the conflict surfaces' buttons — the comparison's own ("用冲突副本替换当前
 * 文件" / "恢复为原文件") or the replace confirmation's.
 *
 * The comparison is a tab and the confirmation a modal, so both are searched: whichever is
 * on top is the one a click would reach, and the confirmation is always the newer surface.
 */
export async function clickConflictDialogButton(vault: string, label: string): Promise<boolean> {
  return await evalInVault<boolean>(
    vault,
    `
    const wanted = ${jsLiteral(label)};
    const surfaces = ${CONFLICT_DIFF_VIEWS_EXPR}.concat(${CONFLICT_DIALOGS_EXPR});
    // Newest first: the confirmation belongs after the tab, so it is the surface a click
    // reaches first when both are up.
    for (let index = surfaces.length - 1; index >= 0; index--) {
      for (const button of surfaces[index].querySelectorAll('button')) {
        if ((button.textContent || '').trim() === wanted) {
          button.click();
          return true;
        }
      }
    }
    return false;
    `,
    60_000,
  );
}

/** The notices Obsidian is showing, newest last — what the plugin last told the user. */
export async function readNotices(vault: string): Promise<string[]> {
  return await evalInVault<string[]>(
    vault,
    `
    return Array.from(document.querySelectorAll('.notice')).map(
      (notice) => (notice.textContent || '').trim(),
    );
    `,
    30_000,
  );
}

/** Force a full reconcile in the live engine (what a reconnect does). */ export async function reconcile(
  vault: string,
): Promise<void> {
  await evalInVault(
    vault,
    `
    const p = app.plugins.plugins.courier;
    if (!p || !p.host) throw new Error('no running sync host');
    await p.host.engine.initialSync();
    return true;
    `,
    180_000,
  );
}

/**
 * A vault, driven through Obsidian's own `app.vault` API.
 *
 * Writes deliberately use `app.vault.create` / `modify` / `rename` / `delete`
 * (not the CLI's `create` command, which needs an active file) so they behave
 * exactly like a user editing notes and emit the real vault events.
 */
export class ObsidianVault {
  constructor(readonly name: string) {}

  /** Create a note, or overwrite it when it already exists. */
  async write(path: string, content: string): Promise<void> {
    await this.ensureFolder(parentDir(path));
    await evalInVault(
      this.name,
      `
      const existing = app.vault.getAbstractFileByPath(${jsLiteral(path)});
      if (existing) { await app.vault.modify(existing, ${jsLiteral(content)}); return 'modified'; }
      await app.vault.create(${jsLiteral(path)}, ${jsLiteral(content)});
      return 'created';
      `,
      60_000,
    );
  }

  /**
   * Create the folder chain for a path, outermost first (see
   * {@link ensureFolderInVault}).
   */
  async ensureFolder(path: string): Promise<void> {
    await ensureFolderInVault(this.name, path);
  }

  /**
   * Rename/move a note, firing Obsidian's `rename` event.
   *
   * Idempotent on purpose: when the *peer* moves a note first, this vault's own
   * copy lands at `to` through sync, and an unconditional rename would then throw
   * ENOENT on a scenario that actually succeeded. Nothing to move at either path
   * is a real failure.
   */
  async rename(from: string, to: string): Promise<void> {
    await this.ensureFolder(parentDir(to));
    await evalInVault(
      this.name,
      `
      const file = app.vault.getAbstractFileByPath(${jsLiteral(from)});
      if (!file) {
        const already = app.vault.getAbstractFileByPath(${jsLiteral(to)});
        if (already) return 'already-moved';
        throw new Error('missing file: ' + ${jsLiteral(from)});
      }
      await app.vault.rename(file, ${jsLiteral(to)});
      return true;
      `,
      60_000,
    );
  }

  /**
   * Delete a note permanently, firing Obsidian's `delete` event.
   *
   * Idempotent on the same post-condition rule as {@link rename}: `Vault.delete` awaits
   * only the adapter's unlink and leaves the vault index to the file watcher, so a note
   * another writer already removed from disk — a peer's delete arriving through sync
   * while this cleanup runs, or the suite's own earlier step — is still listed by
   * `getAbstractFileByPath`, and its unlink answers `ENOENT`. The file is gone either
   * way; the cleanup's job is the absence, not the unlink.
   */
  async remove(path: string): Promise<void> {
    await evalInVault(
      this.name,
      `
      const file = app.vault.getAbstractFileByPath(${jsLiteral(path)});
      if (!file) return false;
      try {
        await app.vault.delete(file);
      } catch (err) {
        if (!(await app.vault.adapter.exists(${jsLiteral(path)}))) return false;
        throw err;
      }
      return true;
      `,
      60_000,
    );
  }

  /** Note content, or null when the vault does not have the file. */
  async read(path: string): Promise<string | null> {
    return await evalInVault<string | null>(
      this.name,
      `
      const file = app.vault.getAbstractFileByPath(${jsLiteral(path)});
      if (!file) return null;
      return await app.vault.read(file);
      `,
      60_000,
    );
  }

  /**
   * A file's bytes as base64, or null when the vault does not have it.
   *
   * The only lossless way to read an attachment back: the CLI's `read` command and
   * `app.vault.read` both decode as text, which turns a PNG into replacement characters
   * and would make a "the bytes arrived" assertion pass on garbage.
   */
  async readBase64(path: string): Promise<string | null> {
    return await evalInVault<string | null>(
      this.name,
      `
      const file = app.vault.getAbstractFileByPath(${jsLiteral(path)});
      if (!file) return null;
      const buffer = await app.vault.readBinary(file);
      const bytes = new Uint8Array(buffer);
      let binary = '';
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(binary);
      `,
      60_000,
    );
  }

  /** Write a file's bytes through Obsidian's own binary API (fires a real vault event). */
  async writeBase64(path: string, base64: string): Promise<void> {
    await this.ensureFolder(parentDir(path));
    await evalInVault(
      this.name,
      `
      const binary = atob(${jsLiteral(base64)});
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const existing = app.vault.getAbstractFileByPath(${jsLiteral(path)});
      if (existing) { await app.vault.modifyBinary(existing, bytes.buffer); return 'modified'; }
      await app.vault.createBinary(${jsLiteral(path)}, bytes.buffer);
      return 'created';
      `,
      60_000,
    );
  }

  async exists(path: string): Promise<boolean> {
    return await evalInVault<boolean>(
      this.name,
      `return !!app.vault.getAbstractFileByPath(${jsLiteral(path)});`,
      60_000,
    );
  }

  /**
   * Markdown file paths Obsidian currently indexes.
   *
   * `getMarkdownFiles` is what the old adapter listed with; the sync scope now works off
   * `getFiles`, so assertions about attachments use {@link listAll}.
   */
  async list(): Promise<string[]> {
    return await evalInVault<string[]>(
      this.name,
      `return app.vault.getMarkdownFiles().map((f) => f.path).sort();`,
      60_000,
    );
  }

  /**
   * **Every** file Obsidian indexes, whatever the type.
   *
   * This is the real-app answer to "does `getFiles()` really include attachments" — the
   * question a stub cannot answer, and the reason the attachment cases have to run here.
   */
  async listAll(): Promise<string[]> {
    return await evalInVault<string[]>(
      this.name,
      `return app.vault.getFiles().map((f) => f.path).sort();`,
      60_000,
    );
  }

  /**
   * Folder paths Obsidian knows, optionally restricted to a subtree
   * (`inFolder`). Used by the suite's own cleanup, never by a sync assertion.
   */
  async folders(inFolder?: string): Promise<string[]> {
    return await evalInVault<string[]>(
      this.name,
      `
      const all = app.vault.getAllFolders().map((f) => f.path).filter(Boolean);
      const root = ${jsLiteral(inFolder ?? "")};
      return all.filter((p) => !root || p === root || p.startsWith(root + '/')).sort();
      `,
      60_000,
    );
  }

  /** Delete an empty folder (a no-op when it is gone or not empty). */
  async removeFolder(path: string): Promise<void> {
    await removeFolderInVault(this.name, path);
  }

  /**
   * Delete a folder the way the file explorer does: the folder **and everything in
   * it**, through `app.vault.delete(folder, true)`, so the whole delete burst reaches
   * the plugin (the folder first, then one `delete` per descendant, in no defined
   * order).
   *
   * Cleanup keeps using {@link removeFolderInVault}: that one goes through the data
   * adapter, fires nothing, and removes the directory itself.
   */
  async removeTree(path: string): Promise<void> {
    await evalInVault(
      this.name,
      `
      const folder = app.vault.getFolderByPath(${jsLiteral(path)});
      if (!folder) return false;
      await app.vault.delete(folder, true);
      return true;
      `,
      60_000,
    );
  }
}
