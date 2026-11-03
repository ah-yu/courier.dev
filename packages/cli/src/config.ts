import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import {
  MAX_HISTORY_LIMIT,
  normalizeDeviceName,
  type HistoryLimits,
  type UpdateVaultRequest,
} from "@courier/shared";
import { t } from "./i18n";
import {
  DEFAULT_FILE_TYPES,
  FILE_TYPE_GROUPS,
  NO_FILE_TYPES,
  normalizeExcludedFolders,
  normalizeScope,
  type FileTypeGroup,
  type FileTypeSync,
  type SyncScope,
} from "@courier/engine";

/**
 * One vault this machine syncs, as `vault connect` stored it.
 *
 * The vault id, its AES key and the local folder are one unit: a password re-derived for
 * another vault would silently decrypt nothing, and a local folder bound twice would put
 * two engines on the same files. Everything else on the binding is the device-local
 * sync scope.
 */
export interface CliVault {
  /** Remote vault id; also the key of this vault's persisted sync state. */
  vaultId: string;
  /** Absolute path of the local vault folder. */
  vaultPath: string;
  /**
   * The vault's name on the server, stored at connect so the daemon can say "工作笔记"
   * instead of the local folder's name. Absent on a binding made before it was stored.
   */
  vaultName?: string;
  /** Base64 32-byte AES vault key (derived at connect, stored locally). */
  encryptionKeyB64: string;
  /**
   * The label this binding's pushes state. Per vault, not per machine: two vaults on one
   * computer can carry different names. Absent only for a binding made before the field
   * existed, where `vaultDeviceName` falls back to the machine's name.
   */
  deviceName?: string;
  /**
   * Which vault-wide file types (besides markdown and canvas, which always sync) this
   * machine syncs. Absent = the defaults (images/audio/video/PDF on, other types off).
   */
  fileTypes?: Partial<FileTypeSync>;
  /**
   * Vault folders this machine leaves out of sync entirely. Absent = no exclusions.
   * Device-local like the records above — see `SyncScope`.
   */
  excludedFolders?: string[];
}

/** The label a binding's pushes state: its own name, or the machine's when it has none. */
export function vaultDeviceName(config: CliConfig, vault: CliVault): string {
  const own = vault.deviceName?.trim();
  return own && own.length > 0 ? own : config.deviceName;
}

/**
 * Persisted headless CLI configuration at `~/.courier-cli/config.json`.
 *
 * One user key and one server are shared by every vault on this machine; each binding
 * carries its own device label. The bindings are independent and each is synced by its
 * own daemon. Nothing here is registered with the server.
 */
export interface CliConfig {
  serverUrl: string;
  userKey: string;
  /** Label stated on every push; may be changed freely. */
  deviceName: string;
  /** Every vault this machine syncs. Empty until `vault connect`. */
  vaults: CliVault[];
  /**
   * The largest plaintext file this account's key may sync, in bytes (`0` = unlimited).
   *
   * A cache of what `GET /api/me` last reported, never a CLI/config setting: the
   * administrator sets it per key on the server, `register` and `vault connect`
   * write it, `run` and `status` read the server live (falling back to this cache
   * when it cannot be reached), and a host start applies whatever it read.
   */
  accountMaxFileBytes?: number;
}

/**
 * The scope a vault's host runs under.
 *
 * **No config-folder group, ever.** Obsidian's config folder is where a live Obsidian
 * keeps its settings, and the CLI is a headless replica: it cannot consume those files
 * and has no way to tell the user that one arrived (the plugin's reload card is that
 * surface). Leaving every group off keeps `.obsidian` out of this device's scope on
 * both ends, so the CLI neither pushes nor pulls settings, and the silent
 * modification-time rule for config-folder conflicts never runs here.
 */
export function syncScopeOf(vault: CliVault, maxFileBytes?: number): SyncScope {
  return normalizeScope({
    // Named explicitly: the CLI has no Obsidian to ask for one, and every group is off.
    configDir: "",
    fileTypes: vault.fileTypes,
    excludedFolders: vault.excludedFolders,
    maxFileBytes,
  });
}

/**
 * How the file types read in `status` output.
 *
 * Markdown and canvas are always listed first because they are not switchable — the
 * point of the line is to say what this machine moves, not which toggles are set.
 * The ids themselves stay untranslated; only the surrounding words and separators
 * follow the active language.
 */
export function describeFileTypes(vault: CliVault, maxFileBytes?: number): string {
  const scope = syncScopeOf(vault, maxFileBytes);
  const enabled = FILE_TYPE_GROUPS.filter((group) => scope.fileTypes[group]);
  const cap =
    scope.maxFileBytes === 0
      ? t("cli.status.cap.unlimited")
      : t("cli.status.cap.limited", { megabytes: formatMegabytes(scope.maxFileBytes) });
  const types = ["md", "canvas", ...enabled].join(t("common.listSeparator"));
  return t(enabled.length > 0 ? "cli.status.fileTypes.value" : "cli.status.fileTypes.valueOnly", {
    types,
    cap,
  });
}

/** How a stored excluded-folder list reads in `status` output: `(none)`, or the paths. */
export function describeExcludedFolderList(folders: readonly string[]): string {
  return folders.length === 0 ? t("common.none") : folders.join(t("common.listSeparator"));
}

/** How the excluded folders read in `status` output: `(none)`, or the paths. */
export function describeExcludedFolders(vault: CliVault): string {
  return describeExcludedFolderList(syncScopeOf(vault).excludedFolders);
}

/** How the two history limits read: `notes/canvas 200, attachments 10`. */
export function describeHistoryLimits(limits: HistoryLimits): string {
  return t("cli.status.historyLimit.value", {
    documents: limits.documents,
    attachments: limits.attachments,
  });
}

/** A byte count as whole megabytes, rounded up so a cap never reads as 0 MB. */
export function formatMegabytes(bytes: number): number {
  return Math.ceil(bytes / (1024 * 1024));
}

/**
 * Parse `--sync-file-types=<list>`: a comma-separated list of file-type ids.
 *
 * An empty list is meaningful: `--sync-file-types=` means "markdown and canvas only".
 * An unknown id throws with the valid names, for the same reason as above.
 */
export function parseFileTypes(list: string): FileTypeSync {
  const requested = list
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (requested.length === 0) return { ...NO_FILE_TYPES };

  const fileTypes: FileTypeSync = { ...NO_FILE_TYPES };
  for (const entry of requested) {
    if (!FILE_TYPE_GROUPS.includes(entry as FileTypeGroup)) {
      throw new Error(
        t("cli.config.error.unknownFileType", {
          name: entry,
          valid: FILE_TYPE_GROUPS.join(", "),
        }),
      );
    }
    fileTypes[entry as FileTypeGroup] = true;
  }
  return fileTypes;
}

/**
 * The file-type record `vault connect` should store, given what this binding already had
 * and the flags of this run.
 *
 * `--sync-file-types` (with or without a list) **replaces** the record — a bare flag means
 * the defaults, an explicit list means exactly those. `--sync-other-types` only adds the
 * catch-all, so it works on a machine that has never been configured. Running `vault
 * connect` without any of them keeps what is stored.
 */
export function fileTypesFromFlags(
  stored: Partial<FileTypeSync> | undefined,
  flags: { syncFileTypes?: string | boolean; syncOtherTypes?: boolean },
): FileTypeSync {
  let fileTypes = normalizeScope({ fileTypes: stored }).fileTypes;

  if (flags.syncFileTypes !== undefined && flags.syncFileTypes !== false) {
    fileTypes =
      typeof flags.syncFileTypes === "string"
        ? parseFileTypes(flags.syncFileTypes)
        : { ...DEFAULT_FILE_TYPES };
  }

  if (flags.syncOtherTypes) fileTypes.otherTypes = true;
  return fileTypes;
}

/**
 * The excluded-folder list `vault connect` should store.
 *
 * `--exclude-folders=<list>` **replaces** the record: an explicit list is exactly those
 * folders, and an empty one (`--exclude-folders=`) clears it. Omitting the flag keeps
 * what an earlier connect stored, the same rule the file-type flags follow. Each entry
 * goes through the engine's normalizer, so `private\sub/` and `private/sub` are one
 * folder.
 */
export function excludedFoldersFromFlags(
  stored: readonly string[] | undefined,
  flags: { excludeFolders?: string },
): string[] {
  if (flags.excludeFolders === undefined) return normalizeExcludedFolders(stored);
  return normalizeExcludedFolders(flags.excludeFolders.split(","));
}

/**
 * Parse `--history-limit-documents` / `--history-limit-attachments`: a whole number of
 * versions between 1 and {@link MAX_HISTORY_LIMIT}.
 *
 * Refused rather than clamped: a typo would otherwise silently change how much history a
 * vault keeps, which is the one outcome a user cannot notice — and `0` would read as
 * "keep only the newest version", deleting history nobody asked to delete.
 */
export function parseHistoryLimit(value: string): number {
  const trimmed = value.trim();
  const limit = Number(trimmed);
  if (trimmed === "" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
    throw new Error(t("cli.config.error.historyLimit", { value, max: MAX_HISTORY_LIMIT }));
  }
  return limit;
}

/**
 * The `PATCH /api/vaults/:id` body for a command's history-limit flags, or null when
 * neither flag was given.
 *
 * The limits are **vault-level server state** (shared by every device of the vault), so
 * the flags become a request rather than a local record. Each flag states only its own
 * field: a user who raises the attachment limit must not resend the notes one.
 */
export function historyLimitPatchFromFlags(flags: {
  historyLimitDocuments?: string;
  historyLimitAttachments?: string;
}): UpdateVaultRequest | null {
  const patch: UpdateVaultRequest = {};
  if (flags.historyLimitDocuments !== undefined) {
    patch.historyLimitDocuments = parseHistoryLimit(flags.historyLimitDocuments);
  }
  if (flags.historyLimitAttachments !== undefined) {
    patch.historyLimitAttachments = parseHistoryLimit(flags.historyLimitAttachments);
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/** The CLI's configuration directory, shared by every vault on this machine. */
export function configDir(): string {
  return process.env.COURIER_CLI_CONFIG_DIR ?? path.join(homedir(), ".courier-cli");
}

/**
 * Where one vault's per-file sync state lives.
 *
 * The state maps local paths to `fileId`s **in one vault's chain**, so it must be keyed by
 * the remote vault and never shared. The id is hashed rather than used as a file name:
 * ids come from the server, and a path separator in one must not escape this directory.
 */
export function statePath(vaultId: string): string {
  return path.join(configDir(), "state", `${vaultKey(vaultId)}.json`);
}

/**
 * The record that says the vault is fully bound, beside its state file.
 *
 * It is deliberately **not** inside the state JSON: that file is the engine's
 * `localVersions` map keyed by fileId, and a marker key there would be read as a chain.
 * A bind killed after persisting part of the vault leaves the state non-empty; this
 * sibling is what tells the next daemon that the vault is still only half-bound (see
 * `SyncStateStore.loadBindCompleted`).
 */
export function bindStatePath(vaultId: string): string {
  return path.join(configDir(), "state", `${vaultKey(vaultId)}.bind.json`);
}

/** The vault id as a safe file-name segment. The id comes from the server. */
function vaultKey(vaultId: string): string {
  return new Bun.CryptoHasher("sha256").update(vaultId).digest("hex").slice(0, 24);
}

/**
 * Read the stored config, or null when there is none **or it cannot be used**.
 *
 * A hand-edited or truncated file used to be cast straight to `CliConfig`, so
 * `undefined` fields reached the client — `Authorization: Bearer undefined`, a
 * `vaultPath` that is not a string, a device name of any length. A file this machine
 * cannot trust is treated as "not configured", the same answer as no file at all.
 */
export function loadConfig(): CliConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath(), "utf-8"));
  } catch {
    return null;
  }
  return normalizeCliConfig(parsed);
}

/** Text from disk, or null for an empty/non-string value. */
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Validate what came off disk. The two credentials have to be usable strings. */
export function normalizeCliConfig(raw: unknown): CliConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const serverUrl = text(record.serverUrl);
  const userKey = text(record.userKey);
  if (!serverUrl || !userKey) return null;

  return {
    serverUrl,
    userKey,
    deviceName: normalizeDeviceName(text(record.deviceName) ?? undefined),
    vaults: normalizeVaults(record.vaults),
    accountMaxFileBytes:
      typeof record.accountMaxFileBytes === "number" ? record.accountMaxFileBytes : undefined,
  };
}

/** The stored bindings, dropping entries that cannot be used. */
function normalizeVaults(raw: unknown): CliVault[] {
  if (!Array.isArray(raw)) return [];
  const vaults: CliVault[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const vaultId = text(record.vaultId);
    const vaultPath = text(record.vaultPath);
    const encryptionKeyB64 = text(record.encryptionKeyB64);
    if (!vaultId || !vaultPath || !encryptionKeyB64) continue;
    vaults.push({
      vaultId,
      vaultPath,
      vaultName: text(record.vaultName) ?? undefined,
      encryptionKeyB64,
      deviceName: text(record.deviceName) ?? undefined,
      fileTypes: fileTypesOf(record.fileTypes),
      excludedFolders: excludedFoldersOf(record.excludedFolders),
    });
  }
  return vaults;
}

/** The stored file-type record, ignoring anything that is not a boolean. */
function fileTypesOf(raw: unknown): Partial<FileTypeSync> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const types: Partial<FileTypeSync> = {};
  for (const group of FILE_TYPE_GROUPS) {
    if (typeof record[group] === "boolean") types[group] = record[group] as boolean;
  }
  return types;
}

/** The stored excluded-folder list, normalized; absent or empty means no exclusions. */
function excludedFoldersOf(raw: unknown): string[] | undefined {
  const folders = normalizeExcludedFolders(raw);
  return folders.length > 0 ? folders : undefined;
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(path.dirname(configPath()), { recursive: true });
  writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Remove the stored configuration (logout). The caller clears the per-vault state first:
 * a config is what makes those state files reachable, and a logout drops both.
 */
export function clearConfig(): void {
  try {
    unlinkSync(configPath());
  } catch {
    // Already absent.
  }
}

export function loadState(vaultId: string): string | null {
  try {
    return readFileSync(statePath(vaultId), "utf-8");
  } catch {
    return null;
  }
}

export function saveState(vaultId: string, json: string): void {
  mkdirSync(path.dirname(statePath(vaultId)), { recursive: true });
  writeFileSync(statePath(vaultId), json, "utf-8");
}

/**
 * Whether a bind pass for this vault has ever completed on this machine.
 *
 * False is "this device and the remote have not finished meeting", which is what makes
 * the next daemon's first pass a real first sync, however much state a killed bind left.
 */
export function loadBindCompleted(vaultId: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(bindStatePath(vaultId), "utf-8")) as unknown;
    return (parsed as { bindCompleted?: unknown } | null)?.bindCompleted === true;
  } catch {
    return false;
  }
}

/** Record that a bind pass completed; written once per binding. */
export function saveBindCompleted(vaultId: string): void {
  mkdirSync(path.dirname(bindStatePath(vaultId)), { recursive: true });
  writeFileSync(bindStatePath(vaultId), JSON.stringify({ bindCompleted: true }), "utf-8");
}

/** Drop one vault's sync state (disconnect, or a binding that no longer exists). */
export function clearState(vaultId: string): void {
  for (const target of [statePath(vaultId), bindStatePath(vaultId)]) {
    try {
      unlinkSync(target);
    } catch {
      // Already absent.
    }
  }
}

/** Drop every binding's state, used when the server (and so the fileId space) changes. */
export function clearAllState(vaults: readonly CliVault[]): void {
  for (const vault of vaults) clearState(vault.vaultId);
}

/**
 * A path in the form two bindings are compared with: absolute, forward slashes, and the
 * platform's case rules. Two vaults whose folders overlap would put two engines on the
 * same files, which is the one thing the daemon must never do.
 */
export function vaultPathKey(vaultPath: string): string {
  let resolved = path.resolve(vaultPath).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32" || process.platform === "darwin") {
    resolved = resolved.toLowerCase();
  }
  return resolved;
}

/** Whether two vault folders are the same or one contains the other. */
export function vaultPathsOverlap(left: string, right: string): boolean {
  const a = vaultPathKey(left);
  const b = vaultPathKey(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/**
 * The first pair of bindings whose folders overlap, if any. Used by `vault connect` and
 * by the daemon before it builds a host, so a hand-edited config cannot put two engines
 * on one folder either.
 */
export function overlappingVaults(vaults: readonly CliVault[]): [CliVault, CliVault] | null {
  for (let left = 0; left < vaults.length; left += 1) {
    for (let right = left + 1; right < vaults.length; right += 1) {
      if (vaultPathsOverlap(vaults[left]!.vaultPath, vaults[right]!.vaultPath)) {
        return [vaults[left]!, vaults[right]!];
      }
    }
  }
  return null;
}

/** A stable, human-readable name for a binding, used in logs and status headings. */
export function vaultLabel(vault: Pick<CliVault, "vaultId" | "vaultPath" | "vaultName">): string {
  const name = vault.vaultName?.trim();
  if (name && name.length > 0) return name;
  const base = path.basename(vault.vaultPath.replace(/[\\/]+$/, ""));
  return base || vault.vaultId;
}

/** The binding for one remote vault, or null. */
export function findVault(config: CliConfig, vaultId: string): CliVault | null {
  return config.vaults.find((vault) => vault.vaultId === vaultId) ?? null;
}
