/**
 * The binary framing specs.
 *
 * JSON Schema cannot describe a body whose header is JSON and whose payload is raw
 * ciphertext, so these three frames are explicit descriptors instead of Zod schemas.
 * They are built from the same constants the parsers use, and the surface records them:
 * both sides must agree on a binary layout exactly, so any change moves every contract
 * number.
 */
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
  CONTENT_BATCH_HEADER_BYTES,
  CONTENT_BATCH_MAGIC,
  MAX_CONTENT_BATCH_BYTES,
  MAX_CONTENT_BATCH_FILES,
  MAX_PUSH_HEADER_BYTES,
  PUSH_HEADER_LENGTH_BYTES,
} from "../wire";
import { PushBodyHeaderSchema } from "./http";

/** `POST …/sync/push`: a uint32 header length, the header JSON, then every payload. */
export const PUSH_BODY_SPEC = {
  headerLengthBytes: PUSH_HEADER_LENGTH_BYTES,
  maxHeaderBytes: MAX_PUSH_HEADER_BYTES,
  header: PushBodyHeaderSchema,
  content: "per-file ciphertext, in header order, each contentLength bytes",
} as const;

/** `POST …/sync/contents`: a magic, a count, then the ciphertext of each requested hash. */
export const CONTENT_BATCH_SPEC = {
  magic: CONTENT_BATCH_MAGIC,
  headerBytes: CONTENT_BATCH_HEADER_BYTES,
  maxFiles: MAX_CONTENT_BATCH_FILES,
  maxBytes: MAX_CONTENT_BATCH_BYTES,
} as const;

/** The on-disk blob envelope and its chunk framing. */
export const BLOB_SPEC = {
  magic: BLOB_MAGIC,
  headerBytes: BLOB_HEADER_BYTES,
  chunkPlaintextBytes: CHUNK_PLAINTEXT_BYTES,
  chunkStoredBytes: CHUNK_STORED_BYTES,
  chunkedTransferThreshold: CHUNKED_TRANSFER_THRESHOLD,
  maxChunks: MAX_CHUNKS,
  chunkAadFlag: BLOB_FLAG_CHUNK_AAD,
} as const;
