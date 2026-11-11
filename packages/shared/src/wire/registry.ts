/**
 * The wire registry: the one list of what a peer can observe.
 *
 * This module is the source the server builds its route table from, the source the
 * contract surface is serialized from, and the source the classifier diffs between
 * generations. It is deliberately data, not a scan of declarations: a route, a frame, a
 * status code or a request constraint that is not here is not on the wire.
 */
import type { ApiKeyScope } from "../auth";
import { API_KEY_SCOPES } from "../auth";
import { CONTRACT_HEADER } from "../contract";
import type { ApiErrorCode } from "../errors";
import { API_ERROR_CODES } from "../errors";
import {
  BLOB_FLAG_CHUNK_AAD,
  BLOB_HEADER_BYTES,
  BLOB_MAGIC,
  CHUNK_PLAINTEXT_BYTES,
  CHUNK_STORED_BYTES,
  CHUNKED_TRANSFER_THRESHOLD,
  MAX_CHUNKS,
} from "../blob";
import {
  CONTENT_HASH_PATTERN,
  HISTORY_KINDS,
  MAX_DEVICE_NAME_LENGTH,
  MAX_ENCRYPTED_PATH_LENGTH,
  MAX_HISTORY_LIMIT,
  MAX_ID_LENGTH,
  MAX_PULL_BATCH_FILES,
  MAX_PUSH_BATCH_FILES,
  SYNC_ACTIONS,
} from "../sync";
import { KEY_CHECK_VALUE } from "../vault";
import {
  CONTENT_BATCH_HEADER_BYTES,
  CONTENT_BATCH_MAGIC,
  MAX_CONTENT_BATCH_BYTES,
  MAX_CONTENT_BATCH_FILES,
  MAX_PUSH_HEADER_BYTES,
  PUSH_HEADER_LENGTH_BYTES,
} from "../wire";
import { BLOB_SPEC, CONTENT_BATCH_SPEC, PUSH_BODY_SPEC } from "./binary";
import {
  AdminRuntimeResponseSchema,
  AdminStatusResponseSchema,
  ApiErrorSchema,
  ChunkUploadAckSchema,
  ChunkUploadQuerySchema,
  ChunkUploadStatusSchema,
  ClearDeletedResponseSchema,
  CreateUserRequestSchema,
  CreateUserResponseSchema,
  CreateVaultRequestSchema,
  CreateVaultResponseSchema,
  FileVersionHistoryResponseSchema,
  FileVersionQuerySchema,
  HealthResponseSchema,
  ListDeletedFilesResponseSchema,
  ListUsersResponseSchema,
  ListVaultsResponseSchema,
  PushBodySchema,
  RevealUserKeyResponseSchema,
  SyncContentsRequestSchema,
  SyncPullRequestSchema,
  SyncPullResponseSchema,
  SyncPushResponseSchema,
  UpdateUserRequestSchema,
  UpdateVaultRequestSchema,
  UserSummarySchema,
  VaultEncryptionSaltResponseSchema,
  VaultKeyCheckResponseSchema,
  VaultSettingsResponseSchema,
  VaultSyncHistoryResponseSchema,
  VaultSyncIndexResponseSchema,
} from "./http";
import type { WireSchema } from "./schema";
import { text, z } from "./schema";
import { WsClientMessageSchema, WsServerMessageSchema } from "./ws";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
export type HttpAuth = "none" | "user" | "host" | "sync";
export type RateLimit = "sync" | "transfer";

/** What a request carries, in the form the adapter knows how to read. */
export type HttpBody =
  | { kind: "none" }
  | { kind: "json"; schema: WireSchema }
  /** The binary push frame; `schema` validates the parsed header entries. */
  | { kind: "push"; schema: WireSchema }
  /** Raw bytes (a staged chunk); `limit` names the server's body cap. */
  | { kind: "bytes"; limit: "chunk" };

/** What a successful answer carries. */
export type HttpResponse =
  | { kind: "none" }
  | { kind: "json"; schema: WireSchema }
  | { kind: "binary"; contentType: string }
  | { kind: "stream"; contentType: string; headers: readonly string[] };

/** One method of one path: everything a peer can observe about it. */
export interface HttpContract {
  /** Stable handler key; never part of the wire. */
  id: string;
  method: HttpMethod;
  path: string;
  auth: HttpAuth;
  /** The host-key scope a `host` route needs. */
  scope?: ApiKeyScope;
  /** Whether the request carries the contract-generation check (the `ck_` routes). */
  contract: "required" | "exempt";
  rateLimit?: RateLimit;
  body: HttpBody;
  query?: WireSchema;
  params?: WireSchema;
  /**
   * What a malformed path parameter answers.
   *
   * `"validation"` (the default) is the ordinary 422. The content route answers
   * `"not-found"` instead: a hash that is not 64 hex characters names nothing, and
   * answering 404 keeps a malformed path indistinguishable from a missing blob.
   */
  paramFailure?: "validation" | "not-found";
  response: HttpResponse;
  status: readonly number[];
  /** The error codes this route is allowed to answer with. */
  errors?: readonly ApiErrorCode[];
  headers?: { request?: readonly string[]; response?: readonly string[] };
}

const vaultParams = z.object({ id: z.string() });
const contentParams = z.object({
  id: z.string(),
  contentHash: text({ pattern: CONTENT_HASH_PATTERN }),
});
const chunkParams = z.object({
  id: z.string(),
  contentHash: text({ pattern: CONTENT_HASH_PATTERN }),
  index: text({ pattern: /^\d+$/ }),
});

const USER_ERRORS: readonly ApiErrorCode[] = [
  "UNAUTHORIZED",
  "KEY_EXPIRED",
  "KEY_DISABLED",
  "CONTRACT_MISMATCH",
  "RATE_LIMITED",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "INTERNAL_ERROR",
];

const SYNC_ERRORS: readonly ApiErrorCode[] = [
  ...USER_ERRORS,
  "QUOTA_EXCEEDED",
  "VAULT_LIMIT_REACHED",
  "PAYLOAD_TOO_LARGE",
  "RANGE_NOT_SATISFIABLE",
];

const HOST_ERRORS: readonly ApiErrorCode[] = [
  "UNAUTHORIZED",
  "KEY_EXPIRED",
  "INSUFFICIENT_SCOPE",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "INTERNAL_ERROR",
];

/**
 * The HTTP surface.
 *
 * `contract: "required"` marks the routes whose wrapper runs `requireContract`; the
 * public crypto reads, `/api/health` and the host-key routes are exempt, exactly as
 * their wrappers are.
 */
export const HTTP = [
  {
    id: "health.get",
    method: "GET",
    path: "/api/health",
    auth: "none",
    contract: "exempt",
    body: { kind: "none" },
    response: { kind: "json", schema: HealthResponseSchema },
    status: [200],
  },
  {
    id: "me.get",
    method: "GET",
    path: "/api/me",
    auth: "user",
    contract: "required",
    body: { kind: "none" },
    response: { kind: "json", schema: UserSummarySchema },
    status: [200],
    errors: USER_ERRORS,
  },
  {
    id: "users.list",
    method: "GET",
    path: "/api/users",
    auth: "host",
    scope: "users",
    contract: "exempt",
    body: { kind: "none" },
    response: { kind: "json", schema: ListUsersResponseSchema },
    status: [200],
    errors: HOST_ERRORS,
  },
  {
    id: "users.create",
    method: "POST",
    path: "/api/users",
    auth: "host",
    scope: "users",
    contract: "exempt",
    body: { kind: "json", schema: CreateUserRequestSchema },
    response: { kind: "json", schema: CreateUserResponseSchema },
    status: [201],
    errors: HOST_ERRORS,
  },
  {
    id: "users.revealKey",
    method: "GET",
    path: "/api/users/:id/key",
    auth: "host",
    scope: "users",
    contract: "exempt",
    params: vaultParams,
    body: { kind: "none" },
    response: { kind: "json", schema: RevealUserKeyResponseSchema },
    status: [200],
    errors: HOST_ERRORS,
  },
  {
    id: "users.update",
    method: "PATCH",
    path: "/api/users/:id",
    auth: "host",
    scope: "users",
    contract: "exempt",
    params: vaultParams,
    body: { kind: "json", schema: UpdateUserRequestSchema },
    response: { kind: "json", schema: UserSummarySchema },
    status: [200],
    errors: HOST_ERRORS,
  },
  {
    id: "users.delete",
    method: "DELETE",
    path: "/api/users/:id",
    auth: "host",
    scope: "users",
    contract: "exempt",
    params: vaultParams,
    body: { kind: "none" },
    response: { kind: "none" },
    status: [204],
    errors: HOST_ERRORS,
  },
  {
    id: "vaults.list",
    method: "GET",
    path: "/api/vaults",
    auth: "user",
    contract: "required",
    body: { kind: "none" },
    response: { kind: "json", schema: ListVaultsResponseSchema },
    status: [200],
    errors: USER_ERRORS,
  },
  {
    id: "vaults.create",
    method: "POST",
    path: "/api/vaults",
    auth: "user",
    contract: "required",
    body: { kind: "json", schema: CreateVaultRequestSchema },
    response: { kind: "json", schema: CreateVaultResponseSchema },
    status: [201],
    errors: USER_ERRORS,
  },
  {
    id: "vaults.update",
    method: "PATCH",
    path: "/api/vaults/:id",
    auth: "user",
    contract: "required",
    params: vaultParams,
    body: { kind: "json", schema: UpdateVaultRequestSchema },
    response: { kind: "json", schema: VaultSettingsResponseSchema },
    status: [200],
    errors: USER_ERRORS,
  },
  {
    id: "vaults.delete",
    method: "DELETE",
    path: "/api/vaults/:id",
    auth: "user",
    contract: "required",
    params: vaultParams,
    body: { kind: "none" },
    response: { kind: "none" },
    status: [204],
    errors: USER_ERRORS,
  },
  {
    id: "vaults.encryptionSalt",
    method: "GET",
    path: "/api/vaults/:id/encryption-salt",
    auth: "none",
    contract: "exempt",
    params: vaultParams,
    body: { kind: "none" },
    response: { kind: "json", schema: VaultEncryptionSaltResponseSchema },
    status: [200],
    errors: ["NOT_FOUND", "INTERNAL_ERROR"],
  },
  {
    id: "vaults.keyCheck",
    method: "GET",
    path: "/api/vaults/:id/key-check",
    auth: "none",
    contract: "exempt",
    params: vaultParams,
    body: { kind: "none" },
    response: { kind: "json", schema: VaultKeyCheckResponseSchema },
    status: [200],
    errors: ["NOT_FOUND", "INTERNAL_ERROR"],
  },
  {
    id: "admin.status",
    method: "GET",
    path: "/api/admin/status",
    auth: "host",
    scope: "status",
    contract: "exempt",
    body: { kind: "none" },
    response: { kind: "json", schema: AdminStatusResponseSchema },
    status: [200],
    errors: HOST_ERRORS,
  },
  {
    id: "admin.runtime",
    method: "GET",
    path: "/api/admin/runtime",
    auth: "host",
    scope: "status",
    contract: "exempt",
    body: { kind: "none" },
    response: { kind: "json", schema: AdminRuntimeResponseSchema },
    status: [200],
    errors: HOST_ERRORS,
  },
  {
    id: "sync.push",
    method: "POST",
    path: "/api/vaults/:id/sync/push",
    auth: "sync",
    contract: "required",
    rateLimit: "sync",
    params: vaultParams,
    body: { kind: "push", schema: PushBodySchema },
    response: { kind: "json", schema: SyncPushResponseSchema },
    status: [200],
    // The pusher's own session id: the server excludes it from the `files_pushed`
    // broadcast, so a rename here silently disables echo suppression.
    headers: { request: ["x-courier-session-id"] },
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.pull",
    method: "POST",
    path: "/api/vaults/:id/sync/pull",
    auth: "sync",
    contract: "required",
    rateLimit: "sync",
    params: vaultParams,
    body: { kind: "json", schema: SyncPullRequestSchema },
    response: { kind: "json", schema: SyncPullResponseSchema },
    status: [200],
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.versionContent",
    method: "GET",
    path: "/api/vaults/:id/sync/versions/:contentHash/content",
    auth: "sync",
    contract: "required",
    rateLimit: "transfer",
    params: contentParams,
    paramFailure: "not-found",
    body: { kind: "none" },
    response: {
      kind: "stream",
      contentType: "application/octet-stream",
      headers: ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"],
    },
    status: [200, 206],
    headers: { request: ["Range"] },
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.versionContentHead",
    method: "HEAD",
    path: "/api/vaults/:id/sync/versions/:contentHash/content",
    auth: "sync",
    contract: "required",
    rateLimit: "transfer",
    params: contentParams,
    paramFailure: "not-found",
    body: { kind: "none" },
    response: {
      kind: "stream",
      contentType: "application/octet-stream",
      headers: ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"],
    },
    status: [200, 206],
    headers: { request: ["Range"] },
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.contents",
    method: "POST",
    path: "/api/vaults/:id/sync/contents",
    auth: "sync",
    contract: "required",
    rateLimit: "transfer",
    params: vaultParams,
    body: { kind: "json", schema: SyncContentsRequestSchema },
    response: { kind: "binary", contentType: "application/octet-stream" },
    status: [200],
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.chunkPut",
    method: "PUT",
    path: "/api/vaults/:id/sync/blobs/:contentHash/chunks/:index",
    auth: "sync",
    contract: "required",
    rateLimit: "transfer",
    params: chunkParams,
    query: ChunkUploadQuerySchema,
    body: { kind: "bytes", limit: "chunk" },
    response: { kind: "json", schema: ChunkUploadAckSchema },
    status: [200],
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.chunkStatus",
    method: "GET",
    path: "/api/vaults/:id/sync/blobs/:contentHash/status",
    auth: "sync",
    contract: "required",
    rateLimit: "transfer",
    params: contentParams,
    body: { kind: "none" },
    response: { kind: "json", schema: ChunkUploadStatusSchema },
    status: [200],
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.versions",
    method: "GET",
    path: "/api/vaults/:id/sync/versions",
    auth: "sync",
    contract: "required",
    rateLimit: "sync",
    params: vaultParams,
    query: FileVersionQuerySchema,
    body: { kind: "none" },
    response: { kind: "json", schema: FileVersionHistoryResponseSchema },
    status: [200],
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.history",
    method: "GET",
    path: "/api/vaults/:id/sync/history",
    auth: "sync",
    contract: "required",
    rateLimit: "sync",
    params: vaultParams,
    body: { kind: "none" },
    response: { kind: "json", schema: VaultSyncHistoryResponseSchema },
    status: [200],
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.index",
    method: "GET",
    path: "/api/vaults/:id/sync/index",
    auth: "sync",
    contract: "required",
    rateLimit: "sync",
    params: vaultParams,
    body: { kind: "none" },
    response: { kind: "json", schema: VaultSyncIndexResponseSchema },
    status: [200],
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.deleted",
    method: "GET",
    path: "/api/vaults/:id/sync/deleted",
    auth: "sync",
    contract: "required",
    rateLimit: "sync",
    params: vaultParams,
    body: { kind: "none" },
    response: { kind: "json", schema: ListDeletedFilesResponseSchema },
    status: [200],
    errors: SYNC_ERRORS,
  },
  {
    id: "sync.clearDeleted",
    method: "POST",
    path: "/api/vaults/:id/sync/deleted/clear",
    auth: "sync",
    contract: "required",
    rateLimit: "sync",
    params: vaultParams,
    body: { kind: "none" },
    response: { kind: "json", schema: ClearDeletedResponseSchema },
    status: [200],
    errors: SYNC_ERRORS,
  },
] as const satisfies readonly HttpContract[];

export type HttpContractId = (typeof HTTP)[number]["id"];

/** The socket: any path upgrades, and the frames are the contract. */
export const WS = {
  upgrade: {
    path: "/",
    anyPath: true,
    contract: "exempt",
    headers: ["upgrade"],
  },
  client: WsClientMessageSchema,
  server: WsServerMessageSchema,
} as const;

export const BINARY = {
  pushBody: PUSH_BODY_SPEC,
  contentBatch: CONTENT_BATCH_SPEC,
  blob: BLOB_SPEC,
} as const;

/**
 * The constants both sides must agree on, as **values**.
 *
 * The old surface stored a constant's printed source, so a value derived from a name
 * that was not itself recorded could change without the gate seeing it. Here the number
 * is the number.
 */
export const CONSTANTS = {
  API_ERROR_CODES,
  API_KEY_SCOPES,
  BLOB_FLAG_CHUNK_AAD,
  BLOB_HEADER_BYTES,
  BLOB_MAGIC,
  CHUNKED_TRANSFER_THRESHOLD,
  CHUNK_PLAINTEXT_BYTES,
  CHUNK_STORED_BYTES,
  CONTENT_BATCH_HEADER_BYTES,
  CONTENT_BATCH_MAGIC,
  CONTENT_HASH_PATTERN,
  CONTRACT_HEADER,
  HISTORY_KINDS,
  KEY_CHECK_VALUE,
  MAX_CHUNKS,
  MAX_CONTENT_BATCH_BYTES,
  MAX_CONTENT_BATCH_FILES,
  MAX_DEVICE_NAME_LENGTH,
  MAX_ENCRYPTED_PATH_LENGTH,
  MAX_HISTORY_LIMIT,
  MAX_ID_LENGTH,
  MAX_PULL_BATCH_FILES,
  MAX_PUSH_BATCH_FILES,
  MAX_PUSH_HEADER_BYTES,
  PUSH_HEADER_LENGTH_BYTES,
  SYNC_ACTIONS,
} as const;

export const WIRE = {
  http: HTTP,
  ws: WS,
  binary: BINARY,
  error: ApiErrorSchema,
  constants: CONSTANTS,
} as const;

export type Wire = typeof WIRE;
