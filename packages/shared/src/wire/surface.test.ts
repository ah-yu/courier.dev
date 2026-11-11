import { describe, expect, it } from "vitest";
import { byCodeUnits, formatSurface, readSurface } from "./surface";
import { HTTP } from "./registry";
import {
  ContractMismatchErrorSchema,
  PushBodyHeaderSchema,
  PushBodySchema,
  UpdateUserRequestSchema,
  UpdateVaultRequestSchema,
} from "./http";
import { WsServerMessageSchema } from "./ws";

describe("the committed surface", () => {
  it("has one entry per route and method, with unique ids", () => {
    const surface = readSurface();
    expect(Object.keys(surface.http)).toHaveLength(HTTP.length);
    expect(new Set(HTTP.map((contract) => contract.id)).size).toBe(HTTP.length);
    expect(new Set(Object.keys(surface.http)).size).toBe(HTTP.length);
  });

  it("is deterministic", () => {
    expect(formatSurface(readSurface())).toBe(formatSurface(readSurface()));
  });

  it("compares equal strings as equal", () => {
    expect(byCodeUnits("a", "a")).toBe(0);
  });

  it("records the unknown-key rule once, not as a per-object rejection", () => {
    const text = formatSurface(readSurface());
    expect(text).toContain('"unknownKeys": "strip"');
    expect(text).not.toContain('"additionalProperties"');
  });

  it("serializes a schema's constraints, not just its shape", () => {
    const surface = readSurface();
    const createVault = surface.http["POST /api/vaults"] as {
      body: { schema: { properties: { name: { maxLength: number; minLength: number } } } };
    };
    expect(createVault.body.schema.properties.name.minLength).toBe(1);
    expect(createVault.body.schema.properties.name.maxLength).toBe(255);
  });
});

describe("the wire schemas are executable", () => {
  it("accepts a well-formed push header and rejects a bad hash", () => {
    const good = {
      deviceName: "phone",
      files: [
        {
          fileId: "f1",
          encryptedPath: "cGF0aA==",
          action: "modify",
          versionId: "v1",
          contentHash: "a".repeat(64),
          sizeBytes: 12,
          mtimeMs: 1,
          baseVersionId: null,
          contentLength: 12,
          historyKind: "documents",
        },
      ],
    };
    expect(PushBodyHeaderSchema.safeParse(good).success).toBe(true);
    expect(
      PushBodyHeaderSchema.safeParse({
        ...good,
        files: [{ ...good.files[0], contentHash: "not-a-hash" }],
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown server frame", () => {
    expect(WsServerMessageSchema.safeParse({ type: "invented" }).success).toBe(false);
    expect(
      WsServerMessageSchema.safeParse({ type: "files_pushed", vaultId: "v", files: [] }).success,
    ).toBe(true);
  });

  it("records and accepts the 426 body", () => {
    expect(readSurface().contractMismatch).toBeDefined();
    expect(
      ContractMismatchErrorSchema.safeParse({
        error: "CONTRACT_MISMATCH",
        message: "upgrade",
        serverContract: 4,
        minClient: 1,
        clientContract: 5,
        serverVersion: "0.1.0",
      }).success,
    ).toBe(true);
  });

  it("executes the request refinements and the byte guard", () => {
    expect(UpdateUserRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateUserRequestSchema.safeParse({ name: "a" }).success).toBe(true);
    expect(UpdateVaultRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateVaultRequestSchema.safeParse({ name: "a" }).success).toBe(true);

    const frame = {
      fileId: "f1",
      encryptedPath: "cGF0aA==",
      action: "modify",
      versionId: "v1",
      contentHash: "a".repeat(64),
      sizeBytes: 1,
      mtimeMs: 1,
      baseVersionId: null,
      historyKind: "documents",
      content: new Uint8Array([1]),
    };
    expect(PushBodySchema.safeParse({ deviceName: null, files: [frame] }).success).toBe(true);
  });
});
