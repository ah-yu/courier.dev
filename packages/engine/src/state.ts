import type { FileStamp } from "./adapter";

/**
 * Per-file last-known sync state, keyed by fileId: `lastKnownVersionId` /
 * `lastKnownContentHash` describe the history point both sides last agreed on;
 * `plainPath` is the current local path.
 */
export interface LocalVersionState {
  [fileId: string]: {
    lastKnownVersionId: string | null;
    lastKnownContentHash: string | null;
    plainPath: string;
    /**
     * Size and modification time of the file **when `lastKnownContentHash` was
     * taken from it**.
     *
     * This is what lets a pass skip reading a file it has already hashed: same size,
     * same timestamp, same content as far as this device is concerned. It is recorded
     * only together with the hash of the bytes that were on disk at that stamp, so a
     * pass can never trust a hash for content that has since changed. Absent (an older
     * state, an adapter that could not stat the file) simply costs one re-read.
     */
    stamp?: FileStamp;
    /**
     * When this device decided on the deletion, while the tombstone has not been
     * accepted yet (milliseconds since the epoch).
     *
     * A tombstone has no file to stamp, and its `mtimeMs` is what a peer compares with
     * its own file's modification time to settle a config-folder conflict. Recording
     * the moment here — rather than reading the clock again when the push is retried
     * — keeps a deletion made offline from later claiming to be newer than an edit the
     * peer made after it. Cleared as soon as the server accepts the tombstone (the
     * sync point is then rewritten to the delete version).
     */
    deletedAtMs?: number;
  };
}
