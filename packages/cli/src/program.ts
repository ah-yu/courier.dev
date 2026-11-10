import { hostname } from "os";
import path from "path";
import { Command } from "commander";
import {
  deriveEncryptionKey,
  exportRawKey,
  generateSalt,
  makeKeyCheck,
  verifyKeyCheck,
} from "@courier/engine";
import {
  clearAllState,
  clearConfig,
  clearState,
  describeExcludedFolders,
  describeFileTypes,
  describeHistoryLimits,
  excludedFoldersFromFlags,
  fileTypesFromFlags,
  findVault,
  historyLimitPatchFromFlags,
  loadConfig,
  loadState,
  overlappingVaults,
  saveConfig,
  syncScopeOf,
  vaultDeviceName,
  vaultLabel,
  vaultPathsOverlap,
  type CliConfig,
  type CliVault,
} from "./config";
import { leaseIsCurrent, pidAlive, readSyncLease } from "@courier/engine";
import { detectCoexistence } from "./coexistence";
import { t } from "./i18n";
import { parseIntervalMinutes, selectVaults } from "./options";
import { createCliClient } from "./api";
import { LeaseStore } from "./lease";
import { cliPlatform } from "./platform";
import { FsAdapter } from "./fs-adapter";
import { runDaemon, runOnceSync, type RunnerHandle } from "./runner";
import {
  EXIT_CONTRACT_MISMATCH,
  ensureCompatibleServer,
  ServerContractError,
} from "./server-contract";
import { clearActivityLog } from "./history";
import { daemonStatus } from "./runtime";
import {
  buildStatusReport,
  formatStatusLines,
  type ContractIssue,
  type VaultStatusInput,
} from "./status";
import { BUILD_TIME, GIT_SHA, VERSION } from "./version";
import {
  ApiClientError,
  contractVerdict,
  historyLimitsOf,
  normalizeDeviceName,
  runtimeLabel,
  type CreateVaultResponse,
  type HistoryLimits,
} from "@courier/shared";

/** Read the stored config or exit with the command that creates one. */
function requireConfig(): CliConfig {
  const config = loadConfig();
  if (!config) {
    console.error(t("cli.error.notConfigured"));
    process.exit(1);
  }
  return config;
}

/** Print an error and exit, for the action-level refusals. */
function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

/**
 * Refuse to go on when this CLI and the server speak different contract generations.
 *
 * A mismatch is a configuration fact, not a transient fault: it exits with its own code so
 * a supervisor can be told not to restart it, and it is checked **before** a lease is taken
 * or a binding is written, so nothing is left half-done. A server that cannot be reached is
 * not this: that stays the caller's retry path.
 */
async function requireCompatibleServer(config: CliConfig): Promise<void> {
  try {
    await ensureCompatibleServer(config);
  } catch (err) {
    if (err instanceof ServerContractError) fail(err.message, EXIT_CONTRACT_MISMATCH);
  }
}

/** What binding one local folder to a known remote vault needs. */
interface BindVaultOptions {
  vaultId: string;
  path: string;
  password: string;
  deviceName?: string;
  /** The remote name, when the caller already knows it (`vault create`). */
  vaultName?: string;
  syncFileTypes?: string | boolean;
  syncOtherTypes?: boolean;
  excludeFolders?: string;
  /** How many versions of notes/canvas to keep on the server (absent = keep stored). */
  historyLimitDocuments?: string;
  /** How many versions of every other file to keep (absent = keep stored). */
  historyLimitAttachments?: string;
}

/**
 * Refuse a local folder that already belongs to another vault. Two engines on one folder
 * (or one inside the other) would both write the same files, so this runs before anything
 * is created or stored — including before `vault create` makes a remote vault, which would
 * otherwise be left behind without a folder.
 */
function assertPathFree(config: CliConfig, vaultId: string, vaultPath: string): void {
  for (const other of config.vaults) {
    if (other.vaultId === vaultId) continue;
    if (vaultPathsOverlap(vaultPath, other.vaultPath)) {
      fail(
        t("cli.error.vaultPathOverlap", {
          path: vaultPath,
          other: `${vaultLabel(other)} (${other.vaultPath})`,
        }),
      );
    }
  }
}

/** Whether two bindings name the same folder, allowing for a case-insensitive platform. */
function sameVaultPath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Bind a local folder to a remote vault and store the binding. It prints nothing: the
 * command that called it decides what to report, so `vault create --json` can emit one
 * machine-readable line.
 *
 * When the command states `--history-limit-*`, those flags go to the **server** (the
 * limits are vault-level state) and the returned `historyLimits` is what the vault now
 * holds; without them it is whatever the server last reported (or `null` if that read
 * failed — the limits are not something a bind has to have).
 */
async function bindVault(
  config: CliConfig,
  options: BindVaultOptions,
): Promise<{ vault: CliVault; count: number; historyLimits: HistoryLimits | null }> {
  const previous = findVault(config, options.vaultId) ?? undefined;
  assertPathFree(config, options.vaultId, options.path);
  // A binding's sync state is keyed by vault id, not by folder. Re-binding the same vault
  // to a different folder must not read the old folder's recorded paths as local
  // deletions — that would push a delete for every file the old folder had synced.
  const movedFolder = previous !== undefined && !sameVaultPath(previous.vaultPath, options.path);
  if (movedFolder) {
    clearState(options.vaultId);
    clearActivityLog(options.vaultId);
  }

  let fileTypes;
  let excludedFolders;
  let historyLimitPatch = null;
  try {
    fileTypes = fileTypesFromFlags(previous?.fileTypes, options);
    excludedFolders = excludedFoldersFromFlags(previous?.excludedFolders, options);
    historyLimitPatch = historyLimitPatchFromFlags(options);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const client = createCliClient({ serverUrl: config.serverUrl, userKey: config.userKey });
  const me = await client.getMe();
  // Store the server's name for this vault, so the daemon's own log and status say
  // "工作笔记" rather than the local folder's name. A failed list must not fail the bind:
  // the name is display metadata, and the folder/key are what the binding needs.
  const listed = await client.listVaults().catch(() => null);
  const listedVault = listed?.vaults.find((entry) => entry.id === options.vaultId);
  const remoteName = options.vaultName?.trim() || listedVault?.name?.trim() || previous?.vaultName;
  const { encryptionSalt } = await client.getEncryptionSalt(options.vaultId);
  const { keyCheck } = await client.getKeyCheck(options.vaultId);
  const key = await deriveEncryptionKey(options.password, encryptionSalt);
  if (!(await verifyKeyCheck(key, keyCheck))) fail(t("cli.error.incorrectVaultPassword"));
  const encryptionKeyB64 = await exportRawKey(
    // The same derivation the engine uses, with `extractable` so the key can be
    // persisted: re-implementing PBKDF2 here (with its own hardcoded iteration
    // count) is how a CLI key would silently stop matching the vault's.
    await deriveEncryptionKey(options.password, encryptionSalt, true),
  );
  const nextVault: CliVault = {
    vaultId: options.vaultId,
    vaultPath: options.path,
    vaultName: remoteName,
    encryptionKeyB64,
    deviceName: normalizeDeviceName(
      options.deviceName?.trim() || previous?.deviceName || config.deviceName,
    ),
    fileTypes,
    excludedFolders,
  };
  const vaults = previous
    ? config.vaults.map((entry) => (entry.vaultId === options.vaultId ? nextVault : entry))
    : [...config.vaults, nextVault];
  // The same check over the final set catches an overlap the excluded self entry could
  // hide (for example, changing a path onto a sibling).
  const overlap = overlappingVaults(vaults);
  if (overlap) {
    fail(
      t("cli.error.vaultPathOverlap", {
        path: overlap[0].vaultPath,
        other: `${vaultLabel(overlap[1])} (${overlap[1].vaultPath})`,
      }),
    );
  }
  saveConfig({ ...config, vaults, accountMaxFileBytes: me.maxFileBytes });
  const historyLimits = historyLimitPatch
    ? historyLimitsOf(await client.updateVault(options.vaultId, historyLimitPatch))
    : listedVault
      ? historyLimitsOf(listedVault)
      : null;
  return { vault: nextVault, count: vaults.length, historyLimits };
}

/**
 * Stop this daemon when the supervisor's pipe on stdin closes, calling `onClose` at most
 * once.
 *
 * A supervisor — the desktop app — starts the daemon with a pipe on stdin and keeps its
 * write end open for as long as it runs, so this end reads EOF exactly when the supervisor
 * is gone: a quit, a crash, or a force-kill that runs no cleanup code. macOS has no
 * parent-death signal (a child is only reparented to launchd), which makes this the one way
 * a daemon there hears about its supervisor. Only when the supervisor asks: a terminal
 * `run` with stdin redirected to `/dev/null` reads EOF at once, and a daemon must not stop
 * because nothing is on its stdin.
 *
 * A real pipe close reports both `end` and `close`, so the one-shot is the normal path, not
 * an edge; the caller keeps its own guard for a signal that arrives at the same time.
 */
export function watchSupervisor(
  onClose: () => void,
  env: NodeJS.ProcessEnv = process.env,
  stdin: NodeJS.ReadStream = process.stdin,
): void {
  if (env.COURIER_DAEMON_SUPERVISED !== "1") return;
  let fired = false;
  const closeOnce = () => {
    if (fired) return;
    fired = true;
    onClose();
  };
  stdin.resume();
  // The resumed pipe is a live handle of its own. Unreferenced, it still reports EOF, but
  // it no longer keeps the process alive by itself: a daemon whose run loop ends on its own
  // (a revoked key, a deleted vault, a fatal error) has nothing else pending, and must exit
  // there instead of lingering with a stale runtime record.
  (stdin as { unref?: () => void }).unref?.();
  stdin.on("end", closeOnce);
  stdin.on("close", closeOnce);
}

/**
 * Build the whole command surface.
 *
 * Kept out of `main.ts` so the entry point can resolve the language **before** any
 * description is rendered, and so a test can inspect the translated program
 * without `program.parse()` running on import.
 */
export function createProgram(): Command {
  const program = new Command();

  program.name("courier-cli").description(t("cli.description"));
  // Documented here for --help. `main.ts` strips the flag before parsing; the
  // language itself is already applied by then.
  program.option("--lang <locale>", t("cli.option.lang"));

  program
    .command("version")
    .description(t("cli.command.version.description"))
    .option("--json", t("cli.option.json"))
    .action((options: { json?: boolean }) => {
      // A supervisor reads this to identify a binary it did not install (a local
      // build), and a release manifest carries the same version for a downloaded one.
      const identity = {
        version: VERSION,
        gitSha: GIT_SHA,
        buildTime: BUILD_TIME,
        runtime: runtimeLabel(process.versions),
      };
      if (options.json) {
        console.log(JSON.stringify(identity));
        return;
      }
      console.log(t("cli.version.line", identity));
    });

  program
    .command("register")
    .description(t("cli.command.register.description"))
    .requiredOption("--server <url>", t("cli.option.server"))
    .requiredOption("--user-key <key>", t("cli.option.userKey"))
    .option("-n, --name <name>", t("cli.option.name"), hostname())
    .action(async (options: { server: string; userKey: string; name: string }) => {
      const existing = loadConfig();
      const serverUrl = options.server.replace(/\/$/, "");
      const client = createCliClient({ serverUrl, userKey: options.userKey });
      // There is no device to register any more — the name is just a label. But the
      // key still has to be checked, and the vault list is the cheapest authenticated
      // read: failing here beats failing on the first sync. `getMe` also gives the
      // account's administrator-set file cap, cached for later offline use.
      let accountMaxFileBytes: number | undefined;
      try {
        await client.listVaults();
        accountMaxFileBytes = (await client.getMe()).maxFileBytes;
      } catch (err) {
        if (err instanceof ApiClientError && err.status === 401) {
          fail(t("cli.error.invalidUserKey", { error: err.message }));
        }
        throw err;
      }
      const deviceName = normalizeDeviceName(options.name);
      // A different server invalidates **every** binding: each remote vault, its
      // encryption salt/key and every saved fileId belong to that server's database.
      // The device-local bindings are dropped with their state; the user runs
      // `vault connect` again for each vault.
      const serverChanged = existing !== null && existing.serverUrl !== serverUrl;
      if (serverChanged && existing) {
        clearAllState(existing.vaults);
        for (const bound of existing.vaults) clearActivityLog(bound.vaultId);
      }
      saveConfig({
        serverUrl,
        userKey: options.userKey,
        deviceName,
        vaults: serverChanged ? [] : (existing?.vaults ?? []),
        accountMaxFileBytes,
      });
      console.log(t("cli.register.saved", { deviceName }));
      console.log(
        t("cli.register.vaultCount", { count: serverChanged ? 0 : (existing?.vaults.length ?? 0) }),
      );
    });

  program
    .command("logout")
    .description(t("cli.command.logout.description"))
    .action(() => {
      const config = loadConfig();
      if (!config) {
        console.log(t("cli.logout.none"));
        return;
      }
      // The key and the server go with the bindings: a binding without its key cannot
      // sync, and the state files are only reachable through the config this removes.
      clearAllState(config.vaults);
      for (const bound of config.vaults) clearActivityLog(bound.vaultId);
      clearConfig();
      console.log(t("cli.logout.done", { count: config.vaults.length }));
    });

  const vault = program.command("vault").description(t("cli.command.vault.description"));

  vault
    .command("connect")
    .description(t("cli.command.vaultConnect.description"))
    .requiredOption("--id <vaultId>", t("cli.option.vaultId"))
    .requiredOption("--path <path>", t("cli.option.vaultPath"))
    .option("--password <pw>", t("cli.option.password"))
    .option("--device-name <name>", t("cli.option.deviceName"))
    .option("--sync-file-types [types]", t("cli.option.syncFileTypes"))
    .option("--sync-other-types", t("cli.option.syncOtherTypes"))
    .option("--exclude-folders <paths>", t("cli.option.excludeFolders"))
    .option("--history-limit-documents <n>", t("cli.option.historyLimitDocuments"))
    .option("--history-limit-attachments <n>", t("cli.option.historyLimitAttachments"))
    .action(
      async (options: {
        id: string;
        path: string;
        password?: string;
        deviceName?: string;
        syncFileTypes?: string | boolean;
        syncOtherTypes?: boolean;
        excludeFolders?: string;
        historyLimitDocuments?: string;
        historyLimitAttachments?: string;
      }) => {
        const config = requireConfig();
        const password = options.password ?? process.env.COURIER_VAULT_PASSWORD;
        if (!password) fail(t("cli.error.vaultPasswordRequired"));
        if (options.deviceName !== undefined && !options.deviceName.trim()) {
          fail(t("cli.error.deviceNameRequired"));
        }
        // Before anything is written: a binding to a server this build cannot talk to
        // would only be a folder that never syncs.
        await requireCompatibleServer(config);
        const {
          vault: bound,
          count,
          historyLimits,
        } = await bindVault(config, {
          vaultId: options.id,
          path: options.path,
          password,
          deviceName: options.deviceName,
          syncFileTypes: options.syncFileTypes,
          syncOtherTypes: options.syncOtherTypes,
          excludeFolders: options.excludeFolders,
          historyLimitDocuments: options.historyLimitDocuments,
          historyLimitAttachments: options.historyLimitAttachments,
        });
        console.log(
          t("cli.connect.connected", {
            vaultId: bound.vaultId,
            path: bound.vaultPath,
            count,
          }),
        );
        console.log(t("cli.connect.deviceName", { value: vaultDeviceName(config, bound) }));
        console.log(t("cli.connect.fileTypes", { value: describeFileTypes(bound) }));
        console.log(
          t("cli.connect.excludedFolders", {
            value: describeExcludedFolders(bound),
          }),
        );
        if (historyLimits) {
          console.log(
            t("cli.connect.historyLimits", { value: describeHistoryLimits(historyLimits) }),
          );
        }
      },
    );

  vault
    .command("create")
    .description(t("cli.command.vaultCreate.description"))
    .requiredOption("--name <name>", t("cli.option.vaultName"))
    .requiredOption("--path <path>", t("cli.option.vaultPath"))
    .option("--password <pw>", t("cli.option.password"))
    .option("--device-name <name>", t("cli.option.deviceName"))
    .option("--sync-file-types [types]", t("cli.option.syncFileTypes"))
    .option("--sync-other-types", t("cli.option.syncOtherTypes"))
    .option("--exclude-folders <paths>", t("cli.option.excludeFolders"))
    .option("--history-limit-documents <n>", t("cli.option.historyLimitDocuments"))
    .option("--history-limit-attachments <n>", t("cli.option.historyLimitAttachments"))
    .option("--json", t("cli.option.json"))
    .action(
      async (options: {
        name: string;
        path: string;
        password?: string;
        deviceName?: string;
        syncFileTypes?: string | boolean;
        syncOtherTypes?: boolean;
        excludeFolders?: string;
        historyLimitDocuments?: string;
        historyLimitAttachments?: string;
        json?: boolean;
      }) => {
        const config = requireConfig();
        const password = options.password ?? process.env.COURIER_VAULT_PASSWORD;
        if (!password) fail(t("cli.error.vaultPasswordRequired"));
        if (options.deviceName !== undefined && !options.deviceName.trim()) {
          fail(t("cli.error.deviceNameRequired"));
        }
        const name = options.name.trim();
        if (!name) fail(t("cli.error.vaultNameRequired"));
        if (name.length > 255) fail(t("cli.error.vaultNameTooLong", { max: 255 }));
        // Refuse a taken folder before the remote vault exists: creating one and then
        // failing to bind it would leave a vault nobody asked for.
        assertPathFree(config, "", options.path);
        // ...and refuse an incompatible server before creating one, for the same reason.
        await requireCompatibleServer(config);

        const client = createCliClient({ serverUrl: config.serverUrl, userKey: config.userKey });
        let created: CreateVaultResponse;
        try {
          const encryptionSalt = generateSalt();
          const key = await deriveEncryptionKey(password, encryptionSalt, true);
          created = await client.createVault(name, encryptionSalt, await makeKeyCheck(key));
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
        // The remote vault exists from here on. If binding fails (a network error after
        // the create), remove it again: a vault nobody asked for is worse than a retried
        // command.
        let bound: CliVault;
        let count: number;
        let historyLimits: HistoryLimits | null;
        try {
          ({
            vault: bound,
            count,
            historyLimits,
          } = await bindVault(config, {
            vaultId: created.id,
            path: options.path,
            password,
            deviceName: options.deviceName,
            vaultName: created.name,
            syncFileTypes: options.syncFileTypes,
            syncOtherTypes: options.syncOtherTypes,
            excludeFolders: options.excludeFolders,
            historyLimitDocuments: options.historyLimitDocuments,
            historyLimitAttachments: options.historyLimitAttachments,
          }));
        } catch (err) {
          await client.deleteVault(created.id).catch(() => undefined);
          throw err;
        }
        if (options.json) {
          console.log(JSON.stringify({ id: created.id, name: created.name }));
          return;
        }
        console.log(t("cli.create.created", { name: created.name, id: created.id }));
        console.log(
          t("cli.connect.connected", { vaultId: bound.vaultId, path: bound.vaultPath, count }),
        );
        console.log(t("cli.connect.deviceName", { value: vaultDeviceName(config, bound) }));
        console.log(t("cli.connect.fileTypes", { value: describeFileTypes(bound) }));
        console.log(t("cli.connect.excludedFolders", { value: describeExcludedFolders(bound) }));
        if (historyLimits) {
          console.log(
            t("cli.connect.historyLimits", { value: describeHistoryLimits(historyLimits) }),
          );
        }
      },
    );

  vault
    .command("update")
    .description(t("cli.command.vaultUpdate.description"))
    .requiredOption("--id <vaultId>", t("cli.option.vaultId"))
    .option("--device-name <name>", t("cli.option.deviceName"))
    .option("--sync-file-types [types]", t("cli.option.syncFileTypes"))
    .option("--sync-other-types", t("cli.option.syncOtherTypes"))
    .option("--exclude-folders <paths>", t("cli.option.excludeFolders"))
    .option("--history-limit-documents <n>", t("cli.option.historyLimitDocuments"))
    .option("--history-limit-attachments <n>", t("cli.option.historyLimitAttachments"))
    .action(
      async (options: {
        id: string;
        deviceName?: string;
        syncFileTypes?: string | boolean;
        syncOtherTypes?: boolean;
        excludeFolders?: string;
        historyLimitDocuments?: string;
        historyLimitAttachments?: string;
      }) => {
        const config = requireConfig();
        const bound = findVault(config, options.id);
        if (!bound) fail(t("cli.error.vaultNotBound", { id: options.id }));
        const deviceName = options.deviceName?.trim();
        if (options.deviceName !== undefined && !deviceName) {
          fail(t("cli.error.deviceNameRequired"));
        }
        let fileTypes;
        let excludedFolders;
        let historyLimitPatch = null;
        try {
          fileTypes = fileTypesFromFlags(bound.fileTypes, options);
          excludedFolders = excludedFoldersFromFlags(bound.excludedFolders, options);
          historyLimitPatch = historyLimitPatchFromFlags(options);
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
        // Refresh the stored server name as a side effect, so an existing binding can
        // pick it up without reconnecting; a failed read keeps the stored one.
        const client = createCliClient({ serverUrl: config.serverUrl, userKey: config.userKey });
        const listed = await client.listVaults().catch(() => null);
        const listedVault = listed?.vaults.find((entry) => entry.id === bound.vaultId);
        const vaultName = listedVault?.name?.trim() || bound.vaultName;
        const next: CliVault = {
          ...bound,
          vaultName,
          deviceName: deviceName ? normalizeDeviceName(deviceName) : bound.deviceName,
          fileTypes,
          excludedFolders,
        };
        saveConfig({
          ...config,
          vaults: config.vaults.map((entry) => (entry.vaultId === bound.vaultId ? next : entry)),
        });
        // The limits are the vault's, so a flag is a request to the server; the line below
        // prints what the vault holds afterwards (the PATCH answer, or the read above).
        let historyLimits: HistoryLimits | null = null;
        if (historyLimitPatch) {
          try {
            historyLimits = historyLimitsOf(
              await client.updateVault(bound.vaultId, historyLimitPatch),
            );
          } catch (err) {
            fail(err instanceof Error ? err.message : String(err));
          }
        } else if (listedVault) {
          historyLimits = historyLimitsOf(listedVault);
        }
        console.log(
          t("cli.update.saved", {
            vaultId: bound.vaultId,
            device: vaultDeviceName(config, next),
            fileTypes: describeFileTypes(next),
            folders: describeExcludedFolders(next),
          }),
        );
        if (historyLimits) {
          console.log(
            t("cli.connect.historyLimits", { value: describeHistoryLimits(historyLimits) }),
          );
        }
      },
    );

  vault
    .command("disconnect")
    .description(t("cli.command.vaultDisconnect.description"))
    .requiredOption("--id <vaultId>", t("cli.option.vaultId"))
    .action((options: { id: string }) => {
      const config = requireConfig();
      if (!findVault(config, options.id)) {
        fail(t("cli.error.unknownVault", { vaultId: options.id }));
      }
      const running = daemonStatus(options.id).running;
      clearState(options.id);
      clearActivityLog(options.id);
      const vaults = config.vaults.filter((entry) => entry.vaultId !== options.id);
      saveConfig({ ...config, vaults });
      console.log(t("cli.disconnect.done", { vaultId: options.id, count: vaults.length }));
      if (running) console.log(t("cli.disconnect.running"));
    });

  program
    .command("run")
    .description(t("cli.command.run.description"))
    .option("--vault <vaultId>", t("cli.option.vault"))
    .option("--once", t("cli.option.once"))
    .option("--take-over", t("cli.option.takeOver"))
    .option("--interval <minutes>", t("cli.option.interval"), "30")
    .action(
      async (options: { vault?: string; once?: boolean; takeOver?: boolean; interval: string }) => {
        const config = requireConfig();
        let selected: CliVault;
        let intervalMinutes: number;
        try {
          // A hand-edited config can bind two folders that overlap; two processes would
          // then write the same files. Refuse before the daemon starts.
          const overlap = overlappingVaults(config.vaults);
          if (overlap) {
            throw new Error(
              t("cli.error.vaultPathOverlap", {
                path: overlap[0].vaultPath,
                other: `${vaultLabel(overlap[1])} (${overlap[1].vaultPath})`,
              }),
            );
          }
          // Both decisions throw with what to fix, instead of letting an unusable value
          // reach the daemon (see `options.ts`: `--interval 5m` used to switch the
          // periodic reconcile off without a word).
          selected = selectVaults(config, options.vault)[0]!;
          intervalMinutes = parseIntervalMinutes(options.interval);
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
        // Before the lease, before the engine, before anything: a server this build cannot
        // talk to is a configuration fact, and the daemon must not sit in a retry loop over
        // it. `--once` is refused here too, so both forms answer the same way.
        await requireCompatibleServer(config);
        try {
          if (options.once) {
            await runOnceSync(config, selected, {
              onLog: (message) => console.log(message),
              takeOver: options.takeOver,
            });
            return;
          }
          // A failed **startup pass** is tolerated inside the daemon — it comes up and
          // retries on the interval — so what is reported here is a genuine failure (a
          // config the client cannot use) as one line rather than an unhandled rejection.
          const handle: RunnerHandle = await runDaemon(config, selected, {
            intervalMinutes,
            takeOver: options.takeOver,
            onLog: (message) => console.log(message),
            // A failure after the first attempt (a filesystem error while reacquiring
            // the lease) cannot reject runDaemon: the caller already has the handle.
            onFatal: (err) => fail(err.message),
          });
          let stopping = false;
          const shutdown = () => {
            // A supervisor's pipe closing and a signal can both ask; the drain runs once.
            if (stopping) return;
            stopping = true;
            console.log(t("cli.run.stopping"));
            // Releasing the vault lease is a filesystem write; exiting first would leave the
            // plugin waiting for the TTL after this process is already gone.
            void handle.stop().finally(() => process.exit(0));
            // Last resort if a drain never settles; give it the same budget a supervisor
            // uses before it force-stops the process, not a mere one second.
            setTimeout(() => process.exit(0), 5_000).unref();
          };
          process.on("SIGINT", shutdown);
          process.on("SIGTERM", shutdown);
          // A supervisor's pipe closing is the manager's death, not an input to read.
          watchSupervisor(shutdown);
          console.log(
            t("cli.run.started", {
              vault: `${vaultLabel(selected)} (${selected.vaultId})`,
              vaultId: selected.vaultId,
              vaultPath: selected.vaultPath,
              serverUrl: config.serverUrl,
              deviceName: vaultDeviceName(config, selected),
            }),
          );
        } catch (err) {
          fail(err instanceof Error ? err.message : String(err));
        }
      },
    );

  program
    .command("status")
    .description(t("cli.command.status.description"))
    .option("--vault <vaultId>", t("cli.option.vault"))
    .option("--json", t("cli.option.json"))
    .action(async (options: { vault?: string; json?: boolean }) => {
      const config = requireConfig();
      const selected = options.vault ? selectVaults(config, options.vault) : config.vaults;
      // The file cap belongs to the account's key and the administrator sets it, so
      // ask the server for the current value; a cached value is the fallback when it
      // cannot be reached (the daemon would be unable to sync then anyway). The same
      // client reads each vault's retention limits, which are **vault-level** server
      // state: a status read has to show what the server holds, not a local copy.
      const client = createCliClient({ serverUrl: config.serverUrl, userKey: config.userKey });
      let effective = config;
      let vaultLimits = new Map<string, HistoryLimits>();
      try {
        const me = await client.getMe();
        effective = { ...config, accountMaxFileBytes: me.maxFileBytes };
      } catch {
        // Keep the last value written by register/connect/run.
      }
      try {
        const { vaults } = await client.listVaults();
        vaultLimits = new Map(vaults.map((entry) => [entry.id, historyLimitsOf(entry)]));
      } catch {
        // A status block still renders offline; the limit row says it could not be read.
      }
      // The same trip answers whether this CLI can talk to this server at all. It is worth
      // the one request: a daemon that keeps exiting on a mismatch leaves nothing behind
      // (a stopped process has no runtime record), so this is where a headless user finds
      // out why. An unreachable server renders no row, exactly like the limits above.
      let contractIssue: ContractIssue | null = null;
      try {
        const health = await client.getServerInfo();
        const verdict = contractVerdict(health);
        if (verdict !== "ok") contractIssue = { verdict };
      } catch {
        // Offline: the daemon row is the only signal, and that is honest.
      }
      // Conflict files never sync, so they are the only place a resolved conflict is
      // visible on a headless machine; the same listing answers which files the size
      // cap keeps out. Each vault is read under its own scope and state file.
      const inputs: VaultStatusInput[] = [];
      for (const current of selected) {
        const scope = syncScopeOf(current, effective.accountMaxFileBytes);
        const adapter = new FsAdapter(current.vaultPath, scope);
        const lease = await readSyncLease(new LeaseStore(current.vaultPath)).catch(() => null);
        inputs.push({
          vault: current,
          state: loadState(current.vaultId),
          conflictFiles: await adapter.listConflictFiles(),
          oversizeFiles: (await adapter.listOversizeFiles()).map((entry) => entry.path),
          historyLimits: vaultLimits.get(current.vaultId) ?? null,
          daemon: daemonStatus(current.vaultId),
          // A record that has expired, or whose CLI process no longer exists on this
          // machine, is not a current owner: the next acquire takes it over.
          lease: leaseIsCurrent(
            lease,
            Date.now(),
            (pid) => pidAlive(pid, cliPlatform.process),
            hostname(),
          )
            ? lease
            : null,
          coexistence: detectCoexistence(current),
        });
      }
      const report = buildStatusReport(effective, inputs, contractIssue);
      if (options.json) {
        console.log(JSON.stringify(report));
        return;
      }
      for (const statusLine of formatStatusLines(report)) console.log(statusLine);
    });

  const device = program.command("device").description(t("cli.command.device.description"));

  device
    .command("rename <name>")
    .description(t("cli.command.deviceRename.description"))
    .action(async (name: string) => {
      const config = requireConfig();
      // Local only: the name is a label stamped on each push, not a server-side
      // identity. Versions pushed earlier keep the name they were written with. The
      // daemon reads it from this file on every push, so a rename applies without a
      // restart.
      const deviceName = normalizeDeviceName(name);
      saveConfig({ ...config, deviceName });
      console.log(t("cli.device.renamed", { deviceName }));
    });

  return program;
}
