import {
  FakeAdapter,
  FakeApi,
  NO_SETTINGS_GROUPS,
  SyncEngine,
  conflictFilePath,
  conflictPaths,
  deriveEncryptionKey,
  describe,
  encoder,
  encryptCombinedBytes,
  encryptString,
  expect,
  expectConsistent,
  freezeConflictClock,
  generateVersionId,
  it,
  makeEngine,
  normalizeScope,
  plain,
  rateLimited,
  realPlatform,
  sha256Hex,
  syncPointOf,
  textOf,
  vi,
} from "./engine.test-helpers";
import type { ConflictResolvedEvent, SyncActivityEvent } from "./engine.test-helpers";

freezeConflictClock();

/**
 * Two chains can name one path for a moment. A peer's move (or delete) is recorded on
 * the server while this device's file is still at the old path, and another device can
 * have created a new chain at that path. The pass is concurrent now, so without a path
 * claim the remote-only chain reads the other chain's file as a divergence and parks a
 * conflict copy of content that never conflicted — the serial pass was what hid this.
 */
/**
 * Seed chain X at `old.md` on a source device, bind a target to it, then let a second
 * device change X (move it away or delete it) and create a note at `old.md`. The
 * target still has X's file at the old path when its next pass starts.
 */
async function prepare(kind: "move" | "delete") {
  const key = await deriveEncryptionKey(
    "password",
    btoa(String.fromCharCode(...new Uint8Array(32))),
  );
  const api = new FakeApi(key);
  const sourceAdapter = new FakeAdapter();
  sourceAdapter.files.set("old.md", encoder.encode("old"));
  const source = new SyncEngine({
    platform: realPlatform,
    vaultId: "vault-1",
    adapter: sourceAdapter,
    api,
    encryptionKey: key,
  });
  await source.initialSync();
  const originalId = source.fileIdForPath("old.md")!;

  const targetAdapter = new FakeAdapter();
  targetAdapter.files.set("old.md", encoder.encode("old"));
  const conflicts: ConflictResolvedEvent[] = [];
  const target = new SyncEngine({
    platform: realPlatform,
    vaultId: "vault-1",
    adapter: targetAdapter,
    api,
    encryptionKey: key,
    // The production concurrency: both tasks are free to start together.
    opLimits: { maxConcurrent: 4, exclusiveBytes: 8 * 1024 * 1024 },
    onConflictResolved: (event) => conflicts.push(event),
  });
  await target.initialSync();

  if (kind === "move") {
    await api.remoteEdit(originalId, "moved");
    await api.remoteRename(originalId, await encryptString(key, "new.md"));
  } else {
    await api.remoteDelete(originalId);
  }

  // A second device puts a new note at the path this device still holds. It is a
  // first bind on that device, so it keeps its own file instead of applying X's
  // deletion — the chain it creates is the one that must land at `old.md`.
  const peerAdapter = new FakeAdapter();
  peerAdapter.files.set("old.md", encoder.encode("new note"));
  const peer = new SyncEngine({
    platform: realPlatform,
    vaultId: "vault-1",
    adapter: peerAdapter,
    api,
    encryptionKey: key,
  });
  await peer.initialSync({ firstBind: true });

  return { target, targetAdapter, conflicts };
}

/**
 * A second chain that also records `pathCipher`, with its own head stamped `createdAt`.
 * That is the state a forked rename, or a device that created the same note, leaves behind.
 */
async function seedChainAt(
  api: FakeApi,
  key: CryptoKey,
  pathCipher: string,
  chain: { fileId: string; versionId: string; text: string; createdAt: string },
): Promise<void> {
  const bytes = encoder.encode(chain.text);
  const contentHash = await sha256Hex(bytes);
  api.blobs.set(contentHash, await encryptCombinedBytes(key, bytes as Uint8Array<ArrayBuffer>));
  api.paths.set(chain.fileId, pathCipher);
  api.chains.set(chain.fileId, [
    {
      versionId: chain.versionId,
      contentHash,
      encryptedPath: pathCipher,
      action: "create",
      sizeBytes: bytes.byteLength,
      mtimeMs: 1,
      createdAt: chain.createdAt,
    },
  ]);
}

describe("SyncEngine — two chains naming one path", () => {
  it("applies a peer's move before a new chain at the old path decides", async () => {
    const { target, targetAdapter, conflicts } = await prepare("move");

    await target.initialSync();

    expect(textOf(targetAdapter, "new.md")).toBe("moved");
    expect(textOf(targetAdapter, "old.md")).toBe("new note");
    expect(conflictPaths(targetAdapter)).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("applies a peer's delete before a new chain at the vacated path decides", async () => {
    const { target, targetAdapter, conflicts } = await prepare("delete");

    await target.initialSync();

    expect(textOf(targetAdapter, "old.md")).toBe("new note");
    expect(conflictPaths(targetAdapter)).toEqual([]);
    expect(conflicts).toEqual([]);
  });

  it("keeps the path's own bytes when an older chain names it too", async () => {
    const key = await deriveEncryptionKey(
      "password",
      btoa(String.fromCharCode(...new Uint8Array(32))),
    );
    const api = new FakeApi(key);
    const adapter = new FakeAdapter();
    adapter.files.set("note.md", encoder.encode("v2-new"));
    const engine = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    await engine.initialSync();
    const owner = engine.fileIdForPath("note.md")!;
    const pathCipher = api.chains.get(owner)![0]!.encryptedPath;

    // A second chain that also records `note.md`, with older bytes and an older head: the
    // leftover of a rename that forked, or a device that arrived with the same path.
    await seedChainAt(api, key, pathCipher, {
      fileId: "fileId-older",
      versionId: "version-older",
      text: "v1-old",
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    await engine.initialSync();

    // The older chain may not decide the file: no revert, and no conflict copy of bytes
    // that were never in conflict with it.
    expect(textOf(adapter, "note.md")).toBe("v2-new");
    expect(conflictPaths(adapter)).toEqual([]);
  });

  it("does not let an older chain's notification overwrite the path", async () => {
    const key = await deriveEncryptionKey(
      "password",
      btoa(String.fromCharCode(...new Uint8Array(32))),
    );
    const api = new FakeApi(key);
    const adapter = new FakeAdapter();
    adapter.files.set("note.md", encoder.encode("v2-new"));
    const engine = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    await engine.initialSync();
    const pathCipher = api.chains.get(engine.fileIdForPath("note.md")!)![0]!.encryptedPath;
    await seedChainAt(api, key, pathCipher, {
      fileId: "fileId-older",
      versionId: "version-older",
      text: "v1-old",
      createdAt: "2020-01-01T00:00:00.000Z",
    });

    // The push of the older chain is announced: the notification is the same decision the
    // pass makes, so it must lose the path here too (the pass is five minutes away).
    await engine.handleFilePushedBatch([{ fileId: "fileId-older", versionId: "version-older" }]);

    expect(textOf(adapter, "note.md")).toBe("v2-new");
    expect(conflictPaths(adapter)).toEqual([]);
  });

  it("applies a newer chain's notification over the path it takes", async () => {
    const key = await deriveEncryptionKey(
      "password",
      btoa(String.fromCharCode(...new Uint8Array(32))),
    );
    const api = new FakeApi(key);
    const adapter = new FakeAdapter();
    adapter.files.set("note.md", encoder.encode("v1-mine"));
    const engine = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    await engine.initialSync();
    const pathCipher = api.chains.get(engine.fileIdForPath("note.md")!)![0]!.encryptedPath;
    await seedChainAt(api, key, pathCipher, {
      fileId: "fileId-newer",
      versionId: "version-newer",
      text: "v2-theirs",
      createdAt: "2030-01-01T00:00:00.000Z",
    });

    await engine.handleFilePushedBatch([{ fileId: "fileId-newer", versionId: "version-newer" }]);

    // The newer chain owns the path: its bytes land and this device's copy is parked, so
    // nothing is lost when the two genuinely diverged.
    expect(textOf(adapter, "note.md")).toBe("v2-theirs");
    expect(conflictPaths(adapter)).toHaveLength(1);
    expect(plain(adapter.files.get(conflictPaths(adapter)[0]!))).toBe("v1-mine");
  });

  it("converges two devices that created the same path out of touch", async () => {
    const key = await deriveEncryptionKey(
      "password",
      btoa(String.fromCharCode(...new Uint8Array(32))),
    );
    const api = new FakeApi(key);
    const aAdapter = new FakeAdapter();
    const bAdapter = new FakeAdapter();
    const a = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: aAdapter,
      api,
      encryptionKey: key,
    });
    const b = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: bAdapter,
      api,
      encryptionKey: key,
    });

    // B creates the note; A cannot see that chain yet and creates its own at the same
    // path, exactly what two devices out of touch leave behind.
    bAdapter.files.set("note.md", encoder.encode("from-b"));
    await b.initialSync();
    const bChain = [...api.chains.entries()];
    for (const [fileId] of bChain) api.chains.delete(fileId);
    aAdapter.files.set("note.md", encoder.encode("from-a"));
    await a.initialSync();
    for (const [fileId, chain] of bChain) api.chains.set(fileId, chain);

    // The frozen clock stamps both heads in the same millisecond, so the fileId is the
    // tie-break both devices apply (see `pathOwners`).
    const winner = [...api.chains.keys()].reduce((left, right) => (left < right ? left : right));
    const winningText = winner === a.fileIdForPath("note.md") ? "from-a" : "from-b";
    for (let round = 0; round < 3; round += 1) {
      await a.initialSync();
      await b.initialSync();
      // Both devices pick the same chain by the server's own stamp, so the note settles
      // instead of each device handing the other's bytes back to its own chain.
      expect(textOf(aAdapter, "note.md"), `round ${round} on a`).toBe(winningText);
      expect(textOf(bAdapter, "note.md"), `round ${round} on b`).toBe(winningText);
    }
    // The loser is parked once, on the device that held it, and never again.
    const parked = [...conflictPaths(aAdapter), ...conflictPaths(bAdapter)];
    expect(parked).toHaveLength(1);
  });
});

/**
 * The host-facing activity feed.
 *
 * It is not a sync rule: the engine decides exactly the same without a listener. What
 * these cases pin is that the decision is reported **when it is made** — direction,
 * outcome and, for a skip, the switch that fired — so the plugin's history can freeze a
 * row instead of reconstructing it from the server's chains and today's settings.
 */
describe("sync activity", () => {
  it("records a local create as outgoing, with the action it pushed", async () => {
    const events: SyncActivityEvent[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => events.push(event),
    );
    adapter.files.set("notes/a.md", encoder.encode("# A"));

    await engine.initialSync();

    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "out",
        outcome: "applied",
        plainPath: "notes/a.md",
        action: "create",
        versionId: expect.any(String),
      }),
    );
  });

  it("records a pulled remote version as incoming, and a converged pass as nothing", async () => {
    const sender = await makeEngine();
    sender.adapter.files.set("n.md", encoder.encode("v1"));
    await sender.engine.initialSync();

    const events: SyncActivityEvent[] = [];
    const receiverAdapter = new FakeAdapter();
    const receiver = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: receiverAdapter,
      api: sender.api,
      encryptionKey: sender.key,
      onSyncActivity: (event) => events.push(event),
    });
    await receiver.initialSync();

    expect(plain(receiverAdapter.files.get("n.md"))).toBe("v1");
    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "in",
        outcome: "applied",
        plainPath: "n.md",
        action: "create",
      }),
    );

    // A second pass sees the same bytes at the same sync point: nothing was applied, so
    // nothing may be reported (the row would otherwise repeat every reconcile).
    const seen = events.length;
    await receiver.initialSync();
    expect(events.length).toBe(seen);
  });

  it("records a live notification for a path the scope leaves out, naming the switch", async () => {
    // A chain merely discovered by a bind is not activity; a notification that arrives
    // while the device is running is. The receiver is told about the push as if its
    // socket had delivered it.
    const sender = await makeEngine(
      undefined,
      undefined,
      normalizeScope({ configDir: ".obsidian", settingsGroups: { corePlugins: true } }),
    );
    sender.adapter.files.set(".obsidian/core-plugins.json", encoder.encode("{}"));
    await sender.engine.initialSync();
    const fileId = sender.api.pushed[0].fileId;
    const head = await sender.api.latestVersionId(fileId);

    const events: SyncActivityEvent[] = [];
    const receiverAdapter = new FakeAdapter();
    const receiver = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: receiverAdapter,
      api: sender.api,
      encryptionKey: sender.key,
      syncScope: normalizeScope({ configDir: ".obsidian", settingsGroups: NO_SETTINGS_GROUPS }),
      onSyncActivity: (event) => events.push(event),
    });
    await receiver.handleFilePushed(fileId, head!, "Mobile");

    expect(receiverAdapter.files.has(".obsidian/core-plugins.json")).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "in",
        outcome: "skipped",
        reason: "settingsGroup",
        plainPath: ".obsidian/core-plugins.json",
        action: "create",
        deviceName: "Mobile",
      }),
    );
  });

  it("records a local file over the size cap as an outgoing skip", async () => {
    const events: SyncActivityEvent[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      normalizeScope({ maxFileBytes: 4 }),
      undefined,
      undefined,
      (event) => events.push(event),
    );
    adapter.files.set("big.md", encoder.encode("12345"));

    await engine.initialSync();

    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "out",
        outcome: "skipped",
        reason: "size",
        plainPath: "big.md",
        action: null,
        sizeBytes: 5,
      }),
    );
  });

  it("records a path the API cannot carry as skipped, before a version exists", async () => {
    const events: SyncActivityEvent[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => events.push(event),
    );
    const path = `${"a".repeat(600)}.md`;
    adapter.files.set(path, encoder.encode("deep"));

    await engine.initialSync();

    expect(events).toContainEqual(
      expect.objectContaining({
        direction: "out",
        outcome: "skipped",
        reason: "pathTooLong",
        plainPath: path,
        versionId: null,
      }),
    );
  });

  it("does not re-report a version this device already applied", async () => {
    // A `files_pushed` that names the head this device already holds is not an incoming
    // change: it adds no row and writes nothing. (A size cap used to be the reason such
    // a notification was skipped; the cap now bounds uploads only, so the rule that
    // matters is "already applied".)
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("hello"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;
    const head = await api.latestVersionId(fileId);
    expect(head).not.toBeNull();

    const events: SyncActivityEvent[] = [];
    const reopened = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
      syncScope: normalizeScope({}),
      onSyncActivity: (event) => events.push(event),
    });
    reopened.loadState(engine.serializeState());
    await reopened.initialSync();
    await reopened.handleFilePushed(fileId, head!);

    expect(events.filter((event) => event.direction === "in")).toEqual([]);
  });

  it("only uses the notified device label when the head is the notified version", async () => {
    const sender = await makeEngine();
    sender.adapter.files.set("n.md", encoder.encode("v1"));
    await sender.engine.initialSync();
    const fileId = sender.api.pushed[0].fileId;
    await sender.api.remoteEdit(fileId, "v2");
    const chain = sender.api.chains.get(fileId)!;
    const older = chain[0]!.versionId;
    const head = chain.at(-1)!.versionId;

    // A notification for a version that is no longer the head cannot name the client
    // whose version this device is about to apply.
    const olderEvents: SyncActivityEvent[] = [];
    const olderReceiver = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: new FakeAdapter(),
      api: sender.api,
      encryptionKey: sender.key,
      onSyncActivity: (event) => olderEvents.push(event),
    });
    await olderReceiver.handleFilePushed(fileId, older, "Mobile");
    expect(olderEvents).toContainEqual(
      expect.objectContaining({
        direction: "in",
        outcome: "applied",
        plainPath: "n.md",
        deviceName: null,
      }),
    );

    // The head's own notification carries the pusher's label.
    const headEvents: SyncActivityEvent[] = [];
    const headReceiver = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: new FakeAdapter(),
      api: sender.api,
      encryptionKey: sender.key,
      onSyncActivity: (event) => headEvents.push(event),
    });
    await headReceiver.handleFilePushed(fileId, head, "Mobile");
    expect(headEvents).toContainEqual(
      expect.objectContaining({
        direction: "in",
        outcome: "applied",
        plainPath: "n.md",
        deviceName: "Mobile",
      }),
    );
  });

  it("keeps a throwing listener from failing the push it reports", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error("the log listener blew up");
      },
    );
    adapter.files.set("n.md", encoder.encode("v1"));

    await expect(engine.initialSync()).resolves.toBeUndefined();
    expect(api.pushed).toHaveLength(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("sync-activity listener failed");
    error.mockRestore();
  });
});

/**
 * A burst of local events, carried out as one job (`handleLocalEvents`).
 *
 * The host collects a bulk write's events and hands their paths over; the engine must make
 * the same per-path decisions a single event would, then send what they produce in batches
 * (100 versions per request) and settle each answer with the single-file path's rules.
 */
/** Write `count` notes into the fake vault, and answer their paths. */
function seed(adapter: FakeAdapter, count: number, body = "v1"): string[] {
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = `batch/n-${index}.md`;
    adapter.files.set(path, encoder.encode(`# ${index} ${body}`));
    paths.push(path);
  }
  return paths;
}

describe("SyncEngine — a batch of local events", () => {
  it("sends the batch's creates 100 files per request", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    const paths = seed(adapter, 120);

    await engine.handleLocalEvents({ changed: paths });

    expect(api.pushCalls).toEqual([100, 20]);
    expect(api.pushed.every((file) => file.action === "create")).toBe(true);
    // The batch recorded every identity it created, so a later event for the same path
    // adopts the chain instead of forking a second one.
    for (const path of paths) expect(engine.fileIdForPath(path)).not.toBeNull();
    await expectConsistent(engine, adapter, api);
  });

  it("edits a tracked note from the chain it fetched alongside the batch", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("edit.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("edit.md")!;
    const base = syncPointOf(engine, fileId);
    const created = seed(adapter, 150);

    adapter.files.set("edit.md", encoder.encode("v2"));
    // A mixed batch: one tracked edit and 150 creates, all decided together.
    const before = api.pushCalls.length;
    await engine.handleLocalEvents({ changed: ["edit.md", ...created] });

    const edit = api.pushed.filter((file) => file.fileId === fileId).at(-1)!;
    expect(edit.action).toBe("modify");
    expect(edit.baseVersionId).toBe(base);
    // 151 versions →two requests, the edit in the first with 99 creates.
    expect(api.pushCalls.slice(before).reduce((total, count) => total + count, 0)).toBe(151);
    await expectConsistent(engine, adapter, api);
  });

  it("sends a batch's tombstones 100 files per request", async () => {
    const { engine, adapter, api } = await makeEngine();
    const paths = seed(adapter, 120);
    await engine.initialSync();
    const fileIds = paths.map((path) => engine.fileIdForPath(path)!);
    for (const path of paths) adapter.files.delete(path);
    const before = api.pushCalls.length;

    await engine.handleLocalEvents({ deleted: paths });

    expect(api.pushCalls.slice(before)).toEqual([100, 20]);
    for (const fileId of fileIds) {
      expect(api.chains.get(fileId)!.at(-1)!.action).toBe("delete");
    }
    await expectConsistent(engine, adapter, api);
  });

  it("reads a delete and a rewrite of one path in one batch as an edit, not a deletion", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("in-place.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("in-place.md")!;
    const before = api.pushCalls.length;

    // A tool that replaces a file in place: the watcher can report the removal and the new
    // write in the same window. The file is there, so the removal is not a deletion.
    adapter.files.set("in-place.md", encoder.encode("v2"));
    await engine.handleLocalEvents({ changed: ["in-place.md"], deleted: ["in-place.md"] });

    expect(api.pushCalls.slice(before)).toEqual([1]);
    expect(api.pushed.at(-1)!.action).toBe("modify");
    expect(api.chains.get(fileId)!.map((version) => version.action)).toEqual(["create", "modify"]);
    expect(new TextDecoder().decode(adapter.files.get("in-place.md"))).toBe("v2");
    await expectConsistent(engine, adapter, api);
  });

  it("does not tombstone a path that was recreated before the batch was decided", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("undo.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("undo.md")!;

    // Trash and undo: the recreate is decided on its own event first, and the host holds
    // the deletion for a sequence before the batch runs. A batch cannot see the two events
    // in order, so the absence is checked on disk — a tombstone here would trash a live
    // note on every peer and reset the chain.
    adapter.files.set("undo.md", encoder.encode("v2"));
    await engine.handleLocalChange("undo.md");
    const before = api.pushCalls.length;

    await engine.handleLocalEvents({ deleted: ["undo.md"] });

    expect(api.pushCalls.slice(before)).toEqual([]);
    expect(api.chains.get(fileId)!.map((version) => version.action)).toEqual(["create", "modify"]);
    await expectConsistent(engine, adapter, api);
  });

  it("stamps a batch's tombstone with the moment the deletion happened", async () => {
    const { engine, adapter, api } = await makeEngine();
    const paths = seed(adapter, 1);
    await engine.initialSync();
    for (const path of paths) adapter.files.delete(path);

    // The host holds a deletion before the batch runs; the moment a peer compares is the
    // deletion's, not the flush's (a config-folder conflict is settled on it).
    const deletedAt = Date.now() - 5_000;
    await engine.handleLocalEvents({
      deleted: paths,
      deletedAtMs: { [paths[0]!]: deletedAt },
    });

    const tombstone = api.pushed.at(-1)!;
    expect(tombstone.action).toBe("delete");
    expect(tombstone.mtimeMs).toBe(deletedAt);
  });

  it("settles a refused create through its own lost-response handling", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    let raced = false;
    // The server accepts a competing version of this chain before it processes the batch:
    // the same bytes, so the retry must adopt that head rather than push again.
    api.onPush = async (files) => {
      if (raced) return;
      raced = true;
      for (const file of files) {
        api.chains.set(file.fileId, [
          {
            versionId: generateVersionId(),
            contentHash: file.contentHash,
            encryptedPath: file.encryptedPath,
            action: "create",
            sizeBytes: file.sizeBytes,
            mtimeMs: file.mtimeMs,
            createdAt: new Date().toISOString(),
          },
        ]);
        api.blobs.set(file.contentHash, file.content!);
        api.paths.set(file.fileId, file.encryptedPath);
      }
    };

    adapter.files.set("raced.md", encoder.encode("raced"));
    await engine.handleLocalEvents({ changed: ["raced.md"] });
    api.onPush = null;

    const fileId = engine.fileIdForPath("raced.md")!;
    // The batch's request was refused (`stale_base`) and the version was re-sent alone;
    // the head holds the same bytes, so it became this device's sync point.
    expect(api.pushCalls).toEqual([1, 1]);
    expect(syncPointOf(engine, fileId)).toBe(api.chains.get(fileId)!.at(-1)!.versionId);
    await expectConsistent(engine, adapter, api);
  });

  it("re-decides a tracked edit refused inside the batch", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("raced.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("raced.md")!;
    let raced = false;
    // A peer pushes after this batch fetched the chain, so the edit's base is stale.
    api.onPush = async () => {
      if (raced) return;
      raced = true;
      await api.remoteEdit(fileId, "peer-v2");
    };

    adapter.files.set("raced.md", encoder.encode("local-v2"));
    await engine.handleLocalEvents({ changed: ["raced.md"] });
    api.onPush = null;

    // The refusal is settled by deciding again from the fresh chain: the peer's version
    // wins and the local edit is parked beside it.
    expect(new TextDecoder().decode(adapter.files.get("raced.md"))).toBe("peer-v2");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("raced.md")))).toBe(
      "local-v2",
    );
    await expectConsistent(engine, adapter, api);
  });

  it("settles a refused tombstone as the deletion that raced an edit", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("raced.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("raced.md")!;
    let raced = false;
    api.onPush = async () => {
      if (raced) return;
      raced = true;
      await api.remoteEdit(fileId, "peer-v2");
    };

    adapter.files.delete("raced.md");
    await engine.handleLocalEvents({ deleted: ["raced.md"] });
    api.onPush = null;

    // The peer pushed after the point the delete was decided from: the remote side wins
    // and — the local file being gone — its version comes back.
    expect(new TextDecoder().decode(adapter.files.get("raced.md"))).toBe("peer-v2");
    expect(api.chains.get(fileId)!.map((version) => version.action)).toEqual(["create", "modify"]);
    await expectConsistent(engine, adapter, api);
  });

  it("moves a batch of notes with 100 content-less versions per request", async () => {
    const { engine, adapter, api } = await makeEngine();
    const paths = seed(adapter, 120);
    await engine.initialSync();
    const pushesBefore = api.pushed.length;
    const before = api.pushCalls.length;

    const pairs = paths.map((path, index) => {
      const to = `moved/n-${index}.md`;
      const bytes = adapter.files.get(path)!;
      adapter.files.delete(path);
      adapter.files.set(to, bytes);
      return { from: path, to };
    });
    await engine.handleLocalEvents({ renamed: pairs });

    expect(api.pushCalls.slice(before)).toEqual([100, 20]);
    const moved = api.pushed.slice(pushesBefore);
    expect(moved).toHaveLength(120);
    // A move sends no content: the chain's head already holds those bytes.
    expect(moved.every((file) => file.action === "rename" && file.content === null)).toBe(true);
    for (const pair of pairs) expect(engine.fileIdForPath(pair.to)).not.toBeNull();
    await expectConsistent(engine, adapter, api);
  });

  it("turns a move of an untracked file into a batch create", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();

    // The source was never tracked (created and moved between two events): the move is a
    // create at the destination, decided with the batch's other changes.
    adapter.files.set("moved/here.md", encoder.encode("never seen"));
    await engine.handleLocalEvents({
      renamed: [{ from: "was/elsewhere.md", to: "moved/here.md" }],
    });

    expect(api.pushed.at(-1)!.action).toBe("create");
    expect(engine.fileIdForPath("moved/here.md")).not.toBeNull();
    await expectConsistent(engine, adapter, api);
  });

  it("re-points a move that leaves the scope without pushing anything", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("keep me"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;
    const syncPoint = syncPointOf(engine, fileId);
    const before = api.pushCalls.length;

    // The destination is outside this device's sync set (a config-folder path with every
    // settings group off): the chain follows the file, nothing is published, and a later
    // pass must not read the old path as a deletion.
    adapter.files.delete("note.md");
    adapter.files.set(".obsidian/plugins/x/data.json", encoder.encode("keep me"));
    await engine.handleLocalEvents({
      renamed: [{ from: "note.md", to: ".obsidian/plugins/x/data.json" }],
    });

    expect(api.pushCalls).toHaveLength(before);
    expect(syncPointOf(engine, fileId)).toBe(syncPoint);
    expect(engine.fileIdForPath("note.md")).toBeNull();
    await expectConsistent(engine, adapter, api);
  });

  it("settles a refused move by deciding again at the destination", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("old.md")!;
    let raced = false;
    // A peer edits the chain after the batch fetched it, so the move's base is stale.
    api.onPush = async () => {
      if (raced) return;
      raced = true;
      await api.remoteEdit(fileId, "peer-v2");
    };

    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("v1"));
    await expect(
      engine.handleLocalEvents({ renamed: [{ from: "old.md", to: "new.md" }] }),
    ).resolves.toBeUndefined();
    api.onPush = null;

    // The refusal is settled by deciding again from the fresh chain: the peer's version is
    // the one this device ends up holding.
    expect(api.chains.get(fileId)!.at(-1)!.action).toBe("modify");
    expect(syncPointOf(engine, fileId)).not.toBeNull();
    await expectConsistent(engine, adapter, api);
  });

  it("re-points a single move out of the scope without pushing", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("keep me"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;
    const syncPoint = syncPointOf(engine, fileId);
    const before = api.pushCalls.length;

    adapter.files.delete("note.md");
    adapter.files.set(".obsidian/plugins/x/data.json", encoder.encode("keep me"));
    await engine.handleLocalRename("note.md", ".obsidian/plugins/x/data.json");

    expect(api.pushCalls).toHaveLength(before);
    expect(syncPointOf(engine, fileId)).toBe(syncPoint);
    expect(engine.fileIdForPath("note.md")).toBeNull();
  });

  it("ignores a move of an untracked file onto a path it already tracks", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("b.md", encoder.encode("b"));
    await engine.initialSync();
    const before = api.pushCalls.length;

    // The source was never tracked and the destination is already a chain: the event
    // cannot re-point anything, and it must not create a second chain there.
    adapter.files.set("c.md", encoder.encode("c"));
    await engine.handleLocalRename("c.md", "b.md");

    expect(api.pushCalls).toHaveLength(before);
    expect(engine.fileIdForPath("b.md")).not.toBeNull();
    expect(engine.fileIdForPath("c.md")).toBeNull();
  });

  it("ignores an empty batch, and one entirely outside the scope", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("x"));
    await engine.initialSync();
    const before = api.pushCalls.length;

    // Nothing to decide, and nothing this device syncs: no pass, no listing, no request.
    await engine.handleLocalEvents({});
    await engine.handleLocalEvents({
      changed: [".obsidian/app.json"],
      deleted: [".obsidian/appearance.json"],
      renamed: [{ from: ".obsidian/a.json", to: ".obsidian/b.json" }],
    });

    expect(api.pushCalls).toHaveLength(before);
    expect(engine.fileIdForPath(".obsidian/app.json")).toBeNull();
  });

  it("tombstones a move's destination before the move lands, leaving one live chain", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("dest.md", encoder.encode("old dest"));
    adapter.files.set("src.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const destId = engine.fileIdForPath("dest.md")!;
    const srcId = engine.fileIdForPath("src.md")!;
    const before = api.pushed.length;

    // A replace: the destination is removed and another file is renamed onto it, reported
    // as the two halves a watcher sees.
    adapter.files.delete("dest.md");
    adapter.files.delete("src.md");
    adapter.files.set("dest.md", encoder.encode("moved bytes"));
    await engine.handleLocalEvents({
      deleted: ["dest.md"],
      renamed: [{ from: "src.md", to: "dest.md" }],
    });

    const pushed = api.pushed.slice(before).map((push) => [push.action, push.fileId]);
    // The destination's tombstone first, then the move: a peer must delete the old file
    // before it writes the moved bytes there.
    expect(pushed).toEqual([
      ["delete", destId],
      ["rename", srcId],
    ]);
    expect(api.chains.get(destId)!.at(-1)!.action).toBe("delete");
    expect(api.chains.get(srcId)!.at(-1)!.action).toBe("rename");
    expect(engine.fileIdForPath("dest.md")).toBe(srcId);
    expect(new TextDecoder().decode(adapter.files.get("dest.md"))).toBe("moved bytes");
    await expectConsistent(engine, adapter, api);
  });

  it("replaces a destination from an untracked source: one delete, then a create", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("dest.md", encoder.encode("old dest"));
    await engine.initialSync();
    const destId = engine.fileIdForPath("dest.md")!;
    const before = api.pushed.length;

    // The source was never tracked (a temp file, a file that appeared and replaced another):
    // the move is a create at the destination, and the destination's chain must be retired
    // first — the stale index would otherwise pull the deleted bytes over it.
    adapter.files.set("tmp.md", encoder.encode("moved bytes"));
    adapter.files.delete("dest.md");
    adapter.files.delete("tmp.md");
    adapter.files.set("dest.md", encoder.encode("moved bytes"));
    await engine.handleLocalEvents({
      deleted: ["dest.md"],
      renamed: [{ from: "tmp.md", to: "dest.md" }],
    });

    const pushed = api.pushed.slice(before).map((push) => [push.action, push.fileId]);
    expect(pushed[0]).toEqual(["delete", destId]);
    expect(pushed[1]?.[0]).toBe("create");
    expect(api.chains.get(destId)!.at(-1)!.action).toBe("delete");
    expect(new TextDecoder().decode(adapter.files.get("dest.md"))).toBe("moved bytes");
    expect(adapter.files.has(conflictFilePath("dest.md"))).toBe(false);
    const createdId = engine.fileIdForPath("dest.md")!;
    expect(createdId).not.toBe(destId);
    expect(api.chains.get(createdId)!.at(-1)!.contentHash).toBe(
      await sha256Hex(encoder.encode("moved bytes")),
    );
    await expectConsistent(engine, adapter, api);
  });

  it("does not move onto a destination whose tombstone could not land", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("dest.md", encoder.encode("old dest"));
    adapter.files.set("src.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const destId = engine.fileIdForPath("dest.md")!;
    const srcId = engine.fileIdForPath("src.md")!;
    const before = api.pushed.length;

    adapter.files.delete("dest.md");
    adapter.files.delete("src.md");
    adapter.files.set("dest.md", encoder.encode("moved bytes"));
    const realPush = api.push.bind(api);
    api.push = async () => {
      throw Object.assign(new Error("refused"), { status: 409, code: "STALE_BASE" });
    };
    try {
      await expect(
        engine.handleLocalEvents({
          deleted: ["dest.md"],
          renamed: [{ from: "src.md", to: "dest.md" }],
        }),
      ).rejects.toThrow("refused");
    } finally {
      api.push = realPush;
    }

    // The destination's chain is still live, so the move is withheld rather than leaving two
    // chains at one path; the failed push is visible (the job rejects) and the pass retries.
    expect(api.pushed.slice(before).filter((push) => push.action === "rename")).toHaveLength(0);
    expect(api.chains.get(destId)!.at(-1)!.action).toBe("create");
    expect(engine.fileIdForPath("dest.md")).toBe(destId);
    expect(engine.fileIdForPath("src.md")).toBe(srcId);
  });

  it("does not adopt a peer's tombstone as the head of an empty rename", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("empty.md", new Uint8Array(0));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("empty.md")!;
    // A peer deletes the empty note; the local device renames it (a live version whose
    // content hash is also the empty hash). The tombstone must not be adopted as that
    // version's head — the peer's deletion is what the chain says.
    await api.remoteDelete(fileId);
    adapter.files.delete("empty.md");
    adapter.files.set("moved-empty.md", new Uint8Array(0));
    await engine.handleLocalRename("empty.md", "moved-empty.md");

    // The peer's tombstone is the chain's head, so the deletion lands and the moved copy
    // goes with it; nothing is resurrected.
    expect(api.chains.get(fileId)!.at(-1)!.action).toBe("delete");
    expect(adapter.files.has("moved-empty.md")).toBe(false);
    expect(engine.fileIdForPath("moved-empty.md")).toBeNull();
  });

  it("adopts a refused destination whose bytes already match the moved file", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("dest.md", encoder.encode("old dest"));
    adapter.files.set("src.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const destId = engine.fileIdForPath("dest.md")!;
    // The peer converged on exactly the moved bytes: the tombstone is refused, but there is
    // nothing to conflict over.
    await api.remoteEdit(destId, "moved bytes");
    const before = api.pushed.length;

    adapter.files.delete("dest.md");
    adapter.files.delete("src.md");
    adapter.files.set("dest.md", encoder.encode("moved bytes"));
    await engine.handleLocalEvents({
      deleted: ["dest.md"],
      renamed: [{ from: "src.md", to: "dest.md" }],
    });

    expect(api.pushed.slice(before).filter((push) => push.action === "rename")).toHaveLength(0);
    expect(adapter.files.has(conflictFilePath("dest.md"))).toBe(false);
    expect(engine.fileIdForPath("dest.md")).toBe(destId);
    expect(new TextDecoder().decode(adapter.files.get("dest.md"))).toBe("moved bytes");
  });

  it("does not move onto a destination when the tombstone hits the limiter", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("dest.md", encoder.encode("old dest"));
    adapter.files.set("src.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const destId = engine.fileIdForPath("dest.md")!;
    const srcId = engine.fileIdForPath("src.md")!;
    const before = api.pushed.length;

    adapter.files.delete("dest.md");
    adapter.files.delete("src.md");
    adapter.files.set("dest.md", encoder.encode("moved bytes"));
    const realPush = api.push.bind(api);
    api.push = async () => {
      throw rateLimited();
    };
    try {
      await expect(
        engine.handleLocalEvents({
          deleted: ["dest.md"],
          renamed: [{ from: "src.md", to: "dest.md" }],
        }),
      ).rejects.toMatchObject({ status: 429 });
    } finally {
      api.push = realPush;
    }

    // Uncertain whether it landed: the local bookkeeping names the destination's chain at the
    // path again, no move is published, and the pass retries the decision.
    expect(api.pushed.slice(before).filter((push) => push.action === "rename")).toHaveLength(0);
    expect(engine.fileIdForPath("dest.md")).toBe(destId);
    expect(engine.fileIdForPath("src.md")).toBe(srcId);
  });

  it("keeps a refused destination when its bytes cannot be read", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("dest.md", encoder.encode("old dest"));
    adapter.files.set("src.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const destId = engine.fileIdForPath("dest.md")!;
    // A peer replaced the destination with something this device cannot read back: the
    // refusal has no local bytes to compare, so it settles as a conflict without a copy.
    await api.remoteEdit(destId, "peer bytes");
    const realRead = adapter.readFile.bind(adapter);
    adapter.readFile = async (path: string) => (path === "dest.md" ? null : await realRead(path));
    const before = api.pushed.length;
    try {
      await engine.handleLocalEvents({
        deleted: ["dest.md"],
        renamed: [{ from: "src.md", to: "dest.md" }],
      });
    } finally {
      adapter.readFile = realRead;
    }

    expect(api.pushed.slice(before).filter((push) => push.action === "rename")).toHaveLength(0);
    expect(engine.fileIdForPath("dest.md")).toBe(destId);
  });

  it("does not treat a peer's empty file as the tombstone that landed", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("dest.md", encoder.encode("old dest"));
    adapter.files.set("src.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const destId = engine.fileIdForPath("dest.md")!;
    // A peer replaces the destination with an empty file: the tombstone's base is stale, and
    // every tombstone's content hash is the empty one — it must not be read as "our delete
    // landed".
    await api.remoteEdit(destId, "");
    const before = api.pushed.length;

    adapter.files.delete("dest.md");
    adapter.files.delete("src.md");
    adapter.files.set("dest.md", encoder.encode("moved bytes"));
    await engine.handleLocalEvents({
      deleted: ["dest.md"],
      renamed: [{ from: "src.md", to: "dest.md" }],
    });

    // The peer's empty version wins the path and the moved bytes are parked beside it.
    expect(api.pushed.slice(before).filter((push) => push.action === "rename")).toHaveLength(0);
    expect(api.chains.get(destId)!.at(-1)!.action).toBe("modify");
    expect(new TextDecoder().decode(adapter.files.get("dest.md"))).toBe("");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("dest.md")))).toBe(
      "moved bytes",
    );
  });

  it("keeps a second copy of a peer's content as its own chain when it moves", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("shared bytes"));
    await engine.initialSync();
    const aId = engine.fileIdForPath("a.md")!;

    // A second, untracked copy of the same content, moved while the chain's own path still
    // holds a file: the identity fallback must not merge the two by content — which it can
    // only see if the job's listing includes the destination.
    adapter.files.set("b.md", encoder.encode("shared bytes"));
    adapter.files.delete("b.md");
    adapter.files.set("c.md", encoder.encode("shared bytes"));

    await engine.handleLocalEvents({ renamed: [{ from: "b.md", to: "c.md" }] });

    expect(engine.fileIdForPath("a.md")).toBe(aId);
    expect(engine.fileIdForPath("c.md")).not.toBeNull();
    expect(engine.fileIdForPath("c.md")).not.toBe(aId);
    expect(api.chains.get(aId)!.at(-1)!.action).toBe("create");
  });

  it("does not leave a chunked create behind when the batch's upload fails", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(5));
    api.uploadChunk = async () => {
      throw new Error("chunk upload failed");
    };

    await expect(engine.handleLocalEvents({ changed: ["big.mp4"] })).rejects.toThrow(
      "chunk upload failed",
    );
    // The pending identity goes with the failed upload, not with a later pass.
    expect(engine.fileIdForPath("big.mp4")).toBeNull();
    expect(engine.serializeState()).not.toContain("big.mp4");
  }, 20_000);

  it("reads the chain index once for a job full of recreates", async () => {
    const { engine, adapter, api } = await makeEngine();
    const paths = ["a.md", "b.md", "c.md"];
    for (const path of paths) adapter.files.set(path, encoder.encode(`old ${path}`));
    await engine.initialSync();
    for (const path of paths) {
      adapter.files.delete(path);
      await engine.handleLocalDelete(path);
    }

    const realIndex = api.getVaultSyncIndex.bind(api);
    const indexReads = vi.fn(async (vaultId: string) => realIndex(vaultId));
    api.getVaultSyncIndex = indexReads;
    for (const path of paths) adapter.files.set(path, encoder.encode(`new ${path}`));

    await engine.handleLocalEvents({ changed: paths });

    // Three restores, one owner check for the job: a bulk recreate is a bulk write.
    expect(indexReads).toHaveBeenCalledTimes(1);
    expect(api.pushed.filter((push) => push.action === "restore")).toHaveLength(paths.length);
  });

  it("adopts a move whose new path a pass saw before its event", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("old.md")!;

    // The delete half is published by a burst, then the file is renamed on disk and a pass
    // lists the vault before the create's event arrives — a scheduled pass inside a bulk
    // move. The pass must adopt the chain the delete left behind, not create a second one.
    adapter.files.delete("old.md");
    await engine.handleLocalEvents({ deleted: ["old.md"] });
    adapter.files.set("new.md", encoder.encode("moved bytes"));
    await engine.initialSync();

    expect(engine.fileIdForPath("new.md")).toBe(fileId);
    expect(engine.fileIdForPath("old.md")).toBeNull();
    expect(api.chains.get(fileId)!.map((version) => version.action)).toEqual([
      "create",
      "delete",
      "rename",
    ]);
    // A rename sends no content (invariant 7): the bytes the chain already holds are named
    // by hash and size, not re-uploaded. The tombstone is why this needs pinning — it
    // overwrote the state's content hash with the empty one, so a push that reuses content
    // by that hash would carry the whole file again.
    const rename = api.pushed.filter((push) => push.action === "rename").at(-1)!;
    expect(rename.content).toBeNull();
    expect(textOf(adapter, "new.md")).toBe("moved bytes");
  });

  it("does not let a chain apply its move over a newer chain's file", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("old.md")!;

    // The peer edits and moves this chain to `new.md`; a chain created *later* owns
    // `new.md` with other bytes. The move must not apply over the owner's file — the path
    // a pull writes is the head's recorded one, not the state's.
    const newPathCipher = await encryptString(key, "new.md");
    await api.remoteEdit(fileId, "peer edit");
    await api.remoteRename(fileId, newPathCipher);
    adapter.files.set("new.md", encoder.encode("theirs"));
    await seedChainAt(api, key, newPathCipher, {
      fileId: "fileId-newer",
      versionId: "version-newer",
      text: "theirs",
      createdAt: "2030-01-01T00:00:00.000Z",
    });

    await engine.initialSync();

    expect(textOf(adapter, "new.md")).toBe("theirs");
  });

  it("does not let a notification's move take another chain's file", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("p.md", encoder.encode("mine"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("p.md")!;

    // The rival is the *older* chain at the same path, and it enters the index through its
    // own notification (no pass, so the index order is the notifications' — the case a
    // pass-only owner map cannot answer). Its bytes are the ones on disk: it applied first
    // on another device, and this one has them.
    const pCipher = await encryptString(key, "p.md");
    await seedChainAt(api, key, pCipher, {
      fileId: "fileId-rival",
      versionId: "version-rival",
      text: "theirs",
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    await engine.handleFilePushedBatch([{ fileId: "fileId-rival", versionId: "version-rival" }]);
    // The rival loses the path (this chain is the newer one at it) and writes nothing.
    expect(textOf(adapter, "p.md")).toBe("mine");
    adapter.files.set("p.md", encoder.encode("theirs"));

    // Now the peer moves *this* chain to `q.md`. Following that move would rename the file
    // at `p.md` — the rival's bytes — and write this chain's head over it. The guard has to
    // find the rival among every chain recorded at the path, not just the newest one (this
    // chain is the newest at `p.md`, so a newest-only test would let it through).
    const renameVersion = await api.remoteRename(fileId, await encryptString(key, "q.md"));

    await engine.handleFilePushedBatch([{ fileId, versionId: renameVersion }]);

    expect(textOf(adapter, "p.md")).toBe("theirs");
    expect(adapter.files.has("q.md")).toBe(false);
  });

  it("does not let a newer tombstone delete the path's owner", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("mine"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;
    const pathCipher = await encryptString(key, "note.md");

    // A newer chain owns the path, and *then* this device's chain is deleted — the
    // tombstone carries the later stamp, but a tombstone owns nothing: its conflict must not
    // delete the owner's file and park those bytes.
    await seedChainAt(api, key, pathCipher, {
      fileId: "fileId-owner",
      versionId: "version-owner",
      text: "theirs",
      createdAt: "2030-01-01T00:00:00.000Z",
    });
    await engine.initialSync();
    expect(textOf(adapter, "note.md")).toBe("theirs");

    const deleteVersion = await api.remoteDelete(fileId);
    await engine.handleFilePushedBatch([{ fileId, versionId: deleteVersion }]);

    expect(textOf(adapter, "note.md")).toBe("theirs");
  });

  it("re-points a move no event reported without sending its bytes", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("old.md")!;

    // The vault was reorganised while nothing watched: no event at all, and the pass finds
    // the chain's recorded path gone and one unclaimed file holding its bytes.
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("moved bytes"));
    await engine.initialSync();

    expect(engine.fileIdForPath("new.md")).toBe(fileId);
    expect(api.chains.get(fileId)!.map((version) => version.action)).toEqual(["create", "rename"]);
    // A rename sends no content (invariant 7) — and a pass that re-points a bulk move must
    // not hold every renamed file's plaintext until its batch drains.
    const rename = api.pushed.filter((push) => push.action === "rename").at(-1)!;
    expect(rename.content).toBeNull();
  });

  it("sends the payload when a silent re-point's blob was reclaimed", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("old.md")!;
    // The store no longer holds the blob this rename names (a reclaimed row): the rename is
    // refused with `content_missing`, and has to be re-sent with the verified payload, or
    // the move is refused on every pass from then on.
    for (const [hash] of api.blobs) {
      if (api.chains.get(fileId)!.some((version) => version.contentHash === hash)) {
        api.blobs.delete(hash);
      }
    }

    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("moved bytes"));
    await engine.initialSync();

    expect(api.chains.get(fileId)!.map((version) => version.action)).toEqual(["create", "rename"]);
    // The retry carried the bytes, so the blob is stored again under the same hash.
    expect(api.blobs.has(api.chains.get(fileId)!.at(-1)!.contentHash)).toBe(true);
  });

  it("turns a move the watcher reports as delete+create into one rename", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("moved bytes"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("old.md")!;
    const before = api.pushed.length;

    // The CLI's `fs.watch` (and an external tool) reports a move as its two halves: the
    // old path gone and a new path created. The chain never left the tree, so the batch
    // must send one content-less rename — not a tombstone the rename then races.
    adapter.files.delete("old.md");
    adapter.files.set("new.md", encoder.encode("moved bytes"));
    await engine.handleLocalEvents({ changed: ["new.md"], deleted: ["old.md"] });

    const pushed = api.pushed.slice(before);
    expect(pushed.map((push) => push.action)).toEqual(["rename"]);
    expect(pushed[0]!.fileId).toBe(fileId);
    expect(pushed[0]!.content).toBeNull();
    expect(engine.fileIdForPath("new.md")).toBe(fileId);
    expect(engine.fileIdForPath("old.md")).toBeNull();
    expect(api.chains.get(fileId)!.map((version) => version.action)).toEqual(["create", "rename"]);
    expect(adapter.files.has(conflictFilePath("new.md"))).toBe(false);
    await expectConsistent(engine, adapter, api);
  });

  it("leaves no pending identity when the job fails outside the request", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("tracked.md", encoder.encode("v1"));
    await engine.initialSync();
    adapter.files.set("tracked.md", encoder.encode("v2"));
    adapter.files.set("new.md", encoder.encode("new"));

    // The create is prepared and its identity recorded before the tracked chains are read;
    // that read failing must take the identity back, or the next pass pushes the create
    // one request at a time instead of through the batch.
    const realPull = api.pull.bind(api);
    api.pull = async () => {
      throw new Error("pull failed");
    };
    try {
      await expect(engine.handleLocalEvents({ changed: ["tracked.md", "new.md"] })).rejects.toThrow(
        "pull failed",
      );
    } finally {
      api.pull = realPull;
    }

    expect(engine.fileIdForPath("new.md")).toBeNull();
    await engine.initialSync();
    expect(engine.fileIdForPath("new.md")).not.toBeNull();
    await expectConsistent(engine, adapter, api);
  });

  it("reports a recreate it could not hand to the owning chain", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("reborn.md", encoder.encode("first life"));
    await engine.initialSync();
    const mine = engine.fileIdForPath("reborn.md")!;
    adapter.files.delete("reborn.md");
    await engine.handleLocalDelete("reborn.md");

    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    peerAdapter.files.set("reborn.md", encoder.encode("theirs"));
    await peer.initialSync();
    const theirs = peer.fileIdForPath("reborn.md")!;
    // The owning chain's bytes are gone from the store, so the apply cannot succeed.
    api.blobs.delete(api.chains.get(theirs)!.at(-1)!.contentHash);

    adapter.files.set("reborn.md", encoder.encode("second life"));
    await expect(engine.handleLocalEvents({ changed: ["reborn.md"] })).rejects.toThrow(
      /Could not read the content of reborn\.md/,
    );
    // Nothing was published for this device's dead chain, and the local copy survives for
    // the next pass to retry.
    expect(api.chains.get(mine)!.map((version) => version.action)).toEqual(["create", "delete"]);
    expect(new TextDecoder().decode(adapter.files.get("reborn.md"))).toBe("second life");
  });

  it("does not resurrect a chain whose path another chain already owns", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("reborn.md", encoder.encode("first life"));
    await engine.initialSync();
    const mine = engine.fileIdForPath("reborn.md")!;
    adapter.files.delete("reborn.md");
    await engine.handleLocalDelete("reborn.md");

    // A peer creates a *different* chain at the same path while this device's chain is a
    // tombstone (the shape an offline delete + a peer's new note makes).
    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    peerAdapter.files.set("reborn.md", encoder.encode("theirs"));
    await peer.initialSync();
    const theirs = peer.fileIdForPath("reborn.md")!;
    expect(theirs).not.toBe(mine);

    // The recreate arrives in a batch: the restore must ask who owns the path, exactly as
    // the single event does — the owner keeps it, and this device's tombstone is retired.
    adapter.files.set("reborn.md", encoder.encode("second life"));
    await engine.handleLocalEvents({ changed: ["reborn.md"] });

    expect(api.pushed.filter((push) => push.action === "restore")).toHaveLength(0);
    expect(new TextDecoder().decode(adapter.files.get("reborn.md"))).toBe("theirs");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("reborn.md")))).toBe(
      "second life",
    );
    expect(api.chains.get(mine)!.map((version) => version.action)).toEqual(["create", "delete"]);
    expect(engine.fileIdForPath("reborn.md")).toBe(theirs);
    await expectConsistent(engine, adapter, api);
  });

  it("keeps two chains apart when two deleted files shared their content", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("same bytes"));
    adapter.files.set("b.md", encoder.encode("same bytes"));
    await engine.initialSync();
    const aId = engine.fileIdForPath("a.md")!;
    const bId = engine.fileIdForPath("b.md")!;
    expect(api.chains.get(aId)!.at(-1)!.action).toBe("create");

    // Both are removed in one job; a.md is back at its own path when the changes are read,
    // so its tombstone is taken back and b.md's goes out. The two share a content hash, and
    // taking a.md back must not steal b.md's rename record or its mapping.
    adapter.files.delete("a.md");
    adapter.files.delete("b.md");
    adapter.files.set("a.md", encoder.encode("same bytes"));
    const stat = adapter.statFile.bind(adapter);
    let first = true;
    adapter.statFile = async (path: string) => {
      if (path === "a.md" && first) {
        first = false;
        return null;
      }
      return await stat(path);
    };
    try {
      await engine.handleLocalEvents({ deleted: ["a.md", "b.md"], changed: ["a.md"] });
    } finally {
      adapter.statFile = stat;
    }

    // a.md's bytes never changed, so its chain keeps its version (no modify to send); b.md's
    // tombstone goes out on its own chain.
    expect(api.chains.get(aId)!.map((version) => version.action)).toEqual(["create"]);
    expect(api.chains.get(bId)!.map((version) => version.action)).toEqual(["create", "delete"]);
    expect(engine.fileIdForPath("a.md")).toBe(aId);
    // A tombstone keeps the path mapped to its chain, so a file that appears there later is
    // a restore of that chain rather than a second one.
    expect(engine.fileIdForPath("b.md")).toBe(bId);
    await expectConsistent(engine, adapter, api);
  });

  it("takes the tombstone back when the file reappears with new bytes", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;
    const before = api.pushed.length;

    // The removal is decided while the file is gone and the change is read after it came
    // back with new bytes (a write/delete race inside one window).
    const stat = adapter.statFile.bind(adapter);
    let first = true;
    adapter.statFile = async (path: string) => {
      if (path === "note.md" && first) {
        first = false;
        return null;
      }
      return await stat(path);
    };
    adapter.files.set("note.md", encoder.encode("v2"));
    await engine.handleLocalEvents({
      deleted: ["note.md"],
      changed: ["note.md"],
    });
    adapter.statFile = stat;

    // One modify on the chain that was there: no tombstone, no restore, no second chain.
    expect(api.pushed.slice(before).map((push) => push.action)).toEqual(["modify"]);
    expect(engine.fileIdForPath("note.md")).toBe(fileId);
    expect(api.chains.get(fileId)!.map((version) => version.action)).toEqual(["create", "modify"]);
    await expectConsistent(engine, adapter, api);
  });

  it("drops the batch's held versions when the limiter ends the job mid-way", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    // Exactly one full batch, then a chunked file: adding it flushes the batch, the flush is
    // refused, and the chunked version must be abandoned rather than staged and sent alone
    // into the same limiter window.
    const paths = Array.from({ length: 100 }, (_, index) => `n-${index}.md`);
    for (const path of paths) adapter.files.set(path, encoder.encode(`# ${path}`));
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(5));
    const uploads = vi.fn(async () => {
      throw new Error("no chunk should be staged");
    });
    api.uploadChunk = uploads;

    const realPush = api.push.bind(api);
    api.push = async () => {
      throw rateLimited();
    };
    try {
      await expect(
        engine.handleLocalEvents({ changed: [...paths, "big.mp4"] }),
      ).rejects.toMatchObject({ status: 429 });
    } finally {
      api.push = realPush;
    }

    // The full-batch flush inside the job ended it; every version it still held was dropped
    // with its pending identity, so the next event or pass pushes them as batches again.
    for (const path of [...paths, "big.mp4"]) expect(engine.fileIdForPath(path)).toBeNull();
    expect(uploads).not.toHaveBeenCalled();
  }, 20_000);

  it("stops the batch when a limiter outlasts its waits", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    const realPush = api.push.bind(api);
    api.push = async () => {
      throw rateLimited();
    };
    try {
      // The wait is bounded: once the limiter has outlasted it, every further batch would
      // be refused too, so the job ends and leaves the files for the next pass.
      await expect(engine.handleLocalEvents({ changed: ["a.md", "b.md"] })).rejects.toMatchObject({
        status: 429,
      });
    } finally {
      api.push = realPush;
    }

    expect(engine.fileIdForPath("a.md")).toBeNull();
    expect(engine.fileIdForPath("b.md")).toBeNull();
  });

  it("drops the whole batch when the request never lands, and the next pass retries it", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    const paths = seed(adapter, 5);
    api.offline = true;

    await expect(engine.handleLocalEvents({ changed: paths })).rejects.toThrow("network down");

    // Nothing landed, so no identity may survive: the files are untracked again, which is
    // what makes the next pass (not a per-file push) carry them.
    api.offline = false;
    for (const path of paths) expect(engine.fileIdForPath(path)).toBeNull();
    await engine.initialSync();
    for (const path of paths) expect(engine.fileIdForPath(path)).not.toBeNull();
    await expectConsistent(engine, adapter, api);
  });

  it("reads the chains of a big batch 200 files per request", async () => {
    const { engine, adapter, api } = await makeEngine();
    const paths = seed(adapter, 250);
    await engine.initialSync();
    const pulls: number[] = [];
    const innerPull = api.pull.bind(api);
    api.pull = async (vaultId, fileIds) => {
      pulls.push(fileIds.length);
      return await innerPull(vaultId, fileIds);
    };
    for (const path of paths) adapter.files.set(path, encoder.encode(`${path} v2`));

    await engine.handleLocalEvents({ changed: paths });

    // 250 tracked edits: their chains travel 200 + 50, their versions 100 per request.
    expect(pulls).toEqual([200, 50]);
    expect(api.pushed.filter((file) => file.action === "modify")).toHaveLength(250);
    await expectConsistent(engine, adapter, api);
  });

  it("uploads a chunked file alone, after the batch's versions", async () => {
    const { engine, adapter, api } = await makeEngine();
    await engine.initialSync();
    const big = new Uint8Array(9 * 1024 * 1024);
    for (let index = 0; index < big.byteLength; index += 1) big[index] = index % 251;
    adapter.files.set("big.pdf", big);
    adapter.files.set("small.md", encoder.encode("small"));
    const before = api.pushCalls.length;

    await engine.handleLocalEvents({ changed: ["small.md", "big.pdf"] });

    // The small note goes first as its own (one-file) batch, then the chunked upload:
    // its version names staged chunks instead of carrying a payload.
    expect(api.pushCalls.slice(before)).toEqual([1, 1]);
    expect(api.uploadCalls.length).toBeGreaterThan(0);
    expect(api.pushed.at(-1)!.content).toBeNull();
    await expectConsistent(engine, adapter, api);
  });
});
