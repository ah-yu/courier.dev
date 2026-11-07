import { realPlatform } from "@courier/testing";
import { readFileSync } from "fs";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_OP_QUEUE_LIMITS,
  SyncWebSocket,
  encryptString,
  sha256Hex,
  type WsConnectionState,
} from "../../engine/src/index";
import { buildPushBody } from "../../shared/src/index";
import { createTestClient, type TestClient } from "./harness/client";
import { startTestServer, type TestServer } from "./harness/server";
import {
  createTestVault,
  makeVaultMaterial,
  type VaultMaterial,
  type TestVault,
} from "./harness/vault";
import {
  deletedFiles,
  fileVersions,
  filesAtPath,
  pushFilesRaw,
  vaultHistory,
  versionDeviceNames,
} from "./harness/api";
import { waitFor } from "./harness/wait";

const payload = (fill: number) => new Uint8Array(6 * 1024 * 1024).fill(fill);

/**
 * End-to-end sync: real server (SQLite + Hono + ws), real `SyncEngine`, real
 * CLI filesystem adapter — no Obsidian, no mocks.
 *
 * This is the layer that replaces the manual "open vault_a and vault_b and
 * watch what happens" routine: every scenario below used to need two Obsidian
 * windows and a human comparing them.
 */
describe("sync e2e — two clients through a real server", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer("sync e2e user");
    // PBKDF2 with 600k iterations is deliberately slow: derive once, reuse the
    // material for every vault this file creates.
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

  async function newClient(vaultId: string, deviceName: string, dir?: string) {
    const client = await createTestClient({
      server,
      vaultId,
      key: material.key,
      deviceName,
      dir,
    });
    clients.push(client);
    return client;
  }

  it("uploads a note created on one device and pulls it onto another", async () => {
    const vault = await newVault("create-propagation");
    const laptop = await newClient(vault.id, "laptop");
    const phone = await newClient(vault.id, "phone");

    laptop.write("notes/hello.md", "# Hello\n\nwritten on the laptop");
    await laptop.sync();
    await laptop.change("notes/hello.md");

    await phone.sync();

    expect(phone.read("notes/hello.md")).toBe("# Hello\n\nwritten on the laptop");
    expect(await phone.list()).toContain("notes/hello.md");
    // The server holds exactly one chain for it.
    const history = await vaultHistory(server, vault.id);
    expect(history).toHaveLength(1);
    expect(history[0].versions.at(-1)?.action).toBe("create");
  });

  it("propagates edits in both directions", async () => {
    const vault = await newVault("edit-propagation");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("note.md", "version 1");
    await a.sync();
    await a.change("note.md");

    await b.sync();
    expect(b.read("note.md")).toBe("version 1");

    b.write("note.md", "version 2");
    await b.change("note.md");

    await a.sync();
    expect(a.read("note.md")).toBe("version 2");

    const history = await vaultHistory(server, vault.id);
    expect(history[0].versions.map((v) => v.action)).toEqual(["create", "modify"]);
  });

  it("pulls the note the host named first on a cold bind", async () => {
    const vault = await newVault("priority-cold-start");
    const laptop = await newClient(vault.id, "laptop");
    const phone = await newClient(vault.id, "phone");
    const names = Array.from({ length: 9 }, (_, index) => `n-${index}.md`);
    const opened = "n-4.md";

    for (const name of names) laptop.write(name, `${name} v1`);
    await laptop.sync();
    // The phone learns all of them (and records a sync point and a stamp for each).
    await phone.bind();

    for (const name of names) {
      laptop.write(name, `${name} v2`);
      await laptop.change(name);
    }
    phone.resetCounters();

    await phone.bind({ priorityPaths: [opened] });

    // The host's path is the file the user is looking at. The pass runs up to four
    // files at once, so the assertion is "in the first wave", not "the very first
    // request": whichever of the first four tasks reaches the network first, the note
    // on screen is fetched with them rather than behind the other eight.
    expect(phone.contentFetches).toHaveLength(names.length);
    const openedHash = await sha256Hex(new TextEncoder().encode(`${opened} v2`));
    expect(phone.contentFetches.indexOf(openedHash)).toBeGreaterThanOrEqual(0);
    expect(phone.contentFetches.indexOf(openedHash)).toBeLessThan(
      DEFAULT_OP_QUEUE_LIMITS.maxConcurrent,
    );
    for (const name of names) expect(phone.read(name)).toBe(`${name} v2`);
  });

  it("keeps the fileId when a file is renamed", async () => {
    const vault = await newVault("rename-fileid");
    const a = await newClient(vault.id, "device-a");

    a.write("old-name.md", "content that survives a rename");
    await a.sync();
    await a.change("old-name.md");
    const fileId = a.engine.fileIdForPath("old-name.md");
    expect(fileId).toBeTruthy();

    a.move("old-name.md", "new-name.md");
    await a.rename("old-name.md", "new-name.md");

    // Same fileId, new path — the invariant every host must keep.
    expect(a.engine.fileIdForPath("new-name.md")).toBe(fileId);
    const history = await vaultHistory(server, vault.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.fileId).toBe(fileId!);
    expect(history[0].versions.at(-1)?.action).toBe("rename");
  });

  it("moves a renamed file on the other device too", async () => {
    const vault = await newVault("rename-propagation");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("old-name.md", "shared content");
    await a.sync();
    await a.change("old-name.md");
    const fileId = a.engine.fileIdForPath("old-name.md")!;
    await b.sync();
    expect(b.read("old-name.md")).toBe("shared content");

    a.move("old-name.md", "new-name.md");
    await a.rename("old-name.md", "new-name.md");
    await b.sync();

    // Every version records the path it was written at, so the peer renames its
    // local file instead of writing the content to the stale path.
    expect(b.read("new-name.md")).toBe("shared content");
    expect(b.read("old-name.md")).toBeNull();
    expect(b.engine.fileIdForPath("new-name.md")).toBe(fileId);
  });

  it("delivers a file that was renamed before the peer ever saw it", async () => {
    const vault = await newVault("rename-before-first-pull");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("draft.md", "written, then renamed");
    await a.sync();
    await a.change("draft.md");
    a.move("draft.md", "final.md");
    await a.rename("draft.md", "final.md");

    // B never had the old path, so this exercises the "materialise at the
    // version's own path" branch rather than the local rename.
    await b.sync();
    expect(b.read("final.md")).toBe("written, then renamed");
    expect(b.read("draft.md")).toBeNull();
  });

  it("propagates a delete and exposes it in the recycle bin", async () => {
    const vault = await newVault("delete-propagation");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("doomed.md", "soon gone");
    await a.sync();
    await a.change("doomed.md");
    await b.sync();

    a.remove("doomed.md");
    await a.removeAndSync("doomed.md");

    await b.sync();
    expect(b.read("doomed.md")).toBeNull();
    expect(await b.list()).not.toContain("doomed.md");

    const bin = await deletedFiles(server, vault.id);
    expect(bin).toHaveLength(1);
    expect(bin[0].previousContentHash).toBeTruthy();
  });

  it("restores a deleted file from its previous version", async () => {
    const vault = await newVault("restore");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("phoenix.md", "rises again");
    await a.sync();
    await a.change("phoenix.md");
    const fileId = a.engine.fileIdForPath("phoenix.md")!;
    await b.sync();

    a.remove("phoenix.md");
    await a.removeAndSync("phoenix.md");
    await b.sync();

    const bin = await deletedFiles(server, vault.id);
    const entry = bin.find((file) => file.fileId === fileId)!;
    expect(entry.previousContentHash).toBeTruthy();

    await b.engine.restoreFile(fileId, "phoenix.md", entry.previousContentHash!);
    expect(b.read("phoenix.md")).toBe("rises again");

    await a.sync();
    expect(a.read("phoenix.md")).toBe("rises again");
    const versions = await fileVersions(server, vault.id, fileId);
    expect(versions.map((v) => v.action)).toEqual(["create", "delete", "restore"]);
  });

  it("restores an older version of a live note and both devices converge on it", async () => {
    const vault = await newVault("restore-version");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("note.md", "v1");
    await a.sync();
    await a.change("note.md");
    const fileId = a.engine.fileIdForPath("note.md")!;
    const firstVersion = (await fileVersions(server, vault.id, fileId))[0];

    await b.sync();
    a.write("note.md", "v2");
    await a.change("note.md");
    await b.sync();
    expect(b.read("note.md")).toBe("v2");

    // What the version-history dialog does: write the first version back over the
    // note that is there now. The path belongs to this chain, so it is an in-place
    // write, not a conflict.
    await b.engine.restoreFile(fileId, "note.md", firstVersion.contentHash);
    expect(b.read("note.md")).toBe("v1");

    await a.sync();
    expect(a.read("note.md")).toBe("v1");
    expect((await fileVersions(server, vault.id, fileId)).map((v) => v.action)).toEqual([
      "create",
      "modify",
      "restore",
    ]);
    // One path, one chain — the restore added a version, not a second identity.
    expect(await filesAtPath(server, vault.id, material.key, "note.md")).toEqual([fileId]);
  });

  it("takes the remote version on a two-sided edit and parks the local one", async () => {
    const vault = await newVault("conflict-explicit");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("shared.md", "base");
    await a.sync();
    await a.change("shared.md");
    const fileId = a.engine.fileIdForPath("shared.md")!;
    await b.sync();

    // Both sides move: A pushes first, so B is the one that sees a conflict — and
    // the first pusher is the one whose version stays.
    a.write("shared.md", "edited on A");
    await a.change("shared.md");

    b.write("shared.md", "edited on B");
    await b.change("shared.md");

    expect(b.read("shared.md")).toBe("edited on A");
    expect(await b.parkedContentOf("shared.md")).toBe("edited on B");

    // Nothing was pushed to settle it: the chain still ends at A's version.
    const versions = await fileVersions(server, vault.id, fileId);
    expect(versions.map((v) => v.action)).toEqual(["create", "modify"]);
    await a.sync();
    expect(a.read("shared.md")).toBe("edited on A");
  });

  /**
   * The window a pull's own write opens, end to end: the bytes are on disk before the
   * sync point is recorded, so a decision that lands in between used to read them as a
   * divergence from the head it was about to apply.
   *
   * The shape is a note Obsidian saves twice — dragging an attachment in inserts the
   * link, and the app saves the note again when the file finishes landing — and the
   * window is deterministic here because the adapter's write is held open across the
   * peer's notification, which is exactly the gap the real write leaves between "the
   * bytes are visible" and "the promise resolved".
   */
  it("does not park a copy of the note a pull is still recording", async () => {
    const vault = await newVault("pull-write-window");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    b.write("note.md", "v1");
    await b.sync();
    await a.sync();
    const fileId = b.engine.fileIdForPath("note.md")!;

    // A's first save is on the chain; B's pass will pull it.
    a.write("note.md", "v2");
    await a.change("note.md");
    b.resetCounters();

    // Hold B's write open: the pass has landed v2's bytes and has not recorded their
    // sync point yet. The peer's second save arrives as a notification right here.
    const writeFile = b.adapter.writeFile.bind(b.adapter);
    let injected = false;
    b.adapter.writeFile = async (path, bytes) => {
      await writeFile(path, bytes);
      if (path !== "note.md" || injected) return;
      injected = true;
      b.adapter.writeFile = writeFile;
      a.write("note.md", "v3");
      await a.change("note.md");
      const head = (await fileVersions(server, vault.id, fileId)).at(-1)!;
      await b.remotePushed(fileId, head.versionId);
    };

    await b.sync();
    await b.engine.whenIdle();

    // Nothing the user wrote was overwritten, so nothing is parked, and the note and
    // the sync point both end on the peer's newest version — the pull that was still
    // in flight must not move the point back under the notification.
    expect(await b.conflictFiles()).toEqual([]);
    expect(b.read("note.md")).toBe("v3");
    const head = (await fileVersions(server, vault.id, fileId)).at(-1)!;
    const state = JSON.parse(b.state.json!) as Record<string, { lastKnownVersionId: string }>;
    expect(state[fileId]?.lastKnownVersionId).toBe(head.versionId);
    // …and the passive device pushed nothing: a revert or a duplicate would keep both
    // assertions above green while corrupting the chain.
    expect(b.pushCalls).toEqual([]);
    expect((await fileVersions(server, vault.id, fileId)).map((v) => v.action)).toEqual([
      "create",
      "modify",
      "modify",
    ]);
  });

  /**
   * The other ordering of the same window: the notification's pull writes the peer's
   * next version first, and this pull's older bytes land after it. The engine has to put
   * the newer version back — declining to record the older one would leave the next pass
   * to push those bytes as a revert of the peer's version.
   */
  it("puts back the version a notification adopted before the pull's bytes landed", async () => {
    const vault = await newVault("pull-write-late");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    b.write("note.md", "v1");
    await b.sync();
    await a.sync();
    const fileId = b.engine.fileIdForPath("note.md")!;

    a.write("note.md", "v2");
    await a.change("note.md");
    b.resetCounters();

    const writeFile = b.adapter.writeFile.bind(b.adapter);
    let injected = false;
    b.adapter.writeFile = async (path, bytes) => {
      if (path === "note.md" && !injected) {
        injected = true;
        b.adapter.writeFile = writeFile;
        // The notification's apply queues behind the pull's job: the pull writes v2 and
        // records it, then the notification applies v3.
        a.write("note.md", "v3");
        await a.change("note.md");
        const head = (await fileVersions(server, vault.id, fileId)).at(-1)!;
        await b.remotePushed(fileId, head.versionId);
      }
      await writeFile(path, bytes);
    };

    await b.sync();
    b.adapter.writeFile = writeFile;
    await b.engine.whenIdle();

    expect(await b.conflictFiles()).toEqual([]);
    expect(b.read("note.md")).toBe("v3");
    const head = (await fileVersions(server, vault.id, fileId)).at(-1)!;
    const state = JSON.parse(b.state.json!) as Record<string, { lastKnownVersionId: string }>;
    expect(state[fileId]?.lastKnownVersionId).toBe(head.versionId);
    expect(b.pushCalls).toEqual([]);
    expect((await fileVersions(server, vault.id, fileId)).map((v) => v.action)).toEqual([
      "create",
      "modify",
      "modify",
    ]);
  });

  it("resolves a conflict even when the client has no persisted state", async () => {
    const vault = await newVault("conflict-without-state");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("shared.md", "base");
    await a.sync();
    await a.change("shared.md");
    await b.sync();
    const fileId = a.engine.fileIdForPath("shared.md")!;

    // A moves ahead on the server; B diverges on disk but never pushes it.
    a.write("shared.md", "remote moved ahead");
    await a.change("shared.md");
    b.write("shared.md", "local diverged");

    // A fresh client over B's directory: same files, no persisted sync state —
    // what an unbind/rebind or a wiped data.json looks like.
    const reborn = await createTestClient({
      server,
      vaultId: vault.id,
      key: material.key,
      deviceName: "reborn",
      dir: b.dir,
    });
    clients.push(reborn);
    await reborn.sync();

    // Regression: a client with no state used to be able to reach the conflict
    // without a path, which made it impossible to resolve. Resolution no longer
    // depends on any of that — the remote side wins and the local bytes are parked
    // next to the note.
    expect(reborn.read("shared.md")).toBe("remote moved ahead");
    expect(await reborn.parkedContentOf("shared.md")).toBe("local diverged");
    expect(reborn.engine.fileIdForPath("shared.md")).toBe(fileId);
  });

  it("parks the losing side of a conflict on every host, mobile included", async () => {
    const vault = await newVault("conflict-auto-resolve");
    const a = await newClient(vault.id, "device-a");
    const mobile = await newClient(vault.id, "phone");
    clients.push(mobile);

    a.write("shared.md", "base");
    await a.sync();
    await a.change("shared.md");
    await mobile.sync();

    a.write("shared.md", "edited on A");
    await a.change("shared.md");

    mobile.write("shared.md", "edited on the phone");
    await mobile.change("shared.md");

    // The remote version is the note, the phone's own edit is beside it — the same
    // outcome the plugin and the CLI produce.
    expect(mobile.read("shared.md")).toBe("edited on A");
    expect(await mobile.parkedContentOf("shared.md")).toBe("edited on the phone");

    // The phone pushed nothing, so nothing travels back to A.
    await a.sync();
    expect(a.read("shared.md")).toBe("edited on A");
  });

  it("attributes every version to the label the pushing client stated", async () => {
    const vault = await newVault("device-attribution");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("note.md", "from A");
    await a.sync();
    await a.change("note.md");
    const fileId = a.engine.fileIdForPath("note.md")!;

    await b.sync();
    b.write("note.md", "from B");
    await b.change("note.md");

    // No registry is involved: the name each client stated is what its version row
    // carries, and the history reads it back verbatim.
    expect(await versionDeviceNames(server, vault.id, fileId)).toEqual(["device-a", "device-b"]);
  });

  it("keeps the name a version was written with when the client is renamed", async () => {
    const vault = await newVault("device-rename-stamp");
    const a = await newClient(vault.id, "before-rename");

    a.write("note.md", "first");
    await a.sync();
    await a.change("note.md");
    const fileId = a.engine.fileIdForPath("note.md")!;

    // The same machine, now calling itself something else: same directory, same
    // vault, same chain — only the stated label changed.
    const renamed = await newClient(vault.id, "after-rename", a.dir);
    await renamed.sync();
    renamed.write("note.md", "second");
    await renamed.change("note.md");

    const names = await versionDeviceNames(server, vault.id, fileId);
    // The version written before the rename keeps the old label; the one after it
    // carries the new one, so the history shows the rename as it happened.
    expect(names[0]).toBe("before-rename");
    expect(names.at(-1)).toBe("after-rename");
  });

  it("notifies the other device over the websocket and pulls the change without a reconcile", async () => {
    const vault = await newVault("websocket-push");
    const a = await newClient(vault.id, "device-a");
    const b = await newClient(vault.id, "device-b");

    a.write("live.md", "pushed while B is just sitting there");
    await a.sync();
    await a.change("live.md");
    await b.sync();

    // B keeps a live subscription, exactly like EngineHost does.
    const states: WsConnectionState[] = [];
    const pushed: Array<{ fileId: string; versionId: string }> = [];
    const socket = new SyncWebSocket({
      platform: realPlatform,
      wsUrl: server.wsUrl,
      vaultId: vault.id,
      userKey: server.userKey,
      deviceName: b.deviceName,
      onEvent: (event) => {
        if (event.type === "state_change") states.push(event.state);
        if (event.type === "file_pushed") {
          pushed.push({ fileId: event.fileId, versionId: event.versionId });
        }
      },
    });
    socket.connect();

    try {
      await waitFor(() => states.includes("connected"), "websocket never connected");

      a.write("live.md", "second revision, pushed live");
      await a.change("live.md");

      await waitFor(() => pushed.length > 0, "no file_pushed notification arrived");
      for (const event of pushed) {
        await b.remotePushed(event.fileId, event.versionId);
      }

      // No full reconcile — the notification alone updated B's file.
      expect(b.read("live.md")).toBe("second revision, pushed live");
    } finally {
      socket.disconnect();
    }
  });

  it("carries a burst of files that share one content hash to a peer that is already listening", async () => {
    const vault = await newVault("same-content-burst");
    const empty = await newClient(vault.id, "empty-device");
    const full = await newClient(vault.id, "full-device");

    // The vault with nothing in it connects first — the shape a user binds
    // before connecting the device that holds the notes.
    await empty.bind();

    const states: WsConnectionState[] = [];
    const pulls: Array<Promise<void>> = [];
    const socket = new SyncWebSocket({
      platform: realPlatform,
      wsUrl: server.wsUrl,
      vaultId: vault.id,
      userKey: server.userKey,
      deviceName: empty.deviceName,
      onEvent: (event) => {
        if (event.type === "state_change") states.push(event.state);
        if (event.type === "file_pushed") {
          // A host does not await the notification (see `EngineHost.handleWsEvent`):
          // every push is handled concurrently, which is what the server's blob
          // store has to survive.
          pulls.push(empty.remotePushed(event.fileId, event.versionId));
        }
      },
    });
    socket.connect();

    try {
      await waitFor(() => states.includes("connected"), "websocket never connected");

      // Identical bytes in every note, so the server stores them as ONE
      // content-addressed blob: the shape that dropped notes on the receiving
      // device, because the blob was rewritten while the peer was reading it.
      const content = "same content, stored once\n".repeat(40_000);
      const paths = Array.from({ length: 12 }, (_, index) => `notes/same-${index}.md`);
      for (const path of paths) full.write(path, content);
      await full.bind();

      await waitFor(() => pulls.length >= paths.length, "not every push was announced");
      await Promise.all(pulls);

      for (const path of paths) {
        expect(empty.read(path), `${path} never arrived`).toBe(content);
      }
      expect(await vaultHistory(server, vault.id)).toHaveLength(paths.length);
    } finally {
      socket.disconnect();
    }
  });

  /**
   * A host that loses its connection keeps running: the user goes on editing,
   * every push fails, and the server sends no backlog when the socket comes back.
   * The next full reconcile — what `EngineHost` runs on a reconnect and on its
   * periodic pass — is the only thing that carries those changes, so these are
   * the shapes it has to get right against a real server.
   */
  describe("the connection is down while the user keeps working", () => {
    it("pushes an edit made offline on the next reconcile", async () => {
      const vault = await newVault("offline-edit");
      const laptop = await newClient(vault.id, "laptop");
      const phone = await newClient(vault.id, "phone");

      laptop.write("note.md", "v1");
      await laptop.sync();
      await laptop.change("note.md");
      await phone.sync();
      expect(phone.read("note.md")).toBe("v1");

      laptop.goOffline();
      laptop.write("note.md", "v2, written while offline");
      await expect(laptop.change("note.md")).rejects.toThrow();

      // Nothing reached the server: the peer still reads the old revision.
      await phone.sync();
      expect(phone.read("note.md")).toBe("v1");

      laptop.goOnline();
      await laptop.sync();

      await phone.sync();
      expect(phone.read("note.md")).toBe("v2, written while offline");
      const history = await vaultHistory(server, vault.id);
      expect(history).toHaveLength(1);
      expect(history[0].versions.map((v) => v.action)).toEqual(["create", "modify"]);
    });

    it("propagates a delete made offline instead of pulling the note back", async () => {
      const vault = await newVault("offline-delete");
      const laptop = await newClient(vault.id, "laptop");
      const phone = await newClient(vault.id, "phone");

      laptop.write("doomed.md", "delete me");
      await laptop.sync();
      await laptop.change("doomed.md");
      await phone.sync();
      expect(phone.read("doomed.md")).toBe("delete me");

      laptop.goOffline();
      laptop.remove("doomed.md");
      await expect(laptop.removeAndSync("doomed.md")).rejects.toThrow();

      laptop.goOnline();
      await laptop.sync();

      // The deletion survives its own reconcile — it used to be read as "a remote
      // file this device is missing" and pulled straight back — and it is what
      // reaches the peer.
      expect(laptop.read("doomed.md")).toBeNull();
      await phone.sync();
      expect(phone.read("doomed.md")).toBeNull();
      expect(await deletedFiles(server, vault.id)).toHaveLength(1);
    });

    it("keeps one chain for a rename made offline and moves the peer's file", async () => {
      const vault = await newVault("offline-rename");
      const laptop = await newClient(vault.id, "laptop");
      const phone = await newClient(vault.id, "phone");

      laptop.write("old-name.md", "content that survives the move");
      await laptop.sync();
      await laptop.change("old-name.md");
      await phone.sync();
      const fileId = laptop.engine.fileIdForPath("old-name.md")!;

      laptop.goOffline();
      laptop.move("old-name.md", "new-name.md");
      await expect(laptop.rename("old-name.md", "new-name.md")).rejects.toThrow();

      laptop.goOnline();
      await laptop.sync();

      // One chain, new path — not a tombstone plus a brand-new file.
      const history = await vaultHistory(server, vault.id);
      expect(history).toHaveLength(1);
      expect(history[0]!.fileId).toBe(fileId!);
      expect(history[0].versions.map((v) => v.action)).toEqual(["create", "rename"]);

      await phone.sync();
      expect(phone.read("new-name.md")).toBe("content that survives the move");
      expect(phone.read("old-name.md")).toBeNull();
    });

    it("takes the phone's version when both sides edited while one was offline", async () => {
      const vault = await newVault("offline-conflict");
      const laptop = await newClient(vault.id, "laptop");
      const phone = await newClient(vault.id, "phone");

      laptop.write("shared.md", "base");
      await laptop.sync();
      await laptop.change("shared.md");
      await phone.sync();

      laptop.goOffline();
      laptop.write("shared.md", "edited on the laptop while offline");
      await expect(laptop.change("shared.md")).rejects.toThrow();

      phone.write("shared.md", "edited on the phone");
      await phone.change("shared.md");

      laptop.goOnline();
      await laptop.sync();

      // The phone's edit reached the chain first, so it is what every device shows;
      // the laptop's offline work survives beside the note instead of being lost.
      expect(laptop.read("shared.md")).toBe("edited on the phone");
      expect(await laptop.parkedContentOf("shared.md")).toBe("edited on the laptop while offline");

      await phone.sync();
      expect(phone.read("shared.md")).toBe("edited on the phone");
    });
  });

  it("applies the remote tombstone when an event arrives before the first pass", async () => {
    const vault = await newVault("bind-merge-event");
    const a = await newClient(vault.id, "device-a");
    a.write("gone.md", "mine");
    await a.sync();
    const fileId = a.engine.fileIdForPath("gone.md")!;

    // The peer deletes the note, so the server's head for that path is a tombstone.
    const peer = await newClient(vault.id, "device-b");
    await peer.sync();
    peer.write("gone.md", "theirs");
    await peer.change("gone.md");
    peer.remove("gone.md");
    await peer.removeAndSync("gone.md");

    // A restarted client keeps the state that names the note; the server's head is a
    // tombstone and the file is on disk. The state already holds the chain and the sync
    // point, so the tombstone is not new to this device: the local copy is the version
    // the deletion removed, and the event that arrives before the first pass has to
    // apply the deletion rather than revive the note.
    const restarted = await newClient(vault.id, "device-a", a.dir);
    const state = a.state.json;
    expect(state, "the first client never persisted a state").toBeTruthy();
    restarted.engine.loadState(state!);
    expect(restarted.engine.fileIdForPath("gone.md")).toBe(fileId);
    restarted.write("gone.md", "mine");
    await restarted.engine.handleLocalChange("gone.md");
    await restarted.engine.whenIdle();

    expect(restarted.read("gone.md")).toBeNull();
    expect(restarted.engine.fileIdForPath("gone.md")).toBeNull();
    // The local copy diverged from the version the peer's deletion removed ("theirs"),
    // so the remote deletion wins and the local bytes are parked, as for any conflict.
    expect(await restarted.parkedContentOf("gone.md")).toBe("mine");
    expect((await fileVersions(server, vault.id, fileId)).map((v) => v.action)).toEqual([
      "create",
      "modify",
      "delete",
    ]);
  });
  it("applies the remote tombstone on a plain pass (the contrast to a bind)", async () => {
    const vault = await newVault("plain-pass-tombstone");
    const a = await newClient(vault.id, "device-a");
    a.write("gone.md", "mine");
    await a.sync();
    const fileId = a.engine.fileIdForPath("gone.md")!;

    const peer = await newClient(vault.id, "device-b");
    await peer.sync();
    peer.write("gone.md", "theirs");
    await peer.change("gone.md");
    peer.remove("gone.md");
    await peer.removeAndSync("gone.md");

    const restarted = await newClient(vault.id, "device-a", a.dir);
    restarted.engine.loadState(a.state.json!);
    await restarted.engine.initialSync();
    await restarted.engine.whenIdle();

    expect(restarted.read("gone.md")).toBeNull();
    expect(restarted.engine.fileIdForPath("gone.md")).toBeNull();
    expect((await fileVersions(server, vault.id, fileId)).map((v) => v.action)).toEqual([
      "create",
      "modify",
      "delete",
    ]);
  });
  /**
   * The race no client can see by looking harder: a device decides from a chain and
   * a peer pushes that same file before the decision's push arrives. Against the real
   * server, the push is conditional — it carries the head it was decided from, and a
   * push whose base is no longer the head is refused instead of appended.
   */
  describe("a push the chain has moved past", () => {
    it("does not overwrite the peer's version when it lands mid-push", async () => {
      const vault = await newVault("stale-base");
      const a = await newClient(vault.id, "device-a");
      const peer = await newClient(vault.id, "device-b");

      a.write("n.md", "base");
      await a.sync();
      await a.change("n.md");
      await peer.sync();
      expect(peer.read("n.md")).toBe("base");

      a.write("n.md", "edited on A");
      peer.write("n.md", "edited on B");
      // The peer's push lands exactly between A's decision and A's push: A decided
      // to modify from the create version, which is no longer the chain's head.
      a.beforeNextPush(async () => {
        await peer.change("n.md");
      });
      await a.change("n.md");

      // A's version was refused, so the peer's is the only modification on the chain
      // — and A, having re-decided from it, takes that version and parks its own
      // bytes rather than replacing anything.
      const history = await vaultHistory(server, vault.id);
      expect(history).toHaveLength(1);
      expect(history[0].versions.map((v) => v.action)).toEqual(["create", "modify"]);
      expect(a.read("n.md")).toBe("edited on B");
      expect(await a.parkedContentOf("n.md")).toBe("edited on A");
      // The peer's side is untouched, and knows nothing about A's refused push.
      expect(peer.read("n.md")).toBe("edited on B");
    });

    it("does not need a second push once the client has the head it was missing", async () => {
      const vault = await newVault("stale-base-recovered");
      const a = await newClient(vault.id, "device-a");
      const peer = await newClient(vault.id, "device-b");

      a.write("n.md", "base");
      await a.sync();
      await a.change("n.md");
      await peer.sync();

      a.write("n.md", "edited on A");
      peer.write("n.md", "edited on B");
      a.beforeNextPush(async () => {
        await peer.change("n.md");
      });
      await a.change("n.md");

      // The conflict is settled by adopting the head the refusal showed A — the
      // chain does not grow a third version, and the peer never has to reconcile
      // someone else's text onto its own edit.
      expect(a.read("n.md")).toBe("edited on B");
      await peer.sync();
      expect(peer.read("n.md")).toBe("edited on B");
      const history = await vaultHistory(server, vault.id);
      expect(history[0].versions.map((v) => v.action)).toEqual(["create", "modify"]);
    });

    it("brings the note back when a delete races the peer's edit", async () => {
      const vault = await newVault("stale-base-delete");
      const a = await newClient(vault.id, "device-a");
      const peer = await newClient(vault.id, "device-b");

      a.write("n.md", "base");
      await a.sync();
      await a.change("n.md");
      await peer.sync();
      expect(peer.read("n.md")).toBe("base");

      // A deletes the note, and the peer's edit of it lands while that tombstone is
      // on its way: the deletion would remove a version A never saw, so the server
      // refuses it — and the remote side wins, which means the note comes back.
      a.remove("n.md");
      a.beforeNextPush(async () => {
        peer.write("n.md", "edited on B");
        await peer.change("n.md");
      });
      await a.removeAndSync("n.md");

      expect(a.read("n.md")).toBe("edited on B");
      // The deletion had no content, so there is nothing parked beside the note.
      expect(await a.parkedContentOf("n.md")).toBeNull();
      const history = await vaultHistory(server, vault.id);
      expect(history[0].versions.map((v) => v.action)).toEqual(["create", "modify"]);
    });

    it("keeps the peer's edit on the chain when this device's own edit lost that race", async () => {
      const vault = await newVault("stale-base-delete-kept");
      const a = await newClient(vault.id, "device-a");
      const peer = await newClient(vault.id, "device-b");

      a.write("n.md", "base");
      await a.sync();
      await a.change("n.md");
      await peer.sync();

      // A edits the note locally, the peer pushes its own edit first: A's push is
      // refused, and taking the remote version is the whole resolution.
      a.write("n.md", "edited on A");
      a.beforeNextPush(async () => {
        peer.write("n.md", "edited on B");
        await peer.change("n.md");
      });
      await a.change("n.md");

      expect(a.read("n.md")).toBe("edited on B");
      expect(await a.parkedContentOf("n.md")).toBe("edited on A");
      const history = await vaultHistory(server, vault.id);
      expect(history[0].versions.map((v) => v.action)).toEqual(["create", "modify"]);
    });
  });

  /**
   * The conditional push has to hold when both pushes are in flight **at once**, not
   * only when one is injected into the other's decision-to-request window. The blob
   * write sits between the head check and the row, so a push carrying a large file is
   * still unfinished when a later, faster push is appended — and unless the check and
   * the insert are one atomic step, both are appended and the *earlier* push can end
   * up as the head, because it is whichever request finishes last that wins.
   */
  describe("two pushes decided from the same head, in flight at once", () => {
    it("appends exactly one of them, whichever finishes its blob write last", async () => {
      const vault = await newVault("concurrent-push");
      const a = await newClient(vault.id, "device-a");
      a.write("n.md", "base");
      await a.sync();
      await a.change("n.md");
      const fileId = a.engine.fileIdForPath("n.md")!;
      const base = (await fileVersions(server, vault.id, fileId)).at(-1)!;
      const encryptedPath = await encryptString(material.key, "n.md");

      // Two versions of the same file, both decided from `base`. Both payloads are
      // large, so both requests are inside their blob write together: this is the
      // ordering a queue on either side would not have changed, and the one the
      // server has to get right on its own.
      const [first, second] = await Promise.all([
        pushFilesRaw(server, vault.id, [
          {
            fileId,
            encryptedPath,
            content: payload(0x61),
            action: "modify",
            versionId: "concurrent-version-a",
            contentHash: "a".repeat(64),
            // The payload is 6 MiB of ciphertext: its plaintext is 28 bytes shorter.
            sizeBytes: 6 * 1024 * 1024 - 28,
            baseVersionId: base.versionId,
          },
        ]),
        pushFilesRaw(server, vault.id, [
          {
            fileId,
            encryptedPath,
            content: payload(0x62),
            action: "modify",
            versionId: "concurrent-version-b",
            contentHash: "b".repeat(64),
            sizeBytes: 6 * 1024 * 1024 - 28,
            baseVersionId: base.versionId,
          },
        ]),
      ]);

      // Exactly one of the two is the chain's head; the other is refused against it
      // and told what the head now is, so its client can pull and decide again.
      const accepted = [first[0]!, second[0]!].filter((r) => r.status === "ok");
      const refused = [first[0]!, second[0]!].filter((r) => r.status === "stale_base");
      expect(accepted).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.currentVersionId).toBe(accepted[0]!.versionId);

      // And the chain grew by exactly that one version: no second "ok" row, and no
      // history that shows the file going backwards.
      const versions = await fileVersions(server, vault.id, fileId);
      expect(versions.map((v) => v.versionId!)).toEqual([base.versionId!, accepted[0]!.versionId!]);
      const history = await vaultHistory(server, vault.id);
      expect(history[0]!.currentVersionId!).toBe(accepted[0]!.versionId!);
    });

    it("does not let an earlier edit become the head by finishing its push last", async () => {
      const vault = await newVault("slow-then-fast-edit");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");
      a.write("n.md", "base");
      await a.sync();
      await a.change("n.md");
      await b.sync();

      // The earlier edit is a large one, so its push — the blob write and the flush
      // included — would take far longer than the later, small edit's. Neither is
      // *decided* from a fresh head: both name the same base, so the server has to refuse
      // whichever arrives second.
      a.write("n.md", "a".repeat(4 * 1024 * 1024));
      let laterEdit: Promise<void> | undefined;
      a.beforeNextPush(async () => {
        // Runs inside the first push, before its request goes out. The later edit's
        // handler queues behind this push's job (one job per path), so it is started,
        // not awaited: waiting here would wait for the push that is waiting for this
        // hook.
        a.write("n.md", "edited second");
        laterEdit = a.change("n.md");
      });
      await a.change("n.md");
      await laterEdit;

      // The head is the later edit. The earlier push either lost the head race or was
      // refused against the version that won — and a refused push re-decides from the
      // chain it was refused by, so what is on disk is what the vault ends up holding.
      // Without that, the earlier push becomes the head simply by finishing last and
      // the peer below syncs the note *backwards*.
      await b.sync();
      expect(b.read("n.md")).toBe("edited second");
      expect(a.read("n.md")).toBe("edited second");
      // One device, one editing session, one chain — and nothing parked as a conflict.
      expect(await a.parkedContentOf("n.md")).toBeNull();
      expect(await vaultHistory(server, vault.id)).toHaveLength(1);
    });

    it("re-decides a refused push from the chain that refused it", async () => {
      const vault = await newVault("refused-push");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");
      a.write("n.md", "base");
      await a.sync();
      await b.sync();

      // b decides from the head it holds, and a lands a version **inside b's push**, so
      // the server has to refuse b's base. That refusal is the only way into the
      // re-decision, and this shape reaches it every run instead of one time in four.
      b.write("n.md", "edited second");
      b.beforeNextPush(async () => {
        a.write("n.md", "a".repeat(256 * 1024));
        await a.change("n.md");
        await waitFor(() => a.pushResults.length >= 2, "a's second push never came back");
      });
      await b.change("n.md");

      // The refusal happened, and b answered it from the fresh chain: the note ends up
      // holding the head (a's bytes), the edit b had made is parked beside it, and b's
      // **sync point** is that head — not the version b started from, which is the failure
      // this pins. Wait for the re-decision before reading: `change()` returns when the
      // push has been handed over, not when the refused one has been decided again.
      const head = b.pushResults.flat()[0]!.currentVersionId;
      await waitFor(
        () => (b.read("n.md") ?? "").length === 256 * 1024,
        "b never applied the head it was refused against",
      );
      expect(b.pushResults.flat().map((entry) => entry.status)).toEqual(["stale_base"]);
      expect(await b.parkedContentOf("n.md")).toBe("edited second");
      const state = JSON.parse(b.state.json ?? "{}") as Record<
        string,
        { lastKnownVersionId?: string } | undefined
      >;
      const entry = Object.values(state).find((value) => value?.lastKnownVersionId !== undefined);
      expect(entry?.lastKnownVersionId).toBe(head);
    });

    it("parks the losing side when two devices edit the same instant", async () => {
      const vault = await newVault("concurrent-edit");
      const a = await newClient(vault.id, "device-a");
      const b = await newClient(vault.id, "device-b");
      a.write("n.md", "base");
      await a.sync();
      await a.change("n.md");
      await b.sync();

      // Both devices edit and push at once — no injection: the two requests race on
      // their own, which is the shape a user typing on two open laptops produces.
      a.write("n.md", "edited on A");
      b.write("n.md", "edited on B");
      await Promise.all([a.change("n.md"), b.change("n.md")]);

      await a.sync();
      await b.sync();
      expect(a.read("n.md")).toBe(b.read("n.md"));
      expect(["edited on A", "edited on B"]).toContain(a.read("n.md")!);
      // Neither text is dropped: the version that lost is parked beside the note on
      // the device that lost it. Silently pulling over it — what a push the chain
      // never refused did — leaves only one of these two strings on either device.
      const kept = new Set([
        a.read("n.md"),
        b.read("n.md"),
        await a.parkedContentOf("n.md"),
        await b.parkedContentOf("n.md"),
      ]);
      kept.delete(null);
      expect(kept).toEqual(new Set(["edited on A", "edited on B"]));
    });
  });

  /**
   * `contentHash` is a client-chosen **path component** in the blob store, so the push
   * contract has to pin its shape. Without that, `../../courier.db` resolves out of
   * `BLOB_STORE_DIR` — and for a server laid out like this one, two levels up is the
   * database file, which holds every `ck_` and `ak_` key in plaintext.
   */
  describe("a content hash that would escape the blob store", () => {
    it("refuses the push and leaves the file it named untouched", async () => {
      const vault = await newVault("traversal-push");
      const databasePath = join(server.rootDir, "courier.db");
      const before = readFileSync(databasePath);

      const body = buildPushBody([
        {
          fileId: "traversal-file",
          encryptedPath: await encryptString(material.key, "n.md"),
          content: new TextEncoder().encode("attacker bytes"),
          action: "create",
          versionId: "traversal-version",
          contentHash: "../../courier.db",
          sizeBytes: 14,
          mtimeMs: 0,
          baseVersionId: null,
          historyKind: "documents",
        },
      ]);
      const response = await fetch(`${server.serverUrl}/api/vaults/${vault.id}/sync/push`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${server.userKey}`,
          "Content-Type": "application/octet-stream",
        },
        body: body as unknown as BodyInit,
      });

      // The shape is the documented contract (64 hex characters), so the body is
      // refused before a single byte is stored.
      expect(response.status).toBe(422);
      const refused = (await response.json()) as {
        error?: string;
        details?: Array<{ field?: string }>;
      };
      expect(refused.error).toBe("VALIDATION_ERROR");
      // The refusal names the field, so this is the shape check answering — not some
      // other malformed-frame path that would 422 for a different reason.
      expect(refused.details?.some((detail) => detail.field?.includes("contentHash"))).toBe(true);

      // The proof that matters: the database is byte-identical (no write escaped the
      // store) and the server still answers out of it.
      expect(readFileSync(databasePath)).toEqual(before);
      const me = await fetch(`${server.serverUrl}/api/me`, {
        headers: { Authorization: `Bearer ${server.userKey}` },
      });
      expect(me.status).toBe(200);
    });

    it("does not hand the named file back through the content route", async () => {
      const vault = await newVault("traversal-read");
      const response = await fetch(
        `${server.serverUrl}/api/vaults/${vault.id}/sync/versions/..%2F..%2Fcourier.db/content`,
        { headers: { Authorization: `Bearer ${server.userKey}` } },
      );

      // It used to answer the SQLite file itself — every key in it, in plaintext.
      expect(response.status).toBe(404);
      const text = await response.text();
      // Never the database: its header is the first thing the old behaviour returned.
      expect(text.startsWith("SQLite format 3")).toBe(false);
      // A JSON `NOT_FOUND` is this server's own handler answering, so the URL did match
      // the route and the store refused to resolve the path. A router-level 404 would be
      // plain text, which is what makes this assertion able to fail.
      expect((JSON.parse(text) as { error?: string }).error).toBe("NOT_FOUND");
    });
  });
});
