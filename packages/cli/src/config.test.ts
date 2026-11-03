import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  DEFAULT_FILE_TYPES,
  DEFAULT_MAX_FILE_BYTES,
  NO_FILE_TYPES,
  NO_SETTINGS_GROUPS,
} from "@courier/engine";
import { DEFAULT_HISTORY_LIMITS, MAX_HISTORY_LIMIT } from "@courier/shared";
import {
  bindStatePath,
  clearAllState,
  clearState,
  configPath,
  describeExcludedFolders,
  describeFileTypes,
  describeHistoryLimits,
  excludedFoldersFromFlags,
  fileTypesFromFlags,
  findVault,
  historyLimitPatchFromFlags,
  loadBindCompleted,
  loadConfig,
  normalizeCliConfig,
  overlappingVaults,
  parseFileTypes,
  parseHistoryLimit,
  saveBindCompleted,
  statePath,
  syncScopeOf,
  vaultPathsOverlap,
  type CliConfig,
  type CliVault,
} from "./config";
import { setLocale } from "./i18n";

/**
 * What `vault connect` stores about the sync scope, and how `status` reads it back.
 *
 * The flags decide which file types and which folders a headless machine will carry, so
 * a silent mistake here is "my PDFs never arrive" or "my drafts went to the NAS". The
 * rules pinned below: an explicit list replaces the record, the convenience flag only
 * adds its own switch, and re-connecting without any flag keeps what is stored.
 *
 * The config folder is deliberately **not** part of this scope: the CLI never enables a
 * settings group (see `syncScopeOf`).
 */

function vault(overrides: Partial<CliVault> = {}): CliVault {
  return {
    vaultId: "vault-1",
    vaultPath: "/mnt/vault",
    encryptionKeyB64: "a2V5",
    ...overrides,
  };
}

function config(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    serverUrl: "http://vps.example.com",
    userKey: "ck_test",
    deviceName: "headless",
    vaults: [vault()],
    ...overrides,
  };
}

afterEach(() => {
  setLocale("en");
});

describe("per-vault state", () => {
  it("gives each remote vault its own state file and clears only that one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "courier-state-"));
    const previous = process.env.COURIER_CLI_CONFIG_DIR;
    process.env.COURIER_CLI_CONFIG_DIR = dir;
    try {
      expect(statePath("vault-a")).not.toBe(statePath("vault-b"));
      mkdirSync(path.dirname(statePath("vault-a")), { recursive: true });
      writeFileSync(statePath("vault-a"), "{}");
      writeFileSync(statePath("vault-b"), "{}");
      clearState("vault-a");
      expect(() => readFileSync(statePath("vault-a"), "utf-8")).toThrow();
      expect(readFileSync(statePath("vault-b"), "utf-8")).toBe("{}");

      // Dropping the whole account drops every binding's state.
      clearAllState([vault({ vaultId: "vault-b" })]);
      expect(() => readFileSync(statePath("vault-b"), "utf-8")).toThrow();
    } finally {
      if (previous === undefined) delete process.env.COURIER_CLI_CONFIG_DIR;
      else process.env.COURIER_CLI_CONFIG_DIR = previous;
    }
  });

  /**
   * The bind's completion is a sibling of the state file, not a key in it: the state JSON
   * is the engine's `localVersions` map, and a marker key there would be read as a chain.
   * It has to outlive the state's emptiness, which is the whole reason it exists.
   */
  it("records a completed bind beside the state, and drops it with the state", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "courier-bind-state-"));
    const previous = process.env.COURIER_CLI_CONFIG_DIR;
    process.env.COURIER_CLI_CONFIG_DIR = dir;
    try {
      expect(bindStatePath("vault-a")).not.toBe(statePath("vault-a"));
      expect(loadBindCompleted("vault-a")).toBe(false);

      saveBindCompleted("vault-a");
      expect(loadBindCompleted("vault-a")).toBe(true);
      // The engine's state map is untouched by the flag.
      expect(() => readFileSync(statePath("vault-a"), "utf-8")).toThrow();
      expect(loadBindCompleted("vault-b")).toBe(false);

      clearState("vault-a");
      expect(loadBindCompleted("vault-a")).toBe(false);
      expect(() => readFileSync(bindStatePath("vault-a"), "utf-8")).toThrow();
    } finally {
      if (previous === undefined) delete process.env.COURIER_CLI_CONFIG_DIR;
      else process.env.COURIER_CLI_CONFIG_DIR = previous;
    }
  });

  it("refuses folders that overlap, including a parent/child pair", () => {
    expect(vaultPathsOverlap("/mnt/vault", "/mnt/vault")).toBe(true);
    expect(vaultPathsOverlap("/mnt/vault", "/mnt/vault/sub")).toBe(true);
    expect(vaultPathsOverlap("/mnt/vault/sub", "/mnt/vault")).toBe(true);
    expect(vaultPathsOverlap("/mnt/vault", "/mnt/vault2")).toBe(false);

    const pair = overlappingVaults([
      vault({ vaultId: "a", vaultPath: "/mnt/vault" }),
      vault({ vaultId: "b", vaultPath: "/mnt/vault/sub" }),
    ]);
    expect(pair?.[0].vaultId).toBe("a");
    expect(findVault(config(), "vault-1")?.vaultPath).toBe("/mnt/vault");
    expect(findVault(config(), "missing")).toBeNull();
  });
});

describe("syncScopeOf", () => {
  it("never enables a config-folder group, whatever the binding stores", () => {
    expect(syncScopeOf(vault())).toEqual({
      // No Obsidian to ask, so the CLI names no config folder: every group is off, and a
      // name nobody supplies would only make other paths look like settings.
      configDir: "",
      settingsGroups: NO_SETTINGS_GROUPS,
      fileTypes: DEFAULT_FILE_TYPES,
      excludedFolders: [],
      maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    });
    // A hand-edited record cannot turn settings sync on: the device-local scope does not
    // read that field at all.
    expect(syncScopeOf(Object.assign(vault(), { settingsGroups: { appearance: true } }))).toEqual(
      syncScopeOf(vault()),
    );
  });

  it("normalizes the stored file types, excluded folders and cap", () => {
    expect(syncScopeOf(vault({ fileTypes: { video: false } })).fileTypes).toEqual({
      ...DEFAULT_FILE_TYPES,
      video: false,
    });
    expect(
      syncScopeOf(vault({ excludedFolders: [" /private/ ", "private\\sub", "private"] }))
        .excludedFolders,
    ).toEqual(["private", "private/sub"]);
    expect(syncScopeOf(vault(), 1024).maxFileBytes).toBe(1024);
    expect(syncScopeOf(vault()).maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
  });

  it("carries no retention policy: the limits are the vault's, read from the server", () => {
    // The scope decides what this device syncs; how much history the server keeps is
    // vault state, so a binding cannot override it and the scope has no such field.
    expect(syncScopeOf(vault())).not.toHaveProperty("historyLimits");
  });
});

describe("parseFileTypes", () => {
  it("accepts a comma list and ignores spacing and empty entries", () => {
    expect(parseFileTypes("images, pdf,,")).toEqual({
      ...NO_FILE_TYPES,
      images: true,
      pdf: true,
    });
  });

  it("reads an empty list as 'markdown and canvas only'", () => {
    expect(parseFileTypes("")).toEqual(NO_FILE_TYPES);
    expect(parseFileTypes("  ")).toEqual(NO_FILE_TYPES);
  });

  it("refuses an unknown type and lists the valid ones", () => {
    expect(() => parseFileTypes("images,imgs")).toThrowError(/Unknown file type "imgs"/);
    expect(() => parseFileTypes("images,imgs")).toThrowError(
      /images, video, audio, pdf, otherTypes/,
    );
  });
});

describe("fileTypesFromFlags", () => {
  it("keeps what is stored when no flag is given", () => {
    expect(fileTypesFromFlags({ otherTypes: true }, {})).toEqual({
      ...DEFAULT_FILE_TYPES,
      otherTypes: true,
    });
    expect(fileTypesFromFlags(undefined, {})).toEqual(DEFAULT_FILE_TYPES);
  });

  it("replaces the record with an explicit list, or with the defaults when bare", () => {
    expect(fileTypesFromFlags({ otherTypes: true }, { syncFileTypes: "images" })).toEqual({
      ...NO_FILE_TYPES,
      images: true,
    });
    expect(fileTypesFromFlags({ images: false }, { syncFileTypes: true })).toEqual(
      DEFAULT_FILE_TYPES,
    );
    // `--sync-file-types=` is the way to ask for markdown and canvas only.
    expect(fileTypesFromFlags(undefined, { syncFileTypes: "" })).toEqual(NO_FILE_TYPES);
  });

  it("only adds the catch-all for --sync-other-types", () => {
    expect(fileTypesFromFlags(undefined, { syncOtherTypes: true })).toEqual({
      ...DEFAULT_FILE_TYPES,
      otherTypes: true,
    });
    // It composes with an explicit list rather than replacing it.
    expect(fileTypesFromFlags(undefined, { syncFileTypes: "pdf", syncOtherTypes: true })).toEqual({
      ...NO_FILE_TYPES,
      pdf: true,
      otherTypes: true,
    });
  });
});

describe("excludedFoldersFromFlags", () => {
  it("keeps what is stored when no flag is given", () => {
    expect(excludedFoldersFromFlags(["private"], {})).toEqual(["private"]);
    expect(excludedFoldersFromFlags(undefined, {})).toEqual([]);
  });

  it("replaces the list with the flag's comma list", () => {
    expect(
      excludedFoldersFromFlags(["old"], { excludeFolders: " private , drafts\\sub ,, " }),
    ).toEqual(["private", "drafts/sub"]);
  });

  it("clears the list for an empty value", () => {
    expect(excludedFoldersFromFlags(["private"], { excludeFolders: "" })).toEqual([]);
    expect(excludedFoldersFromFlags(["private"], { excludeFolders: " , " })).toEqual([]);
  });
});

describe("describeExcludedFolders", () => {
  it("reads (none) or the stored paths", () => {
    expect(describeExcludedFolders(vault())).toBe("(none)");
    expect(describeExcludedFolders(vault({ excludedFolders: ["private", "drafts"] }))).toBe(
      "private, drafts",
    );
  });
});

/**
 * The two history-limit flags.
 *
 * They become a `PATCH /api/vaults/:id` body — the limits are the **vault's**, not the
 * binding's — and each flag states only its own field: raising the attachment limit must
 * not resend (or reset) the notes one. A value that is not a whole number of versions is
 * **refused** rather than clamped: a typo would otherwise change how much history a vault
 * keeps, and `0` would read as "keep only the newest version".
 */
describe("parseHistoryLimit", () => {
  it("accepts a whole number of versions inside the bound", () => {
    expect(parseHistoryLimit("200")).toBe(200);
    expect(parseHistoryLimit(" 1 ")).toBe(1);
    expect(parseHistoryLimit(String(MAX_HISTORY_LIMIT))).toBe(MAX_HISTORY_LIMIT);
  });

  it("refuses an empty, fractional, out-of-range or non-numeric value", () => {
    for (const value of ["", "  ", "0", "-1", "1.5", "many", String(MAX_HISTORY_LIMIT + 1)]) {
      expect(() => parseHistoryLimit(value), value).toThrowError(/history limit/);
    }
  });

  it("names the value and the bound in the refusal, in the active language", () => {
    setLocale("en");
    expect(() => parseHistoryLimit("0")).toThrowError(/between 1 and 10000/);
    setLocale("zh");
    expect(() => parseHistoryLimit("0")).toThrowError(/1 到 10000/);
  });
});

describe("historyLimitPatchFromFlags", () => {
  it("states nothing when neither flag is given, so the vault keeps its values", () => {
    expect(historyLimitPatchFromFlags({})).toBeNull();
  });

  it("states only the half its flag names", () => {
    expect(historyLimitPatchFromFlags({ historyLimitDocuments: "500" })).toEqual({
      historyLimitDocuments: 500,
    });
    expect(historyLimitPatchFromFlags({ historyLimitAttachments: "3" })).toEqual({
      historyLimitAttachments: 3,
    });
    expect(
      historyLimitPatchFromFlags({ historyLimitDocuments: "20", historyLimitAttachments: "2" }),
    ).toEqual({ historyLimitDocuments: 20, historyLimitAttachments: 2 });
  });

  it("refuses a bad value instead of sending it", () => {
    expect(() => historyLimitPatchFromFlags({ historyLimitDocuments: "0" })).toThrowError(
      /history limit/,
    );
    expect(() => historyLimitPatchFromFlags({ historyLimitAttachments: "ten" })).toThrowError(
      /history limit/,
    );
  });
});

describe("describeHistoryLimits", () => {
  it("renders both halves, so a status row says what the server keeps", () => {
    expect(describeHistoryLimits({ documents: 200, attachments: 10 })).toBe(
      "notes/canvas 200, attachments 10",
    );
  });

  it("follows the active language", () => {
    setLocale("zh");
    expect(describeHistoryLimits(DEFAULT_HISTORY_LIMITS)).toBe("笔记/Canvas 200，附件 10");
  });
});

function write(raw: string): void {
  writeFileSync(configPath(), raw, "utf-8");
}

/**
 * The config file at `~/.courier-cli/config.json`, and what happens when it is not the
 * file this binary wrote.
 *
 * The load used to be a bare cast: a hand-edited or truncated file produced `undefined`
 * fields, which reached the client as `Authorization: Bearer undefined` or a
 * `vaultPath` that is not a path. A file this machine cannot trust is now treated as
 * "not configured", the same answer as no file at all.
 */
describe("loadConfig — a file this machine cannot trust", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "courier-cli-config-"));
    process.env.COURIER_CLI_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.COURIER_CLI_CONFIG_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("treats unparseable JSON as 'not configured'", () => {
    write("{ this is not json");
    expect(loadConfig()).toBeNull();
  });

  it("refuses a file without a usable server URL or user key", () => {
    write(JSON.stringify({ ...config(), userKey: undefined }));
    expect(loadConfig()).toBeNull();

    write(JSON.stringify({ ...config(), serverUrl: "" }));
    expect(loadConfig()).toBeNull();

    write(JSON.stringify([config()]));
    expect(loadConfig()).toBeNull();
  });

  it("keeps the bindings it can read, and drops the parts it cannot", () => {
    write(
      JSON.stringify({
        serverUrl: "http://srv",
        userKey: "ck_x",
        deviceName: "   ",
        vaults: [
          { vaultId: 42, vaultPath: "/mnt/number-id", encryptionKeyB64: "a2V5" },
          {
            vaultId: "vault-1",
            vaultPath: "/mnt/vault",
            encryptionKeyB64: "a2V5",
            fileTypes: { images: false },
            excludedFolders: [" /private/ ", "..", 42, "private"],
          },
          { vaultId: "vault-2", vaultPath: "/mnt/no-key", encryptionKeyB64: null },
        ],
        accountMaxFileBytes: "big",
      }),
    );

    const loaded = loadConfig();
    expect(loaded).not.toBeNull();
    // A blank label falls back to the default rather than reading as "the device called ''".
    expect(loaded!.deviceName).toBe("My Device");
    // Only the complete binding survives; only booleans survive in its scope records.
    expect(loaded!.vaults).toHaveLength(1);
    expect(loaded!.vaults[0]).toMatchObject({
      vaultId: "vault-1",
      vaultPath: "/mnt/vault",
      fileTypes: { images: false },
      excludedFolders: ["private"],
    });
    expect(loaded!.accountMaxFileBytes).toBeUndefined();
  });

  it("returns a registered but unbound config with an empty vault list", () => {
    write(JSON.stringify({ serverUrl: "http://srv", userKey: "ck_x" }));
    expect(loadConfig()?.vaults).toEqual([]);
  });
});

describe("normalizeCliConfig", () => {
  it("normalizes the device label to the wire limit", () => {
    const loaded = normalizeCliConfig({
      serverUrl: "http://srv",
      userKey: "ck_x",
      deviceName: `  ${"d".repeat(200)}  `,
    });

    expect(loaded!.deviceName).toHaveLength(100);
  });

  // The vault's server name and its own device name are per binding and must survive a
  // read: `vaultLabel`/`vaultDeviceName` and the daemon's start log read them from here.
  it("keeps a binding's own server name and device name", () => {
    const loaded = normalizeCliConfig({
      serverUrl: "http://srv",
      userKey: "ck_x",
      deviceName: "DESKTOP-1",
      vaults: [
        {
          vaultId: "vault-a",
          vaultPath: "/mnt/a",
          vaultName: " 工作笔记 ",
          encryptionKeyB64: "a2V5",
          deviceName: " 我的笔记本 ",
        },
      ],
    });

    expect(loaded!.vaults[0]!.vaultName).toBe("工作笔记");
    expect(loaded!.vaults[0]!.deviceName).toBe("我的笔记本");
  });

  // The retention limits are the vault's server state, so a hand-edited local config
  // cannot carry them at all — even a file that still has an old `historyLimits` key must
  // not become a second, divergent copy of the policy.
  it("drops a stored historyLimits record from an old config file", () => {
    const loaded = normalizeCliConfig({
      serverUrl: "http://srv",
      userKey: "ck_x",
      vaults: [
        {
          vaultId: "vault-a",
          vaultPath: "/mnt/a",
          encryptionKeyB64: "a2V5",
          historyLimits: { documents: 7, attachments: 3 },
        },
      ],
    });

    expect(loaded!.vaults[0]).not.toHaveProperty("historyLimits");
  });
});

describe("the localized human descriptions", () => {
  it("renders the connected file types in Chinese", () => {
    setLocale("zh");

    expect(describeFileTypes(vault())).toBe(
      "md、canvas、images、video、audio、pdf（上限 50 MB，由管理员设置）",
    );
    expect(
      describeFileTypes(
        vault({ fileTypes: { images: false, video: false, audio: false, pdf: false } }),
      ),
    ).toBe("仅 md、canvas（上限 50 MB，由管理员设置）");
    expect(describeExcludedFolders(vault())).toBe("（无）");
    expect(describeExcludedFolders(vault({ excludedFolders: ["private", "drafts"] }))).toBe(
      "private、drafts",
    );
  });

  it("localizes the flag validation errors", () => {
    setLocale("zh");

    expect(() => parseFileTypes("images,imgs")).toThrow(/未知文件类型「imgs」/);
  });
});
