import {
  CHUNK_PLAINTEXT_BYTES,
  FakeAdapter,
  StreamingFakeAdapter,
  SyncEngine,
  chunkAdditionalData,
  conflictFilePath,
  decryptString,
  describe,
  encoder,
  encryptChunkBytes,
  encryptCombinedBytes,
  encryptString,
  engineOver,
  expect,
  expectSameBytes,
  fileTypesEngine,
  fileTypesWith,
  freezeConflictClock,
  it,
  makeEngine,
  normalizeScope,
  realPlatform,
  scopeWith,
  sha256Hex,
  sortedCopy,
} from "./engine.test-helpers";
import type { ConflictResolvedEvent, FileTooLargeEvent } from "./engine.test-helpers";

freezeConflictClock();

describe("SyncEngine — vault file types and the size cap", () => {
  /** A small PNG-shaped payload: bytes that are not valid UTF-8 on purpose. */
  const PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0xff, 0xfe, 0x80, 0x7f,
  ]);

  it("carries a binary file byte for byte", async () => {
    const source = await makeEngine(undefined, undefined, fileTypesWith("images"));
    source.adapter.files.set("photos/raw.png", PNG);

    await source.engine.initialSync();
    expect(source.api.pushed.map((p) => p.action)).toEqual(["create"]);
    expect(source.api.pushed[0]!.sizeBytes).toBe(PNG.byteLength);

    // A second device with the same switch pulls exactly those bytes.
    const target = await makeEngine(undefined, undefined, fileTypesWith("images"));
    target.api.chains = source.api.chains;
    target.api.blobs = source.api.blobs;
    target.api.paths = source.api.paths;

    await target.engine.initialSync();
    expect(Array.from(target.adapter.files.get("photos/raw.png")!)).toEqual(Array.from(PNG));
    expect(target.adapter.files.get("photos/raw.png")).not.toBe(PNG);
  });

  it("pushes markdown and canvas even with every file type switched off", async () => {
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, fileTypesWith());
    adapter.files.set("note.md", encoder.encode("# note"));
    adapter.files.set("board.canvas", encoder.encode("{}"));
    adapter.files.set("photo.png", PNG);
    adapter.files.set("archive.zip", encoder.encode("zip"));

    await engine.initialSync();

    const paths = await Promise.all(api.pushed.map((p) => decryptString(key, p.encryptedPath)));
    expect(sortedCopy(paths)).toEqual(["board.canvas", "note.md"]);
  });

  it("ignores a peer's file type this device has off, and syncs it once it is on", async () => {
    const { adapter, api, key } = await makeEngine();
    const photosOff = fileTypesEngine(adapter, api, key, fileTypesWith("pdf"));

    const bytes = PNG;
    const contentHash = await sha256Hex(bytes);
    const encryptedPath = await encryptString(key, "photos/raw.png");
    api.paths.set("f-photo", encryptedPath);
    api.blobs.set(contentHash, await encryptCombinedBytes(key, bytes as Uint8Array<ArrayBuffer>));
    api.chains.set("f-photo", [
      {
        versionId: "v-photo",
        contentHash,
        encryptedPath,
        action: "create",
        sizeBytes: bytes.byteLength,
        mtimeMs: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    await photosOff.initialSync();
    expect(adapter.files.has("photos/raw.png")).toBe(false);
    expect(photosOff.fileIdForPath("photos/raw.png")).toBeNull();

    // Turning the type on resumes where it stopped: the chain is still there.
    const photosOn = fileTypesEngine(adapter, api, key, fileTypesWith("images"));
    await photosOn.initialSync();
    expect(Array.from(adapter.files.get("photos/raw.png")!)).toEqual(Array.from(PNG));
  });

  it("never reads a local file over the cap, and reports it instead", async () => {
    const reported: FileTooLargeEvent[] = [];
    const scope = normalizeScope({ fileTypes: { images: true }, maxFileBytes: 4 });
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, scope, (event) =>
      reported.push(event),
    );
    adapter.files.set("small.md", encoder.encode("ok"));
    adapter.files.set("photos/big.png", PNG);

    await engine.initialSync();

    const paths = await Promise.all(api.pushed.map((p) => decryptString(key, p.encryptedPath)));
    expect(paths).toEqual(["small.md"]);
    // The point of the cap: the oversized file was never loaded to be hashed.
    expect(adapter.reads).not.toContain("photos/big.png");
    expect(reported).toEqual([{ plainPath: "photos/big.png", sizeBytes: PNG.byteLength }]);
    expect(engine.fileIdForPath("photos/big.png")).toBeNull();
  });

  it("takes a peer's version that is over the cap, because the cap bounds uploads", async () => {
    // A file a peer already uploaded is part of the vault: refusing it here made it
    // silently absent from a new device, which is indistinguishable from data loss.
    // The cap still keeps this device from **sending** such a file (the case above).
    const scope = normalizeScope({ fileTypes: { images: true }, maxFileBytes: 16 });
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, scope);
    const bytes = PNG;
    const contentHash = await sha256Hex(bytes);
    const encryptedPath = await encryptString(key, "photos/raw.png");
    api.paths.set("f-photo", encryptedPath);
    api.blobs.set(contentHash, await encryptCombinedBytes(key, bytes as Uint8Array<ArrayBuffer>));
    api.chains.set("f-photo", [
      {
        versionId: "v-photo",
        contentHash,
        encryptedPath,
        action: "create",
        // Larger than this device's cap, whatever the content actually is.
        sizeBytes: PNG.byteLength,
        mtimeMs: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    await engine.initialSync();
    expect(Array.from(adapter.files.get("photos/raw.png")!)).toEqual(Array.from(PNG));
    expect(engine.fileIdForPath("photos/raw.png")).toBe("f-photo");
  });

  /**
   * The case the first-bind tests miss: this device already holds the file, and the
   * administrator then lowers the cap below it. The cap refuses what this device
   * **sends**; a peer's newer version must still land, or the file is silently stale
   * forever — the exact failure the upload-only rule exists to remove.
   */
  it("applies a peer's newer version over an over-cap local copy that has not changed", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("0123456789abcdefghij"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    // A device that may only upload eight-byte files, holding the twenty-byte copy it
    // synced under a higher cap.
    const lowered = engineOver(adapter, api, key, { ...scopeWith(), maxFileBytes: 8 });
    lowered.loadState(engine.serializeState());
    await lowered.initialSync();
    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("0123456789abcdefghij");

    await api.remoteEdit(fileId, "peer-v2");
    await lowered.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("peer-v2");
  });

  /**
   * The other half of the same rule: an over-cap local copy that **changed** is an edit
   * this device can never send (the cap refuses it), and it must not be replaced
   * silently. The pass leaves it alone and the scan reports it.
   */
  it("leaves an over-cap local edit alone when a peer also pushed", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("0123456789abcdefghij"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    const lowered = engineOver(adapter, api, key, { ...scopeWith(), maxFileBytes: 8 });
    lowered.loadState(engine.serializeState());
    await lowered.initialSync();

    const localEdit = "a local edit that this device cannot upload";
    adapter.files.set("note.md", encoder.encode(localEdit));
    adapter.files.touch("note.md", Date.now() + 60_000);
    await api.remoteEdit(fileId, "peer-v2");

    await lowered.initialSync();

    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe(localEdit);
  });

  it("never applies a tombstone over an over-cap local copy", async () => {
    // Deleting a file this pass could not read would destroy content it never saw, and a
    // conflict copy cannot be parked without those bytes.
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("0123456789abcdefghij"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    const lowered = engineOver(adapter, api, key, { ...scopeWith(), maxFileBytes: 8 });
    lowered.loadState(engine.serializeState());
    await lowered.initialSync();

    await api.remoteDelete(fileId);
    await lowered.initialSync();

    expect(adapter.files.has("note.md")).toBe(true);
  });

  it("parks a binary conflict beside the original, extension and bytes intact", async () => {
    const conflicts: ConflictResolvedEvent[] = [];
    const scope = fileTypesWith("images");
    const { engine, adapter, api } = await makeEngine(
      undefined,
      (event) => conflicts.push(event),
      scope,
    );
    adapter.files.set("photos/raw.png", PNG);
    await engine.initialSync();

    const fileId = engine.fileIdForPath("photos/raw.png")!;
    // The peer moves ahead while this device edits the same image: the remote wins, and
    // the local bytes are parked beside the original — under an extension Obsidian can
    // still open, not as a `.conflict.md` full of PNG.
    await api.remoteEditWithSize(fileId, "peer-version", PNG.byteLength);
    const local = new Uint8Array([...PNG, 0x01]);
    adapter.files.set("photos/raw.png", local);
    await engine.handleLocalChange("photos/raw.png");

    const parked = conflictFilePath("photos/raw.png");
    expect(parked.endsWith(".conflict.png")).toBe(true);
    expect(conflicts.map((event) => event.conflictPath)).toEqual([parked]);
    expect(Array.from(adapter.files.get(parked)!)).toEqual(Array.from(local));
    expect(new TextDecoder().decode(adapter.files.get("photos/raw.png"))).toBe("peer-version");
  });
});

describe("SyncEngine — what a large file costs", () => {
  /**
   * A payload big enough to be worth not sending twice, small enough to keep the test
   * fast. Its bytes matter: they are compared after a move.
   */
  const LARGE = new Uint8Array(64 * 1024).map((_, index) => (index * 31) % 251);

  /**
   * A file that has not changed since its sync point is not read again.
   *
   * Every pass used to read and hash every syncable file in the vault, which for a
   * vault of attachments means re-reading gigabytes every five minutes (and on every
   * reconnect) to discover that nothing had happened. The state records the size and
   * modification time the hash was taken at, and a pass that finds them unchanged
   * reuses the hash.
   */
  it("does not read a file whose stamp has not moved, and still reads one that has", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();

    adapter.reads.length = 0;
    await engine.initialSync();
    // Nothing changed: the pass reused the recorded hash instead of reading the file.
    expect(adapter.reads).not.toContain("note.md");

    // An edit made while nothing was watching moves the stamp, so the pass reads it
    // and pushes the new content.
    adapter.files.set("note.md", encoder.encode("v2"));
    adapter.reads.length = 0;
    await engine.initialSync();
    expect(adapter.reads).toContain("note.md");
    const fileId = engine.fileIdForPath("note.md")!;
    expect(await api.readPlainLatest(fileId)).toBe("v2");
  });

  it("reads an edited file once, and pushes the bytes it read", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.set("note.md", encoder.encode("v2"));
    adapter.reads.length = 0;
    await engine.handleLocalChange("note.md");

    // The event handler's read is the one the decision and the push use. It used to
    // read the file a second time after fetching the chain, and hash it twice more.
    expect(adapter.reads).toEqual(["note.md"]);
    expect(await api.readPlainLatest(fileId)).toBe("v2");
  });

  it("re-reads an edit that lands while the chain is being fetched", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;

    adapter.files.set("note.md", encoder.encode("v2"));
    api.onPull = async () => {
      adapter.files.set("note.md", encoder.encode("v3"));
    };
    adapter.reads.length = 0;
    try {
      await engine.handleLocalChange("note.md");
    } finally {
      api.onPull = null;
    }

    // The bytes read before the fetch were stale by the time the decision ran; the
    // stamp check sends it back to disk, so the version carries what is actually there
    // instead of silently pushing the superseded content.
    expect(adapter.reads).toEqual(["note.md", "note.md"]);
    expect(await api.readPlainLatest(fileId)).toBe("v3");
  });

  it("moves a file without reading it when its stamp still matches the sync point", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((push) => push.action === "create")!;
    const fileId = engine.fileIdForPath("big.mp4")!;

    // A real rename keeps the modification time. The fake's `set` stamps a new one, so
    // the move states the old stamp explicitly.
    const mtime = adapter.files.mtimes.get("big.mp4")!;
    adapter.files.set("moved/big.mp4", LARGE);
    adapter.files.touch("moved/big.mp4", mtime);
    adapter.files.delete("big.mp4");
    adapter.reads.length = 0;

    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    const rename = api.pushed.at(-1)!;
    expect(rename.action).toBe("rename");
    expect(rename.content).toBeNull();
    expect(rename.sizeBytes).toBe(LARGE.byteLength);
    // The move names the create's content, not a re-encoding of it.
    expect(rename.contentHash).toBe(created.contentHash);
    // A move's cost used to be a full read and hash of the file, only to learn there
    // was nothing to send.
    expect(adapter.reads).toEqual([]);
    // The stamp is part of the sync point, or the next pass pays that read again.
    const state = JSON.parse(engine.serializeState()) as Record<string, { stamp?: unknown }>;
    expect(state[fileId]?.stamp).toBeDefined();
    adapter.reads.length = 0;
    await engine.initialSync();
    expect(adapter.reads).toEqual([]);
  });

  it("does not overwrite an edit that lands between the prefetch and a pull decision", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    const fileId = engine.fileIdForPath("note.md")!;
    const mtime = adapter.files.mtimes.get("note.md")!;

    // A peer moves the chain, so the decision for an unchanged local file is `pull`.
    await api.remoteEdit(fileId, "RR");

    // `applyLocalChange` reads "v1" (the sync point), then this edit lands during the
    // chain fetch — same size, same mtime, so the stamp check cannot see it.
    api.onPull = async () => {
      adapter.files.set("note.md", encoder.encode("v2"));
      adapter.files.touch("note.md", mtime);
    };
    try {
      await engine.handleLocalChange("note.md");
    } finally {
      api.onPull = null;
    }

    // The pull path re-reads before acting: the bytes are now "v2", so this is a
    // conflict — the remote wins and the local edit is parked, not overwritten.
    const conflict = [...adapter.files.keys()].find((name) => name.includes(".conflict"));
    expect(conflict).toBeDefined();
    expect(new TextDecoder().decode(adapter.files.get(conflict!))).toBe("v2");
    expect(new TextDecoder().decode(adapter.files.get("note.md"))).toBe("RR");
  });

  it("reads a moved file whose stamp moved with it, and sends the new content", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();

    // Edited and renamed with no event in between: the stamp no longer proves the
    // sync point's hash, so the move falls back to reading — and pushes the bytes that
    // are actually there rather than reusing the old content.
    const edited = LARGE.slice();
    edited[0] = (edited[0]! + 1) % 256;
    adapter.files.delete("big.mp4");
    adapter.files.set("moved/big.mp4", edited);
    adapter.reads.length = 0;

    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    expect(adapter.reads).toEqual(["moved/big.mp4"]);
    expect(api.pushed.at(-1)!.content).not.toBeNull();
  });

  it("sends the content for a stamp-proved move when the store lost the blob", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    api.blobs.delete(created.contentHash);

    const mtime = adapter.files.mtimes.get("big.mp4")!;
    adapter.files.set("moved/big.mp4", LARGE);
    adapter.files.touch("moved/big.mp4", mtime);
    adapter.files.delete("big.mp4");
    adapter.reads.length = 0;

    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    // The move sent no content, the server refused it (`content_missing`), and only
    // then did the engine read the file: the retry is the one place a stamp-proved move
    // pays for bytes.
    expect(adapter.reads).toEqual(["moved/big.mp4"]);
    expect(api.pushed.at(-1)!.content).not.toBeNull();
  });

  it("re-uploads a chunked move in chunks when the store lost the blob", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).fill(5);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    // The chain still points at the content, but the blob is gone.
    api.blobs.delete(created.contentHash);
    api.uploadCalls.length = 0;

    const mtime = adapter.files.mtimes.get("big.mp4")!;
    adapter.files.set("moved/big.mp4", bytes);
    adapter.files.touch("moved/big.mp4", mtime);
    adapter.files.delete("big.mp4");
    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    // A whole payload above the threshold would be rejected by the wire and unreadable
    // to a chunk-capable peer, so the retry stages chunks again.
    expect(api.uploadCalls.map((call) => call.index)).toEqual([0, 1, 2]);
    const rename = api.pushed.at(-1)!;
    expect(rename.action).toBe("rename");
    expect(rename.content).toBeNull();
    expect(rename.contentChunks).toBe(3);

    // …and a peer reads it back.
    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    await peer.initialSync();
    const pulled = peerAdapter.files.get("moved/big.mp4")!;
    expect(pulled.byteLength).toBe(bytes.byteLength);
    // A byte loop rather than Buffer/Array.from: the engine package declares no runtime types.
    let mismatch = -1;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (pulled[index] !== bytes[index]) {
        mismatch = index;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  }, 20_000);

  it("refuses to rebind a content hash when the file changed before the retry", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    api.blobs.delete(created.contentHash);

    // Same size, same mtime (so the stamp still matches), different bytes: exactly the
    // window the stamp cannot see.
    const edited = LARGE.slice();
    edited[0] = (edited[0]! + 1) % 256;
    const mtime = adapter.files.mtimes.get("big.mp4")!;
    adapter.files.set("moved/big.mp4", edited);
    adapter.files.touch("moved/big.mp4", mtime);
    adapter.files.delete("big.mp4");

    await expect(engine.handleLocalRename("big.mp4", "moved/big.mp4")).rejects.toThrow(
      /Version content not found/,
    );
    // The old hash was not rebound to bytes that are not its content.
    expect(api.blobs.has(created.contentHash)).toBe(false);
  });

  it("records the stamp with the hash, so a restart keeps the benefit", async () => {
    let saved: string | null = null;
    const { engine, adapter, api, key } = await makeEngine((json) => {
      saved = json;
    });
    adapter.files.set("note.md", encoder.encode("v1"));
    await engine.initialSync();
    expect(saved).not.toBeNull();

    // A second engine over the same persisted state and the same filesystem — what
    // reopening Obsidian does.
    const restarted = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
    });
    restarted.loadState(saved!);
    adapter.reads.length = 0;
    await restarted.initialSync({ firstBind: true });
    expect(adapter.reads).not.toContain("note.md");
  });

  it("pushes a rename without its content, and records the size a peer applies its cap to", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    expect(created.content).not.toBeNull();

    adapter.files.delete("big.mp4");
    adapter.files.set("moved/big.mp4", LARGE);
    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    const rename = api.pushed.at(-1)!;
    expect(rename.action).toBe("rename");
    // The bytes are the ones the chain's head already holds, so none are sent...
    expect(rename.content).toBeNull();
    // ...but the version still reports the real plaintext size, so a peer that never
    // had the file still applies its own size cap before pulling.
    expect(rename.sizeBytes).toBe(LARGE.byteLength);
    expect(api.blobs.size).toBe(1);
  });

  it("sends the content after all when the store no longer holds it", async () => {
    // The safety net behind the shortcut: the server refuses a content-less version
    // whose bytes it does not have (`content_missing`), and the engine answers by
    // sending the payload instead of leaving a chain nobody can fetch.
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    api.blobs.delete(created.contentHash);

    adapter.files.delete("big.mp4");
    adapter.files.set("moved/big.mp4", LARGE);
    await engine.handleLocalRename("big.mp4", "moved/big.mp4");

    const rename = api.pushed.at(-1)!;
    expect(rename.action).toBe("rename");
    expect(rename.content).not.toBeNull();
    expect(api.blobs.get(rename.contentHash)).toBeDefined();
  });

  it("follows a peer's rename without downloading the content it already has", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;

    // The peer moves the file: a new version, same content hash, new path.
    const versionId = await api.remoteRename(created.fileId, await encryptString(key, "new.mp4"));
    api.contentFetches.length = 0;
    await engine.handleFilePushed(created.fileId, versionId);

    expect(api.contentFetches).toEqual([]);
    expect(adapter.files.has("old.mp4")).toBe(false);
    expect(Array.from(adapter.files.get("new.mp4")!)).toEqual(Array.from(LARGE));
  });

  it("still downloads for a device that never had the file", async () => {
    // The shortcut is "this device already holds those bytes", never "everyone does":
    // a fresh client must fetch the content its chain points at.
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.mp4", LARGE);
    await engine.initialSync();
    const created = api.pushed.find((p) => p.action === "create")!;
    const versionId = await api.remoteRename(created.fileId, await encryptString(key, "new.mp4"));

    // A device that has never synced this vault, learning about the file from the
    // chain alone.
    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    api.contentFetches.length = 0;
    await peer.handleFilePushed(created.fileId, versionId);

    expect(api.contentFetches).toHaveLength(1);
    expect(Array.from(peerAdapter.files.get("new.mp4")!)).toEqual(Array.from(LARGE));
  });

  it("creates a bind's files in batches instead of one request each", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }
    await engine.initialSync();

    // 250 files, at most 100 per request: three pushes, not 250.
    expect(api.pushCalls).toEqual([100, 100, 50]);
    expect(api.chains.size).toBe(250);
    expect([...api.chains.values()].every((chain) => chain.length === 1)).toBe(true);
  });

  it("sends a file too large for a batch on its own", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("small.md", encoder.encode("# small"));
    // Over the 8 MiB batch bound: it never shares a request with another file, so a
    // bind holds one large payload at a time rather than a vault's worth of them.
    adapter.files.set("big.mp4", new Uint8Array(9 * 1024 * 1024).fill(7));
    await engine.initialSync();

    expect(api.pushCalls).toEqual([1, 1]);
    expect(api.chains.size).toBe(2);
    // Over the chunking threshold too, so it travelled through the chunk endpoints and
    // its push carried no payload at all.
    expect(api.uploadCalls.length).toBeGreaterThan(0);
    const chunked = api.pushed.find((p) => p.contentChunks === 3)!;
    expect(chunked.content).toBeNull();
  });

  it("moves a large file in chunks, and a peer fetches it in ranges", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).map((_, index) => (index * 31) % 251);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();

    const count = Math.ceil(bytes.byteLength / CHUNK_PLAINTEXT_BYTES);
    expect(api.uploadCalls.map((call) => call.index)).toEqual([0, 1, 2]);
    const push = api.pushed.at(-1)!;
    expect(push.content).toBeNull();
    expect(push.contentChunks).toBe(count);
    // The fake store assembled the chunks like the server: concatenated ciphertexts,
    // 28 bytes of IV and tag each.
    expect(api.blobs.get(push.contentHash)!.byteLength).toBe(bytes.byteLength + count * 28);

    // A peer fetches the version one range at a time and reassembles it.
    const peerAdapter = new FakeAdapter();
    const peer = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: peerAdapter,
      api,
      encryptionKey: key,
    });
    api.rangeFetches.length = 0;
    await peer.initialSync();

    expect(api.rangeFetches).toHaveLength(count);
    const pulled = peerAdapter.files.get("big.mp4")!;
    expect(pulled.byteLength).toBe(bytes.byteLength);
    let mismatch = -1;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (pulled[index] !== bytes[index]) {
        mismatch = index;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  }, 20_000);

  it("streams a large peer download through the adapter's sink", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).map((_, index) => (index * 37) % 251);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();

    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    const count = Math.ceil(bytes.byteLength / CHUNK_PLAINTEXT_BYTES);
    api.rangeFetches.length = 0;
    await peer.initialSync();

    // One sink, one chunk per ranged request, and no whole-file write at all: this is
    // the memory bound the streaming path exists for.
    expect(peerAdapter.streamed).toHaveLength(1);
    expect(peerAdapter.streamed[0]).toMatchObject({ path: "big.mp4", chunks: count });
    expect(peerAdapter.wholeWrites).toEqual([]);
    expect(peerAdapter.aborted).toEqual([]);
    expect(api.rangeFetches).toHaveLength(count);

    const pulled = peerAdapter.files.get("big.mp4")!;
    expect(pulled.byteLength).toBe(bytes.byteLength);
    expectSameBytes(pulled, bytes);
  }, 20_000);

  it("falls back to a whole write when the streaming sink fails", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).fill(2);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();

    const peerAdapter = new StreamingFakeAdapter();
    peerAdapter.failBeginWrite = true;
    const peer = engineOver(peerAdapter, api, key);
    await expect(peer.initialSync()).resolves.toBeUndefined();

    // The sink is an optional capability; a host whose implementation is broken must
    // still receive the file through the old whole-buffer path rather than fail forever.
    expect(peerAdapter.streamed).toEqual([]);
    expect(peerAdapter.wholeWrites).toEqual(["big.mp4"]);
    expectSameBytes(peerAdapter.files.get("big.mp4")!, bytes);
  }, 20_000);

  it("keeps a streamed pull's own event from becoming a local edit", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(3));
    await engine.initialSync();
    const fileId = api.pushed.at(-1)!.fileId;
    const versionId = api.chains.get(fileId)!.at(-1)!.versionId;

    // A bound peer, so the re-entering event handler does not start a bind of its own.
    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    await peer.initialSync();
    // The bind's decision may stat/read a path that is absent; only the event after the
    // stream matters here, so start counting from the notification.
    peerAdapter.reads.length = 0;
    // The host feeds the write's vault event straight back, exactly as Obsidian does.
    peerAdapter.onWrite = async (path) => {
      await peer.handleLocalChange(path);
    };
    const pushCallsBefore = api.pushCalls.length;

    await peer.handleFilePushed(fileId, versionId);
    await peerAdapter.settleEvents();

    // The self-event record covers the whole stream (the hash was known before `close`),
    // so the event is recognised instead of pushing the pulled bytes back as an edit.
    expect(api.pushCalls.length).toBe(pushCallsBefore);
    // …and, equally important, the event did not read the file back: the stamp recorded
    // at the commit is what answers it. A read here would allocate the whole attachment
    // on the plugin right after the streamed write.
    expect(peerAdapter.reads.filter((path) => path === "big.mp4")).toEqual([]);
    expect(peerAdapter.aborted).toEqual([]);
    expect(await peer.fileIdForPath("big.mp4")).not.toBeNull();
  }, 20_000);

  it("still reads a genuine edit inside the streamed write's window", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(6));
    await engine.initialSync();
    const fileId = api.pushed.at(-1)!.fileId;
    const versionId = api.chains.get(fileId)!.at(-1)!.versionId;

    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    await peer.initialSync();
    peerAdapter.onWrite = async (path) => {
      await peer.handleLocalChange(path);
    };
    await peer.handleFilePushed(fileId, versionId);
    await peerAdapter.settleEvents();

    const edited = new Uint8Array(8 * 1024 * 1024 + 1024).fill(8);
    peerAdapter.files.set("big.mp4", edited);
    const pushCallsBefore = api.pushCalls.length;
    await peer.handleLocalChange("big.mp4");

    // The stamp moved, so the fast path cannot answer; the edit is read, hashed and
    // pushed like any other.
    expect(peerAdapter.reads.filter((path) => path === "big.mp4").length).toBeGreaterThan(0);
    expect(api.pushCalls.length).toBeGreaterThan(pushCallsBefore);
  }, 20_000);

  it("aborts a streamed pull that cannot decrypt, and retries it whole later", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).fill(4);
    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();
    const head = api.chains.get(api.pushed.at(-1)!.fileId)!.at(-1)!;

    // A stored blob whose second chunk no longer decrypts: the temporary file must be
    // discarded, not renamed over a target.
    const stored = api.blobs.get(head.contentHash)!;
    const damaged = stored.slice();
    damaged[CHUNK_PLAINTEXT_BYTES + 28 + 5] ^= 0xff;
    api.blobs.set(head.contentHash, damaged);

    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    await expect(peer.initialSync()).resolves.toBeUndefined();

    expect(peerAdapter.streamed).toHaveLength(1);
    expect(peerAdapter.aborted).toEqual(["big.mp4"]);
    expect(peerAdapter.files.has("big.mp4")).toBe(false);

    // The pass is the retry: with the stored bytes intact again the file lands and the
    // earlier abort left nothing behind.
    api.blobs.set(head.contentHash, stored);
    peerAdapter.aborted.length = 0;
    await peer.initialSync();
    expect(peerAdapter.aborted).toEqual([]);
    expectSameBytes(peerAdapter.files.get("big.mp4")!, bytes);
  }, 20_000);

  it("refuses a chunk-valid blob whose plaintext hashes to a different content hash", async () => {
    const { api, key } = await makeEngine();
    const size = 8 * 1024 * 1024 + 1024;
    const plaintext = new Uint8Array(size).fill(9);
    const claimedHash = "a".repeat(64);
    const count = Math.ceil(size / CHUNK_PLAINTEXT_BYTES);

    // Every chunk decrypts under the claimed hash and its position, but the concatenated
    // plaintext does not hash to that value. Per-chunk AEAD cannot see this; the
    // streaming whole-file hash must.
    const parts: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const start = index * CHUNK_PLAINTEXT_BYTES;
      const end = Math.min(start + CHUNK_PLAINTEXT_BYTES, size);
      parts.push(
        await encryptChunkBytes(
          key,
          plaintext.subarray(start, end) as Uint8Array<ArrayBuffer>,
          chunkAdditionalData(claimedHash, index, count, size),
        ),
      );
    }
    const blob = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      blob.set(part, offset);
      offset += part.byteLength;
    }
    api.blobs.set(claimedHash, blob);
    const fileId = "forged-file";
    const encryptedPath = await encryptString(key, "forged.mp4");
    api.paths.set(fileId, encryptedPath);
    api.chains.set(fileId, [
      {
        versionId: "forged-version",
        contentHash: claimedHash,
        encryptedPath,
        action: "create",
        sizeBytes: size,
        mtimeMs: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    const peerAdapter = new StreamingFakeAdapter();
    const peer = engineOver(peerAdapter, api, key);
    await expect(peer.initialSync()).resolves.toBeUndefined();

    expect(peerAdapter.streamed).toHaveLength(1);
    expect(peerAdapter.aborted).toEqual(["forged.mp4"]);
    expect(peerAdapter.files.has("forged.mp4")).toBe(false);
  }, 20_000);

  it("reports a chunked create the server refused, and tracks nothing", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(5));
    // The server answers every chunk with `received: 0`, so nothing is ever staged and
    // the push that names the upload is refused with `chunk_missing` — what a truncated
    // upload looks like from the client's side.
    api.uploadChunk = async () => ({ received: 0 });

    await expect(engine.initialSync()).rejects.toThrow(/Push failed for big\.mp4: chunk_missing/);
    // The failed create is not left half-tracked: the next pass must retry it through
    // the chunk endpoints, not as a one-file plain push of a payload the wire rejects.
    expect(engine.fileIdForPath("big.mp4")).toBeNull();
    expect(engine.serializeState()).not.toContain("big.mp4");
  }, 20_000);

  it("does not leave a chunked create behind when the upload itself fails", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("big.mp4", new Uint8Array(8 * 1024 * 1024 + 1024).fill(5));
    api.uploadChunk = async () => {
      throw new Error("chunk upload failed");
    };

    await expect(engine.initialSync()).rejects.toThrow("chunk upload failed");
    // Same rule on the throwing path: the pending create goes with the failed upload, so
    // the retry starts from the batched/chunked decision instead of a stale state entry.
    expect(engine.fileIdForPath("big.mp4")).toBeNull();
    expect(engine.serializeState()).not.toContain("big.mp4");
  }, 20_000);

  it("abandons the pending batch when the adapter fails mid-bind", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("first"));
    adapter.files.set("b.md", encoder.encode("second"));
    const readFile = adapter.readFile.bind(adapter);
    adapter.readFile = async (path: string) => {
      if (path === "b.md") throw new Error("disk error");
      return await readFile(path);
    };

    await expect(engine.initialSync()).rejects.toThrow("disk error");

    // A file the pass had already prepared for the batch must not stay "tracked, no
    // version": that entry makes the next pass push it on its own, one request at a
    // time, and it is invisible in the history. The throw is the adapter's, not the
    // server's, so the file itself is fine and must be retried normally.
    adapter.readFile = readFile;
    expect(engine.fileIdForPath("a.md")).toBeNull();
    expect(engine.fileIdForPath("b.md")).toBeNull();

    await engine.initialSync();
    const paths = await Promise.all(api.pushed.map((p) => decryptString(api.key, p.encryptedPath)));
    expect(sortedCopy(paths)).toEqual(["a.md", "b.md"]);
  }, 20_000);

  it("resumes a chunked upload from the prefix the server already holds", async () => {
    const { engine, adapter, api } = await makeEngine();
    const bytes = new Uint8Array(8 * 1024 * 1024 + 1024).fill(9);
    const size = bytes.byteLength;
    const count = Math.ceil(size / CHUNK_PLAINTEXT_BYTES);
    const hash = await sha256Hex(bytes);

    // A previous attempt staged chunk 0 and then the connection dropped.
    await api.uploadChunk(
      "vault-1",
      hash,
      0,
      count,
      size,
      new Uint8Array(CHUNK_PLAINTEXT_BYTES + 28),
    );
    api.uploadCalls.length = 0;

    adapter.files.set("big.mp4", bytes);
    await engine.initialSync();

    // The retry asks for the resumed prefix and uploads only what is missing.
    expect(api.uploadCalls.map((call) => call.index)).toEqual([1, 2]);
  });
});
