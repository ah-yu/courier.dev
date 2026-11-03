import { sqliteTable, text, integer, index, primaryKey } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  DEFAULT_HISTORY_LIMITS,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_VAULTS,
  HISTORY_KINDS,
  SYNC_ACTIONS,
} from "@courier/shared";

// SQLite ISO 8601 timestamp default
const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  key: text("key").notNull(),
  // Comma-separated capability list (`admin` implies every other scope). The
  // default is the full-power key a human creates with `courier apikey create`;
  // a host asks for `status,users` explicitly.
  scopes: text("scopes").notNull().default("admin"),
  // Host-key validity expiry (ISO 8601). Null = never expires.
  expiresAt: text("expires_at"),
  createdAt: text("created_at").notNull().default(now),
});

// ── Users (shared-server multi-user model) ──

/**
 * A user is an account on a shared Courier server. The host creates a user and
 * authorizes its storage quota, history retention window, and key validity
 * period. Each user holds a single user key (`ck_...`) shared across devices.
 */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // Plaintext user key (ck_...). Stored in plaintext like api_keys.key.
  key: text("key").notNull(),
  // Storage quota in bytes across the user's vaults. Null = unlimited.
  storageBytesLimit: integer("storage_bytes_limit"),
  // Version-chain retention window in days. Null = keep forever.
  retentionDays: integer("retention_days"),
  // Largest plaintext file this key's clients may sync, in bytes. `0` = unlimited.
  // Delivered to clients through `GET /api/me`; it is a client-side read guard, not
  // a server-enforced resource limit (that is `storageBytesLimit`).
  maxFileBytes: integer("max_file_bytes").notNull().default(DEFAULT_MAX_FILE_BYTES),
  // How many vaults this account may own. `0` = unlimited. Enforced by
  // `POST /api/vaults`, which counts the account's existing vaults first.
  maxVaults: integer("max_vaults").notNull().default(DEFAULT_MAX_VAULTS),
  // Key validity expiry (ISO 8601). Null = never expires.
  expiresAt: text("expires_at"),
  // Whether the host has disabled the account. A disabled key keeps everything it
  // owns (the key, its vaults, their chains and blobs) but authenticates nothing:
  // every route answers `KEY_DISABLED`. It is the reversible counterpart of
  // deleting the account, which takes its vaults with it.
  disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(now),
});

export const vaults = sqliteTable("vaults", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  encryptionSalt: text("encryption_salt"),
  // AES-256-GCM ciphertext of the fixed KEY_CHECK_VALUE plaintext (base64 iv||ct||tag).
  // Lets clients verify the vault password locally without sending it to the server.
  keyCheck: text("key_check"),
  // Owning user for the shared model. Null = legacy/server-managed vault still
  // visible to any authenticated user (single-user deployments).
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  // ── Version-history retention (vault-level, shared by every device of the vault) ──
  // How many versions of each chain the server keeps. A push states its file's **kind**
  // (`file_versions.history_kind`) and the server reads the number here, so the policy is
  // one per vault rather than "whatever the last device to edit the file set". Lowering
  // either value trims the vault's existing chains when the update commits.
  historyLimitDocuments: integer("history_limit_documents")
    .notNull()
    .default(DEFAULT_HISTORY_LIMITS.documents),
  historyLimitAttachments: integer("history_limit_attachments")
    .notNull()
    .default(DEFAULT_HISTORY_LIMITS.attachments),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
});

// ── Sync table ──

/**
 * Full version history for each file. Each sync operation creates one row.
 * fileId is a UUID assigned by the client at file creation — never changes across renames.
 * Encrypted content is stored on the filesystem, not in the database.
 */
export const fileVersions = sqliteTable(
  "file_versions",
  {
    id: text("id").primaryKey(),
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    fileId: text("file_id").notNull(),
    encryptedPath: text("encrypted_path").notNull(),
    versionId: text("version_id").notNull(),
    contentHash: text("content_hash").notNull(),
    // Plaintext size of the version, reported by the pushing client. Metadata for the
    // clients' own size caps — never used for quota accounting, which reads the
    // encrypted payload the server actually received.
    sizeBytes: integer("size_bytes").notNull().default(0),
    // Plaintext last modification time of the file on the pushing device, in
    // milliseconds since the epoch. Clients compare it with their own file's stamp to
    // settle a conflict inside Obsidian's config folder (newer modification wins); it
    // never participates in chain ordering, which is `created_at` then `rowid`.
    mtimeMs: integer("mtime_ms").notNull().default(0),
    action: text("action", { enum: SYNC_ACTIONS }).notNull(),
    // The label the pushing client stated for itself when it wrote this version,
    // shown in the version/sync history. Display metadata only: there is no device
    // registry, nothing is resolved against it, and a client may rename itself at
    // any time — older rows then keep the name they were written with.
    deviceName: text("device_name"),
    // The kind of file this version belongs to, as the pushing client classified it:
    // `documents` (markdown/canvas) or `attachments` (everything else). The client states
    // it because the category is only visible in the plaintext path; the server uses it to
    // pick the vault's document or attachment limit when it trims, including in a later
    // pass that trims chains nobody is pushing. Default `attachments` is the conservative
    // side (the smaller limit) for any row a hand-written insert leaves unset.
    historyKind: text("history_kind", { enum: HISTORY_KINDS }).notNull().default("attachments"),
    createdAt: text("created_at").notNull().default(now),
  },
  (table) => [
    index("idx_file_versions_vault_file_created").on(table.vaultId, table.fileId, table.createdAt),
    // "Does any row still name this content hash?" is asked after a chain is trimmed to
    // its history limit (`tryInsertFileVersions`) and by the orphan sweep. Without this
    // the check is a scan of every version row in the vault, on the push path.
    index("idx_file_versions_vault_hash").on(table.vaultId, table.contentHash),
  ],
);

// ── Blob storage index ──

/**
 * Content-addressed blobs: one row per `(vault, plaintext hash)`, naming a byte range in
 * one immutable batch file.
 *
 * A push batch writes **one file** (`<uuid>.blob`) and flushes it once, so a single
 * `fsync` covers the whole batch; the rows that name those bytes are inserted afterwards,
 * in one transaction. "The row exists" therefore means "the bytes are on disk", and a
 * crash between the rename and the commit leaves a file no row names, which the sweep
 * reclaims.
 *
 * Nothing ever rewrites a file: a row is either repointed at a new file (a re-push of
 * content whose file was lost) or deleted, and a file is unlinked when its last row goes.
 * That is why there is no compaction step and no committed length to recover.
 */
export const blobs = sqliteTable(
  "blobs",
  {
    vaultId: text("vault_id")
      .notNull()
      .references(() => vaults.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    /** File name inside the vault's blob directory. */
    file: text("file").notNull(),
    offset: integer("offset").notNull(),
    length: integer("length").notNull(),
    plaintextSize: integer("plaintext_size").notNull().default(0),
    /** 0 for a whole-file frame, `n` for a chunked upload assembled into the file. */
    chunkCount: integer("chunk_count").notNull().default(1),
    createdAt: text("created_at").notNull().default(now),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.contentHash] }),
    // "Does any row still name this file?" is asked once per reclaim and once per
    // unreferenced-file sweep; without this it is a scan of every blob in the store.
    index("idx_blobs_file").on(table.file),
  ],
);
