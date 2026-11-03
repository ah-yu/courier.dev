import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { ApiClientError, parsePushBody } from "@courier/shared";
import { loadConfig, saveConfig, loadState, saveState, type CliConfig } from "./config";
import { createCliClient, createCliSyncApi, createFetchTransport } from "./api";

const sample: CliConfig = {
  serverUrl: "http://vps.example.com",
  userKey: "ck_abc",
  deviceName: "nas",
  vaults: [{ vaultId: "vault-1", vaultPath: "/mnt/vault", encryptionKeyB64: "a2V5" }],
};

/** A `fetch`-like function answering one canned response. */
function fetchResolving(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): typeof fetch {
  return vi.fn(async () => new Response(body, { status, headers })) as unknown as typeof fetch;
}

describe("config persistence", () => {
  it("round-trips config and state in a temp dir", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "courier-cli-test-"));
    process.env.COURIER_CLI_CONFIG_DIR = dir;
    try {
      saveConfig(sample);
      expect(loadConfig()).toEqual(sample);
      saveState(
        "vault-1",
        '{"f1":{"lastKnownVersionId":"x","lastKnownContentHash":"h","plainPath":"a.md"}}',
      );
      expect(loadState("vault-1")).toContain('"f1"');
      expect(loadState("vault-2")).toBeNull();
    } finally {
      delete process.env.COURIER_CLI_CONFIG_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no config exists", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "courier-cli-empty-"));
    process.env.COURIER_CLI_CONFIG_DIR = dir;
    try {
      expect(loadConfig()).toBeNull();
    } finally {
      delete process.env.COURIER_CLI_CONFIG_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The fetch transport is the CLI's only host-specific networking code — the
 * endpoints, auth and error mapping are the shared client's, and the push frame
 * is the engine's. What is worth pinning here is that a `fetch` response becomes
 * the shape the client expects (bytes always, text/JSON decoded lazily) and that
 * a transport failure is told apart from a server answer.
 */
describe("createFetchTransport", () => {
  it("keeps the bytes and exposes text/JSON from them", async () => {
    const transport = createFetchTransport(
      fetchResolving(200, JSON.stringify({ vaults: [] }), { "content-type": "application/json" }),
    );

    const response = await transport({ url: "http://srv/api/vaults", method: "GET", headers: {} });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ vaults: [] });
    expect(response.text).toBe('{"vaults":[]}');
    expect(response.arrayBuffer.byteLength).toBe('{"vaults":[]}'.length);
  });

  it("leaves a non-JSON body unparsed instead of throwing", async () => {
    const transport = createFetchTransport(fetchResolving(200, "not json at all"));

    const response = await transport({ url: "http://srv/x", method: "GET", headers: {} });

    expect(response.json).toBeNull();
    expect(response.text).toBe("not json at all");
  });

  it("decodes the body only when text or JSON is read, and at most once", async () => {
    // A large download reads `arrayBuffer`; decoding it as UTF-8 would cost a pass
    // over every ciphertext byte and a throwaway string (see the transport's doc).
    // This pins the `TextDecoder` call itself — the cost proxy — so a different eager
    // decoder (say Buffer#toString) would need its own guard.
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const transport = createFetchTransport(fetchResolving(200, '{"vaults":[]}'));
      const response = await transport({
        url: "http://srv/api/vaults",
        method: "GET",
        headers: {},
      });

      expect(response.arrayBuffer.byteLength).toBe('{"vaults":[]}'.length);
      expect(decode).not.toHaveBeenCalled();

      const parsed = response.json;
      expect(parsed).toEqual({ vaults: [] });
      expect(decode).toHaveBeenCalledTimes(1);

      // Both getters share the one decode, and JSON is parsed once: the same object
      // comes back, not a structurally equal one.
      expect(response.text).toBe('{"vaults":[]}');
      expect(response.json).toBe(parsed);
      expect(decode).toHaveBeenCalledTimes(1);
    } finally {
      decode.mockRestore();
    }
  });

  it("answers an empty body as empty text and null JSON, without decoding twice", async () => {
    // 204s and empty responses are common (deletes, `clearDeleted`); `text ??=` must
    // cache "" rather than looking falsy and decoding again on every read.
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const fetchImpl = vi.fn(
        async () => new Response(null, { status: 204 }),
      ) as unknown as typeof fetch;
      const transport = createFetchTransport(fetchImpl);
      const response = await transport({ url: "http://srv/x", method: "DELETE", headers: {} });

      expect(response.status).toBe(204);
      expect(response.text).toBe("");
      expect(response.json).toBeNull();
      expect(response.text).toBe("");
      expect(decode).toHaveBeenCalledTimes(1);
    } finally {
      decode.mockRestore();
    }
  });

  it("keeps the status of an error response, rather than turning it into a failure", async () => {
    // `fetch` resolves for 4xx/5xx; the client decides what that means. A transport
    // that threw here would hide the server's error body.
    const transport = createFetchTransport(fetchResolving(401, '{"error":"UNAUTHORIZED"}'));

    const response = await transport({ url: "http://srv/x", method: "GET", headers: {} });

    expect(response.status).toBe(401);
    expect(response.json).toEqual({ error: "UNAUTHORIZED" });
  });
});

describe("the CLI's client", () => {
  it("lists the user's vaults — the credential check `register` performs", async () => {
    const fetchImpl = fetchResolving(
      200,
      JSON.stringify({ vaults: [{ id: "v-1", name: "notes", createdAt: "2026-01-01" }] }),
    );
    const client = createCliClient({ serverUrl: "http://srv", userKey: "ck_x", fetchImpl });

    const res = await client.listVaults();

    expect(res.vaults[0]!.id).toBe("v-1");
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string> },
    ];
    expect(url).toBe("http://srv/api/vaults");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer ck_x");
  });

  it("reads the vault's crypto material under the names the routes use", async () => {
    const fetchImpl = fetchResolving(200, JSON.stringify({ encryptionSalt: "salt" }));
    const client = createCliClient({ serverUrl: "http://srv", userKey: "ck_x", fetchImpl });

    await expect(client.getEncryptionSalt("v-1")).resolves.toEqual({ encryptionSalt: "salt" });
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://srv/api/vaults/v-1/encryption-salt");
  });

  it("maps a non-2xx answer to ApiClientError", async () => {
    const client = createCliClient({
      serverUrl: "http://srv",
      userKey: "ck_x",
      fetchImpl: fetchResolving(401, JSON.stringify({ error: "UNAUTHORIZED", message: "bad key" })),
    });

    const error = await client.getVersionContent("v1", "h").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiClientError);
    // The code and message come from the body, so this also proves the lazy `json`
    // getter still feeds `handleApiError` (a null answer would degrade to UNKNOWN_ERROR).
    expect(error).toMatchObject({ status: 401, code: "UNAUTHORIZED", message: "bad key" });
  });

  it("does not decode a ciphertext download", async () => {
    // The regression this guards: every response body used to be decoded as UTF-8, so
    // a 50 MiB download spent most of its time turning ciphertext into a discarded
    // string. A content download asks only for bytes.
    const decode = vi.spyOn(TextDecoder.prototype, "decode");
    try {
      const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
      const fetchImpl = vi.fn(
        async () => new Response(bytes, { status: 200 }),
      ) as unknown as typeof fetch;
      const client = createCliClient({ serverUrl: "http://srv", userKey: "ck_x", fetchImpl });

      await expect(client.getVersionContent("v1", "h")).resolves.toEqual(bytes);

      expect(decode).not.toHaveBeenCalled();
    } finally {
      decode.mockRestore();
    }
  });
});

describe("the CLI's sync api", () => {
  it("states the device label read at push time, and the session id once known", async () => {
    const fetchImpl = fetchResolving(200, JSON.stringify({ results: [] }));
    let deviceName = "书房笔记本";
    const api = createCliSyncApi({
      serverUrl: "http://srv",
      userKey: "ck_x",
      getDeviceName: () => deviceName,
      fetchImpl,
    });

    api.setSessionId?.("session-1");
    await api.push("v1", [
      {
        fileId: "f1",
        encryptedPath: "p",
        content: new Uint8Array([1, 2, 3]),
        action: "create",
        versionId: "v",
        contentHash: "h",
        sizeBytes: 3,
        mtimeMs: 0,
        // Decided from a chain with no head yet.
        baseVersionId: null,
        historyKind: "documents",
      },
    ]);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: Uint8Array },
    ];
    expect(url).toContain("/api/vaults/v1/sync/push");
    expect(init.headers["X-Courier-Session-Id"]).toBe("session-1");
    // The label is user-facing text, so it rides in the frame's JSON header — an HTTP
    // header value cannot carry a Chinese name — and it is read per push, so a rename
    // applies without restarting the daemon.
    expect(init.headers["X-Courier-Device-Id"]).toBeUndefined();
    expect(parsePushBody(new Uint8Array(init.body)).deviceName).toBe("书房笔记本");
  });
});
