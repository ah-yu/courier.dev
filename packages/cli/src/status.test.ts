import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_FILE_BYTES } from "@courier/engine";
import { DEFAULT_HISTORY_LIMITS, type HistoryLimits } from "@courier/shared";
import { setLocale } from "./i18n";
import {
  buildStatusReport,
  buildVaultSummary,
  displayWidth,
  formatStatusLines,
  type VaultStatusInput,
} from "./status";
import type { CliConfig, CliVault } from "./config";
import type { Coexistence } from "./coexistence";
import type { DaemonStatus } from "./runtime";

/**
 * `courier-cli status` is the only place a headless machine reports what a conflict left
 * behind, and `--json` is what a supervisor's CLI view parses. Each vault has its own
 * process, scope and state, so the report is a list; the summary and its human form live
 * in `status.ts` so both can be pinned without spawning the binary.
 */

function vault(overrides: Partial<CliVault> = {}): CliVault {
  return {
    vaultId: "vault-1",
    vaultPath: "/mnt/vault",
    encryptionKeyB64: "a2V5",
    ...overrides,
  };
}

function config(vaults: CliVault[] = [vault()], overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    serverUrl: "http://vps.example.com",
    userKey: "ck_test",
    deviceName: "headless",
    vaults,
    ...overrides,
  };
}

const stoppedDaemon: DaemonStatus = {
  running: false,
  pid: null,
  startedAt: null,
  updatedAt: null,
  phase: null,
  reason: null,
  lastActivityAt: null,
  lastError: null,
  firstSync: false,
  progress: null,
};

const parkedDaemon: DaemonStatus = {
  running: true,
  pid: 4242,
  startedAt: "2026-10-21T08:00:00.000Z",
  updatedAt: "2026-10-21T08:01:00.000Z",
  phase: "waiting",
  reason: "other-writer",
  lastActivityAt: "2026-10-21T08:00:59.000Z",
  lastError: null,
  firstSync: false,
  progress: null,
};

const observedByObsidian: Coexistence = {
  obsidianOpen: true,
  pluginSyncActive: true,
  reason: "obsidian-plugin",
};

const cliOwns: Coexistence = {
  obsidianOpen: false,
  pluginSyncActive: false,
  reason: "obsidian-closed",
};

function input(
  target: CliVault,
  overrides: Partial<Omit<VaultStatusInput, "vault">> = {},
): VaultStatusInput {
  return {
    vault: target,
    state: "{}",
    conflictFiles: [],
    daemon: stoppedDaemon,
    lease: null,
    coexistence: cliOwns,
    ...overrides,
  };
}

afterEach(() => {
  setLocale("en");
});

describe("buildVaultSummary", () => {
  it("reports this vault's folder, scope and state", () => {
    const summary = buildVaultSummary(config(), vault(), "{}", []);

    expect(summary).toEqual({
      vaultId: "vault-1",
      vaultPath: "/mnt/vault",
      vaultName: "",
      deviceName: "headless",
      hasState: true,
      fileTypes: ["images", "video", "audio", "pdf"],
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
      // The limits are the vault's, so a summary built without a server read has none —
      // it is `null` rather than the default numbers, which would be a guess.
      historyLimits: null,
      excludedFolders: [],
      oversizeFiles: [],
      conflictFiles: [],
    });
    expect(new Set(Object.keys(JSON.parse(JSON.stringify(summary))))).toEqual(
      new Set([
        "vaultId",
        "vaultPath",
        "vaultName",
        "deviceName",
        "hasState",
        "fileTypes",
        "maxFileBytes",
        "historyLimits",
        "excludedFolders",
        "oversizeFiles",
        "conflictFiles",
      ]),
    );
  });

  it("carries the vault's limits when the server read succeeded", () => {
    expect(
      buildVaultSummary(config(), vault(), "{}", [], [], { documents: 500, attachments: 3 })
        .historyLimits,
    ).toEqual({ documents: 500, attachments: 3 });
  });

  it("says so when this vault has never synced", () => {
    expect(buildVaultSummary(config(), vault(), null, []).hasState).toBe(false);
  });

  it("carries the parked conflict files through untouched", () => {
    const parked = [
      "notes/plan-2026-02-14-101530.conflict.md",
      "plan-2026-02-14-101530-2.conflict.md",
    ];
    expect(buildVaultSummary(config(), vault(), "{}", parked).conflictFiles).toEqual(parked);
  });
});

describe("buildStatusReport", () => {
  it("shares the server and device, and keeps one entry per vault", () => {
    const first = vault({ vaultId: "v1", vaultPath: "/mnt/one" });
    const second = vault({ vaultId: "v2", vaultPath: "/mnt/two" });
    const report = buildStatusReport(config([first, second]), [
      input(first),
      input(second, { state: null, daemon: parkedDaemon, coexistence: observedByObsidian }),
    ]);

    expect(report.serverUrl).toBe("http://vps.example.com");
    expect(report.deviceName).toBe("headless");
    expect(report.vaults.map((entry) => entry.vaultId)).toEqual(["v1", "v2"]);
    expect(report.vaults[0]!.daemon).toBe(stoppedDaemon);
    expect(report.vaults[1]).toMatchObject({
      hasState: false,
      daemon: parkedDaemon,
      coexistence: observedByObsidian,
    });
    // The JSON a supervisor parses is this object verbatim.
    expect(new Set(Object.keys(JSON.parse(JSON.stringify(report))))).toEqual(
      new Set(["serverUrl", "deviceName", "contractIssue", "vaults"]),
    );
    expect(new Set(Object.keys(report.vaults[0]!))).toEqual(
      new Set([
        "vaultId",
        "vaultPath",
        "vaultName",
        "deviceName",
        "hasState",
        "fileTypes",
        "maxFileBytes",
        "historyLimits",
        "excludedFolders",
        "oversizeFiles",
        "conflictFiles",
        "daemon",
        "lease",
        "coexistence",
      ]),
    );
  });
});

describe("formatStatusLines", () => {
  it("renders the shared header and one block per vault", () => {
    const lines = formatStatusLines(
      buildStatusReport(config([vault()]), [
        input(vault(), { conflictFiles: [], historyLimits: DEFAULT_HISTORY_LIMITS }),
      ]),
    );

    expect(lines).toEqual([
      "Server:  http://vps.example.com",
      "Device:  headless",
      "Vaults:  1",
      "",
      "Vault:       vault (vault-1)",
      "Path:        /mnt/vault",
      "Device:      headless",
      "Lease:       free (first come, first served)",
      "Daemon:      not running",
      "Obsidian:    not open; the CLI owns sync",
      "State:       tracked",
      "File types:  md, canvas, images, video, audio, pdf (max 50 MB, admin-set)",
      "History:     notes/canvas 200, attachments 10",
      "Excluded:    (none)",
      "Conflicts:   (none)",
      "",
      "Hint: each vault runs in its own process: start one with `courier-cli run --vault <id>`; the first process to take the vault's lease syncs it, and the other waits.",
    ]);
    // One column per block, so every label/value pair aligns.
    const block = lines.slice(4, 14);
    const widths = block.map((line) => displayWidth(/^\S+[^:]*: +/.exec(line)![0]));
    expect([...new Set(widths)]).toEqual([13]);
  });

  it("adds one row when this CLI cannot talk to the server, and names the side to move", () => {
    const rows = (verdict: "client-too-old" | "server-too-old"): string[] =>
      formatStatusLines(
        buildStatusReport(config([vault()]), [input(vault())], { verdict } as never),
      );

    const older = rows("server-too-old").find((line) => line.startsWith("Compatibility:"));
    expect(older).toContain("upgrade");
    const tooOld = rows("client-too-old").find((line) => line.startsWith("Compatibility:"));
    expect(tooOld).toContain("courier-cli");
    // A matched pair says nothing: the row exists only to explain a refusal.
    expect(
      formatStatusLines(buildStatusReport(config([vault()]), [input(vault())])).some((line) =>
        line.startsWith("Compatibility:"),
      ),
    ).toBe(false);
  });

  it("reads the history row from the server's answer, or says it could not", () => {
    const line = (historyLimits: HistoryLimits | null): string =>
      formatStatusLines(buildStatusReport(config(), [input(vault(), { historyLimits })])).find(
        (candidate) => candidate.startsWith("History:"),
      )!;

    expect(line({ documents: 200, attachments: 10 })).toBe(
      "History:     notes/canvas 200, attachments 10",
    );
    expect(line({ documents: 500, attachments: 3 })).toBe(
      "History:     notes/canvas 500, attachments 3",
    );
    // The value is the vault's, so an unreachable server cannot be answered from a local
    // copy — the row says so instead of printing a number nobody holds.
    expect(line(null)).toBe("History:     (not readable from the server)");
  });

  it("renders the starting, stopped and activity states a status read can meet", () => {
    const line = (daemon: DaemonStatus): string =>
      formatStatusLines(buildStatusReport(config(), [input(vault(), { daemon })])).find(
        (candidate) => candidate.startsWith("Daemon:"),
      )!;
    const running = { ...stoppedDaemon, running: true, pid: 77 };

    expect(line({ ...running, phase: "starting" })).toBe("Daemon:      starting (PID 77)");
    // A revoked key writes `stopped` and then drains before the record is cleared, so a
    // status read in that window still sees the pid and reports why it stopped.
    expect(line({ ...running, phase: "stopped", lastError: "key revoked" })).toBe(
      "Daemon:      stopped (PID 77): key revoked",
    );
    expect(line({ ...running, phase: "syncing", lastActivityAt: null })).toBe(
      "Daemon:      running (PID 77)",
    );
    // An unparseable activity stamp is shown verbatim rather than crashing the row.
    expect(line({ ...running, phase: "syncing", lastActivityAt: "not a time" })).toBe(
      "Daemon:      running (PID 77), last activity at not a time",
    );
  });

  it("shows each vault's own lease and daemon state", () => {
    const first = vault({ vaultId: "v1", vaultPath: "/mnt/one" });
    const second = vault({ vaultId: "v2", vaultPath: "/mnt/two" });
    const pluginLease = {
      version: 1 as const,
      owner: "plugin" as const,
      token: "plugin-token",
      pid: 0,
      acquiredAt: "2026-10-21T08:00:00.000Z",
      updatedAt: "2026-10-21T08:01:00.000Z",
      expiresAt: Date.parse("2026-10-21T08:01:20.000Z"),
    };
    const lines = formatStatusLines(
      buildStatusReport(config([first, second]), [
        input(first, {
          daemon: parkedDaemon,
          lease: pluginLease,
          coexistence: observedByObsidian,
        }),
        input(second, { daemon: stoppedDaemon, coexistence: cliOwns }),
      ]),
    );
    const rendered = lines.join("\n");

    expect(rendered).toContain("Vault:       one (v1)");
    expect(rendered).toContain("Vault:       two (v2)");
    expect(rendered).toContain("Lease:       Obsidian plugin");
    expect(rendered).toContain(
      "Daemon:      waiting for another syncer to release the lease (PID 4242)",
    );
    expect(rendered).toContain("Obsidian:    open and the Courier plugin is set up to sync");
    expect(rendered).toContain("Daemon:      not running");
  });

  it("reads the file-type line as a list, with the cap that is in force", () => {
    const fileTypes = (cap: number, extra: Partial<CliVault> = {}) =>
      formatStatusLines(
        buildStatusReport(config([vault(extra)], { accountMaxFileBytes: cap }), [
          input(vault(extra)),
        ]),
      ).find((line) => line.startsWith("File types"));

    expect(
      fileTypes(50 << 20, { fileTypes: { images: false, video: false, audio: false, pdf: false } }),
    ).toBe("File types:  md, canvas only (max 50 MB, admin-set)");
    expect(fileTypes(50 << 20, { fileTypes: { otherTypes: true } })).toBe(
      "File types:  md, canvas, images, video, audio, pdf, otherTypes (max 50 MB, admin-set)",
    );
    expect(fileTypes(0)).toBe(
      "File types:  md, canvas, images, video, audio, pdf (max unlimited, admin-set)",
    );
    expect(fileTypes(200 << 20)).toBe(
      "File types:  md, canvas, images, video, audio, pdf (max 200 MB, admin-set)",
    );
  });

  it("reads the excluded-folder line as (none) or the paths", () => {
    const line = (extra: Partial<CliVault>) =>
      formatStatusLines(buildStatusReport(config([vault(extra)]), [input(vault(extra))])).find(
        (candidate) => candidate.startsWith("Excluded"),
      );

    expect(line({})).toBe("Excluded:    (none)");
    expect(line({ excludedFolders: ["private", "drafts/sub"] })).toBe(
      "Excluded:    private, drafts/sub",
    );
  });

  it("names the files the size cap keeps out and the conflicts parked", () => {
    const lines = formatStatusLines(
      buildStatusReport(config(), [
        input(vault(), {
          conflictFiles: [
            "plan-2026-02-14-101530.conflict.md",
            "notes/other-2026-02-14-101530.conflict.md",
          ],
          oversizeFiles: ["media/raw.mov", "media/take.mkv"],
        }),
      ]),
    );

    expect(lines).toContain(
      "Conflicts:   2 parked files: plan-2026-02-14-101530.conflict.md, notes/other-2026-02-14-101530.conflict.md",
    );
    expect(lines).toContain("Too large:   2 files over the cap: media/raw.mov, media/take.mkv");
    // Nothing to say when nothing is over the cap — the line is not merely empty.
    expect(
      formatStatusLines(buildStatusReport(config(), [input(vault())])).some((line) =>
        line.startsWith("Too large"),
      ),
    ).toBe(false);
  });

  it("uses the singular form for exactly one parked or oversized file", () => {
    const lines = formatStatusLines(
      buildStatusReport(config(), [
        input(vault(), { conflictFiles: ["a.conflict.md"], oversizeFiles: ["video.mov"] }),
      ]),
    );

    expect(lines).toContain("Conflicts:   1 parked file: a.conflict.md");
    expect(lines).toContain("Too large:   1 file over the cap: video.mov");
  });

  it("tells an unbound machine how to add a vault", () => {
    const lines = formatStatusLines(buildStatusReport(config([]), []));
    expect(lines).toEqual([
      "Server:  http://vps.example.com",
      "Device:  headless",
      "Vaults:  0",
      "no vault is bound: run `courier-cli vault connect` to add one.",
    ]);
  });
});

describe("formatStatusLines — Chinese", () => {
  afterEach(() => {
    setLocale("en");
  });

  it("renders Chinese labels and values, aligned to one column", () => {
    setLocale("zh");
    const lines = formatStatusLines(
      buildStatusReport(config(), [input(vault(), { historyLimits: DEFAULT_HISTORY_LIMITS })]),
    );
    const lineFor = (label: string): string => lines.find((line) => line.startsWith(`${label}:`))!;

    expect(lineFor("服务器")).toContain("http://vps.example.com");
    expect(lineFor("设备")).toContain("headless");
    expect(lineFor("Vault 数量")).toContain("1 个");
    expect(lineFor("远程库")).toContain("vault-1");
    expect(lineFor("路径")).toContain("/mnt/vault");
    expect(lineFor("状态")).toContain("已记录");
    expect(lineFor("文件类型")).toContain(
      "md、canvas、images、video、audio、pdf（上限 50 MB，由管理员设置）",
    );
    expect(lineFor("排除的文件夹")).toContain("（无）");
    expect(lineFor("冲突副本")).toContain("（无）");
    // The history limit is one more scope fact a headless machine has to be able to read
    // back: the defaults, in the active language.
    expect(lineFor("历史版本")).toContain("笔记/Canvas 200，附件 10");

    // The padding is computed in terminal columns, so the wide labels line up too.
    const widths = lines
      .filter((line) => /^\S+[^:]*: +\S/.test(line) && !/^(Hint|提示):/.test(line))
      .map((line) => displayWidth(/^[^:]+: +/.exec(line)![0]));
    expect(new Set(widths).size).toBe(2); // header and vault block
  });

  it("uses Chinese punctuation and list separators for counts", () => {
    setLocale("zh");
    const lines = formatStatusLines(
      buildStatusReport(config(), [
        input(vault(), {
          conflictFiles: ["a.conflict.md", "b.conflict.md"],
          oversizeFiles: ["video.mov", "take.mkv"],
        }),
      ]),
    );

    expect(
      lines.some(
        (line) =>
          line.startsWith("冲突副本:") &&
          line.includes("2 个冲突副本：a.conflict.md、b.conflict.md"),
      ),
    ).toBe(true);
    expect(
      lines.some(
        (line) =>
          line.startsWith("超出上限:") && line.includes("2 个文件超过上限：video.mov、take.mkv"),
      ),
    ).toBe(true);
  });

  it("reads an unlimited cap and a custom cap in Chinese", () => {
    setLocale("zh");
    const fileTypes = (cap: number, extra: Partial<CliVault> = {}): string =>
      formatStatusLines(
        buildStatusReport(config([vault(extra)], { accountMaxFileBytes: cap }), [
          input(vault(extra)),
        ]),
      ).find((line) => line.startsWith("文件类型:"))!;

    expect(fileTypes(0)).toContain("上限不限，由管理员设置");
    expect(fileTypes(200 << 20)).toContain("上限 200 MB，由管理员设置");
    expect(
      fileTypes(50 << 20, { fileTypes: { images: false, video: false, audio: false, pdf: false } }),
    ).toContain("仅 md、canvas（上限 50 MB，由管理员设置）");
  });

  it("reports an untracked vault in Chinese", () => {
    setLocale("zh");
    const lines = formatStatusLines(buildStatusReport(config(), [input(vault(), { state: null })]));
    expect(
      lines.some((line) => line.startsWith("状态:") && line.includes("（尚无同步状态）")),
    ).toBe(true);
  });
});

describe("displayWidth", () => {
  it("counts CJK characters and full-width punctuation as two columns", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("服务器")).toBe(6);
    expect(displayWidth("服务器:")).toBe(7);
    expect(displayWidth("（无）")).toBe(6);
    expect(displayWidth("md、canvas")).toBe(10);
  });
});
