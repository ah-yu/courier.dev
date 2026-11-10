import type { FindUserByKeyFn, UserRow } from "./users-handlers";
import type { FindVaultByIdFn } from "./vault-handlers";
import { authenticateUserKey } from "../lib/user-credentials";
import { canAccessVault } from "../lib/vault-access";
import { AppError } from "../lib/errors";
import type { ApiErrorCode, HistoryLimits } from "@courier/shared";
import { trimDeviceName } from "@courier/shared";

/**
 * The WebSocket side of the sync service: who is subscribed, and what a change is
 * announced to.
 *
 * It is an **object** (`createWsHub()`), not module state. The registry used to be
 * three module-level maps, which made every test clean up after itself by hand and
 * made the REST push path announce its versions through a global setter wired in
 * `startServer` — a handler whose broadcast silently disappeared if nobody had
 * called the setter. The hub is created once by `createServerApp()`, handed to the
 * routes that need it and to the socket server that fills it.
 *
 * Sessions are keyed by `sessionId`, not by socket: one connection may subscribe to
 * several vaults, and echo suppression has to be per-vault (a REST push for vault A
 * excludes A's session only).
 */

/** Minimal WebSocket interface — only the methods/properties the hub uses. */
export interface WsConnection {
  send(data: string): void;
  close(): void;
  readyState: number;
  /** WebSocket.OPEN === 1 */
  readonly OPEN: number;
}

/** The lookups a `subscribe` needs: who the key belongs to, and which vault it names. */
export interface SubscribeDeps {
  findUserByKey: FindUserByKeyFn;
  findVaultById: FindVaultByIdFn;
}

/**
 * What a `subscribe` decided.
 *
 * The socket is told either way (`subscribe_success` / `subscribe_error`); the
 * result exists so the caller that owns the socket can put the refusal in the
 * service log. A refused subscription is the visible half of "my key expired" and
 * "this vault is not mine", and it used to leave no trace on the server at all.
 */
export interface SubscribeResult {
  ok: boolean;
  /** Why it was refused, in the same wording the client received. */
  reason?: string;
}

interface SessionMeta {
  ws: WsConnection;
  vaultId: string;
  /** The `ck_` user that subscribed, plus the label it stated for itself. */
  userId?: string;
  deviceName?: string | null;
}

export interface WsHub {
  /** Register a user-key session (single user key + self-declared device label). */
  addUserConnection(
    vaultId: string,
    ws: WsConnection,
    sessionId: string,
    meta: { userId: string; deviceName?: string | null },
  ): void;
  removeConnection(vaultId: string, sessionId: string): void;
  /**
   * Cut off all WS sessions of a user, saying **why**.
   *
   * `deleted` sends `api_key_revoked` (the account and its vaults are gone, so the
   * client drops the binding) and `disabled` sends `api_key_disabled` (the key and its
   * data are still there, so the client pauses instead). The two used to be one message,
   * which made a reversible disable indistinguishable from an irreversible delete.
   */
  revokeUserSessions(userId: string, reason: "deleted" | "disabled"): void;
  /** Who is subscribed right now: distinct users, and how many vaults anyone holds. */
  onlineSummary(): { users: number; vaults: number };
  broadcastVaultDeleted(vaultId: string): void;
  /**
   * Announce a vault's new retention limits to every session subscribed to it.
   *
   * A settings page that is already open has to show the numbers the server now holds —
   * they are the vault's, so a change made on one device is every device's change. The
   * event is display data only: the server applies the limits itself when it trims.
   */
  broadcastVaultSettings(vaultId: string, historyLimits: HistoryLimits): void;
  /**
   * Announce the versions **one push request** committed to every session subscribed to
   * the vault except the sender (identified by sessionId), as one frame.
   *
   * One frame per version used to be fine on a LAN and pathological on a phone: a
   * mobile link hands hundreds of small frames to the client spread over seconds, and a
   * client that pulls per notification then pays one round trip (and one local delete)
   * per file. The batch is the unit the server just applied, so it is the unit the wire
   * carries. The origin device label is included so clients can display which client
   * made the change.
   */
  broadcastFilesPushed(
    vaultId: string,
    files: ReadonlyArray<{ fileId: string; versionId: string }>,
    excludeSessionId?: string,
    deviceName?: string | null,
  ): void;
  /**
   * A `subscribe` message: authenticate the credential, resolve the vault, check
   * that this account may use it, and only then register the session.
   */
  subscribe(
    vaultId: string,
    credential: string,
    deviceName: string | undefined,
    deps: SubscribeDeps,
    ws: WsConnection,
    sessionId: string,
  ): Promise<SubscribeResult>;
}

/**
 * The self-declared label a subscriber stated, trimmed and bounded so a
 * notification cannot carry an absurd string.
 *
 * It is display text: nothing is looked up or verified against it (there is no device
 * registry), and the same rule builds the label on the push side (`trimDeviceName`).
 */
function normalizeDeviceName(raw: string | undefined): string | null {
  return trimDeviceName(raw);
}

/** Send one JSON frame, ignoring a socket that is already gone. */
function trySend(ws: WsConnection, message: unknown): void {
  try {
    ws.send(JSON.stringify(message));
  } catch {
    // The connection is dead; the close handler is what removes it.
  }
}

export function createWsHub(): WsHub {
  const vaultConnections = new Map<string, Set<string>>(); // vaultId → Set<sessionId>
  const sessionMeta = new Map<string, SessionMeta>(); // sessionId → meta
  const userSessions = new Map<string, Set<string>>(); // userId → Set<sessionId>

  function addUserConnection(
    vaultId: string,
    ws: WsConnection,
    sessionId: string,
    meta: { userId: string; deviceName?: string | null },
  ): void {
    let set = vaultConnections.get(vaultId);
    if (!set) {
      set = new Set();
      vaultConnections.set(vaultId, set);
    }
    set.add(sessionId);
    sessionMeta.set(sessionId, { ws, vaultId, ...meta });

    let userSet = userSessions.get(meta.userId);
    if (!userSet) {
      userSet = new Set();
      userSessions.set(meta.userId, userSet);
    }
    userSet.add(sessionId);
  }

  function removeConnection(vaultId: string, sessionId: string): void {
    const set = vaultConnections.get(vaultId);
    if (set) {
      set.delete(sessionId);
      if (set.size === 0) vaultConnections.delete(vaultId);
    }
    const meta = sessionMeta.get(sessionId);
    if (meta?.userId) {
      const userSet = userSessions.get(meta.userId);
      userSet?.delete(sessionId);
      if (userSet?.size === 0) userSessions.delete(meta.userId);
    }
    sessionMeta.delete(sessionId);
  }

  function revokeUserSessions(userId: string, reason: "deleted" | "disabled"): void {
    const sessions = userSessions.get(userId);
    if (!sessions) return;
    const type = reason === "deleted" ? "api_key_revoked" : "api_key_disabled";
    for (const sessionId of sessions) {
      const meta = sessionMeta.get(sessionId);
      if (!meta) continue;
      trySend(meta.ws, { type, vaultId: meta.vaultId });
      removeConnection(meta.vaultId, sessionId);
    }
    userSessions.delete(userId);
  }

  function onlineSummary(): { users: number; vaults: number } {
    const users = new Set<string>();
    const vaults = new Set<string>();
    for (const meta of sessionMeta.values()) {
      if (meta.userId) users.add(meta.userId);
      vaults.add(meta.vaultId);
    }
    return { users: users.size, vaults: vaults.size };
  }

  function broadcastVaultDeleted(vaultId: string): void {
    const set = vaultConnections.get(vaultId);
    if (!set) return;
    for (const sessionId of set) {
      const meta = sessionMeta.get(sessionId);
      if (!meta) continue;
      trySend(meta.ws, { type: "vault_deleted", vaultId });
      removeConnection(vaultId, sessionId);
    }
    vaultConnections.delete(vaultId);
  }

  function broadcastVaultSettings(vaultId: string, historyLimits: HistoryLimits): void {
    const set = vaultConnections.get(vaultId);
    if (!set) return;
    const message = JSON.stringify({ type: "vault_settings", vaultId, historyLimits });
    for (const sessionId of set) {
      const meta = sessionMeta.get(sessionId);
      if (!meta) continue;
      try {
        meta.ws.send(message);
      } catch {
        // Connection might be dead — ignore; the close handler removes it.
      }
    }
  }

  function broadcastFilesPushed(
    vaultId: string,
    files: ReadonlyArray<{ fileId: string; versionId: string }>,
    excludeSessionId?: string,
    deviceName?: string | null,
  ): void {
    if (files.length === 0) return;
    const set = vaultConnections.get(vaultId);
    if (!set) return;
    // The sender's session id decides who is **left out**; it is not part of what the
    // peers receive. It used to travel in the message, which handed every subscriber
    // another client's session id for no reason — a session id is what a push uses to
    // suppress its own echo.
    //
    // One frame for the request, not one per file: a phone receives the batch as the
    // server applied it instead of as hundreds of frames whose delivery the client has
    // to re-batch, and one frame costs the peer one chain pull.
    const message = JSON.stringify({
      type: "files_pushed",
      vaultId,
      files: files.map((file) => ({
        fileId: file.fileId,
        versionId: file.versionId,
        deviceName: deviceName ?? null,
      })),
    });
    for (const sessionId of set) {
      if (sessionId === excludeSessionId) continue;
      const meta = sessionMeta.get(sessionId);
      if (!meta) continue;
      try {
        meta.ws.send(message);
      } catch {
        // Connection might be dead — ignore
      }
    }
  }

  async function subscribe(
    vaultId: string,
    credential: string,
    deviceName: string | undefined,
    deps: SubscribeDeps,
    ws: WsConnection,
    sessionId: string,
  ): Promise<SubscribeResult> {
    const fail = (message: string, code?: ApiErrorCode): SubscribeResult => {
      trySend(ws, { type: "subscribe_error", vaultId, message, ...(code ? { code } : {}) });
      return { ok: false, reason: message };
    };

    // The single credential of the shared multi-user model. Host keys (`ak_`) are
    // admin credentials for the HTTP routes and deliberately cannot subscribe.
    if (!credential.startsWith("ck_")) {
      return fail("Invalid credential format: a ck_ user key is required", "UNAUTHORIZED");
    }
    let user: UserRow;
    try {
      user = await authenticateUserKey(credential, deps.findUserByKey);
    } catch (err) {
      // The message is the credential's own ("User key has expired", "User key is
      // disabled", "Invalid or expired user key"), which is what a client logs. The
      // code is what it acts on: those three are terminal, everything else is worth
      // retrying.
      return fail(
        err instanceof Error ? err.message : "Invalid or expired user key",
        err instanceof AppError ? err.code : "UNAUTHORIZED",
      );
    }

    const vault = await deps.findVaultById(vaultId);
    if (!vault) return fail("Vault not found", "NOT_FOUND");
    // A vault this account cannot see is "not found", exactly like one that does not
    // exist: the two answers cannot differ without telling an account that someone
    // else's vault id is real, and a `UNAUTHORIZED` here would read as "your key is
    // dead" — which is a different thing to do about.
    if (!canAccessVault(vault, user.id)) return fail("Vault not found", "NOT_FOUND");

    trySend(ws, { type: "subscribe_success", vaultId, sessionId });
    addUserConnection(vaultId, ws, sessionId, {
      userId: user.id,
      deviceName: normalizeDeviceName(deviceName),
    });
    return { ok: true };
  }

  return {
    addUserConnection,
    removeConnection,
    revokeUserSessions,
    onlineSummary,
    broadcastVaultDeleted,
    broadcastVaultSettings,
    broadcastFilesPushed,
    subscribe,
  };
}

// ── Heartbeat ──

export function startHeartbeat(ws: WsConnection): Timer {
  return setInterval(() => {
    try {
      ws.send(JSON.stringify({ type: "ping" }));
    } catch {
      // Connection closed — heartbeat will be cleaned up on close
    }
  }, 30_000);
}

export function stopHeartbeat(interval: Timer): void {
  clearInterval(interval);
}
