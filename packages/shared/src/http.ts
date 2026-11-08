import type { ApiError } from "./errors";
import type { UserSummary } from "./auth";
import { parseContentBatchBody } from "./wire";
import type {
  ClearDeletedResponse,
  FileVersionHistoryResponse,
  ListDeletedFilesResponse,
  SyncPullResponse,
  SyncPushResponse,
  VaultSyncHistoryResponse,
  VaultSyncIndexResponse,
} from "./sync";
import type {
  CreateVaultResponse,
  ListVaultsResponse,
  UpdateVaultRequest,
  VaultEncryptionSaltResponse,
  VaultKeyCheckResponse,
  VaultSettingsResponse,
} from "./vault";

/**
 * The one HTTP client every host uses.
 *
 * It exists because three hand-written clients had grown apart: the plugin wired
 * 15 `requestUrl` calls in `main.ts` (with two endpoints written twice), the CLI
 * carried its own client and `SyncApi` pair, and each carried a byte-identical
 * `ApiClientError`/`handleApiError` pair. The two could — and did — disagree: the
 * plugin read the device label on every push while the CLI captured it when the
 * daemon started, so `courier-cli device rename` only took effect after a
 * restart.
 *
 * The **transport is injected**, so this module stays dependency-free and works
 * on every host: the plugin passes an Obsidian `requestUrl` adapter, the CLI a
 * `fetch` adapter, tests a plain function. What the client owns is everything
 * the hosts were repeating: the base URL and `/api` prefix, the `Bearer` header,
 * the WebSocket session id header, `encodeURIComponent` on path segments, error
 * mapping, and the two binary routes (a push body and version content).
 */

/** Default base URL of the sync server when nothing else is configured. */
export const DEFAULT_SERVER_URL = "http://localhost:3002";

/** A request as the client hands it to a transport. */
export interface TransportRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** JSON text, or the push frame's bytes. Absent for a body-less request. */
  body?: string | ArrayBuffer | Uint8Array;
}

/**
 * A response, in the shape Obsidian's `requestUrl` already answers with: the body
 * is read once into bytes, while `text` and `json` are **materialized on first
 * access** (accessors, on both hosts) — so a caller that wants the ciphertext of a
 * download never pays to decode it.
 *
 * Read only the shape you need. Spreading, destructuring, `Object.assign` or
 * serializing a response invokes every accessor and forces the decode and parse; for
 * a large download that is a pass over the whole payload and a string twice its
 * size.
 */
export interface TransportResponse {
  status: number;
  /**
   * Response headers, lower-cased by both real hosts.
   *
   * Only `Retry-After` is read today: a refused sync request answers when the rate
   * limiter's window ends, and a client that binds a large vault waits that long
   * instead of failing the pass (see `docs/first-bind-performance.md`). Optional so a
   * test transport that answers a status and a body still works — the client then
   * falls back to its own wait.
   */
  headers?: Record<string, string>;
  text: string;
  /** Parsed JSON, or `null` when the body is not JSON (binary, empty, an error page). */
  json: unknown;
  arrayBuffer: ArrayBuffer;
}

/** How a host performs a request. The only thing that differs between hosts. */
export type HttpTransport = (request: TransportRequest) => Promise<TransportResponse>;

/**
 * A failed request, in the one shape every host maps to a user-facing sentence.
 *
 * `status` is `0` for a request that never reached the server (a transport
 * failure), which is deliberately distinct from any status the server can send:
 * "the server said no" and "nothing answered" are different answers.
 */
export class ApiClientError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details?: Array<{ field: string; message: string }>;
  /**
   * How long the server asked the client to wait, when it said so (`Retry-After`).
   *
   * Only a 429 carries it. A caller that retries reads this instead of guessing the
   * limiter's window; absent means "the server did not say", not "retry at once".
   */
  public readonly retryAfterMs?: number;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Array<{ field: string; message: string }>,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

/** `Retry-After` in milliseconds: delta-seconds only (an HTTP-date is not worth it). */
function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.ceil(seconds * 1000);
}

/** The server's error body, mapped onto {@link ApiClientError}. */
export function handleApiError(
  status: number,
  json: unknown,
  headers?: Record<string, string>,
): never {
  const wait = retryAfterMs(headers);
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw new ApiClientError(
      status,
      "UNKNOWN_ERROR",
      `Request failed with status ${status}`,
      undefined,
      { retryAfterMs: wait },
    );
  }

  const body = json as ApiError;

  throw new ApiClientError(
    status,
    body.error ?? "UNKNOWN_ERROR",
    body.message ?? `Request failed with status ${status}`,
    body.details,
    { retryAfterMs: wait },
  );
}

/** Derive the WebSocket base URL from the server URL (http→ws, https→wss). */
export function httpToWsUrl(serverUrl: string): string {
  return serverUrl.replace(/^http/, "ws");
}

/** A path segment, escaped the one way every route expects it. */
function segment(value: string): string {
  return encodeURIComponent(value);
}

export interface CourierClientOptions {
  /**
   * Server base URL, or a getter for it. The plugin reads its settings per
   * request: a user who changes the server address in the settings page must not
   * have to reload the plugin for the next call to use it.
   */
  baseUrl: string | (() => string);
  /** The `ck_` user key, or null while this host has none (a signed-out plugin). */
  getUserKey: () => string | null;
  transport: HttpTransport;
}

export interface CourierClient {
  /**
   * Identify this client's WebSocket session so the server skips echoing this
   * device's own pushes back to it. A one-shot host (no socket) never sets one.
   */
  setSessionId(sessionId: string | null): void;

  createVault(name: string, encryptionSalt: string, keyCheck: string): Promise<CreateVaultResponse>;
  listVaults(): Promise<ListVaultsResponse>;
  /**
   * Rename a vault and/or change its retention limits (`PATCH /api/vaults/:id`).
   *
   * The limits are **vault-level** state, so this is the write path every device of the
   * vault shares; the answer is the vault as it now stands, limits included.
   */
  updateVault(vaultId: string, patch: UpdateVaultRequest): Promise<VaultSettingsResponse>;
  /** The account the configured key belongs to — the cheapest "is this key good" read. */
  getMe(): Promise<UserSummary>;
  getEncryptionSalt(vaultId: string): Promise<VaultEncryptionSaltResponse>;
  getKeyCheck(vaultId: string): Promise<VaultKeyCheckResponse>;
  deleteVault(vaultId: string): Promise<void>;
  listDeleted(vaultId: string): Promise<ListDeletedFilesResponse>;
  /** Irreversible: every tombstoned chain of the vault, plus the blobs only they referenced. */
  clearDeleted(vaultId: string): Promise<ClearDeletedResponse>;
  getFileVersionHistory(vaultId: string, fileId: string): Promise<FileVersionHistoryResponse>;
  /** The whole vault's chains, for the sync-history UI. */
  getVaultSyncHistory(vaultId: string): Promise<VaultSyncHistoryResponse>;
  /** One row per chain (tombstones included) — the engine's cold-start index. */
  getVaultSyncIndex(vaultId: string): Promise<VaultSyncIndexResponse>;
  /** The stored ciphertext of one version: `iv ‖ ciphertext ‖ tag`, exactly as held. */
  getVersionContent(vaultId: string, contentHash: string): Promise<Uint8Array>;
  /**
   * The ciphertext of several versions in one request (`POST …/sync/contents`).
   *
   * `null` for a hash the store does not hold — the same answer a `404` gives for one
   * version, and just as ordinary (a reclaimed blob, or a chain no peer can fetch). The
   * batch is bounded by the server (`MAX_CONTENT_BATCH_FILES` / `…_BYTES`); the caller
   * keeps its batches under that, so a refusal here is a bug, not a normal answer.
   */
  getVersionContents(
    vaultId: string,
    contentHashes: readonly string[],
  ): Promise<Array<Uint8Array | null>>;
  /**
   * One byte range of a version's chunk region (`end` inclusive).
   *
   * A whole-file version's region is its single `iv‖ct‖tag`; a chunked version's is the
   * concatenated chunks. The caller knows the chunk size and the plaintext size from the
   * version row, so one request per chunk is all a range needs.
   */
  getVersionContentRange(
    vaultId: string,
    contentHash: string,
    start: number,
    end: number,
  ): Promise<Uint8Array>;
  /** Stage one chunk of a chunked upload; answers the contiguous prefix on disk. */
  uploadChunk(
    vaultId: string,
    contentHash: string,
    index: number,
    chunkCount: number,
    plaintextSize: number,
    body: Uint8Array,
  ): Promise<ChunkUploadAck>;
  /** The resume point of a staged upload, or `null` when none was ever started. */
  getChunkStatus(vaultId: string, contentHash: string): Promise<ChunkUploadStatus | null>;
  /** One push frame, already built (see `buildPushBody`), for the whole batch. */
  push(vaultId: string, body: Uint8Array): Promise<SyncPushResponse>;
  pull(vaultId: string, fileIds: string[]): Promise<SyncPullResponse>;
}

/** The answer to one chunk request: the contiguous prefix now staged. */
export interface ChunkUploadAck {
  received: number;
}

/** How much of a staged upload the server holds. */
export interface ChunkUploadStatus {
  received: number;
  complete: boolean;
}

/** Build the client a host uses for the whole session. */
export function createCourierClient(options: CourierClientOptions): CourierClient {
  const baseUrl = (): string =>
    typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl;
  let sessionId: string | null = null;

  function headers(contentType?: string): Record<string, string> {
    const key = options.getUserKey();
    return {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(sessionId ? { "X-Courier-Session-Id": sessionId } : {}),
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
  }

  /** One request, with transport failures and non-2xx answers mapped to `ApiClientError`. */
  async function send(
    path: string,
    init: {
      method?: string;
      body?: string | Uint8Array;
      contentType?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<TransportResponse> {
    const request: TransportRequest = {
      url: `${baseUrl()}/api${path}`,
      method: init.method ?? "GET",
      headers: { ...headers(init.contentType), ...init.headers },
    };
    if (init.body !== undefined) request.body = init.body;

    let response: TransportResponse;
    try {
      response = await options.transport(request);
    } catch (err) {
      throw new ApiClientError(
        0,
        "NETWORK_ERROR",
        `Cannot reach server: ${String(err)}`,
        undefined,
        {
          cause: err,
        },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      handleApiError(response.status, response.json, response.headers);
    }
    return response;
  }

  async function json<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await send(path, {
      ...(init.method === undefined ? {} : { method: init.method }),
      ...(init.body === undefined
        ? {}
        : { body: JSON.stringify(init.body), contentType: "application/json" }),
    });
    return response.json as T;
  }

  return {
    setSessionId(id) {
      sessionId = id;
    },

    async createVault(name, encryptionSalt, keyCheck) {
      return await json<CreateVaultResponse>("/vaults", {
        method: "POST",
        body: { name, encryptionSalt, keyCheck },
      });
    },

    async listVaults() {
      return await json<ListVaultsResponse>("/vaults");
    },

    async updateVault(vaultId, patch) {
      return await json<VaultSettingsResponse>(`/vaults/${segment(vaultId)}`, {
        method: "PATCH",
        body: patch,
      });
    },

    async getMe() {
      return await json<UserSummary>("/me");
    },

    async getEncryptionSalt(vaultId) {
      return await json<VaultEncryptionSaltResponse>(`/vaults/${segment(vaultId)}/encryption-salt`);
    },

    async getKeyCheck(vaultId) {
      return await json<VaultKeyCheckResponse>(`/vaults/${segment(vaultId)}/key-check`);
    },

    async deleteVault(vaultId) {
      // 204, no body: nothing to parse.
      await send(`/vaults/${segment(vaultId)}`, { method: "DELETE" });
    },

    async listDeleted(vaultId) {
      return await json<ListDeletedFilesResponse>(`/vaults/${segment(vaultId)}/sync/deleted`);
    },

    async clearDeleted(vaultId) {
      return await json<ClearDeletedResponse>(`/vaults/${segment(vaultId)}/sync/deleted/clear`, {
        method: "POST",
      });
    },

    async getFileVersionHistory(vaultId, fileId) {
      return await json<FileVersionHistoryResponse>(
        `/vaults/${segment(vaultId)}/sync/versions?fileId=${segment(fileId)}`,
      );
    },

    async getVaultSyncHistory(vaultId) {
      return await json<VaultSyncHistoryResponse>(`/vaults/${segment(vaultId)}/sync/history`);
    },

    async getVaultSyncIndex(vaultId) {
      return await json<VaultSyncIndexResponse>(`/vaults/${segment(vaultId)}/sync/index`);
    },

    async getVersionContent(vaultId, contentHash) {
      const response = await send(
        `/vaults/${segment(vaultId)}/sync/versions/${segment(contentHash)}/content`,
      );
      return new Uint8Array(response.arrayBuffer);
    },

    async getVersionContents(vaultId, contentHashes) {
      const response = await send(`/vaults/${segment(vaultId)}/sync/contents`, {
        method: "POST",
        contentType: "application/json",
        body: JSON.stringify({ hashes: [...contentHashes] }),
      });
      return parseContentBatchBody(new Uint8Array(response.arrayBuffer), contentHashes.length);
    },

    async getVersionContentRange(vaultId, contentHash, start, end) {
      const response = await send(
        `/vaults/${segment(vaultId)}/sync/versions/${segment(contentHash)}/content`,
        { headers: { Range: `bytes=${start}-${end}` } },
      );
      return new Uint8Array(response.arrayBuffer);
    },

    async uploadChunk(vaultId, contentHash, index, chunkCount, plaintextSize, body) {
      const response = await send(
        `/vaults/${segment(vaultId)}/sync/blobs/${segment(contentHash)}/chunks/${index}` +
          `?chunkCount=${chunkCount}&plaintextSize=${plaintextSize}`,
        { method: "PUT", contentType: "application/octet-stream", body },
      );
      return response.json as ChunkUploadAck;
    },

    async getChunkStatus(vaultId, contentHash) {
      try {
        const response = await send(
          `/vaults/${segment(vaultId)}/sync/blobs/${segment(contentHash)}/status`,
        );
        return response.json as ChunkUploadStatus;
      } catch (err) {
        // "No chunk was ever staged" is an answer, not a failure: the caller starts at 0.
        if (err instanceof ApiClientError && err.status === 404) return null;
        throw err;
      }
    },

    async push(vaultId, body) {
      const response = await send(`/vaults/${segment(vaultId)}/sync/push`, {
        method: "POST",
        contentType: "application/octet-stream",
        body,
      });
      return response.json as SyncPushResponse;
    },

    async pull(vaultId, fileIds) {
      return await json<SyncPullResponse>(`/vaults/${segment(vaultId)}/sync/pull`, {
        method: "POST",
        body: { files: fileIds.map((fileId) => ({ fileId })) },
      });
    },
  };
}
