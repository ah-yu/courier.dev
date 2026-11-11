/**
 * The bridge between the readable interfaces and the executable schemas.
 *
 * Each assertion is compile-time: if an interface and its schema drift, `bun run
 * typecheck` fails here instead of the contract gate going green on a stale declaration.
 * The list is deliberately exhaustive — it is the coverage statement for the schema
 * module, and a new wire type without a line here is a type that has no runtime mirror.
 */
import { expectTypeOf, it } from "vitest";
import type * as auth from "../auth";
import type * as contract from "../contract";
import type * as errors from "../errors";
import type * as sharedHttp from "../http";
import type * as sync from "../sync";
import type * as vault from "../vault";
import type * as wire from "../wire";
import * as http from "./http";
import { z } from "./schema";
import * as ws from "./ws";

it("HTTP request and response schemas match their interfaces", () => {
  expectTypeOf<
    z.infer<typeof http.HealthResponseSchema>
  >().toEqualTypeOf<contract.HealthResponse>();

  expectTypeOf<z.infer<typeof http.UserSummarySchema>>().toEqualTypeOf<auth.UserSummary>();
  expectTypeOf<
    z.infer<typeof http.CreateUserResponseSchema>
  >().toEqualTypeOf<auth.CreateUserResponse>();
  expectTypeOf<
    z.infer<typeof http.RevealUserKeyResponseSchema>
  >().toEqualTypeOf<auth.RevealUserKeyResponse>();
  expectTypeOf<
    z.infer<typeof http.ListUsersResponseSchema>
  >().toEqualTypeOf<auth.ListUsersResponse>();
  expectTypeOf<
    z.infer<typeof http.CreateUserRequestSchema>
  >().toEqualTypeOf<auth.CreateUserRequest>();
  expectTypeOf<
    z.infer<typeof http.UpdateUserRequestSchema>
  >().toEqualTypeOf<auth.UpdateUserRequest>();

  expectTypeOf<
    z.infer<typeof http.CreateVaultRequestSchema>
  >().toEqualTypeOf<vault.CreateVaultRequest>();
  expectTypeOf<
    z.infer<typeof http.CreateVaultResponseSchema>
  >().toEqualTypeOf<vault.CreateVaultResponse>();
  expectTypeOf<
    z.infer<typeof http.VaultHistorySettingsSchema>
  >().toEqualTypeOf<vault.VaultHistorySettings>();
  expectTypeOf<z.infer<typeof http.VaultSummarySchema>>().toEqualTypeOf<vault.VaultSummary>();
  expectTypeOf<
    z.infer<typeof http.VaultSettingsResponseSchema>
  >().toEqualTypeOf<vault.VaultSettingsResponse>();
  expectTypeOf<
    z.infer<typeof http.ListVaultsResponseSchema>
  >().toEqualTypeOf<vault.ListVaultsResponse>();
  expectTypeOf<
    z.infer<typeof http.VaultEncryptionSaltResponseSchema>
  >().toEqualTypeOf<vault.VaultEncryptionSaltResponse>();
  expectTypeOf<
    z.infer<typeof http.VaultKeyCheckResponseSchema>
  >().toEqualTypeOf<vault.VaultKeyCheckResponse>();

  expectTypeOf<z.infer<typeof http.SyncActionSchema>>().toEqualTypeOf<sync.SyncAction>();
  expectTypeOf<z.infer<typeof http.HistoryKindSchema>>().toEqualTypeOf<sync.HistoryKind>();
  expectTypeOf<z.infer<typeof http.HistoryLimitsSchema>>().toEqualTypeOf<sync.HistoryLimits>();
  expectTypeOf<z.infer<typeof http.SyncPushResultSchema>>().toEqualTypeOf<sync.SyncPushResult>();
  expectTypeOf<
    z.infer<typeof http.SyncPushResponseSchema>
  >().toEqualTypeOf<sync.SyncPushResponse>();
  expectTypeOf<z.infer<typeof http.SyncPullRequestSchema>>().toEqualTypeOf<sync.SyncPullRequest>();
  expectTypeOf<
    z.infer<typeof http.VersionChainEntrySchema>
  >().toEqualTypeOf<sync.VersionChainEntry>();
  expectTypeOf<
    z.infer<typeof http.FileVersionChainSchema>
  >().toEqualTypeOf<sync.FileVersionChain>();
  expectTypeOf<
    z.infer<typeof http.SyncPullResponseSchema>
  >().toEqualTypeOf<sync.SyncPullResponse>();
  expectTypeOf<z.infer<typeof http.FileVersionInfoSchema>>().toEqualTypeOf<sync.FileVersionInfo>();
  expectTypeOf<
    z.infer<typeof http.FileVersionHistoryResponseSchema>
  >().toEqualTypeOf<sync.FileVersionHistoryResponse>();
  expectTypeOf<
    z.infer<typeof http.VaultSyncHistoryResponseSchema>
  >().toEqualTypeOf<sync.VaultSyncHistoryResponse>();
  expectTypeOf<
    z.infer<typeof http.VaultSyncIndexEntrySchema>
  >().toEqualTypeOf<sync.VaultSyncIndexEntry>();
  expectTypeOf<
    z.infer<typeof http.VaultSyncIndexResponseSchema>
  >().toEqualTypeOf<sync.VaultSyncIndexResponse>();
  expectTypeOf<
    z.infer<typeof http.ClearDeletedResponseSchema>
  >().toEqualTypeOf<sync.ClearDeletedResponse>();
  expectTypeOf<z.infer<typeof http.DeletedFileInfoSchema>>().toEqualTypeOf<sync.DeletedFileInfo>();
  expectTypeOf<
    z.infer<typeof http.ListDeletedFilesResponseSchema>
  >().toEqualTypeOf<sync.ListDeletedFilesResponse>();
  expectTypeOf<
    z.infer<typeof http.SyncContentsRequestSchema>
  >().toEqualTypeOf<sync.SyncContentsRequest>();
  expectTypeOf<
    z.infer<typeof http.ChunkUploadQuerySchema>
  >().toEqualTypeOf<sync.ChunkUploadQuery>();
  expectTypeOf<
    z.infer<typeof http.FileVersionQuerySchema>
  >().toEqualTypeOf<sync.FileVersionQuery>();
  expectTypeOf<
    z.infer<typeof http.ChunkUploadAckSchema>
  >().toEqualTypeOf<sharedHttp.ChunkUploadAck>();
  expectTypeOf<
    z.infer<typeof http.ChunkUploadStatusSchema>
  >().toEqualTypeOf<sharedHttp.ChunkUploadStatus>();

  expectTypeOf<z.infer<typeof http.ApiErrorSchema>>().toEqualTypeOf<errors.ApiError>();
  expectTypeOf<
    z.infer<typeof http.ContractMismatchErrorSchema>
  >().toEqualTypeOf<errors.ContractMismatchErrorBody>();
  expectTypeOf<
    z.infer<typeof http.AdminStatusResponseSchema>
  >().toEqualTypeOf<auth.AdminStatusResponse>();
  expectTypeOf<
    z.infer<typeof http.AdminRuntimeResponseSchema>
  >().toEqualTypeOf<auth.AdminRuntimeResponse>();

  expectTypeOf<z.infer<typeof http.PushFileFrameSchema>>().toEqualTypeOf<wire.PushFileFrame>();
  expectTypeOf<z.infer<typeof http.PushBodySchema>>().toEqualTypeOf<wire.PushBody>();
});

it("WebSocket frame schemas match their unions", () => {
  expectTypeOf<z.infer<typeof ws.WsClientMessageSchema>>().toEqualTypeOf<vault.WsClientMessage>();
  expectTypeOf<z.infer<typeof ws.WsServerMessageSchema>>().toEqualTypeOf<vault.WsServerMessage>();
});
