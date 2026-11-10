import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubGlobal, restoreGlobals, realPlatform } from "@courier/testing";
import { SyncWebSocket, type SyncWebSocketOptions, type WsEvent } from "./websocket";

/**
 * The sync socket's own logic, with no network and no real time.
 *
 * `SyncWebSocket` uses the global `WebSocket`, so a fake stands in for it and fake timers
 * drive the backoff. What matters here is everything the L1/L2 suites cannot see: they run
 * a **real** socket against a **real** server, so they only ever exercise the happy path —
 * a refused subscribe, a socket that goes quiet, an exponential retry, a message that is
 * not JSON. Those paths are exactly what a host relies on when the server misbehaves, and
 * until this file existed they had no test at all.
 */

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];
  /** When true the constructor throws — a bad URL, or a runtime without sockets. */
  static throwOnConstruct = false;

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  /** The handlers `SyncWebSocket` registered, keyed by event type. */
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) {
    if (FakeWebSocket.throwOnConstruct) throw new Error("bad url");
    FakeWebSocket.instances.push(this);
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

  private dispatch(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** The real `WebSocket` throws when it is not OPEN; so does this one. */
  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN)
      throw new Error("send on a socket that is not open");
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch("close");
  }

  // ── test-side controls ──

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch("open");
  }

  deliver(message: unknown): void {
    this.dispatch("message", {
      data: typeof message === "string" ? message : JSON.stringify(message),
    });
  }

  /** The last frame this socket sent, parsed. */
  get lastSent(): unknown {
    const raw = this.sent.at(-1);
    return raw === undefined ? null : JSON.parse(raw);
  }
}

/** The socket under test, plus the events it reported and the states it went through. */
function makeSocket(overrides: Partial<SyncWebSocketOptions> = {}) {
  const events: WsEvent[] = [];
  const socket = new SyncWebSocket({
    platform: realPlatform,
    wsUrl: "ws://host/ws",
    vaultId: "v1",
    userKey: "ck_user",
    deviceName: "MacBook",
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  return {
    socket,
    events,
    states: () =>
      events.filter((e) => e.type === "state_change").map((e) => (e as { state: string }).state),
    latest: () => FakeWebSocket.instances.at(-1)!,
  };
}

/** Connect and accept the subscription, i.e. the ordinary "the socket works" state. */
function connected(socket: SyncWebSocket, sessionId = "sess-1") {
  socket.connect();
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.open();
  ws.deliver({ type: "subscribe_success", sessionId });
  return ws;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  FakeWebSocket.throwOnConstruct = false;
  stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
  restoreGlobals();
  vi.restoreAllMocks();
});

describe("SyncWebSocket — subscribing", () => {
  it("states the vault, the user key and its own device label when the socket opens", () => {
    const { socket } = makeSocket();

    socket.connect();
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("ws://host/ws");
    // Nothing goes out before the socket is open: `send` on a CONNECTING socket is a
    // no-op, which is what stops a subscribe from being lost.
    expect(ws.sent).toEqual([]);

    ws.open();

    expect(ws.lastSent).toEqual({
      type: "subscribe",
      vaultId: "v1",
      userKey: "ck_user",
      deviceName: "MacBook",
    });
  });

  it("is connected only once the server accepts, and keeps the session id", () => {
    const { socket } = makeSocket();
    socket.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();
    expect(socket.getState()).toBe("connecting");
    expect(socket.getSessionId()).toBeNull();

    ws.deliver({ type: "subscribe_success", sessionId: "sess-42" });

    expect(socket.getState()).toBe("connected");
    expect(socket.getSessionId()).toBe("sess-42");
  });

  it("reports a refused subscribe and reconnects instead of giving up", () => {
    const { socket, events, states } = makeSocket();
    socket.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    ws.deliver({
      type: "subscribe_error",
      vaultId: "v1",
      message: "User key has expired",
      code: "KEY_EXPIRED",
    });

    // The refusal is reported with the server's code, and the socket reconnects with
    // backoff. Ending the live channel for good is the *host's* decision (it stops on a
    // terminal code); this class cannot know whether the refusal is transient (a server
    // still starting) or fixable (a key the administrator renews).
    expect(events).toContainEqual({
      type: "subscribe_error",
      code: "KEY_EXPIRED",
      message: "User key has expired",
    });
    expect(states()).toEqual(["connecting", "disconnected"]);
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("reports a constructor failure as an error and retries", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    FakeWebSocket.throwOnConstruct = true;
    const { socket, states } = makeSocket();

    socket.connect();

    expect(states()).toEqual(["connecting", "error"]);
    expect(error).toHaveBeenCalled();
    // The retry goes through the same backoff as any other failure.
    vi.advanceTimersByTime(1_000);
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe("SyncWebSocket — messages", () => {
  it("answers a ping with a pong", () => {
    const { socket } = makeSocket();
    const ws = connected(socket);

    ws.deliver({ type: "ping" });

    expect(ws.lastSent).toEqual({ type: "pong" });
  });

  it("reports a peer's push with the label that pushed it", () => {
    const { socket, events } = makeSocket();
    const ws = connected(socket);

    ws.deliver({
      type: "files_pushed",
      vaultId: "v1",
      files: [
        { fileId: "f1", versionId: "ver-1", deviceName: "Surface" },
        { fileId: "f2", versionId: "ver-2", deviceName: "Surface" },
      ],
    });

    // One frame, every version the push committed, and the label once per entry.
    expect(events).toContainEqual({
      type: "files_pushed",
      files: [
        { fileId: "f1", versionId: "ver-1", deviceName: "Surface" },
        { fileId: "f2", versionId: "ver-2", deviceName: "Surface" },
      ],
    });
  });

  it("drops a malformed entry instead of the whole frame", () => {
    const { socket, events } = makeSocket();
    const ws = connected(socket);

    ws.deliver({
      type: "files_pushed",
      vaultId: "v1",
      files: [{ fileId: "f1", versionId: "ver-1" }, { fileId: 42, versionId: "ver-2" } as never],
    });

    expect(events).toContainEqual({
      type: "files_pushed",
      files: [{ fileId: "f1", versionId: "ver-1" }],
    });
  });

  it("reports a vault deleted elsewhere and stops", () => {
    const { socket, events, states } = makeSocket();
    const ws = connected(socket);

    ws.deliver({ type: "vault_deleted", vaultId: "v1" });

    expect(events).toContainEqual({ type: "vault_deleted", vaultId: "v1" });
    expect(states().at(-1)).toBe("disconnected");
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reports the vault's new retention limits without touching the connection", () => {
    // Display state only: the server trims by its own copy, so the socket just hands the
    // numbers to the host (which is what keeps an open settings page current).
    const { socket, events, states } = makeSocket();
    const ws = connected(socket);

    ws.deliver({
      type: "vault_settings",
      vaultId: "v1",
      historyLimits: { documents: 40, attachments: 5 },
    });

    expect(events).toContainEqual({
      type: "vault_settings",
      historyLimits: { documents: 40, attachments: 5 },
    });
    // The connection stays as it was: this is not a terminal event.
    expect(states().at(-1)).toBe("connected");
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reports a revoked user key and stops", () => {
    const { socket, events, states } = makeSocket();
    const ws = connected(socket);

    ws.deliver({ type: "api_key_revoked" });

    expect(events).toContainEqual({ type: "user_key_revoked" });
    expect(states().at(-1)).toBe("disconnected");
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reports a disabled user key as its own event, and stops", () => {
    // Disabled is a pause, not a revocation: the host keeps the binding, so the
    // message must not be indistinguishable from a deleted account.
    const { socket, events, states } = makeSocket();
    const ws = connected(socket);

    ws.deliver({ type: "api_key_disabled" });

    expect(events).toContainEqual({ type: "user_key_disabled" });
    expect(events).not.toContainEqual({ type: "user_key_revoked" });
    expect(states().at(-1)).toBe("disconnected");
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("ignores a message that is not JSON instead of taking the socket down", () => {
    const { socket, events } = makeSocket();
    const ws = connected(socket);

    expect(() => ws.deliver("{ this is not json")).not.toThrow();

    expect(socket.getState()).toBe("connected");
    expect(events.filter((e) => e.type !== "state_change")).toEqual([]);
  });

  it("ignores an unknown message type", () => {
    const { socket, events } = makeSocket();
    const ws = connected(socket);

    ws.deliver({ type: "something_new", payload: 1 });

    expect(socket.getState()).toBe("connected");
    expect(events.filter((e) => e.type !== "state_change")).toEqual([]);
  });
});

describe("SyncWebSocket — reconnecting", () => {
  it("retries an unexpected close with exponential backoff, capped", () => {
    const { socket, states } = makeSocket();
    socket.connect();

    // Never accept: each dropped socket grows the delay for the next attempt.
    const delays: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const before = FakeWebSocket.instances.length;
      FakeWebSocket.instances.at(-1)!.close();

      const expected = Math.min(1_000 * 2 ** attempt, 30_000);
      // Nothing happens one millisecond early…
      vi.advanceTimersByTime(expected - 1);
      expect(FakeWebSocket.instances).toHaveLength(before);
      // …and the retry lands exactly on the delay.
      vi.advanceTimersByTime(1);
      expect(FakeWebSocket.instances).toHaveLength(before + 1);
      delays.push(expected);
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(states()).toContain("disconnected");
  });

  it("resets the backoff once a subscribe succeeds", () => {
    const { socket } = makeSocket();
    socket.connect();
    // Two failures first, so the next delay would be 4s.
    FakeWebSocket.instances.at(-1)!.close();
    vi.advanceTimersByTime(1_000);
    FakeWebSocket.instances.at(-1)!.close();
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // …then a working socket.
    const ws = FakeWebSocket.instances.at(-1)!;
    ws.open();
    ws.deliver({ type: "subscribe_success", sessionId: "s" });

    ws.close();
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("drops a connection that has gone quiet, and reconnects", () => {
    const { socket, states } = makeSocket();
    const ws = connected(socket);
    expect(ws.readyState).toBe(FakeWebSocket.OPEN);

    // The server pings; a silent socket is one the other end has forgotten about.
    vi.advanceTimersByTime(60_000);

    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(states()).toContain("disconnected");
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("keeps the connection alive as long as anything arrives", () => {
    const { socket } = makeSocket();
    const ws = connected(socket);

    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(50_000);
      ws.deliver({ type: "ping" });
    }

    expect(ws.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("does not reconnect after a deliberate disconnect", () => {
    const { socket, states } = makeSocket();
    connected(socket);

    socket.disconnect();

    expect(socket.getState()).toBe("disconnected");
    expect(states().at(-1)).toBe("disconnected");
    vi.advanceTimersByTime(120_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("replaces a socket it is asked to reconnect over", () => {
    const { socket } = makeSocket();
    connected(socket);

    socket.connect();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[0].readyState).toBe(FakeWebSocket.CLOSED);
    expect(socket.getState()).toBe("connecting");
  });
});
