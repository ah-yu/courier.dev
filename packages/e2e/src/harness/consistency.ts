import { sha256Hex } from "../../../engine/src/index";

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

/**
 * The invariants every **settled** client must hold, read from its own files.
 *
 * Run after each successful `sync`/`bind`/`change`/`rename`/`removeAndSync`: a pass or
 * an event that settled leaves the state and the disk agreeing, and no path owned by two
 * live chains. A divergence here — a state that names bytes the disk does not hold, a
 * tombstone over a file, two chains on one path — is exactly the class of bug the
 * serialized engine exists to prevent, so it is worth failing the case that caused it
 * instead of the next assertion in the test.
 *
 * The check reads the state *after* the operation, so a case that writes a file without
 * reporting it (a legitimate L1 scene: L1 has no vault events) must report it before the
 * next helper call, or the helper fails the case.
 */
export async function assertClientConsistent(client: ConsistentClient): Promise<void> {
  const state = JSON.parse(client.state.json ?? "{}") as Record<string, StateEntry>;
  const live = new Map<string, string>();
  for (const [fileId, entry] of Object.entries(state)) {
    const ownsPath = client.engine.fileIdForPath(entry.plainPath) === fileId;
    if (entry.stamp === undefined) {
      // A tombstone: its recorded path may be reused by a new chain (a bind merge), so it
      // only fails while this chain still owns the path and a file is there.
      if (ownsPath && client.readBytes(entry.plainPath) !== null) {
        throw new Error(`a tombstone at ${entry.plainPath} still has a file`);
      }
      continue;
    }
    if (!ownsPath) {
      // The path was reused by another chain; that chain's own entry is checked, and the
      // map below catches two *live* chains claiming one path.
      continue;
    }
    const other = live.get(entry.plainPath);
    if (other !== undefined && other !== fileId) {
      throw new Error(`two live chains own ${entry.plainPath}: ${other} and ${fileId}`);
    }
    live.set(entry.plainPath, fileId);
    const bytes = client.readBytes(entry.plainPath);
    if (bytes === null) throw new Error(`the state names ${entry.plainPath} but no file is there`);
    if ((await sha256Hex(bytes)) !== entry.lastKnownContentHash) {
      throw new Error(`the state and the disk disagree at ${entry.plainPath}`);
    }
  }
}
