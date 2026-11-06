import { describe, expect, it } from "vitest";
import { sha256Hex } from "../../../engine/src/index";
import { assertClientConsistent } from "./consistency";

const encoder = new TextEncoder();

/** A sync point for a live file, with or without the stamp a settled pull records. */
async function live(path: string, text: string, stamped = true) {
  const bytes = encoder.encode(text);
  return {
    plainPath: path,
    lastKnownContentHash: await sha256Hex(bytes),
    ...(stamped ? { stamp: { sizeBytes: bytes.byteLength, mtimeMs: 1 } } : {}),
  };
}

/** A delete sync point: the empty content hash and no stamp. */
async function tombstone(path: string) {
  return { plainPath: path, lastKnownContentHash: await sha256Hex(new Uint8Array(0)) };
}

function client(
  state: Record<string, unknown>,
  files: Record<string, Uint8Array>,
  owners: Record<string, string>,
) {
  return {
    state: { json: JSON.stringify(state) },
    readBytes: (path: string) => files[path] ?? null,
    engine: { fileIdForPath: (path: string) => owners[path] ?? null },
  };
}

describe("assertClientConsistent", () => {
  it("passes when a chain owns the bytes its state records", async () => {
    const state = { f1: await live("a.md", "body") };
    await expect(
      assertClientConsistent(client(state, { "a.md": encoder.encode("body") }, { "a.md": "f1" })),
    ).resolves.toBeUndefined();
  });

  it("fails when the recorded bytes are gone", async () => {
    const state = { f1: await live("a.md", "body") };
    await expect(assertClientConsistent(client(state, {}, { "a.md": "f1" }))).rejects.toThrow(
      /no file is there/,
    );
  });

  it("checks a live empty file like any other, including its absence", async () => {
    const state = { f1: await live("blank.md", "") };
    await expect(
      assertClientConsistent(
        client(state, { "blank.md": encoder.encode("") }, { "blank.md": "f1" }),
      ),
    ).resolves.toBeUndefined();
    await expect(assertClientConsistent(client(state, {}, { "blank.md": "f1" }))).rejects.toThrow(
      /no file is there/,
    );
  });

  it("fails when a tombstone still owns a file", async () => {
    const state = { f1: await tombstone("gone.md") };
    await expect(
      assertClientConsistent(
        client(state, { "gone.md": encoder.encode("body") }, { "gone.md": "f1" }),
      ),
    ).rejects.toThrow(/tombstone at gone\.md still has a file/);
  });

  it("passes a tombstone with no file, even after its path was reused", async () => {
    const state = {
      f1: await tombstone("phoenix.md"),
      f2: await live("phoenix.md", "new body"),
    };
    await expect(
      assertClientConsistent(
        client(state, { "phoenix.md": encoder.encode("new body") }, { "phoenix.md": "f2" }),
      ),
    ).resolves.toBeUndefined();
  });

  it("fails when two live chains claim one path", async () => {
    const state = {
      f1: await live("both.md", "one"),
      f2: await live("both.md", "one"),
    };
    await expect(
      assertClientConsistent(
        client(state, { "both.md": encoder.encode("one") }, { "both.md": "f1" }),
      ),
    ).rejects.toThrow(/two live chains own both\.md/);
  });

  it("checks a live entry that has no stamp (an adopted version)", async () => {
    const state = { f1: await live("adopted.md", "body", false) };
    await expect(
      assertClientConsistent(
        client(state, { "adopted.md": encoder.encode("body") }, { "adopted.md": "f1" }),
      ),
    ).resolves.toBeUndefined();
    await expect(assertClientConsistent(client(state, {}, { "adopted.md": "f1" }))).rejects.toThrow(
      /no file is there/,
    );
  });
});
