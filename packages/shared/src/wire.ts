import {
  HISTORY_KINDS,
  SYNC_ACTIONS,
  trimDeviceName,
  type HistoryKind,
  type SyncAction,
} from "./sync";
import { CHUNKED_TRANSFER_THRESHOLD, chunkCountFor } from "./blob";

/**
 * The push wire format: one binary body carrying a JSON header plus the raw
 * ciphertext of every file in the batch.
 *
 * ```
 * [ 4 bytes LE: header length ][ header JSON (UTF-8) ][ content 1 ][ content 2 ]…
 * ```
 *
 * The header is `{ "deviceName"?: string, "files": [ { …, "contentLength": <n> } ] }`,
 * and each file's content sits at the running offset in that order — so the reader
 * slices without parsing anything twice, and the writer copies each payload exactly
 * once.
 *
 * `deviceName` is the **self-declared label** of the client that built the batch
 * (the server stores it on every version row it appends, and the sync history
 * displays it). It is not an identity: nothing is registered, nothing is checked
 * against a registry, and a client may call itself whatever it likes. It travels in
 * the JSON header rather than an HTTP header because it is user-facing text — a
 * Chinese device name is not a valid header value.
 *
 * Why not JSON with base64 (what this replaced): base64 inflates every payload by
 * 4/3 on the wire and on disk, and the encode/decode loops are the single most
 * expensive thing a large file does on a client — measured at ~50 ms per MiB, i.e.
 * over a second of pure CPU for a 20 MiB attachment, more than the encryption
 * itself. Raw bytes also let the blob store be a binary file rather than base64
 * text, so the same 25% comes off the disk and off every read back.
 *
 * This module is the one place that knows the frame, so both hosts (the Obsidian
 * plugin and the headless CLI) and the server agree by construction. It is pure
 * and dependency-free: it validates the *frame* (structure, lengths, no trailing
 * bytes) and leaves the field-level contract — id lengths, the action enum, the
 * batch cap — to the server's schema.
 */

/** Size of the little-endian uint32 that opens the body. */
export const PUSH_HEADER_LENGTH_BYTES = 4;

/**
 * Longest header a body may carry. A header holds only per-file metadata (ids,
 * an encrypted path, a hash, sizes), so even a 100-file batch is far below this;
 * the bound exists so a malformed body cannot make the reader allocate or scan
 * something absurd before it is rejected.
 */
export const MAX_PUSH_HEADER_BYTES = 1024 * 1024;

/**
 * One file change on the wire.
 *
 * `content` is the encrypted payload — `iv ‖ AES-256-GCM ciphertext ‖ tag` — or
 * `null` when the version carries none: a `delete`, or a `rename` whose content
 * the store already holds under `contentHash` (see the engine's rename rule).
 * `sizeBytes` is always the **plaintext** size of the version, which is what a peer plans
 * a chunked transfer from and reports as progress. It is not a download filter: the
 * account's `maxFileBytes` bounds uploads, and a version a peer already stored is
 * materialised whatever the receiver's cap says.
 *
 * `mtimeMs` is the plaintext **last modification time** of the file on the pushing
 * device (milliseconds since the epoch). It is not used for chain ordering — that
 * stays `created_at`/`rowid` — but a peer compares it with its own file's stamp to
 * settle a conflict inside Obsidian's config folder, where a parked copy would be
 * unreachable: the newer modification wins. A `delete` carries the moment this
 * device decided on the deletion (there is no file to stamp).
 */
export interface PushFileFrame {
  fileId: string;
  encryptedPath: string;
  action: SyncAction;
  versionId: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  baseVersionId: string | null;
  content: Uint8Array | null;
  /**
   * How many chunks this version's content was uploaded in, when it was uploaded
   * chunk-by-chunk instead of carried in `content`.
   *
   * `0`/absent means "the normal shape": `content` carries the payload, or the version
   * carries none (`delete`, or a `rename` reusing a stored blob). A positive value
   * means the bytes are already staged under `contentHash` (see `PUT …/blobs/:hash/
   * chunks/:index`) and the server assembles them before it inserts the row. Such a
   * version always has `content: null` and `sizeBytes > 0`.
   */
  contentChunks?: number;
  /**
   * What kind of file this version belongs to.
   *
   * The server maps it to the **vault's** own `HistoryLimits` when it trims the chain:
   * `"documents"` for markdown and canvas, `"attachments"` for everything else. The
   * client states it because the category is only visible in the plaintext path, which
   * the server never sees; the numbers themselves live on the vault, so every device of
   * the vault is trimmed by the same policy (see `@courier/shared`'s `vault.ts` and
   * `@courier/server`'s `tryInsertFileVersions`).
   */
  historyKind: HistoryKind;
}

/** The per-file header entry, as it appears in the JSON header. */
interface PushFileHeaderEntry {
  fileId: string;
  encryptedPath: string;
  action: SyncAction;
  versionId: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  baseVersionId: string | null;
  contentLength: number;
  contentChunks?: number;
  historyKind: HistoryKind;
}

/**
 * A decoded push body: the batch's files plus the label of the client that built
 * it (`null` when the header carried none).
 */
export interface PushBody {
  deviceName: string | null;
  files: PushFileFrame[];
}

/** What a host may attach to the batch it is pushing. */
export interface PushBodyOptions {
  /** Self-declared device label; empty/absent becomes `null`. */
  deviceName?: string | null;
}

const ACTIONS: readonly SyncAction[] = SYNC_ACTIONS;

/** A body that does not match the frame format. Always a client-side fault. */
export class WireFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireFormatError";
  }
}

/**
 * Encode a batch as one body.
 *
 * Each payload is copied once, into its place in the output buffer. The common
 * case — the engine pushes a single file per request — therefore costs one copy of
 * the ciphertext, where the base64 format cost an encode pass, a 4/3 string and a
 * JSON string.
 */
export function buildPushBody(
  files: readonly PushFileFrame[],
  options: PushBodyOptions = {},
): Uint8Array {
  const header: PushFileHeaderEntry[] = [];
  let contentBytes = 0;
  for (const file of files) {
    const chunks = file.contentChunks ?? 0;
    // A version travels one way or the other, never both, and a reader decides which
    // from the version's size — so the frame has to agree with that rule.
    if (file.content !== null && chunks > 0) {
      throw new WireFormatError(
        `${file.fileId} carries content and ${chunks} chunks; it must be one or the other`,
      );
    }
    if (chunks > 0) {
      if (file.sizeBytes <= CHUNKED_TRANSFER_THRESHOLD) {
        throw new WireFormatError(
          `${file.fileId} is ${file.sizeBytes} bytes, at or below the chunking threshold`,
        );
      }
      if (chunks !== chunkCountFor(file.sizeBytes)) {
        throw new WireFormatError(
          `${file.fileId} declares ${chunks} chunks for ${file.sizeBytes} bytes`,
        );
      }
    } else if (file.content !== null && file.sizeBytes > CHUNKED_TRANSFER_THRESHOLD) {
      throw new WireFormatError(
        `${file.fileId} is ${file.sizeBytes} bytes and must travel in chunks`,
      );
    }
    const contentLength = file.content?.byteLength ?? 0;
    contentBytes += contentLength;
    // The kind is what the server's trim is decided from — it picks the vault's document
    // or attachment limit — so a frame without one, or with a value the server does not
    // know, must fail here on the client rather than as a 422 on the whole batch.
    if (!HISTORY_KINDS.includes(file.historyKind)) {
      throw new WireFormatError(
        `${file.fileId} states historyKind ${String(file.historyKind)}; it must be one of ${HISTORY_KINDS.join(", ")}`,
      );
    }
    header.push({
      fileId: file.fileId,
      encryptedPath: file.encryptedPath,
      action: file.action,
      versionId: file.versionId,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes,
      mtimeMs: file.mtimeMs,
      baseVersionId: file.baseVersionId,
      contentLength,
      ...(file.contentChunks === undefined ? {} : { contentChunks: file.contentChunks }),
      historyKind: file.historyKind,
    });
  }

  // The label is part of the envelope: one batch comes from one client, so it is
  // stated once rather than repeated per file. It is display text, so it must never be
  // able to fail a batch: the server's push schema rejects anything over
  // `MAX_DEVICE_NAME_LENGTH` **for the whole request** (a 422 on every push, i.e. a
  // device that silently never syncs). The client applies `trimDeviceName` before the
  // subscribe frame, and the schema rejects a longer label.
  const deviceName = trimDeviceName(options.deviceName);
  const headerBytes = new TextEncoder().encode(
    JSON.stringify(deviceName === null ? { files: header } : { deviceName, files: header }),
  );
  if (headerBytes.byteLength > MAX_PUSH_HEADER_BYTES) {
    throw new WireFormatError(
      `push header is ${headerBytes.byteLength} bytes, over the ${MAX_PUSH_HEADER_BYTES}-byte limit`,
    );
  }

  const body = new Uint8Array(PUSH_HEADER_LENGTH_BYTES + headerBytes.byteLength + contentBytes);
  new DataView(body.buffer).setUint32(0, headerBytes.byteLength, true);
  body.set(headerBytes, PUSH_HEADER_LENGTH_BYTES);
  let offset = PUSH_HEADER_LENGTH_BYTES + headerBytes.byteLength;
  for (const file of files) {
    if (!file.content) continue;
    body.set(file.content, offset);
    offset += file.content.byteLength;
  }
  return body;
}

/**
 * Decode a body back into its batch: the client label plus its files. Content is
 * returned as a **view** into `body` (no copy) — the server hands it straight to
 * the blob store.
 *
 * Throws {@link WireFormatError} for anything malformed: a truncated body, a
 * header that is not JSON or not the expected shape, a `deviceName` that is not a
 * string, a content length that runs past the end, or trailing bytes nobody
 * claimed.
 */
export function parsePushBody(body: Uint8Array): PushBody {
  if (body.byteLength < PUSH_HEADER_LENGTH_BYTES) {
    throw new WireFormatError("body is shorter than the header length prefix");
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const headerLength = view.getUint32(0, true);
  if (headerLength === 0) throw new WireFormatError("header is empty");
  if (headerLength > MAX_PUSH_HEADER_BYTES) {
    throw new WireFormatError(
      `header is ${headerLength} bytes, over the ${MAX_PUSH_HEADER_BYTES}-byte limit`,
    );
  }
  if (PUSH_HEADER_LENGTH_BYTES + headerLength > body.byteLength) {
    throw new WireFormatError("header runs past the end of the body");
  }

  const headerText = new TextDecoder().decode(
    body.subarray(PUSH_HEADER_LENGTH_BYTES, PUSH_HEADER_LENGTH_BYTES + headerLength),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerText);
  } catch {
    throw new WireFormatError("header is not valid JSON");
  }

  const deviceName = readDeviceName(parsed);
  const entries = readHeaderEntries(parsed);
  const files: PushFileFrame[] = [];
  let offset = PUSH_HEADER_LENGTH_BYTES + headerLength;
  for (const entry of entries) {
    if (offset + entry.contentLength > body.byteLength) {
      throw new WireFormatError(
        `content of ${entry.fileId} is ${entry.contentLength} bytes but the body ends first`,
      );
    }
    files.push({
      fileId: entry.fileId,
      encryptedPath: entry.encryptedPath,
      action: entry.action,
      versionId: entry.versionId,
      contentHash: entry.contentHash,
      sizeBytes: entry.sizeBytes,
      mtimeMs: entry.mtimeMs,
      baseVersionId: entry.baseVersionId,
      content:
        entry.contentLength === 0 ? null : body.subarray(offset, offset + entry.contentLength),
      ...(entry.contentChunks === undefined ? {} : { contentChunks: entry.contentChunks }),
      historyKind: entry.historyKind,
    });
    offset += entry.contentLength;
  }

  if (offset !== body.byteLength) {
    throw new WireFormatError(`${body.byteLength - offset} trailing bytes after the last content`);
  }
  return { deviceName, files };
}

/**
 * The batch's device label: absent, empty or whitespace-only reads as `null`, so a
 * host that never set a name is not "the device called ''".
 */
function readDeviceName(parsed: unknown): string | null {
  // A header that is not an object is reported by `readHeaderEntries` with the proper
  // WireFormatError; reading a property off `null` first would throw a raw TypeError.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const raw = (parsed as { deviceName?: unknown }).deviceName;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new WireFormatError("deviceName is not a string");
  }
  return raw.trim() || null;
}

/** Structural half of the header contract (the field limits live in the schema). */
function readHeaderEntries(parsed: unknown): PushFileHeaderEntry[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WireFormatError("header is not an object");
  }
  const files = (parsed as { files?: unknown }).files;
  if (!Array.isArray(files)) throw new WireFormatError("header has no files array");

  return files.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new WireFormatError(`files[${index}] is not an object`);
    }
    const entry = raw as Record<string, unknown>;
    const action = entry.action;
    if (typeof action !== "string" || !ACTIONS.includes(action as SyncAction)) {
      throw new WireFormatError(`files[${index}].action is not a sync action`);
    }
    const rawBaseVersionId = entry.baseVersionId;
    if (rawBaseVersionId !== null && typeof rawBaseVersionId !== "string") {
      throw new WireFormatError(`files[${index}].baseVersionId is neither a string nor null`);
    }
    // The guard is what makes this a `string | null` at run time; spelling the result
    // again keeps that type visible to a type-checker that runs without the narrowing
    // (`tsconfig.scripts.json` compiles this file too), rather than casting it away.
    const baseVersionId: string | null =
      typeof rawBaseVersionId === "string" ? rawBaseVersionId : null;
    return {
      fileId: readString(entry, "fileId", index),
      encryptedPath: readString(entry, "encryptedPath", index),
      action: action as SyncAction,
      versionId: readString(entry, "versionId", index),
      contentHash: readString(entry, "contentHash", index),
      sizeBytes: readCount(entry, "sizeBytes", index),
      mtimeMs: readCount(entry, "mtimeMs", index),
      baseVersionId,
      contentLength: readCount(entry, "contentLength", index),
      ...(entry.contentChunks === undefined
        ? {}
        : { contentChunks: readCount(entry, "contentChunks", index) }),
      historyKind: readHistoryKind(entry, index),
    };
  });
}

function readString(entry: Record<string, unknown>, field: string, index: number): string {
  const value = entry[field];
  if (typeof value !== "string") {
    throw new WireFormatError(`files[${index}].${field} is not a string`);
  }
  return value;
}

function readCount(entry: Record<string, unknown>, field: string, index: number): number {
  const value = entry[field];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new WireFormatError(`files[${index}].${field} is not a non-negative integer`);
  }
  return value as number;
}

/** The file kind the server's trim is decided by: one of {@link HISTORY_KINDS}. */
function readHistoryKind(entry: Record<string, unknown>, index: number): HistoryKind {
  const value = entry["historyKind"];
  if (typeof value !== "string" || !HISTORY_KINDS.includes(value as HistoryKind)) {
    throw new WireFormatError(
      `files[${index}].historyKind is not one of ${HISTORY_KINDS.join(", ")}`,
    );
  }
  return value as HistoryKind;
}

/**
 * The batch content frame: several versions' ciphertext in one answer.
 *
 * A download used to be one request per file — the last per-file cost on the sync path
 * (`docs/first-bind-performance.md`). This frame carries up to
 * {@link MAX_CONTENT_BATCH_FILES} of them: `"CBC1" ‖ u32 count`, then per entry a `u8`
 * status (`0` present, `1` missing) and — for a present entry — a `u32` length and the
 * bytes. The client already knows the hashes it asked for, so they do not travel back; a
 * missing entry is an ordinary answer (the blob was reclaimed, or the chain points at
 * content no peer can fetch), exactly as a `404` is for one version.
 *
 * The frame is bounded on both ends: the request names at most
 * {@link MAX_CONTENT_BATCH_FILES} hashes, and the server refuses an answer over
 * {@link MAX_CONTENT_BATCH_BYTES} rather than building it.
 */
export const CONTENT_BATCH_MAGIC = "CBC1";

/** Most versions one content request may name. */
export const MAX_CONTENT_BATCH_FILES = 64;

/** Largest answer one content request may carry (the server refuses past it). */
export const MAX_CONTENT_BATCH_BYTES = 16 * 1024 * 1024;

/** Header bytes: the magic plus the entry count. */
export const CONTENT_BATCH_HEADER_BYTES = CONTENT_BATCH_MAGIC.length + 4;

/** Encode the ciphertext of several versions, in the order they were asked for. */
export function buildContentBatchBody(
  entries: ReadonlyArray<Uint8Array | null>,
): Uint8Array<ArrayBuffer> {
  let total = CONTENT_BATCH_HEADER_BYTES;
  for (const entry of entries) {
    total += 1 + (entry === null ? 0 : 4 + entry.byteLength);
  }
  const body = new Uint8Array(total);
  for (let i = 0; i < CONTENT_BATCH_MAGIC.length; i++) body[i] = CONTENT_BATCH_MAGIC.charCodeAt(i);
  const view = new DataView(body.buffer);
  view.setUint32(CONTENT_BATCH_MAGIC.length, entries.length, true);
  let offset = CONTENT_BATCH_HEADER_BYTES;
  for (const entry of entries) {
    if (entry === null) {
      body[offset] = 1;
      offset += 1;
      continue;
    }
    body[offset] = 0;
    view.setUint32(offset + 1, entry.byteLength, true);
    body.set(entry, offset + 5);
    offset += 5 + entry.byteLength;
  }
  return body;
}

/**
 * Decode a content batch, checked against the number of hashes the request named.
 *
 * A **view** into `body` per present entry (no copy), like `parsePushBody`. Anything
 * malformed — a truncated body, a count that disagrees with the request, an unknown
 * status, a length that runs past the end, trailing bytes — is a {@link WireFormatError}:
 * a frame this client cannot read is a failed request, not "no content".
 */
export function parseContentBatchBody(
  body: Uint8Array,
  expected: number,
): Array<Uint8Array | null> {
  if (body.byteLength < CONTENT_BATCH_HEADER_BYTES) {
    throw new WireFormatError("content batch is shorter than its header");
  }
  for (let i = 0; i < CONTENT_BATCH_MAGIC.length; i++) {
    if (body[i] !== CONTENT_BATCH_MAGIC.charCodeAt(i)) {
      throw new WireFormatError("content batch has no header magic");
    }
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getUint32(CONTENT_BATCH_MAGIC.length, true);
  if (count !== expected) {
    throw new WireFormatError(`content batch names ${count} entries, asked for ${expected}`);
  }
  const entries: Array<Uint8Array | null> = [];
  let offset = CONTENT_BATCH_HEADER_BYTES;
  for (let index = 0; index < count; index++) {
    if (offset >= body.byteLength) {
      throw new WireFormatError(`content batch ends before entry ${index}`);
    }
    const status = body[offset];
    offset += 1;
    if (status === 1) {
      entries.push(null);
      continue;
    }
    if (status !== 0) {
      throw new WireFormatError(`content batch entry ${index} has status ${status}`);
    }
    if (offset + 4 > body.byteLength) {
      throw new WireFormatError(`content batch entry ${index} has no length`);
    }
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > body.byteLength) {
      throw new WireFormatError(`content batch entry ${index} runs past the end`);
    }
    entries.push(body.subarray(offset, offset + length));
    offset += length;
  }
  if (offset !== body.byteLength) {
    throw new WireFormatError(`${body.byteLength - offset} trailing bytes after the last entry`);
  }
  return entries;
}
