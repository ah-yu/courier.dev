import { FILE_TYPE_GROUPS, type SyncLeaseInfo } from "@courier/engine";
import type { HistoryLimits } from "@courier/shared";
import {
  describeExcludedFolderList,
  describeHistoryLimits,
  formatMegabytes,
  syncScopeOf,
  vaultDeviceName,
  vaultLabel,
  type CliConfig,
  type CliVault,
} from "./config";
import type { Coexistence } from "./coexistence";
import { plural, t } from "./i18n";
import type { DaemonStatus } from "./runtime";
import { VERSION } from "./version";

/**
 * What `courier-cli status` reports, and how it is rendered.
 *
 * Each vault is synced by its own process, so the machine answer is a **list**: the
 * server and device are shared, and every vault carries its own scope, conflicts and
 * daemon. `buildStatusReport` stays language-independent (`fileTypes` is still ids, the
 * cap a byte count); only `formatStatusLines` follows the active language.
 *
 * The conflict files are the part that matters most on a headless machine: they never
 * sync, so this list is the only place a resolved conflict is visible without Obsidian.
 * The same goes for a file too large to sync.
 */
export interface CliVaultSummary {
  vaultId: string;
  vaultPath: string;
  /** The vault's name on the server, stored at connect; "" when it was never recorded. */
  vaultName: string;
  /** The label this binding stamps on its pushes (its own, or the machine's). */
  deviceName: string;
  /** Whether this vault's per-file sync state file exists. */
  hasState: boolean;
  /** This vault's enabled file types (markdown/canvas are implicit). */
  fileTypes: string[];
  /** The account's size cap in bytes; `0` means unlimited. Same for every vault. */
  maxFileBytes: number;
  /**
   * The vault's retention limits, as the server reported them; `null` when it could not
   * be read (an offline machine still has to render a status block).
   */
  historyLimits: HistoryLimits | null;
  excludedFolders: string[];
  oversizeFiles: string[];
  conflictFiles: string[];
}

/** One vault in the report, with the process that is (or is not) syncing it. */
export interface CliVaultStatus extends CliVaultSummary {
  daemon: DaemonStatus;
  /** The current writer, if any. First come, first served. */
  lease: SyncLeaseInfo | null;
  /** Observation only; it does not decide who writes. */
  coexistence: Coexistence;
}

/** The whole `status --json` document. */
export interface CliStatusReport {
  serverUrl: string;
  deviceName: string;
  /**
   * Set when this CLI cannot work with the server it is configured for.
   *
   * `status` already asks the server for the account's file cap and the vaults' retention
   * limits, so the generation arrives on the same trip; it is `null` when the server could
   * not be reached, because a status block must still render offline. This is the one place
   * a headless user sees *why* the daemon keeps exiting without reading the journal.
   */
  contractIssue?: ContractIssue | null;
  vaults: CliVaultStatus[];
}

/** Which side is too old, and what the server calls itself. */
export interface ContractIssue {
  verdict: "client-too-old" | "server-too-old";
  server: string;
}

/** What the command already read for one vault. */
export interface VaultStatusInput {
  vault: CliVault;
  state: string | null;
  conflictFiles: string[];
  oversizeFiles?: string[];
  /**
   * The vault's retention limits, from the server (`GET /api/vaults`); omitted or `null`
   * when the read was impossible — a status block must still render offline.
   */
  historyLimits?: HistoryLimits | null;
  daemon: DaemonStatus;
  lease: SyncLeaseInfo | null;
  coexistence: Coexistence;
}

/**
 * Build one vault's summary from what the command already read off disk.
 *
 * `state` is the raw persisted sync state (or `null` when this vault has never synced):
 * only its presence is reported, never its contents. This function does not call `t`:
 * its result is serialized verbatim by `--json`.
 */
export function buildVaultSummary(
  config: CliConfig,
  vault: CliVault,
  state: string | null,
  conflictFiles: string[],
  oversizeFiles: string[] = [],
  historyLimits: HistoryLimits | null = null,
): CliVaultSummary {
  const scope = syncScopeOf(vault, config.accountMaxFileBytes);
  return {
    vaultId: vault.vaultId,
    vaultPath: vault.vaultPath,
    vaultName: vault.vaultName ?? "",
    deviceName: vaultDeviceName(config, vault),
    hasState: state !== null,
    fileTypes: FILE_TYPE_GROUPS.filter((group) => scope.fileTypes[group]),
    maxFileBytes: scope.maxFileBytes,
    historyLimits,
    excludedFolders: scope.excludedFolders,
    oversizeFiles,
    conflictFiles,
  };
}

/** Build the full report from one read per vault. */
export function buildStatusReport(
  config: CliConfig,
  vaults: readonly VaultStatusInput[],
  contractIssue: ContractIssue | null = null,
): CliStatusReport {
  return {
    serverUrl: config.serverUrl,
    deviceName: config.deviceName,
    contractIssue,
    vaults: vaults.map((input) => ({
      ...buildVaultSummary(
        config,
        input.vault,
        input.state,
        input.conflictFiles,
        input.oversizeFiles ?? [],
        input.historyLimits ?? null,
      ),
      daemon: input.daemon,
      lease: input.lease,
      coexistence: input.coexistence,
    })),
  };
}

/**
 * A string's width in terminal columns.
 *
 * CJK characters and full-width punctuation occupy two columns, so padding with
 * `String.length` would misalign the Chinese table. The ranges cover the CJK
 * ideographs, Hangul, kana, Yi, CJK compatibility, full-width forms and the
 * full-width punctuation block used by the catalogs.
 */
const WIDE_CHAR =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/** The terminal display width of one string (wide characters count as two). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) width += WIDE_CHAR.test(character) ? 2 : 1;
  return width;
}

/**
 * The human-readable form: a shared header and then one block per vault.
 *
 * `--json` is the machine interface; this is what a person running `status` in a
 * terminal reads, so the labels, the "nothing here" cases and the language all follow
 * the active catalog. The column width is computed from the rendered labels, which is
 * what keeps each block aligned in Chinese as well as English.
 */
export function formatStatusLines(report: CliStatusReport): string[] {
  const lines: string[] = [];
  const headerRows: Array<[string, string]> = [
    [t("cli.status.label.server"), report.serverUrl],
    [t("cli.status.label.device"), report.deviceName],
    [t("cli.status.label.vaults"), t("cli.status.vaults.count", { count: report.vaults.length })],
  ];
  if (report.contractIssue) {
    const { verdict, server } = report.contractIssue;
    headerRows.push([
      t("cli.status.label.contract"),
      t(
        verdict === "client-too-old"
          ? "cli.status.contract.clientTooOld"
          : "cli.status.contract.serverTooOld",
        { server, cli: VERSION },
      ),
    ]);
  }
  lines.push(...renderRows(headerRows));

  if (report.vaults.length === 0) {
    lines.push(t("cli.status.hintNotBound"));
    return lines;
  }

  for (const vault of report.vaults) {
    const rows: Array<[string, string]> = [
      [t("cli.status.label.vault"), `${vaultLabel(vault)} (${vault.vaultId})`],
      [t("cli.status.label.path"), vault.vaultPath],
      [t("cli.status.label.device"), vault.deviceName],
      [t("cli.status.label.lease"), describeLease(vault.lease)],
      [t("cli.status.label.daemon"), describeDaemon(vault.daemon)],
      [t("cli.status.label.obsidian"), describeCoexistence(vault.coexistence)],
      [
        t("cli.status.label.state"),
        vault.hasState ? t("cli.status.value.tracked") : t("cli.status.value.noState"),
      ],
      [t("cli.status.label.fileTypes"), describeFileTypeLine(vault)],
      [
        t("cli.status.label.historyLimit"),
        vault.historyLimits
          ? describeHistoryLimits(vault.historyLimits)
          : t("cli.status.historyLimit.unknown"),
      ],
      [t("cli.status.label.excluded"), describeExcludedFolderList(vault.excludedFolders)],
      [t("cli.status.label.conflicts"), describeConflicts(vault.conflictFiles)],
    ];
    if (vault.oversizeFiles.length > 0) {
      rows.push([t("cli.status.label.tooLarge"), describeOversize(vault.oversizeFiles)]);
    }
    lines.push("", ...renderRows(rows));
  }
  lines.push("", `${t("cli.status.label.hint")}: ${t("cli.status.hintWithDaemon")}`);
  return lines;
}

/** Render one block with its labels padded to a common width. */
function renderRows(rows: Array<[string, string]>): string[] {
  const column = Math.max(...rows.map(([label]) => displayWidth(`${label}:`))) + 1;
  return rows.map(([label, value]) => line(label, value, column));
}

/** What this vault's daemon is doing, from its pid and its own record. */
function describeDaemon(daemon: DaemonStatus): string {
  if (!daemon.running) return t("cli.status.daemon.stopped");
  const pid = daemon.pid ?? 0;
  switch (daemon.phase) {
    case "starting":
      return t("cli.status.daemon.starting", { pid });
    case "waiting":
      return t("cli.status.daemon.otherWriter", { pid });
    case "stopped":
      return t("cli.status.daemon.failed", { pid, error: daemon.lastError ?? "" });
    default:
      return daemon.lastActivityAt
        ? t("cli.status.daemon.runningSince", { pid, time: formatClock(daemon.lastActivityAt) })
        : t("cli.status.daemon.running", { pid });
  }
}

/** Who holds the writer lease right now; this is the authority, not the observation. */
function describeLease(lease: SyncLeaseInfo | null): string {
  if (!lease) return t("cli.status.lease.free");
  return lease.owner === "cli"
    ? t("cli.status.lease.cli", { pid: lease.pid })
    : t("cli.status.lease.plugin");
}

/** What Obsidian is doing, for the operator's context only. */
function describeCoexistence(coexistence: Coexistence): string {
  if (!coexistence.obsidianOpen) return t("cli.status.obsidian.closed");
  return coexistence.pluginSyncActive
    ? t("cli.status.obsidian.plugin")
    : t("cli.status.obsidian.pluginOff");
}

/** A stored RFC 3339 instant as local wall-clock time, or the raw value if unparseable. */
function formatClock(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** Markdown and canvas always sync; the switched-on types follow, then the cap. */
function describeFileTypeLine(summary: CliVaultSummary): string {
  const cap =
    summary.maxFileBytes === 0
      ? t("cli.status.cap.unlimited")
      : t("cli.status.cap.limited", { megabytes: formatMegabytes(summary.maxFileBytes) });
  const types = ["md", "canvas", ...summary.fileTypes].join(t("common.listSeparator"));
  return t(
    summary.fileTypes.length > 0 ? "cli.status.fileTypes.value" : "cli.status.fileTypes.valueOnly",
    { types, cap },
  );
}

function line(label: string, value: string, column: number): string {
  const head = `${label}:`;
  const padding = Math.max(0, column - displayWidth(head));
  return `${head}${" ".repeat(padding)} ${value}`;
}

/** "(none)", or how many files were parked and where they are. */
function describeConflicts(conflictFiles: string[]): string {
  if (conflictFiles.length === 0) return t("common.none");
  return plural("cli.status.conflicts.one", "cli.status.conflicts.other", conflictFiles.length, {
    files: conflictFiles.join(t("common.listSeparator")),
  });
}

/** How many files the cap keeps out, and which — a video silently missing is the failure mode. */
function describeOversize(oversizeFiles: string[]): string {
  return plural("cli.status.tooLarge.one", "cli.status.tooLarge.other", oversizeFiles.length, {
    files: oversizeFiles.join(t("common.listSeparator")),
  });
}
