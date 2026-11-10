/**
 * The HTTP wire schemas.
 *
 * Every request body, query, path parameter and response body the REST API exchanges is
 * defined here once. The server validates with these; the contract surface serializes
 * them; the client can validate a response with them when a host opts in. The existing
 * interfaces in `../sync`, `../vault`, `../auth` and `../http` stay the readable type
 * names, and `conformance.test.ts` pins each schema's inferred type to its interface.
 *
 * The schemas are deliberately stricter than the types where the server is: a string
 * length, a regex or an integer bound is part of what a peer can observe, and the old
 * static surface could not see it because it read declarations only.
 */
import { MAX_CHUNKS } from "../blob";
import { API_ERROR_CODES } from "../errors";
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
import { MAX_CONTENT_BATCH_FILES } from "../wire";
import { integer, list, queryInteger, text, z } from "./schema";

// ── Shared vocabulary ──

/** The error codes a server may answer with, plus the one a client invents. */
export const API_ERROR_CODE_VALUES = [...API_ERROR_CODES, "UNKNOWN_ERROR"] as const;

export const SyncActionSchema = z.enum(SYNC_ACTIONS);
export const HistoryKindSchema = z.enum(HISTORY_KINDS);

export const HistoryLimitsSchema = z.object({
  documents: z.number(),
  attachments: z.number(),
});

/** The body of every failed request (`docs/api.md` §Error code list). */
export const ApiErrorSchema = z.object({
  error: z.enum(API_ERROR_CODE_VALUES),
  message: z.string(),
  details: z.optional(z.array(z.object({ field: z.string(), message: z.string() }))),
});

// ── Health ──

export const HealthResponseSchema = z.object({
  status: z.string(),
  timestamp: z.string(),
  generation: z.optional(z.number()),
  minClient: z.optional(z.number()),
  version: z.optional(z.string()),
});

// ── Users ──

export const UserSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  storageBytesLimit: z.nullable(z.number()),
  maskedKey: z.string(),
  retentionDays: z.nullable(z.number()),
  maxFileBytes: z.number(),
  maxVaults: z.number(),
  expiresAt: z.nullable(z.string()),
  disabled: z.boolean(),
  createdAt: z.string(),
  usedBytes: z.optional(z.number()),
  vaultsCount: z.optional(z.number()),
});

export const CreateUserResponseSchema = z.extend(UserSummarySchema, { key: z.string() });

export const RevealUserKeyResponseSchema = z.object({ key: z.string() });

export const ListUsersResponseSchema = z.object({ users: z.array(UserSummarySchema) });

export const CreateUserRequestSchema = z.object({
  name: text({ min: 1, max: 255 }),
  storageBytesLimit: z.optional(z.nullable(integer({ min: 0 }))),
  retentionDays: z.optional(z.nullable(integer({ min: 0 }))),
  maxFileBytes: z.optional(integer({ min: 0, max: Number.MAX_SAFE_INTEGER })),
  maxVaults: z.optional(integer({ min: 0 })),
  expiresAt: z.optional(z.nullable(z.iso.datetime())),
  disabled: z.optional(z.boolean()),
});

export const UpdateUserRequestSchema = z
  .object({
    name: z.optional(text({ min: 1, max: 255 })),
    storageBytesLimit: z.optional(z.nullable(integer({ min: 0 }))),
    retentionDays: z.optional(z.nullable(integer({ min: 0 }))),
    maxFileBytes: z.optional(integer({ min: 0, max: Number.MAX_SAFE_INTEGER })),
    maxVaults: z.optional(integer({ min: 0 })),
    expiresAt: z.optional(z.nullable(z.iso.datetime())),
    disabled: z.optional(z.boolean()),
  })
  .check(
    z.refine((value) => Object.keys(value).length > 0, {
      message: "At least one field must be provided",
    }),
  );

// ── Vaults ──

export const CreateVaultRequestSchema = z.object({
  name: text({ min: 1, max: 255 }),
  encryptionSalt: text({ min: 1, max: 128 }),
  keyCheck: text({ min: 1, max: 256 }),
});

export const UpdateVaultRequestSchema = z
  .object({
    name: z.optional(text({ min: 1, max: 255 })),
    historyLimitDocuments: z.optional(integer({ min: 1, max: MAX_HISTORY_LIMIT })),
    historyLimitAttachments: z.optional(integer({ min: 1, max: MAX_HISTORY_LIMIT })),
  })
  .check(
    z.refine(
      (value) =>
        value.name !== undefined ||
        value.historyLimitDocuments !== undefined ||
        value.historyLimitAttachments !== undefined,
      {
        message: "at least one of name, historyLimitDocuments, historyLimitAttachments is required",
      },
    ),
  );

export const VaultHistorySettingsSchema = z.object({
  historyLimitDocuments: z.number(),
  historyLimitAttachments: z.number(),
});

export const VaultBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});

export const VaultSummarySchema = z.intersection(VaultBaseSchema, VaultHistorySettingsSchema);

export const CreateVaultResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  historyLimitDocuments: z.number(),
  historyLimitAttachments: z.number(),
});

export const VaultSettingsResponseSchema = z.intersection(
  z.object({ id: z.string(), name: z.string() }),
  VaultHistorySettingsSchema,
);

export const ListVaultsResponseSchema = z.object({ vaults: z.array(VaultSummarySchema) });

export const VaultEncryptionSaltResponseSchema = z.object({ encryptionSalt: z.string() });

export const VaultKeyCheckResponseSchema = z.object({ keyCheck: z.string() });

// ── Sync: push ──

export const SyncPushResultSchema = z.object({
  fileId: z.string(),
  status: z.enum(["ok", "stale_base", "content_missing", "error"]),
  versionId: z.optional(z.string()),
  contentHash: z.optional(z.string()),
  currentVersionId: z.optional(z.string()),
  error: z.optional(z.string()),
});

export const SyncPushResponseSchema = z.object({ results: z.array(SyncPushResultSchema) });

const pushFileFields = {
  fileId: text({ min: 1, max: MAX_ID_LENGTH }),
  encryptedPath: text({ max: MAX_ENCRYPTED_PATH_LENGTH }),
  action: SyncActionSchema,
  versionId: text({ min: 1, max: MAX_ID_LENGTH }),
  contentHash: text({ pattern: CONTENT_HASH_PATTERN }),
  sizeBytes: integer({ min: 0 }),
  mtimeMs: integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
  baseVersionId: z.nullable(text({ min: 1, max: MAX_ID_LENGTH })),
  contentChunks: z.optional(integer({ min: 0, max: MAX_CHUNKS })),
  historyKind: HistoryKindSchema,
};

/**
 * One file of a **parsed** push body: the header entry plus the ciphertext the frame
 * carried. The server validates this after `parsePushBody`.
 */
export const PushFileFrameSchema = z.object({
  ...pushFileFields,
  // `z.instanceof` widens the constructor's type; `custom` keeps the inferred field
  // exactly `Uint8Array`, which is what `PushFileFrame.content` declares.
  content: z.nullable(z.custom<Uint8Array>((value) => value instanceof Uint8Array)),
});

/** One file of the JSON **header** on the wire: the same fields, and a content length. */
export const PushFileHeaderSchema = z.object({
  ...pushFileFields,
  contentLength: integer({ min: 0 }),
});

export const PushBodySchema = z.object({
  deviceName: z.nullable(text({ min: 1, max: MAX_DEVICE_NAME_LENGTH })),
  files: list(PushFileFrameSchema, { min: 1, max: MAX_PUSH_BATCH_FILES }),
});

export const PushBodyHeaderSchema = z.object({
  deviceName: z.nullable(text({ min: 1, max: MAX_DEVICE_NAME_LENGTH })),
  files: list(PushFileHeaderSchema, { min: 1, max: MAX_PUSH_BATCH_FILES }),
});

export type PushFileHeader = z.infer<typeof PushFileHeaderSchema>;

// ── Sync: pull and chains ──

export const SyncPullRequestSchema = z.object({
  files: list(z.object({ fileId: text({ min: 1, max: MAX_ID_LENGTH }) }), {
    max: MAX_PULL_BATCH_FILES,
  }),
});

export const VersionChainEntrySchema = z.object({
  versionId: z.string(),
  contentHash: z.string(),
  encryptedPath: z.string(),
  action: SyncActionSchema,
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  createdAt: z.string(),
});

export const FileVersionChainSchema = z.object({
  fileId: z.string(),
  encryptedPath: z.string(),
  versions: z.array(VersionChainEntrySchema),
});

export const SyncPullResponseSchema = z.object({ files: z.array(FileVersionChainSchema) });

export const FileVersionInfoSchema = z.object({
  versionId: z.string(),
  contentHash: z.string(),
  encryptedPath: z.string(),
  action: SyncActionSchema,
  sizeBytes: z.number(),
  mtimeMs: z.number(),
  deviceName: z.nullable(z.string()),
  createdAt: z.string(),
});

export const FileVersionHistoryResponseSchema = z.object({
  versions: z.array(FileVersionInfoSchema),
});

export const VaultSyncHistoryResponseSchema = z.object({
  files: z.array(
    z.object({
      fileId: z.string(),
      encryptedPath: z.string(),
      currentVersionId: z.string(),
      currentContentHash: z.string(),
      versions: z.array(FileVersionInfoSchema),
    }),
  ),
});

export const VaultSyncIndexEntrySchema = z.object({
  fileId: z.string(),
  head: VersionChainEntrySchema,
  previousLive: z.nullable(VersionChainEntrySchema),
});

export const VaultSyncIndexResponseSchema = z.object({
  files: z.array(VaultSyncIndexEntrySchema),
});

// ── Sync: contents, chunks, deleted ──

export const SyncContentsRequestSchema = z.object({
  hashes: list(text({ pattern: CONTENT_HASH_PATTERN }), {
    min: 1,
    max: MAX_CONTENT_BATCH_FILES,
  }),
});

export const ChunkUploadQuerySchema = z.object({
  chunkCount: queryInteger({ min: 1, max: MAX_CHUNKS }),
  plaintextSize: queryInteger({ min: 1 }),
});

export const FileVersionQuerySchema = z.object({
  fileId: text({ min: 1, max: MAX_ID_LENGTH }),
});

export const ChunkUploadAckSchema = z.object({ received: z.number() });

export const ChunkUploadStatusSchema = z.object({
  received: z.number(),
  complete: z.boolean(),
});

export const ClearDeletedResponseSchema = z.object({
  deletedFiles: z.number(),
  deletedBlobs: z.number(),
});

export const DeletedFileInfoSchema = z.object({
  fileId: z.string(),
  lastEncryptedPath: z.nullable(z.string()),
  previousVersionId: z.nullable(z.string()),
  previousContentHash: z.nullable(z.string()),
  previousSizeBytes: z.nullable(z.number()),
  deletedByDeviceName: z.nullable(z.string()),
  deletedAt: z.string(),
});

export const ListDeletedFilesResponseSchema = z.object({ files: z.array(DeletedFileInfoSchema) });

// ── Admin ──

export const AdminStatusResponseSchema = z.object({
  storageUsedBytes: z.number(),
  storageLimitBytes: z.nullable(z.number()),
  dbBytes: z.number(),
  diskTotalBytes: z.number(),
  diskUsedBytes: z.number(),
  diskFreeBytes: z.number(),
  binarySha256: z.string(),
  binarySize: z.number(),
  blobCount: z.number(),
  usersCount: z.number(),
  devicesCount: z.number(),
  vaultsCount: z.number(),
  migrationsApplied: z.number(),
  migrationsKnown: z.number(),
  version: z.string(),
});

export const AdminRuntimeResponseSchema = z.object({
  version: z.string(),
  runtime: z.string(),
  pid: z.number(),
  uptimeSeconds: z.number(),
  cpuMicros: z.number(),
  cpuPercent: z.nullable(z.number()),
  memoryBytes: z.number(),
  cpuCount: z.number(),
  loadAverage: z.tuple([z.number(), z.number(), z.number()]),
  freeMemoryBytes: z.number(),
  totalMemoryBytes: z.number(),
  onlineUsers: z.number(),
  onlineVaults: z.number(),
  sampledAt: z.string(),
});
