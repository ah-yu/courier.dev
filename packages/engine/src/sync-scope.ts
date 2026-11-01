import { DEFAULT_MAX_FILE_BYTES } from "@courier/shared";
import { isConflictFile } from "./conflict-file";
import { DEFAULT_FILE_TYPES, FILE_TYPE_GROUPS, fileTypeOf, type FileTypeSync } from "./file-types";

export { DEFAULT_MAX_FILE_BYTES };

/**
 * Which paths a device syncs, and the config-folder switches that shape it.
 *
 * Three systems meet in this module. **File types** (`file-types.ts`) decide what kind of
 * thing a vault path is — markdown and canvas always, images/audio/video/PDF by default,
 * everything else on request. **Settings groups** (this file) decide what a path inside
 * Obsidian's config folder is, one group per category of configuration. **Excluded
 * folders** (this file) are the user's own "not this part of the vault" list. A path
 * belongs to exactly one of them, and `isSyncablePath` is the single rule that says
 * whether this device wants it.
 */

/**
 * One group of files inside Obsidian's config folder, switchable on its own.
 *
 * The grouping mirrors the categories Obsidian's own Sync offers under "vault
 * configuration sync", so a user can turn off exactly the part they do not want
 * on another device — appearance, hotkeys, one plugin's settings — instead of all
 * settings at once. `themes` and `snippets` are one category there; they are split
 * here because a theme is a folder of assets while a snippet is a single stylesheet,
 * and users usually want them for different reasons.
 */
export type SettingsGroup =
  /** `app.json` — Obsidian's main settings (file/links behaviour, editor defaults…). */
  | "app"
  /** `appearance.json` — theme, fonts, accent colour, which snippets are enabled. */
  | "appearance"
  /** `themes/**` — the installed theme folders `appearance.json` points at. */
  | "themes"
  /** `snippets/**` — the CSS snippets themselves. */
  | "snippets"
  /** `hotkeys.json` — keyboard shortcuts (device-specific by nature). */
  | "hotkeys"
  /** `core-plugins.json` — which core plugins are enabled. */
  | "corePlugins"
  /**
   * Every **other** top-level `*.json` — one file per core plugin's own settings
   * (`graph.json`, `templates.json`, `daily-notes.json`, `bookmarks.json`,
   * `types.json`, …). A catch-all on purpose: a core plugin added later writes its
   * settings at the same level and needs no change here.
   */
  | "corePluginSettings"
  /**
   * `community-plugins.json` — **which** community plugins are enabled (a state
   * list, not the plugins themselves). Obsidian exposes this as "active community
   * plugin list", separately from the plugin files.
   */
  | "communityPluginList"
  /**
   * `plugins/<id>/**` — the **installed** community plugins: their code
   * (`main.js`), styles, `manifest.json`, assets and each plugin's own settings
   * (`data.json`). Obsidian exposes this as "installed community plugin list".
   *
   * A separate group from `communityPluginList` on purpose — Obsidian lets a
   * device sync the enabled list without the plugin bodies — but note the
   * consequence: carrying the list alone leaves a peer that lists plugins it does
   * not have, which Obsidian reports as a failed load.
   */
  | "communityPlugins"
  /**
   * Anything else inside the config folder: non-standard files that no group above
   * claims — a top-level file that is not `*.json`, or an unknown subfolder (an
   * `icons/` folder, a tool's own state file). Off by default: these are the files
   * whose provenance we cannot reason about, so they only travel when asked for.
   *
   * This is **inside** the config folder only; attachments elsewhere in the vault
   * are a separate concern (still unsynced).
   */
  | "otherFiles";

/** Every group, in the order the settings UI shows them. */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  "app",
  "appearance",
  "themes",
  "snippets",
  "hotkeys",
  "corePlugins",
  "corePluginSettings",
  "communityPluginList",
  "communityPlugins",
  "otherFiles",
];

/** Which groups a device syncs. */
export type SettingsSyncGroups = Record<SettingsGroup, boolean>;

/** No config-folder group at all — the default for every device. */
export const NO_SETTINGS_GROUPS: SettingsSyncGroups = {
  app: false,
  appearance: false,
  themes: false,
  snippets: false,
  hotkeys: false,
  corePlugins: false,
  corePluginSettings: false,
  communityPluginList: false,
  communityPlugins: false,
  otherFiles: false,
};

/**
 * What Obsidian Sync keeps in step by default: the app's settings, appearance,
 * themes and snippets, hotkeys, the active core-plugin list and every core
 * plugin's own settings. Community plugins and unknown files are opt-in.
 */
export const OBSIDIAN_DEFAULT_GROUPS: SettingsSyncGroups = {
  ...NO_SETTINGS_GROUPS,
  app: true,
  appearance: true,
  themes: true,
  snippets: true,
  hotkeys: true,
  corePlugins: true,
  corePluginSettings: true,
};

/**
 * Which vault paths this device syncs.
 *
 * Markdown outside dot-folders is always synced; Obsidian's **config folder**
 * (`.obsidian`, the one dot-folder that is allowed through) contributes the files
 * whose group the user switched on. Everything else — every other dot-folder, and
 * every non-markdown file outside the config folder — is not part of the vault as
 * far as this engine is concerned.
 *
 * The scope is a **device-local** decision: a peer that has a group off ignores
 * those chains entirely (see `SyncEngine`), so two devices cannot fight over files
 * only one of them wants.
 */
export interface SyncScope {
  /**
   * Vault-relative name of Obsidian's config folder, from `Vault.configDir`.
   * Defaults to `.obsidian`; a vault with a custom one uses its own name and
   * only syncs paths under it.
   */
  configDir: string;
  /** The config-folder groups this device syncs. */
  settingsGroups: SettingsSyncGroups;
  /**
   * The vault-wide file categories this device syncs, besides markdown and canvas
   * (which are always synced). Device-local like the groups above.
   */
  fileTypes: FileTypeSync;
  /**
   * Vault-relative folders this device leaves out entirely, as typed by the user:
   * a path equal to an entry or under `entry + "/"` is neither pushed nor pulled
   * (and never becomes a conflict copy) on this device.
   *
   * Device-local, exactly like the file types above: one device excluding a folder
   * does not change what a peer syncs. The list only covers the vault itself —
   * paths inside the config folder stay governed by `settingsGroups`.
   */
  excludedFolders: string[];
  /**
   * Largest file this host will **send**, in plaintext bytes; `0` means no limit.
   *
   * A guard rail rather than the resource policy itself: the engine reads a whole file
   * into memory to hash and encrypt it, so a large video can exhaust a phone before
   * anything else fails. It bounds the upload direction only — a version a peer already
   * stored is part of the vault and is materialised whatever this cap says, because a
   * file silently absent from one device is indistinguishable from data loss. A file over
   * the cap that this device cannot send is reported through `EngineOptions.onFileTooLarge`
   * (once per path per pass, and only when it actually has something to send).
   *
   * The value is the account's administrator-set cap (`GET /api/me`), not a setting
   * this device's user edits; hosts fall back to {@link DEFAULT_MAX_FILE_BYTES} when
   * they cannot read it.
   */
  maxFileBytes: number;
}

/**
 * What a device that has never been configured syncs: markdown, canvas and Obsidian's
 * own file types (images, audio, video, PDF) everywhere in the vault, no config-folder
 * group, and the default 50 MB size cap.
 *
 * `configDir` is **empty**, and that means "this host has no config folder": the name is a
 * property of the app the vault belongs to (`Vault.configDir`, which a user can rename), so
 * the engine never guesses it. The plugin passes the real one; the CLI, which has no
 * Obsidian to ask, syncs no config folder at all — which is what it always did.
 */
export const DEFAULT_SYNC_SCOPE: SyncScope = {
  configDir: "",
  settingsGroups: NO_SETTINGS_GROUPS,
  fileTypes: DEFAULT_FILE_TYPES,
  excludedFolders: [],
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
};

/**
 * Normalize a stored excluded-folder list into the shape the engine compares against.
 *
 * Input comes from a settings field, a CLI flag or a hand-edited config file, so it can
 * be anything: non-strings are dropped, Windows separators become `/`, empty and `.`
 * segments disappear, and an entry containing `..` is rejected as a whole (a path that
 * climbs out of the vault is not a folder this device can name). The result is a fresh,
 * de-duplicated array that keeps the first occurrence's order — the settings page shows
 * the list as the user built it.
 */
export function normalizeExcludedFolders(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const folders: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const segments = raw
      .trim()
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => segment !== "" && segment !== ".");
    if (segments.length === 0 || segments.includes("..")) continue;
    const folder = segments.join("/");
    if (!folders.includes(folder)) folders.push(folder);
  }
  return folders;
}

/**
 * Whether `path` is one of `folders` or lives inside one — the excluded-folder rule
 * itself, without the scope around it.
 *
 * Exported separately because not every caller has a `SyncScope`: a host's display
 * layer greys the explorer rows from the list alone, and it has to agree with the
 * engine on what "inside an excluded folder" means. {@link isExcludedPath} is this
 * rule plus the scope; `isSyncablePath` is where it is applied to the vault (a path
 * inside the config folder is owned by a settings group, not by this list).
 */
export function isPathInExcludedFolders(path: string, folders: readonly string[]): boolean {
  return folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

/** Whether `path` is one of the scope's excluded folders or lives inside one. */
export function isExcludedPath(path: string, scope: SyncScope): boolean {
  return isPathInExcludedFolders(path, scope.excludedFolders);
}

/**
 * Files inside the config folder that are **never** synced, whatever the switches
 * say. They hold per-device or per-installation state:
 *
 * - `workspace.json` / `workspaces.json` / `workspace-mobile.json` — the window
 *   layout, rewritten every time a file is opened (Obsidian's own documentation
 *   recommends keeping them out of version control).
 * - `sync.json` / `ui-state.json` — Obsidian Sync's own bound-vault config and
 *   the UI state; both describe *this* installation.
 * - `core-plugins-migration.json` — bookkeeping for the core-plugin migration,
 *   which must not be replayed on another device.
 */
export const CONFIG_ALWAYS_EXCLUDED: readonly string[] = [
  "workspace.json",
  "workspaces.json",
  "workspace-mobile.json",
  "sync.json",
  "ui-state.json",
  "core-plugins-migration.json",
];

/**
 * This plugin's own folder inside the config folder.
 *
 * Its `data.json` carries the user key and the per-file sync state, so syncing it
 * would clone this device's credentials onto a peer and hand the server a second
 * writer under the same account.
 */
export const COURIER_PLUGIN_DIR = "plugins/courier";

/** Top-level config files with a group of their own; the rest fall to `corePluginSettings`. */
const NAMED_TOP_LEVEL_FILES: Record<string, SettingsGroup> = {
  "app.json": "app",
  "appearance.json": "appearance",
  "hotkeys.json": "hotkeys",
  "core-plugins.json": "corePlugins",
};

/**
 * A partially specified scope, as a host stores or passes it: the config folder
 * name is optional and each record may only carry the switches that host knows
 * about.
 */
export interface SyncScopeInput {
  configDir?: string;
  settingsGroups?: Partial<SettingsSyncGroups>;
  fileTypes?: Partial<FileTypeSync>;
  excludedFolders?: readonly string[];
  maxFileBytes?: number;
}

/** Fill in the defaults of a partially specified scope and normalize it. */
export function normalizeScope(scope?: SyncScopeInput): SyncScope {
  // No name means no config folder — see `DEFAULT_SYNC_SCOPE`. A host that has one passes it.
  const configDir = (scope?.configDir ?? "").replace(/^\/+|\/+$/g, "");
  const groups: SettingsSyncGroups = { ...NO_SETTINGS_GROUPS };
  for (const group of SETTINGS_GROUPS) {
    groups[group] = scope?.settingsGroups?.[group] === true;
  }
  // Unlike the config-folder groups, a file type that is missing or unknown keeps its
  // **default** (images and friends stay on) instead of reading as off: silently
  // turning off what the user expects to sync is worse than syncing a default.
  const fileTypes: FileTypeSync = { ...DEFAULT_FILE_TYPES };
  for (const group of FILE_TYPE_GROUPS) {
    const value = scope?.fileTypes?.[group];
    if (typeof value === "boolean") fileTypes[group] = value;
  }
  return {
    configDir,
    settingsGroups: groups,
    fileTypes,
    excludedFolders: normalizeExcludedFolders(scope?.excludedFolders),
    maxFileBytes: normalizeMaxFileBytes(scope?.maxFileBytes),
  };
}

/** A usable cap: a non-negative safe integer, or the default. `0` = no limit. */
function normalizeMaxFileBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_FILE_BYTES;
  if (!Number.isSafeInteger(value) || value < 0) return DEFAULT_MAX_FILE_BYTES;
  return value;
}

/**
 * Whether a file of `sizeBytes` is inside this device's cap. The pure half of the size
 * rule; the engine pairs it with `SyncAdapter.statFile` (local) and a version's
 * `sizeBytes` (remote).
 */
export function withinFileSizeCap(scope: SyncScope, sizeBytes: number): boolean {
  return scope.maxFileBytes === 0 || sizeBytes <= scope.maxFileBytes;
}

/** True when at least one config-folder group is switched on. */
export function syncsAnySettings(scope: SyncScope): boolean {
  return SETTINGS_GROUPS.some((group) => scope.settingsGroups[group]);
}

/** True when `path` is the config folder itself or lives inside it. */
export function isConfigPath(path: string, scope: SyncScope): boolean {
  return path === scope.configDir || path.startsWith(`${scope.configDir}/`);
}

/**
 * The path relative to the config folder, or null when `path` is outside it.
 * `""` means the config folder itself.
 */
function configRelativePath(path: string, scope: SyncScope): string | null {
  if (path === scope.configDir) return "";
  if (!path.startsWith(`${scope.configDir}/`)) return null;
  return path.slice(scope.configDir.length + 1);
}

/**
 * The group a config-folder path belongs to, or null when nothing may sync it.
 *
 * Every path has **exactly one** owner, which is what makes a switch predictable:
 * turning `themes` off keeps themes out even when `otherFiles` is on, because a
 * theme file is claimed by `themes` rather than falling through to the catch-all.
 */
export function settingsGroupOf(path: string, scope: SyncScope): SettingsGroup | null {
  const relative = configRelativePath(path, scope);
  if (relative === null || relative === "") return null;

  const segments = relative.split("/");
  // Hidden files and folders are not part of the vault on any host — with the
  // single exception of the config folder's own name, which is stripped above.
  // A dot-name *inside* the config folder is hidden like anywhere else.
  if (segments.some((segment) => segment.startsWith("."))) return null;

  if (CONFIG_ALWAYS_EXCLUDED.includes(relative)) return null;
  if (segments[0] === "cache") return null;
  if (relative === COURIER_PLUGIN_DIR || relative.startsWith(`${COURIER_PLUGIN_DIR}/`)) {
    return null;
  }

  if (relative === "community-plugins.json") return "communityPluginList";
  if (segments[0] === "plugins") return "communityPlugins";
  if (segments[0] === "themes") return "themes";
  if (segments[0] === "snippets") return "snippets";
  if (segments.length === 1) {
    const named = NAMED_TOP_LEVEL_FILES[relative];
    if (named) return named;
    if (relative.endsWith(".json")) return "corePluginSettings";
  }
  return "otherFiles";
}

/**
 * The one rule for "may this device sync this path".
 *
 * Applied by the engine to everything it learns about — the local listing, the
 * vault events a host feeds in, and the remote chains the server holds — so a
 * path the scope rejects can neither be pushed nor pulled nor conflict, no matter
 * what a host hands over.
 *
 * Ownership, in order:
 *
 * 1. `*.conflict.*` copies and any hidden (dot-prefixed) name never sync.
 * 2. A path inside the config folder belongs to exactly one **settings group**
 *    (`settingsGroupOf`); the file-type rules below do not apply there, so
 *    `.obsidian/plugins/x/icon.png` needs `communityPlugins`, not `images`.
 * 3. Anywhere else in the vault, a path in an **excluded folder** is left out
 *    entirely, and otherwise `fileTypeOf` names the category: markdown and canvas
 *    always sync, the switched-on categories sync, and everything unclaimed is
 *    `otherTypes` (off unless asked for).
 */
export function isSyncablePath(path: string, scope: SyncScope): boolean {
  if (!path || isConflictFile(path)) return false;

  if (configRelativePath(path, scope) === null) {
    // Outside the config folder: never inside a dot-folder. The config folder is the
    // single exception to "dot-folders are not synced".
    const segments = path.split("/");
    if (segments.some((segment) => segment.startsWith("."))) return false;
    if (isExcludedPath(path, scope)) return false;
    const kind = fileTypeOf(path);
    if (kind === "always") return true;
    return scope.fileTypes[kind] === true;
  }

  const group = settingsGroupOf(path, scope);
  return group !== null && scope.settingsGroups[group] === true;
}

/**
 * Why this device does not sync a path, named after the switch that owns the rule.
 *
 * Named after the switch, because "excluded" alone is not actionable: a file under an
 * excluded folder and a `.obsidian` group left off are two switches on the settings
 * page, a video over the size cap is the account's administrator-set limit, and a
 * `.zip` is none of them. `null` means this device does sync it.
 *
 * The reason is recovered by asking the narrower questions in the engine's own order
 * (`isSyncablePath` short-circuits, so the first false answer is the rule that fired):
 * a path inside the config folder is owned by a settings group and never by a folder
 * or a file type, and everywhere else a file type is only consulted once the folder
 * rules have passed. A switch reason wins over the size cap: raising the cap would
 * still not sync a path another rule leaves out.
 *
 * This lives beside `isSyncablePath` rather than in the plugin so the engine's skip
 * decision and the activity event it reports cannot disagree about which rule fired.
 */
export type SyncOutOfScopeReason = "folder" | "fileType" | "settingsGroup" | "size";

export function outOfScopeReason(
  path: string,
  scope: SyncScope,
  sizeBytes = 0,
): SyncOutOfScopeReason | null {
  if (!isSyncablePath(path, scope)) {
    if (isConfigPath(path, scope)) return "settingsGroup";
    if (isExcludedPath(path, scope)) return "folder";
    // Anything left is a category this device switched off — markdown and canvas have no
    // switch, so they cannot reach here, and a hidden path never has a history row (no
    // device syncs it, so no chain exists).
    return "fileType";
  }
  return withinFileSizeCap(scope, sizeBytes) ? null : "size";
}

/**
 * Whether a listing may descend into `path`.
 *
 * The pruning half of {@link isSyncablePath}, for adapters that have to walk the
 * config folder themselves: a folder this returns false for cannot contain a
 * syncable file, so its contents are never even enumerated (which is what keeps
 * the walk cheap — `plugins/`, `cache/` and the other dot-folders cost nothing
 * when their group is off).
 *
 * A known folder answers for its own group only. An unknown one can hold
 * `otherFiles`, so it is walked exactly when that group is on.
 */
export function isSyncableDir(path: string, scope: SyncScope): boolean {
  if (!path) return true; // the vault root

  const relative = configRelativePath(path, scope);
  if (relative === null) {
    if (isExcludedPath(path, scope)) return false;
    return !path.split("/").some((segment) => segment.startsWith("."));
  }
  if (!relative) return true; // the config folder itself

  const segments = relative.split("/");
  if (segments.some((segment) => segment.startsWith("."))) return false;

  if (segments[0] === "cache") return false;
  if (relative === COURIER_PLUGIN_DIR || relative.startsWith(`${COURIER_PLUGIN_DIR}/`)) {
    return false;
  }

  if (segments[0] === "plugins") return scope.settingsGroups.communityPlugins;
  if (segments[0] === "themes") return scope.settingsGroups.themes;
  if (segments[0] === "snippets") return scope.settingsGroups.snippets;
  return scope.settingsGroups.otherFiles;
}
