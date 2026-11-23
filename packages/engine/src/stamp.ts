import type { FileStamp } from "./adapter";

/**
 * Whether two stamps describe the same file state, as far as a recorded hash may be trusted.
 *
 * The size and the modification time are the whole test: the engine records a hash only
 * together with the stamp it was taken at, and every reuse compares exactly those two
 * fields — a pass's cached hash, a pre-fetched read, the upload cap's "has this file
 * changed since this device synced it?" question, and whether a file that appeared at
 * another path is the file a deletion recorded (`SelfEventLog.matchDeletedFile`). One
 * predicate keeps those sites from drifting on which fields count (a size-only comparison
 * would trust an edit that kept the length; a time-only one would trust a rewritten file
 * written inside the same tick). A stamp missing on either side proves nothing.
 *
 * Local to the engine on purpose: it encodes nothing a host decides with, so it stays off
 * the package surface (`index.ts` wildcard-exports `state.ts` and `adapter.ts`, where it
 * must not land).
 */
export function sameStamp(
  a: FileStamp | null | undefined,
  b: FileStamp | null | undefined,
): boolean {
  if (!a || !b) return false;
  return a.sizeBytes === b.sizeBytes && a.mtimeMs === b.mtimeMs;
}
