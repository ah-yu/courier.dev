/**
 * The error codes the API answers with, in one place.
 *
 * They are part of the contract (`docs/api.md` §Error code list): clients match on
 * them, so a code is a type rather than a string that happens to be spelled the
 * same in four files. `UNKNOWN_ERROR` is the one code a **client** invents, for a
 * failure body it cannot read at all (a proxy error page, an empty 502).
 */
export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "KEY_EXPIRED",
  "KEY_DISABLED",
  "INSUFFICIENT_SCOPE",
  "CONTRACT_MISMATCH",
  "RATE_LIMITED",
  "QUOTA_EXCEEDED",
  "VAULT_LIMIT_REACHED",
  "PAYLOAD_TOO_LARGE",
  "RANGE_NOT_SATISFIABLE",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number] | "UNKNOWN_ERROR";

/** The body of every failed request. */
export interface ApiError {
  error: ApiErrorCode;
  message: string;
  details?: Array<{
    field: string;
    message: string;
  }>;
}

/**
 * The body of a `426 CONTRACT_MISMATCH`: the base error plus the two generation
 * windows and the server's release version, so a caller that skipped `/api/health`
 * can still tell which side has to move.
 */
export interface ContractMismatchErrorBody {
  error: "CONTRACT_MISMATCH";
  message: string;
  serverContract: number;
  minClient: number;
  clientContract: number;
  serverVersion: string;
}
