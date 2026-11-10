import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  waitFor,
  stubGlobal,
  advanceTimersByTimeAsync,
  restoreGlobals,
  realPlatform,
} from "@courier/testing";
import { CONTRACT_GENERATION, sortedCopy } from "@courier/shared";
import {
  LOCAL_DELETE_SEQUENCE_MS,
  LOCAL_EVENT_BURST_FLUSH_MS,
  LOCAL_EVENT_BURST_MAX_FILES,
  LOCAL_EVENT_BURST_SIZE,
  PUSH_NOTIFICATION_FLUSH_MS,
  SyncHost,
  type SyncEventSource,
  type SyncHostOptions,
} from "./host";
import { SyncEngine } from "./engine";
import { importRawKey } from "./crypto";
import { NO_FILE_TYPES } from "./file-types";
import { NO_SETTINGS_GROUPS, normalizeScope, type SyncScope } from "./sync-scope";
import type { SyncAdapter, FileStamp } from "./adapter";
import type { PushFile, SyncApi } from "./api";

/**
 * The host loop, on its own.
 *
 * These are the rules the plugin and the CLI both depend on and that used to be
 * written twice — bind gating, a reconcile that is never re-entered, a reconcile
 * on a *re*connect and not on the first connect, the settings poll, and what
 * happens when the credential dies. The Obsidian wiring (vault events, the vault
 * adapter, `data.json`) is pinned separately in the plugin's `host.test.ts`; what
 * is here needs nothing but a fake adapter, a fake api and a fake event source.
 */

/** An in-memory adapter: enough for the loop's event path, nothing more. */
class FakeAdapter implements SyncAdapter {
  readonly files = new Map<string, Uint8Array>();
  async listSyncableFiles(): Promise<string[]> {
    return sortedCopy(this.files.keys());
  }
  async readFile(path: string): Promise<Uint8Array | null> {
    return this.files.get(path) ?? null;
  }
  async statFile(path: string): Promise<FileStamp | null> {
    const bytes = this.files.get(path);
    return bytes ? { sizeBytes: bytes.byteLength, mtimeMs: 0 } : null;
  }
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, bytes);
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
  async renameFile(from: string, to: string): Promise<void> {
    const bytes = this.files.get(from);
    if (bytes) {
      this.files.delete(from);
      this.files.set(to, bytes);
    }
  }
  async createFolder(): Promise<void> {}
}

/** An `ApiClientError`-shaped refusal, as the shared client throws it. */
function apiError(status: number, code: string): Error {
  return Object.assign(new Error(`Request failed with status ${status}`), { status, code });
}

function fakeApi(): Record<string, ReturnType<typeof vi.fn>> {
  return {
    push: vi.fn(async (_vaultId: string, files: PushFile[]) => ({
      results: files.map((file) => ({
        fileId: file.fileId,
        versionId: file.versionId,
        status: "ok",
      })),
    })),
    pull: vi.fn(async () => ({ files: [] })),
    getVersionContent: vi.fn(async () => new Uint8Array()),
    getVaultSyncIndex: vi.fn(async () => ({ files: [] })),
    setSessionId: vi.fn(),
  };
}

/** The handlers the host installed, so a test can deliver an event by hand. */
interface FakeEventSource extends SyncEventSource {
  handlers: Parameters<SyncEventSource["start"]>[0] | null;
  stopped: boolean;
}

function fakeEventSource(): FakeEventSource {
  return {
    handlers: null,
    stopped: false,
    start(handlers) {
      this.handlers = handlers;
      this.stopped = false;
      return () => {
        this.handlers = null;
        this.stopped = true;
      };
    },
  };
}

/** Minimal WebSocket constructor stub so `SyncWebSocket.connect()` never hits the network. */
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = 0;
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
  /** Deliver one server frame, the way the socket's `message` listener would receive it. */
  deliver(message: unknown): void {
    const event = { data: JSON.stringify(message) };
    for (const listener of this.listeners.get("message") ?? []) listener(event);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    for (const listener of this.listeners.get("close") ?? []) listener(undefined);
  }
}

async function makeKey(): Promise<CryptoKey> {
  const raw = new Uint8Array(32);
  crypto.getRandomValues(raw);
  return importRawKey(btoa(String.fromCharCode(...raw)));
}

/**
 * The host's own logger, collected instead of printed.
 *
 * Most cases here drive a failure path on purpose (a bind the server refuses, a retry that
 * backs off), and the host reports each one. Without this it falls back to `console.error`,
 * which turns a passing suite into a wall of stderr and hides a message that is not expected.
 */
const hostLog = vi.fn();

async function newHost(overrides: Partial<SyncHostOptions> = {}): Promise<{
  host: SyncHost;
  api: Record<string, ReturnType<typeof vi.fn>>;
  events: FakeEventSource;
}> {
  const api = fakeApi();
  const events = fakeEventSource();
  const host = new SyncHost({
    platform: realPlatform,
    vaultId: "vault-1",
    encryptionKey: await makeKey(),
    adapter: new FakeAdapter(),
    api: api as unknown as SyncApi,
    wsUrl: "ws://localhost:3002",
    userKey: "ck_user",
    getDeviceName: () => "My Device",
    eventSource: events,
    stateStore: { load: () => null, save: () => {} },
    log: hostLog,
    ...overrides,
  });
  return { host, api, events };
}

/**
 * A state store whose state is `state`, with a bind-completion flag the test controls.
 *
 * The flag is written beside the state, never into it: `state` is the engine's
 * `localVersions` map (see `SyncStateStore`).
 */
function store(
  state: string | null,
  completed: boolean,
  saveBindCompleted = vi.fn(),
): SyncHostOptions["stateStore"] {
  return {
    load: () => state,
    save: () => {},
    loadBindCompleted: () => completed,
    saveBindCompleted,
  };
}

/** Wait until a gated fake api's bind has reached its index read. */
async function untilIndexRead(api: Record<string, ReturnType<typeof vi.fn>>): Promise<void> {
  while (api.getVaultSyncIndex.mock.calls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Deliver `count` create events, for files the fake adapter already holds.
 *
 * What a bulk write looks like to the host: the bytes are on disk and the watcher reports
 * one event per file, all inside one tick.
 */
function writeBurst(
  adapter: FakeAdapter,
  events: FakeEventSource,
  count: number,
  prefix = "notes/n",
): string[] {
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = `${prefix}-${index}.md`;
    const bytes = new TextEncoder().encode(`# note ${index}`);
    adapter.files.set(path, bytes);
    events.handlers!.changed(path, bytes.byteLength);
    paths.push(path);
  }
  return paths;
}

describe("SyncHost", () => {
  let hosts: SyncHost[] = [];

  beforeEach(() => {
    MockWebSocket.instances = [];
    hostLog.mockClear();
    stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    for (const host of hosts) host.stop();
    hosts = [];
    vi.useRealTimers();
    restoreGlobals();
  });

  function track(host: SyncHost): SyncHost {
    hosts.push(host);
    return host;
  }

  /** Answer the subscribe on the live socket — the only thing that reports `connected`. */
  function subscribed(sessionId = "session-1"): void {
    MockWebSocket.instances.at(-1)!.deliver({
      type: "subscribe_success",
      vaultId: "vault-1",
      sessionId,
    });
  }

  /** Drop the live socket and answer the next connect, on fake timers. */
  async function reconnect(sessionId = "session-back"): Promise<void> {
    MockWebSocket.instances.at(-1)!.close();
    await advanceTimersByTimeAsync(1_000);
    subscribed(sessionId);
    await advanceTimersByTimeAsync(0);
  }

  it("binds the vault on start, and wires the event source and the socket", async () => {
    const settings = { json: null as string | null };
    const { host, api, events } = await newHost({
      stateStore: {
        load: () => settings.json,
        save: (json) => {
          settings.json = json;
        },
      },
    });
    track(host);

    await host.start();

    expect(api.getVaultSyncIndex).toHaveBeenCalledWith("vault-1");
    expect(events.handlers).not.toBeNull();
    expect(MockWebSocket.instances).toHaveLength(1);
    // The bind pass recorded the (empty) state through the injected store.
    expect(settings.json).not.toBeNull();
  });

  /**
   * The server keeps no backlog: `subscribe` is answered with a session id and
   * nothing else, so every `files_pushed` sent while the socket was down is gone.
   */
  it("drops an echo of its own push when the notification arrives", async () => {
    vi.useFakeTimers();
    const { host } = await newHost({ stateStore: store(null, true) });
    track(host);
    await host.start();
    subscribed();
    await advanceTimersByTimeAsync(0);

    const engine = host.engine!;
    vi.spyOn(engine, "consumeOwnPush").mockReturnValue(true);
    const batch = vi.spyOn(engine, "handleFilePushedBatch").mockResolvedValue(undefined);
    MockWebSocket.instances.at(-1)!.deliver({
      type: "files_pushed",
      vaultId: "v-1",
      files: [{ fileId: "mine", versionId: "v-mine" }],
    });

    await advanceTimersByTimeAsync(PUSH_NOTIFICATION_FLUSH_MS);
    expect(engine.consumeOwnPush).toHaveBeenCalledWith("v-mine");
    expect(batch).not.toHaveBeenCalled();
  });

  it("coalesces a burst of notifications into one batched pull", async () => {
    vi.useFakeTimers();
    const { host } = await newHost({ stateStore: store(null, true) });
    track(host);

    await host.start();
    subscribed();
    await advanceTimersByTimeAsync(0);

    const batch = vi.spyOn(host.engine!, "handleFilePushedBatch").mockResolvedValue(undefined);
    const socket = MockWebSocket.instances.at(-1)!;
    for (let index = 0; index < 5; index += 1) {
      socket.deliver({
        type: "files_pushed",
        vaultId: "v-1",
        files: [{ fileId: `f-${index}`, versionId: `v-${index}` }],
      });
    }
    // Held for the short quiet period, not sent one request per notification.
    expect(batch).not.toHaveBeenCalled();

    await advanceTimersByTimeAsync(PUSH_NOTIFICATION_FLUSH_MS);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0].map((event) => event.fileId)).toEqual([
      "f-0",
      "f-1",
      "f-2",
      "f-3",
      "f-4",
    ]);
  });

  /**
   * The regression this fix exists for: a mobile link delivers one push's frames over
   * hundreds of milliseconds. A **fixed** 25 ms window flushed between them, one pull —
   * and one local delete — per file, which is how a thousand deleted notes took minutes
   * on a phone while a LAN peer applied them in one batch.
   */
  it("keeps coalescing notifications that arrive slower than the quiet period", async () => {
    vi.useFakeTimers();
    const { host } = await newHost({ stateStore: store(null, true) });
    track(host);

    await host.start();
    subscribed();
    await advanceTimersByTimeAsync(0);

    const batch = vi.spyOn(host.engine!, "handleFilePushedBatch").mockResolvedValue(undefined);
    const socket = MockWebSocket.instances.at(-1)!;
    for (let index = 0; index < 5; index += 1) {
      socket.deliver({
        type: "files_pushed",
        vaultId: "v-1",
        files: [{ fileId: `f-${index}`, versionId: `v-${index}` }],
      });
      // Each frame lands inside the quiet period, so each one pushes the deadline back.
      await advanceTimersByTimeAsync(10);
    }
    expect(batch).not.toHaveBeenCalled();

    await advanceTimersByTimeAsync(PUSH_NOTIFICATION_FLUSH_MS);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0].map((event) => event.fileId)).toEqual([
      "f-0",
      "f-1",
      "f-2",
      "f-3",
      "f-4",
    ]);
  });

  it("releases a stream that never goes quiet at the cap", async () => {
    vi.useFakeTimers();
    const { host } = await newHost({ stateStore: store(null, true) });
    track(host);

    await host.start();
    subscribed();
    await advanceTimersByTimeAsync(0);

    const batch = vi.spyOn(host.engine!, "handleFilePushedBatch").mockResolvedValue(undefined);
    const socket = MockWebSocket.instances.at(-1)!;
    for (let index = 0; index < 200 && batch.mock.calls.length === 0; index += 1) {
      socket.deliver({
        type: "files_pushed",
        vaultId: "v-1",
        files: [{ fileId: `f-${index}`, versionId: `v-${index}` }],
      });
      // Faster than the quiet period, forever: only the cap can release it.
      await advanceTimersByTimeAsync(20);
    }

    expect(batch).toHaveBeenCalledTimes(1);
    // A second of arrivals (the cap) is many files, not the one-per-window the fixed
    // window produced.
    expect(batch.mock.calls[0]![0].length).toBeGreaterThan(10);
  });

  it("never starts a second pull while one is in flight", async () => {
    vi.useFakeTimers();
    const { host } = await newHost({ stateStore: store(null, true) });
    track(host);

    await host.start();
    subscribed();
    await advanceTimersByTimeAsync(0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const batch = vi
      .spyOn(host.engine!, "handleFilePushedBatch")
      .mockImplementationOnce(() => gate)
      .mockResolvedValue(undefined);
    const socket = MockWebSocket.instances.at(-1)!;

    socket.deliver({
      type: "files_pushed",
      vaultId: "v-1",
      files: [{ fileId: "a", versionId: "v-a" }],
    });
    await advanceTimersByTimeAsync(PUSH_NOTIFICATION_FLUSH_MS);
    expect(batch).toHaveBeenCalledTimes(1);

    // Arrives while the pull is in flight: held for the next one, not queued behind it.
    socket.deliver({
      type: "files_pushed",
      vaultId: "v-1",
      files: [{ fileId: "b", versionId: "v-b" }],
    });
    await advanceTimersByTimeAsync(PUSH_NOTIFICATION_FLUSH_MS);
    expect(batch).toHaveBeenCalledTimes(1);

    release();
    // The pull's tail is a microtask: let it arm the next flush, then wait it out.
    await advanceTimersByTimeAsync(0);
    await advanceTimersByTimeAsync(PUSH_NOTIFICATION_FLUSH_MS);
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[1]![0].map((event) => event.fileId)).toEqual(["b"]);
  });

  it("retries the held notifications after a pull fails", async () => {
    vi.useFakeTimers();
    const { host } = await newHost({ stateStore: store(null, true) });
    track(host);

    await host.start();
    subscribed();
    await advanceTimersByTimeAsync(0);

    let fail!: (err: Error) => void;
    const gate = new Promise<void>((_, reject) => {
      fail = reject;
    });
    const batch = vi
      .spyOn(host.engine!, "handleFilePushedBatch")
      .mockImplementationOnce(() => gate)
      .mockResolvedValue(undefined);
    const socket = MockWebSocket.instances.at(-1)!;

    socket.deliver({
      type: "files_pushed",
      vaultId: "v-1",
      files: [{ fileId: "a", versionId: "v-a" }],
    });
    await advanceTimersByTimeAsync(PUSH_NOTIFICATION_FLUSH_MS);
    expect(batch).toHaveBeenCalledTimes(1);

    // A second frame arrives, and the pull it waits behind fails: the tail still releases
    // the in-flight flag and re-arms, so the held notification is not lost.
    socket.deliver({
      type: "files_pushed",
      vaultId: "v-1",
      files: [{ fileId: "b", versionId: "v-b" }],
    });
    fail(new Error("network down"));
    await advanceTimersByTimeAsync(0);
    await advanceTimersByTimeAsync(PUSH_NOTIFICATION_FLUSH_MS);

    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[1]![0].map((event) => event.fileId)).toEqual(["b"]);
  });

  it("reconciles when the socket comes back, and not on the first connect", async () => {
    vi.useFakeTimers();
    const { host, api } = await newHost();
    track(host);

    await host.start();
    // Only the bind pass `start()` runs so far.
    expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(1);

    // The first connect is the socket `start()` just opened, right behind that bind
    // pass — there is nothing to catch up on.
    subscribed();
    await advanceTimersByTimeAsync(0);
    expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(1);

    await reconnect();
    expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(2);
  });

  it("drops a reconcile the periodic timer asks for while another is running", async () => {
    vi.useFakeTimers();
    const { host, api } = await newHost();
    track(host);

    await host.start();
    subscribed();
    await advanceTimersByTimeAsync(0);

    await reconnect();
    expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(2);

    // A reconcile that has not finished yet …
    let release!: () => void;
    api.getVaultSyncIndex.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ files: [] });
        }),
    );
    await reconnect();
    expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(3);

    // … is not re-entered by the safety net: a reconcile walks the engine state and
    // pushes as it goes, so two at once would duplicate versions.
    await advanceTimersByTimeAsync(5 * 60_000);
    expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(3);

    release();
    await advanceTimersByTimeAsync(0);
    await advanceTimersByTimeAsync(5 * 60_000);
    expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(4);
  });

  it("stays wired and retries when the bind pass fails", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    api.getVaultSyncIndex = vi.fn(async () => {
      throw new Error("network down");
    });
    const onBindFailed = vi.fn();
    const events = fakeEventSource();
    // The host reports the failure through its logger; collecting it here keeps the suite's
    // own output clean and pins the message, instead of the console fallback printing it.
    const log = vi.fn();
    const host = new SyncHost({
      platform: realPlatform,
      vaultId: "vault-1",
      encryptionKey: await makeKey(),
      adapter: new FakeAdapter(),
      api: api as unknown as SyncApi,
      wsUrl: "ws://localhost:3002",
      userKey: "ck_user",
      getDeviceName: () => "My Device",
      eventSource: events,
      stateStore: { load: () => null, save: () => {} },
      onBindFailed,
      log,
    });
    track(host);

    // Starting does not throw. What it used to leave behind was a host with an
    // engine and nothing else — no event source, no socket, no timer — so nothing
    // ever retried.
    await expect(host.start()).resolves.toBeUndefined();
    expect(onBindFailed).toHaveBeenCalledTimes(1);
    expect(host.engine).not.toBeNull();
    expect(events.handlers).not.toBeNull();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(log).toHaveBeenCalledWith("the bind pass failed", expect.any(Error));

    // The reconcile timer is armed, and firing it retries the pass.
    const reads = api.getVaultSyncIndex.mock.calls.length;
    await advanceTimersByTimeAsync(5 * 60_000);
    expect(api.getVaultSyncIndex.mock.calls.length).toBeGreaterThan(reads);
    expect(log).toHaveBeenCalledWith("bind retry failed", expect.any(Error));
  });

  it("retries a failed bind on its own backoff, and stops once one succeeds", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    api.getVaultSyncIndex = failing;
    const host = new SyncHost({
      platform: realPlatform,
      vaultId: "vault-1",
      encryptionKey: await makeKey(),
      adapter: new FakeAdapter(),
      api: api as unknown as SyncApi,
      wsUrl: "ws://localhost:3002",
      userKey: "ck_user",
      getDeviceName: () => "My Device",
      eventSource: fakeEventSource(),
      stateStore: { load: () => null, save: () => {} },
      log: hostLog,
    });
    track(host);

    await host.start();
    expect(failing).toHaveBeenCalledTimes(1);

    // 30 seconds later, not five minutes: the retry is the bind's own.
    await advanceTimersByTimeAsync(30_000);
    expect(failing).toHaveBeenCalledTimes(2);

    // The second failure backed off to 60 seconds.
    await advanceTimersByTimeAsync(30_000);
    expect(failing).toHaveBeenCalledTimes(2);

    // Let it succeed this time.
    const working = fakeApi();
    api.getVaultSyncIndex = working.getVaultSyncIndex as never;
    await advanceTimersByTimeAsync(30_000);
    expect(working.getVaultSyncIndex).toHaveBeenCalledTimes(1);

    // A completed bind cancels the retry loop: the next pass is the periodic one.
    await advanceTimersByTimeAsync(60_000);
    expect(working.getVaultSyncIndex).toHaveBeenCalledTimes(1);
  });

  it("does not retry a failed bind after the host stops", async () => {
    vi.useFakeTimers();
    const api = fakeApi();
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    api.getVaultSyncIndex = failing;
    const host = new SyncHost({
      platform: realPlatform,
      vaultId: "vault-1",
      encryptionKey: await makeKey(),
      adapter: new FakeAdapter(),
      api: api as unknown as SyncApi,
      wsUrl: "ws://localhost:3002",
      userKey: "ck_user",
      getDeviceName: () => "My Device",
      eventSource: fakeEventSource(),
      stateStore: { load: () => null, save: () => {} },
      log: hostLog,
    });
    track(host);

    await host.start();
    host.stop();
    await advanceTimersByTimeAsync(5 * 60_000);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  /**
   * A pass that waits out a rate limiter holds its background count — and, in a real
   * host, the vault lease — for as long as the wait lasts: three waits of up to five
   * minutes each. `stop()` must end that wait, not sit out the server's window.
   */
  it("stops a pass that is waiting out a rate limit, and answers its refusal", async () => {
    const api = fakeApi();
    const adapter = new FakeAdapter();
    adapter.files.set("notes/a.md", new TextEncoder().encode("hello"));
    const refusal = Object.assign(new Error("rate limited"), {
      status: 429,
      retryAfterMs: 60_000,
    });
    const rateLimited = vi.fn();
    const logs: Array<{ message: string; err?: unknown }> = [];
    const { host, events } = await newHost({
      api: api as unknown as SyncApi,
      adapter,
      // No periodic pass: the vault event below is the only work after the bind.
      reconcileIntervalMs: 0,
      onRateLimited: rateLimited,
      log: (message, err) => logs.push({ message, err }),
    });
    track(host);

    // The bind pushes the file, so the push below is a modify against a real base.
    await host.start();
    expect(api.push).toHaveBeenCalledTimes(1);
    api.push.mockRejectedValue(refusal);

    adapter.files.set("notes/a.md", new TextEncoder().encode("hello again"));
    events.handlers!.changed("notes/a.md", null);

    await waitFor(() => expect(rateLimited).toHaveBeenCalledTimes(1), { timeout: 2_000 });
    expect(rateLimited).toHaveBeenCalledWith({ waitMs: 60_000 });

    // The pass is now inside a 60-second wait. Stopping must not wait it out.
    host.stop();
    const settled = await Promise.race([
      host.whenIdle().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
    ]);
    expect(settled).toBe(true);

    // The pass reported the refusal it was waiting out instead of retrying.
    const failure = logs.find((entry) => entry.message === "push notes/a.md failed");
    expect(failure?.err).toBe(refusal);
    expect(rateLimited).toHaveBeenCalledTimes(1);
  });

  /**
   * "First sync" is a fact about the **vault**, not about the process: it is the pass in
   * which this device and the remote finish meeting for the first time. So it is decided
   * by the state store's completion flag, not by whether the loaded state happens to have
   * entries — a bind killed after pushing half the vault leaves entries behind, and the
   * next start has to keep saying "first sync" until one bind actually finishes.
   */
  describe("firstSync", () => {
    /** Hold the bind open at its index read, so the flags can be read mid-pass. */
    function gatedApi(): {
      api: Record<string, ReturnType<typeof vi.fn>>;
      release: () => void;
    } {
      const api = fakeApi();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      api.getVaultSyncIndex = vi.fn(async () => {
        await gate;
        // The fake server holds nothing yet, which is the shape the pass expects.
        return { files: [] };
      });
      return { api, release };
    }

    it("calls a fresh vault a first sync, and records its completion once", async () => {
      const { api, release } = gatedApi();
      const saveBindCompleted = vi.fn();
      const fresh = await newHost({
        api: api as unknown as SyncApi,
        stateStore: store(null, false, saveBindCompleted),
      });
      track(fresh.host);

      const started = fresh.host.start();
      await untilIndexRead(api);
      expect(fresh.host.binding).toBe(true);
      expect(fresh.host.firstSync).toBe(true);
      release();
      await started;

      // The bind finished: the pass it ran is no longer a first sync, and the flag is
      // what tells the next start that.
      expect(fresh.host.firstSync).toBe(false);
      expect(saveBindCompleted).toHaveBeenCalledTimes(1);

      // A later start over that recorded flag runs an ordinary startup scan: `binding` is
      // still true (every start's first pass is a bind), `firstSync` is not.
      const { api: secondApi, release: releaseSecond } = gatedApi();
      const known = await newHost({
        api: secondApi as unknown as SyncApi,
        stateStore: {
          load: () =>
            JSON.stringify({ "file-1": { plainPath: "note.md", lastKnownVersionId: "v1" } }),
          save: () => {},
          loadBindCompleted: () => true,
          saveBindCompleted,
        },
      });
      track(known.host);
      const secondStarted = known.host.start();
      await untilIndexRead(secondApi);
      expect(known.host.binding).toBe(true);
      expect(known.host.firstSync).toBe(false);
      releaseSecond();
      await secondStarted;
      // A completed bind is not recorded a second time.
      expect(saveBindCompleted).toHaveBeenCalledTimes(1);
    });

    it("still calls a half-persisted bind a first sync on the next start", async () => {
      // A daemon killed after persisting 30 000 of 50 000 files leaves a non-empty state
      // and no completion flag. The next start finishes the bind, so the counter belongs
      // on screen until it does.
      const { api, release } = gatedApi();
      const saveBindCompleted = vi.fn();
      const partial = await newHost({
        api: api as unknown as SyncApi,
        stateStore: store(
          JSON.stringify({ "file-1": { plainPath: "note.md", lastKnownVersionId: "v1" } }),
          false,
          saveBindCompleted,
        ),
      });
      track(partial.host);

      const started = partial.host.start();
      await untilIndexRead(api);
      expect(partial.host.binding).toBe(true);
      expect(partial.host.firstSync).toBe(true);
      release();
      await started;

      expect(partial.host.firstSync).toBe(false);
      expect(saveBindCompleted).toHaveBeenCalledTimes(1);
    });

    it("judges a store with no completion record by the state's emptiness", async () => {
      // The flag is optional. A store that keeps none is read the old way: entries mean
      // an earlier bind got somewhere. This is the fallback the flag replaces, kept so a
      // minimal store (a test fake, a host without persistence) still has an answer.
      const { api, release } = gatedApi();
      const host = await newHost({
        api: api as unknown as SyncApi,
        stateStore: {
          load: () =>
            JSON.stringify({ "file-1": { plainPath: "note.md", lastKnownVersionId: "v1" } }),
          save: () => {},
        },
      });
      track(host.host);

      const started = host.host.start();
      await untilIndexRead(api);
      expect(host.host.firstSync).toBe(false);
      release();
      await started;
    });
  });

  it("polls the settings files only when a group is on, and stops with the host", async () => {
    vi.useFakeTimers();
    const markdownOnly: SyncScope = normalizeScope({
      configDir: ".obsidian",
      settingsGroups: NO_SETTINGS_GROUPS,
      fileTypes: NO_FILE_TYPES,
    });
    const withSettings: SyncScope = {
      ...markdownOnly,
      settingsGroups: { ...NO_SETTINGS_GROUPS, app: true },
    };

    const off = await newHost({ syncScope: markdownOnly });
    track(off.host);
    await off.host.start();
    const offPoll = vi.spyOn(off.host.engine!, "syncLocalSettings");
    await advanceTimersByTimeAsync(60_000);
    expect(offPoll).not.toHaveBeenCalled();

    const on = await newHost({ syncScope: withSettings });
    track(on.host);
    await on.host.start();
    const onPoll = vi.spyOn(on.host.engine!, "syncLocalSettings");
    await advanceTimersByTimeAsync(30_000);
    expect(onPoll).toHaveBeenCalledTimes(1);

    on.host.stop();
    await advanceTimersByTimeAsync(60_000);
    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it("delivers local events to the engine through the queue", async () => {
    const adapter = new FakeAdapter();
    adapter.files.set("notes/a.md", new TextEncoder().encode("hello"));
    const { host, api, events } = await newHost({ adapter });
    track(host);
    await host.start();

    // A vault event is synchronous and cannot be awaited, so the host queues the
    // work: the push lands a few microtasks later.
    events.handlers!.changed("notes/a.md", null);
    await waitFor(() => expect(api.push).toHaveBeenCalledTimes(1));
    const [, pushed] = api.push.mock.calls[0] as unknown as [string, PushFile[]];
    expect(pushed[0]!.action).toBe("create");

    // A removal is the other half of the same wiring: the engine is told the file
    // is gone and pushes the tombstone for the chain it just created.
    adapter.files.delete("notes/a.md");
    events.handlers!.removed("notes/a.md");
    await waitFor(() => expect(api.push).toHaveBeenCalledTimes(2));
    const [, second] = api.push.mock.calls[1] as unknown as [string, PushFile[]];
    expect(second[0]!.action).toBe("delete");
  });

  it("routes a queued event's failure through the host's failure path", async () => {
    const onAuthFailure = vi.fn();
    const { host } = await newHost({ onAuthFailure });
    track(host);
    await host.start();
    // The binding the engine calls when a deferred job fails: one line to `fail`, which
    // logs the paths and stops the host on an auth failure.
    const engine = host.engine as unknown as {
      opts: { onError?: (error: unknown, paths: readonly string[]) => void };
    };
    engine.opts.onError!(apiError(401, "UNAUTHORIZED"), ["notes/a.md"]);
    expect(hostLog).toHaveBeenCalledWith(
      expect.stringContaining("a queued local event for notes/a.md"),
      expect.any(Error),
    );
    expect(onAuthFailure).toHaveBeenCalledWith("revoked");
    expect(host.engine).toBeNull();
  });
  /**
   * A revoked key (or a vault deleted on the server) used to be reported by the CLI
   * while its watcher and interval kept running against a credential that could
   * never work again. The host stops first, then reports.
   */
  it("stops when the settings poll is refused for the contract", async () => {
    // The poll is a pass like any other: a 426 there used to be one log line and a retry
    // every 30 seconds — the host running, holding the lease, and saying nothing.
    vi.useFakeTimers();
    const scope = normalizeScope({
      configDir: ".obsidian",
      settingsGroups: { ...NO_SETTINGS_GROUPS, app: true },
      fileTypes: NO_FILE_TYPES,
    });
    const onServerContract = vi.fn();
    const { host } = await newHost({ syncScope: scope, onServerContract });
    track(host);
    await host.start();
    const poll = vi.spyOn(host.engine!, "syncLocalSettings").mockRejectedValue(
      Object.assign(new Error("426"), {
        status: 426,
        code: "CONTRACT_MISMATCH",
        body: { serverContract: 1, minClient: 1, serverVersion: "0.5.2" },
      }),
    );

    await advanceTimersByTimeAsync(30_000);

    expect(onServerContract).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "server-too-old" }),
    );
    expect(host.engine).toBeNull();
    await advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
  it("stops and reports when a pass is refused for the contract", async () => {
    // The probe only runs at start(), so a host that began while the server was down meets a
    // server of another generation on its first pass. Without this the refusal would be one
    // more transient failure: retried for ever, the lease held, and nothing said.
    const onServerContract = vi.fn();
    const { host, api } = await newHost({ onServerContract });
    track(host);
    api.getVaultSyncIndex.mockRejectedValueOnce(
      Object.assign(new Error("426"), {
        status: 426,
        code: "CONTRACT_MISMATCH",
        body: { serverContract: 1, minClient: 1, serverVersion: "0.5.2" },
      }),
    );

    await host.start();

    expect(onServerContract).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "server-too-old", serverVersion: "0.5.2" }),
    );
    expect(host.engine).toBeNull();
    expect(host.wsState).toBe("disconnected");
  });
  it("stops the loop when the credential is revoked or the vault is gone", async () => {
    const onAuthFailure = vi.fn();
    const { host, events } = await newHost({ onAuthFailure });
    track(host);
    await host.start();

    MockWebSocket.instances.at(-1)!.deliver({ type: "api_key_revoked", vaultId: "vault-1" });

    expect(onAuthFailure).toHaveBeenCalledWith("revoked");
    expect(host.engine).toBeNull();
    expect(host.wsState).toBe("disconnected");
    expect(events.stopped).toBe(true);

    const onVaultDeleted = vi.fn();
    const second = await newHost({ onVaultDeleted });
    track(second.host);
    await second.host.start();

    MockWebSocket.instances.at(-1)!.deliver({ type: "vault_deleted", vaultId: "vault-1" });

    expect(onVaultDeleted).toHaveBeenCalledTimes(1);
    expect(second.host.engine).toBeNull();
    expect(second.events.stopped).toBe(true);
  });

  it("hands a vault-settings change to the host without touching the loop", async () => {
    // The limits are display state (the server trims by its own copy): the host forwards
    // them and keeps running, which is what lets an open settings page follow a change
    // made on another device.
    const onVaultSettings = vi.fn();
    const { host, events } = await newHost({ onVaultSettings });
    track(host);
    await host.start();
    const socket = MockWebSocket.instances.at(-1)!;
    socket.deliver({ type: "subscribe_success", vaultId: "vault-1", sessionId: "session-1" });

    socket.deliver({
      type: "vault_settings",
      vaultId: "vault-1",
      historyLimits: { documents: 40, attachments: 5 },
    });

    expect(onVaultSettings).toHaveBeenCalledWith({ documents: 40, attachments: 5 });
    expect(host.engine).not.toBeNull();
    expect(host.wsState).toBe("connected");
    expect(events.stopped).toBe(false);
  });

  /**
   * The refused subscription is the same rule on the socket's own channel: a
   * refusal that names a dead credential, or a vault that no longer exists, is
   * the host's to act on. The socket reconnects by itself, so a refusal that
   * says neither — a server still starting, a rate limiter — is only logged and
   * left to the next attempt.
   */
  it("acts on a refused subscription, and only logs a transient one", async () => {
    const onAuthFailure = vi.fn();
    const { host, events } = await newHost({ onAuthFailure });
    track(host);
    await host.start();

    MockWebSocket.instances.at(-1)!.deliver({
      type: "subscribe_error",
      vaultId: "vault-1",
      code: "KEY_DISABLED",
      message: "user key is disabled",
    });

    expect(onAuthFailure).toHaveBeenCalledWith("disabled");
    expect(host.engine).toBeNull();
    expect(events.stopped).toBe(true);

    const onVaultDeleted = vi.fn();
    const gone = await newHost({ onVaultDeleted });
    track(gone.host);
    await gone.host.start();

    MockWebSocket.instances.at(-1)!.deliver({
      type: "subscribe_error",
      vaultId: "vault-1",
      code: "NOT_FOUND",
      message: "vault not found",
    });

    expect(onVaultDeleted).toHaveBeenCalledTimes(1);
    expect(gone.host.engine).toBeNull();
    expect(gone.events.stopped).toBe(true);

    const transientFailure = vi.fn();
    const transient = await newHost({ onAuthFailure: transientFailure });
    track(transient.host);
    await transient.host.start();

    MockWebSocket.instances.at(-1)!.deliver({
      type: "subscribe_error",
      vaultId: "vault-1",
      code: "RATE_LIMITED",
      message: "too many requests",
    });

    expect(transientFailure).not.toHaveBeenCalled();
    expect(transient.host.engine).not.toBeNull();
    expect(transient.events.stopped).toBe(false);
  });

  /**
   * The HTTP half of the same rule.
   *
   * The WebSocket path has always stopped the host; a pass that came back `401`/`403`
   * used to be logged and retried, so a client whose key the server had already refused
   * kept looking like it was syncing. These cases pin the mapping and the one-report
   * behaviour, and the `404` that must **not** be read as a dead key.
   */
  describe("a pass the server refuses", () => {
    it("stops the host on a refused bind, and reports the reason once", async () => {
      const api = fakeApi();
      api.getVaultSyncIndex.mockRejectedValue(apiError(403, "KEY_DISABLED"));
      const onAuthFailure = vi.fn();
      const { host } = await newHost({ api: api as unknown as SyncApi, onAuthFailure });
      track(host);

      await host.start();

      expect(onAuthFailure).toHaveBeenCalledTimes(1);
      expect(onAuthFailure).toHaveBeenCalledWith("disabled");
      expect(host.engine).toBeNull();
    });

    it("maps an expired key and a revoked one to their own reasons", async () => {
      const cases = [
        { status: 403, code: "KEY_EXPIRED", reason: "expired" },
        { status: 401, code: "UNAUTHORIZED", reason: "revoked" },
      ] as const;
      for (const { status, code, reason } of cases) {
        const api = fakeApi();
        api.getVaultSyncIndex.mockRejectedValue(apiError(status, code));
        const onAuthFailure = vi.fn();
        const { host } = await newHost({ api: api as unknown as SyncApi, onAuthFailure });

        await host.start();

        expect(onAuthFailure).toHaveBeenCalledWith(reason);
        host.stop();
      }
    });

    it("treats a 404 as a vault that is gone, and keeps the key", async () => {
      // The server answers "this vault is not yours" with 404 too: a valid key must not
      // be dropped over a binding that points at the wrong vault.
      const api = fakeApi();
      api.getVaultSyncIndex.mockRejectedValue(apiError(404, "NOT_FOUND"));
      const onAuthFailure = vi.fn();
      const onVaultDeleted = vi.fn();
      const { host } = await newHost({
        api: api as unknown as SyncApi,
        onAuthFailure,
        onVaultDeleted,
      });

      await host.start();

      expect(onVaultDeleted).toHaveBeenCalledTimes(1);
      expect(onAuthFailure).not.toHaveBeenCalled();
    });

    it("keeps running on a transient failure", async () => {
      const api = fakeApi();
      api.getVaultSyncIndex.mockRejectedValue(apiError(500, "INTERNAL_ERROR"));
      const onAuthFailure = vi.fn();
      const { host } = await newHost({ api: api as unknown as SyncApi, onAuthFailure });

      await host.start();

      expect(onAuthFailure).not.toHaveBeenCalled();
      expect(host.engine).not.toBeNull();
    });

    it("stops a queued push on a 401 without reporting twice", async () => {
      const api = fakeApi();
      const adapter = new FakeAdapter();
      adapter.files.set("notes/a.md", new TextEncoder().encode("hello"));
      const onAuthFailure = vi.fn();
      const { host, events } = await newHost({
        api: api as unknown as SyncApi,
        adapter,
        reconcileIntervalMs: 0,
        onAuthFailure,
      });
      track(host);
      await host.start();

      api.push.mockRejectedValue(apiError(401, "UNAUTHORIZED"));
      adapter.files.set("notes/a.md", new TextEncoder().encode("hello again"));
      events.handlers!.changed("notes/a.md", null);
      events.handlers!.changed("notes/a.md", null);

      await waitFor(() => expect(host.engine).toBeNull());
      expect(onAuthFailure).toHaveBeenCalledTimes(1);
      expect(onAuthFailure).toHaveBeenCalledWith("revoked");
    });
  });

  it("hands the session id to the api, and stops claiming it on stop", async () => {
    const { host, api } = await newHost();
    track(host);

    await host.start();
    expect(api.setSessionId).toHaveBeenLastCalledWith(null);

    subscribed("session-1");
    expect(api.setSessionId).toHaveBeenLastCalledWith("session-1");

    host.stop();
    expect(api.setSessionId).toHaveBeenLastCalledWith(null);
  });

  /**
   * The paths the user is looking at are read at the start of **every** pass, not once
   * at construction: the note a phone restores can change while the host runs, and the
   * next reconcile has to rank the new one first.
   */
  describe("priority paths", () => {
    it("passes the host's list to the bind and to a later reconcile", async () => {
      vi.useFakeTimers();
      const getPriorityPaths = vi.fn(() => ["notes/open.md", "notes/recent.md"]);
      const { host } = await newHost({ getPriorityPaths });
      track(host);
      const spy = vi.spyOn(SyncEngine.prototype, "initialSync");

      try {
        await host.start();
        expect(spy.mock.calls[0]?.[0]).toEqual({
          firstBind: true,
          priorityPaths: ["notes/open.md", "notes/recent.md"],
        });

        subscribed();
        await advanceTimersByTimeAsync(0);
        await reconnect();

        expect(spy.mock.calls.at(-1)?.[0]).toEqual({
          firstBind: false,
          priorityPaths: ["notes/open.md", "notes/recent.md"],
        });
        expect(getPriorityPaths).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    it("runs in its ordinary order when the provider throws", async () => {
      const { host, api } = await newHost({
        getPriorityPaths: () => {
          throw new Error("workspace is not ready");
        },
      });
      track(host);
      const spy = vi.spyOn(SyncEngine.prototype, "initialSync");

      try {
        await expect(host.start()).resolves.toBeUndefined();
        // A preference is never the reason a pass fails: the bind ran, with no ranks.
        expect(spy.mock.calls[0]?.[0]).toEqual({ firstBind: true, priorityPaths: [] });
        expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(1);
        expect(host.engine).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it("asks for no priority input when the host has none", async () => {
      const { host } = await newHost();
      track(host);
      const spy = vi.spyOn(SyncEngine.prototype, "initialSync");

      try {
        await host.start();
        expect(spy.mock.calls[0]?.[0]).toEqual({ firstBind: true, priorityPaths: [] });
      } finally {
        spy.mockRestore();
      }
    });
  });

  /**
   * The event source is wired only after the bind returns. A bind that lasted long
   * enough for a person to type gets one ordinary pass behind it, so the edit is not
   * left waiting for the five-minute safety net; a fast bind pays nothing.
   */
  describe("post-bind catch-up", () => {
    it("reconciles once more when the bind took at least the threshold", async () => {
      const { host, api } = await newHost({ postBindReconcileAfterMs: 0 });
      track(host);

      await host.start();

      await waitFor(() => expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(2));
    });

    it("does not reconcile when the bind was faster than the threshold", async () => {
      const { host, api } = await newHost({ postBindReconcileAfterMs: 60_000 });
      track(host);

      await host.start();
      // Let any background pass the host might have scheduled run to completion.
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(1);
    });

    it("does not catch up after a failed bind", async () => {
      const { host, api } = await newHost({ postBindReconcileAfterMs: 0 });
      track(host);
      api.getVaultSyncIndex.mockRejectedValueOnce(new Error("network down"));

      await expect(host.start()).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      // The failed bind is the only request: a pass that never completed has to be a
      // bind again, and the retry belongs to the periodic/reconnect path.
      expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(1);
    });

    it("drops a catch-up's state write after the host was stopped", async () => {
      const save = vi.fn();
      let release!: () => void;
      let indexCalls = 0;
      const { host, api } = await newHost({
        postBindReconcileAfterMs: 0,
        stateStore: { load: () => null, save },
      });
      track(host);
      // The bind answers at once; the catch-up's index request hangs, which is how a
      // pass is still in flight when the host is stopped.
      api.getVaultSyncIndex.mockImplementation(async () => {
        indexCalls++;
        if (indexCalls === 2) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { files: [] };
      });

      await host.start();
      await waitFor(() => expect(indexCalls).toBe(2));
      const savesBefore = save.mock.calls.length;
      expect(savesBefore).toBeGreaterThan(0);

      host.stop();
      release();
      await host.whenIdle();

      // The pass could not be cancelled, but the state it read before the stop must not
      // land over what a restarted host has already written.
      expect(save.mock.calls.length).toBe(savesBefore);
    });
  });

  /**
   * A bulk local write: an agent, a script or a folder operation drops hundreds of files
   * into the vault, and the watcher reports one event per file within a second.
   *
   * Handled one at a time that is one push request per file — 1 000 generated notes
   * measured 1 000 `POST /sync/push` calls, and the server's 600/minute allowance refuses
   * the vault after about a minute (the client sat out limiter windows and the rest waited
   * for the five-minute pass). More than `LOCAL_EVENT_BURST_SIZE` events inside one window
   * are collected and handed to **one engine job** instead, whose creates travel 100 files
   * per request.
   */
  describe("a burst of local events", () => {
    it("handles the burst as one engine job, with no pass and no per-file push", async () => {
      const adapter = new FakeAdapter();
      const { host, api, events } = await newHost({ adapter, stateStore: store(null, true) });
      track(host);
      await host.start();

      // The per-file path is what a burst must not take for every event: one call is one
      // push request. Only the events below the threshold may reach it.
      const perEvent = vi.spyOn(host.engine!, "handleLocalChange").mockResolvedValue(undefined);
      const batch = vi.spyOn(host.engine!, "handleLocalEvents").mockResolvedValue(undefined);

      const count = LOCAL_EVENT_BURST_SIZE * 3;
      writeBurst(adapter, events, count);
      await host.whenIdle();

      // The events below the threshold went out one by one; the rest travelled as one job.
      expect(perEvent.mock.calls.length).toBe(LOCAL_EVENT_BURST_SIZE);
      expect(batch).toHaveBeenCalledTimes(1);
      const handed = batch.mock.calls[0]![0] as { changed?: string[]; deleted?: string[] };
      expect(handed.changed).toHaveLength(count - LOCAL_EVENT_BURST_SIZE);
      expect(handed.deleted).toEqual([]);
      // No pass: the burst job reads what it needs and never lists the vault's chains.
      expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(1);
      // The burst says how big it was, which is what makes "a single save triggered a
      // batch" answerable from a host's log rather than guessed from CPU use.
      expect(hostLog.mock.calls.at(-1)?.[0]).toBe(
        `local burst: ${count - LOCAL_EVENT_BURST_SIZE} changed, 0 deleted, 0 renamed in one batched push`,
      );
    });

    it("does not count its own pull's events as a burst", async () => {
      vi.useFakeTimers();
      const { host, api, events } = await newHost({ stateStore: store(null, true) });
      track(host);
      await host.start();
      subscribed();
      await advanceTimersByTimeAsync(0);

      const perEvent = vi.spyOn(host.engine!, "handleLocalChange").mockResolvedValue(undefined);
      const batch = vi.spyOn(host.engine!, "handleLocalEvents").mockResolvedValue(undefined);
      // What a pull looks like from the watcher's side: one event per file the engine
      // wrote itself. Counting them would batch behind every large download.
      vi.spyOn(host.engine!, "hasSelfWriteHint").mockReturnValue(true);
      const count = LOCAL_EVENT_BURST_SIZE * 3;
      for (let index = 0; index < count; index += 1) {
        events.handlers!.changed(`pulled/file-${index}.md`, 10);
      }
      await advanceTimersByTimeAsync(LOCAL_EVENT_BURST_FLUSH_MS * 4);
      await host.whenIdle();

      // Every event went to the per-file path, nothing was batched, and only the bind read
      // the index — a pull is not a burst.
      expect(perEvent).toHaveBeenCalledTimes(count);
      expect(batch).not.toHaveBeenCalled();
      expect(api.getVaultSyncIndex).toHaveBeenCalledTimes(1);
    });

    it("hands over the paths written while a batch job is still running", async () => {
      const adapter = new FakeAdapter();
      const { host, events } = await newHost({ adapter, stateStore: store(null, true) });
      track(host);
      await host.start();

      // Hold the first job, so the vault can change underneath it.
      let release!: () => void;
      const batch = vi
        .spyOn(host.engine!, "handleLocalEvents")
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue(undefined);

      writeBurst(adapter, events, LOCAL_EVENT_BURST_SIZE * 2);
      await waitFor(() => expect(batch).toHaveBeenCalledTimes(1));

      // More files land while that job is still deciding from what it read.
      writeBurst(adapter, events, LOCAL_EVENT_BURST_SIZE, "notes/late");
      release();
      await waitFor(() => expect(batch).toHaveBeenCalledTimes(2));
      await host.whenIdle();

      // The second hand-off carries exactly the paths written during the first job.
      const second = batch.mock.calls[1]![0] as { changed?: string[] };
      expect(second.changed).toHaveLength(LOCAL_EVENT_BURST_SIZE);
      expect(second.changed!.every((path) => path.startsWith("notes/late"))).toBe(true);
    });

    it("keeps the three event kinds apart, so a burst's moves are still moves", async () => {
      const { host, events } = await newHost({ stateStore: store(null, true) });
      track(host);
      await host.start();

      const batch = vi.spyOn(host.engine!, "handleLocalEvents").mockResolvedValue(undefined);
      const perRename = vi.spyOn(host.engine!, "handleLocalRename").mockResolvedValue(undefined);
      const perDelete = vi.spyOn(host.engine!, "handleLocalDelete").mockResolvedValue(undefined);

      // A burst that removed a folder: the tombstones travel as one batch of `deleted`
      // paths, never as `changed` (a change is decided by reading the file, and the file
      // is gone). The first delete of the sequence keeps its immediate push; the rest
      // join the batch — a delete that follows a delete is a sequence, whatever the rate.
      for (let index = 0; index < LOCAL_EVENT_BURST_SIZE * 2; index += 1) {
        events.handlers!.removed(`gone/file-${index}.md`);
      }
      await host.whenIdle();
      expect(batch).toHaveBeenCalledTimes(1);
      const first = batch.mock.calls[0]![0] as {
        changed?: string[];
        deleted?: string[];
        renamed?: unknown[];
      };
      expect(first.changed).toEqual([]);
      expect(first.renamed).toEqual([]);
      expect(first.deleted).toHaveLength(LOCAL_EVENT_BURST_SIZE * 2 - 1);
      // Only the first delete of the sequence went out on its own.
      expect(perDelete).toHaveBeenCalledTimes(1);

      // A folder rename: the moves travel as their own list of pairs, so the engine
      // re-points each chain instead of reading a destination as a new file.
      const renames = LOCAL_EVENT_BURST_SIZE * 2;
      for (let index = 0; index < renames; index += 1) {
        events.handlers!.renamed(`old-${index}.md`, `new-${index}.md`, 10);
      }
      await host.whenIdle();
      expect(batch).toHaveBeenCalledTimes(2);
      const second = batch.mock.calls[1]![0] as {
        renamed?: Array<{ from: string; to: string }>;
      };
      // Every move is accounted for once: the ones the window still had room for took the
      // per-path job, the rest travelled in the batch — and none of them as a change.
      const batched = second.renamed ?? [];
      const perPath = perRename.mock.calls.length;
      expect(batched).toHaveLength(renames - perPath);
      const allPairs = new Set([
        ...batched.map((pair) => pair.from),
        ...perRename.mock.calls.map((call) => call[0]),
      ]);
      expect(allPairs.size).toBe(renames);
      for (let index = 0; index < renames; index += 1) {
        expect(allPairs.has(`old-${index}.md`)).toBe(true);
      }
      expect((second as { changed?: string[] }).changed ?? []).toEqual([]);
    });

    /**
     * The shape Obsidian's own trash loop produces: one `delete` per file, a native trash
     * operation each, so a bulk deletion arrives at a few events a second. The dense-burst
     * rule (4 events in 500 ms) never sees it, and each file used to be its own push —
     * 1 000 deleted files were 1 000 requests, which a phone then applied one at a time.
     */
    it("batches a delete sequence that arrives below the burst threshold", async () => {
      vi.useFakeTimers();
      const { host, events } = await newHost({ stateStore: store(null, true) });
      track(host);
      await host.start();
      await advanceTimersByTimeAsync(0);

      const batch = vi.spyOn(host.engine!, "handleLocalEvents").mockResolvedValue(undefined);
      const perDelete = vi.spyOn(host.engine!, "handleLocalDelete").mockResolvedValue(undefined);

      for (let index = 0; index < 5; index += 1) {
        events.handlers!.removed(`trashed/file-${index}.md`);
        // Slower than the dense window, so nothing counts as a burst.
        await advanceTimersByTimeAsync(200);
      }
      // The first delete went out immediately; the rest are held as one open sequence.
      expect(perDelete).toHaveBeenCalledTimes(1);
      expect(batch).not.toHaveBeenCalled();

      // One quiet window after the last delete, the sequence travels as one job.
      await advanceTimersByTimeAsync(LOCAL_DELETE_SEQUENCE_MS);
      await advanceTimersByTimeAsync(0);
      expect(batch).toHaveBeenCalledTimes(1);
      const handed = batch.mock.calls[0]![0] as {
        deleted?: string[];
        changed?: string[];
        deletedAtMs?: Record<string, number>;
      };
      expect(handed.changed).toEqual([]);
      expect(handed.deleted).toHaveLength(4);
      // The tombstone carries when the user deleted the file, not when the batch flushed.
      for (const path of handed.deleted!) expect(handed.deletedAtMs?.[path]).toBeTypeOf("number");
    });

    it("releases a delete sequence that never goes quiet at the cap", async () => {
      vi.useFakeTimers();
      const { host, events } = await newHost({ stateStore: store(null, true) });
      track(host);
      await host.start();
      await advanceTimersByTimeAsync(0);

      const batch = vi.spyOn(host.engine!, "handleLocalEvents").mockResolvedValue(undefined);
      vi.spyOn(host.engine!, "handleLocalDelete").mockResolvedValue(undefined);

      // Faster than the sequence's quiet window, forever: only the cap can release it.
      for (let index = 0; index < 100 && batch.mock.calls.length === 0; index += 1) {
        events.handlers!.removed(`endless/file-${index}.md`);
        await advanceTimersByTimeAsync(100);
      }
      expect(batch).toHaveBeenCalledTimes(1);
      expect((batch.mock.calls[0]![0] as { deleted: string[] }).deleted.length).toBeGreaterThan(7);
    });

    it("hands a full burst over at once instead of waiting for quiet", async () => {
      // A dense burst has its paths in hand: waiting out a quiet period the burst will
      // never have is what made a script's bulk delete arrive 750 ms later than before.
      vi.useFakeTimers();
      const { host, events } = await newHost({ stateStore: store(null, true) });
      track(host);
      await host.start();
      await advanceTimersByTimeAsync(0);

      const batch = vi.spyOn(host.engine!, "handleLocalEvents").mockResolvedValue(undefined);
      vi.spyOn(host.engine!, "handleLocalDelete").mockResolvedValue(undefined);

      for (let index = 0; index < LOCAL_EVENT_BURST_MAX_FILES + 25; index += 1) {
        events.handlers!.removed(`folder/file-${index}.md`);
      }
      await advanceTimersByTimeAsync(0);

      expect(batch).toHaveBeenCalledTimes(1);
      const held = batch.mock.calls[0]![0] as { deleted?: string[] };
      expect(held.deleted).toHaveLength(LOCAL_EVENT_BURST_MAX_FILES + 25 - 1);
    });
  });
});

/**
 * What a health endpoint answers, for the contract-probe cases.
 *
 * Module scope because it captures nothing: the lint rules treat a function that could live
 * outside a block as a warning, and a warning fails `bun run verify`.
 */
function healthy(generation: number, minClient = 1): Record<string, unknown> {
  return {
    status: "ok",
    timestamp: "2026-11-10T00:00:00.000Z",
    generation,
    minClient,
    version: "0.6.0",
  };
}

/**
 * The contract probe: what a host does when the server answers `/api/health` with a window
 * this build is outside.
 *
 * The guarantee is structural — the probe runs before anything is built — so the assertion
 * that matters is an absence: no engine, no index read, no push.
 */
describe("the contract probe", () => {
  const started: SyncHost[] = [];
  afterEach(() => {
    for (const host of started) host.stop();
    started.length = 0;
  });

  /** A host over an API that records its calls, with a health endpoint answering `health`. */
  async function probedHost(
    health: Record<string, unknown>,
    overrides: Partial<SyncHostOptions> = {},
  ): Promise<{ host: SyncHost; api: Record<string, ReturnType<typeof vi.fn>> }> {
    const api = { ...fakeApi(), getServerInfo: vi.fn(async () => health) };
    const { host } = await newHost({ api: api as unknown as SyncApi, ...overrides });
    started.push(host);
    return { host, api };
  }

  it("reports the server and starts when the window matches", async () => {
    const onServerContract = vi.fn();
    const { host, api } = await probedHost(healthy(CONTRACT_GENERATION), { onServerContract });

    await host.start();

    expect(onServerContract).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "ok", serverGeneration: CONTRACT_GENERATION }),
    );
    // The probe passed, so the bind pass ran.
    expect(api.getVaultSyncIndex).toHaveBeenCalled();
  });

  it("stops before building an engine when the server is too old", async () => {
    const onServerContract = vi.fn();
    const { host, api } = await probedHost(healthy(CONTRACT_GENERATION - 1), { onServerContract });

    await host.start();

    expect(onServerContract).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "server-too-old" }),
    );
    // Nothing was built and nothing was written.
    expect(host.engine).toBeNull();
    expect(api.getVaultSyncIndex).not.toHaveBeenCalled();
    expect(api.push).not.toHaveBeenCalled();
    expect(host.wsState).toBe("disconnected");
  });

  it("stops when the server's floor is above this build", async () => {
    const onServerContract = vi.fn();
    const { host, api } = await probedHost(
      healthy(CONTRACT_GENERATION + 1, CONTRACT_GENERATION + 1),
      { onServerContract },
    );

    await host.start();

    expect(onServerContract).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: "client-too-old" }),
    );
    expect(host.engine).toBeNull();
    expect(api.getVaultSyncIndex).not.toHaveBeenCalled();
  });

  it("does not mistake an unreachable server for a mismatch", async () => {
    const onServerContract = vi.fn();
    const api: Record<string, ReturnType<typeof vi.fn>> = {
      ...fakeApi(),
      getServerInfo: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const { host } = await newHost({ api: api as unknown as SyncApi, onServerContract });
    started.push(host);

    await host.start();

    // No verdict is reported; the ordinary pass runs and fails on its own terms.
    expect(onServerContract).not.toHaveBeenCalled();
    expect(api.getVaultSyncIndex).toHaveBeenCalled();
  });

  it("does not resurrect a host that was stopped while the probe was in flight", async () => {
    // The probe is the one await before the engine is built, so a pause that lands inside it
    // must win: otherwise the continuation clears `stopped` and builds an engine for a host
    // the caller has already dropped — an orphan writer holding no lease.
    let release!: (health: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const api: Record<string, ReturnType<typeof vi.fn>> = {
      ...fakeApi(),
      getServerInfo: vi.fn(() => pending),
    };
    const { host } = await newHost({ api: api as unknown as SyncApi });
    started.push(host);

    const starting = host.start();
    host.stop();
    release(healthy(CONTRACT_GENERATION));
    await starting;

    expect(host.engine).toBeNull();
    expect(api.getVaultSyncIndex).not.toHaveBeenCalled();
    expect(api.push).not.toHaveBeenCalled();
    expect(host.wsState).toBe("disconnected");
  });
});
