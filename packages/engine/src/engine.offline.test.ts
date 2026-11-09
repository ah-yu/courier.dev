import {
  FakeAdapter,
  FakeApi,
  SyncEngine,
  conflictFilePath,
  decryptString,
  deriveEncryptionKey,
  describe,
  encoder,
  encryptString,
  expect,
  freezeConflictClock,
  holdFirstPush,
  it,
  makeEngine,
  pushFromPeerMidFlight,
  rateLimited,
  realPlatform,
  sortedCopy,
  syncPointOf,
  syncedFileId,
} from "./engine.test-helpers";
import type { ConflictResolvedEvent, SyncAction } from "./engine.test-helpers";

freezeConflictClock();

/**
 * The connection can be gone while the user keeps working. Every push fails, the
 * engine keeps no queue, and the vault websocket delivers no backlog on
 * `subscribe` — so the next full reconcile (a reconnect, the host's periodic
 * pass, a restart) is the only thing that carries those changes to the server.
 * These are the shapes that pass has to get right, each of them a way the old
 * behaviour either lost a local change or undid it.
 */
describe("SyncEngine — changes made while the connection is down", () => {
  it("pushes the tombstone for a delete whose push failed, instead of pulling it back", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // The user deletes the note while the server is unreachable.
    api.offline = true;
    adapter.files.delete("n.md");
    await expect(engine.handleLocalDelete("n.md")).rejects.toThrow();

    api.offline = false;
    await engine.initialSync();

    // The deletion is real and the server has to hear about it — not read it as
    // "a remote file this device is missing" and hand the note back.
    expect(adapter.files.has("n.md")).toBe(false);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("pushes a pass's tombstones in one request", async () => {
    // The files disappear with nothing watching — the app was closed, or the host never
    // saw the delete — so the pass discovers them. Each tombstone used to be its own
    // request: a thousand files deleted that way is a thousand requests against the
    // deployed allowance, and the peers see the deletion arrive over minutes.
    const { engine, adapter, api } = await makeEngine();
    const paths = ["a.md", "b.md", "c.md"];
    for (const path of paths) adapter.files.set(path, encoder.encode(path));
    await engine.initialSync();
    api.pushCalls.length = 0;

    for (const path of paths) adapter.files.delete(path);
    await engine.initialSync();

    expect(api.pushCalls).toEqual([paths.length]);
    expect(api.pushed.filter((p) => p.action === "delete")).toHaveLength(paths.length);
    for (const path of paths) expect(adapter.files.has(path)).toBe(false);
  });

  it("sends a pass's tombstones 100 per request", async () => {
    // The server's own cap, the same bound the create batch uses.
    const { engine, adapter, api } = await makeEngine();
    const paths = Array.from({ length: 101 }, (_, index) => `notes/${index}.md`);
    for (const path of paths) adapter.files.set(path, encoder.encode(path));
    await engine.initialSync();
    api.pushCalls.length = 0;

    for (const path of paths) adapter.files.delete(path);
    await engine.initialSync();

    expect(api.pushCalls).toEqual([100, 1]);
    expect(api.pushed.filter((p) => p.action === "delete")).toHaveLength(paths.length);
  });

  it("leaves a rate-limited tombstone batch for the next pass", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // The limiter outlasts the pass's waits: nothing landed, so the state entry has to
    // survive and the next pass has to retry the tombstone — in a batch, not one request.
    const realPush = api.push.bind(api);
    let limited = true;
    api.push = async (vaultId, files) => {
      if (limited && files.some((file) => file.action === "delete")) throw rateLimited();
      return await realPush(vaultId, files);
    };

    adapter.files.delete("a.md");
    await expect(engine.initialSync()).rejects.toMatchObject({ status: 429 });
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);

    limited = false;
    await engine.initialSync();
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("reports a refused tombstone and retries it on the next pass", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // A refusal a wait cannot fix (a quota, say): the pass reports it, and the state
    // entry stays so the next pass decides the same tombstone again.
    const realPush = api.push.bind(api);
    let refuse = true;
    api.push = async (vaultId, files) => {
      if (refuse && files.some((file) => file.action === "delete")) {
        refuse = false;
        return {
          results: files.map((file) => ({
            fileId: file.fileId,
            status: "error" as const,
            error: "quota exceeded",
          })),
        };
      }
      return await realPush(vaultId, files);
    };

    adapter.files.delete("a.md");
    await expect(engine.initialSync()).rejects.toThrow("quota exceeded");
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);

    await engine.initialSync();
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("resolves a tombstone a peer's edit refused during a pass", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // The user deletes it while the connection is down; the tombstone never lands.
    api.offline = true;
    adapter.files.delete("n.md");
    await expect(engine.handleLocalDelete("n.md")).rejects.toThrow("network down");
    api.offline = false;

    // The pass decides from a chain whose head is still this device's sync point, so it
    // pushes the tombstone — and a peer edit lands between the decision and the request,
    // which is a deletion racing an edit. That refusal is the case this branch exists
    // for: it has to resolve as the peer's version coming back, not be dropped into
    // `firstFailure` and forgotten until the next pass.
    const sent: string[][] = [];
    const realPush = api.push.bind(api);
    api.push = async (vaultId, files) => {
      sent.push(files.map((file) => file.fileId));
      return await realPush(vaultId, files);
    };
    api.onPush = async (files) => {
      api.onPush = null;
      for (const file of files) await api.remoteEdit(file.fileId, "peer-rushed");
    };
    await engine.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("peer-rushed");
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    // The refusal is settled from the chain the server answered with, not by re-sending
    // the base it just refused: one request, not two.
    expect(sent).toEqual([[fileId]]);
  });

  it("keeps the rest of a tombstone batch when one conflict cannot be applied", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    await engine.initialSync();
    const aId = engine.fileIdForPath("a.md")!;
    const bId = engine.fileIdForPath("b.md")!;

    // A peer edits `a.md` while the batch is on the wire, so its tombstone is refused; the
    // peer's version then cannot be written (the disk refuses). `b.md` travelled in the
    // same request and its answer is `ok`: one failed conflict must not leave that answer
    // unapplied — the next pass would read the chain as a deletion this device never made
    // and a file written there later would become a new chain instead of a restore.
    api.onPush = async (files) => {
      if (!files.some((file) => file.fileId === aId)) return;
      api.onPush = null;
      await api.remoteEdit(aId, "peer-rushed");
    };
    const write = adapter.writeFile.bind(adapter);
    adapter.writeFile = async (path, bytes) => {
      if (path === "a.md") throw new Error("disk full");
      return await write(path, bytes);
    };

    adapter.files.delete("a.md");
    adapter.files.delete("b.md");
    await expect(engine.initialSync()).rejects.toThrow("disk full");

    expect(api.chains.get(bId)!.at(-1)!.action).toBe("delete");
    // A tombstone keeps the path mapped to its chain, so a file written there later is a
    // recreate — the identity that a missing `applyPushedVersion` would have lost.
    expect(engine.fileIdForPath("b.md")).toBe(bId);
  });

  it("leaves a tombstone alone when its file is written back before the batch", async () => {
    const { engine, adapter, api } = await makeEngine();
    const paths = Array.from({ length: 101 }, (_, index) => `notes/${index}.md`);
    for (const path of paths) adapter.files.set(path, encoder.encode(path));
    await engine.initialSync();
    const idOf = (path: string): string => engine.fileIdForPath(path)!;

    // The first 100 tombstones go out while the 101st is still being prepared. A file
    // written back in that window is not a deletion any more.
    let writtenBack: string | null = null;
    api.onPush = async (files) => {
      if (writtenBack !== null) return;
      const inBatch = new Set(files.map((file) => file.fileId));
      writtenBack = paths.find((path) => !inBatch.has(idOf(path)))!;
      adapter.files.set(writtenBack, encoder.encode(writtenBack));
    };

    for (const path of paths) adapter.files.delete(path);
    await engine.initialSync();

    expect(writtenBack).not.toBeNull();
    expect(
      api.pushed.filter((p) => p.fileId === idOf(writtenBack!) && p.action === "delete"),
    ).toHaveLength(0);
    expect(adapter.files.has(writtenBack!)).toBe(true);
  });

  it("leaves a tombstone to the event that already owns its path", async () => {
    const { engine, adapter, api } = await makeEngine();
    const paths = Array.from({ length: 101 }, (_, index) => `notes/${index}.md`);
    for (const path of paths) adapter.files.set(path, encoder.encode(path));
    await engine.initialSync();
    const idOf = (path: string): string => engine.fileIdForPath(path)!;

    // While the first 100 are on the wire, a delete event for the 101st is queued behind
    // the batch: it owns that path, so the batch leaves it to the event's own decision.
    const sent: string[][] = [];
    const realPush = api.push.bind(api);
    api.push = async (vaultId, files) => {
      sent.push(files.map((file) => file.fileId));
      return await realPush(vaultId, files);
    };
    let owned: string | null = null;
    api.onPush = async (files) => {
      if (owned !== null) return;
      const inBatch = new Set(files.map((file) => file.fileId));
      owned = paths.find((path) => !inBatch.has(idOf(path)))!;
      void engine.handleLocalDelete(owned);
    };

    for (const path of paths) adapter.files.delete(path);
    await engine.initialSync();
    await engine.whenIdle();

    // The batch sent 100; the 101st travelled alone, from the event, after it.
    expect(sent[0]).toHaveLength(100);
    const carrying = sent.filter((batch) => batch.includes(idOf(owned!)));
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toHaveLength(1);
  });

  it("pushes that tombstone after a restart as well", async () => {
    let persisted = "{}";
    const { engine, adapter, api, key } = await makeEngine((json) => {
      persisted = json;
    });
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    api.offline = true;
    adapter.files.delete("n.md");
    await expect(engine.handleLocalDelete("n.md")).rejects.toThrow();

    // Obsidian restarts before the connection comes back: the engine is rebuilt
    // from what settings hold, which is the state from *before* the deletion.
    api.offline = false;
    const restored = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    restored.loadState(persisted);
    await restored.initialSync({ firstBind: true });

    expect(adapter.files.has("n.md")).toBe(false);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("pushes a tombstone for a file deleted while the app was closed", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // No engine call at all: the file disappeared from the directory while
    // nothing was watching it.
    adapter.files.delete("n.md");
    await engine.initialSync();

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("pushes an edit made in another editor while the app was closed", async () => {
    let persisted = "{}";
    const { engine, adapter, api, key } = await makeEngine((json) => {
      persisted = json;
    });
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // Nothing is running, so no vault event exists to hear: the file is changed by
    // another editor (VS Code, a sync tool) and the engine only learns about it when
    // the next start binds the vault from what settings and the disk hold.
    adapter.files.set("n.md", encoder.encode("v2 from another editor"));

    const rebound = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    rebound.loadState(persisted);
    await rebound.initialSync({ firstBind: true });

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("v2 from another editor");
  });

  it("does not turn a vault listing that lags a write into a tombstone", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // The listing misses a file the adapter can still read — Obsidian's index
    // lagging a write. Absence from one listing is not evidence of a deletion.
    const listSyncableFiles = adapter.listSyncableFiles.bind(adapter);
    adapter.listSyncableFiles = async () => [];
    await engine.initialSync();
    adapter.listSyncableFiles = listSyncableFiles;

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(adapter.files.has("n.md")).toBe(true);
  });

  it("pushes the rename and keeps one chain when the move could not be pushed", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    api.offline = true;
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("v1"));
    await expect(engine.handleLocalRename("old.md", "new.md")).rejects.toThrow();

    api.offline = false;
    await engine.initialSync();

    // The versionId and the content already agree, so nothing but the recorded
    // path tells the chain that the note moved.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect([...api.chains.keys()]).toEqual([fileId]);
    expect(await decryptString(key, api.paths.get(fileId)!)).toBe("new.md");
    expect(adapter.files.has("old.md")).toBe(false);
  });

  it("keeps one chain when that move is followed by a restart", async () => {
    let persisted = "{}";
    const { engine, adapter, api, key } = await makeEngine((json) => {
      persisted = json;
    });
    adapter.files.set("old.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    api.offline = true;
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("v1"));
    await expect(engine.handleLocalRename("old.md", "new.md")).rejects.toThrow();

    // The move happened on disk, so it has to be in the persisted state even
    // though the push failed — otherwise the restart reads the old path as
    // deleted and the new one as a brand-new file.
    expect(JSON.parse(persisted)[fileId].plainPath).toBe("new.md");

    api.offline = false;
    const restored = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    restored.loadState(persisted);
    await restored.initialSync({ firstBind: true });

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect([...api.chains.keys()]).toEqual([fileId]);
    expect(await decryptString(key, api.paths.get(fileId)!)).toBe("new.md");
    expect(adapter.files.has("old.md")).toBe(false);
  });

  it("repairs a move that never reached the engine as a rename, not a delete plus a new file", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);

    // Nothing told the engine about the move at all (the plugin was disabled
    // while the vault was reorganised, or an external tool moved the file).
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("v1"));
    await engine.initialSync();

    // One note, one chain: a tombstone here plus a fresh fileId for the new path
    // would leave a duplicate on every peer and split the history in two.
    expect([...api.chains.keys()]).toEqual([fileId]);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect(await decryptString(key, api.paths.get(fileId)!)).toBe("new.md");
  });

  it("keeps two same-content files on their own chains when only one of them moved", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("same bytes"));
    await engine.initialSync();
    const first = api.pushed.find((p) => p.action === "create")!;

    // A second, genuinely separate note with the same content, then a move of the
    // first one. The content match is ambiguous, so the move must not adopt the
    // other chain's file.
    adapter.files.set("b.md", encoder.encode("same bytes"));
    await engine.handleLocalChange("b.md");
    const second = api.pushed.find((p) => p.fileId !== first.fileId)!;

    adapter.files.delete("a.md");
    adapter.files.set("moved.md", encoder.encode("same bytes"));
    await engine.initialSync();

    expect(sortedCopy(api.chains.keys())).toEqual(sortedCopy([first.fileId, second.fileId]));
    expect(engine.fileIdForPath("moved.md")).toBe(first.fileId);
    expect(engine.fileIdForPath("b.md")).toBe(second.fileId);
  });
});

/**
 * A host reconciles on a timer and on a reconnect, and neither has anything to do
 * with what the user is typing. A reconcile decides from the snapshot it takes
 * when it starts — the vault listing, the hashes of that moment, the chains as
 * they were — while the vault keeps firing events. Both then act on the same file,
 * and the reconcile is the one working from stale bytes: a duplicate version at
 * best, a pull over an edit that landed mid-pass at worst. The engine resolves
 * that without a lock — the reconcile skips a path an event is handling (nothing
 * ever waits, so no host can deadlock) and re-reads a file before writing it.
 */
describe("SyncEngine — a reconcile racing an incremental event", () => {
  it("does not push the rename an in-flight event is already pushing", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The user moves the note; its push is slow rather than failed. The pass queues
    // behind the rename's job (one job per path), so it sees the settled state and has
    // nothing to push — the duplicate the plugin suite caught cannot be built.
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("v1"));
    const held = holdFirstPush(api);
    const rename = engine.handleLocalRename("old.md", "new.md");
    await held.reached;

    const pass = engine.initialSync();
    held.release();
    await Promise.all([rename, pass]);

    // Exactly one rename, from the event that owns the file. A second one is the
    // duplicated version the plugin suite caught when the reconnect reconcile ran
    // against a snapshot the move had already invalidated.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect([...api.chains.keys()]).toEqual([fileId]);
    expect(engine.fileIdForPath("new.md")).toBe(fileId);
  });

  it("does not push the tombstone an in-flight delete is already pushing", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.delete("n.md");
    const held = holdFirstPush(api);
    const remove = engine.handleLocalDelete("n.md");
    await held.reached;

    const pass = engine.initialSync();
    held.release();
    await Promise.all([remove, pass]);

    // One tombstone. A second one would rewrite the recycle bin's "previous
    // version" to the hash of an empty string, which is what makes a file
    // unrestorable.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("does not pull over an edit that landed while the pass was running", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The peer moved the file on, and then the user typed in it — both while the
    // pass was running. The hook fires where the history request goes out, i.e.
    // after this pass has already hashed the vault, so its snapshot still says
    // "the local copy is untouched" while the disk says otherwise.
    await api.remoteEdit(fileId, "peer version");
    api.onIndex = async () => {
      adapter.files.set("n.md", encoder.encode("typed during the pass"));
    };
    await engine.initialSync();
    api.onIndex = null;

    // The pull that snapshot decided on would have overwritten the edit; re-reading
    // the file turns the two divergent versions into the conflict they are, and the
    // remote side wins it — with the typed content parked beside the note.
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("peer version");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md")))).toBe(
      "typed during the pass",
    );
  });

  it("does not record a sync point older than the push that landed mid-pass", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    await engine.initialSync();
    const aFileId = engine.fileIdForPath("a.md")!;
    const bFileId = engine.fileIdForPath("b.md")!;

    // A peer's edit makes the pass pull A, and that pull's write is the await this test
    // releases B's push inside.
    await api.remoteEdit(aFileId, "peer-a");

    // The index the pass reads is a snapshot of the chains, like the wire: the fake
    // copies each head out, so a version appended mid-pass cannot appear retroactively
    // in the snapshot that pass already fetched and hide the race this test is about.

    // The pass hashes the vault *before* the index request, so this edit to B lands
    // after the pass has hashed it while the chain the pass is about to fetch still has
    // B at v1. B's push is parked, so the chain stays behind this device's own push for
    // the whole pass — the exact shape "the head already holds the bytes on disk, while
    // the state is one version behind" describes.
    const held = holdFirstPush(api);
    let bEvent: Promise<void> | null = null;
    api.onIndex = async () => {
      adapter.files.set("b.md", encoder.encode("b edited"));
      bEvent = engine.handleLocalChange("b.md");
      await held.reached;
    };
    adapter.onWrite = async (path) => {
      if (path !== "a.md" || !bEvent) return;
      held.release();
      await bEvent;
      adapter.onWrite = null;
    };

    await engine.initialSync();
    api.onIndex = null;

    // B's push is the newest version and the pass's chain does not contain it. Adopting
    // the pass's head would move the sync point backwards, and the next edit of B would
    // then conflict with the version this device had just pushed.
    const chain = api.chains.get(bFileId)!;
    expect(chain.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(new TextDecoder().decode(adapter.files.get("b.md"))).toBe("b edited");
    const state = JSON.parse(engine.serializeState()) as Record<
      string,
      { lastKnownVersionId: string }
    >;
    expect(state[bFileId]?.lastKnownVersionId).toBe(chain.at(-1)!.versionId);

    // An ordinary edit after the pass builds on that head: one new version, no copy.
    adapter.files.set("b.md", encoder.encode("after"));
    await engine.handleLocalChange("b.md");
    expect(api.chains.get(bFileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
    expect(new Set(adapter.files.keys())).toEqual(new Set(["a.md", "b.md"]));
  });
});

/**
 * The mirror of the race above, and the one no client can see by looking harder:
 * this device decides from a chain, and a **peer pushes that same file before the
 * decision's push arrives**. Every version the server holds would then be one this
 * client never read, and its push would silently replace it.
 *
 * The push is therefore conditional — it carries the head it was decided from, and
 * the server refuses it when that is no longer the head (see `SyncPushResult`). The
 * engine answers a refusal by taking the chain it was refused by and deciding again
 * *without* moving its own sync point, so a peer's version becomes the conflict it
 * is rather than something this device builds on top of.
 */
/** Push `base`, then leave the chain one version ahead with the same bytes on disk. */
async function racedState(text: string) {
  const { engine, adapter, api } = await makeEngine();
  adapter.files.set("n.md", encoder.encode("base"));
  await engine.initialSync();
  const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

  // The other operation's push of the new bytes landed on the chain…
  adapter.files.set("n.md", encoder.encode(text));
  await api.remoteEdit(fileId, text);
  // …while this engine's sync point is still the version before it.
  return { engine, adapter, api, fileId };
}

describe("SyncEngine — a push the chain has moved past", () => {
  it("takes the peer's version when it lands while this device's push is in flight", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.set("n.md", encoder.encode("edited here"));
    pushFromPeerMidFlight(api, () => api.remoteEdit(fileId, "edited there"));
    await engine.handleLocalChange("n.md");

    // The re-decision is a conflict, and a conflict goes to the remote head: the
    // peer's version is what the note now holds, and this device's bytes are parked
    // beside it — the refused push left no version of its own on the chain.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md")))).toBe(
      "edited here",
    );
  });

  it("does not build on a peer's version when the reconcile's push is refused", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // A pass reads the chain once, at the start — which is the whole gap: the peer's
    // push can land between that read and this pass's own push.
    adapter.files.set("n.md", encoder.encode("edited here"));
    pushFromPeerMidFlight(api, () => api.remoteEdit(fileId, "edited there"));
    await engine.initialSync();

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md")))).toBe(
      "edited here",
    );
  });

  it("adopts the version it already pushed when the response was lost", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.set("n.md", encoder.encode("edited here"));
    // The push was applied and only its response was lost: the retry carries the
    // same bytes against a base that is now the version it already wrote.
    api.onPush = async (files) => {
      api.onPush = null;
      for (const f of files) {
        const chain = api.chains.get(f.fileId) ?? [];
        chain.push({
          versionId: f.versionId,
          contentHash: f.contentHash,
          encryptedPath: f.encryptedPath,
          action: f.action as SyncAction,
          sizeBytes: f.sizeBytes,
          mtimeMs: f.mtimeMs,
          createdAt: new Date().toISOString(),
        });
        api.chains.set(f.fileId, chain);
        if (f.content) api.blobs.set(f.contentHash, f.content);
      }
    };
    await engine.handleLocalChange("n.md");

    // Recognised as the version this device already got in: no duplicate version and
    // no conflict file.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited here");
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(engine.fileIdForPath("n.md")).toBe(fileId);
  });

  /**
   * The race that used to park a conflict copy of a file over itself.
   *
   * Two operations run on one path: the first edits and pushes, the second decides before
   * the first's response has updated this device's sync point — but after its push landed
   * on the chain. The head then holds exactly the bytes on disk while the state still
   * points at the previous version, which `decideFile` used to read as a conflict. Every
   * test here starts from that state: chain head content === local content, state one
   * version behind.
   */
  describe("a decision that meets this device's own content on the head", () => {
    it("an incremental event records the head instead of parking a copy", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");

      await engine.handleLocalChange("n.md");

      // No second version, no conflict copy, and the note still holds those bytes.
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      // The head became the sync point, so the *next* edit builds on it normally.
      expect(syncPointOf(engine, fileId) ?? null).toBe(await api.latestVersionId(fileId));

      adapter.files.set("n.md", encoder.encode("same2"));
      await engine.handleLocalChange("n.md");
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
    });

    it("a pass records the head too", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");

      await engine.initialSync();

      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      expect(syncPointOf(engine, fileId) ?? null).toBe(await api.latestVersionId(fileId));
    });

    it("does not adopt the head over a push that landed while it fetched the ancestry", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");
      const passHead = (await api.latestVersionId(fileId))!;

      // The pass proves its older sync point from the full chain (a request the head-only
      // index cannot answer). While that request is in flight, a peer pushes a version
      // with the same bytes and the notification adopts it. The notification writes
      // nothing, so only the state re-check can see it; adopting the pass's head would
      // move the sync point backwards under the peer's newer version.
      const originalPull = api.pull.bind(api);
      let fired = false;
      let notification: Promise<void> | null = null;
      api.pull = async (vaultId, fileIds) => {
        const response = await originalPull(vaultId, fileIds);
        if (!fired) {
          fired = true;
          await api.remoteEdit(fileId, "same");
          // The notification's job queues behind this pass's job (one job per path), so
          // it is started, not awaited: waiting here would wait for the pass that is
          // waiting for this hook. The promise is awaited after the pass, below.
          notification = engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);
        }
        return response;
      };

      try {
        await engine.initialSync();
        await notification;
        await engine.whenIdle();
      } finally {
        api.pull = originalPull;
      }

      const newest = (await api.latestVersionId(fileId))!;
      expect(newest).not.toBe(passHead);
      expect(syncPointOf(engine, fileId)).toBe(newest);
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    });

    it("does not adopt when the bytes changed while it fetched the ancestry", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");
      const before = syncPointOf(engine, fileId);

      const originalPull = api.pull.bind(api);
      let fired = false;
      api.pull = async (vaultId, fileIds) => {
        const response = await originalPull(vaultId, fileIds);
        if (!fired) {
          fired = true;
          adapter.files.set("n.md", encoder.encode("typed during the fetch"));
        }
        return response;
      };
      try {
        await engine.initialSync();
      } finally {
        api.pull = originalPull;
      }

      // The local bytes no longer match the head the pass adopts; recording the old
      // sync point would claim bytes this device does not hold.
      expect(syncPointOf(engine, fileId)).toBe(before);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("typed during the fetch");
      expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    });

    it("does not adopt when the bytes changed after the pass hashed them", async () => {
      // A first bind: no sync point yet, so the head-only chain proves the convergence
      // by itself and the adoption has no fetch to re-check after. The file moves between
      // the pass's listing and the decision; adopting the head would claim those bytes
      // for a file that no longer holds them.
      const key = await deriveEncryptionKey(
        "password",
        btoa(String.fromCharCode(...new Uint8Array(32))),
      );
      const api = new FakeApi(key);
      const sourceAdapter = new FakeAdapter();
      sourceAdapter.files.set("n.md", encoder.encode("same"));
      const source = new SyncEngine({
        platform: realPlatform,
        vaultId: "vault-1",
        adapter: sourceAdapter,
        api,
        encryptionKey: key,
      });
      await source.initialSync();

      const targetAdapter = new FakeAdapter();
      targetAdapter.files.set("n.md", encoder.encode("same"));
      const target = new SyncEngine({
        platform: realPlatform,
        vaultId: "vault-1",
        adapter: targetAdapter,
        api,
        encryptionKey: key,
      });
      // The scan stats the path once; the adoption's "are these still the bytes I
      // hashed?" re-check stats it again. The file changes in that window, so the
      // re-check must refuse to claim the head for bytes it never hashed.
      let stats = 0;
      targetAdapter.onStat = (path) => {
        if (path !== "n.md") return;
        stats += 1;
        if (stats === 2) targetAdapter.files.set("n.md", encoder.encode("typed after hashing"));
      };
      try {
        await target.initialSync();
      } finally {
        targetAdapter.onStat = null;
      }

      // No identity was recorded for bytes the pass did not hash, and no second chain was
      // created for the path the server already holds.
      expect(JSON.parse(target.serializeState())).toEqual({});
      expect(target.fileIdForPath("n.md")).toBeNull();
      expect(api.chains.size).toBe(1);
      expect(new TextDecoder().decode(targetAdapter.files.get("n.md"))).toBe("typed after hashing");
    });

    it("leaves the sync point alone when the ancestry request fails", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");
      const before = syncPointOf(engine, fileId);
      const originalPull = api.pull.bind(api);
      api.pull = async () => {
        throw new Error("offline");
      };
      try {
        await expect(engine.initialSync()).resolves.toBeUndefined();
      } finally {
        api.pull = originalPull;
      }

      // A failed fetch is answered conservatively: the state keeps its point and the
      // bytes stay on disk; the next pass retries instead of the file failing the pass.
      expect(syncPointOf(engine, fileId)).toBe(before);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    });

    it("a peer's notification records the head too", async () => {
      const { engine, adapter, api, fileId } = await racedState("same");
      const versionId = (await api.latestVersionId(fileId))!;

      await engine.handleFilePushed(fileId, versionId);

      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("same");
      expect(syncPointOf(engine, fileId)).toBe(versionId);
    });

    /**
     * The same rule, for the window a pull's **write** opens: the bytes are on disk
     * before the sync point is recorded, so a decision that lands in between reads them
     * as a divergence from the head it is about to apply.
     *
     * This is the shape a note saved twice by Obsidian leaves behind — the app saves a
     * note again when the attachment it embeds finishes landing, so the peer's next
     * version can arrive while this device is still recording the previous one. It parked
     * a conflict copy of the note the engine had just pulled, and the pull that was still
     * in flight then moved the sync point *back* under the notification.
     */
    it("does not park a conflict copy of the bytes a pull is still recording", async () => {
      const conflicts: ConflictResolvedEvent[] = [];
      const { engine, adapter, api } = await makeEngine(undefined, (event) =>
        conflicts.push(event),
      );
      adapter.files.set("n.md", encoder.encode("v1"));
      await engine.initialSync();
      const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

      // The peer's first save is on the chain; a pass's index sees it.
      await api.remoteEdit(fileId, "v2");

      adapter.onWrite = async (path) => {
        if (path !== "n.md") return;
        adapter.onWrite = null;
        // The adapter has landed the pull's bytes and the engine has not recorded their
        // sync point yet — the notify-only turn the peer's second save arrives in.
        await api.remoteEdit(fileId, "v3");
        await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);
      };

      await engine.initialSync();
      adapter.onWrite = null;
      // The notification's job was queued behind the pull's (one job per path): let it
      // run before asserting the settled state.
      await engine.whenIdle();

      // Nothing the user wrote was overwritten, so nothing is parked; the note ends on
      // the peer's newest version, and so does the sync point.
      expect(conflicts).toEqual([]);
      expect([...adapter.files.keys()]).toEqual(["n.md"]);
      expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("v3");
      expect(syncPointOf(engine, fileId)).toBe(await api.latestVersionId(fileId));
    });

    /**
     * The same window with the peer's version at another path: the notification follows a
     * rename, and the in-flight pull then re-creates the old path with its own bytes.
     * Those bytes must be removed, or the next pass reads them as a new file and forks a
     * second chain for the same note.
     */
    it("removes the old path a pull re-created after the peer moved the file", async () => {
      const { engine, adapter, api, key } = await makeEngine();
      adapter.files.set("n.md", encoder.encode("v1"));
      await engine.initialSync();
      const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
      await api.remoteEdit(fileId, "v2");

      const writeFile = adapter.writeFile.bind(adapter);
      let injected = false;
      adapter.writeFile = async (path, bytes) => {
        if (path === "n.md" && !injected) {
          injected = true;
          adapter.writeFile = writeFile;
          // The peer renames and edits: the notification's pull follows the move and
          // applies v3 at m.md, while this pull is still holding v2's write.
          await api.remoteRename(fileId, await encryptString(key, "m.md"));
          await api.remoteEdit(fileId, "v3");
          await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);
        }
        await writeFile(path, bytes);
      };

      await engine.initialSync();
      adapter.writeFile = writeFile;
      await engine.whenIdle();

      expect([...adapter.files.keys()]).toEqual(["m.md"]);
      expect(new TextDecoder().decode(adapter.files.get("m.md"))).toBe("v3");
      expect(syncPointOf(engine, fileId)).toBe(await api.latestVersionId(fileId));
      expect(engine.fileIdForPath("m.md")).toBe(fileId);
      expect(engine.fileIdForPath("n.md")).toBeNull();
    });

    /**
     * A deletion landing while a pull's write is in flight: the notification's job queues
     * behind the pull (one job per path), so it applies the tombstone to the settled state
     * — the file is deleted and the chain stays one chain, never a second one for the path.
     */
    it("applies a deletion that lands while a pull's write is in flight", async () => {
      const { engine, adapter, api } = await makeEngine();
      adapter.files.set("n.md", encoder.encode("v1"));
      await engine.initialSync();
      const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
      await api.remoteEdit(fileId, "v2");

      const writeFile = adapter.writeFile.bind(adapter);
      let injected = false;
      adapter.writeFile = async (path, bytes) => {
        if (path === "n.md" && !injected) {
          injected = true;
          adapter.writeFile = writeFile;
          const deleted = await api.remoteDelete(fileId);
          await engine.handleFilePushed(fileId, deleted);
        }
        await writeFile(path, bytes);
      };

      await engine.initialSync();
      adapter.writeFile = writeFile;
      await engine.whenIdle();

      // The pull settled v2, then the queued tombstone applied: the file is gone, the
      // path is untracked, and the chain is still the one it was.
      expect(adapter.files.has("n.md")).toBe(false);
      expect(engine.fileIdForPath("n.md")).toBeNull();
      expect([...api.chains.keys()]).toEqual([fileId]);
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "delete"]);
    });
  });

  it("keeps the later of two edits when both of its own pushes are in flight at once", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The first edit is on its way to the server and stuck there — a large file's
    // upload, a slow link — and the second edit is made and pushed while it is still
    // in flight. Both were decided from the same head, so the server appends the
    // second and refuses the first; nothing here needs a queue on the client for
    // the order to come out right.
    let firstPushStarted: (() => void) | null = null;
    const atPush = new Promise<void>((resolve) => {
      firstPushStarted = resolve;
    });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let held = false;
    api.onPush = async () => {
      if (held) return;
      held = true;
      firstPushStarted!();
      await gate;
    };

    adapter.files.set("n.md", encoder.encode("edited first"));
    const firstChange = engine.handleLocalChange("n.md");
    await atPush;

    adapter.files.set("n.md", encoder.encode("edited second"));
    // The second edit's job queues behind the first (one job per path), so it reads the
    // file after the first push settled and builds on its version.
    const secondChange = engine.handleLocalChange("n.md");
    releaseFirst();
    await Promise.all([firstChange, secondChange]);

    // The later edit is the head and the content on disk; the earlier version stays on
    // the chain and nothing was parked — the two edits are ordered, not raced.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited second");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited second");
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(engine.fileIdForPath("n.md")).toBe(fileId);
  });

  it("brings the file back when a deletion loses the race, because the remote side wins", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.delete("n.md");
    pushFromPeerMidFlight(api, () => api.remoteEdit(fileId, "edited there"));
    await engine.handleLocalDelete("n.md");

    // The tombstone would have removed a version this device never saw, so it is
    // refused. The two intents meet in a conflict, and the remote one wins: the
    // peer's version is on disk, and the deletion — which has no content — loses
    // without leaving a conflict file behind.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
    expect(await api.readPlainLatest(fileId)).toBe("edited there");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited there");
  });

  it("takes the peer's version when a pass finds the deletion, not the failed push", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The user deletes the note while the network is down, and a peer edits it before
    // the next pass: the deletion never reached the chain, so the pass is where the
    // two intents meet.
    api.offline = true;
    adapter.files.delete("n.md");
    await expect(engine.handleLocalDelete("n.md")).rejects.toThrow();
    await api.remoteEdit(fileId, "edited there");
    api.offline = false;

    await engine.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("edited there");
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
  });

  it("parks a second conflict in the same second beside the first, and reports both", async () => {
    const resolved: ConflictResolvedEvent[] = [];
    const { engine, adapter, api } = await makeEngine(undefined, (event) => resolved.push(event));
    adapter.files.set("n.md", encoder.encode("base"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    adapter.files.set("n.md", encoder.encode("local one"));
    await api.remoteEdit(fileId, "peer one");
    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    adapter.files.set("n.md", encoder.encode("local two"));
    await api.remoteEdit(fileId, "peer two");
    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    // A second conflict on the same file inside the same second must not overwrite the
    // copy the first one parked — that content is the only copy there is. (The clock is
    // frozen for this file, so both copies really do land in one second.)
    expect(
      new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md", new Date(), 1))),
    ).toBe("local one");
    expect(
      new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md", new Date(), 2))),
    ).toBe("local two");
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("peer two");

    expect(resolved).toEqual([
      {
        fileId,
        plainPath: "n.md",
        conflictPath: conflictFilePath("n.md", new Date(), 1),
        remoteAction: "write",
      },
      {
        fileId,
        plainPath: "n.md",
        conflictPath: conflictFilePath("n.md", new Date(), 2),
        remoteAction: "write",
      },
    ]);
  });
});
