import {
  CHUNKED_TRANSFER_THRESHOLD,
  WireFormatError,
  chunkCountFor,
  parsePushBody,
  type PushBody,
} from "@courier/shared";
import { PushBodySchema } from "@courier/shared/wire";
import { config } from "../config";
import { PayloadTooLargeError, ValidationError } from "../lib/errors";
import { validationDetails } from "../lib/validator";
import type { RouteRequest } from "./router";

/**
 * Read and validate one push body.
 *
 * The body is the binary frame from `@courier/shared`'s `wire.ts`: a JSON header and the
 * raw ciphertext of every file, in header order. Reading it is bounded on purpose,
 * before and after buffering. The frame parser checks the structure; the shared schema
 * checks the contract (id lengths, the action enum, the batch cap, the label's length)
 * and the cross-field rules the per-entry schema cannot express.
 */
export async function readPushBody(request: RouteRequest): Promise<PushBody> {
  const limit = config.SYNC_MAX_PUSH_BYTES;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) {
    throw new PayloadTooLargeError(`push body exceeds ${limit} bytes`);
  }
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > limit) {
    throw new PayloadTooLargeError(`push body exceeds ${limit} bytes`);
  }

  let parsedBody: PushBody;
  try {
    parsedBody = parsePushBody(body);
  } catch (err) {
    if (err instanceof WireFormatError) {
      throw new ValidationError("Validation failed", [{ field: "body", message: err.message }]);
    }
    throw err;
  }

  const parsed = PushBodySchema.safeParse(parsedBody);
  if (!parsed.success) {
    throw new ValidationError("Validation failed", validationDetails(parsed.error.issues));
  }

  // Cross-field rules: a version travels either as a whole payload or as staged chunks,
  // and the size decides which.
  for (const file of parsedBody.files) {
    const chunks = file.contentChunks ?? 0;
    if (file.content !== null && chunks > 0) {
      throw new ValidationError("Validation failed", [
        { field: "contentChunks", message: "a push carries either content or chunks, not both" },
      ]);
    }
    if (chunks > 0) {
      if (file.sizeBytes <= CHUNKED_TRANSFER_THRESHOLD) {
        throw new ValidationError("Validation failed", [
          { field: "contentChunks", message: "chunked uploads are only for payloads above 8 MiB" },
        ]);
      }
      if (chunks !== chunkCountFor(file.sizeBytes)) {
        throw new ValidationError("Validation failed", [
          { field: "contentChunks", message: "chunkCount does not match sizeBytes" },
        ]);
      }
    } else if (file.content !== null && file.sizeBytes > CHUNKED_TRANSFER_THRESHOLD) {
      throw new ValidationError("Validation failed", [
        { field: "content", message: "a payload above 8 MiB must be uploaded in chunks" },
      ]);
    }
  }

  return parsedBody;
}
