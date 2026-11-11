import { describe, expect, it } from "vitest";
import { readPushBody } from "./push-body";
import type { RouteRequest } from "./router";

/**
 * The push header's label is display text: the old schema trimmed it and refused a blank
 * one, and the adapter still has to. `buildPushBody` already trims, so these bodies are
 * assembled by hand to reach the server-side rule.
 */

const content = new Uint8Array([1, 2, 3]);

const file = {
  fileId: "f1",
  encryptedPath: "cGF0aA==",
  action: "modify" as const,
  versionId: "v1",
  contentHash: "a".repeat(64),
  sizeBytes: content.byteLength,
  mtimeMs: 1,
  baseVersionId: null,
  contentLength: content.byteLength,
  historyKind: "documents" as const,
};

function pushBody(deviceName?: string): Uint8Array {
  const header = deviceName === undefined ? { files: [file] } : { deviceName, files: [file] };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const body = new Uint8Array(4 + headerBytes.byteLength + content.byteLength);
  new DataView(body.buffer).setUint32(0, headerBytes.byteLength, true);
  body.set(headerBytes, 4);
  body.set(content, 4 + headerBytes.byteLength);
  return body;
}

function request(body: Uint8Array): RouteRequest {
  return {
    headers: new Headers({ "content-length": String(body.byteLength) }),
    arrayBuffer: async () => body.buffer,
    params: {},
  } as unknown as RouteRequest;
}

describe("readPushBody", () => {
  it("trims a padded device label", async () => {
    const parsed = await readPushBody(request(pushBody("  padded  ")));
    expect(parsed.deviceName).toBe("padded");
  });

  it("normalises a blank device label to null", async () => {
    const parsed = await readPushBody(request(pushBody("   ")));
    expect(parsed.deviceName).toBeNull();
  });

  it("accepts an omitted label", async () => {
    const parsed = await readPushBody(request(pushBody()));
    expect(parsed.deviceName).toBeNull();
  });
});
