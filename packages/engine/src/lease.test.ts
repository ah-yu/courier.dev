import { afterEach, describe, expect, it } from "vitest";
import { stubGlobal, restoreGlobals } from "@courier/testing";
import {
  DEFAULT_LEASE_TTL_MS,
  LEASE_FILE,
  SyncLease,
  leaseIsCurrent,
  pidAlive,
  readSyncLease,
  type SyncLeaseInfo,
  type SyncLeaseStore,
} from "./lease";

/**
 * The lease is the correctness boundary between the plugin and the CLI. These tests pin
 * the pieces a timing-based handoff cannot provide: a second writer is refused, a holder
 * that stopped renewing is taken over after the TTL (and a holder whose process is gone
 * at once), and a takeover cannot let both sides own it.
 */

/** A pid no process table can hold, so a record carrying it is provably dead. */
const DEAD_PID = 2_147_483_646;

/** The machine every test record claims to come from, so pid checks are deterministic. */
const HOST = "test-host";

/** The pid running these tests: a process that exists, without importing runtime types. */
function selfPID(): number {
  const pid = (globalThis as { process?: { pid?: number } }).process?.pid ?? 0;
  expect(pid).toBeGreaterThan(0);
  return pid;
}

class MemoryLeaseStore implements SyncLeaseStore {
  dirs = new Set<string>();
  files = new Map<string, string>();
  mtimes = new Map<string, number>();
  constructor(private readonly clock: () => number) {}

  async ensureDir(path: string): Promise<void> {
    this.dirs.add(path);
  }
  async tryCreateDir(path: string): Promise<boolean> {
    if (this.dirs.has(path) || this.files.has(path)) return false;
    this.dirs.add(path);
    this.mtimes.set(path, this.clock());
    return true;
  }
  async tryRename(from: string, to: string): Promise<boolean> {
    if (!this.dirs.has(from) || this.dirs.has(to) || this.files.has(to)) return false;
    this.dirs.delete(from);
    this.dirs.add(to);
    const moved: Array<[string, string]> = [];
    for (const [path, content] of this.files) {
      if (path === from || path.startsWith(`${from}/`)) {
        moved.push([`${to}${path.slice(from.length)}`, content]);
        this.files.delete(path);
      }
    }
    for (const [path, content] of moved) this.files.set(path, content);
    return true;
  }
  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }
  async writeFile(path: string, data: string): Promise<void> {
    const parent = path.slice(0, path.lastIndexOf("/"));
    if (parent) this.dirs.add(parent);
    this.files.set(path, data);
  }
  async removeFile(path: string): Promise<void> {
    this.files.delete(path);
  }
  async removeDir(path: string): Promise<void> {
    this.dirs.delete(path);
    for (const file of this.files.keys()) {
      if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
    }
  }
  async stat(path: string): Promise<{ mtimeMs: number } | null> {
    if (!this.dirs.has(path) && !this.files.has(path)) return null;
    return { mtimeMs: this.mtimes.get(path) ?? this.clock() };
  }
}

function twoLeases(store: MemoryLeaseStore, now: () => number) {
  const first = new SyncLease({
    process,
    store,
    owner: "cli",
    token: "cli-token",
    ttlMs: DEFAULT_LEASE_TTL_MS,
    now,
    host: HOST,
  });
  const second = new SyncLease({
    process,
    store,
    owner: "plugin",
    token: "plugin-token",
    ttlMs: DEFAULT_LEASE_TTL_MS,
    now,
    host: HOST,
  });
  return { first, second };
}

afterEach(() => {
  restoreGlobals();
});

describe("SyncLease", () => {
  it("lets exactly one host acquire, and the next one after release", async () => {
    let now = 1_000;
    const store = new MemoryLeaseStore(() => now);
    const { first, second } = twoLeases(store, () => now);

    expect(await first.acquire()).toBe(true);
    expect(await second.acquire()).toBe(false);
    expect(await readSyncLease(store)).toMatchObject({ owner: "cli", token: "cli-token" });

    await first.release();
    expect(await second.acquire()).toBe(true);
    expect(await readSyncLease(store)).toMatchObject({ owner: "plugin", token: "plugin-token" });
  });

  it("keeps a live lease through renewals and refuses it to the other host", async () => {
    let now = 1_000;
    const store = new MemoryLeaseStore(() => now);
    const { first, second } = twoLeases(store, () => now);

    await first.acquire();
    now += DEFAULT_LEASE_TTL_MS / 2;
    expect(await first.renew()).toBe(true);
    expect(await second.acquire()).toBe(false);
  });

  it("renews only the per-token heartbeat, never the owner record", async () => {
    let now = 1_000;
    const store = new MemoryLeaseStore(() => now);
    const { first } = twoLeases(store, () => now);

    await first.acquire();
    const owner = store.files.get(LEASE_FILE);
    const before = await readSyncLease(store);
    now += 1_000;
    expect(await first.renew()).toBe(true);
    const after = await readSyncLease(store);

    expect(store.files.get(LEASE_FILE)).toBe(owner);
    expect(after!.expiresAt).toBeGreaterThan(before!.expiresAt);
  });

  it("takes over only after the TTL, and the old holder's renew then fails", async () => {
    let now = 1_000;
    const store = new MemoryLeaseStore(() => now);
    const { first, second } = twoLeases(store, () => now);

    await first.acquire();
    now += DEFAULT_LEASE_TTL_MS + 1;
    expect(await second.acquire()).toBe(true);
    const newOwner = store.files.get(LEASE_FILE);
    expect(await first.renew()).toBe(false);
    // The suspended old holder must not replace the new owner's record.
    expect(store.files.get(LEASE_FILE)).toBe(newOwner);
    expect(await readSyncLease(store)).toMatchObject({ owner: "plugin" });
  });

  it("does not let the old holder's release remove the new one", async () => {
    let now = 1_000;
    const store = new MemoryLeaseStore(() => now);
    const { first, second } = twoLeases(store, () => now);

    await first.acquire();
    now += DEFAULT_LEASE_TTL_MS + 1;
    await second.acquire();
    await first.release();
    expect(await readSyncLease(store)).toMatchObject({ token: "plugin-token" });
  });

  it("takes over a stale directory even when the owner record is missing", async () => {
    let now = 10_000;
    const store = new MemoryLeaseStore(() => now);
    const { first } = twoLeases(store, () => now);

    await store.ensureDir(".courier");
    await store.tryCreateDir(".courier/sync-lease");
    store.mtimes.set(".courier/sync-lease", now - DEFAULT_LEASE_TTL_MS - 1);

    expect(await first.acquire()).toBe(true);
    expect(await readSyncLease(store)).toMatchObject({ token: "cli-token" });
  });

  it("reports ownership, survives a repeated acquire, and renews only while held", async () => {
    let now = 1_000;
    const store = new MemoryLeaseStore(() => now);
    const { first } = twoLeases(store, () => now);

    expect(first.owned).toBe(false);
    await first.release(); // releasing a lease never taken is a no-op
    expect(await first.renew()).toBe(false);

    await first.acquire();
    expect(first.owned).toBe(true);
    // A second acquire from the same instance joins its own record.
    expect(await first.acquire()).toBe(true);
    now += 1;
    expect(await first.renew()).toBe(true);
    await first.release();
    expect(first.owned).toBe(false);
    expect(await first.renew()).toBe(false);
    await first.release();
  });

  it("does not claim ownership when the owner record cannot be written", async () => {
    let now = 1_000;
    class FailingStore extends MemoryLeaseStore {
      override async writeFile(): Promise<void> {
        throw new Error("disk full");
      }
    }
    const failing: SyncLeaseStore = new FailingStore(() => now);
    const lease = new SyncLease({
      process,
      store: failing,
      owner: "cli",
      token: "cli-token",
      now: () => now,
    });

    expect(await lease.acquire()).toBe(false);
    expect(lease.owned).toBe(false);
    // The half-created directory was removed, so a later contender is not blocked.
    expect(await failing.stat(".courier/sync-lease")).toBeNull();
  });

  it("works with the production defaults (no token, clock or pid supplied)", async () => {
    const store = new MemoryLeaseStore(() => Date.now());
    const lease = new SyncLease({ store, owner: "cli", process });
    expect(await lease.acquire()).toBe(true);
    expect(lease.owned).toBe(true);
    await lease.release();
  });

  it("still gets a token when the host has no crypto.randomUUID", async () => {
    const store = new MemoryLeaseStore(() => Date.now());
    stubGlobal("crypto", {});
    try {
      const lease = new SyncLease({ store, owner: "plugin", process });
      expect(await lease.acquire()).toBe(true);
      await lease.release();
    } finally {
      restoreGlobals();
    }
  });

  it("does not remove an expired record that may already be taken over", async () => {
    let now = 1_000;
    const store = new MemoryLeaseStore(() => now);
    const lease = new SyncLease({
      store,
      owner: "cli",
      token: "cli-token",
      now: () => now,
      process,
    });
    await lease.acquire();
    now += DEFAULT_LEASE_TTL_MS + 1;

    await lease.release();

    expect(store.dirs.has(".courier/sync-lease")).toBe(true);
  });

  it("fails acquisition when the heartbeat cannot be written, and leaves no lock", async () => {
    let now = 1_000;
    class HeartbeatWriteError extends MemoryLeaseStore {
      override async writeFile(path: string, data: string): Promise<void> {
        if (path.endsWith(".hb")) throw new Error("disk full");
        return super.writeFile(path, data);
      }
    }
    const store = new HeartbeatWriteError(() => now);
    const lease = new SyncLease({
      store,
      owner: "cli",
      token: "cli-token",
      now: () => now,
      process,
    });

    expect(await lease.acquire()).toBe(false);
    expect(await store.stat(".courier/sync-lease")).toBeNull();
  });

  it("falls back to the owner record when the heartbeat cannot be read", async () => {
    let now = 1_000;
    class HeartbeatReadError extends MemoryLeaseStore {
      override async readFile(path: string): Promise<string | null> {
        if (path.endsWith(".hb")) throw new Error("io");
        return super.readFile(path);
      }
    }
    const store = new HeartbeatReadError(() => now);
    const lease = new SyncLease({
      store,
      owner: "cli",
      token: "cli-token",
      now: () => now,
      process,
    });

    expect(await lease.acquire()).toBe(true);
    expect(await readSyncLease(store)).toMatchObject({ token: "cli-token" });
    now += 1_000;
    expect(await lease.renew()).toBe(true);
    await lease.release();
  });

  it("does not delete a directory when the owner record is missing", async () => {
    let now = 1_000;
    const store = new MemoryLeaseStore(() => now);
    const lease = new SyncLease({
      store,
      owner: "cli",
      token: "cli-token",
      now: () => now,
      process,
    });
    await lease.acquire();
    await store.removeFile(".courier/sync-lease/owner.json");

    await lease.release();

    // The directory may belong to a contender that created it but has not written its
    // record yet; leave it for the TTL instead of deleting under that contender.
    expect(store.dirs.has(".courier/sync-lease")).toBe(true);
  });

  it("does not throw when the store cannot clean up or read its own record", async () => {
    let now = 1_000;
    const store = new MemoryLeaseStore(() => now);
    const lease = new SyncLease({
      store,
      owner: "cli",
      token: "cli-token",
      now: () => now,
      process,
    });
    await lease.acquire();

    store.removeFile = async () => {
      throw new Error("read-only");
    };
    store.removeDir = async () => {
      throw new Error("read-only");
    };
    await expect(lease.release()).resolves.toBeUndefined();

    // A release whose owner record cannot even be read must not throw either.
    store.files.clear();
    store.dirs.clear();
    const second = new SyncLease({
      process,
      store,
      owner: "plugin",
      token: "plugin-token",
      now: () => now,
    });
    await second.acquire();
    store.readFile = async () => {
      throw new Error("vanished");
    };
    await expect(second.release()).resolves.toBeUndefined();
    await expect(second.renew()).resolves.toBe(false);
  });

  it("treats a malformed owner record as no lease rather than stealing it blindly", async () => {
    let now = 10_000;
    const store = new MemoryLeaseStore(() => now);
    const { first } = twoLeases(store, () => now);

    await store.ensureDir(".courier/sync-lease");
    await store.writeFile(".courier/sync-lease/owner.json", "{not json");
    // The directory mtime is recent, so a contender waits for the TTL instead of
    // assuming the corrupt record belongs to nobody.
    expect(await first.acquire()).toBe(false);
  });
});

/**
 * Not every exit runs `release()`: a SIGKILL or a crash ends the holder outright, a
 * supervised CLI releases on its way out but cannot if it is killed first, and Obsidian
 * quits without waiting for a plugin's asynchronous release. The record's pid is then the
 * only evidence that nobody is renewing, and waiting out the TTL would describe a process
 * that no longer exists as the writer. A plugin record is one renderer's claim, so the same
 * rule applies to it.
 */
describe("leaseIsCurrent", () => {
  const NOW = 1_000_000;
  const record = (overrides: Partial<SyncLeaseInfo> = {}): SyncLeaseInfo => ({
    version: 1,
    owner: "cli",
    token: "cli-4242-token",
    pid: 4242,
    host: HOST,
    acquiredAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    expiresAt: NOW + DEFAULT_LEASE_TTL_MS,
    ...overrides,
  });

  /** The question as a reader on `HOST` asks it. */
  const current = (
    lease: SyncLeaseInfo | null,
    now = NOW,
    alive: (pid: number) => boolean = (pid) => pidAlive(pid, process),
  ) => leaseIsCurrent(lease, now, alive, HOST);

  it("calls a record current while its process exists", () => {
    expect(pidAlive(selfPID(), process)).toBe(true);
    expect(pidAlive(DEAD_PID, process)).toBe(false);
    // No pid: an environment that cannot answer. Not proof of death.
    expect(pidAlive(0)).toBe(true);
    expect(current(record({ pid: selfPID() }))).toBe(true);
  });

  it("calls a CLI record stale the moment its process is gone, before the TTL", () => {
    expect(current(record({ pid: DEAD_PID }))).toBe(false);
    // The same record is current for a reader that cannot see a process table (mobile).
    expect(current(record({ pid: DEAD_PID }), NOW, () => true)).toBe(true);
  });

  it("keeps a record from another machine to its expiry, where a pid means nothing", () => {
    expect(current(record({ pid: DEAD_PID, host: "another-machine" }))).toBe(true);
    // A record that never named its machine (an older build, or a host that cannot tell).
    const anonymous = record({ pid: DEAD_PID });
    delete anonymous.host;
    expect(current(anonymous)).toBe(true);
    // And a reader that cannot name itself does not judge anybody's pid.
    expect(
      leaseIsCurrent(record({ pid: DEAD_PID }), NOW, (pid) => pidAlive(pid, process), ""),
    ).toBe(true);
  });

  it("treats a plugin record whose process is gone as stale too", () => {
    // A plugin lease belongs to the renderer that wrote it: that process dies with its
    // window or the whole app, and no other window holds the token.
    const plugin = record({ owner: "plugin", pid: selfPID() });
    expect(current(plugin)).toBe(true);
    expect(current(record({ owner: "plugin", pid: DEAD_PID }))).toBe(false);
    // No pid evidence (mobile): only the expiry can end it.
    expect(current(record({ owner: "plugin", pid: 0 }))).toBe(true);
    expect(current(plugin, NOW + DEFAULT_LEASE_TTL_MS)).toBe(false);
    expect(current(null)).toBe(false);
  });

  it("lets a contender take over a killed plugin's record without waiting for the TTL", async () => {
    let now = NOW;
    const store = new MemoryLeaseStore(() => now);
    await store.ensureDir(".courier");
    await store.tryCreateDir(".courier/sync-lease");
    await store.writeFile(
      LEASE_FILE,
      JSON.stringify(record({ owner: "plugin", token: "plugin-token", pid: DEAD_PID })),
    );

    const next = new SyncLease({
      process,
      store,
      owner: "cli",
      token: "cli-token",
      now: () => now,
      host: HOST,
    });
    expect(await next.acquire()).toBe(true);
    expect(await readSyncLease(store)).toMatchObject({ token: "cli-token" });
  });

  it("still waits for a live plugin's record until it expires", async () => {
    let now = NOW;
    const store = new MemoryLeaseStore(() => now);
    await store.ensureDir(".courier");
    await store.tryCreateDir(".courier/sync-lease");
    await store.writeFile(
      LEASE_FILE,
      JSON.stringify(record({ owner: "plugin", token: "plugin-token", pid: selfPID() })),
    );

    const next = new SyncLease({
      process,
      store,
      owner: "cli",
      token: "cli-token",
      now: () => now,
      host: HOST,
    });
    expect(await next.acquire()).toBe(false);

    now += DEFAULT_LEASE_TTL_MS + 1;
    expect(await next.acquire()).toBe(true);
  });

  it("lets a contender take over a killed CLI's record without waiting for the TTL", async () => {
    let now = NOW;
    const store = new MemoryLeaseStore(() => now);
    await store.ensureDir(".courier");
    await store.tryCreateDir(".courier/sync-lease");
    await store.writeFile(LEASE_FILE, JSON.stringify(record({ pid: DEAD_PID })));
    await store.writeFile(
      ".courier/sync-lease/cli-4242-token.hb",
      JSON.stringify({ token: "cli-4242-token", expiresAt: now + DEFAULT_LEASE_TTL_MS }),
    );

    const next = new SyncLease({
      process,
      store,
      owner: "plugin",
      token: "plugin-token",
      now: () => now,
      host: HOST,
    });
    expect(await next.acquire()).toBe(true);
    expect(await readSyncLease(store)).toMatchObject({ token: "plugin-token" });
  });

  it("keeps the lease of a live CLI on another machine, which only expiry can end", async () => {
    let now = NOW;
    const store = new MemoryLeaseStore(() => now);
    await store.ensureDir(".courier");
    await store.tryCreateDir(".courier/sync-lease");
    await store.writeFile(LEASE_FILE, JSON.stringify(record({ pid: DEAD_PID, host: "the-nas" })));

    const next = new SyncLease({
      process,
      store,
      owner: "plugin",
      token: "plugin-token",
      now: () => now,
      host: HOST,
    });
    expect(await next.acquire()).toBe(false);

    now += DEFAULT_LEASE_TTL_MS + 1;
    expect(await next.acquire()).toBe(true);
  });

  it("still waits for a live CLI's record until it expires", async () => {
    let now = NOW;
    const store = new MemoryLeaseStore(() => now);
    await store.ensureDir(".courier");
    await store.tryCreateDir(".courier/sync-lease");
    await store.writeFile(LEASE_FILE, JSON.stringify(record({ pid: selfPID() })));

    const next = new SyncLease({
      process,
      store,
      owner: "plugin",
      token: "plugin-token",
      now: () => now,
      host: HOST,
    });
    expect(await next.acquire()).toBe(false);

    now += DEFAULT_LEASE_TTL_MS + 1;
    expect(await next.acquire()).toBe(true);
  });
});
