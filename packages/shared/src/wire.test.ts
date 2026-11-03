import { describe, expect, it } from "vitest";
import { MAX_DEVICE_NAME_LENGTH } from "./sync";
import { CHUNKED_TRANSFER_THRESHOLD } from "./blob";
import {
  MAX_PUSH_HEADER_BYTES,
  PUSH_HEADER_LENGTH_BYTES,
  WireFormatError,
  buildPushBody,
  parsePushBody,
  type PushFileFrame,
} from "./wire";

/** Deterministic bytes, so a round trip can be compared exactly. */
function bytes(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (i * 31 + seed * 7) % 251;
  return out;
}

function frame(overrides: Partial<PushFileFrame> = {}): PushFileFrame {
  return {
    fileId: "file-1",
    encryptedPath: "ZW5jcnlwdGVkLXBhdGg=",
    action: "create",
    versionId: "version-1",
    contentHash: "a".repeat(64),
    sizeBytes: 1024,
    mtimeMs: 1_760_000_000_000,
    baseVersionId: null,
    content: bytes(1024),
    historyKind: "documents",
    ...overrides,
  };
}

/** Write a body by hand so the parser can be fed things the builder cannot produce. */
function handBuiltBody(header: unknown, content: Uint8Array = new Uint8Array(0)): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const body = new Uint8Array(
    PUSH_HEADER_LENGTH_BYTES + headerBytes.byteLength + content.byteLength,
  );
  new DataView(body.buffer).setUint32(0, headerBytes.byteLength, true);
  body.set(headerBytes, PUSH_HEADER_LENGTH_BYTES);
  body.set(content, PUSH_HEADER_LENGTH_BYTES + headerBytes.byteLength);
  return body;
}

function headerEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fileId: "file-1",
    encryptedPath: "ZW5jcnlwdGVkLXBhdGg=",
    action: "modify",
    versionId: "version-1",
    contentHash: "a".repeat(64),
    sizeBytes: 4,
    mtimeMs: 1_760_000_000_000,
    baseVersionId: null,
    contentLength: 0,
    historyKind: "documents",
    ...overrides,
  };
}

describe("the push wire frame", () => {
  it("round-trips a batch, keeping every field and every byte", () => {
    const files = [
      frame({ fileId: "a", action: "create", content: bytes(300, 1) }),
      // A version with no content: a delete, or a rename the store already has.
      frame({ fileId: "b", action: "rename", content: null, sizeBytes: 4096 }),
      frame({ fileId: "c", action: "delete", content: null, sizeBytes: 0 }),
    ];

    const parsed = parsePushBody(buildPushBody(files, { deviceName: "  MacBook  " }));

    // The label is trimmed once, and stated once for the whole batch.
    expect(parsed.deviceName).toBe("MacBook");
    expect(parsed.files).toHaveLength(3);
    for (const [index, file] of parsed.files.entries()) {
      const source = files[index]!;
      expect(file.fileId).toBe(source.fileId);
      expect(file.encryptedPath).toBe(source.encryptedPath);
      expect(file.action).toBe(source.action);
      expect(file.versionId).toBe(source.versionId);
      expect(file.contentHash).toBe(source.contentHash);
      expect(file.sizeBytes).toBe(source.sizeBytes);
      expect(file.mtimeMs).toBe(source.mtimeMs);
      expect(file.baseVersionId).toBe(source.baseVersionId);
      expect(file.historyKind).toBe(source.historyKind);
      if (source.content === null) {
        expect(file.content).toBeNull();
      } else {
        expect(Array.from(file.content!)).toEqual(Array.from(source.content));
      }
    }
  });

  it("carries a non-ASCII device label, which an HTTP header could not", () => {
    const parsed = parsePushBody(buildPushBody([frame()], { deviceName: "书房笔记本" }));
    expect(parsed.deviceName).toBe("书房笔记本");
  });

  it("reads an absent, empty or blank device label as null", () => {
    expect(parsePushBody(buildPushBody([frame()])).deviceName).toBeNull();
    expect(parsePushBody(buildPushBody([frame()], { deviceName: null })).deviceName).toBeNull();
    expect(parsePushBody(buildPushBody([frame()], { deviceName: "   " })).deviceName).toBeNull();
    // A hand-built header without the key at all is the same case.
    expect(parsePushBody(handBuiltBody({ files: [headerEntry()] })).deviceName).toBeNull();
  });

  it("rejects a device label that is not a string", () => {
    expect(() => parsePushBody(handBuiltBody({ deviceName: 7, files: [headerEntry()] }))).toThrow(
      /deviceName is not a string/,
    );
  });

  it("truncates an over-long device label instead of failing the batch", () => {
    // The label is display text, and the server refuses a push whose header carries more
    // than MAX_DEVICE_NAME_LENGTH characters **for the whole request** (422 — a device
    // that then never syncs), while its subscribe path truncates the same string. A name
    // that is merely too long must not be able to stop a device syncing.
    const tooLong = "x".repeat(MAX_DEVICE_NAME_LENGTH + 40);
    const parsed = parsePushBody(buildPushBody([frame()], { deviceName: tooLong }));

    expect(parsed.deviceName).toBe(tooLong.slice(0, MAX_DEVICE_NAME_LENGTH));
  });

  it("keeps a large payload byte-exact and hands it back as a view, not a copy", () => {
    const content = bytes(256 * 1024, 3);
    const body = buildPushBody([frame({ content, sizeBytes: content.byteLength })]);
    const [file] = parsePushBody(body).files;

    expect(Array.from(file!.content!)).toEqual(Array.from(content));
    // A view into the body: the server writes it straight to the store.
    expect(file!.content!.buffer).toBe(body.buffer);
  });

  it("carries a baseVersionId through, which is what makes a push conditional", () => {
    const { files } = parsePushBody(
      buildPushBody([frame({ action: "modify", baseVersionId: "head-9", content: bytes(8) })]),
    );
    expect(files[0]!.baseVersionId).toBe("head-9");
  });

  it("carries the per-file history kind, so one batch can hold a note and an attachment", () => {
    // The kind is what the server maps to the **vault's** two limits; a batch may mix both,
    // and each version states its own.
    const { files } = parsePushBody(
      buildPushBody([
        frame({ fileId: "note", content: bytes(8), historyKind: "documents" }),
        frame({ fileId: "photo", content: bytes(8), historyKind: "attachments" }),
      ]),
    );
    expect(files.map((file) => file.historyKind)).toEqual(["documents", "attachments"]);
  });

  it("refuses to build a frame whose history kind is not one of the two", () => {
    // The server refuses the whole batch over an unknown kind (422, so the device never
    // syncs). The producer's mistake has to fail here, naming the file.
    for (const historyKind of ["notes", "", 7, undefined]) {
      expect(() =>
        buildPushBody([frame({ historyKind: historyKind as unknown as "documents" })]),
      ).toThrow(/historyKind/);
    }
  });

  it("rejects a header whose history kind is missing or not a known value", () => {
    expect(() =>
      parsePushBody(handBuiltBody({ files: [headerEntry({ historyKind: undefined })] })),
    ).toThrow(/historyKind/);
    expect(() =>
      parsePushBody(handBuiltBody({ files: [headerEntry({ historyKind: "notes" })] })),
    ).toThrow(/historyKind/);
  });

  it("rejects a body shorter than its own length prefix", () => {
    expect(() => parsePushBody(new Uint8Array(2))).toThrow(WireFormatError);
  });

  it("rejects a header that is empty, truncated, or not JSON", () => {
    expect(() => parsePushBody(handBuiltBody({ files: [] }).subarray(0, 0))).toThrow(
      WireFormatError,
    );

    const emptyHeader = new Uint8Array(PUSH_HEADER_LENGTH_BYTES);
    new DataView(emptyHeader.buffer).setUint32(0, 0, true);
    expect(() => parsePushBody(emptyHeader)).toThrow(/header is empty/);

    // The length prefix claims more header than the body holds.
    const lying = new Uint8Array(PUSH_HEADER_LENGTH_BYTES + 4);
    new DataView(lying.buffer).setUint32(0, 4096, true);
    expect(() => parsePushBody(lying)).toThrow(/runs past the end/);

    const notJson = handBuiltBody({ files: [] });
    notJson[PUSH_HEADER_LENGTH_BYTES] = 0x7b; // "{" — invalid on its own
    notJson[PUSH_HEADER_LENGTH_BYTES + 1] = 0x7b;
    expect(() => parsePushBody(notJson)).toThrow(/not valid JSON/);
  });

  it("rejects a header of the wrong shape", () => {
    expect(() => parsePushBody(handBuiltBody(null))).toThrow(/not an object/);
    expect(() => parsePushBody(handBuiltBody([1, 2, 3]))).toThrow(/not an object/);
    expect(() => parsePushBody(handBuiltBody({}))).toThrow(/no files array/);
    expect(() => parsePushBody(handBuiltBody({ files: {} }))).toThrow(/no files array/);
    expect(() => parsePushBody(handBuiltBody({ files: ["nope"] }))).toThrow(/is not an object/);
    expect(() => parsePushBody(handBuiltBody({ files: [[]] }))).toThrow(/is not an object/);
  });

  it("rejects fields that are missing, misnamed or of the wrong type", () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ action: "explode" }, /action is not a sync action/],
      [{ action: undefined }, /action is not a sync action/],
      [{ fileId: 7 }, /fileId is not a string/],
      [{ encryptedPath: null }, /encryptedPath is not a string/],
      [{ versionId: 1 }, /versionId is not a string/],
      [{ contentHash: [] }, /contentHash is not a string/],
      [{ sizeBytes: -1 }, /sizeBytes is not a non-negative integer/],
      [{ sizeBytes: 1.5 }, /sizeBytes is not a non-negative integer/],
      [{ mtimeMs: -1 }, /mtimeMs is not a non-negative integer/],
      [{ mtimeMs: 1.5 }, /mtimeMs is not a non-negative integer/],
      [{ mtimeMs: undefined }, /mtimeMs is not a non-negative integer/],
      [{ contentLength: "4" }, /contentLength is not a non-negative integer/],
      [{ contentChunks: 1.5 }, /contentChunks is not a non-negative integer/],
      [{ contentChunks: -1 }, /contentChunks is not a non-negative integer/],
      [{ baseVersionId: 42 }, /baseVersionId is neither a string nor null/],
    ];
    for (const [overrides, message] of cases) {
      expect(() =>
        parsePushBody(handBuiltBody({ files: [headerEntry(overrides)] }, new Uint8Array(4))),
      ).toThrow(message);
    }
  });

  it("rejects content that runs past the end of the body, and trailing bytes", () => {
    // Claims 8 bytes of content, carries 4.
    const short = handBuiltBody({ files: [headerEntry({ contentLength: 8 })] }, new Uint8Array(4));
    expect(() => parsePushBody(short)).toThrow(/body ends first/);

    // Claims 0 bytes, carries 4: nobody claimed the tail.
    const trailing = handBuiltBody(
      { files: [headerEntry({ contentLength: 0 })] },
      new Uint8Array(4),
    );
    expect(() => parsePushBody(trailing)).toThrow(/trailing bytes/);
  });

  it("rejects a body that mixes content with staged chunks", () => {
    expect(() =>
      buildPushBody([frame({ content: bytes(4), contentChunks: 3, sizeBytes: 9 * 1024 * 1024 })]),
    ).toThrow(/one or the other/);
  });

  it("rejects a whole payload above the chunking threshold", () => {
    expect(() => buildPushBody([frame({ content: bytes(4), sizeBytes: 9 * 1024 * 1024 })])).toThrow(
      /must travel in chunks/,
    );
  });

  it("rejects a chunked version at or below the threshold, or with the wrong count", () => {
    expect(() =>
      buildPushBody([frame({ content: null, contentChunks: 1, sizeBytes: 1024 })]),
    ).toThrow(/at or below/);
    expect(() =>
      buildPushBody([frame({ content: null, contentChunks: 2, sizeBytes: 9 * 1024 * 1024 })]),
    ).toThrow(/declares 2 chunks/);
  });

  it("puts the threshold itself on the whole-payload side", () => {
    // Exactly 8 MiB is one payload; one byte more must be staged.
    expect(() =>
      buildPushBody([frame({ content: bytes(4), sizeBytes: CHUNKED_TRANSFER_THRESHOLD })]),
    ).not.toThrow();
    expect(() =>
      buildPushBody([frame({ content: bytes(4), sizeBytes: CHUNKED_TRANSFER_THRESHOLD + 1 })]),
    ).toThrow(/must travel in chunks/);
    // And a chunked push at exactly the threshold is refused, not accepted.
    expect(() =>
      buildPushBody([
        frame({
          content: null,
          contentChunks: 2,
          sizeBytes: CHUNKED_TRANSFER_THRESHOLD,
        }),
      ]),
    ).toThrow(/at or below/);
  });

  it("keeps the contents of several files in header order", () => {
    const first = bytes(300, 1);
    const second = bytes(200, 2);
    const parsed = parsePushBody(
      buildPushBody([
        frame({ fileId: "a", content: first, sizeBytes: first.byteLength }),
        frame({ fileId: "b", content: second, sizeBytes: second.byteLength }),
      ]),
    );

    expect(parsed.files.map((file) => file.fileId)).toEqual(["a", "b"]);
    expect(Array.from(parsed.files[0]!.content!)).toEqual(Array.from(first));
    expect(Array.from(parsed.files[1]!.content!)).toEqual(Array.from(second));
  });

  it("reads a zero-length payload as no content", () => {
    // A zero-byte file still has a version; the frame says "no bytes", and the reader
    // must not hand the blob store an empty view it would mistake for content.
    const parsed = parsePushBody(
      buildPushBody([frame({ content: new Uint8Array(0), sizeBytes: 0 })]),
    );
    expect(parsed.files[0]!.content).toBeNull();
  });

  it("round-trips a chunked version's count", () => {
    const size = 9 * 1024 * 1024;
    const parsed = parsePushBody(
      buildPushBody([frame({ content: null, contentChunks: 3, sizeBytes: size })]),
    );
    expect(parsed.files[0]!.content).toBeNull();
    expect(parsed.files[0]!.contentChunks).toBe(3);
    expect(parsed.files[0]!.sizeBytes).toBe(size);
  });

  it("rejects a header over the size limit, on both sides", () => {
    // An 11 KiB path × 100 files is past the 1 MiB header bound.
    const big = "Z".repeat(11 * 1024);
    const files = Array.from({ length: 100 }, (_, index) =>
      frame({ fileId: `file-${index}`, encryptedPath: big, content: null, sizeBytes: 0 }),
    );
    expect(() => buildPushBody(files)).toThrow(/over the/);

    // And a body that claims an oversized header is refused before it is read.
    const oversized = new Uint8Array(PUSH_HEADER_LENGTH_BYTES);
    new DataView(oversized.buffer).setUint32(0, MAX_PUSH_HEADER_BYTES + 1, true);
    expect(() => parsePushBody(oversized)).toThrow(/over the/);
  });
});
