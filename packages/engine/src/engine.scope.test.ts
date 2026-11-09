import {
  FakeApi,
  SETTINGS_GROUPS,
  SyncEngine,
  conflictFilePath,
  decryptString,
  describe,
  encoder,
  encryptCombinedBytes,
  encryptString,
  engineOver,
  expect,
  freezeConflictClock,
  generateFileId,
  generateVersionId,
  it,
  makeEngine,
  noConflictCopies,
  realPlatform,
  scopeWith,
  scopeWithExcluded,
  sha256Hex,
  sortedCopy,
  textOf,
  vi,
} from "./engine.test-helpers";
import type {
  ConflictResolvedEvent,
  FileTooLargeEvent,
  SettingsAppliedEvent,
  SyncScope,
} from "./engine.test-helpers";

freezeConflictClock();

/**
 * A restore resurrects a deleted file at the path it used to live at — but that
 * path can have been taken since. Overwriting it silently destroys the occupying
 * file's live content locally, and (because the occupant is a different chain)
 * leaves two chains claiming one path, which the next reconcile "resolves" by
 * pushing the restored bytes into the occupant's chain.
 */
/**
 * `hero.md` created and deleted, then re-created by a **fresh** engine — what
 * "Obsidian was closed and reopened, then a new note at the old path" produces:
 * the tombstone is excluded from the bind pass, so the new note is its own chain
 * and the old path is now held by it.
 */
async function makeOccupiedPath() {
  const { engine, adapter, api, key } = await makeEngine();
  adapter.files.set("hero.md", encoder.encode("old content"));
  await engine.initialSync();
  const old = api.pushed.find((p) => p.action === "create")!;
  await engine.handleLocalDelete("hero.md");
  adapter.files.delete("hero.md"); // what the user's delete does to the disk

  const reopened = new SyncEngine({
    platform: realPlatform,
    vaultId: "vault-1",
    adapter,
    api,
    encryptionKey: key,
  });
  await reopened.initialSync({ firstBind: true });
  adapter.files.set("hero.md", encoder.encode("new content"));
  await reopened.handleLocalChange("hero.md");
  const occupant = api.pushed.filter((p) => p.action === "create").at(-1)!;

  expect(occupant.fileId).not.toBe(old.fileId);
  return { engine: reopened, adapter, api, key, old, occupant };
}

describe("SyncEngine — restoring onto a path that is no longer free", () => {
  it("refuses to overwrite the note that now holds the deleted file's path", async () => {
    const { engine, adapter, api, old, occupant } = await makeOccupiedPath();

    const status = await engine.inspectRestoreTarget(old.fileId, "hero.md");
    expect(status.kind).toBe("other-file");
    expect(status.holderFileId).toBe(occupant.fileId);

    const pushedBefore = api.pushed.length;
    await expect(engine.restoreFile(old.fileId, "hero.md", old.contentHash)).rejects.toMatchObject({
      reason: "occupied-by-other-file",
      message: expect.stringContaining("is already held"),
    });

    // Nothing written, nothing pushed, both files exactly as they were.
    expect(new TextDecoder().decode(adapter.files.get("hero.md"))).toBe("new content");
    expect(api.pushed).toHaveLength(pushedBefore);
    expect(api.chains.get(old.fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("restores under another name when the old path is taken", async () => {
    const { engine, adapter, api, key, old, occupant } = await makeOccupiedPath();

    await engine.restoreFile(old.fileId, "hero.md", old.contentHash, {
      targetPath: "hero (恢复).md",
    });

    // The restored note is back, under the new name.
    expect(new TextDecoder().decode(adapter.files.get("hero (恢复).md")!)).toBe("old content");
    // The note that took the path keeps its content *and* its identity.
    expect(new TextDecoder().decode(adapter.files.get("hero.md"))).toBe("new content");
    expect(engine.fileIdForPath("hero.md")).toBe(occupant.fileId);
    expect(engine.fileIdForPath("hero (恢复).md")).toBe(old.fileId);

    // One chain per path: the restore version records the name it came back as.
    expect(api.chains.get(old.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(await decryptString(key, api.paths.get(old.fileId)!)).toBe("hero (恢复).md");
  });

  it("refuses when an unattributed local file sits at the path", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("hero.md", encoder.encode("old content"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    // A peer deletes it and this device applies that deletion, which is when the
    // engine drops its path → fileId mapping entirely.
    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));

    // On disk again, but the vault event has not been processed yet, so no chain
    // claims it. That is still somebody's note — not ours to overwrite.
    adapter.files.set("hero.md", encoder.encode("unsynced note"));
    expect((await engine.inspectRestoreTarget(created.fileId, "hero.md")).kind).toBe(
      "unattributed",
    );

    await expect(
      engine.restoreFile(created.fileId, "hero.md", created.contentHash),
    ).rejects.toMatchObject({ reason: "unattributed-local-file" });
    expect(new TextDecoder().decode(adapter.files.get("hero.md"))).toBe("unsynced note");
  });

  it("refuses a restore whose chain names content the store no longer holds", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((push) => push.action === "create")!;
    // The row still names the version, but its blob was reclaimed.
    api.blobs.delete(created.contentHash);

    await expect(
      engine.restoreFile(created.fileId, "note.md", created.contentHash),
    ).rejects.toThrow(/Version content not found/);
    // Nothing was written from a missing payload.
    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("v1");
  });

  it("refuses a restore whose hash is not in the chain, instead of guessing a size", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((push) => push.action === "create")!;

    await expect(engine.restoreFile(created.fileId, "note.md", "f".repeat(64))).rejects.toThrow(
      /not in this file's history/,
    );
    // Nothing was fetched or written from a guess.
    expect(api.pushed).toHaveLength(1);
    expect(adapter.files.has("note.md")).toBe(true);
  });

  it("restores a version above this device's upload cap", async () => {
    // The cap bounds what a device **sends**; a version already in the chain is part of
    // the vault, so restoring it is not a reason to refuse. (The old rule refused it,
    // which left an old version silently unrestorable on a device whose account cap had
    // been lowered.)
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((push) => push.action === "create")!;
    // A device that may only upload one-byte files; the version is two bytes.
    adapter.files.delete("note.md");
    const capped = engineOver(adapter, api, key, { ...scopeWith(), maxFileBytes: 1 });

    await capped.restoreFile(created.fileId, "note.md", created.contentHash);

    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("v1");
  });

  it("still restores a version onto the chain's own file", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    adapter.files.set("note.md", encoder.encode("v2"));
    await engine.handleLocalChange("note.md");

    // The version-history entry point: the path holds *this* file, so restoring an
    // older version over it is the normal, expected write.
    expect((await engine.inspectRestoreTarget(created.fileId, "note.md")).kind).toBe("same-chain");

    await engine.restoreFile(created.fileId, "note.md", created.contentHash);
    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("v1");
    expect(api.chains.get(created.fileId)!.at(-1)!.action).toBe("restore");
  });

  it("has no live path for a chain whose deletion this device applied", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("gone.md", encoder.encode("deleted by the peer"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    expect(engine.pathForFileId(created.fileId)).toBe("gone.md");

    // The peer deletes it and this device applies that deletion, which is exactly
    // when the path → fileId mapping (and the state entry behind it) is dropped.
    await engine.handleFilePushed(created.fileId, await api.remoteDelete(created.fileId));

    // Nothing to prefer: a restore of this chain can only use what the caller knows.
    expect(engine.pathForFileId(created.fileId)).toBeNull();
  });

  it("writes a restore at the chain's own path, not the stale one a dialog held", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The user renames the note while the version-history dialog is open: the
    // dialog still holds "note.md", the chain now lives at "moved.md".
    adapter.files.delete("note.md");
    adapter.files.set("moved.md", encoder.encode("v2"));
    await engine.handleLocalRename("note.md", "moved.md");
    expect(engine.pathForFileId(created.fileId)).toBe("moved.md");

    await engine.restoreFile(created.fileId, "note.md", created.contentHash);

    // The content comes back where the chain is. Writing the stale path instead
    // would leave the chain live at two paths at once.
    expect(new TextDecoder().decode(adapter.files.get("moved.md")!)).toBe("v1");
    expect(adapter.files.has("note.md")).toBe(false);
    expect(engine.fileIdForPath("note.md")).toBeNull();
    expect(api.chains.get(created.fileId)!.map((v) => v.action)).toEqual([
      "create",
      "rename",
      "restore",
    ]);
    expect(await decryptString(key, api.paths.get(created.fileId)!)).toBe("moved.md");
  });
});

/**
 * The sync scope is a **device-local** decision, and it has to hold on both ends
 * of the wire: a path it rejects may neither be pushed out of this vault nor
 * pulled into it. Only the first half is obvious; the second is what keeps a
 * device with settings sync off from re-pulling a peer's `app.json` on every pass
 * and reporting a fresh "conflict" for it each time.
 *
 * `FakeAdapter.listSyncableFiles` deliberately returns *everything* in its map —
 * "what exists" — so these cases fail if the engine forgets to apply the scope.
 */
/** A live chain the "peer" already pushed for `path`, blob and all. */
async function seedRemoteFile(
  api: FakeApi,
  key: CryptoKey,
  path: string,
  content: string,
  mtimeMs = 0,
): Promise<{ fileId: string; versionId: string }> {
  const bytes = encoder.encode(content);
  const contentHash = await sha256Hex(bytes);
  api.blobs.set(contentHash, await encryptCombinedBytes(key, bytes as Uint8Array<ArrayBuffer>));
  const fileId = generateFileId();
  const versionId = generateVersionId();
  const encryptedPath = await encryptString(key, path);
  api.paths.set(fileId, encryptedPath);
  api.chains.set(fileId, [
    {
      versionId,
      contentHash,
      encryptedPath,
      action: "create",
      sizeBytes: bytes.byteLength,
      mtimeMs,
      createdAt: new Date().toISOString(),
    },
  ]);
  return { fileId, versionId };
}

describe("SyncEngine — the sync scope", () => {
  const OBSIDIAN_DEFAULT = scopeWith(
    "app",
    "appearance",
    "themes",
    "snippets",
    "hotkeys",
    "corePlugins",
    "corePluginSettings",
  );
  const PLUGINS = scopeWith(...SETTINGS_GROUPS);
  const MARKDOWN_ONLY = scopeWith();

  it("answers a caller whether it syncs a path, with the scope it was built with", async () => {
    // The public door exists for the one path that comes from a *person* rather than from
    // the vault or the server: the new file name a restore is put under, which the dialog
    // checks before handing it over. What it must not be is a second, settings-derived
    // opinion — a host restarted for a switch change is the authority on what it syncs.
    const off = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    expect(off.engine.isSyncablePath("note.md")).toBe(true);
    expect(off.engine.isSyncablePath("photo.raw")).toBe(false);
    expect(off.engine.isSyncablePath(".obsidian/app.json")).toBe(false);

    const settings = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    expect(settings.engine.isSyncablePath(".obsidian/app.json")).toBe(true);
    expect(settings.engine.isSyncablePath("photo.raw")).toBe(false);
  });

  it("pushes a settings file only when the scope allows it", async () => {
    const off = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    off.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    off.adapter.files.set("note.md", encoder.encode("# note"));

    await off.engine.initialSync();

    expect(off.api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(await decryptString(off.key, off.api.pushed[0]!.encryptedPath)).toBe("note.md");

    const on = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    on.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    on.adapter.files.set("note.md", encoder.encode("# note"));

    await on.engine.initialSync();

    const paths = await Promise.all(
      on.api.pushed.map((p) => decryptString(on.key, p.encryptedPath)),
    );
    expect(sortedCopy(paths)).toEqual([".obsidian/app.json", "note.md"]);
  });

  it("pushes the settings files the scope allows, and never this plugin's own folder", async () => {
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, PLUGINS);
    adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    adapter.files.set(".obsidian/snippets/wide.css", encoder.encode("body {}"));
    adapter.files.set(".obsidian/plugins/courier/data.json", encoder.encode('{"deviceName":"x"}'));
    adapter.files.set(".obsidian/plugins/dataview/main.js", encoder.encode("module.exports={}"));

    await engine.initialSync();

    const paths = await Promise.all(api.pushed.map((p) => decryptString(key, p.encryptedPath)));
    expect(sortedCopy(paths)).toEqual([
      ".obsidian/app.json",
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/snippets/wide.css",
    ]);
  });

  it("ignores a peer's settings chain completely when settings sync is off", async () => {
    const { adapter, api, key } = await makeEngine();
    const conflicts: ConflictResolvedEvent[] = [];
    const engine = engineOver(adapter, api, key, MARKDOWN_ONLY, (event) => conflicts.push(event));
    const seeded = await seedRemoteFile(api, key, ".obsidian/app.json", '{"theme":"moonstone"}');

    await engine.initialSync();
    await engine.handleFilePushed(seeded.fileId, seeded.versionId);

    // Not pulled, not written, not parked as a conflict file, no notice.
    expect(adapter.files.has(".obsidian/app.json")).toBe(false);
    expect(adapter.files.has(conflictFilePath(".obsidian/app.json"))).toBe(false);
    expect(conflicts).toEqual([]);
    // And no second version was invented for the peer's chain.
    expect(api.chains.get(seeded.fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(engine.fileIdForPath(".obsidian/app.json")).toBeNull();
  });

  it("never lets a local file adopt a peer's settings chain by content", async () => {
    const { adapter, api, key } = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    const engine = engineOver(adapter, api, key, MARKDOWN_ONLY);
    // The same bytes as a local markdown note: a content-hash match must not be
    // enough to hand this device a chain whose path it is not allowed to write.
    const shared = "# identical";
    const seeded = await seedRemoteFile(api, key, ".obsidian/app.json", shared);
    adapter.files.set("note.md", encoder.encode(shared));

    await engine.initialSync();

    expect(engine.fileIdForPath("note.md")).not.toBe(seeded.fileId);
    expect(await decryptString(key, api.paths.get(engine.fileIdForPath("note.md")!)!)).toBe(
      "note.md",
    );
  });

  it("leaves a settings chain this device tracked alone once the scope turns it off", async () => {
    const on = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    on.adapter.files.set(".obsidian/app.json", encoder.encode('{"theme":"moonstone"}'));
    await on.engine.initialSync();
    const fileId = on.engine.fileIdForPath(".obsidian/app.json")!;
    const chainLength = on.api.chains.get(fileId)!.length;

    // The switch goes off (or this device never wanted settings): the same vault,
    // the same server, a markdown-only engine with the persisted state.
    const off = engineOver(on.adapter, on.api, on.key, MARKDOWN_ONLY);
    off.loadState(on.engine.serializeState());
    await off.initialSync();

    // Nothing is deleted, nothing is pulled back, no tombstone, no conflict file.
    expect(new TextDecoder().decode(on.adapter.files.get(".obsidian/app.json"))).toBe(
      '{"theme":"moonstone"}',
    );
    expect(on.api.chains.get(fileId)!.length).toBe(chainLength);
    expect(on.adapter.files.has(conflictFilePath(".obsidian/app.json"))).toBe(false);
  });

  it("drops local events for paths outside the scope", async () => {
    const { engine, adapter, api } = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    adapter.files.set(".hidden/secret.md", encoder.encode("s"));

    await engine.handleLocalChange(".obsidian/app.json");
    await engine.handleLocalChange(".hidden/secret.md");
    await engine.handleLocalRename(".obsidian/app.json", ".obsidian/appearance.json");

    expect(api.pushed).toEqual([]);
    expect(engine.fileIdForPath(".obsidian/app.json")).toBeNull();
  });

  it("ignores a move whose target is outside the scope", async () => {
    // A rename arrives with both paths, and the **destination** decides whether the move
    // is this device's business: a note moved into a hidden folder leaves the synced set,
    // so there is no version to write. The old path's disappearance is a separate event,
    // and one the scope answers on its own terms.
    const { engine, adapter, api } = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = api.pushed[0].fileId;

    adapter.files.delete("note.md");
    adapter.files.set(".trash/note.md", encoder.encode("body"));
    const before = api.pushCalls.length;
    await engine.handleLocalRename("note.md", ".trash/note.md");

    expect(api.pushCalls).toHaveLength(before);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("leaves everything inside an excluded folder on this device", async () => {
    const scope = scopeWithExcluded("private");
    const conflicts: ConflictResolvedEvent[] = [];
    const { adapter, api, key } = await makeEngine(undefined, undefined, scope);
    const engine = engineOver(adapter, api, key, scope, (event) => conflicts.push(event));
    adapter.files.set("public.md", encoder.encode("public"));
    adapter.files.set("private/local.md", encoder.encode("local"));
    const seeded = await seedRemoteFile(api, key, "private/peer.md", "peer");

    await engine.initialSync();

    // The local file in the excluded folder never leaves, the peer's file never arrives,
    // and the peer's chain is not touched (no second version, no conflict copy).
    const pushed = await Promise.all(
      api.pushed.map((push) => decryptString(key, push.encryptedPath)),
    );
    expect(pushed).toEqual(["public.md"]);
    expect(adapter.files.has("private/peer.md")).toBe(false);
    expect(adapter.files.has(conflictFilePath("private/peer.md"))).toBe(false);
    expect(conflicts).toEqual([]);
    expect(api.chains.get(seeded.fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(engine.fileIdForPath("private/local.md")).toBeNull();
    expect(engine.fileIdForPath("private/peer.md")).toBeNull();

    // Local events and remote notifications for that folder are dropped before anything
    // is decided, exactly like a settings group that is switched off.
    await engine.handleLocalChange("private/local.md");
    await engine.handleLocalDelete("private/local.md");
    await engine.handleFilePushed(seeded.fileId, seeded.versionId);
    expect(api.pushed).toHaveLength(1);
    expect(adapter.files.has("private/peer.md")).toBe(false);
  });

  it("resumes an excluded folder when the list no longer excludes it", async () => {
    const off = await makeEngine(undefined, undefined, scopeWithExcluded("private"));
    off.adapter.files.set("private/local.md", encoder.encode("local"));
    const seeded = await seedRemoteFile(off.api, off.key, "private/peer.md", "peer");
    await off.engine.initialSync();
    expect(off.api.pushed).toEqual([]);
    expect(off.adapter.files.has("private/peer.md")).toBe(false);

    // The same vault, server and persisted state, with the folder back in scope.
    const on = engineOver(off.adapter, off.api, off.key, MARKDOWN_ONLY);
    on.loadState(off.engine.serializeState());
    await on.initialSync();

    const pushed = await Promise.all(
      off.api.pushed.map((push) => decryptString(off.key, push.encryptedPath)),
    );
    expect(pushed).toEqual(["private/local.md"]);
    expect(new TextDecoder().decode(off.adapter.files.get("private/peer.md"))).toBe("peer");
    expect(off.api.chains.get(seeded.fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("records a tracked file moved into an excluded folder without pushing a tombstone", async () => {
    const scope = scopeWithExcluded("private");
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, scope);
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;
    const chainLength = api.chains.get(fileId)!.length;

    // What Obsidian reports as a rename: the file left a synced path for an excluded one.
    adapter.files.delete("note.md");
    adapter.files.set("private/note.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "private/note.md");

    // No version is written — in particular no tombstone — but the chain still knows
    // where this device's copy lives. A pass while excluded is silent too.
    expect(api.chains.get(fileId)!.length).toBe(chainLength);
    expect(engine.fileIdForPath("note.md")).toBeNull();
    expect(engine.fileIdForPath("private/note.md")).toBe(fileId);
    await engine.initialSync();
    expect(api.chains.get(fileId)!.length).toBe(chainLength);

    // Back in scope: the recorded path disagrees with the remote head's path, which is
    // exactly the reconcile branch that pushes a rename on the same chain.
    const back = engineOver(adapter, api, key, MARKDOWN_ONLY);
    back.loadState(engine.serializeState());
    await back.initialSync();

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect(await decryptString(key, api.chains.get(fileId)!.at(-1)!.encryptedPath)).toBe(
      "private/note.md",
    );
  });

  it("resumes a tracked file moved back into scope as a rename on the same chain", async () => {
    const scope = scopeWithExcluded("private");
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, scope);
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    // Out of scope: recorded, not pushed.
    adapter.files.delete("note.md");
    adapter.files.set("private/note.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "private/note.md");
    expect(engine.fileIdForPath("private/note.md")).toBe(fileId);

    // Back in scope through a rename event: the same chain gets the move as a `rename`
    // version, instead of the old path's vacancy becoming a tombstone.
    adapter.files.delete("private/note.md");
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.handleLocalRename("private/note.md", "note.md");

    expect(engine.fileIdForPath("note.md")).toBe(fileId);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect(await decryptString(key, api.chains.get(fileId)!.at(-1)!.encryptedPath)).toBe("note.md");
  });

  it("never hands an excluded chain to a local file by content", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("private/note.md", encoder.encode("shared"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("private/note.md")!;

    // The same bytes now sit at a syncable path while the chain's recorded path is
    // excluded. `repairMovedFile` must not read that as a move: the excluded file is
    // still on disk, and the copy is somebody else's new file.
    first.adapter.files.set("copy.md", encoder.encode("shared"));
    const second = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    second.loadState(first.engine.serializeState());
    await second.initialSync();

    expect(second.fileIdForPath("copy.md")).not.toBe(fileId);
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  /**
   * A move into an excluded folder that no host reported as a rename.
   *
   * This is the shape an external tool or a plugin that was not running produces: the
   * old path simply disappears and the new one is dropped by the scope before the engine
   * sees it. The chain must follow the file into the excluded folder — a tombstone here
   * would delete, on every peer, a note the user still owns.
   */
  it("recognises a file moved into an excluded folder without a rename event", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    // The pass that starts after the move sees only the old path's absence.
    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync({ firstBind: true });

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("note.md")).toBeNull();
    expect(restarted.fileIdForPath("private/note.md")).toBe(fileId);

    // A second pass stays silent, and the excluded folder's file is not read as a
    // deletion of the chain either.
    await restarted.initialSync();
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("recognises the same move when it arrives as a bare delete event", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    // `fs.watch`/an external tool: the "created" half is filtered out by the scope and
    // only the removal reaches the engine.
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    await restarted.handleLocalDelete("note.md");

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/note.md")).toBe(fileId);
  });

  /**
   * An **empty** note is the corner case of the hash match: its content hash is the
   * hash a `delete` version carries, so the move detection cannot use "not the empty
   * hash" to tell a real file from a tombstone — it has to trust the path index and the
   * candidate's bytes like any other file.
   */
  it("recognises an empty note moved into an excluded folder", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("blank.md", encoder.encode(""));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("blank.md")!;

    first.adapter.files.delete("blank.md");
    first.adapter.files.set("private/blank.md", encoder.encode(""));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/blank.md")).toBe(fileId);
  });

  /**
   * The re-check in the pass's delete branch: a rename that lands between "the listing
   * says the path is gone" and "the tombstone is sent" has already recorded the move,
   * so the pass must not overwrite that with a deletion decided from its snapshot.
   */
  it("does not publish a deletion for a path an event moved during the pass", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    first.adapter.files.delete("note.md");
    first.adapter.excludedFolders = ["private"];

    // The pass has already repaired all it can; the move lands while it is confirming
    // the deletion, which is exactly the window the state re-check exists for.
    let moved = false;
    const statFile = first.adapter.statFile.bind(first.adapter);
    first.adapter.statFile = async (path) => {
      const stamp = await statFile(path);
      if (!moved && path === "note.md") {
        moved = true;
        first.adapter.files.set("private/note.md", encoder.encode("body"));
        // The rename's job queues behind this pass's job; waiting here would wait for
        // the pass that is waiting for this hook.
        void restarted.handleLocalRename("note.md", "private/note.md");
      }
      return stamp;
    };
    await restarted.initialSync();
    await restarted.whenIdle();
    first.adapter.statFile = statFile;

    expect(moved).toBe(true);
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/note.md")).toBe(fileId);
  });

  it("keeps a deletion when the excluded folder holds only a different file with that name", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("the note"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    // A same-named copy under the excluded folder is not the moved file: the content
    // hash is what decides, so the real deletion still reaches the peers. The two
    // strings are the same length on purpose — that leaves the hash, not the size
    // prefilter, as the only thing standing between the copy and the chain.
    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("a copy!!"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("leaves an ambiguous match alone: two excluded copies are not a move", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/one/note.md", encoder.encode("body"));
    first.adapter.files.set("private/two/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    // Two candidates with the same name and bytes cannot say which one the chain became,
    // so the deletion stands rather than handing the chain to an arbitrary copy.
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(restarted.fileIdForPath("private/one/note.md")).toBeNull();
    expect(restarted.fileIdForPath("private/two/note.md")).toBeNull();
  });

  it("does not take a same-content file under another name as the moved one", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    // The name is the cheap first filter: a file with the same bytes but another name
    // under the excluded folder is somebody else's copy, not this chain's move.
    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/other.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(restarted.fileIdForPath("private/other.md")).toBeNull();
  });

  it("recognises the move when the state records no stamp for the file", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;
    // An older persisted state has the sync point but no size/mtime pair: the size
    // prefilter has to be skipped, not crash, and the bytes still decide.
    const state = JSON.parse(first.engine.serializeState()) as Record<string, { stamp?: unknown }>;
    delete state[fileId]!.stamp;

    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(JSON.stringify(state));
    await restarted.initialSync();

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/note.md")).toBe(fileId);
  });

  it("does not take a file another chain already owns as the moved one", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const deletedId = first.engine.fileIdForPath("note.md")!;
    const claimedId = first.engine.fileIdForPath("private/note.md")!;
    expect(deletedId).not.toBe(claimedId);

    // The note really was deleted; the only same-name, same-content file left is a
    // chain that already owns its path. Reading that as a move would put two chains
    // on one path, so the deletion stands.
    first.adapter.files.delete("note.md");
    first.adapter.excludedFolders = ["private"];
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    expect(first.api.chains.get(deletedId)!.map((v) => v.action)).toEqual(["create", "delete"]);
    expect(first.api.chains.get(claimedId)!.map((v) => v.action)).toEqual(["create"]);
    expect(restarted.fileIdForPath("private/note.md")).toBe(claimedId);
  });

  it("falls back to a deletion when the host cannot list the excluded files", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("note.md")!;

    first.adapter.files.delete("note.md");
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    first.adapter.excludedFolders = ["private"];
    first.adapter.listExcludedFiles = undefined as never;
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.initialSync();

    // `listExcludedFiles` is optional: a host that cannot answer keeps the old
    // behaviour, where such a move is indistinguishable from a deletion.
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);
  });

  it("walks the excluded folders once for a burst of deletions", async () => {
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("a.md", encoder.encode("aaa"));
    adapter.files.set("b.md", encoder.encode("bbb"));
    await engine.initialSync();
    const aId = engine.fileIdForPath("a.md")!;
    const bId = engine.fileIdForPath("b.md")!;

    let lists = 0;
    const list = adapter.listExcludedFiles.bind(adapter);
    adapter.listExcludedFiles = async () => {
      lists += 1;
      return await list();
    };
    adapter.excludedFolders = ["private"];
    adapter.files.delete("a.md");
    adapter.files.set("private/a.md", encoder.encode("aaa"));
    adapter.files.delete("b.md");
    adapter.files.set("private/b.md", encoder.encode("bbb"));

    // A remove of a whole folder arrives as a burst: one listing serves all of it.
    await engine.handleLocalDelete("a.md");
    await engine.handleLocalDelete("b.md");

    expect(lists).toBe(1);
    expect(api.chains.get(aId)!.map((v) => v.action)).toEqual(["create"]);
    expect(api.chains.get(bId)!.map((v) => v.action)).toEqual(["create"]);
    expect(engine.fileIdForPath("private/a.md")).toBe(aId);
    expect(engine.fileIdForPath("private/b.md")).toBe(bId);
  });

  it("does not hand the chain to a new file created at the vacated path", async () => {
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.delete("note.md");
    adapter.files.set("private/note.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "private/note.md");

    // The old path no longer belongs to this chain: a fresh note there is its own
    // chain, and the move must not leave a path job behind that hides it from the
    // next pass either.
    adapter.files.set("note.md", encoder.encode("something else"));
    await engine.initialSync();

    const newId = engine.fileIdForPath("note.md");
    expect(newId).not.toBeNull();
    expect(newId).not.toBe(fileId);
    expect(engine.fileIdForPath("private/note.md")).toBe(fileId);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("persists the path a rename out of scope recorded", async () => {
    const saved: string[] = [];
    const { engine, adapter } = await makeEngine(
      (json) => saved.push(json),
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("renamed.md", encoder.encode("renamed"));
    await engine.initialSync();
    const renamedId = engine.fileIdForPath("renamed.md")!;

    saved.length = 0;
    adapter.excludedFolders = ["private"];
    adapter.files.delete("renamed.md");
    adapter.files.set("private/renamed.md", encoder.encode("renamed"));
    await engine.handleLocalRename("renamed.md", "private/renamed.md");

    // The recorded path is what a restart needs to keep one chain (and what turns the
    // move back into a `rename` when the folder returns to scope), so it has to reach
    // the persisted state, not only the in-memory one.
    const persisted = JSON.parse(saved.at(-1)!) as Record<string, { plainPath?: string }>;
    expect(persisted[renamedId]?.plainPath).toBe("private/renamed.md");
  });

  it("persists the path a delete event was recognised as a move for", async () => {
    const saved: string[] = [];
    const { engine, adapter } = await makeEngine(
      (json) => saved.push(json),
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("deleted.md", encoder.encode("deleted"));
    await engine.initialSync();
    const deletedId = engine.fileIdForPath("deleted.md")!;

    saved.length = 0;
    adapter.excludedFolders = ["private"];
    adapter.files.delete("deleted.md");
    adapter.files.set("private/deleted.md", encoder.encode("deleted"));
    await engine.handleLocalDelete("deleted.md");

    const persisted = JSON.parse(saved.at(-1)!) as Record<string, { plainPath?: string }>;
    expect(persisted[deletedId]?.plainPath).toBe("private/deleted.md");
  });

  it("records a move between two excluded folders without pushing", async () => {
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      scopeWithExcluded("private", "archive"),
    );
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.delete("note.md");
    adapter.files.set("private/note.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "private/note.md");
    adapter.files.delete("private/note.md");
    adapter.files.set("archive/note.md", encoder.encode("body"));
    await engine.handleLocalRename("private/note.md", "archive/note.md");

    // Both paths are outside the scope, so the chain follows the file silently and the
    // server keeps its old version.
    expect(engine.fileIdForPath("archive/note.md")).toBe(fileId);
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("pushes a normal rename while another folder is excluded", async () => {
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      scopeWithExcluded("private"),
    );
    adapter.files.set("note.md", encoder.encode("body"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.delete("note.md");
    adapter.files.set("renamed.md", encoder.encode("body"));
    await engine.handleLocalRename("note.md", "renamed.md");

    // The excluded folder must not change what a move between two synced paths does.
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "rename"]);
    expect(engine.fileIdForPath("renamed.md")).toBe(fileId);
  });

  it("restores a deleted file into an excluded folder — an explicit action, not a scope leak", async () => {
    const first = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    first.adapter.files.set("private/note.md", encoder.encode("body"));
    await first.engine.initialSync();
    const fileId = first.engine.fileIdForPath("private/note.md")!;
    const contentHash = first.api.chains.get(fileId)![0]!.contentHash;
    first.adapter.files.delete("private/note.md");
    await first.engine.handleLocalDelete("private/note.md");
    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete"]);

    // The device now excludes the folder. The recycle bin still lists what the server
    // holds, and 恢复 is the person asking for that version back: it is written locally
    // and pushed as a live version again, while the folder stays excluded here.
    const restarted = engineOver(first.adapter, first.api, first.key, scopeWithExcluded("private"));
    restarted.loadState(first.engine.serializeState());
    await restarted.restoreFile(fileId, "private/note.md", contentHash);

    expect(first.api.chains.get(fileId)!.map((v) => v.action)).toEqual([
      "create",
      "delete",
      "restore",
    ]);
    expect(new TextDecoder().decode(first.adapter.files.get("private/note.md"))).toBe("body");
    // The folder is still out of scope on this device: the next pass leaves the file
    // alone, it is not synced from here on.
    await restarted.initialSync();
    expect(first.api.chains.get(fileId)!).toHaveLength(3);
  });

  it("pushes local settings changes that no vault event ever reports", async () => {
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    adapter.files.set("note.md", encoder.encode("# note"));
    adapter.files.set(".obsidian/app.json", encoder.encode('{"theme":"moonstone"}'));
    await engine.initialSync();
    const fileId = engine.fileIdForPath(".obsidian/app.json")!;

    // Obsidian's config folder is not in the vault index, so editing a settings
    // file on disk fires no event at all — the poll is the only thing that sees it.
    adapter.files.set(".obsidian/app.json", encoder.encode('{"theme":"obsidian"}'));
    adapter.files.set(".obsidian/hotkeys.json", encoder.encode('{"x":[]}'));
    await engine.syncLocalSettings();

    const actions = api.chains.get(fileId)!.map((v) => v.action);
    expect(actions).toEqual(["create", "modify"]);
    const hotkeysId = engine.fileIdForPath(".obsidian/hotkeys.json")!;
    expect(api.chains.get(hotkeysId)!.map((v) => v.action)).toEqual(["create"]);
    // The note was not touched by the settings pass.
    expect(api.chains.get(engine.fileIdForPath("note.md")!)!.map((v) => v.action)).toEqual([
      "create",
    ]);
    expect(await decryptString(key, api.paths.get(hotkeysId)!)).toBe(".obsidian/hotkeys.json");

    // Deleting it while nothing watches is the other half the poll carries.
    adapter.files.delete(".obsidian/app.json");
    await engine.syncLocalSettings();
    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "delete"]);
  });

  it("does nothing before the first bind, and nothing when settings are off", async () => {
    const beforeBind = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    beforeBind.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    await beforeBind.engine.syncLocalSettings();
    expect(beforeBind.api.pushed).toEqual([]);

    const off = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    off.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    await off.engine.initialSync();
    await off.engine.syncLocalSettings();
    expect(off.api.pushed).toEqual([]);
  });

  it("does not turn a listing that lags a settings write into a tombstone", async () => {
    const { engine, adapter, api } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
    adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath(".obsidian/app.json")!;

    // The vault listing misses a file the adapter can still read: absence from one
    // listing is not evidence of a deletion, exactly as in the full reconcile.
    const listSyncableFiles = adapter.listSyncableFiles.bind(adapter);
    adapter.listSyncableFiles = async () => [];
    await engine.syncLocalSettings();
    adapter.listSyncableFiles = listSyncableFiles;

    expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(adapter.files.has(".obsidian/app.json")).toBe(true);
  });

  it("keeps every settings path out of a markdown-only listing", async () => {
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, MARKDOWN_ONLY);
    adapter.files.set(".obsidian/plugins/courier/data.json", encoder.encode("{}"));
    adapter.files.set(".obsidian/workspace.json", encoder.encode("{}"));
    adapter.files.set("note.md", encoder.encode("# note"));

    await engine.initialSync();

    expect(api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(await decryptString(key, api.pushed[0]!.encryptedPath)).toBe("note.md");
  });

  it("syncs only the config-folder groups that are switched on", async () => {
    // Appearance on, the app settings off: the two files differ by one switch only.
    const { engine, adapter, api, key } = await makeEngine(
      undefined,
      undefined,
      scopeWith("appearance"),
    );
    adapter.files.set(".obsidian/app.json", encoder.encode('{"attachmentFolderPath":"files"}'));
    adapter.files.set(".obsidian/appearance.json", encoder.encode('{"theme":"moonstone"}'));
    adapter.files.set(".obsidian/graph.json", encoder.encode("{}"));
    adapter.files.set(".obsidian/themes/Minimal/theme.css", encoder.encode("body {}"));

    await engine.initialSync();

    const paths = await Promise.all(api.pushed.map((p) => decryptString(key, p.encryptedPath)));
    expect(paths).toEqual([".obsidian/appearance.json"]);
    expect(engine.fileIdForPath(".obsidian/app.json")).toBeNull();
  });

  it("ignores a peer's chain for a group this device has off, while another group still travels", async () => {
    const { adapter, api, key } = await makeEngine();
    const engine = engineOver(adapter, api, key, scopeWith("appearance"));
    const app = await seedRemoteFile(api, key, ".obsidian/app.json", '{"theme":"moonstone"}');
    const appearance = await seedRemoteFile(
      api,
      key,
      ".obsidian/appearance.json",
      '{"theme":"obsidian"}',
    );

    await engine.initialSync();

    // The enabled group arrives; the disabled one is not even looked at.
    expect(adapter.files.has(".obsidian/appearance.json")).toBe(true);
    expect(adapter.files.has(".obsidian/app.json")).toBe(false);
    expect(engine.fileIdForPath(".obsidian/app.json")).toBeNull();
    expect(api.chains.get(app.fileId)!.map((v) => v.action)).toEqual(["create"]);
    expect(api.chains.get(appearance.fileId)!.map((v) => v.action)).toEqual(["create"]);
  });

  it("carries the config folder's non-standard files only when otherFiles is on", async () => {
    const off = await makeEngine(undefined, undefined, scopeWith("app"));
    off.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    off.adapter.files.set(".obsidian/notes.txt", encoder.encode("scratch"));
    off.adapter.files.set(".obsidian/my-tool/state.json", encoder.encode('{"x":1}'));

    await off.engine.initialSync();
    const offPaths = await Promise.all(
      off.api.pushed.map((p) => decryptString(off.key, p.encryptedPath)),
    );
    expect(offPaths).toEqual([".obsidian/app.json"]);

    const on = await makeEngine(undefined, undefined, scopeWith("otherFiles"));
    on.adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    on.adapter.files.set(".obsidian/notes.txt", encoder.encode("scratch"));
    on.adapter.files.set(".obsidian/my-tool/state.json", encoder.encode('{"x":1}'));

    await on.engine.initialSync();
    const onPaths = await Promise.all(
      on.api.pushed.map((p) => decryptString(on.key, p.encryptedPath)),
    );
    // `otherFiles` owns the unclaimed paths only — not app.json, whose own group is off.
    expect(sortedCopy(onPaths)).toEqual([".obsidian/my-tool/state.json", ".obsidian/notes.txt"]);
  });

  it("keeps the settings pass inside the switched-on groups", async () => {
    const { engine, adapter, api } = await makeEngine(undefined, undefined, scopeWith("app"));
    adapter.files.set(".obsidian/app.json", encoder.encode("{}"));
    await engine.initialSync();

    // A core plugin's settings file appears while nothing watches: it is not this
    // device's group, so the poll must not push it either.
    adapter.files.set(".obsidian/graph.json", encoder.encode("{}"));
    adapter.files.set(".obsidian/app.json", encoder.encode('{"newFileLocation":"folder"}'));
    await engine.syncLocalSettings();

    expect(engine.fileIdForPath(".obsidian/graph.json")).toBeNull();
    expect(
      api.chains.get(engine.fileIdForPath(".obsidian/app.json")!)!.map((v) => v.action),
    ).toEqual(["create", "modify"]);
  });

  /**
   * What a host is told after a peer's settings file landed.
   *
   * This is the one class of file a running Obsidian does not re-read, so the difference
   * between "the file arrived" and "the app applied it" is invisible on disk — the host
   * has to be told, and these cases fix exactly which applications count.
   */
  it("reports a settings file a peer applied, and never a note", async () => {
    const { adapter, api, key } = await makeEngine();
    const applied: SettingsAppliedEvent[] = [];
    const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT, undefined, (event) =>
      applied.push(event),
    );
    await seedRemoteFile(api, key, ".obsidian/core-plugins.json", '{"sync":false}');
    await seedRemoteFile(api, key, "note.md", "# note");

    await engine.initialSync();

    // The group travels with the event: a host decides what to say about a settings change
    // from which switch owns the file, and this is the only place that rule is applied.
    expect(applied).toEqual([
      { plainPath: ".obsidian/core-plugins.json", action: "write", group: "corePlugins" },
    ]);
    expect(adapter.files.has(".obsidian/core-plugins.json")).toBe(true);
  });

  it("reports a settings file a peer deleted, not only the ones it wrote", async () => {
    const { adapter, api, key } = await makeEngine();
    const seeded = await seedRemoteFile(api, key, ".obsidian/graph.json", '{"zoom":1}');
    const applied: SettingsAppliedEvent[] = [];
    const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT, undefined, (event) =>
      applied.push(event),
    );

    await engine.initialSync({ firstBind: true });
    expect(applied).toEqual([
      { plainPath: ".obsidian/graph.json", action: "write", group: "corePluginSettings" },
    ]);

    // The peer removes it: the absence is as much a change to what the app has read.
    await api.remoteDelete(seeded.fileId);
    await engine.initialSync();

    expect(adapter.files.has(".obsidian/graph.json")).toBe(false);
    expect(applied.at(-1)).toEqual({
      plainPath: ".obsidian/graph.json",
      action: "delete",
      group: "corePluginSettings",
    });
  });

  it("says nothing about a settings chain this device does not sync", async () => {
    const { adapter, api, key } = await makeEngine();
    const applied: SettingsAppliedEvent[] = [];
    const engine = engineOver(adapter, api, key, scopeWith("app"), undefined, (event) =>
      applied.push(event),
    );
    await seedRemoteFile(api, key, ".obsidian/core-plugins.json", '{"sync":false}');

    await engine.initialSync();

    // The group is off, so the chain is ignored entirely — there is nothing to apply and
    // nothing the user could be told.
    expect(applied).toEqual([]);
    expect(adapter.files.has(".obsidian/core-plugins.json")).toBe(false);
  });

  /**
   * A config-folder conflict is the one that is not parked.
   *
   * `.obsidian/` is outside Obsidian's file index, so a copy written there is invisible —
   * there is nothing the user could do with it. The engine settles these by **last
   * modification time** instead (the stamp the pushing device recorded on the version),
   * never writes a copy, and never raises `onConflictResolved`; a host is told only when
   * a peer's file was actually applied (`onSettingsApplied`, which the plugin turns into
   * its reload card).
   */
  describe("a config-folder conflict resolves by modification time", () => {
    it("keeps the newer local edit, with no copy and no notice", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const conflicts: ConflictResolvedEvent[] = [];
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT, (event) =>
        conflicts.push(event),
      );
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode('{"theme":"moonstone"}'));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // The peer edits it (and its push reached the server), then this device edits it
      // later — the *newer* edit has to win, not the one that pushed last.
      await api.remoteEdit(fileId, '{"theme":"obsidian"}', 1_000);
      adapter.files.set(path, encoder.encode('{"theme":"moonstone","newFileLocation":"folder"}'));
      adapter.files.touch(path, 2_000);

      await engine.initialSync();

      expect(textOf(adapter, path)).toBe('{"theme":"moonstone","newFileLocation":"folder"}');
      // The local version was pushed over the peer's, carrying the local stamp.
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify", "modify"]);
      expect(api.chains.get(fileId)!.at(-1)!.mtimeMs).toBe(2_000);
      expect(noConflictCopies(adapter)).toBe(true);
      expect(conflicts).toEqual([]);
    });

    it("takes the newer remote edit, with no copy, and reports it as applied", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const conflicts: ConflictResolvedEvent[] = [];
      const applied: SettingsAppliedEvent[] = [];
      const engine = engineOver(
        adapter,
        api,
        key,
        OBSIDIAN_DEFAULT,
        (event) => conflicts.push(event),
        (event) => applied.push(event),
      );
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode('{"theme":"moonstone"}'));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, '{"theme":"obsidian"}', 2_000);
      adapter.files.set(path, encoder.encode('{"theme":"moonstone","v":2}'));
      adapter.files.touch(path, 1_000);

      await engine.initialSync();

      expect(textOf(adapter, path)).toBe('{"theme":"obsidian"}');
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "modify"]);
      expect(noConflictCopies(adapter)).toBe(true);
      expect(conflicts).toEqual([]);
      // The app has already read the old file: applying a peer's copy is exactly the
      // change the host answers with its reload card.
      expect(applied).toContainEqual({ plainPath: path, action: "write", group: "app" });
    });

    it("resolves an equal modification time to the remote side", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, "remote-v2", 5_000);
      adapter.files.set(path, encoder.encode("local-v2"));
      adapter.files.touch(path, 5_000);

      await engine.initialSync();

      // Both devices apply the same tie rule, so they converge instead of pushing past
      // each other forever.
      expect(textOf(adapter, path)).toBe("remote-v2");
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("brings a config file back as a restore when the local edit is newer than the deletion", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/snippets/wide.css";

      adapter.files.set(path, encoder.encode(".wide {}"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteDelete(fileId, 1_000);
      adapter.files.set(path, encoder.encode(".wide { color: red; }"));
      adapter.files.touch(path, 2_000);

      await engine.initialSync();

      expect(textOf(adapter, path)).toBe(".wide { color: red; }");
      // A live version after a tombstone is a restore on the same chain, not a new one.
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual(["create", "delete", "restore"]);
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("applies a deletion that is newer than the local copy", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const conflicts: ConflictResolvedEvent[] = [];
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT, (event) =>
        conflicts.push(event),
      );
      const path = ".obsidian/snippets/wide.css";

      adapter.files.set(path, encoder.encode(".wide {}"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteDelete(fileId, 2_000);
      adapter.files.set(path, encoder.encode(".wide { color: red; }"));
      adapter.files.touch(path, 1_000);

      await engine.initialSync();

      expect(adapter.files.has(path)).toBe(false);
      expect(noConflictCopies(adapter)).toBe(true);
      expect(conflicts).toEqual([]);
    });

    it("brings the file back when this device deleted it and a peer edited it", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // Deleted here (the push never landed), while the peer edited the file. A local
      // deletion carries no timestamp to argue with, so the remote side is applied —
      // and there is no local content to keep either way.
      adapter.files.delete(path);
      await api.remoteEdit(fileId, "peer-v2", 2_000);

      await engine.initialSync();

      expect(textOf(adapter, path)).toBe("peer-v2");
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("re-decides from the fresh chain when a peer pushes mid-conflict", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, "peer-older", 1_000);
      adapter.files.set(path, encoder.encode("local-newer"));
      adapter.files.touch(path, 2_000);
      // A second peer push lands between this device's decision and its push, so the
      // first conditional push is refused.
      api.onPush = async (files) => {
        api.onPush = null;
        for (const f of files) await api.remoteEdit(f.fileId, "peer-rushed", 1_500);
      };

      await engine.initialSync();

      // The local side is still newer than the chain the server showed, so it is pushed
      // again on top of it rather than parked or lost.
      expect(textOf(adapter, path)).toBe("local-newer");
      expect(api.chains.get(fileId)!.map((v) => v.action)).toEqual([
        "create",
        "modify",
        "modify",
        "modify",
      ]);
      expect(api.chains.get(fileId)!.at(-1)!.mtimeMs).toBe(2_000);
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("treats a second refusal as contention rather than a failed conflict", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // A peer version this device's later edit beats on time, so the local side is the
      // one that tries to push — through the notification path, which reports what the
      // engine could not apply.
      await api.remoteEdit(fileId, "peer-older", 1_000);
      const peerVersion = (await api.latestVersionId(fileId))!;
      adapter.files.set(path, encoder.encode("local-newer"));
      adapter.files.touch(path, Date.now());
      // Every push here is refused: a peer lands a version between the decision and the
      // request, twice in a row.
      api.onPush = async () => {
        await api.remoteEdit(fileId, "peer-rushed", 1_500);
      };

      // Nothing was written and nothing was lost, so this is a race the engine lost, not
      // a conflict it failed to settle: the notification must not report a failure, and
      // the next pass decides again from the newer chain.
      await expect(engine.handleFilePushed(fileId, peerVersion)).resolves.toBeUndefined();
      expect(textOf(adapter, path)).toBe("local-newer");
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("stamps a retried tombstone with the moment the deletion was decided", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/snippets/wide.css";

      adapter.files.set(path, encoder.encode(".wide {}"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // Deleted while the connection is down, so the tombstone cannot be pushed.
      const deletedAt = Date.now();
      api.offline = true;
      adapter.files.delete(path);
      await expect(engine.handleLocalDelete(path)).rejects.toThrow("network down");

      // The retry happens a minute later. Without the recorded moment the tombstone would
      // claim *this* time, which is newer than an edit a peer made in the gap — and a
      // config-folder conflict is settled by exactly that comparison.
      vi.setSystemTime(new Date(deletedAt + 60_000));
      api.offline = false;
      await engine.initialSync();

      const tombstone = api.chains.get(fileId)!.at(-1)!;
      expect(tombstone.action).toBe("delete");
      expect(tombstone.mtimeMs).toBe(deletedAt);
    });

    it("settles a local win through a notification instead of reporting a failure", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      // The peer's version is older on the time axis, so this device's copy is the one
      // that gets pushed — through the notification path, which is the caller that turns
      // "could not apply" into a reported failure.
      await api.remoteEdit(fileId, "peer-older", 1_000);
      const peerVersion = (await api.latestVersionId(fileId))!;
      adapter.files.set(path, encoder.encode("local-newer"));
      adapter.files.touch(path, 2_000);

      await expect(engine.handleFilePushed(fileId, peerVersion)).resolves.toBeUndefined();
      expect(textOf(adapter, path)).toBe("local-newer");
      // The local version became the head: the win is recorded on the chain, not only
      // in the state.
      expect(api.chains.get(fileId)!.at(-1)!.mtimeMs).toBe(2_000);
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("reports a conflict it could not push for a reason other than a refusal", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const engine = engineOver(adapter, api, key, OBSIDIAN_DEFAULT);
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("local-v1"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, "peer-older", 1_000);
      const peerVersion = (await api.latestVersionId(fileId))!;
      adapter.files.set(path, encoder.encode("local-newer"));
      adapter.files.touch(path, 2_000);

      // The local side wins on time, but the request itself cannot be made. That is not
      // a settled conflict, and the notification is the only thing that would say so.
      api.onPush = async () => {
        throw new Error("socket hang up");
      };
      await expect(engine.handleFilePushed(fileId, peerVersion)).rejects.toThrow(
        /Could not apply the conflict/,
      );

      // Nothing was written, so the local copy is untouched and no copy was parked.
      expect(textOf(adapter, path)).toBe("local-newer");
      expect(noConflictCopies(adapter)).toBe(true);
    });

    it("skips a local copy that grew past the size cap instead of pushing it", async () => {
      const { adapter, api, key } = await makeEngine(undefined, undefined, OBSIDIAN_DEFAULT);
      const tooLarge: FileTooLargeEvent[] = [];
      // A cap the local file outgrows *after* the pass that listed it: the notification
      // path reads the file before any reconcile could filter it, which is the one door
      // the engine's "skip before reading" rule has to watch itself.
      const scope: SyncScope = { ...OBSIDIAN_DEFAULT, maxFileBytes: 8 };
      const engine = new SyncEngine({
        platform: realPlatform,
        vaultId: "vault-1",
        adapter,
        api,
        encryptionKey: key,
        syncScope: scope,
        onFileTooLarge: (event) => tooLarge.push(event),
      });
      const path = ".obsidian/app.json";

      adapter.files.set(path, encoder.encode("small"));
      await engine.initialSync();
      const fileId = engine.fileIdForPath(path)!;

      await api.remoteEdit(fileId, "peer", 1_000);
      const peerVersion = (await api.latestVersionId(fileId))!;
      adapter.files.set(path, encoder.encode("x".repeat(64)));
      adapter.files.touch(path, 2_000);

      await expect(engine.handleFilePushed(fileId, peerVersion)).resolves.toBeUndefined();

      // Reported once, nothing pushed, nothing parked: the same answer an over-cap file
      // gets from a pass.
      expect(tooLarge).toEqual([{ plainPath: path, sizeBytes: 64 }]);
      expect(api.chains.get(fileId)!.at(-1)!.contentHash).not.toBe(
        await sha256Hex(encoder.encode("x".repeat(64))),
      );
      expect(textOf(adapter, path)).toBe("x".repeat(64));
      expect(noConflictCopies(adapter)).toBe(true);
    });
  });
});
