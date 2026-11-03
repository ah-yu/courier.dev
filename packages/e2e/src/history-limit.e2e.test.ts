import { createHash } from "crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { realPlatform } from "@courier/testing";
import { SyncWebSocket } from "../../engine/src/index";
import type { HistoryLimits } from "../../shared/src/index";
import { createTestClient, type TestClient } from "./harness/client";
import { startTestServer, type TestServer } from "./harness/server";
import {
  createTestVault,
  makeVaultMaterial,
  type TestVault,
  type VaultMaterial,
} from "./harness/vault";
import {
  fileVersions,
  filesAtPath,
  updateVaultSettings,
  versionContentStatus,
} from "./harness/api";
import { waitFor } from "./harness/wait";

/**
 * The version-history limit, end to end: a real server, real `SyncEngine` clients and a
 * real filesystem.
 *
 * The limit is **vault-level state on the server**, and that is what these cases pin: one
 * device changes the vault's two numbers, and every device — including one that never
 * changed anything — is trimmed by them. The server reads the number from its own vault
 * row at push time; the pusher only says whether the file is a document or an attachment.
 * Lowering a limit also trims the chains already stored, which is the half a device alone
 * could never do.
 *
 * The cases below state tiny limits (2 versions of a note, 1 of an attachment) so a chain
 * crosses its bound in a couple of edits instead of two hundred.
 */

/** A small, deterministic PNG-shaped payload (the bytes are never decoded here). */
function pngBytes(fill: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.fill(fill, 8);
  return bytes;
}

/** The 64-hex hash of some bytes, as the store names content. */
function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("history limit e2e", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer("history limit e2e user");
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

  async function newClient(vaultId: string, deviceName: string, dir?: string): Promise<TestClient> {
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

  /** The one fileId the server knows `path` under. */
  async function fileIdAt(vaultId: string, path: string): Promise<string> {
    const ids = await filesAtPath(server, vaultId, material.key, path);
    expect(ids, `chains at ${path}`).toHaveLength(1);
    return ids[0]!;
  }

  it("applies the vault's limit to every device, not to the one that set it", async () => {
    const vault = await newVault("history-limit-shared");
    const laptop = await newClient(vault.id, "laptop");
    const phone = await newClient(vault.id, "phone");

    // The laptop changes the vault's numbers; the phone never does.
    expect(await updateVaultSettings(server, vault.id, { historyLimitDocuments: 2 })).toMatchObject(
      {
        historyLimitDocuments: 2,
        historyLimitAttachments: 10,
      },
    );

    laptop.write("note.md", "v1");
    await laptop.sync();
    const fileId = await fileIdAt(vault.id, "note.md");
    const firstHash = (await fileVersions(server, vault.id, fileId))[0]!.contentHash;
    expect(await versionContentStatus(server, vault.id, firstHash)).toBe(200);

    laptop.write("note.md", "v2");
    await laptop.change("note.md");
    laptop.write("note.md", "v3");
    await laptop.change("note.md");

    // Two versions kept: the vault's limit, applied while the laptop pushed.
    const versions = await fileVersions(server, vault.id, fileId);
    expect(versions).toHaveLength(2);
    expect(versions.map((version) => version.action)).toEqual(["modify", "modify"]);
    expect(await versionContentStatus(server, vault.id, firstHash)).toBe(404);

    // The phone pushes the next version, having never set a limit itself: the server
    // still keeps two, because the number is the vault's rather than the pusher's.
    await phone.sync();
    expect(phone.read("note.md")).toBe("v3");
    phone.write("note.md", "v4");
    await phone.change("note.md");

    expect(await fileVersions(server, vault.id, fileId)).toHaveLength(2);
    // And the head survived both trims, so a peer converges on the latest content.
    const peer = await newClient(vault.id, "tablet");
    await peer.sync();
    expect(peer.read("note.md")).toBe("v4");
  });

  it("gives notes and attachments the vault's two different limits", async () => {
    const vault = await newVault("history-limit-kinds");
    await updateVaultSettings(server, vault.id, {
      historyLimitDocuments: 3,
      historyLimitAttachments: 1,
    });
    const laptop = await newClient(vault.id, "laptop");

    laptop.writeBinary("media/one.png", pngBytes(1));
    await laptop.sync();
    const imageId = await fileIdAt(vault.id, "media/one.png");
    const firstImageHash = (await fileVersions(server, vault.id, imageId))[0]!.contentHash;

    laptop.writeBinary("media/one.png", pngBytes(2));
    await laptop.change("media/one.png");
    laptop.writeBinary("media/one.png", pngBytes(3));
    await laptop.change("media/one.png");

    // The attachment limit is 1: only the newest version survives, and its bytes went.
    expect(await fileVersions(server, vault.id, imageId)).toHaveLength(1);
    expect(await versionContentStatus(server, vault.id, firstImageHash)).toBe(404);

    // A note in the same vault keeps the documents bound (3), because the server reads
    // the file's kind from the push rather than applying one limit to everything.
    laptop.write("note.md", "n1");
    await laptop.sync();
    laptop.write("note.md", "n2");
    await laptop.change("note.md");
    laptop.write("note.md", "n3");
    await laptop.change("note.md");
    laptop.write("note.md", "n4");
    await laptop.change("note.md");
    const noteId = await fileIdAt(vault.id, "note.md");
    expect(await fileVersions(server, vault.id, noteId)).toHaveLength(3);
  });

  it("trims the chains already stored when the vault's limit is lowered", async () => {
    const vault = await newVault("history-limit-lowering");
    await updateVaultSettings(server, vault.id, {
      historyLimitDocuments: 8,
      historyLimitAttachments: 8,
    });
    const laptop = await newClient(vault.id, "laptop");

    for (const [index, body] of ["v1", "v2", "v3", "v4"].entries()) {
      laptop.write("note.md", body);
      if (index === 0) await laptop.sync();
      else await laptop.change("note.md");
    }
    const fileId = await fileIdAt(vault.id, "note.md");
    const versions = await fileVersions(server, vault.id, fileId);
    expect(versions).toHaveLength(4);
    const droppedHashes = versions.slice(0, 2).map((version) => version.contentHash);

    // An attachment chain too, so the trim below has to pick each chain's own limit.
    for (const [index, fill] of [1, 2, 3].entries()) {
      laptop.writeBinary("media/one.png", pngBytes(fill));
      if (index === 0) await laptop.sync();
      else await laptop.change("media/one.png");
    }
    const imageId = await fileIdAt(vault.id, "media/one.png");
    const imageVersions = await fileVersions(server, vault.id, imageId);
    expect(imageVersions).toHaveLength(3);
    const droppedImageHashes = imageVersions.slice(0, 2).map((version) => version.contentHash);

    // No device pushes these files again: the lowering itself has to reach the chains.
    await updateVaultSettings(server, vault.id, {
      historyLimitDocuments: 2,
      historyLimitAttachments: 1,
    });

    expect(await fileVersions(server, vault.id, fileId)).toHaveLength(2);
    expect(await fileVersions(server, vault.id, imageId)).toHaveLength(1);
    for (const contentHash of [...droppedHashes, ...droppedImageHashes]) {
      expect(await versionContentStatus(server, vault.id, contentHash)).toBe(404);
    }

    // A retried PATCH is idempotent: the update itself already committed, so a retry only
    // re-runs the trim, which now has nothing to remove and must not fail or drop a row.
    const retried = await updateVaultSettings(server, vault.id, {
      historyLimitDocuments: 2,
      historyLimitAttachments: 1,
    });
    expect(retried.historyLimitDocuments).toBe(2);
    expect(await fileVersions(server, vault.id, fileId)).toHaveLength(2);
    expect(await fileVersions(server, vault.id, imageId)).toHaveLength(1);

    // A device that pulls afterwards gets both files, not a broken chain.
    const phone = await newClient(vault.id, "phone");
    await phone.sync();
    expect(phone.read("note.md")).toBe("v4");
    expect(phone.readBytes("media/one.png")).toEqual(pngBytes(3));
  });

  it("keeps a blob another file still holds when a trim drops its own reference", async () => {
    const vault = await newVault("history-limit-shared-content");
    await updateVaultSettings(server, vault.id, { historyLimitDocuments: 1 });
    const laptop = await newClient(vault.id, "laptop");

    // The same bytes in two files: content addressing means one blob, one row, two
    // chains. Trimming one chain must not take the other file's content with it.
    laptop.write("a.md", "shared text");
    laptop.write("b.md", "shared text");
    await laptop.sync();
    const aId = await fileIdAt(vault.id, "a.md");
    const sharedHash = (await fileVersions(server, vault.id, aId))[0]!.contentHash;
    expect(hashOf(new TextEncoder().encode("shared text"))).toBe(sharedHash);

    // a.md moves on, so its chain crosses the limit of 1 and drops the shared row;
    // b.md still points at the same bytes.
    laptop.write("a.md", "only a now");
    await laptop.change("a.md");

    expect(await fileVersions(server, vault.id, aId)).toHaveLength(1);
    expect(await versionContentStatus(server, vault.id, sharedHash)).toBe(200);

    // And b.md's content is still readable from a peer that never had the file.
    const phone = await newClient(vault.id, "phone");
    await phone.sync();
    expect(phone.read("b.md")).toBe("shared text");
  });

  it("tells a subscribed device about a limit change, so an open page can follow it", async () => {
    // The limits are the vault's, so a device that did not make the change still has to
    // hear it: the server broadcasts the new pair to every subscriber, and that is what an
    // already-open settings page repaints from.
    const vault = await newVault("history-limit-broadcast");
    const states: string[] = [];
    const received: HistoryLimits[] = [];
    const socket = new SyncWebSocket({
      platform: realPlatform,
      wsUrl: server.wsUrl,
      vaultId: vault.id,
      userKey: server.userKey,
      deviceName: "open-settings-device",
      onEvent: (event) => {
        if (event.type === "state_change") states.push(event.state);
        if (event.type === "vault_settings") received.push(event.historyLimits);
      },
    });
    socket.connect();

    try {
      await waitFor(() => states.includes("connected"), "websocket never connected");

      await updateVaultSettings(server, vault.id, { historyLimitDocuments: 40 });

      await waitFor(() => received.length > 0, "no vault_settings notification arrived");
      // The whole pair travels: the untouched attachment limit is stated too, so the
      // client never has to guess what did not change.
      expect(received.at(-1)).toEqual({ documents: 40, attachments: 10 });
    } finally {
      socket.disconnect();
    }
  });
});
