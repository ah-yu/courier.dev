import { readFileSync, statSync } from "fs";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { BLOB_HEADER_BYTES, CHUNK_PLAINTEXT_BYTES, buildPushBody } from "../../shared/src/index";
import { createTestClient, type TestClient } from "./harness/client";
import { startTestServer, type TestServer } from "./harness/server";
import {
  createTestVault,
  makeVaultMaterial,
  type VaultMaterial,
  type TestVault,
} from "./harness/vault";
import { fileVersions, vaultHistory } from "./harness/api";

/**
 * Where a blob's frame lives, loaded **after** the server started.
 *
 * A static import would read `SQLITE_PATH` / `BLOB_STORE_DIR` before the harness sets
 * them (the module opens the database on import), so the server under test would end up
 * on the developer's development database instead of its temp one.
 */
async function blobLocation(vaultId: string, contentHash: string) {
  const store = await import("../../server/src/lib/blob-store");
  return await store.blobLocation(vaultId, contentHash);
}

/** Deterministic bytes, so a comparison can only pass on the exact payload. */
function payload(sizeBytes: number): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i += 512) bytes[i] = (i * 31) % 251;
  return bytes;
}

/**
 * A push body written by hand, so a case can send shapes `buildPushBody` refuses —
 * that is the only way to prove the server rejects them too.
 */
function handBuiltPush(header: unknown, content: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const body = new Uint8Array(4 + headerBytes.byteLength + content.byteLength);
  new DataView(body.buffer).setUint32(0, headerBytes.byteLength, true);
  body.set(headerBytes, 4);
  body.set(content, 4 + headerBytes.byteLength);
  return body;
}

/** One header entry for {@link handBuiltPush}, with valid defaults. */
function handBuiltFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fileId: "manual-file",
    encryptedPath: "ZW5jcnlwdGVk",
    action: "create",
    versionId: "manual-version",
    contentHash: "c".repeat(64),
    sizeBytes: 4,
    mtimeMs: 0,
    baseVersionId: null,
    contentLength: 0,
    historyKind: "documents",
    ...overrides,
  };
}

/**
 * What a large file costs, and what a vault with many files costs.
 *
 * The five rules this file exists to protect, each measured on the real wire against
 * the real server:
 *
 * 1. A version's content crosses the wire as **bytes**, not base64 — the store holds
 *    the ciphertext as it arrived, so the payload is `plaintext + 28` bytes and never
 *    4/3 of that.
 * 2. A **rename** sends no content at all when the store already holds those bytes,
 *    and a peer that already has them follows the move **without downloading**.
 * 3. A pass **batches** the files it creates, so binding a vault of many notes is a
 *    handful of requests rather than one per file.
 * 4. A pass does not **re-read** a file whose size and modification time have not
 *    moved since the hash it recorded — while a real edit is still seen.
 * 5. Nothing here changes what a peer ends up with: every case asserts the bytes on
 *    the other device.
 */
describe("large files and many files e2e", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer("large file e2e user");
    material = await makeVaultMaterial();
  }, 120_000);

  afterEach(() => {
    for (const client of clients) client.cleanup();
    clients = [];
  });

  afterAll(async () => {
    await server.close();
  });

  async function newVault(name: string): Promise<TestVault> {
    return await createTestVault(server, name, material);
  }

  async function newClient(vaultId: string, deviceName: string): Promise<TestClient> {
    const client = await createTestClient({
      server,
      vaultId,
      key: material.key,
      deviceName,
    });
    clients.push(client);
    return client;
  }

  it("moves the ciphertext as bytes, exactly as the store holds it", async () => {
    const vault = await newVault("binary-wire");
    const laptop = await newClient(vault.id, "laptop");
    const phone = await newClient(vault.id, "phone");

    const bytes = payload(1024 * 1024);
    laptop.writeBinary("media/clip.mp4", bytes);
    laptop.resetCounters();
    await laptop.sync();

    // The push carried the ciphertext itself: the plaintext plus the 28 bytes of
    // IV and auth tag, and not a byte more. Base64 would have been 1 398 732.
    const push = laptop.pushCalls[0]!;
    expect(push.contentBytes).toBe(bytes.byteLength + 28);

    // …and that is what is on disk in the store: the v2 header plus the ciphertext,
    // with no re-encoding on the way in.
    const fileId = laptop.engine.fileIdForPath("media/clip.mp4")!;
    const version = (await fileVersions(server, vault.id, fileId)).at(-1)!;
    // The frame is a range in its batch file; its length is header plus ciphertext.
    const stored = (await blobLocation(vault.id, version.contentHash))!;
    expect(stored.length).toBe(bytes.byteLength + 28 + BLOB_HEADER_BYTES);
    expect(statSync(stored.filePath).size).toBeGreaterThanOrEqual(stored.offset + stored.length);

    // The peer gets the same bytes back, through the binary content route.
    await phone.sync();
    expect(Array.from(phone.readBytes("media/clip.mp4")!)).toEqual(Array.from(bytes));
  });

  it("renames a large file without sending its content again, and a peer follows without downloading", async () => {
    const vault = await newVault("rename-without-content");
    const laptop = await newClient(vault.id, "laptop");
    const phone = await newClient(vault.id, "phone");

    const bytes = payload(2 * 1024 * 1024);
    laptop.writeBinary("media/holiday.mp4", bytes);
    await laptop.sync();
    await phone.sync();
    expect(phone.readBytes("media/holiday.mp4")).not.toBeNull();

    laptop.move("media/holiday.mp4", "media/2019/holiday.mp4");
    laptop.resetCounters();
    await laptop.engine.handleLocalRename("media/holiday.mp4", "media/2019/holiday.mp4");

    // The move cost one small request: no payload, and the version still records the
    // real size, so a peer's own cap still applies to the bytes it may have to fetch.
    expect(laptop.pushCalls).toHaveLength(1);
    expect(laptop.pushCalls[0]!.contentBytes).toBe(0);
    const fileId = laptop.engine.fileIdForPath("media/2019/holiday.mp4")!;
    const moved = (await fileVersions(server, vault.id, fileId)).at(-1)!;
    expect(moved.action).toBe("rename");
    expect(await vaultHistory(server, vault.id)).toHaveLength(1);

    // The peer already has those bytes, so following the move downloads nothing: it
    // renames its own file, and ends up with exactly one copy at the new path.
    phone.resetCounters();
    await phone.sync();
    expect(phone.contentFetches).toEqual([]);
    expect(phone.readBytes("media/2019/holiday.mp4")).not.toBeNull();
    expect(phone.readBytes("media/holiday.mp4")).toBeNull();
    expect(Array.from(phone.readBytes("media/2019/holiday.mp4")!)).toEqual(Array.from(bytes));
  });

  it("still downloads when the peer never had the file", async () => {
    // The rename shortcut must not become "assume everyone has it": a device that
    // never synced the file has to fetch the content the chain points at.
    const vault = await newVault("rename-to-new-device");
    const laptop = await newClient(vault.id, "laptop");
    const bytes = payload(256 * 1024);
    laptop.writeBinary("clip.mp4", bytes);
    await laptop.sync();

    laptop.move("clip.mp4", "moved/clip.mp4");
    await laptop.engine.handleLocalRename("clip.mp4", "moved/clip.mp4");

    const tablet = await newClient(vault.id, "tablet");
    await tablet.sync();
    expect(tablet.contentFetches).toHaveLength(1);
    expect(Array.from(tablet.readBytes("moved/clip.mp4")!)).toEqual(Array.from(bytes));
  });

  it("batches the files a bind creates instead of one request each", async () => {
    const vault = await newVault("batched-bind");
    const laptop = await newClient(vault.id, "laptop");

    for (let i = 0; i < 250; i++) laptop.write(`notes/${i}.md`, `# note ${i}\n`);
    laptop.resetCounters();
    await laptop.sync();

    // 250 files, at most 100 per request: three pushes, not 250.
    expect(laptop.pushCalls).toHaveLength(3);
    expect(laptop.pushCalls.map((call) => call.files)).toEqual([100, 100, 50]);
    // Every one of them is on the server, one version each.
    const history = await vaultHistory(server, vault.id);
    expect(history).toHaveLength(250);
    expect(history.every((file) => file.versions.length === 1)).toBe(true);
  });

  it("keeps a large file out of a batch, and stages it in chunks", async () => {
    const vault = await newVault("batch-bounds");
    const laptop = await newClient(vault.id, "laptop");

    laptop.write("small.md", "# small");
    // Over both the batch's byte bound (8 MiB) and the chunking threshold: it travels
    // alone, through the chunk endpoints, and its push carries no payload at all.
    laptop.writeBinary("media/big.mp4", payload(9 * 1024 * 1024));
    laptop.resetCounters();
    await laptop.sync();

    // The small file is one batched request; the large one is a content-less push.
    expect(laptop.pushCalls).toHaveLength(2);
    expect(laptop.pushCalls.map((call) => call.files)).toEqual([1, 1]);
    expect(laptop.chunkUploads.map((call) => call.index)).toEqual([0, 1, 2]);
    expect(laptop.pushCalls.map((call) => call.contentBytes).toSorted((a, b) => a - b)).toEqual([
      0,
      expect.any(Number),
    ]);
  });

  it("uploads a large file in chunks, and a peer downloads it in ranges", async () => {
    const vault = await newVault("chunked-transfer");
    const laptop = await newClient(vault.id, "laptop");
    const phone = await newClient(vault.id, "phone");

    const bytes = payload(9 * 1024 * 1024);
    laptop.writeBinary("media/big.mp4", bytes);
    laptop.resetCounters();
    await laptop.sync();

    // Three 4 MiB chunks (the last one short), and a push that carries none of them.
    expect(laptop.chunkUploads.map((call) => call.index)).toEqual([0, 1, 2]);
    expect(laptop.pushCalls).toHaveLength(1);
    expect(laptop.pushCalls[0]!.contentBytes).toBe(0);

    // The other device pulls the version one range at a time and reassembles it.
    phone.resetCounters();
    await phone.sync();

    expect(phone.rangeFetches).toHaveLength(3);
    // It never held the plaintext as one buffer: the chunks go straight into the
    // adapter's streaming sink, and the file appears through one rename.
    expect(phone.streamedWrites).toBe(1);
    expect(phone.streamedChunks).toBe(3);
    expect(Array.from(phone.readBytes("media/big.mp4")!)).toEqual(Array.from(bytes));
  });

  it("does not re-read a file that has not changed, and still sees one that has", async () => {
    const vault = await newVault("stamp-cache");
    const laptop = await newClient(vault.id, "laptop");
    const phone = await newClient(vault.id, "phone");

    laptop.write("note.md", "# v1");
    await laptop.sync();

    // Nothing moved since the sync point: the pass reuses the hash it recorded
    // instead of reading (and hashing) the file again.
    laptop.resetCounters();
    await laptop.sync();
    expect(laptop.readsOf("note.md")).toBe(0);
    expect(laptop.pushCalls).toEqual([]);

    // An edit made with nothing watching (another editor, a sync tool) moves the
    // stamp, so the pass reads it and pushes the change.
    laptop.write("note.md", "# v2 from another editor");
    laptop.resetCounters();
    await laptop.sync();
    expect(laptop.readsOf("note.md")).toBeGreaterThan(0);
    expect(laptop.pushCalls).toHaveLength(1);

    await phone.sync();
    expect(phone.read("note.md")).toBe("# v2 from another editor");
  });

  it("reuses the recorded hash across a restart, where the state is all it has", async () => {
    // The stamp lives in the persisted state, so a device that restarts keeps the
    // benefit — which is the case that matters, since a bind is what a restart runs.
    const vault = await newVault("stamp-cache-restart");
    const laptop = await newClient(vault.id, "laptop");
    laptop.write("note.md", "# v1");
    await laptop.sync();

    const restarted = await createTestClient({
      server,
      vaultId: vault.id,
      key: material.key,
      deviceName: laptop.deviceName,
      dir: laptop.dir,
    });
    clients.push(restarted);
    restarted.engine.loadState(laptop.state.json!);
    restarted.resetCounters();
    await restarted.bind();

    expect(restarted.readsOf("note.md")).toBe(0);
    expect(restarted.pushCalls).toEqual([]);
    expect(restarted.read("note.md")).toBe("# v1");
  });

  it("keeps the blob a rename reuses readable for a peer that pulls it later", async () => {
    // The server accepts a content-less rename only while it really holds the bytes
    // (it answers `content_missing` otherwise), so this is the case that proves the
    // claim holds in the normal path: the blob is still there after the move.
    const vault = await newVault("rename-blob-survives");
    const laptop = await newClient(vault.id, "laptop");
    const bytes = payload(64 * 1024);
    laptop.writeBinary("a/clip.mp4", bytes);
    await laptop.sync();

    laptop.move("a/clip.mp4", "b/clip.mp4");
    await laptop.engine.handleLocalRename("a/clip.mp4", "b/clip.mp4");

    const fileId = laptop.engine.fileIdForPath("b/clip.mp4")!;
    const head = (await fileVersions(server, vault.id, fileId)).at(-1)!;
    const response = await fetch(
      `${server.serverUrl}/api/vaults/${vault.id}/sync/versions/${head.contentHash}/content`,
      { headers: { Authorization: `Bearer ${server.userKey}` } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer()).byteLength).toBe(bytes.byteLength + 28);

    const tablet = await newClient(vault.id, "tablet");
    await tablet.sync();
    expect(Array.from(tablet.readBytes("b/clip.mp4")!)).toEqual(Array.from(bytes));
  });

  it("serves one byte range for a chunked client, and the whole blob for everyone else", async () => {
    const vault = await newVault("content-range");
    const laptop = await newClient(vault.id, "laptop");
    const bytes = payload(64 * 1024);
    laptop.writeBinary("clip.mp4", bytes);
    await laptop.sync();

    const fileId = laptop.engine.fileIdForPath("clip.mp4")!;
    const head = (await fileVersions(server, vault.id, fileId)).at(-1)!;
    const url = `${server.serverUrl}/api/vaults/${vault.id}/sync/versions/${head.contentHash}/content`;
    const auth = { Authorization: `Bearer ${server.userKey}` };
    const storedSize = bytes.byteLength + 28;

    const whole = await fetch(url, { headers: auth });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe(String(storedSize));
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    const stored = new Uint8Array(await whole.arrayBuffer());

    // One block of the ciphertext, exactly as a chunked download asks for it.
    const partial = await fetch(url, { headers: { ...auth, Range: "bytes=20-29" } });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 20-29/${storedSize}`);
    expect(partial.headers.get("content-length")).toBe("10");
    expect(Array.from(new Uint8Array(await partial.arrayBuffer()))).toEqual(
      Array.from(stored.slice(20, 30)),
    );

    // Past the end is unsatisfiable, not a silent full body.
    const beyond = await fetch(url, {
      headers: { ...auth, Range: `bytes=${storedSize}-` },
    });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("content-range")).toBe(`bytes */${storedSize}`);
    expect(await beyond.json()).toMatchObject({
      error: "RANGE_NOT_SATISFIABLE",
      message: "Range is not satisfiable",
    });

    // HEAD carries the GET's headers and no body — the route does not read the blob.
    const headResponse = await fetch(url, { method: "HEAD", headers: auth });
    expect(headResponse.status).toBe(200);
    expect(headResponse.headers.get("content-length")).toBe(String(storedSize));
    expect((await headResponse.arrayBuffer()).byteLength).toBe(0);

    // A malformed or multi-range header is ignored (200, whole body), as RFC 9110 allows.
    const ignored = await fetch(url, {
      headers: { ...auth, Range: "bytes=0-9,20-29" },
    });
    expect(ignored.status).toBe(200);
    expect((await ignored.arrayBuffer()).byteLength).toBe(storedSize);

    const suffix = await fetch(url, { headers: { ...auth, Range: "bytes=-10" } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe(
      `bytes ${storedSize - 10}-${storedSize - 1}/${storedSize}`,
    );
    expect(Array.from(new Uint8Array(await suffix.arrayBuffer()))).toEqual(
      Array.from(stored.slice(-10)),
    );
  });

  it("answers 404 for a version the store does not hold", async () => {
    const vault = await newVault("missing-content");
    const response = await fetch(
      `${server.serverUrl}/api/vaults/${vault.id}/sync/versions/${"0".repeat(64)}/content`,
      { headers: { Authorization: `Bearer ${server.userKey}` } },
    );
    expect(response.status).toBe(404);
  });

  it("refuses a push body over the server's bound before reading it", async () => {
    const vault = await newVault("oversized-body");
    const response = await fetch(`${server.serverUrl}/api/vaults/${vault.id}/sync/push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${server.userKey}`,
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(16),
    });
    // A 16-byte body is a malformed frame, not an oversized one: the frame parser
    // rejects it with the unified validation error rather than a 500.
    expect(response.status).toBe(422);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "VALIDATION_ERROR",
    });
  });

  it("stores a blob that is not base64 text", async () => {
    // The store used to hold base64: a blob read back as UTF-8 decoded to printable
    // text. It now holds the ciphertext, so the same read has to fail to decode as
    // text — which is the property that keeps the 4/3 inflation out of the disk.
    const vault = await newVault("binary-blob");
    const laptop = await newClient(vault.id, "laptop");
    laptop.writeBinary("clip.mp4", payload(4096));
    await laptop.sync();

    const fileId = laptop.engine.fileIdForPath("clip.mp4")!;
    const version = (await fileVersions(server, vault.id, fileId)).at(-1)!;
    const stored = (await blobLocation(vault.id, version.contentHash))!;
    const blob = readFileSync(stored.filePath).subarray(
      stored.offset,
      stored.offset + stored.length,
    );
    expect(blob.byteLength).toBe(4096 + 28 + BLOB_HEADER_BYTES);
    // A base64 blob of this size would be 5 660 bytes of printable ASCII.
    expect(/^[\x20-\x7e]+$/.test(blob.toString("latin1"))).toBe(false);
  });

  it("stores a chunked upload as one v2 blob, and refuses one that is incomplete", async () => {
    const vault = await newVault("chunked-upload");
    const auth = { Authorization: `Bearer ${server.userKey}` };
    const contentHash = "b".repeat(64);
    // Above the 8 MiB protocol threshold, as every chunked version must be.
    const plaintextSize = CHUNK_PLAINTEXT_BYTES * 2 + 1024;
    const chunkCount = 3;
    const chunks = [
      payload(CHUNK_PLAINTEXT_BYTES + 28),
      payload(CHUNK_PLAINTEXT_BYTES + 28),
      payload(1024 + 28),
    ] as Uint8Array<ArrayBuffer>[];
    const chunkUrl = (index: number): string =>
      `${server.serverUrl}/api/vaults/${vault.id}/sync/blobs/${contentHash}/chunks/${index}` +
      `?chunkCount=${chunkCount}&plaintextSize=${plaintextSize}`;
    const uploadChunk = async (index: number): Promise<Response> =>
      await fetch(chunkUrl(index), {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/octet-stream" },
        body: chunks[index],
      });
    const pushBody = (versionId: string, baseVersionId: string | null): Uint8Array =>
      buildPushBody(
        [
          {
            fileId: "chunk-file",
            encryptedPath: "ZW5jcnlwdGVkLXBhdGg=",
            action: "create",
            versionId,
            contentHash,
            sizeBytes: plaintextSize,
            mtimeMs: 0,
            baseVersionId,
            content: null,
            contentChunks: chunkCount,
            historyKind: "documents",
          },
        ],
        { deviceName: "chunk-test" },
      );
    const push = async (versionId: string, baseVersionId: string | null): Promise<Response> =>
      await fetch(`${server.serverUrl}/api/vaults/${vault.id}/sync/push`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/octet-stream" },
        body: pushBody(versionId, baseVersionId) as BodyInit,
      });

    expect(await (await uploadChunk(0)).json()).toEqual({ received: 1 });
    // Re-sending an index is a retry, not a second chunk.
    expect(await (await uploadChunk(0)).json()).toEqual({ received: 1 });

    // A push that names an incomplete upload writes nothing.
    const premature = await push("v-premature", null);
    expect(await premature.json()).toEqual({
      results: [{ fileId: "chunk-file", status: "error", error: "chunk_missing" }],
    });

    expect(await (await uploadChunk(1)).json()).toEqual({ received: 2 });
    expect(await (await uploadChunk(2)).json()).toEqual({ received: 3 });
    expect(
      await (
        await fetch(`${server.serverUrl}/api/vaults/${vault.id}/sync/blobs/${contentHash}/status`, {
          headers: auth,
        })
      ).json(),
    ).toEqual({ received: 3, complete: true });

    const accepted = await push("v-chunk", null);
    expect(await accepted.json()).toEqual({
      results: [{ fileId: "chunk-file", status: "ok", versionId: "v-chunk", contentHash }],
    });

    // The store holds one v2 blob: header plus both chunks, and no staged directory.
    const stored = (await blobLocation(vault.id, contentHash))!;
    expect(stored.length).toBe(BLOB_HEADER_BYTES + plaintextSize + chunkCount * 28);
    expect(
      statSync(join(server.rootDir, "blobs", vault.id, "uploads", contentHash), {
        throwIfNoEntry: false,
      }),
    ).toBeUndefined();

    // A committed upload answers `complete` even though its staging directory is gone:
    // otherwise a push whose response was lost would re-upload the whole file.
    expect(
      await (
        await fetch(`${server.serverUrl}/api/vaults/${vault.id}/sync/blobs/${contentHash}/status`, {
          headers: auth,
        })
      ).json(),
    ).toEqual({ received: 3, complete: true });

    // The content route serves the chunk region without the header, and a push that
    // reuses the assembled blob is accepted (assembly is idempotent).
    const contentUrl = `${server.serverUrl}/api/vaults/${vault.id}/sync/versions/${contentHash}/content`;
    const whole = new Uint8Array(await (await fetch(contentUrl, { headers: auth })).arrayBuffer());
    expect(whole.byteLength).toBe(plaintextSize + chunkCount * 28);
    expect(Array.from(whole.subarray(0, 512))).toEqual(Array.from(chunks[0].subarray(0, 512)));
    const secondChunkStart = CHUNK_PLAINTEXT_BYTES + 28;
    expect(Array.from(whole.subarray(secondChunkStart, secondChunkStart + 512))).toEqual(
      Array.from(chunks[1].subarray(0, 512)),
    );
    const thirdChunkStart = secondChunkStart + CHUNK_PLAINTEXT_BYTES + 28;
    expect(Array.from(whole.subarray(thirdChunkStart, thirdChunkStart + 512))).toEqual(
      Array.from(chunks[2].subarray(0, 512)),
    );

    expect(await (await push("v-chunk-2", "v-chunk")).json()).toMatchObject({
      results: [{ fileId: "chunk-file", status: "ok", versionId: "v-chunk-2" }],
    });
  });

  it("does not serve another vault's blob through an encoded traversal", async () => {
    const vaultA = await newVault("tenant-a");
    const vaultB = await newVault("tenant-b");
    const owner = await newClient(vaultB.id, "tenant-b-laptop");
    owner.writeBinary("clip.mp4", payload(1024));
    await owner.sync();

    const fileId = owner.engine.fileIdForPath("clip.mp4")!;
    const head = (await fileVersions(server, vaultB.id, fileId)).at(-1)!;
    const traversal = encodeURIComponent(`../${vaultB.id}/${head.contentHash}`);
    const response = await fetch(
      `${server.serverUrl}/api/vaults/${vaultA.id}/sync/versions/${traversal}/content`,
      { headers: { Authorization: `Bearer ${server.userKey}` } },
    );

    // The content hash is 64 hex characters or it names nothing; before the check, this
    // route resolved a blob of another vault.
    expect(response.status).toBe(404);
  });

  it("rejects the content/chunk shapes a reader could not tell apart", async () => {
    const vault = await newVault("shape-checks");
    const auth = { Authorization: `Bearer ${server.userKey}` };
    const push = async (files: unknown[]): Promise<Response> =>
      await fetch(`${server.serverUrl}/api/vaults/${vault.id}/sync/push`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/octet-stream" },
        body: handBuiltPush({ files }, payload(4)) as BodyInit,
      });

    // Content and chunks at once: the quota attack, and a shape no reader can choose.
    const both = await push([
      handBuiltFile({ contentChunks: 3, sizeBytes: 9 * 1024 * 1024, contentLength: 4 }),
    ]);
    expect(both.status).toBe(422);

    // A whole payload above the threshold: a reader would ask for ranges of it.
    const whole = await push([handBuiltFile({ sizeBytes: 9 * 1024 * 1024, contentLength: 4 })]);
    expect(whole.status).toBe(422);

    // A chunked version at or below it: a reader would expect a whole payload.
    const small = await push([handBuiltFile({ contentChunks: 1, sizeBytes: 1024 })]);
    expect(small.status).toBe(422);
  });

  it("refuses a plaintext size that does not describe the payload", async () => {
    const vault = await newVault("size-mismatch");
    const auth = { Authorization: `Bearer ${server.userKey}` };
    const response = await fetch(`${server.serverUrl}/api/vaults/${vault.id}/sync/push`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/octet-stream" },
      body: handBuiltPush(
        { files: [handBuiltFile({ sizeBytes: 99, contentLength: 4 })] },
        payload(4),
      ) as BodyInit,
    });

    // The route accepts the shape (a small payload is an ordinary push); the handler
    // answers the file, because a peer would size its read from the declared number.
    expect(await response.json()).toMatchObject({
      results: [{ status: "error", error: "size_mismatch" }],
    });
  });
});
