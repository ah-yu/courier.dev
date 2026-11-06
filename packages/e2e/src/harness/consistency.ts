import { sha256Hex } from "../../../engine/src/index";

/**
 * The invariants every **settled** client must hold, read from its own files.
 *
 * Run after each successful `sync`/`bind`/`change`/`rename`/`removeAndSync`/`remotePushed`:
 * a pass or an event that settled leaves the state and the disk agreeing, and no path
 * owned by two live chains. A divergence here — a state that names bytes the disk does
 * not hold, a tombstone over a file, two chains on one path — is exactly the class of bug
 * the serialized engine exists to prevent, so it is worth failing the case that caused it
 * instead of the next assertion in the test.
 *
 * A **tombstone** is a sync point with the empty content hash *and* no `stamp` (a delete
 * version has no file to stamp); a live entry may legitimately lack a stamp (an adopted
 * version, a file the adapter could not stat), so `stamp` alone cannot classify it.
 *
 * The check reads the state *after* the operation, so a case that writes a file without
 * reporting it (a legitimate L1 scene: L1 has no vault events) must report it before the
 * next helper call, or the helper fails the case.
 */
export async function assertClientConsistent(client: ConsistentClient): Promise<void> {
  const state = JSON.parse(client.state.json ?? "{}") as Record<string, StateEntry>;
  const emptyHash = await sha256Hex(new Uint8Array(0));
  const livePaths = new Map<string, string>();
  for (const [fileId, entry] of Object.entries(state)) {
    const tombstone = entry.stamp === undefined && entry.lastKnownContentHash === emptyHash;
    if (!tombstone) {
      const other = livePaths.get(entry.plainPath);
      if (other !== undefined && other !== fileId) {
        throw new Error(`two live chains own ${entry.plainPath}: ${other} and ${fileId}`);
      }
      livePaths.set(entry.plainPath, fileId);
    }
    const ownsPath = client.engine.fileIdForPath(entry.plainPath) === fileId;
    if (tombstone) {
      // Its recorded path may be reused by a new chain (a bind merge), so a tombstone only
      // fails while this chain still owns the path and a file is there.
      if (ownsPath && client.readBytes(entry.plainPath) !== null) {
        throw new Error(`a tombstone at ${entry.plainPath} still has a file`);
      }
      continue;
    }
    if (!ownsPath) continue; // the path was reused by another chain; its entry is checked
    const bytes = client.readBytes(entry.plainPath);
    if (bytes === null) throw new Error(`the state names ${entry.plainPath} but no file is there`);
    if ((await sha256Hex(bytes)) !== entry.lastKnownContentHash) {
      throw new Error(`the state and the disk disagree at ${entry.plainPath}`);
    }
  }
}

/** The shape `sync_state.json` holds: chain id → its sync point. */
interface StateEntry {
  lastKnownContentHash: string;
  plainPath: string;
  /** Absent on a tombstone: a delete sync point has no file to stamp (see `state.ts`). */
  stamp?: unknown;
}

/** The client surface the check needs; `TestClient` satisfies it. */
interface ConsistentClient {
  state: { json: string | null };
  readBytes(path: string): Uint8Array | null;
  engine: { fileIdForPath(path: string): string | null };
}
