import type { ApiErrorCode } from "@courier/shared";

/** The statuses this service answers with; `number` because nothing maps it to Hono. */
type ContentfulStatusCode = number;

/**
 * The server's error hierarchy.
 *
 * `code` is `ApiErrorCode` (`@courier/shared`), so a code a client matches on is
 * a type rather than a string that happens to be spelled the same in four files,
 * and `statusCode` is Hono's `ContentfulStatusCode`, which removes the cast the
 * handler used to need to hand it back to `c.json`.
 */
export class AppError extends Error {
  constructor(
    public statusCode: ContentfulStatusCode,
    public code: ApiErrorCode,
    message: string,
    /** Extra response headers the error requires (e.g. `Content-Range` on a 416). */
    public headers?: Record<string, string>,
    /** Extra fields the body carries beyond `error` and `message` (a contract refusal). */
    public extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Invalid or missing token") {
    super(401, "UNAUTHORIZED", message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(404, "NOT_FOUND", `${resource} not found`);
  }
}

export class ValidationError extends AppError {
  details?: Array<{ field: string; message: string }>;

  constructor(message: string, details?: Array<{ field: string; message: string }>) {
    super(422, "VALIDATION_ERROR", message);
    this.details = details;
  }
}

/**
 * A request refused by a rate limiter.
 *
 * `Retry-After` is part of the answer, not decoration: a client that binds a large
 * vault waits out the window instead of failing the pass (see
 * `docs/first-bind-performance.md`), and a standard header is what lets it wait the
 * remaining time rather than guess.
 */
export class RateLimitError extends AppError {
  constructor(message = "Too many requests. Please try again later.", retryAfterSeconds?: number) {
    super(
      429,
      "RATE_LIMITED",
      message,
      retryAfterSeconds === undefined
        ? undefined
        : { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
    );
  }
}

/** The user key has expired (or was revoked). */
export class KeyExpiredError extends AppError {
  constructor(message = "User key has expired") {
    super(403, "KEY_EXPIRED", message);
  }
}

/**
 * The host disabled the account: the key, its vaults and their data are all still
 * there, but the key authenticates nothing until it is enabled again.
 *
 * A code of its own rather than `KEY_EXPIRED`, because the two answers differ in what
 * a client should do: an expired key needs a renewal from the host, a disabled one is
 * a pause the same key resumes from.
 */
export class KeyDisabledError extends AppError {
  constructor(message = "User key is disabled") {
    super(403, "KEY_DISABLED", message);
  }
}

/** The host key authenticated, but does not carry the scope this route needs. */
export class InsufficientScopeError extends AppError {
  constructor(scope: string) {
    super(403, "INSUFFICIENT_SCOPE", `This API key does not carry the "${scope}" scope`);
  }
}

/** The user's storage quota would be exceeded. */
export class QuotaExceededError extends AppError {
  constructor(message = "Storage quota exceeded") {
    super(413, "QUOTA_EXCEEDED", message);
  }
}

/** The account already owns as many vaults as its key allows. */
export class VaultLimitReachedError extends AppError {
  constructor(message = "This user key cannot own another vault") {
    super(409, "VAULT_LIMIT_REACHED", message);
  }
}

/** A request body larger than the route accepts (see `SYNC_MAX_PUSH_BYTES`). */
export class PayloadTooLargeError extends AppError {
  constructor(message = "Request body is too large") {
    super(413, "PAYLOAD_TOO_LARGE", message);
  }
}

/**
 * The `Range` header cannot select any byte of the representation (`RFC 9110` §14.4).
 *
 * `Content-Range: bytes *\/<size>` is required on the response, so the client can tell
 * "past the end" from a size it got wrong; the header rides on the error rather than the
 * route building the body by hand.
 */
export class RangeNotSatisfiableError extends AppError {
  constructor(size: number) {
    super(416, "RANGE_NOT_SATISFIABLE", "Range is not satisfiable", {
      "Content-Range": `bytes */${size}`,
    });
  }
}

/**
 * The client and this server speak different contract generations.
 *
 * `426 Upgrade Required` rather than `400`: the request is well formed, the two sides are
 * simply not the same interface. The body carries both numbers and the server's release
 * version, so a caller that never asked `/api/health` can still render which side is old.
 *
 * A client is refused **before** its key is even read: the key may be perfectly good, and
 * "upgrade the server" is a different answer from "your credential is wrong".
 */
export class ContractMismatchError extends AppError {
  constructor(
    message: string,
    extra: {
      serverContract: number;
      minClient: number;
      clientContract: number;
      serverVersion: string;
    },
  ) {
    super(426, "CONTRACT_MISMATCH", message, undefined, extra);
  }
}

/**
 * The one error handler, as Hono's `onError` calls it.
 *
 * The logger is a parameter for the same reason `createApp` takes one: an app
 * built in a test must record its errors, not write them to the real stderr. It
 * defaults to the process-wide one so a direct call still works.
 */
