import {
  FakeAdapter,
  SyncEngine,
  conflictFilePath,
  describe,
  encoder,
  encryptString,
  expect,
  expectConsistent,
  freezeConflictClock,
  generateFileId,
  holdFirstPush,
  it,
  makeEngine,
  realPlatform,
  syncPointOf,
  syncedFileId,
  vi,
} from "./engine.test-helpers";

freezeConflictClock();

/**
 * A host's adapter fires a vault event for every write **the engine itself
 * performs**, and the host feeds that event straight back into
 * `handleLocalChange` / `handleLocalDelete` — while the engine is still midway
 * through its own operation, before its state has caught up. The engine must
 * treat those events as echoes of its own action, exactly like it already
 * suppresses the websocket echo of a version it pushed (`pushedVersions`).
 *
 * Every test below drives that echo at the adapter boundary, which is where a
 * real host produces it. Without the suppression each shape is damaged in its
 * own way, so each one is pinned separately.
 */
describe("SyncEngine — the vault event caused by its own write", () => {
  it("does not record a conflict from the event its own restore write causes", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("phoenix.md", encoder.encode("rises again"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // This device deleted the file seconds ago. The delete push re-established
    // the path → fileId mapping, so the echo looks like a local edit *under a
    // delete head* — treating it as a conflict would park the note the user is
    // actively restoring.
    await engine.handleLocalDelete("phoenix.md");

    let conflictFileDuringRestore: boolean | "the vault-event handler never ran" =
      "the vault-event handler never ran";
    adapter.onWrite = async (path) => {
      adapter.onWrite = null;
      await engine.handleLocalChange(path);
      conflictFileDuringRestore = adapter.files.has(conflictFilePath("phoenix.md"));
    };
    await engine.restoreFile(created.fileId, "phoenix.md", created.contentHash);

    // Nothing about the engine's own write may reach the user as a conflict.
    // The sentinel string names the failure in the diff; compare the boolean it
    // guards explicitly (Bun's `toBe` will not take `false` for `boolean | string`).
    expect<boolean | string>(conflictFileDuringRestore).toBe(false);
    expect(adapter.files.has(conflictFilePath("phoenix.md"))).toBe(false);
    expect(api.pushed.map((p) => p.action)).toEqual(["create", "delete", "restore"]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(await api.readPlainLatest(created.fileId)).toBe("rises again");
  });

  it("does not push a second restore when the echo of its own write comes back", async () => {
    // The echo answers "a local edit under a delete head", which a conflict path
    // would resolve by pushing the restored bytes as a *second* restore version —
    // one extra version and one extra request per restore.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("phoenix.md", encoder.encode("rises again"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    await engine.handleLocalDelete("phoenix.md");

    adapter.onWrite = async (path) => {
      adapter.onWrite = null;
      await engine.handleLocalChange(path);
    };
    await engine.restoreFile(created.fileId, "phoenix.md", created.contentHash);

    expect(api.pushed.map((p) => p.action)).toEqual(["create", "delete", "restore"]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(await api.readPlainLatest(created.fileId)).toBe("rises again");
  });

  it("does not read its own pull as an edit when the vault reports that write twice", async () => {
    // Obsidian reports one write as more than one event — a file the engine created
    // is handed to the host as `create` *and* `modify` — and both arrive while the
    // engine is still midway through the pull that wrote the file. Suppressing only
    // the first left the second to be read as a divergent local edit, so the engine
    // parked a conflict copy of the content it had just pulled and pulled it again.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    await api.remoteEdit(created.fileId, "v2 from the peer");

    let writes = 0;
    adapter.onWrite = async (path) => {
      writes++;
      // Only the pull's own write: a write the *conflict path* performs must not
      // re-enter this hook, or a broken engine recurses instead of failing an
      // assertion (which is what it did in a real vault: the conflict copy's own
      // write fired more events, so the copies escalated `-2`, `-3`, `-4`…).
      if (writes > 1) return;
      // One write, two events — the way Obsidian reports a file it just created.
      await engine.handleLocalChange(path);
      await engine.handleLocalChange(path);
    };
    await engine.handleFilePushed(created.fileId, (await api.latestVersionId(created.fileId))!);

    expect(writes).toBe(1);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("v2 from the peer");
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    // The echo pushed nothing: one create, and the peer's modify.
    expect(api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
  });

  it("does not invent a second fileId when restoring a peer-deleted file", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("phoenix.md", encoder.encode("rises again"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // A peer deleted it, so there is no local delete the rename heuristic could
    // match — which is exactly when the echo used to birth a new fileId. (The
    // local copy is removed first: a local file under a tombstone is a *new*
    // file, not something to restore.)
    adapter.files.delete("phoenix.md");
    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));
    expect(adapter.files.has("phoenix.md")).toBe(false);

    adapter.onWrite = async (path) => {
      adapter.onWrite = null;
      await engine.handleLocalChange(path);
    };
    await engine.restoreFile(created.fileId, "phoenix.md", created.contentHash);

    // One chain for the restored path, still the original identity.
    expect([...api.chains.keys()]).toEqual([created.fileId]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(api.pushed.map((p) => p.action)).toEqual(["create", "restore"]);
    expect(adapter.files.has(conflictFilePath("phoenix.md"))).toBe(false);
    expect(await api.readPlainLatest(created.fileId)).toBe("rises again");
  });

  /**
   * Applying a peer's delete is the other half of the same problem, and the more
   * damaging one: the engine's own `delete` event arrives before it has cleared
   * the path → fileId mapping, so it used to push a second tombstone. The recycle
   * bin reads the version *before* the delete as the restorable one, so that
   * extra tombstone made every peer-deleted file unrestorable — the panel tried
   * to fetch the content hash of an empty string and failed.
   */
  it("does not push a second tombstone when it applies a peer's delete", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("untouched"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The user removed the note locally, so applying the peer's delete is the
    // only sensible outcome.
    adapter.files.delete("gone.md");
    adapter.onDelete = async (path) => {
      adapter.onDelete = null;
      await engine.handleLocalDelete(path);
    };
    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));

    expect(api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(adapter.files.has("gone.md")).toBe(false);
  });

  /**
   * A file written at a path whose chain ends in a tombstone is a **new** file.
   *
   * The notification that applied the peer's deletion must not stay in the live-path
   * index: adopting that identity (or matching it by content — a delete version's hash
   * is the empty string's) turns the user's restored note into a conflict against the
   * deletion and deletes it again, leaving the copy parked instead of the note.
   */
  it("pushes a local file at a peer-deleted path as a new chain, not a conflict", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("deleted by the peer"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));
    expect(adapter.files.has("gone.md")).toBe(false);

    // An empty file is the adversarial case: its hash IS the tombstone's content hash.
    adapter.files.set("gone.md", encoder.encode(""));
    await engine.handleLocalChange("gone.md");

    const restored = api.pushed.filter((p) => p.action === "create").at(-1)!;
    expect(restored.fileId).not.toBe(created.fileId);
    // The dead chain keeps its tombstone; the new file has a chain of its own.
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(api.chains.get(restored.fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(adapter.files.has(conflictFilePath("gone.md"))).toBe(false);
  });

  it("does not push a second rename when following a peer's move", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved by the peer"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer moves the file: the new head records the new path.
    api.paths.set(created.fileId, await encryptString(key, "new.md"));
    await api.remoteEdit(created.fileId, "moved by the peer");

    // Following that move renames the local file, which fires the host's event
    // while the engine still maps the old path.
    adapter.onRename = async (from, to) => {
      adapter.onRename = null;
      await engine.handleLocalRename(from, to);
    };
    await engine.handleFilePushed(created.fileId, (await api.latestVersionId(created.fileId))!);

    expect(adapter.files.has("new.md")).toBe(true);
    // The old path must be gone: falling back to it recreates the file the peer
    // moved away from, which leaves both paths on disk.
    expect(adapter.files.has("old.md")).toBe(false);
    expect(adapter.files.size).toBe(1);
    expect(api.pushed.map((p) => p.action)).toEqual(["create"]);
  });

  it("follows a peer's move when the vault reported the new path first", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved while we watched"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer moves the file: the new head records the new path.
    api.paths.set(created.fileId, await encryptString(key, "new.md"));
    await api.remoteEdit(created.fileId, "moved while we watched");

    // The vault already applied the move locally, so the old path is gone while
    // the engine still maps it. Real Obsidian would report a `rename` for this,
    // but the notification can arrive after the vault's own event (or not at
    // all), and the engine must not turn the reported path into a new file.
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("moved while we watched"));

    await engine.handleFilePushed(created.fileId, (await api.latestVersionId(created.fileId))!);

    expect(adapter.files.has("new.md")).toBe(true);
    expect(adapter.files.has("old.md")).toBe(false);
    expect(adapter.files.size).toBe(1);
    expect([...api.chains.keys()]).toEqual([created.fileId]);
    expect(engine.fileIdForPath("new.md")).toBe(created.fileId);
    // The state moved with the file: an entry still naming the old path is what
    // makes the next reconcile read the new path as untracked and fork a chain.
    const persisted = JSON.parse(engine.serializeState()) as Record<string, { plainPath: string }>;
    expect(Object.values(persisted).map((entry) => entry.plainPath)).toEqual(["new.md"]);
  });

  it("does not recreate the source path when the peer's move is applied", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved by the peer"));
    await engine.initialSync({ firstBind: true });
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer moves the file and the vault has already applied the move locally,
    // but the engine has not processed an event for it yet — a dropped rename
    // notification. The engine still maps the old path.
    api.paths.set(created.fileId, await encryptString(key, "new.md"));
    await api.remoteEdit(created.fileId, "moved by the peer");
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("moved by the peer"));

    await engine.handleFilePushed(created.fileId, (await api.latestVersionId(created.fileId))!);

    // The pull must land at the peer's path: falling back to the mapped old path
    // recreates the file the move removed, leaving both paths on disk.
    expect(adapter.files.has("new.md")).toBe(true);
    expect(adapter.files.has("old.md")).toBe(false);
    expect(adapter.files.size).toBe(1);
    expect([...api.chains.keys()]).toEqual([created.fileId]);
    expect(engine.fileIdForPath("new.md")).toBe(created.fileId);
  });

  it("adopts the remote fileId for a path no remote chain records", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("renamed by the peer"));
    await engine.initialSync({ firstBind: true });
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer renames it and that push never reaches this engine: the server's
    // live path is still the *old* one, while the vault already reports a file at
    // the new path. Without the content-identity net this forks a second chain.
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("renamed by the peer"));

    await engine.handleLocalChange("new.md");

    // One path, one chain, same fileId — not a second chain for the new path.
    expect([...api.chains.keys()]).toEqual([created.fileId]);
    expect(engine.fileIdForPath("new.md")).toBe(created.fileId);
    expect(engine.fileIdForPath("old.md")).toBeNull();
    expect(api.chains.get(created.fileId)!.at(-1)!.action).toBe("rename");
    expect(api.pushed.map((p) => p.action)).toEqual(["create", "rename"]);
  });

  it("does not treat its own push as a remote change when the echo beats the response", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    adapter.files.set("note.md", encoder.encode("first revision"));

    // The server broadcasts `file_pushed` while the push HTTP call is still in
    // flight, so the echo arrives before `push` resolves. Registering the pushed
    // versionId only after the response left a window in which the engine read
    // its own change back and pushed it a second time.
    let echoed = false;
    api.onPush = async (files) => {
      if (echoed) return;
      echoed = true;
      const file = files[0];
      await engine.handleFilePushed(file.fileId, file.versionId);
    };

    await engine.handleLocalChange("note.md");

    expect(api.pushed).toHaveLength(1);
    expect([...api.chains.keys()]).toHaveLength(1);
    expect(adapter.files.has(conflictFilePath("note.md"))).toBe(false);
    expect(adapter.files.size).toBe(1);
  });

  it("forgets a pushed version once its echo window closes", async () => {
    const { engine, adapter } = await makeEngine();
    await engine.initialSync();

    // The server skips the pushing session's own subscription, so on the ordinary path
    // the echo this record exists for never arrives at all. Without a deadline the map
    // grew by one id per push for as long as the host stayed up — weeks, for the CLI
    // daemon — which is the leak this pins. (Read through a cast: the record is
    // deliberately not part of the engine's public surface; `SelfEventLog`'s own tests
    // pin the window itself.)
    const pending = () =>
      (engine as unknown as { selfEvents: { pendingEchoes: number } }).selfEvents.pendingEchoes;

    adapter.files.set("first.md", encoder.encode("first"));
    await engine.handleLocalChange("first.md");
    expect(pending()).toBe(1);

    vi.setSystemTime(new Date(Date.now() + 11_000));

    adapter.files.set("second.md", encoder.encode("second"));
    await engine.handleLocalChange("second.md");

    // The earlier record's window has closed, so it is dropped instead of accumulated.
    expect(pending()).toBe(1);
  });

  it("keeps pulling its peers' changes when one of its own pushes is refused", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    // Two files this device owns, in a deliberate order: the refused push has to be met
    // before the pull, or the case cannot tell the two behaviours apart (the assertion at
    // the end checks that it really was met first).
    adapter.files.set("mine.md", encoder.encode("mine v1"));
    adapter.files.set("theirs.md", encoder.encode("theirs v1"));
    await engine.initialSync();

    // A peer on the same vault edits the second file.
    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    peerAdapter.files.set("theirs.md", encoder.encode("theirs v2"));
    await peer.handleLocalChange("theirs.md");

    // This device edits its own file, and the server refuses every push it makes — a full
    // quota is the real case (413 QUOTA_EXCEEDED). Hold the peer's content fetch just long
    // enough that the refusal is observed before the pull finishes; otherwise the faster
    // pull (the review's stamp shortcut) can win the race and make the assertion blind.
    adapter.files.set("mine.md", encoder.encode("mine v2"));
    api.contentDelayMs = 50;
    let peerChangeWasAlreadyPulled = false;
    api.onPush = async () => {
      peerChangeWasAlreadyPulled =
        new TextDecoder().decode(adapter.files.get("theirs.md")) === "theirs v2";
      throw new Error("QUOTA_EXCEEDED");
    };

    // The failure still reaches the host...
    await expect(engine.initialSync()).rejects.toThrow(/QUOTA_EXCEEDED/);
    // ...but it no longer ends the pass. The refused push came first, so the peer's edit
    // was skipped with it — which is how a device that is merely out of quota stopped
    // receiving its peers' changes while it still looked connected.
    expect(peerChangeWasAlreadyPulled).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("theirs.md"))).toBe("theirs v2");
  });

  it("keeps two live files with identical content on separate chains", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("same bytes"));
    await engine.initialSync();
    const first = api.pushed.find((p) => p.action === "create")!;

    // A second, genuinely separate file with the same content. Its bytes match a
    // live chain, but that chain's file is still here — adopting it would merge
    // two files the user sees as distinct.
    adapter.files.set("b.md", encoder.encode("same bytes"));
    await engine.handleLocalChange("b.md");

    const second = api.pushed.find((p) => p.fileId !== first.fileId);
    expect(second).toBeDefined();
    expect(second!.action).toBe("create");
    expect([...api.chains.keys()]).toEqual([first.fileId, second!.fileId]);
    expect(engine.fileIdForPath("a.md")).toBe(first.fileId);
    expect(engine.fileIdForPath("b.md")).toBe(second!.fileId);
  });

  it("does not push a pulled file back as a second file", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    // A running host: `initialSync` is what makes local events incremental.
    await engine.initialSync();

    // A peer creates a file this engine has never seen.
    const fileId = generateFileId();
    api.paths.set(fileId, await encryptString(key, "from-peer.md"));
    await api.remoteEdit(fileId, "created by the peer");

    adapter.onWrite = async (path) => {
      adapter.onWrite = null;
      await engine.handleLocalChange(path);
    };
    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    // The echo of the pull's own write must not be mistaken for a brand new
    // local file, which would push the same content back under a new fileId.
    expect(new TextDecoder().decode(adapter.files.get("from-peer.md"))).toBe("created by the peer");
    expect(api.pushed).toHaveLength(0);
    expect([...api.chains.keys()]).toEqual([fileId]);
  });
});

/**
 * The operation matrix: two engine jobs aimed at one path, forced to overlap at the
 * window a change can open, and the invariant check afterwards. The serialized outcome
 * is the contract — no conflict copy, one chain, state and disk agreeing.
 */
describe("SyncEngine — operation interleavings", () => {
  it("applies a deletion that lands while a pass pulls the same file", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
    await api.remoteEdit(fileId, "v2");

    adapter.onWrite = async (path) => {
      if (path !== "n.md") return;
      adapter.onWrite = null;
      const deleted = await api.remoteDelete(fileId);
      await engine.handleFilePushed(fileId, deleted);
    };
    await engine.initialSync();
    adapter.onWrite = null;
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(adapter.files.has("n.md")).toBe(false);
    expect(engine.fileIdForPath("n.md")).toBeNull();
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "delete"]);
  });

  it("keeps a live empty file (the empty hash is not a tombstone by itself)", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("blank.md", encoder.encode(""));
    await engine.initialSync();
    await engine.whenIdle();

    // The chain action says "live"; the state records the empty hash and a stamp, and the
    // disk still holds the empty file.
    await expectConsistent(engine, adapter, api);
    expect(adapter.files.has("blank.md")).toBe(true);
  });

  it("records a local delete as a tombstone with no file", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("body"));
    await engine.initialSync();
    adapter.files.delete("gone.md");
    await engine.handleLocalDelete("gone.md");
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(adapter.files.has("gone.md")).toBe(false);
  });
  it("runs one bind when a second bind is requested while the first is in flight", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    const held = holdFirstPush(api);

    const first = engine.initialSync({ firstBind: true });
    await held.reached;
    // The second bind must join the first: a second pass would scan the file before the
    // first bind recorded it and push a second chain for the same note.
    const second = engine.initialSync({ firstBind: true });
    held.release();
    await Promise.all([first, second]);
    await engine.whenIdle();

    expect(api.chains.size).toBe(1);
    expect([...api.chains.values()].flat().map((version) => version.action)).toEqual(["create"]);
  });
  it("binds the vault before a rename that arrives before the first sync", async () => {
    const { engine, adapter, api } = await makeEngine();
    const oldPath = "note-2026-01-01-000000.conflict.md";
    adapter.files.set(oldPath, encoder.encode("the old copy"));
    adapter.files.set("kept.md", encoder.encode("kept"));

    // No `initialSync` first: the rename's handler binds (with the bind merge rule),
    // so the file it creates is not a second chain for content the server may hold.
    await engine.handleLocalRename(oldPath, "kept.md");
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(engine.fileIdForPath("kept.md")).toBeTruthy();
    expect(api.chains.size).toBe(1);
  });
  it("turns an untracked rename into a create without waiting for its own job", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    const parked = "note-2026-01-01-000000.conflict.md";
    adapter.files.set(parked, encoder.encode("kept"));
    adapter.files.set("kept.md", encoder.encode("kept"));

    // The rename's job holds both paths; the create work must run directly, because
    // scheduling it would wait for the job that is waiting for it.
    await engine.handleLocalRename(parked, "kept.md");
    await engine.whenIdle();

    expect(engine.fileIdForPath("kept.md")).toBeTruthy();
    expect(api.chains.size).toBe(1);
  });
  it("binds outside the path queue when an event arrives before the first sync", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));

    // No `initialSync` first: the event must bind the vault without waiting for its own
    // job (the bind's per-file job queues on the path the event's job holds).
    await engine.handleLocalChange("n.md");
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(api.chains.size).toBe(1);
    expect(engine.fileIdForPath("n.md")).toBeTruthy();
  });
  it("reports a deferred event's push failure through onError", async () => {
    const failures: Array<{ error: unknown; paths: readonly string[] }> = [];
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (error, paths) => failures.push({ error, paths }),
    );
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = await syncedFileId(api);
    await api.remoteEdit(fileId, "v2");

    // A user edit that lands right after the pull's write: the event is fired from inside
    // the adapter call, so its job is deferred (it must not wait for the write), and its
    // push fails. The adapter has no place for that rejection, so `onError` must get it.
    adapter.onWrite = async (path) => {
      if (path !== "n.md") return;
      adapter.onWrite = null;
      adapter.files.set("n.md", encoder.encode("local edit"));
      api.onPush = async () => {
        throw new Error("network down");
      };
      void engine.handleLocalChange("n.md");
    };
    await engine.initialSync();
    await engine.whenIdle();
    adapter.onWrite = null;
    api.onPush = null;

    expect(failures).toHaveLength(1);
    expect(String(failures[0].error)).toContain("network down");
    expect(failures[0].paths).toEqual(["n.md"]);
  });
  it("settles one version when a pass and a notification run at the same time", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
    await api.remoteEdit(fileId, "v2");

    // Both jobs start without waiting for each other; the path queue orders them.
    const notified = engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);
    const pass = engine.initialSync();
    await Promise.all([notified, pass]);
    await engine.whenIdle();

    await expectConsistent(engine, adapter, api);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("v2");
    expect(syncPointOf(engine, fileId)).toBe(await api.latestVersionId(fileId));
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
  });
});
