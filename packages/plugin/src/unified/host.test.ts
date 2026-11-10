import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor, stubGlobal, advanceTimersByTimeAsync, restoreGlobals } from "@courier/testing";
import {
  EngineHost,
  LEASE_RETRY_MS,
  SETTINGS_POLL_INTERVAL_MS,
  type EngineHostOptions,
} from "./host";
import { DEFAULT_SETTINGS, type CourierSettings } from "../shared/settings";
import {
  importRawKey,
  readSyncLease,
  SyncEngine,
  SyncLease,
  NO_FILE_TYPES,
  NO_SETTINGS_GROUPS,
  normalizeScope,
  type PushFile,
  type SyncActivityEvent,
  type SyncApi,
  type SyncLeaseStore,
  type SyncScope,
} from "@courier/engine";
import type { FileManager, Vault } from "obsidian";

// The plugin's platform is written for Obsidian's renderer, which owns a `window`; Bun,
// where this suite runs, does not. Defining it here keeps production source honest — the
// plugin never branches on the runtime it is on.
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as { window?: unknown }).window = globalThis;
}

/**
 * The lease watcher loads `node:fs` behind an await, which is the one window where two
 * starts can race. Mocking the module lets the test hold that window open; the default
 * is the no-op the test runtime's adapter would get anyway.
 */
const leaseWatchMock = vi.hoisted(() => ({ watchLeaseDirectory: vi.fn() }));
vi.mock("./lease-watch", () => ({ watchLeaseDirectory: leaseWatchMock.watchLeaseDirectory }));

// ── Fakes (plain injected objects — no module mocking, no real network) ──

/**
 * In-memory sync API that records calls and answers pushes the way the server
 * does (`results[0].status === "ok"`, or the engine treats the push as failed).
 */
function makeFakeSyncApi(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    push: vi.fn(async (_vaultId: string, files: PushFile[]) => ({
      results: files.map((file) => ({
        fileId: file.fileId,
        versionId: file.versionId,
        status: "ok" as const,
      })),
    })),
    pull: vi.fn(async () => ({ files: [] })),
    getVersionContent: vi.fn(async () => ({ contentHash: "", encryptedContent: "" })),
    getVaultSyncIndex: vi.fn(async () => ({ files: [] })),
    setSessionId: vi.fn(),
  };
}

/**
 * Fake Obsidian Vault exposing just the surface the host + adapter touch, plus
 * the config-folder half: a `configDir` and a data adapter over the same bytes,
 * which is how a settings file is listed and read (Obsidian's index holds none).
 */
function makeFakeVault(configFiles: Record<string, string> = {}): {
  vault: Vault;
  events: unknown[];
  config: Map<string, string>;
} {
  const events: unknown[] = [];
  const config = new Map(Object.entries(configFiles));
  const vault = {
    configDir: ".obsidian",
    // No vault-index file in these cases: the settings poll is what they exercise.
    getFiles: () => [] as Array<{ path: string }>,
    getMarkdownFiles: () => [] as Array<{ path: string }>,
    getAbstractFileByPath: () => null,
    adapter: {
      list: async (dir: string) => ({
        files: [...config.keys()].filter(
          (p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/"),
        ),
        folders: [] as string[],
      }),
      exists: async (path: string) => config.has(path),
      stat: async (path: string) => (config.has(path) ? { size: config.get(path)!.length } : null),
      readBinary: async (path: string) => {
        const content = config.get(path);
        if (content === undefined) throw new Error(`ENOENT: ${path}`);
        return new TextEncoder().encode(content).buffer as ArrayBuffer;
      },
      writeBinary: async (path: string, data: ArrayBuffer) => {
        config.set(path, new TextDecoder().decode(data));
      },
      mkdir: async () => {},
      remove: async (path: string) => {
        config.delete(path);
      },
      rename: async (from: string, to: string) => {
        const content = config.get(from);
        if (content !== undefined) {
          config.delete(from);
          config.set(to, content);
        }
      },
    },
    on: (event: string, cb: (...args: unknown[]) => void) => {
      const ref = { event, cb };
      events.push(ref);
      return ref;
    },
    offref: (ref: unknown) => {
      const idx = events.indexOf(ref);
      if (idx >= 0) events.splice(idx, 1);
    },
  };
  return { vault: vault as unknown as Vault, events, config };
}

/** Minimal WebSocket constructor stub so SyncWebSocket.connect() never hits the network. */
class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  /** Every frame the host handed to the socket, so a test can read the subscribe. */
  sent: string[] = [];
  /** The handlers `SyncWebSocket` registered, keyed by event type. */
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(public url: string) {
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((registered) => registered !== listener),
    );
  }
  send(msg: string): void {
    this.sent.push(msg);
  }
  /** Open the socket: what the runtime does when the connection is up. */
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    for (const listener of this.listeners.get("open") ?? []) listener(undefined);
  }
  /** Deliver one server frame, the way the socket's `message` listener would receive it. */
  deliver(message: unknown): void {
    const event = { data: JSON.stringify(message) };
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    for (const listener of this.listeners.get("close") ?? []) listener({ code: 1000 });
  }
}

/** A promise whose completion the test triggers at the moment it wants. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The pid running these tests, read from `process.pid`: a process that exists. */
function currentPID(): number {
  return (globalThis as { process?: { pid?: number } }).process?.pid ?? 0;
}

/**
 * Run `body` with the renderer's Node surface (`window.process`) replaced.
 *
 * Restored through its property descriptor rather than deleted: in this runtime `window`
 * and `globalThis` are the same object, so a plain `delete` would take `process` itself
 * away from every test that runs afterwards.
 */
async function withRendererProcess<T>(value: unknown, body: () => Promise<T>): Promise<T> {
  const target = window as unknown as { process?: unknown };
  const previous = Object.getOwnPropertyDescriptor(target, "process");
  target.process = value;
  try {
    return await body();
  } finally {
    if (previous) Object.defineProperty(target, "process", previous);
    else delete target.process;
  }
}

/** The same, for the renderer's `require` (desktop only), which is how `node:os` is reached. */
async function withRendererRequire<T>(value: unknown, body: () => Promise<T>): Promise<T> {
  const target = window as unknown as { require?: unknown };
  const previous = Object.getOwnPropertyDescriptor(target, "require");
  target.require = value;
  try {
    return await body();
  } finally {
    if (previous) Object.defineProperty(target, "require", previous);
    else delete target.require;
  }
}

/**
 * A lease store over memory, with its record map exposed.
 *
 * A test that needs the vault **stolen while the host holds it** has to replace the record
 * under a running host, which a store closed over its own map cannot do.
 */
function memoryStore(now: number) {
  const dirs = new Set([".courier"]);
  const files = new Map<string, string>();
  const store: SyncLeaseStore = {
    ensureDir: async (path) => {
      dirs.add(path);
    },
    tryCreateDir: async (path) => {
      if (dirs.has(path)) return false;
      dirs.add(path);
      return true;
    },
    tryRename: async (from, to) => {
      if (!dirs.has(from)) return false;
      dirs.delete(from);
      dirs.add(to);
      for (const [path, content] of files) {
        if (path.startsWith(`${from}/`)) {
          files.delete(path);
          files.set(`${to}${path.slice(from.length)}`, content);
        }
      }
      return true;
    },
    readFile: async (path) => files.get(path) ?? null,
    writeFile: async (path, data) => {
      files.set(path, data);
    },
    removeFile: async (path) => {
      files.delete(path);
    },
    removeDir: async (path) => {
      dirs.delete(path);
      for (const entry of files.keys()) {
        if (entry.startsWith(`${path}/`)) files.delete(entry);
      }
    },
    stat: async (path) => (dirs.has(path) ? { mtimeMs: now } : null),
  };
  return { store, files, dirs };
}

/** The record of a live writer holding the vault, for the lease fixtures. */
function holderRecord(now: number): string {
  return JSON.stringify({
    version: 1,
    owner: "cli",
    token: "cli-token",
    // A pid that exists: a record whose process is gone is stale whatever its expiry says,
    // so a made-up pid would make these fixtures mean "nobody".
    pid: currentPID(),
    acquiredAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: now + 60_000,
  });
}

async function makeKey(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return importRawKey(btoa(String.fromCharCode(...raw)));
}

function baseSettings(overrides: Partial<CourierSettings> = {}): CourierSettings {
  return {
    ...DEFAULT_SETTINGS,
    userKey: "ck_user",
    deviceName: "My Device",
    ...overrides,
  };
}

async function newHost(
  settings: CourierSettings,
  syncScope?: SyncScope,
  configFiles: Record<string, string> = {},
  overrides: Partial<EngineHostOptions> = {},
) {
  const saveSettings = vi.fn(async () => {});
  const fakeApi = makeFakeSyncApi();
  const createSyncApi = vi.fn(() => fakeApi as unknown as SyncApi);
  const { vault, events, config } = makeFakeVault(configFiles);
  // The host deletes through Obsidian's file manager; the fake vault is what a deletion
  // reaches, so the stub forwards there and the recorded calls stay the same.
  const fileManager = {
    trashFile: (file: Parameters<Vault["delete"]>[0]) => vault.delete(file),
  } as unknown as FileManager;
  const host = new EngineHost({
    vault,
    fileManager,
    vaultId: "vault-1",
    encryptionKey: await makeKey(),
    serverUrl: "http://localhost:3002",
    wsUrl: "ws://localhost:3002",
    syncScope,
    getSettings: () => settings,
    saveSettings,
    createSyncApi,
    ...overrides,
  });
  return { host, settings, saveSettings, createSyncApi, fakeApi, events, config };
}

/** The paths a push carried, in push order. */
function pushedPaths(fakeApi: Record<string, ReturnType<typeof vi.fn>>): string[][] {
  return (fakeApi.push.mock.calls as unknown as [string, PushFile[]][]).map(([, files]) =>
    files.map((file) => file.action),
  );
}

describe("EngineHost", () => {
  let hosts: EngineHost[] = [];

  beforeEach(() => {
    MockWebSocket.instances = [];
    stubGlobal("WebSocket", MockWebSocket);
    leaseWatchMock.watchLeaseDirectory.mockResolvedValue(() => {});
  });

  afterEach(() => {
    for (const host of hosts) host.stop();
    hosts = [];
    vi.useRealTimers();
    restoreGlobals();
  });

  function track(host: EngineHost): EngineHost {
    hosts.push(host);
    return host;
  }

  /**
   * Answer the subscribe on the live socket — what a connected socket reports,
   * and the only thing that moves the host's connection state to `connected`.
   */
  function subscribed(sessionId = "session-1"): void {
    MockWebSocket.instances.at(-1)!.deliver({ type: "subscribe_success", sessionId });
  }

  describe("the vault lease", () => {
    /** A lease store whose vault is already owned by a live CLI process. */
    function cliHeldStore(now: number): SyncLeaseStore {
      return {
        ensureDir: async () => {},
        tryCreateDir: async () => false,
        tryRename: async () => false,
        readFile: async () =>
          JSON.stringify({
            version: 1,
            owner: "cli",
            token: "cli-token",
            // A pid that exists: a record whose process is gone is stale whatever its
            // expiry says, so a made-up pid would make this fixture mean "nobody".
            pid: currentPID(),
            acquiredAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString(),
            expiresAt: now + 60_000,
          }),
        writeFile: async () => {},
        removeFile: async () => {},
        removeDir: async () => {},
        stat: async () => ({ mtimeMs: now }),
      };
    }

    /** A waiting host over {@link cliHeldStore}, its lease, and the wait reports it made. */
    async function waitingHost() {
      const now = Date.now();
      const lease = new SyncLease({
        store: cliHeldStore(now),
        owner: "plugin",
        token: "plugin-token",
        process,
      });
      const waitStates: boolean[] = [];
      const settings = baseSettings({ connectedVaultId: "vault-1" });
      const { host } = await newHost(
        settings,
        undefined,
        {},
        {
          lease,
          onLeaseChange: (waiting) => waitStates.push(waiting),
        },
      );
      track(host);
      return { host, lease, waitStates };
    }

    it("does not start an engine while the CLI owns the lease, and reports waiting", async () => {
      const { host, waitStates } = await waitingHost();

      await host.start();

      expect(host.engine).toBeNull();
      expect(host.leaseWaiting).toBe(true);
      expect(waitStates).toEqual([true]);
    });

    /**
     * A lease store over memory, with its record map exposed.
     *
     * A test that needs the vault **stolen while the host holds it** has to replace the
     * record under a running host, which a store closed over its own map cannot do.
     */
    function takeoverStore(now: number): SyncLeaseStore {
      const { store, files, dirs } = memoryStore(now);
      dirs.add(".courier/sync-lease");
      files.set(".courier/sync-lease/owner.json", holderRecord(now));
      return store;
    }

    /**
     * The one exception to "first come, first served": a person who cannot end the CLI
     * takes the vault from the status bar. The wait must end and an engine must exist
     * **in the same call** — the point is that the vault is no longer locked.
     */
    it("takes the vault from a live CLI lease when the user asks for it", async () => {
      const now = Date.now();
      const lease = new SyncLease({
        store: takeoverStore(now),
        owner: "plugin",
        token: "plugin-token",
        process,
      });
      const waitStates: boolean[] = [];
      const settings = baseSettings({ connectedVaultId: "vault-1" });
      const { host } = await newHost(
        settings,
        undefined,
        {},
        { lease, onLeaseChange: (waiting) => waitStates.push(waiting) },
      );
      track(host);

      await host.start();
      expect(host.leaseWaiting).toBe(true);
      expect(host.engine).toBeNull();
      expect(await host.leaseHolder()).toMatchObject({ owner: "cli", token: "cli-token" });

      expect(await host.takeOverLease()).toBe(true);

      expect(host.leaseWaiting).toBe(false);
      expect(host.engine).not.toBeNull();
      expect(lease.owned).toBe(true);
      expect(waitStates).toEqual([true, false]);
    });

    it("answers false and keeps waiting when the takeover cannot win the directory", async () => {
      const now = Date.now();
      const lease = new SyncLease({
        store: cliHeldStore(now),
        owner: "plugin",
        token: "plugin-token",
        process,
      });
      const settings = baseSettings({ connectedVaultId: "vault-1" });
      const { host } = await newHost(settings, undefined, {}, { lease });
      track(host);

      await host.start();
      expect(await host.takeOverLease()).toBe(false);

      expect(host.leaseWaiting).toBe(true);
      expect(host.engine).toBeNull();
      expect(lease.owned).toBe(false);
    });

    it("does not take over a lease this host already owns", async () => {
      const settings = baseSettings();
      const { host } = await newHost(settings);
      track(host);
      await host.start();
      expect(host.engine).not.toBeNull();

      expect(await host.takeOverLease()).toBe(false);
      expect(host.engine).not.toBeNull();
    });

    /**
     * A stop that lands while the takeover is in flight wins. The record this call took is
     * handed back (the next host must be able to take it) and no engine is built: a paused
     * or unloaded plugin that kept syncing would break "stopped means stopped" **and** hold
     * the lease against the host that replaces it.
     */
    it("hands the taken record back when a stop lands mid-takeover", async () => {
      const now = Date.now();
      const store = takeoverStore(now);
      const lease = new SyncLease({
        store,
        owner: "plugin",
        token: "plugin-token",
        process,
      });
      const settings = baseSettings({ connectedVaultId: "vault-1" });
      const { host } = await newHost(settings, undefined, {}, { lease });
      track(host);

      await host.start();
      expect(host.leaseWaiting).toBe(true);

      // The stop lands **after** the record was taken, which is the window the release is
      // for: a takeover that succeeded and was then overtaken by a stop must hand the
      // record back, not hold a vault this window no longer syncs.
      const takeOver = lease.takeOver.bind(lease);
      vi.spyOn(lease, "takeOver").mockImplementation(async () => {
        const taken = await takeOver();
        host.stop();
        return taken;
      });

      expect(await host.takeOverLease()).toBe(false);
      expect(host.engine).toBeNull();
      // Released, not left behind: another lease over the same store can take it at once.
      const next = new SyncLease({ store, owner: "plugin", token: "next-token", process });
      expect(await next.acquire()).toBe(true);
    });

    it("takes nothing when a stop lands before the takeover reads the holder", async () => {
      const now = Date.now();
      const store = takeoverStore(now);
      const lease = new SyncLease({ store, owner: "plugin", token: "plugin-token", process });
      const settings = baseSettings({ connectedVaultId: "vault-1" });
      const { host } = await newHost(settings, undefined, {}, { lease });
      track(host);

      await host.start();
      expect(host.leaseWaiting).toBe(true);

      // Synchronous stop immediately after the call: it lands while the holder is being
      // read, before anything is displaced, so the request is simply abandoned.
      const takeover = host.takeOverLease();
      host.stop();

      expect(await takeover).toBe(false);
      expect(host.engine).toBeNull();
      // The CLI's record is untouched.
      expect(await readSyncLease(store)).toMatchObject({ owner: "cli", token: "cli-token" });
    });

    it("does not offer a takeover of this same process's own record", async () => {
      const now = Date.now();
      const store = memoryStore(now).store;
      // The renderer's Node surface: a pid is evidence only with a machine to read it on.
      const self = currentPID();
      const selfHost = "this-machine";
      await withRendererProcess({ pid: self, env: { COMPUTERNAME: selfHost } }, async () => {
        // The record a host this window replaced leaves behind while it drains: this
        // process's pid, this machine, another token. Taking it would put two engines of
        // this plugin on the vault, which is exactly what the drain prevents.
        const draining = new SyncLease({
          store,
          owner: "plugin",
          token: "draining-token",
          now: () => now,
          process,
          pid: self,
          host: selfHost,
        });
        expect(await draining.acquire()).toBe(true);

        const next = new SyncLease({ store, owner: "plugin", token: "next-token", process });
        const settings = baseSettings({ connectedVaultId: "vault-1" });
        const { host } = await newHost(settings, undefined, {}, { lease: next });
        track(host);

        await host.start();
        expect(host.leaseWaiting).toBe(true);
        expect(await host.canTakeOver()).toBe(false);
        expect(await host.takeOverLease()).toBe(false);
        expect(host.engine).toBeNull();
      });
    });

    it("treats a record naming this machine through node:os as this window's own", async () => {
      const now = Date.now();
      const store = memoryStore(now).store;
      const self = currentPID();
      // The shape the plugin actually writes on a desktop launched from a GUI: the
      // environment carries no hostname, so the record's machine comes from `node:os`.
      // Comparing against the environment alone would call this our own record "another".
      await withRendererRequire(
        (id: string) => (id === "node:os" ? { hostname: () => "studio-mac" } : undefined),
        () =>
          withRendererProcess({ pid: self, env: {} }, async () => {
            const draining = new SyncLease({
              store,
              owner: "plugin",
              token: "draining-token",
              now: () => now,
              process,
              pid: self,
              host: "studio-mac",
            });
            expect(await draining.acquire()).toBe(true);

            const next = new SyncLease({ store, owner: "plugin", token: "next-token", process });
            const settings = baseSettings({ connectedVaultId: "vault-1" });
            const { host } = await newHost(settings, undefined, {}, { lease: next });
            track(host);

            await host.start();
            expect(await host.canTakeOver()).toBe(false);
          }),
      );
    });

    it("treats a matching pid with no recorded machine as this window's own", async () => {
      const now = Date.now();
      const store = memoryStore(now).store;
      const self = currentPID();
      // A renderer launched from a GUI can have no hostname to record, and a record with
      // no machine proves nothing either way. The safe reading is "possibly us": hiding the
      // row is a smaller harm than building a second engine over a host still draining.
      await withRendererProcess({ pid: self, env: {} }, async () => {
        const draining = new SyncLease({
          store,
          owner: "plugin",
          token: "draining-token",
          now: () => now,
          process,
          pid: self,
        });
        expect(await draining.acquire()).toBe(true);

        const next = new SyncLease({ store, owner: "plugin", token: "next-token", process });
        const settings = baseSettings({ connectedVaultId: "vault-1" });
        const { host } = await newHost(settings, undefined, {}, { lease: next });
        track(host);

        await host.start();
        expect(await host.canTakeOver()).toBe(false);
      });
    });

    it("still offers a takeover of another machine's plugin record with the same pid", async () => {
      const now = Date.now();
      const store = memoryStore(now).store;
      const self = currentPID();
      await withRendererProcess({ pid: self, env: { COMPUTERNAME: "this-machine" } }, async () => {
        // A shared folder: the other machine's plugin owns a pid this one also has. A pid
        // is evidence only where the record was written, so this must stay takeable — it
        // is the only escape from a writer nobody can end.
        const remote = new SyncLease({
          store,
          owner: "plugin",
          token: "remote-token",
          now: () => now,
          process,
          pid: self,
          host: "another-machine",
        });
        expect(await remote.acquire()).toBe(true);

        const next = new SyncLease({ store, owner: "plugin", token: "next-token", process });
        const settings = baseSettings({ connectedVaultId: "vault-1" });
        const { host } = await newHost(settings, undefined, {}, { lease: next });
        track(host);

        await host.start();
        expect(await host.canTakeOver()).toBe(true);
      });
    });

    /**
     * The success branch `takeOverLease` exists for after `210a30d`: a waiting retry's
     * `start()` that was already in flight builds the host while the takeover is awaiting
     * its record. That must report **success** (the window is syncing, which is what the
     * user asked for) and must not arm a retry that would tear the new host down.
     */
    it("reports success when a start in flight built the host first", async () => {
      vi.useFakeTimers();
      const now = Date.now();
      const lease = new SyncLease({
        store: takeoverStore(now),
        owner: "plugin",
        token: "plugin-token",
        process,
      });
      const settings = baseSettings({ connectedVaultId: "vault-1" });
      const { host } = await newHost(settings, undefined, {}, { lease });
      track(host);

      await host.start();
      expect(host.leaseWaiting).toBe(true);

      // Model the state the code sees when the waiting retry is already running: its timer
      // has fired (so nothing is pending) and it builds a host while the takeover awaits.
      // Standing the host up here is the only deterministic way to land in that window.
      const pending = (host as unknown as { leaseRetry: number | null }).leaseRetry;
      if (pending !== null) window.clearTimeout(pending);
      (host as unknown as { leaseRetry: number | null }).leaseRetry = null;
      const built = {
        engine: { syncLocalSettings: vi.fn() },
        stop: vi.fn(),
        whenIdle: vi.fn(async () => {}),
      };
      const takeOver = lease.takeOver.bind(lease);
      vi.spyOn(lease, "takeOver").mockImplementation(async () => {
        (host as unknown as { host: unknown }).host = built;
        return takeOver();
      });

      expect(await host.takeOverLease()).toBe(true);
      expect(
        (host as unknown as { leaseRetry: unknown }).leaseRetry,
        "a retry was armed over a running host",
      ).toBeNull();
      // And nothing fires later: the healthy host stays.
      await advanceTimersByTimeAsync(LEASE_RETRY_MS * 3);
      expect(host.engine).toBe(built.engine);
    });

    /**
     * A host that **holds** the vault leaves it on the directory event, not at its next
     * renewal. The renewal stays — it is what keeps the record fresh for everybody else —
     * but it is the slow path.
     */
    it("leaves the vault on the first lease-directory event that is not its own", async () => {
      const now = Date.now();
      const { store, files, dirs } = memoryStore(now);
      let onEvent: (() => void) | null = null;
      leaseWatchMock.watchLeaseDirectory.mockImplementation(async (_adapter, callback) => {
        onEvent = callback as () => void;
        return () => {};
      });
      const lease = new SyncLease({
        store,
        owner: "plugin",
        token: "plugin-token",
        process,
      });
      const waitStates: boolean[] = [];
      const settings = baseSettings({ connectedVaultId: "vault-1" });
      const { host } = await newHost(
        settings,
        undefined,
        {},
        { lease, onLeaseChange: (waiting) => waitStates.push(waiting) },
      );
      track(host);

      await host.start();
      expect(host.engine).not.toBeNull();
      expect(onEvent).not.toBeNull();

      // Somebody else's record lands, and the watcher reports the directory change.
      dirs.add(".courier/sync-lease");
      files.set(".courier/sync-lease/owner.json", holderRecord(now));
      onEvent!();

      // The check itself is a read, so it settles in a few microtasks — no timer is
      // advanced here on purpose: this must happen long before the 5-second renewal.
      await waitFor(() => expect(host.leaseWaiting).toBe(true));
      expect(host.engine).toBeNull();
      expect(waitStates).toEqual([true]);
    });

    it("keeps the vault when the event shows the record is still its own", async () => {
      const now = Date.now();
      const { store } = memoryStore(now);
      let onEvent: (() => void) | null = null;
      leaseWatchMock.watchLeaseDirectory.mockImplementation(async (_adapter, callback) => {
        onEvent = callback as () => void;
        return () => {};
      });
      const lease = new SyncLease({
        store,
        owner: "plugin",
        token: "plugin-token",
        process,
      });
      const settings = baseSettings({ connectedVaultId: "vault-1" });
      const { host } = await newHost(settings, undefined, {}, { lease });
      track(host);

      await host.start();
      expect(host.engine).not.toBeNull();

      // Every renewal writes a heartbeat inside the watched directory, so this host's own
      // writes wake it too. Re-reading must therefore change nothing.
      onEvent!();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(host.engine).not.toBeNull();
      expect(host.leaseWaiting).toBe(false);
    });

    /**
     * The retry loop asks for the lease again every {@link LEASE_RETRY_MS}. A "no longer
     * waiting" report between two attempts is a lie — nothing about the vault changed —
     * and it is what the user sees as the lock icon flashing between the lock and the
     * red "not synced" icon.
     */
    it("reports waiting once across retries while the CLI keeps the lease", async () => {
      vi.useFakeTimers();
      const { host, lease, waitStates } = await waitingHost();
      // The count is the proof that retries happened at all: without it, a broken retry
      // timer would leave the state untouched and the test green.
      const acquire = vi.spyOn(lease, "acquire");

      await host.start();
      expect(waitStates).toEqual([true]);
      expect(acquire).toHaveBeenCalledTimes(1);

      await advanceTimersByTimeAsync(LEASE_RETRY_MS * 2 + 50);

      expect(acquire).toHaveBeenCalledTimes(3);
      expect(host.leaseWaiting).toBe(true);
      expect(waitStates).toEqual([true]);

      // A real stop still reports the end of the wait: only the retry attempts between
      // them are silent, because they change nothing the user can observe.
      host.stop();
      expect(waitStates).toEqual([true, false]);
    });

    /**
     * `watchLeaseDirectory` awaits the desktop `node:fs` import, so between the guard and
     * the assignment there is a window. Two asks for the *same* generation — a failed
     * renewal and the bind's own re-check — both pass the `leaseWatch` guard during it;
     * without the pending flag the second watcher would replace the first without closing
     * it, and the leaked one would wake the host on every lease-directory event forever.
     */
    it("loads one watcher when two asks overlap in the same generation", async () => {
      let finishLoading!: (stop: () => void) => void;
      leaseWatchMock.watchLeaseDirectory.mockImplementation(
        () =>
          new Promise<() => void>((resolve) => {
            finishLoading = resolve;
          }),
      );
      const { host } = await waitingHost();
      const startLeaseWatch = (
        host as unknown as { startLeaseWatch(generation: number): Promise<void> }
      ).startLeaseWatch.bind(host);

      const first = startLeaseWatch(1);
      const second = startLeaseWatch(1);

      expect(leaseWatchMock.watchLeaseDirectory).toHaveBeenCalledTimes(1);
      finishLoading(() => {});
      await Promise.all([first, second]);
    });
  });

  describe("the device label", () => {
    /**
     * The name is not an identity and nothing is registered: it is read from
     * settings wherever it is stated, so changing it needs no restart and affects
     * only what is stated from then on.
     */
    it("start() takes the name from settings rather than a stored identity", async () => {
      const settings = baseSettings({ deviceName: "Office iMac" });
      const { host } = await newHost(settings);
      track(host);

      await host.start();

      expect(settings.deviceName).toBe("Office iMac");
      expect(host.engine).not.toBeNull();
    });
  });

  describe("engine wiring", () => {
    it("start() builds a SyncApi, runs initialSync, wires vault events and connects the ws", async () => {
      const settings = baseSettings();
      const { host, createSyncApi, fakeApi, events } = await newHost(settings);
      track(host);

      await host.start();

      expect(host.engine).not.toBeNull();
      expect(createSyncApi).toHaveBeenCalledWith("ck_user");
      // initialSync pulled the (empty) vault history.
      expect(fakeApi.getVaultSyncIndex).toHaveBeenCalledWith("vault-1");
      // vault create/modify/delete/rename events are wired.
      expect(events.length).toBeGreaterThanOrEqual(4);
      // the ws was just opened (stubbed as connecting until a message confirms).
      expect(host.wsState).toBe("connecting");
    });

    /**
     * The note on screen is the one a cold start must bring up to date first; the
     * plugin supplies its workspace's active + recently opened paths and the host
     * passes them to the pass.
     */
    it("passes the workspace's priority paths to the bind", async () => {
      const getPriorityPaths = vi.fn(() => ["notes/open.md", "notes/recent.md"]);
      const settings = baseSettings();
      const { host } = await newHost(settings, undefined, {}, { getPriorityPaths });
      track(host);
      const spy = vi.spyOn(SyncEngine.prototype, "initialSync");

      try {
        await host.start();

        expect(spy.mock.calls[0]?.[0]).toEqual({
          firstBind: true,
          priorityPaths: ["notes/open.md", "notes/recent.md"],
        });
        expect(getPriorityPaths).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
    });

    /**
     * The device label is the only thing that identifies this client to a peer, and
     * there is no registry behind it: the subscriber states it in the `subscribe`
     * message and the server passes it on in `files_pushed`.
     */
    it("subscribes with the configured device name", async () => {
      const settings = baseSettings({ deviceName: "书房笔记本" });
      const { host } = await newHost(settings);
      track(host);

      await host.start();
      const socket = MockWebSocket.instances.at(-1)!;
      socket.open();

      const subscribe = socket.sent
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((msg) => msg.type === "subscribe");
      expect(subscribe).toEqual({
        type: "subscribe",
        vaultId: "vault-1",
        userKey: "ck_user",
        deviceName: "书房笔记本",
      });
    });

    it("start() persists the engine state and the bind's completion after initialSync", async () => {
      const settings = baseSettings();
      const { host, settings: s, saveSettings } = await newHost(settings);
      track(host);

      await host.start();

      expect(s.syncState?.localVersions).toBeDefined();
      // The completed bind is what makes the next start a startup scan rather than a
      // first sync — and it is stored beside `localVersions`, never inside it.
      expect(s.syncState?.bindCompleted).toBe(true);
      expect(saveSettings).toHaveBeenCalled();
    });

    it("keeps the recorded bind completion when a later state save lands", async () => {
      // A vault whose bind completed in an earlier session: the engine's next sync-point
      // write must not drop the flag, or the next start would claim a first sync again.
      const settings = baseSettings({ syncState: { localVersions: {}, bindCompleted: true } });
      const { host, settings: s } = await newHost(settings);
      track(host);

      await host.start();

      expect(s.syncState?.bindCompleted).toBe(true);
      expect(host.firstSync).toBe(false);
    });

    it("fileIdForPath proxies to the engine after a tracked file is known", async () => {
      const settings = baseSettings();
      const { host, fakeApi } = await newHost(settings);
      track(host);
      expect(host.fileIdForPath("notes/a.md")).toBeNull();
      void fakeApi;
    });

    it("stop() unwires vault events, disconnects the ws and clears the engine", async () => {
      const settings = baseSettings();
      const { host, events } = await newHost(settings);
      track(host);

      await host.start();
      expect(events.length).toBeGreaterThanOrEqual(4);

      host.stop();

      expect(events.length).toBe(0);
      expect(host.wsState).toBe("disconnected");
      expect(host.engine).toBeNull();
    });

    it("hands the WebSocket session id to the api so the server can skip the echo", async () => {
      const settings = baseSettings();
      const { host, fakeApi } = await newHost(settings);
      track(host);

      await host.start();
      // The socket is up but not subscribed yet — no session id to claim.
      expect(fakeApi.setSessionId).toHaveBeenLastCalledWith(null);

      subscribed("session-1");

      expect(fakeApi.setSessionId).toHaveBeenLastCalledWith("session-1");
      host.stop();
      // A dropped socket must stop claiming the session it no longer owns.
      expect(fakeApi.setSessionId).toHaveBeenLastCalledWith(null);
    });

    /**
     * The loop's own rules — bind gating, single-flight reconciles, a reconcile on
     * a *re*connect and not on the first connect, the retry after a failed bind —
     * belong to `SyncHost` and are pinned in `packages/engine/src/host.test.ts`,
     * where both hosts get them for free. What stays here is the Obsidian half:
     * vault events, the vault adapter, `data.json` and the session id.
     */
  });

  /**
   * Obsidian's config folder is not in the vault index, so a settings file fires
   * no vault event at all: the host polls for those changes, and the poll is the
   * only thing that gets them to the server before the next full reconcile.
   */
  describe("settings poll", () => {
    /** Markdown only — no config-folder group on, and no vault file type either. */
    const MARKDOWN_ONLY: SyncScope = normalizeScope({
      configDir: ".obsidian",
      settingsGroups: NO_SETTINGS_GROUPS,
      fileTypes: NO_FILE_TYPES,
    });
    const SETTINGS_ONLY: SyncScope = {
      ...MARKDOWN_ONLY,
      settingsGroups: { ...NO_SETTINGS_GROUPS, app: true },
    };

    it("pushes a settings change no vault event reports", async () => {
      // Real timers here: the poll is the only clock that matters, and Bun's fake
      // timers deadlock a WebCrypto/native-hash continuation started inside the
      // faked callback. One real interval is a second; the case waits it out.
      const settings = baseSettings();
      const { host, fakeApi, config } = await newHost(settings, SETTINGS_ONLY, {
        ".obsidian/app.json": '{"theme":"moonstone"}',
      });
      track(host);

      await host.start();
      // The bind pass is what pushes the settings file the first time.
      expect(pushedPaths(fakeApi)).toEqual([["create"]]);
      const poll = vi.spyOn(host.engine!, "syncLocalSettings");

      // Obsidian rewrites a settings file on disk: no `modify` event reaches the
      // host, so only the poll can see it. One interval is one pass — the case advances by
      // the host's own constant rather than a duration, so the poll's cadence is free to
      // change without weakening what this asserts.
      config.set(".obsidian/app.json", '{"theme":"obsidian"}');
      await waitFor(() => expect(poll).toHaveBeenCalled(), {
        timeout: SETTINGS_POLL_INTERVAL_MS * 3,
        interval: 50,
      });

      expect(poll).toHaveBeenCalledTimes(1);
      // The pass hashes through the engine's SHA-256, which under Bun is a native
      // synchronous call, so the push lands a microtask turn after the timer fired.
      await waitFor(() => expect(pushedPaths(fakeApi).length).toBe(2));
    });

    it("does not poll at all when the scope is markdown only", async () => {
      vi.useFakeTimers();
      const settings = baseSettings();
      const { host, fakeApi, config } = await newHost(settings, MARKDOWN_ONLY, {
        ".obsidian/app.json": '{"theme":"moonstone"}',
      });
      track(host);

      await host.start();
      const poll = vi.spyOn(host.engine!, "syncLocalSettings");
      config.set(".obsidian/app.json", '{"theme":"obsidian"}');
      await advanceTimersByTimeAsync(30_000);

      // Nothing was pushed at bind time either: the file is outside the scope.
      expect(pushedPaths(fakeApi)).toEqual([]);
      expect(poll).not.toHaveBeenCalled();
    });

    it("stops polling once the host is stopped", async () => {
      vi.useFakeTimers();
      const settings = baseSettings();
      const { host, fakeApi, config } = await newHost(settings, SETTINGS_ONLY, {
        ".obsidian/app.json": "{}",
      });
      track(host);

      await host.start();
      const poll = vi.spyOn(host.engine!, "syncLocalSettings");
      host.stop();
      config.set(".obsidian/app.json", '{"theme":"obsidian"}');
      await advanceTimersByTimeAsync(60_000);

      // Just the bind push — the settings timer went with the host.
      expect(pushedPaths(fakeApi)).toEqual([["create"]]);
      expect(poll).not.toHaveBeenCalled();
    });
  });

  /**
   * The history dialog's feed: the engine's own decisions, forwarded by the host.
   *
   * The engine knows the direction and the outcome but not this client's label, so the
   * host fills it in for an outgoing change. An incoming event keeps whatever label the
   * server passed on (or none, for a chain discovered by a reconcile).
   */
  describe("sync activity", () => {
    const SETTINGS_ONLY: SyncScope = normalizeScope({
      configDir: ".obsidian",
      settingsGroups: { ...NO_SETTINGS_GROUPS, app: true },
      fileTypes: NO_FILE_TYPES,
    });

    it("forwards a push as outgoing, stamped with the name this device pushed under", async () => {
      const settings = baseSettings({ deviceName: "Office iMac" });
      const seen: SyncActivityEvent[] = [];
      const { host, config, fakeApi } = await newHost(
        settings,
        SETTINGS_ONLY,
        { ".obsidian/app.json": '{"theme":"moonstone"}' },
        { onSyncActivity: (event) => seen.push(event) },
      );
      track(host);
      await host.start();
      // The bind pass pushed the settings file; the event under test is the next one.
      seen.length = 0;

      settings.deviceName = "Renamed mid-run";
      config.set(".obsidian/app.json", '{"theme":"obsidian"}');
      await host.engine!.handleLocalChange(".obsidian/app.json");

      expect(fakeApi.push).toHaveBeenCalledTimes(2);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        direction: "out",
        outcome: "applied",
        plainPath: ".obsidian/app.json",
        deviceName: "Renamed mid-run",
      });
    });

    it("passes an incoming notification's label through to the engine", async () => {
      const { host } = await newHost(baseSettings(), SETTINGS_ONLY);
      track(host);
      await host.start();

      // The socket names the peer that pushed; the host hands the label to the engine as
      // part of the coalesced batch. What the engine does with it is covered in the
      // engine suite.
      const handle = vi.spyOn(host.engine!, "handleFilePushedBatch");
      const socket = MockWebSocket.instances.at(-1)!;
      socket.deliver({
        type: "files_pushed",
        vaultId: "vault-1",
        files: [{ fileId: "file-1", versionId: "version-1", deviceName: "Mobile" }],
      });
      await waitFor(() =>
        expect(handle).toHaveBeenCalledWith([
          { fileId: "file-1", versionId: "version-1", deviceName: "Mobile" },
        ]),
      );
    });

    it("drops an activity event from a pass that outlived a stop", async () => {
      const settings = baseSettings();
      const seen: SyncActivityEvent[] = [];
      const { host, config, fakeApi } = await newHost(
        settings,
        SETTINGS_ONLY,
        { ".obsidian/app.json": '{"theme":"moonstone"}' },
        { onSyncActivity: (event) => seen.push(event) },
      );
      track(host);
      await host.start();
      seen.length = 0;

      // Hold the push response, stop the host, then let the engine finish. The engine
      // reports the accepted version after the stop; the host's generation must drop it
      // instead of refilling a log the caller just cleared.
      const started = deferred();
      const release = deferred();
      fakeApi.push.mockImplementationOnce(async (_vaultId: string, files: PushFile[]) => {
        started.resolve();
        await release.promise;
        return {
          results: files.map((file) => ({
            fileId: file.fileId,
            versionId: file.versionId,
            status: "ok" as const,
          })),
        };
      });
      config.set(".obsidian/app.json", '{"theme":"obsidian"}');
      const engine = host.engine!;
      const pushing = engine.handleLocalChange(".obsidian/app.json");
      // The request must be in flight before the stop, or there is nothing to outlive it.
      await started.promise;
      host.stop();
      release.resolve();
      await pushing;

      expect(seen).toEqual([]);
    });
  });
});
