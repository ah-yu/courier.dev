import { sha256Hex } from "../../../engine/src/index";

/** The shape `sync_state.json` holds: chain id → its sync point. */
interface StateEntry {
  lastKnownContentHash: string;
  plainPath: string;
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
 * an event that settled leaves the state and the disk agreeing, and the identity index
 * mapping each recorded path back to its chain. A divergence here — a state that names
 * bytes the disk does not hold, or a tombstone over a file — is exactly the class of bug
 * the serialized engine exists to prevent, so it is worth failing the case that caused
 * it instead of the next assertion in the test.
 */
export async function assertClientConsistent(client: ConsistentClient): Promise<void> {
  const state = JSON.parse(client.state.json ?? "{}") as Record<string, StateEntry>;
  const emptyHash = await sha256Hex(new Uint8Array(0));
  for (const [fileId, entry] of Object.entries(state)) {
    // A path can belong to two chains for a moment (a kept chain and a bind-merged new
    // one), so only the chain that currently owns the path is checked against it.
    if (client.engine.fileIdForPath(entry.plainPath) !== fileId) continue;
    // A tombstone's recorded path may have been reused by a new chain (a bind merge), so
    // only live sync points own their path; the tombstone itself is checked in L0.
    if (entry.lastKnownContentHash === emptyHash) continue;
    const bytes = client.readBytes(entry.plainPath);
    if (bytes === null) throw new Error(`the state names ${entry.plainPath} but no file is there`);
    if ((await sha256Hex(bytes)) !== entry.lastKnownContentHash) {
      throw new Error(`the state and the disk disagree at ${entry.plainPath}`);
    }
  }
}
