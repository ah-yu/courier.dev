import { describe, expect, it } from "vitest";
import { createObsidianTransport, type RequestUrlResponseLike } from "./transport";

/**
 * The transport is the plugin's only request path, and its timeout is what keeps a dead
 * socket from holding a whole reconcile pass. A fake `requestUrl` is enough to pin both
 * halves: the timeout rejection and the lazy-response mapping the shared client reads.
 */
const request = { url: "http://server/api/me", method: "GET", headers: {} };

describe("createObsidianTransport", () => {
  it("rejects a request that never settles instead of waiting for the pass", async () => {
    const transport = createObsidianTransport(() => new Promise<never>(() => {}), 20);

    await expect(transport(request)).rejects.toThrow("did not answer within 20ms");
  });

  it("passes the status and headers through and reads the body lazily", async () => {
    const response: RequestUrlResponseLike = {
      status: 200,
      headers: { "retry-after": "1" },
      text: "body",
      get json(): unknown {
        throw new SyntaxError("not JSON");
      },
      arrayBuffer: new ArrayBuffer(0),
    };
    const transport = createObsidianTransport(async () => response, 1_000);

    const result = await transport(request);

    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ "retry-after": "1" });
    expect(result.text).toBe("body");
    // A binary body must not make every download look like a transport failure.
    expect(result.json).toBeNull();
  });

  it("sends the method, content type and exact bytes requestUrl takes", async () => {
    const seen: unknown[] = [];
    const transport = createObsidianTransport(async (param) => {
      seen.push(param);
      return {
        status: 204,
        headers: {},
        text: "",
        json: null,
        arrayBuffer: new ArrayBuffer(0),
      };
    });
    const body = new Uint8Array([1, 2, 3]);

    await transport({
      ...request,
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: "PUT",
      contentType: "application/json",
      throw: false,
    });
    expect(new Uint8Array((seen[0] as { body: ArrayBuffer }).body)).toEqual(body);
  });
});
