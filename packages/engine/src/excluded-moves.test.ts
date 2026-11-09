import { describe, expect, it, vi } from "vitest";
import { ExcludedMoveFinder, type ExcludedMovesHost } from "./excluded-moves";
import { sha256Hex } from "./crypto";

/**
 * L0 for `ExcludedMoveFinder`: the finder is real, the adapter surface it asks (listing,
 * stat, read, the identity question) is a mock.
 *
 * The engine suites cover the move this exists for end to end; these cases pin the
 * narrowness of the match — the part that decides whether a file every peer deleted stays
 * deleted, or a file the user still owns is announced as a tombstone.
 */

const encoder = new TextEncoder();

interface Harness {
  finder: ExcludedMoveFinder;
  host: ExcludedMovesHost;
  list: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
}

function makeFinder(
  options: {
    folders?: number;
    files?: Map<string, Uint8Array>;
    sizes?: Map<string, number>;
    claimed?: readonly string[];
    now?: () => number;
    list?: () => Promise<readonly string[]>;
  } = {},
): Harness {
  const files = options.files ?? new Map<string, Uint8Array>();
  const sizes = options.sizes ?? new Map<string, number>();
  const claimed = new Set(options.claimed ?? []);
  const list = vi.fn(options.list ?? (async () => [...files.keys()]));
  const read = vi.fn(async (path: string) => files.get(path) ?? null);

  const host: ExcludedMovesHost = {
    listExcludedFiles: list as ExcludedMovesHost["listExcludedFiles"],
    statFile: async (path) => {
      const bytes = files.get(path);
      return bytes === undefined ? null : { sizeBytes: bytes.byteLength, mtimeMs: 0 };
    },
    readFile: read as ExcludedMovesHost["readFile"],
    isClaimed: (path) => claimed.has(path),
    knownSize: (fileId) => sizes.get(fileId),
    excludedFolders: () => options.folders ?? 1,
    now: options.now ?? (() => 0),
  };
  return { finder: new ExcludedMoveFinder(host), host, list, read };
}

describe("ExcludedMoveFinder", () => {
  it("answers null without listing anything when no folder is excluded", async () => {
    const { finder, list } = makeFinder({
      folders: 0,
      files: new Map([["ex/note.md", encoder.encode("x")]]),
    });
    expect(await finder.find("f1", "note.md", "hash")).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("finds the one same-name candidate whose bytes hash to the sync point", async () => {
    const content = encoder.encode("moved bytes");
    const files = new Map([["excluded/note.md", content]]);
    const { finder } = makeFinder({ files });
    expect(await finder.find("f1", "notes/note.md", await sha256Hex(content))).toBe(
      "excluded/note.md",
    );
  });

  it("keeps the deletion path when two candidates match", async () => {
    const content = encoder.encode("same bytes");
    const files = new Map([
      ["a/note.md", content],
      ["b/note.md", content],
    ]);
    const { finder } = makeFinder({ files });
    expect(await finder.find("f1", "note.md", await sha256Hex(content))).toBeNull();
  });

  it("ignores a candidate another chain claims", async () => {
    const content = encoder.encode("claimed");
    const files = new Map([["excluded/note.md", content]]);
    const { finder } = makeFinder({ files, claimed: ["excluded/note.md"] });
    expect(await finder.find("f1", "note.md", await sha256Hex(content))).toBeNull();
  });

  it("rejects a candidate whose size does not match the recorded sync point, without reading it", async () => {
    const files = new Map([["excluded/note.md", encoder.encode("different length")]]);
    const sizes = new Map([["f1", 3]]);
    const { finder, read } = makeFinder({ files, sizes });
    expect(await finder.find("f1", "note.md", "whatever")).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("skips a candidate it cannot read, and keeps looking", async () => {
    const content = encoder.encode("readable");
    const files = new Map([
      ["a/note.md", content],
      ["b/note.md", content],
    ]);
    const { finder, host } = makeFinder({ files });
    const realRead = host.readFile;
    host.readFile = async (path) => (path === "a/note.md" ? null : await realRead(path));
    // Only the readable candidate counts; it is then the single match.
    expect(await finder.find("f1", "note.md", await sha256Hex(content))).toBe("b/note.md");
  });

  it("answers none when the host cannot list, and reuses that answer within the TTL", async () => {
    let now = 0;
    const { finder, list } = makeFinder({
      now: () => now,
      list: async () => {
        throw new Error("cannot list");
      },
    });
    expect(await finder.find("f1", "note.md", "hash")).toBeNull();
    now += 1_000;
    expect(await finder.find("f1", "note.md", "hash")).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("lists again once the TTL has passed", async () => {
    let now = 0;
    const { finder, list } = makeFinder({ now: () => now });
    await finder.find("f1", "note.md", "hash");
    now += 30_000;
    await finder.find("f1", "note.md", "hash");
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("does not consider a file whose name differs from the old path's", async () => {
    const content = encoder.encode("other name");
    const files = new Map([["excluded/other.md", content]]);
    const { finder } = makeFinder({ files });
    expect(await finder.find("f1", "note.md", await sha256Hex(content))).toBeNull();
  });
});
