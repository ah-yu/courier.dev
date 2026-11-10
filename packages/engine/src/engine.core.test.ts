import {
  FakeAdapter,
  SlowDeleteAdapter,
  SlowWriteAdapter,
  SyncEngine,
  conflictFilePath,
  decryptString,
  describe,
  encoder,
  encryptString,
  expect,
  freezeConflictClock,
  it,
  makeEngine,
  realPlatform,
  sha256Hex,
  sortedCopy,
  vi,
} from "./engine.test-helpers";
import type { ConflictResolvedEvent } from "./engine.test-helpers";

freezeConflictClock();

describe("SyncEngine", () => {
  it("initial sync pushes untracked local files and records state", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("notes/a.md", encoder.encode("# A"));
    adapter.files.set("notes/b.md", encoder.encode("# B"));

    await engine.initialSync();

    expect(adapter.files.size).toBe(2);
    const creates = api.pushed.filter((p) => p.action === "create");
    expect(creates.length).toBe(2);

    // Another engine bound to the same vault pulls the files down.
    const adapter2 = new FakeAdapter();
    const engine2 = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: adapter2,
      api,
      encryptionKey: (await makeEngine()).key,
    });
    await engine2.initialSync();
    expect(adapter2.files.size).toBe(2);
    expect(new TextDecoder().decode(adapter2.files.get("notes/a.md"))).toBe("# A");
  });

  it("states each pushed version's history kind, from the plaintext path", async () => {
    // The server never sees a path, so the device classifies the file: markdown and
    // canvas are documents (the vault's deep limit), every other synced path an
    // attachment (its shallow one). The numbers stay on the vault.
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("# note"));
    adapter.files.set("board.canvas", encoder.encode("{}"));
    adapter.files.set("photo.png", encoder.encode("png"));

    await engine.initialSync();

    const kinds = new Map<string, string>();
    for (const pushed of api.pushed) {
      kinds.set(await decryptString(key, pushed.encryptedPath), pushed.historyKind);
    }
    expect(kinds.get("note.md")).toBe("documents");
    expect(kinds.get("board.canvas")).toBe("documents");
    expect(kinds.get("photo.png")).toBe("attachments");
  });

  it("pulls a remote edit when local is unchanged", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();

    const fileId = api.pushed[0].fileId;
    await api.remoteEdit(fileId, "v2-remote");

    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("v2-remote");
  });

  it("writes the state once for a batch, not once per file", async () => {
    // Persisting per notification rewrote the whole state once per file: a 5 000-file
    // bind meant ~3.5 GB of JSON. One write per batch is enough — every file in it is
    // applied before the host can read the state.
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    await engine.initialSync();
    const fileIds = api.pushed.map((p) => p.fileId);

    const saves: string[] = [];
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: new FakeAdapter(),
      api,
      encryptionKey: key,
      onSaveState: (json) => saves.push(json),
    });
    const events = await Promise.all(
      fileIds.map(async (fileId) => ({
        fileId,
        versionId: (await api.latestVersionId(fileId))!,
      })),
    );
    await peer.handleFilePushedBatch(events);

    expect(saves).toHaveLength(1);
    expect(Object.keys(JSON.parse(saves[0]!))).toHaveLength(2);
  });

  it("answers an own push's echo at arrival, and only once", async () => {
    // The host consumes the echo when the notification arrives. If it waited for the
    // batch to run, the record could be past its deadline and the engine's own version
    // would be pulled back as a peer's — one request per file.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("n"));
    await engine.initialSync();
    const versionId = api.pushed[0]!.versionId;

    expect(engine.consumeOwnPush(versionId)).toBe(true);
    expect(engine.consumeOwnPush(versionId)).toBe(false);
  });

  it("applies a burst of notifications with one chain request per batch", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    await engine.initialSync();
    const fileIds = api.pushed.map((p) => p.fileId);
    expect(fileIds).toHaveLength(2);

    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });

    const pull = vi.spyOn(api, "pull");
    const events = await Promise.all(
      fileIds.map(async (fileId) => ({
        fileId,
        versionId: (await api.latestVersionId(fileId))!,
      })),
    );
    await peer.handleFilePushedBatch(events);

    // Both chains travelled in one request. One `POST /sync/pull` per file is what spent
    // a live peer's whole 600/minute window on 548 files of 5 000.
    expect(pull).toHaveBeenCalledTimes(1);
    expect(pull.mock.calls[0]![1]).toEqual(fileIds);
    expect(sortedCopy(peerAdapter.files.keys())).toEqual(["a.md", "b.md"]);
    expect(new TextDecoder().decode(peerAdapter.files.get("b.md"))).toBe("b");
  });

  it("applies a burst of tombstones for tracked files four at a time", async () => {
    // A peer that already synced these files is the case the batch's path check used to
    // mistake for a shared path: the tombstone's recorded path and the path the state
    // holds are the same string, so the chunk fell back to applying one file at a time.
    // Deletes are where it shows — they transfer no content, so a serial apply is pure
    // latency, and in a real vault every one of them is a trash operation.
    const { engine, adapter, api, key } = await makeEngine();
    const paths = ["a.md", "b.md", "c.md", "d.md"];
    for (const path of paths) adapter.files.set(path, encoder.encode(path));
    await engine.initialSync();
    const fileIds = api.pushed.map((p) => p.fileId);
    expect(fileIds).toHaveLength(paths.length);

    const peerAdapter = new SlowDeleteAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    expect(peerAdapter.files.size).toBe(paths.length);

    // The user's deletion: the files are gone and the host reports one event each, so
    // every tombstone is pushed as a batch rather than one request per file.
    for (const path of paths) {
      adapter.files.delete(path);
      await engine.handleLocalDelete(path);
    }
    const events = await Promise.all(
      fileIds.map(async (fileId) => ({
        fileId,
        versionId: (await api.latestVersionId(fileId))!,
      })),
    );

    await peer.handleFilePushedBatch(events);

    // Four distinct paths, four pool slots: every delete overlaps the others.
    expect(peerAdapter.maxActive).toBe(4);
    expect(peerAdapter.files.size).toBe(0);
  });

  it("applies two notifications naming one path one at a time", async () => {
    // The other side of the same guard: two *different* chains can name one path for a
    // moment (a peer's move in flight), and their applies must not interleave — the
    // single-event dedupe must not weaken this.
    const { engine, adapter, api, key } = await makeEngine();
    // Different sizes, so neither apply can mistake the other's file for its own bytes.
    adapter.files.set("p.md", encoder.encode("pppppppppp"));
    adapter.files.set("q.md", encoder.encode("q"));
    await engine.initialSync();
    const pId = engine.fileIdForPath("p.md")!;
    const qId = engine.fileIdForPath("q.md")!;

    const peerAdapter = new SlowWriteAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    expect(peerAdapter.files.size).toBe(2);
    peerAdapter.maxActive = 0;
    peerAdapter.ops = 0;

    // Both chains now record `r.md`: two chains naming one path.
    await api.remoteRename(pId, await encryptString(key, "r.md"));
    await api.remoteRename(qId, await encryptString(key, "r.md"));
    const events = [
      { fileId: pId, versionId: (await api.latestVersionId(pId))! },
      { fileId: qId, versionId: (await api.latestVersionId(qId))! },
    ];

    await peer.handleFilePushedBatch(events);

    // Both applies take their turn, but only the chain the server stamped latest may write
    // `r.md`: the older one leaves its own file where it is and the next pass re-points it
    // (see `pathOwners`). The serialisation this case pins is `maxActive` — a second write
    // while the first is in flight would take it above 1 — and the owner's bytes landing.
    expect(peerAdapter.maxActive).toBe(1);
    expect(peerAdapter.files.has("r.md")).toBe(true);
  });

  it("reports a notification whose version content cannot be read", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;

    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    expect(new TextDecoder().decode(peerAdapter.files.get("n.md"))).toBe("v1");

    // A peer edit whose stored blob cannot be read — a missing blob, or the
    // truncated one a concurrent overwrite used to leave behind. Either way the
    // content this pull needs is not there.
    await api.remoteEdit(fileId, "v2-remote");
    const head = (await api.latestVersionId(fileId))!;
    const contentHash = api.chains.get(fileId)!.at(-1)!.contentHash;
    const blob = api.blobs.get(contentHash)!;
    api.blobs.delete(contentHash);

    // The notification fails loudly rather than doing nothing: the note never
    // arriving with nothing said anywhere is exactly what made this a bug.
    await expect(peer.handleFilePushed(fileId, head)).rejects.toThrow(/Could not read the content/);
    expect(new TextDecoder().decode(peerAdapter.files.get("n.md"))).toBe("v1");

    // A full pass is the retry mechanism, so it must survive the same failure…
    await expect(peer.initialSync()).resolves.toBeUndefined();
    expect(new TextDecoder().decode(peerAdapter.files.get("n.md"))).toBe("v1");

    // …and converge once the content is readable again.
    api.blobs.set(contentHash, blob);
    await peer.initialSync();
    expect(new TextDecoder().decode(peerAdapter.files.get("n.md"))).toBe("v2-remote");
  });

  it("parks no conflict copy while the remote side cannot be applied", async () => {
    const conflicts: ConflictResolvedEvent[] = [];
    const { engine, adapter, api } = await makeEngine(undefined, (event) => conflicts.push(event));
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;

    // A peer edits the note while this device edits it too, so the pass decides "conflict"…
    await api.remoteEdit(fileId, "theirs");
    adapter.files.set("n.md", encoder.encode("mine"));

    // …and the content that resolution needs cannot be read (a missing blob, or the
    // truncated one a concurrent overwrite leaves behind).
    const contentHash = api.chains.get(fileId)!.at(-1)!.contentHash;
    const blob = api.blobs.get(contentHash)!;
    api.blobs.delete(contentHash);

    // A pass tolerates the failure — it is the retry — but nothing may be **announced** or
    // parked while the note still holds this device's text. Parking first is what told the
    // user the remote version had won, and what added one more copy on every later pass.
    await expect(engine.initialSync()).resolves.toBeUndefined();
    expect(conflicts).toHaveLength(0);
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("mine");

    // With the content readable again it resolves the one way it always does: the remote
    // version wins and the local text is parked beside the note.
    api.blobs.set(contentHash, blob);
    await engine.initialSync();
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("theirs");
    expect(conflicts).toHaveLength(1);
    expect(new TextDecoder().decode(adapter.files.get(conflicts[0]!.conflictPath!))).toBe("mine");
  });

  it("reports a conflict whose remote content cannot be read", async () => {
    // The pass above tolerates the failure because it is the retry. The notification is
    // not: it is the only thing that would have resolved this conflict now, so it has to
    // fail loudly instead of returning as if the note had been settled.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("n.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;

    await api.remoteEdit(fileId, "theirs");
    const versionId = (await api.latestVersionId(fileId))!;
    adapter.files.set("n.md", encoder.encode("mine"));
    const contentHash = api.chains.get(fileId)!.at(-1)!.contentHash;
    api.blobs.delete(contentHash);

    await expect(engine.handleFilePushed(fileId, versionId)).rejects.toThrow(
      /Could not apply the conflict/,
    );

    // Nothing was announced and nothing was parked: the note still holds this device's
    // text, which is exactly what the failure says.
    expect(adapter.files.has(conflictFilePath("n.md"))).toBe(false);
    expect(new TextDecoder().decode(adapter.files.get("n.md"))).toBe("mine");
  });

  it("suppresses echoes of versions it pushed itself", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("e.md", encoder.encode("hello"));
    await engine.initialSync();
    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
    const pushedVersion = api.pushed.find((p) => p.fileId === fileId)!.versionId;

    await engine.handleFilePushed(fileId, pushedVersion);
    // Echo suppressed — no error, state unchanged.
    expect(api.pushed.filter((p) => p.fileId === fileId).length).toBe(1);
    void key;
  });

  it("resolves a conflict towards the remote version and parks the local content", async () => {
    const conflicts: ConflictResolvedEvent[] = [];
    const { engine, adapter, api } = await makeEngine(undefined, (event) => conflicts.push(event));
    adapter.files.set("c.md", encoder.encode("local"));
    await engine.initialSync();

    const fileId = api.pushed.find((p) => p.action === "create")!.fileId;
    // Local edit AND a remote edit → a true conflict.
    adapter.files.set("c.md", encoder.encode("local-v2"));
    await api.remoteEdit(fileId, "remote");

    await engine.handleFilePushed(fileId, (await api.latestVersionId(fileId))!);

    // The remote head is the truth now, and what this device had is beside it.
    expect(new TextDecoder().decode(adapter.files.get("c.md"))).toBe("remote");
    expect(new TextDecoder().decode(adapter.files.get(conflictFilePath("c.md")))).toBe("local-v2");
    // The host is told what the remote side did with the file, not only where the copy
    // went: `remoteAction` is how the plugin and the daemon word their one line.
    expect(conflicts).toEqual([
      {
        fileId,
        plainPath: "c.md",
        conflictPath: conflictFilePath("c.md"),
        remoteAction: "write",
      },
    ]);
    // The losing device pushed nothing: the chain still ends at the remote edit.
    expect(api.chains.get(fileId)!.at(-1)!.contentHash).toBe(
      await sha256Hex(encoder.encode("remote")),
    );
  });
});
