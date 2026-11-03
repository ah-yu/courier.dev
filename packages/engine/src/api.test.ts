import { describe, expect, it, vi } from "vitest";
import { parsePushBody, type CourierClient, type PushFileFrame } from "@courier/shared";
import { createSyncApi } from "./api";

/**
 * The engine's network layer: everything protocol-specific that sits on top of
 * the shared client.
 *
 * It is one thing — the push frame — and it carries the **current** device label:
 * reading it through a getter instead of capturing it is what makes
 * `courier-cli device rename` (and the plugin's device-name field) apply to the
 * next push rather than the next restart.
 */

function fakeClient(): {
  client: CourierClient;
  pushes: Array<{ vaultId: string; body: Uint8Array }>;
} {
  const pushes: Array<{ vaultId: string; body: Uint8Array }> = [];
  const client: CourierClient = {
    setSessionId: vi.fn(),
    createVault: vi.fn(),
    listVaults: vi.fn(),
    updateVault: vi.fn(),
    getMe: vi.fn(),
    getEncryptionSalt: vi.fn(),
    getKeyCheck: vi.fn(),
    deleteVault: vi.fn(),
    listDeleted: vi.fn(),
    clearDeleted: vi.fn(),
    getFileVersionHistory: vi.fn(),
    getVaultSyncHistory: vi.fn(async () => ({ files: [] })),
    getVaultSyncIndex: vi.fn(async () => ({ files: [] })),
    getVersionContent: vi.fn(async () => new Uint8Array([1, 2])),
    getVersionContentRange: vi.fn(async () => new Uint8Array([1, 2])),
    uploadChunk: vi.fn(async () => ({ received: 1 })),
    getChunkStatus: vi.fn(async () => null),
    push: vi.fn(async (vaultId: string, body: Uint8Array) => {
      pushes.push({ vaultId, body });
      return { results: [] };
    }),
    pull: vi.fn(async () => ({ files: [] })),
  };
  return { client, pushes };
}

function pushFile(): PushFileFrame {
  return {
    fileId: "f1",
    encryptedPath: "cGF0aA==",
    action: "create",
    versionId: "v1",
    contentHash: "a".repeat(64),
    sizeBytes: 3,
    mtimeMs: 1_760_000_000_000,
    baseVersionId: null,
    content: new Uint8Array([1, 2, 3]),
    historyKind: "documents",
  };
}

describe("createSyncApi", () => {
  it("builds the push frame with the device label read at push time", async () => {
    const { client, pushes } = fakeClient();
    let deviceName = "MacBook";
    const api = createSyncApi(client, () => deviceName);

    await api.push("v1", [pushFile()]);
    deviceName = "书房笔记本";
    await api.push("v1", [pushFile()]);

    expect(pushes[0]!.vaultId).toBe("v1");
    expect(parsePushBody(pushes[0]!.body).deviceName).toBe("MacBook");
    expect(parsePushBody(pushes[1]!.body).deviceName).toBe("书房笔记本");
    // The frame itself is the shared builder's: header + payload byte for byte.
    expect([...parsePushBody(pushes[0]!.body).files[0]!.content!]).toEqual([1, 2, 3]);
  });

  it("delegates the session id, so the server can skip this device's own echo", () => {
    const { client } = fakeClient();
    createSyncApi(client, () => "device").setSessionId?.("session-1");
    expect(client.setSessionId).toHaveBeenCalledWith("session-1");
  });

  it("passes pull, version content and the sync index straight through", async () => {
    const { client } = fakeClient();
    const api = createSyncApi(client, () => "device");

    await api.pull("v1", ["f1"]);
    await api.getVersionContent("v1", "hash");
    await api.getVaultSyncIndex("v1");

    expect(client.pull).toHaveBeenCalledWith("v1", ["f1"]);
    expect(client.getVersionContent).toHaveBeenCalledWith("v1", "hash");
    expect(client.getVaultSyncIndex).toHaveBeenCalledWith("v1");
  });
});
