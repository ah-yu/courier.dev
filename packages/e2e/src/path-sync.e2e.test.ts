import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestClient, type TestClient } from "./harness/client";
import { startTestServer, type TestServer } from "./harness/server";
import {
  createTestVault,
  makeVaultMaterial,
  type TestVault,
  type VaultMaterial,
} from "./harness/vault";
import { deletedFiles, fileVersions, vaultHistory } from "./harness/api";

/**
 * End-to-end sync across **file path shapes**: root, one level deep, two levels
 * deep and a deep chain, for every basic operation (create, modify, delete,
 * rename) plus renames that change the folder.
 *
 * This is deliberately a separate file from `sync.e2e.test.ts`: that one tells
 * the story of the sync features (conflict policies, the recycle bin, device
 * attribution, websocket delivery) with one path shape; this one holds the path
 * shape constant per case so a failure names the operation *and* the shape.
 *
 * Nothing is mocked: real server (SQLite + Hono + ws), real `SyncEngine`, real
 * `FsAdapter` over a temp directory. Path semantics cannot be pinned in the
 * engine's own unit tests — its `FakeAdapter` is a flat `Map` with a no-op
 * `createFolder` — which is why nesting is verified here and in the adapters'
 * own unit tests.
 */

interface PathShape {
  /** Human readable shape, used in the test name. */
  label: string;
  /** A file path inside the shape. */
  path: string;
  /** A second file path in the same shape (cross-directory moves, rebuilds). */
  other: string;
  /** Where the file goes on a rename that moves to another folder. */
  crossDir: string;
  /** Same folder, new name. */
  renamed: string;
}

const SHAPES: PathShape[] = [
  {
    label: "at the vault root",
    path: "note.md",
    other: "other.md",
    crossDir: "folder/moved.md",
    renamed: "renamed.md",
  },
  {
    label: "one folder deep",
    path: "folder/note.md",
    other: "folder/other.md",
    crossDir: "two/moved.md",
    renamed: "folder/renamed.md",
  },
  {
    label: "two folders deep",
    path: "folder/sub/note.md",
    other: "folder/sub/other.md",
    crossDir: "elsewhere/moved.md",
    renamed: "folder/sub/renamed.md",
  },
  {
    label: "deeply nested",
    path: "folder/deep/sub/note.md",
    other: "folder/deep/sub/other.md",
    crossDir: "somewhere/other/deep/moved.md",
    renamed: "folder/deep/sub/renamed.md",
  },
];

describe("sync e2e — path shapes across two clients", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer("path-shape e2e user");
    // PBKDF2 (600k) is deliberately slow: derive once and reuse for every vault.
    material = await makeVaultMaterial();
  }, 120_000);

  afterEach(() => {
    for (const client of clients) client.cleanup();
    clients = [];
  });

  afterAll(async () => {
    await server.close();
  });

  /** A fresh vault per test, so scenarios cannot interfere. */
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

  describe.each(SHAPES)("a note $label", (shape) => {
    it("is created on one device and pulled, then modified on the other and pulled back", async () => {
      const vault = await newVault(`paths-create-modify-${shape.label}`);
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");
      const fileIdA = () => a.engine.fileIdForPath(shape.path);

      // ── create ──
      a.write(shape.path, "created in A");
      await a.sync();
      await a.change(shape.path);

      expect(a.read(shape.path)).toBe("created in A");
      expect(await a.list()).toContain(shape.path);
      expect(fileIdA()).toBeTruthy();
      expect(
        (await vaultHistory(server, vault.id)).map((f) => f.versions.map((v) => v.action)),
      ).toEqual([["create"]]);

      // ── the peer materialises it at the same path ──
      await b.sync();

      expect(b.read(shape.path)).toBe("created in A");
      expect(await b.list()).toContain(shape.path);
      expect(b.engine.fileIdForPath(shape.path)).toBe(fileIdA());

      // ── modify on the peer, then pull it back ──
      b.write(shape.path, "modified in B");
      await b.change(shape.path);
      await a.sync();

      expect(a.read(shape.path)).toBe("modified in B");
      const versions = await fileVersions(server, vault.id, fileIdA()!);
      expect(versions.map((v) => v.action)).toEqual(["create", "modify"]);
    });

    it("is renamed, moves across folders, then deleted, and the peer follows each step", async () => {
      const vault = await newVault(`paths-rename-delete-${shape.label}`);
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");

      a.write(shape.path, "content that survives every move");
      await a.sync();
      const fileId = a.engine.fileIdForPath(shape.path);
      expect(fileId).toBeTruthy();

      // The peer only ever learns the tracked file, so every later step must
      // follow a remote path change rather than materialise a new file.
      await b.sync();
      expect(b.read(shape.path)).toBe("content that survives every move");

      // ── rename inside the same folder ──
      a.move(shape.path, shape.renamed);
      await a.rename(shape.path, shape.renamed);
      expect(a.read(shape.renamed)).toBe("content that survives every move");
      expect(a.engine.fileIdForPath(shape.renamed)).toBe(fileId);

      await b.sync();

      expect(b.read(shape.renamed)).toBe("content that survives every move");
      expect(b.read(shape.path)).toBeNull();
      expect(await b.list()).not.toContain(shape.path);
      expect(b.engine.fileIdForPath(shape.renamed)).toBe(fileId);
      expect((await fileVersions(server, vault.id, fileId!)).at(-1)?.action).toBe("rename");

      // ── rename that changes the folder (and its depth) ──
      a.move(shape.renamed, shape.crossDir);
      await a.rename(shape.renamed, shape.crossDir);
      await b.sync();

      expect(b.read(shape.crossDir)).toBe("content that survives every move");
      expect(b.read(shape.renamed)).toBeNull();
      expect(await b.list()).not.toContain(shape.renamed);
      expect(b.engine.fileIdForPath(shape.crossDir)).toBe(fileId);
      expect(a.read(shape.crossDir)).toBe("content that survives every move");

      // ── delete from A ──
      a.remove(shape.crossDir);
      await a.removeAndSync(shape.crossDir);

      await b.sync();

      expect(b.read(shape.crossDir)).toBeNull();
      expect(await b.list()).not.toContain(shape.crossDir);
      expect((await fileVersions(server, vault.id, fileId!)).map((v) => v.action)).toEqual([
        "create",
        "rename",
        "rename",
        "delete",
      ]);

      const bin = await deletedFiles(server, vault.id);
      expect(bin).toHaveLength(1);
      expect(bin[0]!.fileId).toBe(fileId!);
      expect(bin[0].previousContentHash).toBeTruthy();
    });
  });

  describe("renaming into a folder the peer has never seen", () => {
    it("materialises the file at the new path instead of the old one", async () => {
      const vault = await newVault("paths-rename-before-first-pull");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");

      a.write("folder/sub/draft.md", "renamed before B ever saw it");
      await a.sync();
      a.move("folder/sub/draft.md", "elsewhere/final.md");
      await a.rename("folder/sub/draft.md", "elsewhere/final.md");

      // B never had the old path, so this exercises "materialise at the
      // version's own path" rather than the local move branch.
      await b.sync();

      expect(b.read("elsewhere/final.md")).toBe("renamed before B ever saw it");
      expect(b.read("folder/sub/draft.md")).toBeNull();
      expect(await b.list()).not.toContain("folder/sub/draft.md");
    });
  });

  describe("a file deleted on one side and recreated on the other", () => {
    /**
     * Deleting a file and writing new content at the same path leaves the server
     * chain ending in a tombstone while this device has real content — but the
     * tombstone is **this device's own sync point**, so the new file is a recreate,
     * not a conflict: it is pushed as a `restore` on the same chain.
     *
     * Regression guard for two defects that met here: the decision used to demand a
     * remote blob that a `delete` version can never have (so the recreate was
     * dropped), and an empty remote tombstone could be mistaken for "same content,
     * nothing to do".
     */
    it("pushes the recreated content as a restore under a nested path", async () => {
      const vault = await newVault("paths-recreate-unrecorded");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");
      const path = "folder/sub/phoenix.md";

      a.write(path, "first life");
      await a.sync();
      await a.change(path);
      const fileId = a.engine.fileIdForPath(path)!;
      await b.sync();

      a.remove(path);
      await a.removeAndSync(path);

      // New bytes while the server chain's head is the tombstone this device pushed.
      a.write(path, "second life");
      await a.sync();

      // Same identity, one more version — and no conflict file, because nothing
      // remote competed with these bytes.
      expect(a.read(path)).toBe("second life");
      expect(a.engine.fileIdForPath(path)).toBe(fileId);
      expect((await fileVersions(server, vault.id, fileId)).at(-1)?.action).toBe("restore");

      await b.sync();
      expect(b.read(path)).toBe("second life");
    });

    /**
     * The same shape seen from the **bind** side: connecting a vault whose remote
     * already deleted the file treats the local copy as the user's own, so it is
     * pushed as a new file with a new fileId. The engine-level cases for that live
     * in `engine.test.ts` ("revives a peer-deleted local file as a new file when
     * binding the vault"); this file keeps the multi-device recycle-bin
     * consequences below.
     */
    it("keeps the deleted chain in the recycle bin after a binding client revives the path", async () => {
      const vault = await newVault("paths-recreate-same-content");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");
      const path = "folder/sub/phoenix.md";

      a.write(path, "first life");
      await a.sync();
      await a.change(path);
      const deletedFileId = a.engine.fileIdForPath(path)!;
      await b.sync();

      a.remove(path);
      await a.removeAndSync(path);
      await b.sync();
      expect(b.read(path)).toBeNull();
      expect((await deletedFiles(server, vault.id)).map((f) => f.fileId)).toContain(deletedFileId);

      // The same path and the same content come back on another binding client.
      const c = await newClient(vault.id, "device-c");
      c.write(path, "first life");
      await c.bind();

      // A new chain, and the deleted one stays exactly as it was — the recycle bin
      // keeps offering the version it removed.
      const rebornFileId = c.engine.fileIdForPath(path)!;
      expect(rebornFileId).not.toBe(deletedFileId);
      expect((await fileVersions(server, vault.id, deletedFileId)).map((v) => v.action)).toEqual([
        "create",
        "delete",
      ]);
      expect((await fileVersions(server, vault.id, rebornFileId)).map((v) => v.action)).toEqual([
        "create",
      ]);
      expect((await deletedFiles(server, vault.id)).map((f) => f.fileId)).toContain(deletedFileId);

      // And the reviving client keeps its own copy.
      expect(c.read(path)).toBe("first life");
    });
  });

  describe("a file that goes through every operation", () => {
    it("keeps one fileId and a readable persisted state throughout", async () => {
      const vault = await newVault("paths-full-lifecycle");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");

      // create
      a.write("lifecycle/one.md", "v1");
      await a.sync();
      await a.change("lifecycle/one.md");
      const fileId = a.engine.fileIdForPath("lifecycle/one.md")!;
      await b.sync();
      expect(b.engine.fileIdForPath("lifecycle/one.md")).toBe(fileId);

      // modify
      a.write("lifecycle/one.md", "v2");
      await a.change("lifecycle/one.md");

      // rename across folders
      a.move("lifecycle/one.md", "lifecycle/deep/two.md");
      await a.rename("lifecycle/one.md", "lifecycle/deep/two.md");
      expect(a.engine.fileIdForPath("lifecycle/deep/two.md")).toBe(fileId);

      await b.sync();
      expect(b.read("lifecycle/deep/two.md")).toBe("v2");

      // The persisted state (what a host writes to disk) tracks the new path.
      expect(a.state.json).toContain("lifecycle/deep/two.md");
      expect(b.state.json).toContain("lifecycle/deep/two.md");

      // delete
      a.remove("lifecycle/deep/two.md");
      await a.removeAndSync("lifecycle/deep/two.md");
      await b.sync();

      expect(b.read("lifecycle/deep/two.md")).toBeNull();
      expect((await fileVersions(server, vault.id, fileId)).map((v) => v.action)).toEqual([
        "create",
        "modify",
        "rename",
        "delete",
      ]);
    });
  });

  /**
   * The merge matrix at the filesystem level: what a **binding** client does when
   * the remote already has content. Each case checks both sides plus the server
   * chains, because "who wins" is exactly what is being pinned.
   */
  describe("binding a vault that already has content on both sides", () => {
    async function seedRemote(vaultId: string, files: Record<string, string>): Promise<TestClient> {
      const seeder = await newClient(vaultId, "seeder");
      for (const [path, content] of Object.entries(files)) seeder.write(path, content);
      await seeder.sync();
      for (const path of Object.keys(files)) await seeder.change(path);
      return seeder;
    }

    it("1. local only — the local notes are created on the server", async () => {
      const vault = await newVault("matrix-local-only");
      await seedRemote(vault.id, { "remote-seed.md": "seed" });

      const joiner = await newClient(vault.id, "joiner");
      joiner.write("local-only.md", "only here");
      joiner.write("folder/nested-local.md", "nested only here");
      const before = (await vaultHistory(server, vault.id)).length;
      await joiner.bind();

      const history = await vaultHistory(server, vault.id);
      expect(history).toHaveLength(before + 2);
      expect(joiner.read("local-only.md")).toBe("only here");
      expect(joiner.read("folder/nested-local.md")).toBe("nested only here");
      const localOnlyId = joiner.engine.fileIdForPath("local-only.md")!;
      expect((await fileVersions(server, vault.id, localOnlyId)).map((v) => v.action)).toEqual([
        "create",
      ]);
    });

    it("2. remote only — the remote notes arrive locally", async () => {
      const vault = await newVault("matrix-remote-only");
      await seedRemote(vault.id, { "remote-only.md": "from the server" });

      const joiner = await newClient(vault.id, "joiner");
      await joiner.bind();

      expect(joiner.read("remote-only.md")).toBe("from the server");
      expect(await joiner.list()).toContain("remote-only.md");
      expect(await joiner.conflictFiles()).toEqual([]);
    });

    it("3. same name, different content — the remote version wins, the local one is parked", async () => {
      const vault = await newVault("matrix-same-name-different");
      await seedRemote(vault.id, { "shared.md": "remote version" });

      const joiner = await newClient(vault.id, "joiner");
      joiner.write("shared.md", "local version");
      await joiner.bind();

      // The remote head is the truth on this path, and the local note is beside it.
      // Binding pushes nothing — the losing side is this device's own content, which
      // never had a version on the server.
      expect(joiner.read("shared.md")).toBe("remote version");
      expect(await joiner.parkedContentOf("shared.md")).toBe("local version");
      const history = await vaultHistory(server, vault.id);
      expect(history).toHaveLength(1);
      expect(history[0].versions.map((v) => v.action)).toEqual(["create"]);
    });

    it("4. same name, same content — converges without a second chain", async () => {
      const vault = await newVault("matrix-same-name-same");
      await seedRemote(vault.id, { "shared.md": "identical" });

      const joiner = await newClient(vault.id, "joiner");
      joiner.write("shared.md", "identical");
      const before = (await vaultHistory(server, vault.id)).length;
      await joiner.bind();

      expect(await joiner.conflictFiles()).toEqual([]);
      expect(joiner.read("shared.md")).toBe("identical");
      expect((await vaultHistory(server, vault.id)).length).toBe(before);
      expect((await vaultHistory(server, vault.id))[0].versions).toHaveLength(1);
    });

    it("5a. remote tombstone + local file on a first bind — new file, old chain kept", async () => {
      const vault = await newVault("matrix-tombstone-bind");
      const a = await newClient(vault.id, "device-a");
      a.write("phoenix.md", "first life");
      await a.sync();
      await a.change("phoenix.md");
      const deletedFileId = a.engine.fileIdForPath("phoenix.md")!;
      a.remove("phoenix.md");
      await a.removeAndSync("phoenix.md");

      // A brand-new client over its own directory: it has never tracked the file,
      // so this is the "connect this vault" shape.
      const joiner = await newClient(vault.id, "joiner");
      joiner.write("phoenix.md", "second life");
      await joiner.bind();

      expect(await joiner.conflictFiles()).toEqual([]);
      const rebornFileId = joiner.engine.fileIdForPath("phoenix.md")!;
      expect(rebornFileId).not.toBe(deletedFileId);
      expect((await fileVersions(server, vault.id, rebornFileId)).map((v) => v.action)).toEqual([
        "create",
      ]);
      expect((await fileVersions(server, vault.id, deletedFileId)).map((v) => v.action)).toEqual([
        "create",
        "delete",
      ]);
      // Two chains now: the file is gone in one and alive in the other.
      expect(await vaultHistory(server, vault.id)).toHaveLength(2);
      expect((await deletedFiles(server, vault.id)).map((f) => f.fileId)).toContain(deletedFileId);

      // The deleting device picks up the new file rather than re-deleting it.
      await a.sync();
      expect(a.read("phoenix.md")).toBe("second life");
      expect(a.engine.fileIdForPath("phoenix.md")).toBe(rebornFileId);
    });

    it("5b. remote tombstone + local file on a later bind over tracked state — deletion applied", async () => {
      const vault = await newVault("matrix-tombstone-rebind");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");
      a.write("phoenix.md", "first life");
      await a.sync();
      await a.change("phoenix.md");
      await b.sync();
      const deletedFileId = a.engine.fileIdForPath("phoenix.md")!;
      expect(b.read("phoenix.md")).toBe("first life");

      a.remove("phoenix.md");
      await a.removeAndSync("phoenix.md");

      // B goes through a bind (Obsidian reopened, or a pause followed by resume) with
      // its copy still on disk. B already tracks that chain, so the tombstone is not
      // new to it: the local file is the version the deletion removed, and the bind
      // has to apply the deletion. Treating every bind as a first connect revived the
      // note as a new chain — a note deleted on A came back on every device when B
      // resumed.
      await b.bind();

      expect(await b.conflictFiles()).toEqual([]);
      expect(b.read("phoenix.md")).toBeNull();
      expect(b.engine.fileIdForPath("phoenix.md")).toBeNull();
      expect((await fileVersions(server, vault.id, deletedFileId)).map((v) => v.action)).toEqual([
        "create",
        "delete",
      ]);
      // One chain: the deletion stands on the server too.
      expect(await vaultHistory(server, vault.id)).toHaveLength(1);

      // A later scheduled pass leaves the deletion alone rather than pulling the old
      // bytes back or filing a second tombstone.
      await b.sync();
      expect(b.read("phoenix.md")).toBeNull();
      expect(await vaultHistory(server, vault.id)).toHaveLength(1);
    });

    it("5c. remote tombstone + local file on a non-binding pass — deletion applied", async () => {
      const vault = await newVault("matrix-tombstone-running");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");
      a.write("phoenix.md", "first life");
      await a.sync();
      await a.change("phoenix.md");
      await b.sync();

      a.remove("phoenix.md");
      await a.removeAndSync("phoenix.md");

      // A scheduled reconcile never revives: the peer's deletion is applied.
      await b.sync();

      expect(await b.conflictFiles()).toEqual([]);
      expect(b.read("phoenix.md")).toBeNull();
      expect(await b.list()).not.toContain("phoenix.md");
    });

    it("5d. remote tombstone + a peer's new chain — an event keeps the owner", async () => {
      const vault = await newVault("matrix-tombstone-event");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");
      a.write("phoenix.md", "first life");
      await a.sync();
      await b.sync();
      const deletedFileId = a.engine.fileIdForPath("phoenix.md")!;

      a.remove("phoenix.md");
      await a.removeAndSync("phoenix.md");

      // B applies the deletion, then creates a new chain at the path. A never receives the
      // notification (it does not sync here), so A's in-memory index does not know the new
      // chain.
      await b.sync();
      b.write("phoenix.md", "second life");
      await b.sync();
      const occupantId = b.engine.fileIdForPath("phoenix.md")!;
      expect(occupantId).not.toBe(deletedFileId);

      // A's user writes a note at the recreated path: the event decides from A's tracked
      // tombstone alone, and only the server index tells it the path is taken.
      a.write("phoenix.md", "mine again");
      await a.change("phoenix.md");

      // One live chain, B's. A's copy is parked and the old chain keeps its tombstone.
      expect(a.engine.fileIdForPath("phoenix.md")).toBe(occupantId);
      expect(a.read("phoenix.md")).toBe("second life");
      expect(await a.parkedContentOf("phoenix.md")).toBe("mine again");
      expect((await fileVersions(server, vault.id, deletedFileId)).map((v) => v.action)).toEqual([
        "create",
        "delete",
      ]);
      expect((await fileVersions(server, vault.id, occupantId)).map((v) => v.action)).toEqual([
        "create",
      ]);
      expect(await vaultHistory(server, vault.id)).toHaveLength(2);
    });
  });

  /**
   * The API bounds `encryptedPath` — base64 of `iv ‖ ciphertext ‖ tag`, 512 characters —
   * and refuses an over-long one for the **whole batch** it travelled in. A single deep
   * path therefore used to poison up to 100 files per pass with a 422 no client could
   * explain. The engine leaves that file out and reports it instead; everything else in
   * the vault still syncs.
   */
  it("skips a path too long for the API and still syncs the rest of the vault", async () => {
    const vault = await newVault("long-path");
    const skipped: string[] = [];
    const client = await createTestClient({
      server,
      vaultId: vault.id,
      key: material.key,
      deviceName: "deep-device",
      onFileSkipped: (event) => skipped.push(event.plainPath),
    });
    clients.push(client);

    // ~400 characters: its ciphertext is ~428 bytes, i.e. ~572 base64 characters.
    const deep = `${Array.from({ length: 8 }, () => "d".repeat(48)).join("/")}/deep.md`;
    client.write(deep, "too deep for the API");
    client.write("shallow.md", "fits");

    await client.sync();

    expect(skipped).toEqual([deep]);
    // One chain on the server: the shallow note. The deep one never travelled, and it
    // is not left looking tracked either.
    expect(await vaultHistory(server, vault.id)).toHaveLength(1);
    expect(client.engine.fileIdForPath(deep)).toBeNull();
    expect(client.engine.fileIdForPath("shallow.md")).toBeTruthy();

    // A later pass skips it again rather than pushing it late or failing the batch.
    await client.sync();
    expect(skipped).toEqual([deep, deep]);
    expect(await vaultHistory(server, vault.id)).toHaveLength(1);
  });
});
