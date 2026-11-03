import { spawn } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { conflictFilePath } from "../../engine/src/conflict-file";
import { DEFAULT_MAX_FILE_BYTES } from "../../shared/src/sync";
import { createProgram } from "../../cli/src/program";
import { setLocale, t } from "../../cli/src/i18n";
import {
  clearConfig,
  configPath,
  loadConfig,
  saveConfig,
  saveState,
  statePath,
} from "../../cli/src/config";
import { setUserMaxFileBytes, startTestServer, type TestServer } from "./harness/server";
import { vaultSettings } from "./harness/api";
import { createTestVault, makeVaultMaterial } from "./harness/vault";

/**
 * The command surface a supervising process drives.
 *
 * A supervisor launches the binary and reads its output, so the contract is `argv` →
 * stored config / JSON on stdout / exit code. Most cases drive the real
 * `createProgram()` in-process (fast, and the wiring is what a unit test of an action
 * cannot see); one case spawns the real entry point end to end, because that is the
 * thing the supervisor actually runs.
 */

/** Thrown by the mocked `process.exit`, so a refusal ends the command without the run. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** The CLI's main entry point, for the one case that really spawns a process. */
const CLI_MAIN = fileURLToPath(new URL("../../../packages/cli/src/main.ts", import.meta.url));

/** Spawn the real entry point and collect what a caller with pipes would see. */
function spawnCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_MAIN, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * The catalog text before the first placeholder, to assert a refusal came from the
 * command's own check rather than from commander rejecting a renamed flag.
 */
function catalogPrefix(template: string): string {
  return template.split("{")[0]!.trim();
}

/** Run one command and return what it printed. */
async function run(args: string[]): Promise<string[]> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  });
  try {
    await createProgram().parseAsync(args, { from: "user" });
  } finally {
    log.mockRestore();
  }
  return lines;
}

/**
 * Run a command that is expected to refuse.
 *
 * `fail()` calls `process.exit`, which would end the whole suite: the exit is mocked
 * to throw, and the case asserts the code and message a supervisor would see.
 */
async function runFailing(args: string[]): Promise<{ lines: string[]; code: number }> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    lines.push(values.map(String).join(" "));
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as never);
  try {
    await createProgram().parseAsync(args, { from: "user" });
    throw new Error(`expected a refusal, got exit 0 from: ${args.join(" ")}`);
  } catch (err) {
    if (err instanceof ExitSignal) return { lines, code: err.code };
    throw err;
  } finally {
    log.mockRestore();
    error.mockRestore();
    exit.mockRestore();
  }
}

describe("cli commands e2e — the contract a supervising process reads", () => {
  let server: TestServer;
  let configDir: string;
  let scratch: string;

  beforeAll(async () => {
    setLocale("en");
    server = await startTestServer("cli commands e2e user");
    configDir = mkdtempSync(join(tmpdir(), "courier-cli-commands-"));
    process.env.COURIER_CLI_CONFIG_DIR = configDir;
    scratch = mkdtempSync(join(tmpdir(), "courier-cli-commands-vault-"));
  }, 120_000);

  afterAll(() => {
    rmSync(configDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    delete process.env.COURIER_CLI_CONFIG_DIR;
  });

  /** A folder this case owns, empty, inside the suite's scratch directory. */
  function vaultFolder(name: string): string {
    const path = join(scratch, name);
    rmSync(path, { recursive: true, force: true });
    return path;
  }

  /** Start a case from a config that only knows the server. */
  function resetConfig(): void {
    rmSync(configDir, { recursive: true, force: true });
    saveConfig({
      serverUrl: server.serverUrl,
      userKey: server.userKey,
      deviceName: "e2e",
      vaults: [],
    });
  }

  it("creates a remote vault, binds the folder, and logs out", async () => {
    resetConfig();
    const vaultPath = vaultFolder("create-and-logout");
    const lines = await run([
      "vault",
      "create",
      "--name",
      "新建库",
      "--path",
      vaultPath,
      "--password",
      "correct horse",
      "--json",
    ]);
    expect(lines).toHaveLength(1);
    const created = JSON.parse(lines[0]!) as { id: string; name: string };
    expect(created.name).toBe("新建库");

    // The server has the vault, and the stored binding is the one a later `run` needs.
    const response = await fetch(`${server.serverUrl}/api/vaults`, {
      headers: { Authorization: `Bearer ${server.userKey}` },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { vaults: Array<{ id: string; name: string }> };
    expect(payload.vaults.find((vault) => vault.id === created.id)?.name).toBe("新建库");

    const config = loadConfig();
    expect(config?.vaults).toHaveLength(1);
    expect(config?.vaults[0]?.vaultId).toBe(created.id);
    expect(config?.vaults[0]?.vaultPath).toBe(vaultPath);

    // A state file stands in for a sync in progress; logging out removes both it and
    // the config that is the only way back to it.
    saveState(created.id, "{}");
    const loggedOut = await run(["logout"]);
    expect(loggedOut).toHaveLength(1);
    expect(loadConfig()).toBeNull();
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(statePath(created.id))).toBe(false);
  }, 120_000);

  it("registers a key against the server and caches the account's file cap", async () => {
    clearConfig();
    // A value no default would produce: a `register` that never read `GET /api/me` would
    // still store *a* number, and the old shape assertion could not tell the difference.
    await setUserMaxFileBytes(server, 12_345);
    try {
      const lines = await run([
        "register",
        "--server",
        server.serverUrl,
        "--user-key",
        server.userKey,
        "--name",
        "工作机",
      ]);

      expect(lines.join("\n")).toContain("工作机");
      const config = loadConfig();
      expect(config?.serverUrl).toBe(server.serverUrl);
      expect(config?.userKey).toBe(server.userKey);
      expect(config?.deviceName).toBe("工作机");
      expect(config?.vaults).toEqual([]);
      // The cap the administrator set arrives from `GET /api/me`, so the daemon can
      // refuse an oversized file while the server is unreachable.
      expect(config?.accountMaxFileBytes).toBe(12_345);
    } finally {
      await setUserMaxFileBytes(server, DEFAULT_MAX_FILE_BYTES);
    }
  }, 120_000);

  it("refuses a key the server rejects, and stores nothing", async () => {
    clearConfig();
    const { lines, code } = await runFailing([
      "register",
      "--server",
      server.serverUrl,
      "--user-key",
      "ck_not_a_real_key",
    ]);
    expect(code).toBe(1);
    // The command's own refusal, not commander's "unknown option" (which also exits 1 and
    // would let a renamed `--user-key` pass for the wrong reason).
    expect(lines.join("\n")).toContain(catalogPrefix(t("cli.error.invalidUserKey", {})));
    expect(loadConfig()).toBeNull();
  }, 120_000);

  it("binds an existing vault, storing its key, label and folder exclusions", async () => {
    resetConfig();
    const material = await makeVaultMaterial("vault-pass-1");
    const remote = await createTestVault(server, "已存在的库", material);
    const vaultPath = vaultFolder("connect");
    const lines = await run([
      "vault",
      "connect",
      "--id",
      remote.id,
      "--path",
      vaultPath,
      "--password",
      "vault-pass-1",
      "--device-name",
      "NAS",
      "--sync-file-types",
      "pdf,images",
      "--exclude-folders",
      "private,cache",
      "--history-limit-documents",
      "500",
      "--history-limit-attachments",
      "5",
    ]);

    expect(lines[0]).toContain(remote.id);
    expect(lines[0]).toContain(vaultPath);
    // The scope flags print what they stored, including the two history limits.
    expect(lines.join("\n")).toContain("History versions: notes/canvas 500, attachments 5.");
    const bound = loadConfig()?.vaults[0];
    expect(bound).toMatchObject({
      vaultId: remote.id,
      vaultPath,
      vaultName: "已存在的库",
      deviceName: "NAS",
    });
    // The key is the derived raw AES key, not the password: a daemon started later must
    // not need the password again.
    expect(bound?.encryptionKeyB64).toBeTypeOf("string");
    expect(bound?.encryptionKeyB64).not.toBe("vault-pass-1");
    expect(bound?.fileTypes).toMatchObject({ pdf: true, images: true });
    expect(bound?.excludedFolders?.toSorted()).toEqual(["cache", "private"]);
    // The limits are the **vault's** state, not the binding's: the flags were sent to the
    // server, and the printed line is what the vault now holds.
    expect(bound).not.toHaveProperty("historyLimits");
    expect(await vaultSettings(server, remote.id)).toMatchObject({
      historyLimitDocuments: 500,
      historyLimitAttachments: 5,
    });
  }, 120_000);

  it("refuses a wrong vault password without changing the stored binding", async () => {
    resetConfig();
    const material = await makeVaultMaterial("right-pass");
    const remote = await createTestVault(server, "密码库", material);
    const vaultPath = vaultFolder("wrong-password");

    const { code, lines } = await runFailing([
      "vault",
      "connect",
      "--id",
      remote.id,
      "--path",
      vaultPath,
      "--password",
      "wrong-pass",
    ]);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain(t("cli.error.incorrectVaultPassword"));
    expect(loadConfig()?.vaults).toEqual([]);
  }, 120_000);

  it("refuses a second binding inside an already bound folder", async () => {
    resetConfig();
    const first = await createTestVault(server, "父目录", await makeVaultMaterial("pass-a"));
    const second = await createTestVault(server, "子目录", await makeVaultMaterial("pass-b"));
    const parent = vaultFolder("overlap");
    await run(["vault", "connect", "--id", first.id, "--path", parent, "--password", "pass-a"]);

    const { code, lines } = await runFailing([
      "vault",
      "connect",
      "--id",
      second.id,
      "--path",
      join(parent, "nested"),
      "--password",
      "pass-b",
    ]);
    expect(code).toBe(1);
    // The refusal names the binding that owns the folder, which a commander error (a
    // renamed flag also exits 1) could not produce.
    expect(lines.join("\n")).toContain(parent);
    // Two engines over one folder (or one inside the other) would write the same files.
    expect(loadConfig()?.vaults.map((vault) => vault.vaultId)).toEqual([first.id]);
  }, 120_000);

  it("updates a binding's label, file types, exclusions and history limits without reconnecting", async () => {
    resetConfig();
    const material = await makeVaultMaterial("pass-update");
    const remote = await createTestVault(server, "更新库", material);
    const vaultPath = vaultFolder("update");
    await run([
      "vault",
      "connect",
      "--id",
      remote.id,
      "--path",
      vaultPath,
      "--password",
      "pass-update",
    ]);

    await run([
      "vault",
      "update",
      "--id",
      remote.id,
      "--device-name",
      "客厅",
      "--sync-file-types",
      "images",
      "--exclude-folders",
      "archive",
      // One flag only: the other half of the vault's record has to survive the update.
      "--history-limit-documents",
      "50",
    ]);

    const bound = loadConfig()?.vaults[0];
    expect(bound?.deviceName).toBe("客厅");
    expect(bound?.fileTypes).toMatchObject({ images: true });
    expect(bound?.excludedFolders).toEqual(["archive"]);
    // The untouched half keeps the vault's default, and nothing about the limits is
    // written to this machine's config: they are the vault's server state.
    expect(bound).not.toHaveProperty("historyLimits");
    expect(await vaultSettings(server, remote.id)).toMatchObject({
      historyLimitDocuments: 50,
      historyLimitAttachments: 10,
    });
    // Still the same binding: no new vault id, no second entry.
    expect(loadConfig()?.vaults).toHaveLength(1);
    expect(bound?.vaultId).toBe(remote.id);
  }, 120_000);

  it("renames the device locally, and status reports the new name", async () => {
    resetConfig();
    const material = await makeVaultMaterial("pass-device");
    const remote = await createTestVault(server, "设备库", material);
    const vaultPath = vaultFolder("device");
    await run([
      "vault",
      "connect",
      "--id",
      remote.id,
      "--path",
      vaultPath,
      "--password",
      "pass-device",
    ]);

    const renamed = await run(["device", "rename", "手机"]);
    expect(renamed.join("\n")).toContain("手机");
    expect(loadConfig()?.deviceName).toBe("手机");

    const lines = await run(["status", "--json"]);
    const report = JSON.parse(lines[0]!) as {
      serverUrl: string;
      deviceName: string;
      vaults: Array<{ vaultId: string; deviceName: string; hasState: boolean }>;
    };
    expect(report.serverUrl).toBe(server.serverUrl);
    expect(report.deviceName).toBe("手机");
    expect(report.vaults).toHaveLength(1);
    expect(report.vaults[0]?.vaultId).toBe(remote.id);
    expect(report.vaults[0]?.hasState).toBe(false);
  }, 120_000);

  it("reports a bound vault's state, conflicts and exclusions in status --json", async () => {
    resetConfig();
    const material = await makeVaultMaterial("pass-status");
    const remote = await createTestVault(server, "状态库", material);
    const vaultPath = vaultFolder("status");
    await run([
      "vault",
      "connect",
      "--id",
      remote.id,
      "--path",
      vaultPath,
      "--password",
      "pass-status",
      "--exclude-folders",
      "private",
    ]);
    saveState(remote.id, JSON.stringify({ state: {} }));
    // A parked copy is the one conflict a headless machine can see; `status` is the only
    // command that surfaces it, so the listing is asserted from a real file, not as a
    // shape of an empty array.
    const parked = conflictFilePath("hero.md", new Date());
    mkdirSync(vaultPath, { recursive: true });
    writeFileSync(join(vaultPath, parked), "parked");

    const lines = await run(["status", "--json"]);
    const report = JSON.parse(lines[0]!) as {
      vaults: Array<{
        vaultId: string;
        vaultName: string;
        hasState: boolean;
        excludedFolders: string[];
        historyLimits: { documents: number; attachments: number };
        conflictFiles: string[];
        oversizeFiles: string[];
        daemon: { running: boolean };
      }>;
    };
    const [summary] = report.vaults;
    expect(summary?.vaultId).toBe(remote.id);
    expect(summary?.vaultName).toBe("状态库");
    expect(summary?.hasState).toBe(true);
    expect(summary?.excludedFolders).toEqual(["private"]);
    // What the server keeps of each file is part of the binding a supervisor reports.
    expect(summary?.historyLimits).toEqual({ documents: 200, attachments: 10 });
    expect(summary?.conflictFiles).toEqual([parked]);
    expect(summary?.oversizeFiles).toEqual([]);
    expect(summary?.daemon.running).toBe(false);
  }, 120_000);

  it("disconnects a vault, dropping its binding and its state", async () => {
    resetConfig();
    const material = await makeVaultMaterial("pass-disconnect");
    const remote = await createTestVault(server, "断开库", material);
    const vaultPath = vaultFolder("disconnect");
    await run([
      "vault",
      "connect",
      "--id",
      remote.id,
      "--path",
      vaultPath,
      "--password",
      "pass-disconnect",
    ]);
    saveState(remote.id, "{}");

    const lines = await run(["vault", "disconnect", "--id", remote.id]);
    expect(lines[0]).toContain(remote.id);
    expect(loadConfig()?.vaults).toEqual([]);
    // The state belongs to the binding: leaving it behind would make a later rebind read
    // the old folder's paths as local deletions.
    expect(existsSync(statePath(remote.id))).toBe(false);
  }, 120_000);

  it("exits 1 for a command that needs a config when none exists", async () => {
    clearConfig();
    const { code, lines } = await runFailing(["status"]);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain(t("cli.error.notConfigured"));
  }, 120_000);

  it("runs through the real entry point: argv in, one JSON line out", async () => {
    // The one thing the in-process cases cannot see: `main.ts` resolving the language
    // from argv/env and dispatching, which is exactly what a supervisor launches.
    const version = await spawnCli(["version", "--json"], { COURIER_LANG: "en" });
    expect(version.stderr).toBe("");
    expect(version.code).toBe(0);
    const lines = version.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ version: expect.any(String) });

    // A refused `--lang` is reported in the language the user would have had without it,
    // and exits before any command runs.
    const refused = await spawnCli(["version", "--lang", "nope"], {
      LANG: "en_US.UTF-8",
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(t("cli.error.invalidLanguage", { value: "nope" }));
    expect(refused.stdout).toBe("");
  }, 60_000);

  it("prints the binary identity as one JSON line", async () => {
    const lines = await run(["version", "--json"]);
    expect(lines).toHaveLength(1);
    const identity = JSON.parse(lines[0]!) as {
      version: string;
      gitSha: string;
      buildTime: string;
      runtime: string;
    };
    expect(identity.version).toBeTypeOf("string");
    expect(identity.gitSha).toBeTypeOf("string");
    expect(identity.buildTime).toBeTypeOf("string");
    // The runtime the binary embeds (`bun/<version>`; `process.version` carries the
    // compatibility version, so it cannot be that).
    expect(identity.runtime).toMatch(/^bun\/\d+\.\d+\.\d+/);
  });
});
