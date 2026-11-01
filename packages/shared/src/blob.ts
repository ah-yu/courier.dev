/**
 * The stored blob format, version 2.
 *
 * A blob is the ciphertext of one file, addressed by the SHA-256 of its **plaintext**
 * (the content hash on the version row). The store frames it as:
 *
 * ```
 * "CBR2" | u32 flags | u32 chunkSize | u32 chunkCount | u64 plaintextSize | chunks…
 * ```
 *
 * `flags` says how the chunks were encrypted:
 *
 * - `0` — one whole-file AES-256-GCM payload (`iv‖ct‖tag`) as the single chunk. That is
 *   what a small push sends; the server wraps it as it stores it.
 * - `1` — every chunk is its own AES-256-GCM payload, and its additional data binds it
 *   to the content hash, its index, the chunk count and the plaintext size, so a chunk
 *   cannot be reordered, truncated or moved to another file.
 *
 * The header is a **storage** detail: it never crosses the wire. The content route
 * serves the chunk bytes only, and a client knows the chunk size and the plaintext size
 * from the version row (see `docs/api.md`).
 *
 * Everything is little-endian. `chunkCount` is bounded so a hostile header cannot make
 * the server allocate or scan something absurd, and `plaintextSize` is a safe integer
 * (a blob larger than 2^53 bytes cannot be represented by the version row either).
 */

/** Magic that opens every stored blob. */
export const BLOB_MAGIC = "CBR2";

/** Bytes of the fixed header that precedes the chunks. */
export const BLOB_HEADER_BYTES = 24;

/** Longest plaintext one chunk may hold (4 MiB), for chunked blobs. */
export const CHUNK_PLAINTEXT_BYTES = 4 * 1024 * 1024;

/** Bytes one full chunk occupies in the store: `iv(12) + ciphertext + tag(16)`. */
export const CHUNK_STORED_BYTES = CHUNK_PLAINTEXT_BYTES + 28;

/**
 * Largest plaintext a push may carry in one request; above it the client stages chunks.
 *
 * This is a **protocol** bound, not a tuning knob: a version's framing is inferred from
 * its `sizeBytes` (chunked above, whole-file at or below), so the client that writes and
 * the peer that reads have to agree on it. The server rejects a content payload above it
 * and a chunked push at or below it, which keeps a blob's layout a pure function of its
 * size.
 */
export const CHUNKED_TRANSFER_THRESHOLD = 8 * 1024 * 1024;

/** Whether a version of `plaintextSize` bytes must travel in chunks. */
export function shouldTransferInChunks(plaintextSize: number): boolean {
  return plaintextSize > CHUNKED_TRANSFER_THRESHOLD;
}

/** A bound on `chunkCount`, so a header cannot describe an impossible blob. */
export const MAX_CHUNKS = 1_048_576;

/** The `flags` bit that says each chunk carries the additional data described above. */
export const BLOB_FLAG_CHUNK_AAD = 1;

/** The header of a stored blob. */
export interface BlobHeader {
  flags: number;
  /** Plaintext bytes per chunk; `0` for a whole-file blob (flags 0). */
  chunkSize: number;
  chunkCount: number;
  plaintextSize: number;
}

/** Encode a header into the 24 bytes a blob starts with. */
export function encodeBlobHeader(header: BlobHeader): Uint8Array {
  const bytes = new Uint8Array(BLOB_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < BLOB_MAGIC.length; i++) bytes[i] = BLOB_MAGIC.charCodeAt(i);
  view.setUint32(4, header.flags, true);
  view.setUint32(8, header.chunkSize, true);
  view.setUint32(12, header.chunkCount, true);
  view.setBigUint64(16, BigInt(header.plaintextSize), true);
  return bytes;
}

/**
 * Parse a header, or answer `null` when the bytes are not a header this store wrote.
 *
 * Only the structure is checked here (magic, length, bounds); whether the fields agree
 * with a version row is the caller's decision, because only the caller knows what it
 * expected.
 */
export function parseBlobHeader(bytes: Uint8Array): BlobHeader | null {
  if (bytes.byteLength < BLOB_HEADER_BYTES) return null;
  for (let i = 0; i < BLOB_MAGIC.length; i++) {
    if (bytes[i] !== BLOB_MAGIC.charCodeAt(i)) return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const flags = view.getUint32(4, true);
  const chunkSize = view.getUint32(8, true);
  const chunkCount = view.getUint32(12, true);
  const plaintextSizeBig = view.getBigUint64(16, true);
  if (plaintextSizeBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const plaintextSize = Number(plaintextSizeBig);
  if (chunkCount > MAX_CHUNKS) return null;
  // Only the two layouts this store writes are understood; an unknown flag is not a
  // blob a reader could decrypt, so it is not a header either.
  if (flags !== 0 && flags !== 1) return null;
  // A whole-file blob is exactly one chunk (an empty file still has one 28-byte
  // payload), and a chunked blob cannot claim zero chunks unless it is empty.
  if (flags === 0 && chunkCount !== 1) return null;
  if (flags === 1 && chunkCount !== chunkCountFor(plaintextSize)) return null;
  return { flags, chunkSize, chunkCount, plaintextSize };
}

/** How many chunks a plaintext of `plaintextSize` bytes occupies at `chunkSize`. */
export function chunkCountFor(
  plaintextSize: number,
  chunkSize: number = CHUNK_PLAINTEXT_BYTES,
): number {
  if (plaintextSize <= 0) return 0;
  return Math.ceil(plaintextSize / chunkSize);
}

/**
 * Stored bytes of one chunk: 28 bytes of IV and tag on top of the plaintext, with the
 * last chunk shorter (or empty for a blob with no chunks).
 */
export function storedChunkBytes(
  index: number,
  plaintextSize: number,
  chunkSize: number = CHUNK_PLAINTEXT_BYTES,
): number {
  const count = chunkCountFor(plaintextSize, chunkSize);
  if (index < 0 || index >= count) return 0;
  const last = index === count - 1;
  const plaintext = last ? plaintextSize - index * chunkSize : chunkSize;
  return plaintext + 28;
}

/** Total stored bytes of the chunk region (without the header). */
export function storedChunkRegionBytes(
  plaintextSize: number,
  chunkSize: number = CHUNK_PLAINTEXT_BYTES,
): number {
  return plaintextSize + 28 * chunkCountFor(plaintextSize, chunkSize);
}

/**
 * The additional data a chunked blob's AEAD binds to its chunk.
 *
 * `contentHash(32 raw) ‖ u32 index ‖ u32 chunkCount ‖ u64 plaintextSize`. It makes a
 * chunk useless anywhere but its own place: reordering two chunks, truncating the blob,
 * or moving a chunk to another file all fail authentication. Both the encrypting client
 * and the decrypting one build it from values they already have (the version row's hash
 * and size, the chunk index), so it never travels separately.
 */
export function chunkAdditionalData(
  contentHash: string,
  index: number,
  chunkCount: number,
  plaintextSize: number,
): Uint8Array<ArrayBuffer> {
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    throw new Error("chunkAdditionalData needs a 64-character lowercase hex content hash");
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("chunkAdditionalData needs a non-negative chunk index");
  }
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 1) {
    throw new Error("chunkAdditionalData needs a positive chunk count");
  }
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw new Error("chunkAdditionalData needs a non-negative plaintext size");
  }
  const bytes = new Uint8Array(48);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(contentHash.slice(i * 2, i * 2 + 2), 16);
  const view = new DataView(bytes.buffer);
  view.setUint32(32, index, true);
  view.setUint32(36, chunkCount, true);
  view.setBigUint64(40, BigInt(plaintextSize), true);
  return bytes;
}
