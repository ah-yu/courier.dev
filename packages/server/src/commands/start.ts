import { isIP } from "net";
import crypto from "crypto";
import type { WsServerMessage } from "@courier/shared";
import { HTTP, WsClientMessageSchema } from "@courier/shared/wire";
import { createServerApp } from "../index";
import { notFound, requestPath } from "../http/router";
import { toErrorResponse } from "../http/auth";
import { toRouteTable, type RouteHandlers } from "../http/contract-routes";
import { healthHandlers } from "../routes/health";
import { meHandlers } from "../routes/me";
import { userHandlers } from "../routes/users";
import { adminHandlers } from "../routes/admin";
import { vaultHandlers } from "../routes/vaults";
import { syncHandlers } from "../routes/sync";
import { findVaultById, listVaultIds } from "../db/repositories/vaults";
import { listReferencedContentHashes } from "../db/repositories/file-versions";
import { findByKey } from "../lib/api-keys";
import { findUserByKey } from "../lib/users-db";
import { startHeartbeat, stopHeartbeat, type WsConnection } from "../handlers/ws-handlers";
import { logger } from "../lib/log";
import { AcmeManager, type CertificatePair } from "../lib/tls/acme-manager";
import { config } from "../config";
import { startPruneLoop } from "./prune";
import {
  deleteBlob,
  listBlobHashes,
  statBlob,
  sweepBlobFiles,
  sweepUploads,
} from "../lib/blob-store";
import { sweepOrphanBlobs } from "../lib/orphan-blobs";
import { invalidateUserStorageUsage } from "../lib/storage-usage";

export interface StartOptions {
  port?: string;
}

/** The TLS half of a running server: the certificate manager and the challenge listener. */
export interface TlsRuntime {
  manager: AcmeManager;
  challenge: ChallengeListener;
}

export interface StartedServer {
  /**
   * The listener, or **null** while TLS is configured but no certificate exists yet.
   *
   * That is the one state change of the Bun port: an `https.Server` can bind with no
   * certificate and fail handshakes until `setSecureContext` swaps one in; `Bun.serve`
   * cannot — the key pair is part of the listen call. Waiting for the certificate
   * before binding turns "not ready
   * yet" into a closed port — the one answer every client already understands —
   * instead of a TLS error that looks like a misconfiguration.
   */
  readonly server: Bun.Server<WsData> | null;
  /** The listener once it is up. Already resolved when TLS is off or a certificate exists. */
  readonly ready: Promise<Bun.Server<WsData>>;
  /** Stop listening and drop every open connection, WebSockets included. */
  stop(): Promise<void>;
  /** Terminate every open WebSocket without stopping the listener (tests). */
  dropSockets(): void;
  /**
   * Act as if the ACME manager had just produced a certificate: the same call the
   * manager makes, exposed so a test can exercise the first-certificate bind and a
   * renewal reload without standing up an ACME server.
   */
  installCertificate(certificate: CertificatePair): void;
  /** Present only when `TLS_NAME` is set; absent in the plain-HTTP path. */
  tls?: TlsRuntime;
}

/** Per-connection state: the sessions it owns, and its heartbeat timer. */
export interface WsData {
  sessions: Map<string, string[]>;
  heartbeat: Timer | null;
}

export function startServer(options: StartOptions = {}): StartedServer {
  if (options.port) process.env.PORT = options.port;

  const port = parsePort(process.env["PORT"]);
  // The route table and the socket handlers share one hub: a REST push announces
  // itself to the sessions this listener accepted.
  const { hub } = createServerApp();

  let server: Bun.Server<WsData> | null = null;
  /** Open sockets, so a test can drop them the way a network failure would. */
  const sockets = new Set<Bun.ServerWebSocket<WsData>>();
  // Assigned by the promise executor below; definite because the executor runs
  // synchronously, before any callback can reach it.
  let signalReady!: (value: Bun.Server<WsData>) => void;
  const ready = new Promise<Bun.Server<WsData>>((resolve) => {
    signalReady = resolve;
  });

  const tlsName = config.TLS_NAME.trim();
  const applyCertificate = (certificate: CertificatePair): void => {
    if (server) {
      // A renewal: reload applies to new handshakes and keeps established sockets.
      // Bun's `reload` types ask for the whole options object even though the
      // runtime keeps the omitted fields (the fetch handler, the port, `websocket`).
      server.reload({ tls: { cert: certificate.cert, key: certificate.key } } as never);
      logger.info(`TLS: certificate reloaded for ${tlsName}`);
      return;
    }
    // The first certificate: this is what starts the listener under TLS.
    server = startListener(certificate);
    signalReady(server);
    logUrls();
  };
  const tls = tlsName === "" ? null : createTlsRuntime(tlsName, applyCertificate);

  /** Bind the listener. Called immediately without TLS, or once a certificate exists. */
  function startListener(certificate: CertificatePair | null): Bun.Server<WsData> {
    // The registry is the route table: every contract has exactly one handler, and a
    // missing or orphan handler is a startup error rather than a silent 404.
    const handlers: RouteHandlers = {
      ...healthHandlers,
      ...meHandlers(),
      ...userHandlers(hub),
      ...adminHandlers(hub),
      ...vaultHandlers(hub),
      ...syncHandlers(hub, logger),
    };
    const instance = Bun.serve<WsData, never>({
      port,
      // Every route is a table entry; `fetch` below only answers what no entry matched.
      routes: toRouteTable(HTTP, handlers, logger, { findUserByKey, findVaultById, findByKey }),
      // Bun's default is 10 s; the plugin may sit idle between saves longer than
      // that, and a keep-alive socket reaped mid-request reads as a sync failure.
      idleTimeout: 120,
      ...(certificate ? { tls: { cert: certificate.cert, key: certificate.key } } : {}),
      fetch(request, bunServer) {
        // The last line of defence: every route wraps its handler in
        // `withErrorMapping`, but a route table entry (or the upgrade path below)
        // that throws outside it would otherwise answer Bun's own 500 body. One
        // mapping keeps the error shape `docs/api.md` documents for both routers.
        try {
          if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
            const upgraded = bunServer.upgrade(request, {
              data: { sessions: new Map<string, string[]>(), heartbeat: null },
            });
            return upgraded
              ? (undefined as unknown as Response)
              : new Response("websocket upgrade failed", { status: 400 });
          }
          // No route table entry matched: answer the 404 Hono used to, and log it as
          // somebody else's path (the public port is scanned all day).
          return notFound(request, logger, config.LOG_SLOW_MS);
        } catch (err) {
          return toErrorResponse(err, logger);
        }
      },
      websocket: {
        open(ws) {
          sockets.add(ws);
          logger.debug("ws: connection opened");
          // Heartbeat is connection-level, not subscription-level — start immediately.
          ws.data.heartbeat = startHeartbeat(asWsConnection(ws));
        },
        async message(ws, raw) {
          await handleSocketMessage(ws, typeof raw === "string" ? raw : raw.toString());
        },
        close(ws, code, reason) {
          sockets.delete(ws);
          const vaults = ws.data.sessions.size;
          cleanupSocket(ws);
          const detail =
            `ws: connection closed code=${code} vaults=${vaults}` +
            (reason && reason.length > 0 ? ` reason=${reason}` : "");
          if (code === 1000 || code === 1001) logger.debug(detail);
          else logger.warn(detail);
        },
      },
    });
    logger.debug(`listener bound on port ${instance.port}`);
    return instance;
  }

  /** Drop the sessions a connection owned and stop its heartbeat. */
  function cleanupSocket(ws: Bun.ServerWebSocket<WsData>): void {
    if (ws.data.heartbeat) {
      stopHeartbeat(ws.data.heartbeat);
      ws.data.heartbeat = null;
    }
    for (const [vaultId, sessionIds] of ws.data.sessions) {
      for (const sessionId of sessionIds) hub.removeConnection(vaultId, sessionId);
    }
    ws.data.sessions.clear();
  }

  /** One frame from a client: subscribe, unsubscribe, or a heartbeat reply. */
  async function handleSocketMessage(ws: Bun.ServerWebSocket<WsData>, raw: string): Promise<void> {
    let rawMessage: unknown;
    try {
      rawMessage = JSON.parse(raw);
    } catch {
      return;
    }
    // The frame is validated against the shared schema, not just switched on: an
    // unknown type or a missing field is ignored exactly like a malformed body.
    const parsed = WsClientMessageSchema.safeParse(rawMessage);
    if (!parsed.success) return;
    const msg = parsed.data;

    if (msg.type === "subscribe") {
      if (msg.vaultId === "" || msg.userKey === "") return;
      const sessionId = crypto.randomUUID();
      // The hub registers the session **only after** the credential and the
      // vault's ownership have been checked; a refused subscribe leaves nothing
      // behind. The connection remembers it either way, because removing a
      // session that was never added is a no-op.
      const result = await hub.subscribe(
        msg.vaultId,
        msg.userKey,
        msg.deviceName,
        { findUserByKey, findVaultById },
        asWsConnection(ws),
        sessionId,
      );
      // A refusal is the client-visible half of an expired key or a vault that
      // is not this account's; without this line the service log says nothing
      // while a device keeps failing to stay connected.
      if (result.ok) {
        logger.info(`ws subscribe vault=${msg.vaultId} device=${msg.deviceName ?? "unknown"}`);
      } else {
        logger.warn(`ws subscribe refused vault=${msg.vaultId}: ${result.reason ?? "unknown"}`);
      }
      const owned = ws.data.sessions.get(msg.vaultId);
      if (owned) owned.push(sessionId);
      else ws.data.sessions.set(msg.vaultId, [sessionId]);
    } else if (msg.type === "unsubscribe") {
      if (msg.vaultId === "") return;
      for (const sessionId of ws.data.sessions.get(msg.vaultId) ?? []) {
        hub.removeConnection(msg.vaultId, sessionId);
      }
      ws.data.sessions.delete(msg.vaultId);
      const frame: WsServerMessage = { type: "unsubscribed", vaultId: msg.vaultId };
      try {
        ws.send(JSON.stringify(frame));
      } catch {
        // The socket may already be gone; the close handler is what cleans up.
      }
    } else if (msg.type === "pong") {
      // Client acknowledged heartbeat
    }
  }

  // Background retention-pruning job (disabled when PRUNE_INTERVAL_MS is 0).
  const pruneStop = startPruneLoop(config.PRUNE_INTERVAL_MS);
  process.on("exit", pruneStop);
  // Staged chunk uploads are reclaimed on their own timer: a client that never
  // finishes one must not leave its chunks on disk for good, and turning retention
  // pruning off must not also stop this sweep.
  const uploadSweepStop = startUploadSweep(config.UPLOAD_SWEEP_INTERVAL_MS, config.UPLOAD_TTL_MS);
  process.on("exit", uploadSweepStop);
  // A refused push can leave its blob on disk with no row (the write happens before the
  // conditional insert). This sweep is independent of per-user retention pruning.
  const orphanSweepStop = startOrphanSweep(config.ORPHAN_SWEEP_INTERVAL_MS, config.ORPHAN_TTL_MS);
  process.on("exit", orphanSweepStop);

  // Report the port the OS actually bound, not the one that was asked for:
  // `PORT=0` (and a test's `port: "0"`) means "pick a free one", and a log line
  // naming port 0 is useless to whoever reads the journal.
  function logUrls(): void {
    const boundPort = server?.port ?? port;
    if (tls) {
      const base = tlsBaseUrl(tlsName, boundPort);
      logger.info(`TLS: serving ${tlsName} with the certificate in ${config.TLS_DIR}`);
      logger.info(`Server running at ${base}`);
      logger.info(`WebSocket server running at ${base.replace(/^https/, "wss")}`);
    } else {
      logger.info(`Server running at http://localhost:${boundPort}`);
      logger.info(`WebSocket server running at ws://localhost:${boundPort}`);
    }
  }

  if (tls) {
    const certificate = tls.manager.currentCertificate();
    if (certificate) {
      server = startListener(certificate);
      signalReady(server);
      logUrls();
    } else {
      // No certificate on disk: do **not** bind the service port yet. The ACME
      // challenge listener (port 80) is all that has to be reachable for issuance,
      // and a closed service port is the honest "not ready" answer for every client.
      logger.info(
        `TLS: no certificate for ${tlsName} in ${config.TLS_DIR} yet — requesting one; ` +
          `the service port will start listening once it arrives`,
      );
      logger.info(`WebSocket server waiting for the certificate too`);
    }
    // Issuance and the renewal checks are background work; `onCertificate` above is
    // what binds (first certificate) or reloads (renewal).
    tls.manager.start();
  } else {
    server = startListener(null);
    signalReady(server);
    logUrls();
  }

  return {
    get server() {
      return server;
    },
    ready,
    dropSockets() {
      for (const socket of sockets) socket.close(1012, "restart");
      sockets.clear();
    },
    installCertificate: applyCertificate,
    async stop() {
      const current = server;
      server = null;
      tls?.manager.stop();
      if (tls) await tls.challenge.close();
      if (current) await current.stop(true);
      // Stop the sweeps and unregister their process hooks: the listener is what those
      // hooks existed for, and a process that starts several servers (the tests) must not
      // accumulate a set of listeners — and their closures — per server.
      process.off("exit", pruneStop);
      process.off("exit", uploadSweepStop);
      process.off("exit", orphanSweepStop);
      pruneStop();
      uploadSweepStop();
      orphanSweepStop();
    },
    ...(tls ? { tls } : {}),
  };
}

/**
 * The hub's socket surface, over Bun's `ServerWebSocket`.
 *
 * The hub predates the listener and only needs `send`, `close`, `readyState` and
 * the `OPEN` constant; adapting here keeps every routing/echo rule in one place.
 */
function asWsConnection(ws: Bun.ServerWebSocket<WsData>): WsConnection {
  return {
    send: (data: string) => ws.send(data),
    close: () => ws.close(),
    get readyState() {
      return ws.readyState;
    },
    OPEN: 1,
  };
}

/**
 * Resolve the listen port. `0` is a real request ("let the OS pick a free
 * port") and must not be folded into the fallback the way `Number(x) || 80`
 * would; every other unusable value falls back to 80.
 */
function parsePort(raw: string | undefined): number {
  const text = (raw ?? "").trim();
  if (text === "") return 80;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return 80;
  return port;
}

/** The public URL clients use: the certificate's identifier, never `localhost`. */
function tlsBaseUrl(name: string, port: number): string {
  // RFC 3986 wants an IPv6 literal in brackets.
  const host = isIP(name) === 6 ? `[${name}]` : name;
  return port === 443 ? `https://${host}` : `https://${host}:${port}`;
}

/** The plain-HTTP listener ACME's http-01 challenge is answered from. */
export interface ChallengeListener {
  /** Bind the challenge port, or throw with actionable text. */
  ensureListening(): Promise<void>;
  /** Release the port (tests and shutdown). */
  close(): Promise<void>;
}

function createTlsRuntime(
  name: string,
  onCertificate: (certificate: CertificatePair) => void,
): TlsRuntime {
  // The manager and the listener need each other: the listener answers with the
  // manager's in-flight tokens, and the manager binds the listener just before
  // it starts an order.
  let challenge: ChallengeListener | null = null;
  const manager = new AcmeManager({
    name,
    email: config.TLS_EMAIL,
    dir: config.TLS_DIR,
    directoryUrl: config.ACME_DIRECTORY_URL,
    onCertificate,
    ensureChallengeListener: async () => {
      await challenge?.ensureListening();
    },
  });
  challenge = createChallengeListener(config.ACME_CHALLENGE_PORT, (token) =>
    manager.challengeResponse(token),
  );
  return { manager, challenge };
}

/**
 * ACME validates an http-01 challenge by fetching
 * `http://<identifier>/.well-known/acme-challenge/<token>` on port 80, so this
 * listener is deliberately tiny: one route, no TLS, and it answers only tokens
 * an order currently has in flight.
 *
 * A bind failure is not fatal. The service keeps serving its certificate, the
 * message names the causes, and the next issuance attempt binds again.
 */
export function createChallengeListener(
  port: number,
  response: (token: string) => string | null,
): ChallengeListener {
  let server: Bun.Server<never> | null = null;
  let pending: Promise<void> | null = null;

  const listen = async (): Promise<void> => {
    server = Bun.serve({
      port,
      fetch(request) {
        const match = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]+)$/.exec(
          requestPath(request),
        );
        const body = request.method === "GET" && match ? response(match[1]) : null;
        if (body === null) return new Response(null, { status: 404 });
        // Exactly the key authorization: ACME compares the bytes it downloads.
        return new Response(body, { headers: { "Content-Type": "text/plain" } });
      },
    });
  };

  const ensureListening = async (): Promise<void> => {
    if (server) return;
    if (!pending) {
      pending = listen().catch((error: unknown) => {
        // Nothing can be issued while this port is unusable, so be loud and let
        // the next attempt try again rather than leaving a dead promise around.
        pending = null;
        logger.info(
          `acme: cannot listen on port ${port} for the http-01 challenge: ${errorMessage(error)}`,
        );
        logger.info(
          `acme: port ${port} must be free on this machine and reachable from the internet; ` +
            `binding a privileged port also needs cap_net_bind_service ` +
            `(e.g. sudo setcap cap_net_bind_service=+ep <courier-server binary>)`,
        );
        throw error;
      });
    }
    return await pending;
  };

  const close = async (): Promise<void> => {
    pending = null;
    const current = server;
    server = null;
    if (!current) return;
    await current.stop(true);
  };

  return { ensureListening, close };
}

/** One line for an unknown thrown value. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reclaim staged chunk uploads — and batch files no row names — on their own timer.
 *
 * The first sweep runs immediately: a process that restarts after a crash would
 * otherwise serve with whatever a previous run left behind until the next interval.
 * `intervalMs = 0` disables the loop, the same way it disables pruning. The file sweep
 * lives here rather than in the orphan sweep so that turning the **retention** sweeps off
 * (`ORPHAN_SWEEP_INTERVAL_MS=0`) does not also stop crash garbage from being collected.
 */
function startUploadSweep(intervalMs: number, ttlMs: number): () => void {
  if (intervalMs <= 0) return () => {};
  const sweep = (): void => {
    void Promise.all([
      sweepUploads(ttlMs),
      // A `.tmp` from a killed process, or a file whose rows never committed: unreachable,
      // so it is collected once it is older than the orphan TTL.
      sweepBlobFiles(config.ORPHAN_TTL_MS).catch((error: unknown) => {
        logger.warn(`blob file sweep failed: ${errorMessage(error)}`);
        return 0;
      }),
    ])
      .then(([removed, files]) => {
        // The swept bytes were part of the cached per-user usage; a fresh measurement
        // is cheaper than tracking each vault's staged total down.
        if (removed > 0 || files > 0) invalidateUserStorageUsage();
      })
      .catch((error: unknown) => {
        logger.warn(`upload sweep failed: ${errorMessage(error)}`);
      });
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Reclaim blobs no version row references, once they are older than the TTL.
 *
 * A push stores its blob before the conditional insert; a `stale_base` refusal (or any
 * other refusal after the write) leaves the bytes with no row. Retention pruning only
 * collected those for users who had a window, so an account with pruning off kept them
 * forever. The age gate keeps a push that is still between its write and its insert out
 * of the sweep, and the sweep runs for every vault. `intervalMs = 0` disables the loop.
 */
function startOrphanSweep(intervalMs: number, ttlMs: number): () => void {
  if (intervalMs <= 0) return () => {};
  const sweep = (): void => {
    void sweepOrphanBlobs(
      {
        listVaultIds,
        listBlobHashes,
        listReferencedHashes: listReferencedContentHashes,
        statBlob,
        deleteBlob,
      },
      { minAgeMs: ttlMs },
    )
      .then((removed) => {
        // Deleting a row frees its file as soon as it was the last one pointing into it
        // (the store unlinks it in that step), so there is nothing else to do here; the
        // crash garbage is collected by the upload sweep, which does not depend on this
        // loop being enabled.
        if (removed === 0) return;
        // The deleted bytes were part of the cached per-user usage.
        invalidateUserStorageUsage();
        logger.info(`orphan sweep removed ${removed} unreferenced blob(s)`);
      })
      .catch((error: unknown) => {
        logger.warn(`orphan sweep failed: ${errorMessage(error)}`);
      });
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
