#!/usr/bin/env bun
/**
 * Make `bun run dev` work in any checkout, worktrees included.
 *
 * A fresh checkout has no vaults, no dev database and no credentials, and the two
 * fixtures of another checkout carry the same names. This runs before the watcher and
 * leaves the machine in a state where the plugin in both vaults is already signed in
 * against the local dev server:
 *
 * 1. create this checkout's two vault folders (their names carry the worktree name, see
 *    `dev-vaults.ts`) and enable the plugin inside them;
 * 2. register them with Obsidian, when it is closed (it reads its registry only at
 *    startup);
 * 3. once the dev server answers, mint an `ak_` host key, create (or reuse) a dev user
 *    and that user's vault, and write the plugin's `data.json` in both vaults;
 * 4. copy the current build, so an Obsidian that is already open has something to load.
 *
 * Everything here is idempotent and reuses `.courier-dev/dev.json` (gitignored), so a
 * second `bun run dev` is two HTTP reads. The vault's *encryption* password is not stored —
 * the plugin derives it from what the user types — so the first open of each vault asks
 * for `courier-dev` once and remembers the key afterwards.
 *
 * Every failure is a warning: a dev loop that cannot reach its own server must still
 * watch and rebuild.
 */
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { deriveEncryptionKey, exportRawKey, generateSalt, makeKeyCheck } from "@courier/engine";
import { DEFAULT_SETTINGS } from "../src/shared/settings";
import { checkoutSlug, devVaults, pluginDir, repoRoot } from "./dev-vaults.ts";
import { ensureRegistered } from "./obsidian-registry.ts";

const DEFAULT_PASSWORD = "courier-dev";
// `bun run dev` starts the server and this script in parallel; a plugin-only dev run waits
// this long once, then continues without a sign-in rather than blocking the watcher.
const WAIT_FOR_SERVER_MS = 30_000;

const log = (message) => console.log(`[courier:dev] ${message}`);
const warn = (message) => console.warn(`[courier:dev] ${message}`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.env.COURIER_DEV_SETUP === "0") {
  log("COURIER_DEV_SETUP=0 — leaving the vaults alone");
  process.exit(0);
}

const root = repoRoot();
const vaults = devVaults();
const label = checkoutSlug(root) || "main";
// The server reads the same `PORT` (default 3002 in dev). A worktree that runs beside
// another one sets it once and both sides follow, unless the URL is given explicitly.
const devPort = (process.env.PORT ?? "").trim() || "3002";
const serverUrl = (process.env.COURIER_DEV_SERVER_URL ?? `http://localhost:${devPort}`).replace(
  /\/+$/,
  "",
);
const password = process.env.COURIER_DEV_VAULT_PASSWORD ?? DEFAULT_PASSWORD;
const repoint = process.env.COURIER_DEV_REPOINT === "1";
const statePath = join(root, ".courier-dev", "dev.json");

// ── The vault folders ──

/** Create one vault's plugin folder and make sure Obsidian loads the plugin there. */
function prepareVault(vault) {
  mkdirSync(pluginDir(vault.path), { recursive: true });
  const enabledPath = join(vault.path, ".obsidian", "community-plugins.json");
  let enabled = [];
  if (existsSync(enabledPath)) {
    try {
      const parsed = JSON.parse(readFileSync(enabledPath, "utf8"));
      if (Array.isArray(parsed)) enabled = parsed;
    } catch {
      // A corrupt list is replaced rather than failing the dev loop.
    }
  }
  if (!enabled.includes("courier")) enabled.push("courier");
  writeFileSync(enabledPath, `${JSON.stringify(enabled, null, 2)}\n`);
}

/** Put the current build in place; the watcher refreshes it on every rebuild. */
function copyPluginFiles() {
  const files = [
    [join(root, "packages", "plugin", "dist", "main.js"), "main.js"],
    [join(root, "packages", "plugin", "manifest.json"), "manifest.json"],
    [join(root, "packages", "plugin", "styles.css"), "styles.css"],
  ];
  if (!existsSync(files[0][0])) return; // the first build of this run will copy it
  for (const vault of vaults) {
    for (const [from, to] of files) {
      if (existsSync(from)) copyFileSync(from, join(pluginDir(vault.path), to));
    }
  }
}

// ── The dev server ──

interface RequestOptions {
  method?: string;
  key?: string;
  body?: unknown;
}

async function request(
  path: string,
  options: RequestOptions = {},
): Promise<{ ok: boolean; status: number; text: string; json: any }> {
  const { method = "GET", key, body } = options;
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const init: RequestInit = { method, headers };
  // A GET must not carry a body: fetch refuses it, and every read here is one.
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await fetch(`${serverUrl}${path}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

/** Wait for the dev server that `bun run dev` starts in parallel with this script. */
async function waitForServer() {
  const deadline = Date.now() + WAIT_FOR_SERVER_MS;
  let announced = false;
  while (Date.now() < deadline) {
    try {
      if ((await request("/api/health")).ok) return true;
    } catch {
      // Not listening yet.
    }
    if (!announced) {
      log(`waiting for the dev server at ${serverUrl} …`);
      announced = true;
    }
    await delay(500);
  }
  return false;
}

/** Mint a host (`ak_`) key: the only way to create a user, and `apikey` owns it. */
function mintHostKey() {
  const result = spawnSync(
    process.execPath,
    ["src/main.ts", "apikey", "create", `dev-${label}`, "--scopes", "users,status", "--json"],
    { cwd: join(root, "packages", "server"), encoding: "utf8", timeout: 120_000 },
  );
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim() || (result.stdout ?? "").trim();
    throw new Error(
      detail ||
        `apikey create did not finish (status ${String(result.status)}, signal ${String(
          result.signal,
        )}${result.error ? `, ${String(result.error)}` : ""})`,
    );
  }
  const line = (result.stdout ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed?.key === "string") return parsed.key;
  } catch {
    // Not JSON: the command prints the bare key without `--json` being honoured.
  }
  if (line.startsWith("ak_")) return line;
  throw new Error(`could not read a host key from: ${line}`);
}

/** A working user key, minting one through the host key when there is none. */
async function ensureAccount(state) {
  if (state.userKey) {
    const me = await request("/api/me", { key: state.userKey });
    if (me.ok) {
      state.userName = me.json?.name ?? state.userName ?? "";
      return;
    }
    // Only a refusal proves the key is gone; a 5xx or a timeout must not cost the account.
    if (me.status !== 401 && me.status !== 403) {
      throw new Error(`GET /api/me answered ${me.status}: ${me.text.trim()}`);
    }
    state.userKey = "";
  }

  if (state.hostKey) {
    const probe = await request("/api/users", { key: state.hostKey });
    if (!probe.ok) {
      if (probe.status !== 401 && probe.status !== 403) {
        throw new Error(`GET /api/users answered ${probe.status}: ${probe.text.trim()}`);
      }
      state.hostKey = "";
    }
  }
  if (!state.hostKey) state.hostKey = mintHostKey();

  const created = await request("/api/users", {
    method: "POST",
    key: state.hostKey,
    body: { name: `dev ${label}` },
  });
  if (!created.ok) {
    throw new Error(`POST /api/users answered ${created.status}: ${created.text.trim()}`);
  }
  state.userKey = created.json.key;
  state.userId = created.json.id;
  state.userName = created.json.name ?? `dev ${label}`;
}

/**
 * The server-side vault both local vaults sync.
 *
 * Its key material is derived from the dev password; the salt is kept in the state so a
 * rerun writes the same salt into both `data.json` files. The derived key is kept as well
 * — the plugin normally remembers it in the vault's local storage after the first unlock,
 * and `open-vaults.ts` writes that record through the Obsidian CLI so a fresh checkout
 * does not have to be unlocked by hand.
 */
async function ensureVault(state) {
  const fingerprint = new Bun.CryptoHasher("sha256").update(password).digest("hex").slice(0, 16);
  const listed = await request("/api/vaults", { key: state.userKey });
  // A failed read is not "this account has no vaults": minting a new one here would
  // re-bind both vaults to an empty remote and make them upload everything again.
  if (!listed.ok) {
    throw new Error(`GET /api/vaults answered ${listed.status}: ${listed.text.trim()}`);
  }
  const vaultsOnServer = Array.isArray(listed.json?.vaults) ? listed.json.vaults : [];
  const known =
    state.vaultId && state.vaultSalt && state.passwordFingerprint === fingerprint
      ? vaultsOnServer.find((vault) => vault.id === state.vaultId)
      : undefined;

  if (known) {
    state.vaultName = known.name;
  } else {
    const salt = generateSalt();
    const key = await deriveEncryptionKey(password, salt);
    const keyCheck = await makeKeyCheck(key);
    const created = await request("/api/vaults", {
      method: "POST",
      key: state.userKey,
      body: { name: `dev ${label}`, encryptionSalt: salt, keyCheck },
    });
    if (!created.ok) {
      throw new Error(`POST /api/vaults answered ${created.status}: ${created.text.trim()}`);
    }
    state.vaultId = created.json.id;
    state.vaultName = created.json.name ?? `dev ${label}`;
    state.vaultSalt = salt;
    state.passwordFingerprint = fingerprint;
  }

  const key = await deriveEncryptionKey(password, state.vaultSalt, true);
  state.encryptionKeyB64 = await exportRawKey(key);
}

/** A URL as it compares: no trailing slash. */
function normalizeUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

/**
 * Write the connection a completed sign-in would have left in this vault.
 *
 * Two cases are left alone. A vault pointed at **another** server is somebody's own setup
 * (a deployed instance), and re-pointing it at the local dev server would be silent data
 * movement — unless the run sets `COURIER_DEV_REPOINT=1`, or the vault still names the
 * server this checkout used last time (the auto-port wrapper moving the loop). A vault
 * already connected to **this** dev vault keeps its paused state, device label and
 * everything else — `bun run dev` runs on every start, and a developer who paused a vault
 * or renamed the device must not have that undone by starting the watcher.
 */
function writePluginData(vault: any, state: any, previousServerUrl: string): void {
  const file = join(pluginDir(vault.path), "data.json");
  let existing: any = {};
  if (existsSync(file)) {
    try {
      existing = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      warn(`${file} is not valid JSON — replacing it`);
    }
  }
  const existingServer = normalizeUrl(existing.serverUrl);
  // The wrapper moves the loop between ports when one is busy. A vault that still names the
  // server this checkout used last time is the loop's own, not somebody's deployed instance,
  // so following the new port is automatic. Anything else needs the explicit flag.
  const movingFromThisLoop = previousServerUrl !== "" && existingServer === previousServerUrl;
  const sameVault = existing.connectedVaultId === state.vaultId;
  // The old sync state is chain identities for the *old* vault. It is only safe to keep
  // when both the dev server and the target vault are unchanged — a port move on the same
  // database is safe, but a new vault (different salt, a changed dev password, or a fresh
  // database) invalidates every fileId in it.
  const keepDerivedState = movingFromThisLoop && sameVault;
  if (existingServer !== "") {
    if (existingServer !== serverUrl) {
      if (!repoint && !movingFromThisLoop) {
        log(`${vault.name} is signed in to ${existingServer} — left alone`);
        return;
      }
      log(`${vault.name} was signed in to ${existingServer} — re-pointing to ${serverUrl}`);
    } else if (sameVault) {
      log(`${vault.name} is already connected to this dev vault — left alone`);
      return;
    }
  }
  const settings = {
    ...DEFAULT_SETTINGS,
    ...existing,
    serverUrl,
    userKey: state.userKey,
    userName: state.userName ?? null,
    deviceName: vault.deviceName,
    connectedVaultId: state.vaultId,
    connectedVaultName: state.vaultName ?? `dev ${label}`,
    encryptionSalt: state.vaultSalt,
    syncPaused: false,
    vaultConnections: keepDerivedState
      ? {
          ...existing.vaultConnections,
          [state.vaultId]: { deviceName: vault.deviceName, excludedFolders: [] },
        }
      : { [state.vaultId]: { deviceName: vault.deviceName, excludedFolders: [] } },
  };
  // A different remote or a different target vault has different chain identities; the old
  // sync state would name files this device has never seen there. Keep the sign-in, drop
  // the derived state. A plain port change on the same vault keeps it.
  if (!keepDerivedState) delete settings.syncState;
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

// ── Run ──

/** The sign-in a vault already carries, or null when it was never configured. */
function existingConnection(vault) {
  try {
    const data = JSON.parse(readFileSync(join(pluginDir(vault.path), "data.json"), "utf8"));
    if (typeof data.userKey === "string" && data.userKey.startsWith("ck_")) return data;
  } catch {
    // No data.json yet: this checkout has never been configured.
  }
  return null;
}

/**
 * Would provisioning replace a setup that still works?
 *
 * `bun run dev` is not the owner of a vault somebody already signed in by hand; the
 * auto-provisioning exists for the checkout that has nothing, not to overwrite working
 * credentials on every start. A vault pointed at **another** server is not touched —
 * reaching that server to prove the key is not this script's business, and a checkout
 * connected to a deployed instance must survive `bun run dev`. The two exceptions are
 * `COURIER_DEV_REPOINT=1`, and a vault that still names the server this checkout used last
 * time: that one is the loop's own, moved because the auto-port wrapper picked a new port.
 */
async function alreadySignedIn(previousServerUrl: string) {
  const connections = vaults.map((vault) => existingConnection(vault));
  if (connections.some((data) => data === null)) return false;
  for (const data of connections) {
    const own = typeof data.serverUrl === "string" ? data.serverUrl.replace(/\/+$/, "") : "";
    if (own && own !== serverUrl) {
      const movingFromThisLoop = previousServerUrl !== "" && own === previousServerUrl;
      return !(repoint || movingFromThisLoop);
    }
  }
  for (const data of connections) {
    const me = await request("/api/me", { key: data.userKey });
    if (!me.ok) return false;
  }
  return true;
}

async function main() {
  for (const vault of vaults) prepareVault(vault);
  copyPluginFiles();

  const registration = ensureRegistered(vaults.map((vault) => vault.path));
  if (registration.blocked) {
    log(
      "Obsidian is running — `open-vaults` opens the new vaults through it, which registers " +
        "them (with COURIER_DEV_OPEN_VAULTS=0 that step is skipped).",
    );
  } else if (registration.added.length > 0) {
    log(`registered ${registration.added.length} vault(s) with Obsidian`);
  }

  if (!(await waitForServer())) {
    warn(
      `the dev server never answered at ${serverUrl} — the vaults are prepared, but their ` +
        "sign-in was left as it was. Start the full `bun run dev` (server + plugin) to finish it.",
    );
    return;
  }

  const state = loadState();
  const previousServerUrl = normalizeUrl(state.serverUrl);
  const owned = typeof state.vaultId === "string" && state.vaultId.length > 0;
  if (!owned && (await alreadySignedIn(previousServerUrl))) {
    log(
      "the vaults already carry a sign-in — left as they are " +
        "(delete their plugin data.json to have this checkout provisioned instead)",
    );
    return;
  }

  state.serverUrl = serverUrl;
  try {
    await ensureAccount(state);
    await ensureVault(state);
  } catch (err) {
    warn(`could not prepare the dev account: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  saveState(state);
  for (const vault of vaults) writePluginData(vault, state, previousServerUrl);

  for (const vault of vaults) {
    log(`${vault.name} → ${serverUrl} (vault ${state.vaultName}, device "${vault.deviceName}")`);
  }
  log(
    `the development vault password is "${password}" ` +
      "(COURIER_DEV_VAULT_PASSWORD changes it; `open-vaults` usually unlocks both vaults " +
      "for you, so it only matters when Obsidian is not reachable)",
  );
  if (registration.added.length > 0) {
    log("restart Obsidian once, so it picks up the newly registered vaults");
  }
}

await main();
