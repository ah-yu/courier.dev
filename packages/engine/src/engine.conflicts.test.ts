import {
  FakeAdapter,
  SyncEngine,
  conflictFilePath,
  describe,
  encoder,
  expect,
  freezeConflictClock,
  generateFileId,
  it,
  makeEngine,
  realPlatform,
  syncedFileId,
} from "./engine.test-helpers";
import type { ConflictResolvedEvent } from "./engine.test-helpers";

freezeConflictClock();

describe("SyncEngine conflicts", () => {
  it("keeps a helper export shape stable", () => {
    expect(typeof generateFileId).toBe("function");
  });

  /**
   * Deleting a file and later having it on disk again is the user starting a new
   * note under a name the server remembers as deleted. The old chain is a
   * tombstone, so it says nothing about the new content: reconciling that path
   * gives it its own fileId and pushes a `create`, with no conflict and no
   * history shared with the deleted file.
   *
   * (This is the reconnect shape: the same directory with no persisted state.)
   */
  it("gives a file that outlived a remote delete its own new fileId", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("reborn.md", encoder.encode("first life"));
    await engine.initialSync();
    const originalFileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The file is deleted (here locally, but the effect is the same: the server
    // chain ends in a tombstone) and later exists again at that path.
    await engine.handleLocalDelete("reborn.md");
    adapter.files.set("reborn.md", encoder.encode("second life"));

    // A client that only has the directory — a restart, a reconnect, a reopened
    // Obsidian — reconciles instead of diffing its own state.
    const reopened = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    await reopened.initialSync();

    expect(adapter.files.has(conflictFilePath("reborn.md"))).toBe(false);
    const rebornFileId = reopened.fileIdForPath("reborn.md")!;
    expect(rebornFileId).not.toBe(originalFileId);
    expect(api.pushed.at(-1)?.action).toBe("create");
    expect(api.pushed.at(-1)?.fileId).toBe(rebornFileId);

    // The deleted file keeps its own chain, tombstone and all.
    expect(api.chains.get(originalFileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(api.chains.get(rebornFileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(await api.readPlainLatest(rebornFileId)).toBe("second life");
  });

  /**
   * A local delete followed by a local recreate is not a divergence: the tombstone
   * is **this device's own sync point**, so a file on disk under it can only be one
   * the user just created, and the remote side holds no content to compete with.
   * The recreate is pushed as a `restore` on the same chain — under the "remote
   * wins" rule the alternative would be deleting the note the user is typing.
   */
  it("pushes a restore for a file recreated after this device deleted it", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("reborn.md", encoder.encode("first life"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    await engine.handleLocalDelete("reborn.md");
    adapter.files.set("reborn.md", encoder.encode("second life"));
    await engine.handleLocalChange("reborn.md");

    expect(api.pushed.at(-1)?.action).toBe("restore");
    expect(engine.fileIdForPath("reborn.md")).toBe(fileId);
    expect(adapter.files.has(conflictFilePath("reborn.md"))).toBe(false);

    // The scheduled pass leaves it alone: it is a normal synced file again.
    await engine.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("reborn.md"))).toBe("second life");
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete", "restore"]);
  });

  it("takes the peer's deletion for an edit made offline, parking that edit", async () => {
    const conflicts: ConflictResolvedEvent[] = [];
    const { engine, adapter, api } = await makeEngine(undefined, (event) => conflicts.push(event));
    adapter.files.set("gone.md", encoder.encode("synced content"));
    await engine.initialSync();
    const originalFileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // Edited while offline: the change is on disk but was never pushed, so the
    // last-known point is still the synced one — the local copy diverged from the
    // version the tombstone removed, which is a conflict.
    adapter.files.set("gone.md", encoder.encode("edited offline"));
    const deleteVersion = await api.remoteDelete(originalFileId);
    await engine.handleFilePushed(originalFileId, deleteVersion);
    await engine.initialSync();

    // The remote deletion is applied — that is what "remote wins" means — and the
    // edit that lost is parked beside the note instead of vanishing with it.
    expect(adapter.files.has("gone.md")).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("gone.md")))).toBe(
      "edited offline",
    );
    // A conflict whose remote side was a tombstone is reported as a `delete`: the
    // host's line has to say the file went away, not that a version was written.
    expect(conflicts.map((event) => event.remoteAction)).toEqual(["delete"]);
    expect(api.chains.get(originalFileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("applies a remote delete to an untouched local copy", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("untouched"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The peer deleted it and this copy is exactly the version it removed, so the
    // deletion simply applies — no conflict, no push-back. The scheduled pass is
    // the one that applies it (the bind pass merges instead).
    await engine.handleFilePushed(fileId, await api.remoteDelete(fileId));
    await engine.initialSync();

    expect(adapter.files.has("gone.md")).toBe(false);
    expect(adapter.files.has(conflictFilePath("gone.md"))).toBe(false);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("ignores a delete for a path it never tracked", async () => {
    // The host feeds every vault event in, including paths this device does not sync
    // (a file created and deleted again between two passes, a path outside the scope).
    // There is nothing to push and no identity to record: the delete is a no-op.
    const { engine, api } = await makeEngine();
    await engine.initialSync();
    const before = api.pushCalls.length;

    await expect(engine.handleLocalDelete("never-synced.md")).resolves.toBeUndefined();
    expect(api.pushCalls).toHaveLength(before);
  });

  it("applies a remote delete once the local file is gone", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("untouched"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The user removed it (or a previous reconcile did): with no local file, the
    // peer's tombstone is just synced, so nothing is pushed back.
    adapter.files.delete("gone.md");
    await engine.handleFilePushed(fileId, await api.remoteDelete(fileId));
    const pushed = api.pushed.length;

    await engine.initialSync();

    expect(adapter.files.has("gone.md")).toBe(false);
    expect(api.pushed.length).toBe(pushed);
  });

  /**
   * The bind pass is the one place a local file wins over a tombstone: connecting
   * a vault (or reopening Obsidian) treats a file the remote already deleted as
   * the user's own, and gives it a fresh identity rather than letting the
   * connection delete it.
   */
  it("revives a peer-deleted local file as a new file when binding the vault", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("survivor.md", encoder.encode("still here"));
    await engine.initialSync();
    const originalFileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The peer deletes the file and the tombstone stays on the server; this
    // device never applied it, which is what a machine that was offline looks
    // like when it connects.
    await api.remoteDelete(originalFileId);
    expect(new TextDecoder().decode(adapter.files.get("survivor.md"))).toBe("still here");

    // A fresh client over that directory — a connect, or Obsidian reopening with
    // no state — has nothing to compare the tombstone against, so the file gets a
    // fresh identity instead of being deleted by the connection.
    const bound = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    await bound.initialSync();

    expect(adapter.files.has(conflictFilePath("survivor.md"))).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("survivor.md"))).toBe("still here");
    const newFileId = bound.fileIdForPath("survivor.md")!;
    expect(newFileId).not.toBe(originalFileId);
    expect(api.chains.get(originalFileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(api.chains.get(newFileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(await api.readPlainLatest(newFileId)).toBe("still here");
  });

  /**
   * A device that was **not running** when the peer deleted the note has to apply that
   * deletion when it starts again. Its persisted state already holds the chain and the
   * sync point, so the tombstone is nothing new to it: only a local file the engine has
   * never tracked is the user's own and gets a fresh identity on a bind
   * (`DecideInput.locallyTracked`).
   *
   * Reading every restart as "a vault I have never seen" revived the file instead: the
   * bind pass dropped the tracked chain, the surviving copy became an untracked file,
   * and it went back to the server as a new chain — so a note deleted on device A came
   * back on every device when B resumed. That is the pause → peer deletes → resume
   * report, and a plain Obsidian restart reaches the same bind.
   */
  it("applies a peer's deletion on a later bind instead of reviving the file", async () => {
    let persisted = "{}";
    const { engine, adapter, api, key } = await makeEngine((json) => {
      persisted = json;
    });
    adapter.files.set("gone.md", encoder.encode("still here"));
    await engine.initialSync({ firstBind: true });
    const originalFileId = api.pushed.find((p) => p.action === "create")!.fileId;

    // The peer deletes the note while this device is not running (paused, or closed).
    await api.remoteDelete(originalFileId);

    // The next start — a pause followed by a resume, or Obsidian reopening — binds again
    // from the state the previous run persisted.
    const resumed = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    resumed.loadState(persisted);
    await resumed.initialSync({ firstBind: true });

    expect(adapter.files.has("gone.md")).toBe(false);
    expect(api.chains.get(originalFileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect([...api.chains.keys()]).toEqual([originalFileId]);
  });

  /**
   * A peer that recreates a note at a path this device deleted owns that path from then
   * on. The old chain's tombstone is this device's own sync point, and its state entry
   * outlives the deletion — that is what makes "delete a note, then write it again" a
   * recreate — but a local file at the path is **not** a recreate once another chain
   * claims it.
   *
   * Without that, the next pass read the peer's new note as the file under this device's
   * delete point and pushed a `restore` on the dead chain: two live chains at one path,
   * and the note the user deleted back on top of the peer's new one. The state entry is
   * what the bind pass now keeps across a restart, so the pass itself has to retire it
   * when the path changes hands.
   */
  it("does not revive its deleted chain over a peer's new file at the same path", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("mine"));
    await engine.initialSync();
    const deletedId = await syncedFileId(api);

    // This device deletes the note, so its own tombstone is the sync point.
    adapter.files.delete("n.md");
    await engine.handleLocalDelete("n.md");
    expect(engine.fileIdForPath("n.md")).toBe(deletedId);

    // A peer creates a new note at the same path — a second chain on the server.
    const peerAdapter = new FakeAdapter();
    peerAdapter.files.set("n.md", encoder.encode("theirs"));
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    const newId = peer.fileIdForPath("n.md")!;
    expect(newId).not.toBe(deletedId);

    // Its notification arrives here and the pull takes the path.
    await engine.handleFilePushed(newId, (await api.latestVersionId(newId))!);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("theirs");
    expect(engine.fileIdForPath("n.md")).toBe(newId);

    // The next pass must leave the peer's note alone: no `restore` on the dead chain.
    await engine.initialSync();
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("theirs");
    expect(engine.fileIdForPath("n.md")).toBe(newId);
    expect(api.chains.get(deletedId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  /**
   * The same ownership rule when the competitor is known **only from the pass index**.
   *
   * A peer's new chain can be in the server index without a notification ever having
   * pulled it here (this device was stopped, or the socket was down), so `pathToFileId`
   * still names the tombstone. The pass has the live chain in its index, and that is
   * enough: retiring the tombstone there is what keeps the recreated local note from
   * being pushed as a `restore` beside the peer's chain.
   */
  it("does not restore over a peer's chain the pass only learns from the index", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("mine"));
    await engine.initialSync();
    const deletedId = await syncedFileId(api);

    // This device deletes the note: its own tombstone is the sync point.
    adapter.files.delete("n.md");
    await engine.handleLocalDelete("n.md");

    // A peer creates a new note at the same path; this device hears nothing about it.
    const peerAdapter = new FakeAdapter();
    peerAdapter.files.set("n.md", encoder.encode("theirs"));
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    const peerId = peer.fileIdForPath("n.md")!;

    // The host was stopped; the user writes a new note at the path; the next start's
    // bind sees the peer's chain only in the index it just fetched.
    adapter.files.set("n.md", encoder.encode("mine again"));
    await engine.initialSync({ firstBind: true });

    // One live chain, the peer's: the recreated copy is parked, and the dead chain keeps
    // its tombstone instead of gaining a `restore`.
    const live = [...api.chains.entries()].filter(
      ([, chain]) => chain[chain.length - 1]!.action !== "delete",
    );
    expect(live.map(([fileId]) => fileId)).toEqual([peerId]);
    expect(api.chains.get(deletedId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("theirs");
    expect(engine.fileIdForPath("n.md")).toBe(peerId);
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md")))).toBe(
      "mine again",
    );
  });

  /**
   * The incremental half of the same ownership rule: a create/change event for a file this
   * device deleted, while a peer's new chain already owns the path **on the server** but no
   * notification has reached this device (the socket is down, and no pass has run since the
   * peer's push).
   *
   * The event's decision is taken from the tracked chain alone, so without a server check it
   * answers "recreate" and pushes a `restore` onto the dead chain beside the peer's chain —
   * two live chains at one path. The pass-level rule has to reach the event path too: the
   * peer's chain owns the path, so the local copy is parked and the peer's head is applied.
   */
  it("does not restore on a recreate event when a peer's chain already owns the path", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("mine"));
    await engine.initialSync();
    const deletedId = await syncedFileId(api);

    // This device deletes the note, so the tombstone is its sync point.
    adapter.files.delete("n.md");
    await engine.handleLocalDelete("n.md");

    // A peer creates a new note at the same path; no notification reaches this device.
    const peerAdapter = new FakeAdapter();
    peerAdapter.files.set("n.md", encoder.encode("theirs"));
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    const peerId = peer.fileIdForPath("n.md")!;

    // The user writes a new note at the path: the vault event decides immediately, before
    // any pass or notification.
    adapter.files.set("n.md", encoder.encode("mine again"));
    await engine.handleLocalChange("n.md");

    // One live chain, the peer's. The dead chain keeps its tombstone, the recreated copy is
    // parked, and the peer's bytes are what the path holds.
    const live = [...api.chains.entries()].filter(
      ([, chain]) => chain[chain.length - 1]!.action !== "delete",
    );
    expect(live.map(([fileId]) => fileId)).toEqual([peerId]);
    expect(api.chains.get(deletedId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(engine.fileIdForPath("n.md")).toBe(peerId);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("theirs");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("n.md")))).toBe(
      "mine again",
    );
    // The dead chain no longer names the path; the owner is the tracked one, so a restart
    // cannot decide a restore for it again.
    const state = JSON.parse(engine.serializeState()) as Record<string, { plainPath: string }>;
    expect(state[deletedId]).toBeUndefined();
    expect(state[peerId]?.plainPath).toBe("n.md");
  });

  /**
   * The same event, with the recreated bytes equal to the owner's head. Identical bytes are
   * never a conflict, so the owner's identity is adopted and no copy is parked.
   */
  it("adopts the owner when the recreated bytes are its head", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("mine"));
    await engine.initialSync();
    const deletedId = await syncedFileId(api);

    adapter.files.delete("n.md");
    await engine.handleLocalDelete("n.md");

    const peerAdapter = new FakeAdapter();
    peerAdapter.files.set("n.md", encoder.encode("theirs"));
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    const peerId = peer.fileIdForPath("n.md")!;

    adapter.files.set("n.md", encoder.encode("theirs"));
    const pushedBefore = api.pushed.length;
    await engine.handleLocalChange("n.md");

    expect(engine.fileIdForPath("n.md")).toBe(peerId);
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(api.chains.get(deletedId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(api.pushed).toHaveLength(pushedBefore);
  });

  it("fails the recreate event when the ownership check cannot read the index", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("mine"));
    await engine.initialSync();
    const deletedId = await syncedFileId(api);
    adapter.files.delete("n.md");
    await engine.handleLocalDelete("n.md");

    adapter.files.set("n.md", encoder.encode("mine again"));
    const realIndex = api.getVaultSyncIndex.bind(api);
    api.getVaultSyncIndex = async () => {
      throw new Error("network down");
    };
    try {
      // The event cannot prove the path is free, so it must not push the restore. The
      // failure is visible and the next pass retries from the same state.
      await expect(engine.handleLocalChange("n.md")).rejects.toThrow("network down");
    } finally {
      api.getVaultSyncIndex = realIndex;
    }

    expect(api.chains.get(deletedId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(engine.fileIdForPath("n.md")).toBe(deletedId);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("mine again");
  });

  it("keeps the tombstone and reports when the owner's content cannot be read", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("mine"));
    await engine.initialSync();
    const deletedId = await syncedFileId(api);
    adapter.files.delete("n.md");
    await engine.handleLocalDelete("n.md");

    const peerAdapter = new FakeAdapter();
    peerAdapter.files.set("n.md", encoder.encode("theirs"));
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    const peerId = peer.fileIdForPath("n.md")!;

    adapter.files.set("n.md", encoder.encode("mine again"));
    const peerHead = api.chains.get(peerId)!.at(-1)!;
    const peerBlob = api.blobs.get(peerHead.contentHash)!;
    api.blobs.delete(peerHead.contentHash);
    try {
      await expect(engine.handleLocalChange("n.md")).rejects.toThrow(/Could not read the content/);
    } finally {
      api.blobs.set(peerHead.contentHash, peerBlob);
    }

    // The apply failed, so the tombstone is untouched and the local note is still on disk:
    // the next pass retries the same decision instead of losing the note silently.
    expect(api.chains.get(deletedId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(engine.fileIdForPath("n.md")).toBe(deletedId);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("mine again");
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
  });

  /**
   * A peer-deleted chain whose local file is already gone leaves nothing to apply, so
   * the entry has to be retired rather than kept as "synced".
   *
   * The file was removed while nothing was watching and the peer deleted it too; the
   * bind then meets a `delete` head with no local file and answers `synced`. Keeping the
   * pre-delete sync point leaves the state naming a path with no file, and the next note
   * the user writes at that freed path is decided against the dead chain — deleted and
   * parked as a conflict instead of becoming a new chain.
   */
  it("retires a peer-deleted chain whose local file was already gone", async () => {
    let persisted = "{}";
    const { engine, adapter, api, key } = await makeEngine((json) => {
      persisted = json;
    });
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const deletedId = await syncedFileId(api);

    // The file disappeared while nothing watched, and the peer deleted it as well.
    adapter.files.delete("n.md");
    await api.remoteDelete(deletedId);

    // A restart binds from the state that still names the file.
    const restarted = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    restarted.loadState(persisted);
    await restarted.initialSync({ firstBind: true });

    // The dead chain is gone from the state: no path, no sync point, nothing to restore.
    expect(restarted.fileIdForPath("n.md")).toBeNull();
    expect(JSON.parse(restarted.serializeState())).toEqual({});
    expect(api.chains.get(deletedId)!.map((v) => v.action)).toEqual(["create", "delete"]);

    // The free path takes a new note as its own chain, not as a conflict with the chain
    // that used to live there.
    adapter.files.set("n.md", encoder.encode("a new note"));
    await restarted.handleLocalChange("n.md");
    const created = api.pushed.filter((p) => p.action === "create").at(-1)!;
    expect(created.fileId).not.toBe(deletedId);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("a new note");
  });
});
