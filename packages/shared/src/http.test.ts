import { describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  createCourierClient,
  handleApiError,
  httpToWsUrl,
  type HttpTransport,
  type TransportRequest,
  type TransportResponse,
} from "./http";
import { buildContentBatchBody } from "./wire";

/**
 * The shared HTTP client: the one place a request is built and a failure is
 * mapped, for every host.
 *
 * What the tests pin is exactly what the three hand-written clients used to
 * disagree about — the `Bearer` header, the WebSocket session id header, the
 * `/api` prefix and path escaping, which routes carry a body, the binary
 * content route, and "the server said no" versus "nothing answered".
 */

/** A transport that answers one canned response and records what it was asked. */
function fakeTransport(response: Partial<TransportResponse> = {}): {
  transport: HttpTransport;
  calls: TransportRequest[];
} {
  const calls: TransportRequest[] = [];
  const transport: HttpTransport = async (request) => {
    calls.push(request);
    return {
      status: 200,
      text: "",
      json: null,
      arrayBuffer: new ArrayBuffer(0),
      ...response,
    };
  };
  return { transport, calls };
}

function jsonResponse(json: unknown, status = 200): Partial<TransportResponse> {
  return { status, json, text: JSON.stringify(json) };
}

function expectApiError(status: number, json: unknown): ApiClientError {
  try {
    handleApiError(status, json);
    throw new Error("handleApiError did not throw");
  } catch (err) {
    if (err instanceof ApiClientError) return err;
    throw new Error(
      `handleApiError threw unexpected ${err?.constructor?.name ?? "error"}: ${String(err)}`,
      { cause: err },
    );
  }
}

describe("handleApiError", () => {
  it("throws ApiClientError with details on validation failure", () => {
    const err = expectApiError(422, {
      error: "VALIDATION_ERROR",
      message: "Validation failed",
      details: [{ field: "name", message: "Name is required" }],
    });

    expect(err.status).toBe(422);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("Validation failed");
    expect(err.details).toEqual([{ field: "name", message: "Name is required" }]);
  });

  it("throws ApiClientError on server error", () => {
    const err = expectApiError(500, {
      error: "INTERNAL_ERROR",
      message: "Something went wrong",
    });

    expect(err.status).toBe(500);
    expect(err.code).toBe("INTERNAL_ERROR");
  });

  it("throws ApiClientError with UNKNOWN_ERROR on non-JSON response", () => {
    const err = expectApiError(502, undefined);

    expect(err.status).toBe(502);
    expect(err.code).toBe("UNKNOWN_ERROR");
  });

  it("throws ApiClientError with NOT_FOUND when vault is missing", () => {
    const err = expectApiError(404, {
      error: "NOT_FOUND",
      message: "Vault not found",
    });

    expect(err.status).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("throws ApiClientError with UNAUTHORIZED on bad token", () => {
    const err = expectApiError(401, {
      error: "UNAUTHORIZED",
      message: "Invalid token",
    });

    expect(err.status).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
  });

  it("carries the wait a rate limit asked for, so a caller can retry it", () => {
    try {
      handleApiError(
        429,
        { error: "RATE_LIMITED", message: "Rate limit exceeded. Please try again in 30 seconds." },
        { "retry-after": "30" },
      );
      throw new Error("handleApiError did not throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      expect(err).toMatchObject({ status: 429, code: "RATE_LIMITED", retryAfterMs: 30_000 });
    }
  });

  it("leaves the wait undefined when the server did not send one", () => {
    const err = expectApiError(429, { error: "RATE_LIMITED", message: "slow down" });
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("ignores a Retry-After that is not a number of seconds", () => {
    try {
      handleApiError(
        429,
        { error: "RATE_LIMITED", message: "slow down" },
        {
          "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT",
        },
      );
      throw new Error("handleApiError did not throw");
    } catch (err) {
      expect((err as ApiClientError).retryAfterMs).toBeUndefined();
    }
  });
});

describe("createCourierClient — request assembly", () => {
  it("prefixes /api, appends the path and escapes path segments", async () => {
    const { transport, calls } = fakeTransport(jsonResponse({ versions: [] }));

    await createCourierClient({
      baseUrl: "http://srv:3002",
      getUserKey: () => "ck_x",
      transport,
    }).getFileVersionHistory("vault/1", "file?a=b");

    expect(calls[0]!.url).toBe(
      "http://srv:3002/api/vaults/vault%2F1/sync/versions?fileId=file%3Fa%3Db",
    );
    expect(calls[0]!.method).toBe("GET");
  });

  it("sends the user key, and no Authorization header without one", async () => {
    const withKey = fakeTransport(jsonResponse({ vaults: [] }));
    await createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport: withKey.transport,
    }).listVaults();
    expect(withKey.calls[0]!.headers.Authorization).toBe("Bearer ck_x");

    const withoutKey = fakeTransport(jsonResponse({ vaults: [] }));
    await createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => null,
      transport: withoutKey.transport,
    }).listVaults();
    expect(withoutKey.calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("reads the base URL per request, so a settings change applies immediately", async () => {
    let baseUrl = "http://first";
    const { transport, calls } = fakeTransport(jsonResponse({ vaults: [] }));
    const client = createCourierClient({
      baseUrl: () => baseUrl,
      getUserKey: () => "ck_x",
      transport,
    });

    await client.listVaults();
    baseUrl = "http://second";
    await client.listVaults();

    expect(calls.map((call) => call.url)).toEqual([
      "http://first/api/vaults",
      "http://second/api/vaults",
    ]);
  });

  it("identifies requests with the WebSocket session id once it is known", async () => {
    const { transport, calls } = fakeTransport(jsonResponse({ results: [] }));
    const client = createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport,
    });

    client.setSessionId("session-1");
    await client.getVaultSyncHistory("v1");
    client.setSessionId(null);
    await client.getVaultSyncHistory("v1");

    expect(calls[0]!.headers["X-Courier-Session-Id"]).toBe("session-1");
    // A dropped session (socket closed) must stop claiming an identity.
    expect(calls[1]!.headers["X-Courier-Session-Id"]).toBeUndefined();
  });

  it("fetches the per-chain sync index from its own route", async () => {
    const { transport, calls } = fakeTransport(jsonResponse({ files: [] }));
    const client = createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport,
    });

    const result = await client.getVaultSyncIndex("v1");

    expect(calls[0]!.url).toBe("http://srv/api/vaults/v1/sync/index");
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers["Content-Type"]).toBeUndefined();
    expect(result).toEqual({ files: [] });
  });

  it("posts JSON with the right content type where the route expects a body", async () => {
    const { transport, calls } = fakeTransport(
      jsonResponse({ id: "v1", name: "n", createdAt: "" }),
    );

    await createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport,
    }).createVault("notes", "salt", "canary");

    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      name: "notes",
      encryptionSalt: "salt",
      keyCheck: "canary",
    });
  });

  it("sends a push frame as bytes, and never content-types a body-less request", async () => {
    const { transport, calls } = fakeTransport(jsonResponse({ results: [] }));
    const client = createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport,
    });

    const frame = new Uint8Array([1, 2, 3]);
    await client.push("v1", frame);
    await client.getVaultSyncHistory("v1");

    expect(calls[0]!.headers["Content-Type"]).toBe("application/octet-stream");
    expect(calls[0]!.body).toBe(frame);
    expect(calls[1]!.headers["Content-Type"]).toBeUndefined();
    expect(calls[1]!.body).toBeUndefined();
  });

  it("hands version content back as bytes, without parsing it as JSON", async () => {
    const bytes = new Uint8Array([9, 8, 7]).buffer;
    const { transport } = fakeTransport({ status: 200, arrayBuffer: bytes, json: null });

    const content = await createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport,
    }).getVersionContent("v1", "hash");

    expect([...content]).toEqual([9, 8, 7]);
  });

  it("asks for several versions' content in one request", async () => {
    const first = new Uint8Array([1, 2]);
    const second = new Uint8Array([3, 4, 5]);
    const body = buildContentBatchBody([first, null, second]);
    const { transport, calls } = fakeTransport({
      status: 200,
      arrayBuffer: body.buffer.slice(
        body.byteOffset,
        body.byteOffset + body.byteLength,
      ) as ArrayBuffer,
      json: null,
    });
    const hashes = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];

    const contents = await createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport,
    }).getVersionContents("v1", hashes);

    expect(contents[0]).toEqual(first);
    expect(contents[1]).toBeNull();
    expect(contents[2]).toEqual(second);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("/sync/contents");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ hashes });
  });

  it("asks for one byte range of a version", async () => {
    const bytes = new Uint8Array([1, 2]).buffer;
    const { transport, calls } = fakeTransport({ status: 206, arrayBuffer: bytes, json: null });

    const content = await createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport,
    }).getVersionContentRange("v1", "hash", 10, 20);

    expect([...content]).toEqual([1, 2]);
    expect(calls[0]!.headers.Range).toBe("bytes=10-20");
    expect(calls[0]!.url).toContain("/sync/versions/hash/content");
  });

  it("stages a chunk, carrying its index and the upload's shape", async () => {
    const { transport, calls } = fakeTransport(jsonResponse({ received: 2 }));

    const result = await createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport,
    }).uploadChunk("v1", "hash", 1, 3, 9 * 1024 * 1024, new Uint8Array([1, 2, 3]));

    expect(result).toEqual({ received: 2 });
    expect(calls[0]!.method).toBe("PUT");
    expect(calls[0]!.url).toContain("/sync/blobs/hash/chunks/1?chunkCount=3&plaintextSize=9437184");
    expect(calls[0]!.headers["Content-Type"]).toBe("application/octet-stream");
    expect([...new Uint8Array(calls[0]!.body as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it("reads a staged upload's status, and answers null when none was started", async () => {
    const stubbed = fakeTransport(jsonResponse({ received: 1, complete: false }));
    const client = createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport: stubbed.transport,
    });
    await expect(client.getChunkStatus("v1", "hash")).resolves.toEqual({
      received: 1,
      complete: false,
    });

    const missing = fakeTransport(jsonResponse({ error: "NOT_FOUND", message: "Upload" }, 404));
    await expect(
      createCourierClient({
        baseUrl: "http://srv",
        getUserKey: () => "ck_x",
        transport: missing.transport,
      }).getChunkStatus("v1", "hash"),
    ).resolves.toBeNull();

    // Anything but "there is no upload" is still a failure.
    const refused = fakeTransport(jsonResponse({ error: "UNAUTHORIZED", message: "no" }, 401));
    await expect(
      createCourierClient({
        baseUrl: "http://srv",
        getUserKey: () => "ck_x",
        transport: refused.transport,
      }).getChunkStatus("v1", "hash"),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("does not parse the empty body of a delete", async () => {
    const { transport, calls } = fakeTransport({ status: 204, text: "", json: null });

    await expect(
      createCourierClient({
        baseUrl: "http://srv",
        getUserKey: () => "ck_x",
        transport,
      }).deleteVault("v1"),
    ).resolves.toBeUndefined();

    expect(calls[0]!.method).toBe("DELETE");
  });

  it("maps a non-2xx answer from the transport to ApiClientError", async () => {
    const { transport } = fakeTransport(
      jsonResponse({ error: "QUOTA_EXCEEDED", message: "full" }, 413),
    );

    await expect(
      createCourierClient({
        baseUrl: "http://srv",
        getUserKey: () => "ck_x",
        transport,
      }).listVaults(),
    ).rejects.toMatchObject({ status: 413, code: "QUOTA_EXCEEDED" });
  });

  it("maps a transport failure to status 0, distinct from any server answer", async () => {
    const failure = new TypeError("fetch failed");
    const transport = vi.fn<HttpTransport>().mockRejectedValue(failure);

    const error = await createCourierClient({
      baseUrl: "http://srv",
      getUserKey: () => "ck_x",
      transport,
    })
      .listVaults()
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ status: 0, code: "NETWORK_ERROR" });
    // The original failure is kept, so a host can log why nothing answered.
    expect((error as ApiClientError).cause).toBe(failure);
  });
});

describe("httpToWsUrl", () => {
  it("rewrites http and https only", () => {
    expect(httpToWsUrl("http://srv:3002")).toBe("ws://srv:3002");
    expect(httpToWsUrl("https://srv")).toBe("wss://srv");
  });
});
