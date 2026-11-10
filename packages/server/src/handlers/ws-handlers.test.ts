import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WsConnection, WsHub } from "./ws-handlers";
import { createWsHub, startHeartbeat, stopHeartbeat } from "./ws-handlers";
import type { FindUserByKeyFn, UserRow } from "./users-handlers";
import type { FindVaultByIdFn, VaultRow } from "./vault-handlers";

/**
 * The hub is an object now, so each case gets its own registry instead of sharing
 * module-level maps and cleaning them up by hand. The calls below are bound to the
 * current test's hub in `beforeEach`.
 */
let hub: WsHub;
let addUserConnection: WsHub["addUserConnection"];
let removeConnection: WsHub["removeConnection"];
let broadcastVaultDeleted: WsHub["broadcastVaultDeleted"];
let broadcastFilesPushed: WsHub["broadcastFilesPushed"];
let handleSubscribe: WsHub["subscribe"];

beforeEach(() => {
  hub = createWsHub();
  addUserConnection = hub.addUserConnection;
  removeConnection = hub.removeConnection;
  broadcastVaultDeleted = hub.broadcastVaultDeleted;
  broadcastFilesPushed = hub.broadcastFilesPushed;
  handleSubscribe = hub.subscribe;
});

function mockWs(): { ws: WsConnection; readonly closed: boolean } {
  let closed = false;
  const ws: WsConnection = {
    send: vi.fn(),
    close: vi.fn(() => {
      closed = true;
    }),
    get readyState() {
      return closed ? 3 : 1; // CLOSED : OPEN
    },
    OPEN: 1,
  };
  return {
    ws,
    get closed() {
      return closed;
    },
  };
}

/** A user row as `findUserByKey` resolves it. */
function mockUser(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: "u-1",
    name: "Alice",
    key: "ck_secret",
    storageBytesLimit: null,
    retentionDays: null,
    maxFileBytes: 50 * 1024 * 1024,
    maxVaults: 1,
    expiresAt: null,
    disabled: false,
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

/** A vault row as `findVaultById` resolves it: owned by `u-1` unless overridden. */
function mockVault(overrides: Partial<VaultRow> = {}): VaultRow {
  return {
    id: "v1",
    name: "Vault",
    ownerUserId: "u-1",
    encryptionSalt: "salt",
    keyCheck: "canary",
    historyLimitDocuments: 200,
    historyLimitAttachments: 10,
    createdAt: new Date("2026-06-10T00:00:00.000Z"),
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
    ...overrides,
  };
}

/** The two lookups a `subscribe` asks for, resolving the vault `v1` owned by `u-1`. */
function deps(findUserByKey: FindUserByKeyFn): {
  findUserByKey: FindUserByKeyFn;
  findVaultById: FindVaultByIdFn;
} {
  return depsFor(findUserByKey, mockVault());
}

/** The same, for a specific vault row (or none at all). */
function depsFor(
  findUserByKey: FindUserByKeyFn,
  vault: VaultRow | undefined,
): { findUserByKey: FindUserByKeyFn; findVaultById: FindVaultByIdFn } {
  return { findUserByKey, findVaultById: vi.fn<FindVaultByIdFn>().mockResolvedValue(vault) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addUserConnection / removeConnection", () => {
  it("registers a session and forgets it again", () => {
    const { ws } = mockWs();
    addUserConnection("v1", ws, "sid1", { userId: "u-1", deviceName: "MacBook" });

    // After cleanup, broadcasting is a no-op again.
    removeConnection("v1", "sid1");
    broadcastVaultDeleted("v1");

    expect(ws.send).not.toHaveBeenCalled();
  });

  it("removing from non-existent vault does not throw", () => {
    removeConnection("nonexistent", "sid1");
  });
});

describe("revokeUserSessions", () => {
  it("tells a deleted account's sessions the key was revoked", () => {
    const { ws } = mockWs();
    addUserConnection("v1", ws, "sid-a", { userId: "u-1", deviceName: "A" });

    hub.revokeUserSessions("u-1", "deleted");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "api_key_revoked", vaultId: "v1" }),
    );
  });

  it("tells a disabled account's sessions the key was disabled, not revoked", () => {
    // Disabled is reversible and keeps everything; a client that saw `api_key_revoked`
    // would drop a binding it can resume.
    const { ws } = mockWs();
    addUserConnection("v1", ws, "sid-a", { userId: "u-1", deviceName: "A" });

    hub.revokeUserSessions("u-1", "disabled");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "api_key_disabled", vaultId: "v1" }),
    );
    expect(ws.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: "api_key_revoked", vaultId: "v1" }),
    );
  });

  it("cuts every vault of that account off and leaves other accounts alone", () => {
    const { ws: own1 } = mockWs();
    const { ws: own2 } = mockWs();
    const { ws: other } = mockWs();
    addUserConnection("v1", own1, "sid-own1", { userId: "u-1" });
    addUserConnection("v2", own2, "sid-own2", { userId: "u-1" });
    addUserConnection("v1", other, "sid-other", { userId: "u-2" });

    hub.revokeUserSessions("u-1", "deleted");

    expect(own1.send).toHaveBeenCalledTimes(1);
    expect(own2.send).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalled();
    // Nothing of that account is registered any more.
    expect(hub.onlineSummary()).toEqual({ users: 1, vaults: 1 });
  });
});

describe("broadcastVaultDeleted", () => {
  it("sends vault_deleted to all connections without closing the ws", () => {
    const { ws: ws1 } = mockWs();
    const { ws: ws2 } = mockWs();

    addUserConnection("v1", ws1, "sid1", { userId: "u-1", deviceName: "A" });
    addUserConnection("v1", ws2, "sid2", { userId: "u-2", deviceName: "B" });

    broadcastVaultDeleted("v1");

    expect(ws1.send).toHaveBeenCalledWith(JSON.stringify({ type: "vault_deleted", vaultId: "v1" }));
    expect(ws2.send).toHaveBeenCalledWith(JSON.stringify({ type: "vault_deleted", vaultId: "v1" }));
    // Multiplexed-safe: the server must NOT close the ws, since it may hold
    // other active vault subscriptions. The client decides whether to close.
    expect(ws1.close).not.toHaveBeenCalled();
    expect(ws2.close).not.toHaveBeenCalled();
  });

  it("is a no-op when no connections exist for the vault", () => {
    broadcastVaultDeleted("nonexistent");
  });
});

describe("broadcastVaultSettings", () => {
  it("sends the vault's new limits to every session subscribed to it", () => {
    const { ws: ws1 } = mockWs();
    const { ws: ws2 } = mockWs();
    const { ws: other } = mockWs();

    addUserConnection("v1", ws1, "sid1", { userId: "u-1", deviceName: "A" });
    addUserConnection("v1", ws2, "sid2", { userId: "u-1", deviceName: "B" });
    addUserConnection("v2", other, "sid3", { userId: "u-1", deviceName: "A" });

    hub.broadcastVaultSettings("v1", { documents: 40, attachments: 5 });

    // Both devices of the vault hear it — the limits are the vault's, not the sender's —
    // and a device subscribed to another vault does not.
    const expected = JSON.stringify({
      type: "vault_settings",
      vaultId: "v1",
      historyLimits: { documents: 40, attachments: 5 },
    });
    expect(ws1.send).toHaveBeenCalledWith(expected);
    expect(ws2.send).toHaveBeenCalledWith(expected);
    expect(other.send).not.toHaveBeenCalled();
  });

  it("is a no-op when no connections exist for the vault", () => {
    expect(() =>
      hub.broadcastVaultSettings("nonexistent", { documents: 1, attachments: 1 }),
    ).not.toThrow();
  });
});

describe("broadcastFilesPushed", () => {
  it("sends one files_pushed frame to all subscribed sessions except the sender", () => {
    const { ws: ws1 } = mockWs();
    const { ws: ws2 } = mockWs();

    addUserConnection("v1", ws1, "sid1", { userId: "u-1", deviceName: "A" });
    addUserConnection("v1", ws2, "sid2", { userId: "u-2", deviceName: "B" });

    broadcastFilesPushed("v1", [{ fileId: "file-1", versionId: "ver-1" }], "sid1");

    // Sender (sid1) is excluded, and its session id is **not** part of what the peer
    // receives: the exclusion is the server's decision, not a field to pass on.
    expect(ws1.send).not.toHaveBeenCalled();
    expect(ws2.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "files_pushed",
        vaultId: "v1",
        files: [{ fileId: "file-1", versionId: "ver-1", deviceName: null }],
      }),
    );
  });

  it("carries a whole push request in one frame", () => {
    // The rule this exists for: a thousand deleted files must not reach a phone as a
    // thousand frames. One request is one frame, however many versions it committed.
    const { ws } = mockWs();
    addUserConnection("v1", ws, "sid-peer", { userId: "u-1", deviceName: "phone" });

    const files = Array.from({ length: 100 }, (_, index) => ({
      fileId: `f-${index}`,
      versionId: `v-${index}`,
    }));
    broadcastFilesPushed("v1", files, "sid-sender", "MacBook");

    expect(ws.send).toHaveBeenCalledTimes(1);
    const frame = JSON.parse((ws.send as any).mock.calls[0][0] as string);
    expect(frame.type).toBe("files_pushed");
    expect(frame.files).toHaveLength(100);
    expect(frame.files[99]).toEqual({ fileId: "f-99", versionId: "v-99", deviceName: "MacBook" });

    removeConnection("v1", "sid-peer");
  });

  it("sends nothing for an empty batch", () => {
    const { ws } = mockWs();
    addUserConnection("v1", ws, "sid-peer", { userId: "u-1", deviceName: "phone" });

    broadcastFilesPushed("v1", [], "sid-sender");

    expect(ws.send).not.toHaveBeenCalled();
    removeConnection("v1", "sid-peer");
  });

  it("echo-suppresses per-sessionId, not per-ws (multiplexing safe)", () => {
    // One ws subscribed to two vaults with two different sessionIds.
    const { ws } = mockWs();
    addUserConnection("vA", ws, "sidA", { userId: "u-1", deviceName: "A" });
    addUserConnection("vB", ws, "sidB", { userId: "u-1", deviceName: "A" });

    // REST push for vault A excludes only sidA — the same ws still receives
    // vault B pushes (it has a different session there).
    broadcastFilesPushed("vB", [{ fileId: "file-B", versionId: "ver-B" }], "sidA");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "files_pushed",
        vaultId: "vB",
        files: [{ fileId: "file-B", versionId: "ver-B", deviceName: null }],
      }),
    );

    // Push for vault A with sidA excluded — same ws gets nothing back.
    (ws.send as any).mockClear();
    broadcastFilesPushed("vA", [{ fileId: "file-A", versionId: "ver-A" }], "sidA");
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("includes the origin device name when provided", () => {
    const { ws } = mockWs();
    addUserConnection("v1", ws, "sid1", { userId: "u-1", deviceName: "MacBook" });
    addUserConnection("v1", ws, "sid2", { userId: "u-1", deviceName: "Surface" });

    broadcastFilesPushed("v1", [{ fileId: "f1", versionId: "v9" }], "sid2", "MacBook");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "files_pushed",
        vaultId: "v1",
        files: [{ fileId: "f1", versionId: "v9", deviceName: "MacBook" }],
      }),
    );

    removeConnection("v1", "sid1");
    removeConnection("v1", "sid2");
  });
});

describe("handleSubscribe", () => {
  it("accepts a user key and remembers the self-declared device label", async () => {
    const findUser = vi.fn<FindUserByKeyFn>().mockResolvedValue(mockUser());
    const { ws } = mockWs();

    await handleSubscribe("v1", "ck_secret", "书房笔记本", deps(findUser), ws, "sid-user");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "subscribe_success", vaultId: "v1", sessionId: "sid-user" }),
    );

    // The label a subscriber stated is what peers see on a push notification.
    const { ws: peer } = mockWs();
    addUserConnection("v1", peer, "sid-peer", { userId: "u-2", deviceName: "other" });
    (peer.send as any).mockClear();
    broadcastFilesPushed("v1", [{ fileId: "f1", versionId: "v9" }], "sid-other", "书房笔记本");
    expect(peer.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "files_pushed",
        vaultId: "v1",
        files: [{ fileId: "f1", versionId: "v9", deviceName: "书房笔记本" }],
      }),
    );

    removeConnection("v1", "sid-user");
    removeConnection("v1", "sid-peer");
  });

  it("rejects an expired user key", async () => {
    const findUser = vi
      .fn<FindUserByKeyFn>()
      .mockResolvedValue(mockUser({ expiresAt: "2020-01-01T00:00:00.000Z" }));
    const { ws } = mockWs();

    await handleSubscribe("v1", "ck_secret", "MacBook", deps(findUser), ws, "sid-x");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "subscribe_error",
        vaultId: "v1",
        message: "User key has expired",
        code: "KEY_EXPIRED",
      }),
    );
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("rejects a disabled user key with its own code", async () => {
    // Disabled is not expired: the key still exists and its data is intact, so a client
    // has to pause rather than drop the binding.
    const findUser = vi.fn<FindUserByKeyFn>().mockResolvedValue(mockUser({ disabled: true }));
    const { ws } = mockWs();

    await handleSubscribe("v1", "ck_secret", "MacBook", deps(findUser), ws, "sid-x");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "subscribe_error",
        vaultId: "v1",
        message: "User key is disabled",
        code: "KEY_DISABLED",
      }),
    );
  });

  it("rejects a subscription to a vault that does not exist", async () => {
    const findUser = vi.fn<FindUserByKeyFn>().mockResolvedValue(mockUser());
    const { ws } = mockWs();

    await handleSubscribe(
      "missing",
      "ck_secret",
      "MacBook",
      depsFor(findUser, undefined),
      ws,
      "sid-x",
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "subscribe_error",
        vaultId: "missing",
        message: "Vault not found",
        code: "NOT_FOUND",
      }),
    );
  });

  it("answers another account's vault as not found", async () => {
    // The same rule the sync routes enforce: a valid key for a vault this account does
    // not own must not start delivering its peers' changes. The answer is `NOT_FOUND`,
    // not `UNAUTHORIZED`, so the refusal cannot be read as "your key is dead" — and it
    // does not confirm that someone else's vault id exists.
    const findUser = vi.fn<FindUserByKeyFn>().mockResolvedValue(mockUser({ id: "u-2" }));
    const { ws } = mockWs();

    await handleSubscribe(
      "v1",
      "ck_secret",
      "MacBook",
      depsFor(findUser, mockVault({ ownerUserId: "u-1" })),
      ws,
      "sid-x",
    );

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "subscribe_error",
        vaultId: "v1",
        message: "Vault not found",
        code: "NOT_FOUND",
      }),
    );

    // Nothing was registered, so a push for that vault reaches nobody.
    const { ws: peer } = mockWs();
    addUserConnection("v1", peer, "sid-peer", { userId: "u-1", deviceName: "A" });
    (peer.send as any).mockClear();
    broadcastFilesPushed("v1", [{ fileId: "f1", versionId: "v9" }], "sid-other");
    expect(peer.send).toHaveBeenCalledTimes(1);
    expect(ws.send).toHaveBeenCalledTimes(1);
    removeConnection("v1", "sid-peer");
  });

  it("accepts a subscriber that states no label at all", async () => {
    const findUser = vi.fn<FindUserByKeyFn>().mockResolvedValue(mockUser());
    const { ws } = mockWs();

    await handleSubscribe("v1", "ck_secret", undefined, deps(findUser), ws, "sid-anon");

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "subscribe_success", vaultId: "v1", sessionId: "sid-anon" }),
    );
    removeConnection("v1", "sid-anon");
  });

  it("rejects a host key: admin credentials cannot subscribe", async () => {
    const findUser = vi.fn<FindUserByKeyFn>();
    const { ws } = mockWs();

    await handleSubscribe("v1", "ak_host", "MacBook", deps(findUser), ws, "sid-x");

    expect(findUser).not.toHaveBeenCalled();
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: "subscribe_error",
        vaultId: "v1",
        message: "Invalid credential format: a ck_ user key is required",
        code: "UNAUTHORIZED",
      }),
    );
  });
});

describe("heartbeat", () => {
  it("calls send with ping on each interval tick", () => {
    vi.useFakeTimers();
    const { ws } = mockWs();

    const interval = startHeartbeat(ws);

    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "ping" }));

    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledTimes(2);

    stopHeartbeat(interval);
    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });
});
