import { sha256Hex } from "../../../engine/src/index";

/**
 * The invariants every **settled** client must hold, read from its own files.
 *
 * Run after each successful `sync`/`bind`/`change`/`rename`/`removeAndSync`/`syncSettings`:
 * a pass or an event that settled leaves the state and the disk agreeing, and no path
 * owned by two live chains. A divergence here is exactly the class of bug the serialized
 * engine exists to prevent, so it is worth failing the case that caused it instead of the
 * next assertion in the test.
 *
 * The check reads the state *after* the operation, so a case that writes a file without
 * reporting it (a legitimate L1 scene: L1 has no vault events) must report it before the
 * next helper call, or the helper fails the case.
 *
 * **Empty-hash entries are skipped.** The empty content hash is both a tombstone's sync
 * point and a live empty file's, and the state records no chain action to tell them
 * apart, so the check skips them; the L0 matrix has the chain action and checks both a
 * tombstone and a live empty file. A live
 * entry whose path was reused by a new chain is likewise skipped: the new chain's own
 * entry is checked, and the map below catches two live owners. An entry whose path this
 * device's scope does not sync is skipped too: the engine deliberately leaves it alone.
 */
export async function assertClientConsistent(client: ConsistentClient): Promise<void> {
  const state = JSON.parse(client.state.json ?? "{}") as Record<string, StateEntry>;
  const emptyHash = await sha256Hex(new Uint8Array(0));
  const livePaths = new Map<string, string>();
  for (const [fileId, entry] of Object.entries(state)) {
    if (!client.isSyncable(entry.plainPath)) continue;
    if (entry.lastKnownContentHash === emptyHash) continue;
    const other = livePaths.get(entry.plainPath);
    if (other !== undefined && other !== fileId) {
      throw new Error(`two live chains own ${entry.plainPath}: ${other} and ${fileId}`);
    }
    livePaths.set(entry.plainPath, fileId);
    if (client.engine.fileIdForPath(entry.plainPath) !== fileId) continue;
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
  stamp?: unknown;
}

/** The client surface the check needs; `TestClient` satisfies it. */
interface ConsistentClient {
  state: { json: string | null };
  readBytes(path: string): Uint8Array | null;
  engine: { fileIdForPath(path: string): string | null };
  isSyncable(path: string): boolean;
}
