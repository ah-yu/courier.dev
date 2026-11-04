import { execFile, spawn, spawnSync } from "child_process";
import { closeSync, existsSync, openSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { delimiter, join } from "path";
import { promisify } from "util";
import { obsidianLaunchCommand } from "./platform";

/**
 * Thin wrapper around the **official Obsidian CLI**
 * (https://help.obsidian.md/cli), which is how the end-to-end tests drive a
 * real, running Obsidian — two vaults at once, addressed with `vault=<name>`.
 *
 * Why the CLI instead of screenshots or DOM poking: the CLI exposes
 * `eval code="<js>"`, which runs JavaScript inside the vault's renderer. That
 * gives the tests the real `app.vault` API (so writes go through Obsidian's own
 * file layer and produce real vault events) and the real plugin instance
 * (`app.plugins.plugins.courier`), with assertions made on values rather than
 * pixels.
 *
 * **All calls are asynchronous on purpose.** The test server runs inside the
 * same process as the suite, so a synchronous `spawnSync` would block the
 * event loop and deadlock the very HTTP request the evaluated code is waiting
 * on.
 *
 * Notes learned from probing the CLI:
 *   - `eval` **awaits promises** and prints the resolved value after `=> `.
 *   - A vault with no window is still addressable; the CLI brings its context up
 *     on demand, so both test vaults can be driven without opening windows.
 *   - The `create` command resolves its target folder from the *active file*,
 *     which is null in a windowless vault — so writes go through `app.vault.*`
 *     inside `eval` instead.
 */

const execFileAsync = promisify(execFile);

/** Absolute path of the CLI binary. On Windows it is `Obsidian.com`, which
 * `execFile` cannot resolve from a bare name, so the path is resolved here. */
function resolveCliBinary(): string | null {
  const override = process.env.COURIER_OBSIDIAN_CLI;
  if (override) return override;
  if (process.platform !== "win32") return "obsidian";

  const names = ["Obsidian.com", "obsidian.exe", "Obsidian.exe"];
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const fallback = join(local, "Programs", "Obsidian", "Obsidian.com");
    if (existsSync(fallback)) return fallback;
  }
  return null;
}

const CLI_BINARY = resolveCliBinary();

/**
 * Absolute path of the Obsidian app binary, when it can be derived.
 *
 * Windows ships `Obsidian.com` (the CLI redirector) beside `Obsidian.exe`, so the
 * app is the CLI's sibling. macOS is launched by name through `open`, and a Linux
 * installation is not adjacent to the CLI copy in `~/.local/bin`, so there the
 * path has to come from `COURIER_OBSIDIAN_APP`.
 */
function resolveAppPath(): string | undefined {
  const override = process.env.COURIER_OBSIDIAN_APP;
  if (override) return override;
  if (process.platform === "win32") {
    return CLI_BINARY ? CLI_BINARY.replace(/Obsidian\.com$/i, "Obsidian.exe") : "Obsidian.exe";
  }
  return undefined;
}

/** Extra Electron flags for CI (`--no-sandbox --disable-gpu`); empty locally. */
function appFlags(): string[] {
  return (process.env.COURIER_OBSIDIAN_APP_FLAGS ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Absolute path of the resolved Obsidian CLI binary, or `null` when it could not
 * be found. Exposed so tooling can locate the Obsidian executable next to it.
 */
export function obsidianCliPath(): string | null {
  return CLI_BINARY;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface TestVaultNames {
  a: string;
  b: string;
}

/** The two vaults the e2e suite drives, honouring the same env overrides as the dev loop. */
export function testVaultNames(): TestVaultNames {
  return {
    a: process.env.COURIER_OBSIDIAN_VAULT_A ?? "vault_a",
    b: process.env.COURIER_OBSIDIAN_VAULT_B ?? "vault_b",
  };
}

interface ExecFileFailure extends Error {
  code?: number | string;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
}

/** Run one CLI command verbatim. Never rejects on a non-zero exit or a timeout. */
export async function runObsidianCli(
  args: string[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<CliResult> {
  // Checked before the try so a missing CLI is a clear, loud failure rather than
  // being folded into the per-command error shape.
  if (CLI_BINARY === null) {
    throw new Error(
      "Could not find the Obsidian CLI. Is Obsidian installed and its CLI registered " +
        "(on Linux it is copied to ~/.local/bin/obsidian)? Set COURIER_OBSIDIAN_CLI to " +
        "the full path to override.",
    );
  }

  try {
    const { stdout, stderr } = await execFileAsync(CLI_BINARY, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr };
  } catch (err) {
    const failure = err as ExecFileFailure;
    return {
      status: typeof failure.code === "number" ? failure.code : -1,
      stdout: failure.stdout ?? "",
      stderr: failure.killed
        ? `the Obsidian CLI did not answer within ${timeoutMs}ms`
        : (failure.stderr ?? failure.message),
    };
  }
}

/** Last non-empty line of some CLI output. */
function lastLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

/**
 * Normalise an `eval` result. The CLI prints `=> <value>`; depending on the
 * value it may also JSON-quote it, so a single unquoting pass is applied when
 * the payload looks like a JSON string literal.
 *
 * Exported for `cli.test.ts`: this and {@link jsLiteral} are the only parts of the
 * wrapper a unit test can reach — everything else needs a running app — and a miss
 * here turns a successful read into "returned nothing usable".
 */
export function unwrapEvalPayload(stdout: string): string {
  let payload = lastLine(stdout);
  if (payload.startsWith("=>")) payload = payload.slice(2).trim();
  if (payload.startsWith('"') && payload.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed === "string") payload = parsed;
    } catch {
      // Not a JSON string literal — keep the raw payload.
    }
  }
  return payload;
}

/**
 * Escape a value as a single-quoted JavaScript string literal.
 *
 * Deliberately avoids `JSON.stringify`, which emits double quotes: the code
 * argument travels as one argv element, so keeping double quotes out of the
 * payload sidesteps Windows command-line quoting ambiguity.
 */
export function jsLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, "\\n")}'`;
}

/**
 * Run `body` (an async function body) inside the given vault's renderer and
 * return its JSON-decoded result.
 *
 * The body must `return` a JSON-serialisable value. A throw inside the body is
 * surfaced as a rejected promise carrying the original message.
 *
 * **Keep each body small — one step per call.** The CLI hands the command line to
 * Obsidian's **main process** over a socket and JSON-parses it there, in chunks; a
 * multi-kilobyte payload has been observed to arrive truncated, which throws inside the
 * main process (an "is not valid JSON" dialog) and leaves every later CLI call answering
 * "unable to find Obsidian" until the app is restarted. Every helper here is written to
 * that budget, and a case that needs several steps should make several calls rather than
 * one big one.
 */
export async function evalInVault<T>(vault: string, body: string, timeoutMs?: number): Promise<T> {
  const code =
    `(async()=>{${body}})().then(` +
    `r=>'OK:'+JSON.stringify(r===undefined?null:r),` +
    `e=>'ERR:'+(e&&e.message?e.message:String(e)))`;

  const { status, stdout, stderr } = await runObsidianCli(
    [`vault=${vault}`, "eval", `code=${code}`],
    timeoutMs,
  );
  const payload = unwrapEvalPayload(stdout);

  if (payload.startsWith("ERR:")) {
    throw new Error(
      `eval in ${vault} threw: ${payload.slice(4) || stderr.trim() || "unknown error"}`,
    );
  }
  if (!payload.startsWith("OK:")) {
    throw new Error(
      `eval in ${vault} returned nothing usable (exit ${status}).\n` +
        `stdout: ${stdout.trim()}\nstderr: ${stderr.trim()}`,
    );
  }
  return JSON.parse(payload.slice(3)) as T;
}

/** True when the vault is currently open/loaded in Obsidian and answering. */
export async function vaultIsReachable(vault: string): Promise<boolean> {
  try {
    return (await evalInVault<string>(vault, `return app.vault.getName()`, 20_000)) === vault;
  } catch {
    return false;
  }
}

/**
 * What a **running** Obsidian instance thinks of one core plugin.
 *
 * The CLI has no command for this, so it goes through `eval` — and `eval` is the right
 * instrument rather than a workaround, because it reads the app's **own record**, which
 * is precisely the state that does *not* follow a config file another program wrote.
 * `configured` is what the app will write back to `.obsidian/core-plugins.json` when it
 * next saves; `loaded` is whether the plugin instance is running right now. Comparing
 * either with the file on disk is what tells "the peer's settings arrived" apart from
 * "this Obsidian applied them".
 *
 * `app.internalPlugins` is outside the public API (the community `obsidian-typings`
 * documents it: `config`, `getPluginById`, `getEnabledPluginById`, `requestSaveConfig`),
 * so this stays in the test harness and never reaches the plugin. Both halves are read
 * defensively: an app that does not expose them answers `null`/`false` instead of
 * failing a whole run.
 */
export async function corePluginRuntimeState(
  vault: string,
  id: string,
): Promise<{ configured: boolean | null; loaded: boolean }> {
  return await evalInVault<{ configured: boolean | null; loaded: boolean }>(
    vault,
    `const internal = app.internalPlugins;
     const configured = internal && internal.config ? internal.config[${jsLiteral(id)}] : null;
     return {
       configured: typeof configured === "boolean" ? configured : null,
       loaded: Boolean(internal && internal.getEnabledPluginById && internal.getEnabledPluginById(${jsLiteral(id)})),
     };`,
  );
}

/** Reload the Courier plugin in a vault (equivalent to the dev loop's hot reload). */
export async function reloadCourierPlugin(vault: string): Promise<void> {
  const { status, stdout, stderr } = await runObsidianCli([
    `vault=${vault}`,
    "plugin:reload",
    "id=courier",
  ]);
  if (status !== 0) {
    throw new Error(`plugin:reload failed in ${vault}: ${stdout.trim()} ${stderr.trim()}`);
  }
}

/**
 * Turn off Obsidian's **restricted mode** for a vault.
 *
 * A vault that has never been used opens with restricted mode on, which silently
 * keeps every community plugin — including Courier — from loading, even when
 * `community-plugins.json` lists it. Obsidian reloads the vault when this flips.
 *
 * A vault also has to have a window before the CLI can run `eval` in it; see
 * {@link openVaultInObsidian}.
 */
export async function enableCommunityPlugins(vault: string): Promise<void> {
  await runObsidianCli([`vault=${vault}`, "plugins:restrict", "off"]);
}

/** True when a running Obsidian answers the CLI. */
export async function obsidianIsRunning(): Promise<boolean> {
  const { status, stdout } = await runObsidianCli(["version"], 15_000);
  return status === 0 && /\d+\.\d+/.test(stdout);
}

/** Launch Obsidian detached, with the CI flags when they are set. */
export function startObsidianApp(): void {
  const appPath = resolveAppPath();
  if (process.platform === "linux" && !appPath) {
    throw new Error(
      "On Linux the Obsidian app path must be set: " +
        "export COURIER_OBSIDIAN_APP=/path/to/obsidian (the CLI copy in ~/.local/bin is " +
        "not the app).",
    );
  }
  const { command, args } = obsidianLaunchCommand({
    platform: process.platform,
    appPath,
    flags: appFlags(),
  });
  try {
    if (process.platform === "linux") {
      // `spawnSync` would block until the app exits: on Linux the app *is* the
      // command, while Windows' `start` and macOS' `open` return immediately.
      spawn(command, args, { detached: true, stdio: "ignore" }).unref();
      return;
    }
    // The launcher's stderr goes to a file, not a pipe: `cmd /c start` and `open` hand
    // their handles to the app they launch, so a captured pipe would keep `spawnSync`
    // waiting for Obsidian itself to exit — a Windows CI run hung exactly that way.
    const logFile = join(tmpdir(), `courier-obsidian-launch-${process.pid}.log`);
    const fd = openSync(logFile, "w");
    const result = spawnSync(command, args, { stdio: ["ignore", "ignore", fd], windowsHide: true });
    closeSync(fd);
    // A launcher that refuses (a macOS bundle LaunchServices does not know, a Windows
    // `start` with no handler) is otherwise only visible as "Obsidian did not come up"
    // from the wait loop below, which says nothing about why.
    if (result.status !== 0) {
      const detail = readFileSync(logFile, "utf8").trim();
      console.log(
        `[courier:e2e] ${command} ${args.join(" ")} exited with ${String(result.status)}` +
          (detail ? `: ${detail}` : ""),
      );
    }
  } catch {
    // The caller's wait loop reports the failure with more context.
  }
}

/**
 * True when the Obsidian process is running, **without asking the CLI**.
 *
 * Asking the CLI (`obsidian version`) launches the app when it is closed. On CI
 * that would start Electron without `--no-sandbox`, and the run would fail as a
 * confusing timeout inside a windowless instance. It also answers `Vault not
 * found.` on a cold start, because the CLI resolves its vault from a window —
 * which is exactly the state this function has to tell apart from "not running".
 */
export async function appIsRunning(): Promise<boolean> {
  if (process.platform === "win32") return windowsObsidianIsRunning();
  const pattern = resolveAppPath() ?? "Obsidian";
  const result = spawnSync("pgrep", ["-f", pattern], { stdio: "ignore" });
  return result.status === 0;
}

/** `tasklist` answers from the process table, so it works before any vault window exists. */
function windowsObsidianIsRunning(): boolean {
  const result = spawnSync("tasklist", ["/FI", "IMAGENAME eq Obsidian.exe", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 && /obsidian\.exe/i.test(result.stdout ?? "");
}

/**
 * Make sure Obsidian is up, launching it when it is not.
 *
 * The suite assumes a running app, but nothing else guarantees one — and a
 * closed Obsidian is the most common reason a run fails confusingly.
 */
export async function ensureObsidianRunning(timeoutMs = 180_000): Promise<void> {
  if (await appIsRunning()) return;
  console.log("[courier:e2e] Obsidian is not running — starting it ...");
  startObsidianApp();
  const deadline = Date.now() + timeoutMs;
  let nextHeartbeat = Date.now() + 5_000;
  while (Date.now() < deadline) {
    // The process table, not the CLI: a freshly started app has no vault window yet,
    // and the CLI cannot answer anything until one exists (`prepareVault` opens it).
    if (await appIsRunning()) return;
    if (Date.now() >= nextHeartbeat) {
      nextHeartbeat = Date.now() + 5_000;
      console.log(
        `[courier:e2e]   still waiting for Obsidian (${((timeoutMs - (deadline - Date.now())) / 1000).toFixed(0)}s)`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(
    `Obsidian did not come up within ${timeoutMs}ms. Start it manually and retry ` +
      `(the CLI must also be enabled in Settings → General).`,
  );
}

/**
 * Open (or focus) a vault window through the official URI scheme.
 *
 * This is the one call in the harness that can raise the app: Obsidian's URI handler
 * restores a minimized vault window and focuses an existing one (1.14.4's
 * `openVaultById(id, true)`). `prepareVault` therefore reaches for it only when the vault
 * has no window at all — the CLI's `eval` path addresses an existing window with
 * `focus: false`, so polling and every other helper leave the window where it is.
 */
export function openVaultInObsidian(name: string): void {
  const uri = `obsidian://open?vault=${encodeURIComponent(name)}`;
  const { command, args } = obsidianLaunchCommand({
    platform: process.platform,
    appPath: resolveAppPath(),
    uri,
    flags: appFlags(),
  });
  if (process.platform === "linux") {
    // The app binary itself is the command here; wait only for the hand-off to
    // the running instance, never for the app to exit.
    spawn(command, args, { detached: true, stdio: "ignore" }).unref();
  } else {
    spawnSync(command, args, { stdio: "ignore", windowsHide: true });
  }
}

/**
 * Read a note through the first-class `read` command — a second, independent
 * path for asserting what a vault actually contains (nothing to do with the
 * plugin's own bookkeeping).
 */
export async function readVaultFile(vault: string, path: string): Promise<string | null> {
  const { status, stdout, stderr } = await runObsidianCli([
    `vault=${vault}`,
    "read",
    `path=${path}`,
  ]);
  const combined = `${stdout}${stderr}`;
  if (status !== 0 || /not found/i.test(combined)) return null;
  // The command terminates its output with a newline; drop exactly one.
  return stdout.replace(/\r?\n$/, "");
}

/** Paths of the files Obsidian currently indexes in the vault. */
export async function listVaultFiles(vault: string): Promise<string[]> {
  const { stdout } = await runObsidianCli([`vault=${vault}`, "files"]);
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
