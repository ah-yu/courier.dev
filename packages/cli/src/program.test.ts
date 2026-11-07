import { mkdtempSync, rmSync } from "fs";
import { EventEmitter } from "events";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "./config";
import { setLocale, t } from "./i18n";
import { createProgram, watchSupervisor } from "./program";

/**
 * The command surface is built from the active catalog before commander parses, so
 * this is the one place where help text can be checked without spawning a process.
 * The program is constructed twice (English then Chinese) — never parsed — to prove
 * that every description follows `setLocale`.
 */

afterEach(() => {
  setLocale("en");
});

function commandNamed(program: ReturnType<typeof createProgram>, name: string) {
  const command = program.commands.find((candidate) => candidate.name() === name);
  if (!command) throw new Error(`no command named ${name}`);
  return command;
}

describe("createProgram", () => {
  it("renders the English command surface", () => {
    setLocale("en");
    const program = createProgram();

    expect(program.name()).toBe("courier-cli");
    expect(program.description()).toBe(t("cli.description"));
    expect(commandNamed(program, "register").description()).toBe(
      t("cli.command.register.description"),
    );
    expect(commandNamed(program, "vault").description()).toBe(t("cli.command.vault.description"));
    expect(commandNamed(program, "run").description()).toBe(t("cli.command.run.description"));
    expect(commandNamed(program, "status").description()).toBe(t("cli.command.status.description"));
    expect(commandNamed(program, "version").description()).toBe(
      t("cli.command.version.description"),
    );
    expect(commandNamed(program, "device").description()).toBe(t("cli.command.device.description"));
  });

  it("renders the Chinese command surface", () => {
    setLocale("zh");
    const program = createProgram();

    expect(program.description()).toBe(t("cli.description"));
    expect(commandNamed(program, "register").description()).toBe(
      t("cli.command.register.description"),
    );
    expect(commandNamed(program, "vault").description()).toBe(t("cli.command.vault.description"));
    expect(commandNamed(program, "run").description()).toBe(t("cli.command.run.description"));
    expect(commandNamed(program, "status").description()).toBe(t("cli.command.status.description"));
    expect(commandNamed(program, "device").description()).toBe(t("cli.command.device.description"));
  });

  it("offers the language flag and translates its help line", () => {
    setLocale("en");
    const english = createProgram();
    const englishFlag = english.options.find((option) => option.long === "--lang");
    expect(englishFlag?.description).toBe(t("cli.option.lang"));

    setLocale("zh");
    const chinese = createProgram();
    const chineseFlag = chinese.options.find((option) => option.long === "--lang");
    expect(chineseFlag?.description).toBe(t("cli.option.lang"));
  });

  it("translates nested command and option descriptions", () => {
    setLocale("en");
    const english = createProgram();
    const vault = commandNamed(english, "vault");
    const connect = vault.commands.find((command) => command.name() === "connect");
    expect(connect?.description()).toBe(t("cli.command.vaultConnect.description"));
    expect(connect?.options.map((option) => option.long)).toContain("--sync-file-types");
    // Settings sync is the plugin's, not the CLI's: none of its five flags is offered.
    const connectFlags = connect?.options.map((option) => option.long) ?? [];
    for (const removed of [
      "--sync-settings",
      "--sync-settings-off",
      "--sync-plugin-list",
      "--sync-plugins",
      "--sync-other-files",
    ]) {
      expect(connectFlags).not.toContain(removed);
    }
    const disconnect = vault.commands.find((command) => command.name() === "disconnect");
    expect(disconnect?.description()).toBe(t("cli.command.vaultDisconnect.description"));
    // One process per vault: `run` and `status` both take a vault id.
    expect(commandNamed(english, "run").options.map((option) => option.long)).toContain("--vault");
    expect(commandNamed(english, "status").options.map((option) => option.long)).toContain(
      "--vault",
    );

    const device = commandNamed(english, "device");
    const rename = device.commands.find((command) => command.name() === "rename");
    expect(rename?.description()).toBe(t("cli.command.deviceRename.description"));

    setLocale("zh");
    const chinese = createProgram();
    const zhConnect = commandNamed(chinese, "vault").commands.find(
      (command) => command.name() === "connect",
    );
    expect(zhConnect?.description()).toBe(t("cli.command.vaultConnect.description"));
  });
});

/**
 * `vault update` edits the stored binding in place. The rule that matters is what it
 * leaves alone: the folder, the vault key and the stored server name are not its to
 * change, and an empty scope flag clears that list.
 */
describe("vault update", () => {
  it("changes the name and scope without dropping the folder, key or vault name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "courier-vault-update-"));
    process.env.COURIER_CLI_CONFIG_DIR = dir;
    const printed = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      saveConfig({
        serverUrl: "http://127.0.0.1:1",
        userKey: "ck_test",
        deviceName: "machine",
        vaults: [
          {
            vaultId: "vault-1",
            vaultPath: "/mnt/vault",
            vaultName: "工作笔记",
            encryptionKeyB64: "a2V5",
            deviceName: "old-name",
            fileTypes: {
              images: true,
              video: false,
              audio: false,
              pdf: false,
              otherTypes: false,
            },
            excludedFolders: ["private"],
          },
        ],
      });

      await createProgram().parseAsync(
        ["vault", "update", "--id", "vault-1", "--device-name", "windows", "--exclude-folders="],
        { from: "user" },
      );

      const bound = loadConfig()?.vaults[0];
      expect(bound).toMatchObject({
        vaultId: "vault-1",
        vaultPath: "/mnt/vault",
        vaultName: "工作笔记",
        encryptionKeyB64: "a2V5",
        deviceName: "windows",
      });
      expect(bound?.excludedFolders).toBeUndefined();
      expect(bound?.fileTypes).toEqual({
        images: true,
        video: false,
        audio: false,
        pdf: false,
        otherTypes: false,
      });
    } finally {
      printed.mockRestore();
      delete process.env.COURIER_CLI_CONFIG_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A stand-in for a supervised stdin: it records whether anything started reading. */
class FakeStdin extends EventEmitter {
  resumed = 0;
  resume() {
    this.resumed += 1;
    return this;
  }
}

function fakeStdin(): NodeJS.ReadStream & FakeStdin {
  return new FakeStdin() as unknown as NodeJS.ReadStream & FakeStdin;
}

/**
 * The supervisor's pipe closing is the desktop app's death, which macOS has no other way to
 * report. It must stay an explicit opt-in: a terminal run with stdin at /dev/null is EOF at
 * once, and a daemon that stopped there would never sync.
 */
describe("watchSupervisor", () => {
  it("leaves stdin alone unless the supervisor asked", () => {
    const stdin = fakeStdin();
    const closed = vi.fn();
    watchSupervisor(closed, {}, stdin);
    stdin.emit("end");
    stdin.emit("close");

    expect(stdin.resumed).toBe(0);
    expect(closed).not.toHaveBeenCalled();
  });

  it("stops when the supervisor's pipe ends", () => {
    const stdin = fakeStdin();
    const closed = vi.fn();
    watchSupervisor(closed, { COURIER_DAEMON_SUPERVISED: "1" }, stdin);
    expect(stdin.resumed).toBe(1);

    stdin.emit("end");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("stops when the supervisor's pipe is closed outright", () => {
    const stdin = fakeStdin();
    const closed = vi.fn();
    watchSupervisor(closed, { COURIER_DAEMON_SUPERVISED: "1" }, stdin);

    stdin.emit("close");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("calls back once when a real close reports both events", () => {
    const stdin = fakeStdin();
    const closed = vi.fn();
    watchSupervisor(closed, { COURIER_DAEMON_SUPERVISED: "1" }, stdin);

    // A pipe closing fires "end" and then "close"; a drain must not run twice.
    stdin.emit("end");
    stdin.emit("close");
    expect(closed).toHaveBeenCalledTimes(1);
  });
});
