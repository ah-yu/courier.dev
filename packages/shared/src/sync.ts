/** Sync action types — what kind of file change occurred. */
export const SYNC_ACTIONS = ["create", "modify", "rename", "delete", "restore"] as const;

export type SyncAction = (typeof SYNC_ACTIONS)[number];

/**
 * The wire limits the client and the server both have to respect.
 *
 * They used to live only in the server's Zod schema, which meant the engine could
 * not know them: it bounded a push batch with its own copy of `100` and had no way
 * to see the `512`-character ceiling on `encryptedPath`, so a single long path made
 * the server refuse the **whole batch** with a 422 that no client could explain.
 * Declared once here, used by the server's schema and by the engine's own bounds.
 */
export const MAX_PUSH_BATCH_FILES = 100;
export const MAX_PULL_BATCH_FILES = 200;
export const MAX_ID_LENGTH = 64;
/** Longest `encryptedPath` the API accepts (`base64(iv ‖ ciphertext ‖ tag)`). */
export const MAX_ENCRYPTED_PATH_LENGTH = 512;
/** A plaintext content hash: the SHA-256 of the file, lowercase hex. */
export const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/;

/**
 * The default per-key maximum for a synced file, in plaintext bytes.
 *
 * 50 MiB: comfortably above every note, theme, plugin bundle and PDF a vault
 * normally holds, far below the video that would exhaust a phone's memory during
 * a hash. `0` means "no limit". The server stores this as the default of
 * `users.max_file_bytes` and every host falls back to it when the account's
 * value cannot be read.
 */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * How many versions of one file's chain the server keeps — the **vault-level** setting
 * that stops an edited note from accumulating history (and storage) for ever.
 *
 * Split in two because the two kinds of file age differently: a note or a canvas is the
 * vault's own content, edited daily and worth a deep history, while an attachment is a
 * large immutable object whose old versions are mostly wasted bytes. The split is the
 * engine's file-type table (`fileTypeOf`: markdown and canvas are `"always"`, every other
 * path is an attachment), so a device classifies each file at push time and states only
 * the **kind** — the server never sees a plaintext path and cannot classify anything, but
 * it owns the numbers (see `wire.ts` and `vault.ts`).
 *
 * The values live on the **vault** row, not on a device and not under the account: every
 * device of that vault reads and writes the same two numbers, so the retention policy is
 * one policy rather than "whatever the last device that edited the file happened to set".
 */
export interface HistoryLimits {
  /** Markdown notes and `.canvas` files. */
  documents: number;
  /** Everything else: images, audio, video, PDFs, and the config-folder files. */
  attachments: number;
}

/**
 * The two kinds of file, for the limit split.
 *
 * Stated per pushed version (`files[].historyKind`): the server maps it to its own
 * `HistoryLimits` and stores it on the row, so a later trim pass — for example after the
 * vault's limit was lowered — can apply the right bound to chains nobody is pushing.
 */
export const HISTORY_KINDS = ["documents", "attachments"] as const;

export type HistoryKind = (typeof HISTORY_KINDS)[number];

/**
 * The defaults: 200 versions of a note or canvas, 10 of an attachment.
 *
 * 200 edits of a note is weeks of ordinary writing and still a history a person can
 * scroll; 10 revisions of a 20 MiB attachment is a bound on the store rather than on a
 * workflow, because an attachment is normally written once and replaced at most a few
 * times. Both are the defaults of the vault's columns and what "reset" returns to.
 */
export const DEFAULT_HISTORY_LIMITS: HistoryLimits = { documents: 200, attachments: 10 };

/**
 * The largest history limit a vault may hold.
 *
 * A bound rather than a product setting: the server deletes the rows beyond the limit,
 * so a huge value is merely "keep everything", and a bound keeps the number meaningful
 * in the API schema and the settings fields. A vault that wants no pruning sets this.
 */
export const MAX_HISTORY_LIMIT = 10_000;

/**
 * One limit from a stored or typed value: a positive integer, clamped to
 * {@link MAX_HISTORY_LIMIT}, or `fallback` for anything else.
 *
 * Every producer runs through it — a vault row written by an older build, a settings
 * field, an admin payload — so a missing or nonsense value can never reach the trim and
 * never reads as "delete every version" (`0` or a negative).
 */
export function normalizeHistoryLimit(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return fallback;
  return Math.min(value, MAX_HISTORY_LIMIT);
}

/**
 * Longest device label a client may stamp on a version.
 *
 * The name is free-form user-facing text (a Chinese name is normal), so it travels
 * in the push frame's JSON header and inside the WebSocket `subscribe` message
 * rather than in an HTTP header. It is display metadata only: the server stores it
 * on the version row and never resolves it against anything.
 */
export const MAX_DEVICE_NAME_LENGTH = 100;

/**
 * The label as it goes on the wire, or `null` when there is nothing to state.
 *
 * One rule for four callers that had their own: the push frame, the WebSocket
 * `subscribe` message (the server's copy), the plugin's device-name field and the CLI's
 * `register` / `device rename`. They disagreed — the plugin trimmed but did not bound,
 * the CLI did neither, and a name over the limit made the server refuse the whole push
 * batch with a 422 while the subscribe path truncated it.
 */
export function trimDeviceName(value: string | null | undefined): string | null {
  const trimmed = value?.trim().slice(0, MAX_DEVICE_NAME_LENGTH) ?? "";
  return trimmed || null;
}

/**
 * The label a device states before the user has named it.
 *
 * Shared rather than repeated in each host because it is also **not** an identity: two
 * fresh installs both push under it, so nothing may use it to tell devices apart. The
 * plugin's session log deliberately does not: it takes the direction from the operation
 * (a push is outgoing, an applied pull is incoming), and only displays the label.
 */
export const DEFAULT_DEVICE_NAME = "My Device";

/** The label a **stored** setting should hold: trimmed, bounded, or the fallback. */
export function normalizeDeviceName(
  value: string | null | undefined,
  fallback = DEFAULT_DEVICE_NAME,
): string {
  return trimDeviceName(value) ?? fallback;
}

// ── Push ──

/**
 * The push **request** is not JSON: it is the binary frame described in
 * `./wire.ts` (`buildPushBody` / `parsePushBody`), one body carrying the header
 * and the raw ciphertext of every file in the batch. `SyncPushResponse` below is
 * still JSON.
 */

/** Per-file result in a batch push response. */
export interface SyncPushResult {
  fileId: string;
  /**
   * `ok` — the version was appended; `stale_base` — refused because the chain's
   * head is not the `baseVersionId` this push was decided from (nothing was
   * written: the client is expected to pull and decide again); `content_missing` —
   * the push carried no content while the store holds no blob for its
   * `contentHash` (a `rename` that reused content it believed was already there;
   * the client is expected to push again *with* the content); `error` — anything
   * else.
   */
  status: "ok" | "stale_base" | "content_missing" | "error";
  versionId?: string;
  contentHash?: string;
  /** The head the server actually holds — present with `stale_base`. */
  currentVersionId?: string;
  error?: string;
}

/** Response with per-file results from a batch push. */
export interface SyncPushResponse {
  results: SyncPushResult[];
}

// ── Pull (version chain lookup) ──

/** Request body for pulling remote version chains. */
export interface SyncPullRequest {
  files: Array<{ fileId: string }>;
}

/**
 * A single version entry in a file's remote version chain.
 *
 * Each version carries the path it was written at, so a client can materialise a
 * file it has never seen (a note created on another device) and can follow a
 * rename — both from the version chain alone, without a full vault history call.
 */
export interface VersionChainEntry {
  versionId: string;
  contentHash: string;
  encryptedPath: string;
  action: SyncAction;
  /**
   * Plaintext size of the version in bytes — `0` only for a `delete` version,
   * which carries no content.
   *
   * It is what a client plans a chunked transfer from, reports as progress and shows in
   * the history. It is **not** a download filter: `SyncScope.maxFileBytes` bounds what a
   * device sends, and a version a peer already uploaded is materialised whatever the
   * receiver's cap says (a file silently absent from one device reads as data loss).
   * A `rename` version records its content size even when the push carried no content
   * (the store already held it).
   */
  sizeBytes: number;
  /**
   * Plaintext **last modification time** of the file on the device that pushed this
   * version (milliseconds since the epoch), as that device's filesystem reported it.
   *
   * It exists for the one conflict rule that is not "the remote head wins": a path
   * inside Obsidian's config folder resolves by modification time instead, because a
   * conflict copy parked there is invisible to the app. It is client-reported metadata
   * and is never used for chain ordering — that is `createdAt`, then `rowid`.
   */
  mtimeMs: number;
  createdAt: string;
}

/** Remote version chain for a single file (ordered oldest→newest by createdAt). */
export interface FileVersionChain {
  fileId: string;
  encryptedPath: string;
  versions: VersionChainEntry[];
}

/** Response containing version chains for requested files. */
export interface SyncPullResponse {
  files: FileVersionChain[];
}

// ── Version content ──

/**
 * The content of one version is **binary**: `GET …/sync/versions/:contentHash/content`
 * answers `application/octet-stream` with `iv ‖ AES-256-GCM ciphertext ‖ tag`, and
 * answers `404` when the store does not hold that hash. There is no response
 * envelope to parse and no base64 — the caller asked for a hash it already has.
 */

// ── Version history (for UI display) ──

/** Metadata for a single file version. */
export interface FileVersionInfo {
  versionId: string;
  contentHash: string;
  encryptedPath: string;
  action: SyncAction;
  /** Plaintext size of this version in bytes (`0` only for a `delete` version). */
  sizeBytes: number;
  /**
   * Plaintext last modification time of the file on the pushing device (ms since the
   * epoch). A config-folder conflict compares it with the peer's own file stamp; it
   * never orders the chain (`createdAt` does, then `rowid`).
   */
  mtimeMs: number;
  /**
   * The label the pushing client had at the time of this version, for display in
   * the version/sync history. `null` for a version pushed without a label.
   *
   * Stored per version rather than resolved from a device registry: a client may
   * rename itself at any time, and the history then shows the name it had *then*.
   */
  deviceName: string | null;
  createdAt: string;
}

/** Version history for a single file. */
export interface FileVersionHistoryResponse {
  versions: FileVersionInfo[];
}

/** Full vault sync history — all files with their version histories. */
export interface VaultSyncHistoryResponse {
  files: Array<{
    fileId: string;
    encryptedPath: string;
    currentVersionId: string;
    currentContentHash: string;
    versions: FileVersionInfo[];
  }>;
}

/**
 * One chain's **current head**, as the engine's cold-start index reports it.
 *
 * The reconcile only needs the head to decide a file — the full chain is fetched on the
 * rare occasions something needs the ancestry (a convergence adoption, a conflict after
 * a refused push). Returning every version of every chain made a phone download a
 * vault's entire history on every pass, which grew with age rather than with changes.
 */
export interface VaultSyncIndexEntry {
  fileId: string;
  /** The chain's newest version. */
  head: VersionChainEntry;
  /**
   * The newest version whose action is not `delete` — the content a tombstone removed.
   *
   * `null` for a live head, and for a chain that holds only `delete` rows (for example
   * when retention pruned the live versions, or a delete was pushed as the first row).
   * It is not necessarily the row immediately before the head: a chain can carry
   * consecutive deletes, and the version a later delete removed is still the newest live
   * one.
   */
  previousLive: VersionChainEntry | null;
}

/** The vault's chains, one entry per chain (tombstones included) — what a reconcile reads. */
export interface VaultSyncIndexResponse {
  files: VaultSyncIndexEntry[];
}

// ── Recycle bin / deleted files ──

/** Response for clearing deleted files from a vault. */
export interface ClearDeletedResponse {
  deletedFiles: number;
  deletedBlobs: number;
}

/** Metadata for a deleted file — its version chain's last action is "delete". */
export interface DeletedFileInfo {
  fileId: string;
  /** encrypted path of the last non-delete version (null if the chain only holds the delete) */
  lastEncryptedPath: string | null;
  /** version id of the last non-delete version — the restorable one */
  previousVersionId: string | null;
  /** content hash of the last non-delete version */
  previousContentHash: string | null;
  /**
   * Plaintext size of the restorable version, or `null` when there is none.
   *
   * The preview needs it to know whether the version is chunked (above 8 MiB); the
   * deleted row otherwise carries only the hash, which names the content but not its
   * framing.
   */
  previousSizeBytes: number | null;
  /** Label of the client that produced the delete, for display (`null` if unknown) */
  deletedByDeviceName: string | null;
  /** ISO 8601 timestamp of the delete event */
  deletedAt: string;
}

/** Response listing all deleted files of a vault (for the recycle bin UI). */
export interface ListDeletedFilesResponse {
  files: DeletedFileInfo[];
}
