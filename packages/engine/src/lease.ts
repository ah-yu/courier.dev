/**
 * One writer per vault.
 *
 * The plugin and the headless CLI run the same engine against the same local folder, so
 * two active hosts would decide from separate snapshots and race: conflict copies at
 * best, a lost write at worst. Observing the other application is not enough — a file
 * change is delivered *after* the other host may already have started, and a config file
 * can be read half-written. Correctness therefore comes from an **atomic lease both hosts
 * take before they build a host**, not from how quickly one notices the other.
 *
 * The lease is a directory under the vault (`.courier/sync-lease`): creating a directory
 * is atomic on the filesystems both hosts support, so exactly one `mkdir` wins. Inside it,
 * `owner.json` names the holder and is written **once**; a per-token heartbeat file is the
 * only thing renewal rewrites. The split matters: a process suspended past its TTL can
 * resume and touch its own heartbeat inside a directory a contender has since taken over,
 * but it can no longer overwrite the new owner record. The stale directory is renamed aside
 * first so two contenders cannot both remove and recreate it.
 *
 * A host that cannot acquire the lease **must not start its engine**. It waits and retries;
 * Obsidian's state is reporting context only, never a handoff rule.
 */

import type { NodeSurface } from "./platform";

export interface SyncLeaseStore {
  /** Create a directory and its parent, if needed. Existing directories are fine. */
  ensureDir(path: string): Promise<void>;
  /** Create exactly this directory; false when it already exists (or creation lost). */
  tryCreateDir(path: string): Promise<boolean>;
  /** Rename a directory; false when the source no longer exists or the target does. */
  tryRename(from: string, to: string): Promise<boolean>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, data: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** Remove a directory and everything under it. Missing is not an error. */
  removeDir(path: string): Promise<void>;
  stat(path: string): Promise<{ mtimeMs: number } | null>;
}

/** Which application owns a lease. Display metadata; the token is the identity. */
export type SyncLeaseOwner = "plugin" | "cli";

export interface SyncLeaseInfo {
  version: 1;
  owner: SyncLeaseOwner;
  token: string;
  /** The holder process's pid; a plugin window records its renderer's pid too. */
  pid: number;
  /**
   * The machine that wrote the record, when it could name itself. A pid is only evidence
   * about a process on **its own** machine, so the record has to say which one that is.
   */
  host?: string;
  acquiredAt: string;
  updatedAt: string;
  /** Epoch milliseconds; a record at or past this instant is stale. */
  expiresAt: number;
}

export interface SyncLeaseOptions {
  store: SyncLeaseStore;
  owner: SyncLeaseOwner;
  /** How long a record stays valid without a renewal. Default 20 s. */
  ttlMs?: number;
  /** Test clock. */
  now?: () => number;
  /** Test token; production leaves it unset. */
  token?: string;
  /** Test pid; production uses the runtime's `process.pid` when it provides one. */
  pid?: number;
  /** This machine's name, recorded in `owner.json`. A host with an OS should pass its own. */
  host?: string;
  /**
   * The Node surface of the runtime this lease runs on (`Platform.process`).
   *
   * Required, and `undefined` is a meaningful value — the plugin on mobile has no process
   * table, and then only the TTL decides whether a record is current. It is required so a
   * host cannot *forget* it: an omitted surface degrades exactly like a missing one, and a
   * contender would then wait out the whole TTL for a holder that is already gone.
   */
  process: NodeSurface | undefined;
}

/** The lease directory, relative to the vault root; a dot directory is out of sync. */
export const LEASE_DIR = ".courier/sync-lease";

/** The owner record inside the lease directory; written once on acquire. */
export const LEASE_FILE = `${LEASE_DIR}/owner.json`;

/** A token is also a file name, so keep it to a conservative portable alphabet. */
const TOKEN_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

function heartbeatPath(token: string): string {
  return `${LEASE_DIR}/${token}.hb`;
}

/** A lease record is stale once its holder has not renewed for this long. */
export const DEFAULT_LEASE_TTL_MS = 20_000;
/** Renewal period: comfortably below the TTL so a slow pass cannot expire a live lease. */
export const LEASE_RENEW_MS = 5_000;

/**
 * This machine's name, from the environment the client runs in.
 *
 * A host with an OS should pass its own (`os.hostname()` in the CLI); this is the fallback
 * for the plugin, whose renderer may only have the environment it inherited. An empty
 * answer is not a failure: it just means pid evidence cannot be used here.
 */
export function currentHost(node?: NodeSurface): string {
  const env = node?.env;
  return (env?.COMPUTERNAME ?? env?.HOSTNAME ?? "").trim();
}

/**
 * Whether a pid names a live process here.
 *
 * Environments without a process table — the plugin on mobile — cannot tell, so they answer
 * `true` and the TTL remains the only clock there. Only `ESRCH` proves absence: any other
 * error (`EPERM` for another user's process, a bad argument from a corrupt record) leaves
 * the claim standing, because wrongly declaring a live holder dead is the one outcome that
 * puts two writers in one vault.
 */
export function pidAlive(pid: number, node?: NodeSurface): boolean {
  if (pid <= 0) return true;
  if (typeof node?.kill !== "function") return true;
  try {
    node.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string } | null)?.code !== "ESRCH";
  }
}

/**
 * Whether a record is still a live claim on the vault: not past its expiry, and — when the
 * record was written on this machine — its process still exists.
 *
 * Liveness is what expiry alone cannot see. Not every exit runs `release()`: a SIGKILL or a
 * crash ends the holder outright, a supervised CLI releases on its way out (the supervisor's
 * pipe closing is one of its stop paths, and it drains first) but cannot if it is killed
 * first, and Obsidian quits without waiting for a plugin's asynchronous release to finish.
 * In those cases the holder's record outlives it by up to the TTL, and without this check
 * every reader — the page, the other application waiting for the vault, a restart —
 * described a process that no longer exists as the writer for seconds.
 *
 * A plugin lease belongs to the **renderer** that wrote it: that process dies with its
 * window (or the whole app), and no other window holds that token, so its pid is evidence
 * in the same way a CLI process's is.
 *
 * The check is deliberately **local**: a pid only names a process on the machine that wrote
 * the record. A vault folder reachable from two machines (a shared folder, not a synced
 * one) would otherwise let one declare the other's live holder dead by looking up a pid
 * that belongs to a different process table — the one way this optimisation could produce
 * the race the lease exists to prevent. Without a host on both sides, or without a pid
 * (a platform with no process table, such as mobile), only expiry decides.
 */
export function leaseIsCurrent(
  lease: SyncLeaseInfo | null,
  now: number,
  /**
   * Whether a pid is a live process **on this machine**. Required, and built from the
   * caller's `NodeSurface`: a default would have to read a global, and a caller that
   * forgot it would silently answer "alive" for every record.
   */
  alive: (pid: number) => boolean,
  /** This machine's name; empty when the runtime cannot say, which skips the pid check. */
  host: string,
): boolean {
  if (!lease || lease.expiresAt <= now) return false;
  if (lease.pid <= 0) return true;
  if (!lease.host || !host || lease.host !== host) return true;
  return alive(lease.pid);
}

/** Read a lease record without owning it. Used by status and diagnostics. */
export async function readSyncLease(store: SyncLeaseStore): Promise<SyncLeaseInfo | null> {
  const raw = await store.readFile(LEASE_FILE);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SyncLeaseInfo>;
    if (
      parsed.version !== 1 ||
      (parsed.owner !== "plugin" && parsed.owner !== "cli") ||
      typeof parsed.token !== "string" ||
      !TOKEN_PATTERN.test(parsed.token) ||
      typeof parsed.expiresAt !== "number"
    ) {
      return null;
    }
    const owner: SyncLeaseInfo = {
      version: 1,
      owner: parsed.owner,
      token: parsed.token,
      pid: typeof parsed.pid === "number" ? parsed.pid : 0,
      ...(typeof parsed.host === "string" ? { host: parsed.host } : {}),
      acquiredAt: typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      expiresAt: parsed.expiresAt,
    };
    // The heartbeat is the current expiry. A missing or malformed one only falls back to
    // the initial record, which still expires without a live renewer.
    const heartbeat = await store.readFile(heartbeatPath(owner.token)).catch(() => null);
    if (heartbeat !== null) {
      try {
        const beat = JSON.parse(heartbeat) as Partial<SyncLeaseInfo>;
        if (beat.token === owner.token && typeof beat.expiresAt === "number") {
          owner.expiresAt = beat.expiresAt;
          if (typeof beat.updatedAt === "string") owner.updatedAt = beat.updatedAt;
        }
      } catch {
        // Fall back to the owner record.
      }
    }
    return owner;
  } catch {
    return null;
  }
}

/**
 * The lease one host holds.
 *
 * `acquire` is safe to call after a failed attempt: it re-reads the record and either
 * joins an existing record owned by this instance's token or reports `false`. `renew`
 * returns false when the lease was taken over; the caller must stop its engine before
 * doing anything else.
 */
export class SyncLease {
  readonly ttlMs: number;
  private readonly now: () => number;
  private readonly token: string;
  private readonly pid: number;
  private readonly host: string;
  /** The Node surface of the runtime this lease runs on, when it has one. */
  private readonly node: NodeSurface | undefined;
  private held = false;
  private acquiredAt = 0;

  constructor(private readonly opts: SyncLeaseOptions) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.node = opts.process;
    this.token = opts.token ?? defaultToken(opts.owner, this.node);
    this.pid = opts.pid ?? defaultPID(this.node);
    this.host = opts.host ?? currentHost(this.node);
  }

  /** Whether this instance currently believes it owns the lease. */
  get owned(): boolean {
    return this.held;
  }

  /** Try to become the only syncer of this vault. */
  async acquire(): Promise<boolean> {
    if (this.held) return this.renew();
    const store = this.opts.store;
    await store.ensureDir(".courier");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (await store.tryCreateDir(LEASE_DIR)) return this.createRecord();

      const existing = await readSyncLease(store);
      if (existing?.token === this.token) {
        this.held = true;
        this.acquiredAt = Date.parse(existing.acquiredAt) || this.now();
        return this.renew();
      }
      if (leaseIsCurrent(existing, this.now(), (pid) => pidAlive(pid, this.node), this.host)) {
        return false;
      }
      if (!existing) {
        // A directory without a readable owner record is either a just-created lease
        // whose owner has not written yet, or a corrupt/stale one. Its mtime decides:
        // a recent directory belongs to someone, an old one is debris.
        const stat = await store.stat(LEASE_DIR);
        if (stat && this.now() - stat.mtimeMs <= this.ttlMs) return false;
      }

      // No owner file, or an expired one. Rename the directory aside first: only one
      // contender can win that rename, so two processes cannot both delete and recreate
      // the lease and both believe they acquired it.
      const quarantine = `${LEASE_DIR}.stale-${this.token}`;
      if (!(await store.tryRename(LEASE_DIR, quarantine))) {
        // Somebody else is taking it over (or it vanished); re-read on the next attempt.
        continue;
      }
      await store.removeDir(quarantine);
      if (await store.tryCreateDir(LEASE_DIR)) return this.createRecord();
    }
    return false;
  }

  /** Extend the lease. False means another host now owns it and this one must stop. */
  async renew(): Promise<boolean> {
    if (!this.held) return false;
    const store = this.opts.store;
    const existing = await readSyncLease(store).catch(() => null);
    if (!existing || existing.token !== this.token) {
      this.held = false;
      return false;
    }
    // Renewal writes a file named for this token, never owner.json. A process resuming
    // after a takeover may therefore leave a stale heartbeat, but cannot replace the new
    // owner record; the read-back below catches that it lost the lease.
    if (!(await this.writeHeartbeat())) return false;
    const after = await readSyncLease(store).catch(() => null);
    if (!after || after.token !== this.token) {
      this.held = false;
      return false;
    }
    return true;
  }

  /** Give the lease up; safe to call when it was never acquired or already lost. */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    const store = this.opts.store;
    const existing = await readSyncLease(store).catch(() => null);
    // Never remove a directory we cannot prove is ours. A missing record is either a
    // contender's just-created lease (owner.json not written yet) or a damaged one; both
    // are safer to leave for the TTL than to delete under the new holder. An expired
    // record may already be taken over, so the stale holder must not remove it either.
    if (!existing || existing.token !== this.token || existing.expiresAt <= this.now()) return;
    await store.removeFile(heartbeatPath(this.token)).catch(() => {});
    await store.removeFile(LEASE_FILE).catch(() => {});
    await store.removeDir(LEASE_DIR).catch(() => {});
  }

  private async createRecord(): Promise<boolean> {
    this.acquiredAt = this.now();
    this.held = true;
    if (!(await this.writeOwner()) || !(await this.writeHeartbeat())) {
      this.held = false;
      await this.opts.store.removeDir(LEASE_DIR).catch(() => {});
      return false;
    }
    return true;
  }

  /** Write the immutable owner record. Only `acquire` calls this. */
  private async writeOwner(): Promise<boolean> {
    const now = this.now();
    const record: SyncLeaseInfo = {
      version: 1,
      owner: this.opts.owner,
      token: this.token,
      pid: this.pid,
      ...(this.host ? { host: this.host } : {}),
      acquiredAt: new Date(this.acquiredAt || now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: now + this.ttlMs,
    };
    try {
      await this.opts.store.ensureDir(LEASE_DIR);
      await this.opts.store.writeFile(LEASE_FILE, JSON.stringify(record));
      return true;
    } catch {
      this.held = false;
      return false;
    }
  }

  private async writeHeartbeat(): Promise<boolean> {
    const now = this.now();
    try {
      await this.opts.store.ensureDir(LEASE_DIR);
      await this.opts.store.writeFile(
        heartbeatPath(this.token),
        JSON.stringify({
          version: 1,
          token: this.token,
          updatedAt: new Date(now).toISOString(),
          expiresAt: now + this.ttlMs,
        }),
      );
      return true;
    } catch {
      this.held = false;
      return false;
    }
  }
}

/** A token unique to this process/host. */
function defaultToken(owner: SyncLeaseOwner, node?: NodeSurface): string {
  // `crypto` is a Web-platform global in both runtimes, and `randomUUID` needs a secure
  // context — which Obsidian's renderer and Bun both are. The fallback covers a
  // `randomUUID` that is missing, not a missing `crypto`: naming it unqualified is what
  // keeps this module free of `globalThis`.
  const random = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
  return `${owner}-${defaultPID(node)}-${random}`;
}

function defaultPID(node?: NodeSurface): number {
  const pid = node?.pid;
  return typeof pid === "number" ? pid : 0;
}
