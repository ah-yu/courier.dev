import { describe, expect, it } from "vitest";
import { sortedCopy, type VersionChainEntry } from "@courier/shared";
import { RemoteIndex } from "./remote-index";

/**
 * The engine's view of what the server holds.
 *
 * Its whole job is to keep **one path, one chain**: a chain is remembered under the path
 * and content hash it lives at *now*, and whatever it was remembered under before is
 * dropped. Leaving an old pair behind is how a later local event at the old path is read
 * as a chain that still lives there — which forks a second chain, the exact failure the
 * index exists to prevent.
 */
function head(versionId: string, contentHash: string): VersionChainEntry {
  return {
    versionId,
    contentHash,
    encryptedPath: "cGF0aA==",
    action: "modify",
    sizeBytes: 1,
    mtimeMs: 1,
    createdAt: "2026-06-01T00:00:00.000Z",
  };
}

describe("RemoteIndex", () => {
  it("answers by path, by fileId and by content hash", () => {
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "notes/a.md");

    expect(index.fileIdAt("notes/a.md")).toBe("f1");
    expect(index.pathOf("f1")).toBe("notes/a.md");
    expect(index.headOf("f1")).toEqual(head("v1", "h1"));
    expect(index.fileIdForHash("h1")).toBe("f1");
    expect(index.size).toBe(1);

    expect(index.fileIdAt("notes/b.md")).toBeNull();
    expect(index.pathOf("f2")).toBeNull();
    expect(index.headOf("f2")).toBeUndefined();
    expect(index.fileIdForHash("h2")).toBeNull();
  });

  it("moves a chain to its new path, dropping the old one", () => {
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "notes/a.md");

    index.remember("f1", head("v2", "h2"), "notes/b.md");

    expect(index.fileIdAt("notes/a.md")).toBeNull();
    expect(index.fileIdAt("notes/b.md")).toBe("f1");
    expect(index.pathOf("f1")).toBe("notes/b.md");
    expect(index.headOf("f1")!.versionId).toBe("v2");
    // The superseded content hash goes too: it is no longer this chain's content, and
    // a local file that happens to hold it must not adopt this chain by content.
    expect(index.fileIdForHash("h1")).toBeNull();
    expect(index.fileIdForHash("h2")).toBe("f1");
    expect(index.size).toBe(1);
  });

  it("keeps two chains apart even when they share content", () => {
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "same"), "one.md");
    index.remember("f2", head("v1", "same"), "two.md");

    // The last writer wins the content lookup — the engine treats an ambiguous match as
    // "adopt nothing" by checking the head it got back, which is why the lookup is a
    // single map hit rather than a scan.
    expect(index.fileIdForHash("same")).toBe("f2");
    expect(index.fileIdAt("one.md")).toBe("f1");
    expect(index.fileIdAt("two.md")).toBe("f2");
    expect(index.size).toBe(2);
  });

  it("keeps another chain's content mapping when one chain moves", () => {
    // The sweep of a chain's superseded hash is scoped to that chain: dropping the
    // `knownId === fileId` half would let one move erase another chain's content lookup,
    // and a renamed file would then fork a second chain instead of being matched.
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "a.md");
    index.remember("f2", head("v1", "h2"), "b.md");

    index.remember("f1", head("v2", "h3"), "c.md");

    expect(index.fileIdForHash("h2")).toBe("f2");
    expect(index.fileIdForHash("h1")).toBeNull();
    expect(index.fileIdForHash("h3")).toBe("f1");
  });

  it("does not steal a shared content mapping from the chain that holds it", () => {
    // Two chains with identical bytes: the hash map keeps the last writer. Moving the
    // other chain must not delete a mapping that now belongs to its peer.
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "same"), "one.md");
    index.remember("f2", head("v1", "same"), "two.md");

    index.remember("f1", head("v2", "new"), "three.md");

    expect(index.fileIdForHash("same")).toBe("f2");
    expect(index.fileIdForHash("new")).toBe("f1");
  });

  it("keeps a shared content mapping when the chain that no longer owns it is forgotten", () => {
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "same"), "one.md");
    index.remember("f2", head("v1", "same"), "two.md");

    index.forget("f1");

    expect(index.fileIdForHash("same")).toBe("f2");

    index.forget("f2");

    expect(index.fileIdForHash("same")).toBeNull();
  });

  it("keeps the content mapping when the head moves on with the same bytes", () => {
    // A rename, or a version whose payload the chain already holds: the head changes,
    // the content hash does not. Dropping the mapping here would make the next move of
    // this chain look like new content and fork a second chain.
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "notes/a.md");

    index.remember("f1", head("v2", "h1"), "notes/b.md");

    expect(index.fileIdForHash("h1")).toBe("f1");
    expect(index.pathOf("f1")).toBe("notes/b.md");
  });

  it("hands a shared content mapping to the other chain when the owner moves on", () => {
    // f2 was the last chain recorded for `same`, so it owns the content lookup. When
    // f2 changes content, the mapping must go to f1 — dropping it would make a later
    // move of f1 fork a second chain.
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "same"), "one.md");
    index.remember("f2", head("v1", "same"), "two.md");

    index.remember("f2", head("v2", "new"), "two.md");

    expect(index.fileIdForHash("same")).toBe("f1");
    expect(index.fileIdForHash("new")).toBe("f2");
  });

  it("hands a shared content mapping to the other chain when the owner is forgotten", () => {
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "same"), "one.md");
    index.remember("f2", head("v1", "same"), "two.md");

    index.forget("f2");

    expect(index.fileIdForHash("same")).toBe("f1");
  });

  it("does not drop another chain's mapping at a path both chains named", () => {
    // The peer-move + new-chain-at-the-old-path window: a rebuild records X at the old
    // path and then a new chain there, so the path map belongs to the new chain. When
    // X moves away it must not delete that mapping.
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "same.md");
    index.remember("f2", head("v1", "h2"), "same.md");

    index.remember("f1", head("v2", "h1"), "new.md");

    expect(index.fileIdAt("same.md")).toBe("f2");
    expect(index.fileIdAt("new.md")).toBe("f1");
  });

  it("does not forget another chain's mapping at a path both chains named", () => {
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "same.md");
    index.remember("f2", head("v1", "h2"), "same.md");

    index.forget("f1");

    expect(index.fileIdAt("same.md")).toBe("f2");
    expect(index.size).toBe(1);
  });

  it("hands a shared content mapping to the most recently recorded chain", () => {
    // Three chains hold the same bytes. `fileIdForHash` answers with the last one recorded,
    // so forgetting it must hand the lookup to the *previous* owner — not to the first
    // chain that ever held those bytes.
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "same"), "one.md");
    index.remember("f2", head("v1", "same"), "two.md");
    index.remember("f3", head("v1", "same"), "three.md");

    expect(index.fileIdForHash("same")).toBe("f3");

    index.forget("f3");

    expect(index.fileIdForHash("same")).toBe("f2");
  });

  it("reports the paths and fileIds a pass walks", () => {
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "a.md");
    index.remember("f2", head("v2", "h2"), "b.md");

    expect(sortedCopy(index.paths())).toEqual(["a.md", "b.md"]);
    expect(sortedCopy(index.fileIds())).toEqual(["f1", "f2"]);
  });

  it("forgets a deleted chain's path, head and content", () => {
    // A chain whose deletion was applied still exists on the server, but it lives at no
    // path: keeping the previous *live* head here is what made a file written at that
    // path adopt the dead chain — and turn a restored copy into a conflict with the
    // deletion that had just been applied.
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "notes/a.md");
    index.remember("f2", head("v1", "h2"), "notes/b.md");

    index.forget("f1");

    expect(index.fileIdAt("notes/a.md")).toBeNull();
    expect(index.pathOf("f1")).toBeNull();
    expect(index.headOf("f1")).toBeUndefined();
    expect(index.fileIdForHash("h1")).toBeNull();
    // Another chain is untouched.
    expect(index.fileIdAt("notes/b.md")).toBe("f2");
    expect(index.fileIdForHash("h2")).toBe("f2");
    expect(index.size).toBe(1);
  });

  it("forgets a chain that is not in the index without touching the others", () => {
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "notes/a.md");

    index.forget("f2");

    expect(index.fileIdAt("notes/a.md")).toBe("f1");
    expect(index.size).toBe(1);
  });

  it("forgets everything when a pass rebuilds it", () => {
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "h1"), "a.md");

    index.clear();

    expect(index.size).toBe(0);
    expect(index.fileIdAt("a.md")).toBeNull();
    expect(index.headOf("f1")).toBeUndefined();
    expect(index.fileIdForHash("h1")).toBeNull();
  });

  it("clears the shared-content bookkeeping too", () => {
    // After `clear`, a hash recorded by the old chain must not keep a second chain's
    // lookup alive when that second chain is forgotten.
    const index = new RemoteIndex();
    index.remember("f1", head("v1", "same"), "one.md");

    index.clear();
    index.remember("f2", head("v1", "same"), "two.md");
    index.forget("f2");

    expect(index.fileIdForHash("same")).toBeNull();
    expect(index.size).toBe(0);
  });

  it("keeps the head the server stamped latest at a path two chains name", () => {
    const index = new RemoteIndex();
    const older = { ...head("v1", "h1"), createdAt: "2020-01-01T00:00:00.000Z" };
    const newer = { ...head("v2", "h2"), createdAt: "2027-01-01T00:00:00.000Z" };
    index.remember("older", older, "notes/a.md");
    index.remember("newer", newer, "notes/a.md");

    // `fileIdAt` answers the last one recorded; `newestAt` answers the authority the
    // owner rule reads.
    expect(index.fileIdAt("notes/a.md")).toBe("newer");
    expect(index.newestAt("notes/a.md")).toEqual({ fileId: "newer", head: newer });

    // Recording the older chain last must not hand it the path.
    index.remember("older", older, "notes/a.md");
    expect(index.newestAt("notes/a.md")?.fileId).toBe("newer");
  });

  it("breaks a same-millisecond tie by fileId, and falls back when the newest is forgotten", () => {
    const index = new RemoteIndex();
    index.remember("b", head("v1", "h1"), "notes/a.md");
    index.remember("a", head("v2", "h2"), "notes/a.md");

    expect(index.newestAt("notes/a.md")?.fileId).toBe("a");

    // Forgetting the newest chain must not answer "nobody owns this path": the other chain
    // naming it is still live, and a notification for it has to see the real owner.
    index.forget("a");
    expect(index.newestAt("notes/a.md")?.fileId).toBe("b");
  });
});
