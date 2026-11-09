import { describe, expect, it } from "vitest";
import type { VersionChainEntry } from "@courier/shared";
import { RestoreBlockedError, Restorer, type RestoreHost } from "./restore";

/**
 * L0 for `Restorer`: the rules are real, the engine half (the path job, the adapter, the
 * push) is a mock.
 *
 * The engine suites run restores end to end (including the real recycle bin in L3); these
 * cases pin the two things a restore must never get wrong — it never writes over a file
 * that is not its own, and the write is recorded as the engine's before the push, in that
 * order.
 */

function chain(...entries: Partial<VersionChainEntry>[]): VersionChainEntry[] {
  return entries.map((entry, index) => ({
    versionId: `v${index + 1}`,
    contentHash: `h${index + 1}`,
    encryptedPath: `encrypted-path-${index + 1}`,
    action: "modify",
    sizeBytes: 4,
    mtimeMs: index + 1,
    createdAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    ...entry,
  }));
}

interface Harness {
  restorer: Restorer;
  order: string[];
  host: RestoreHost;
}

function makeRestorer(
  options: {
    holder?: string | null;
    pathFor?: string | null;
    localFile?: boolean;
    chain?: VersionChainEntry[];
    bytes?: Uint8Array | null;
  } = {},
): Harness {
  const order: string[] = [];
  const host: RestoreHost = {
    pathFor: () => options.pathFor ?? null,
    chain: async () => {
      order.push("chain");
      return options.chain ?? [];
    },
    versionBytes: async (_contentHash, sizeBytes) => {
      order.push(`bytes:${sizeBytes}`);
      return options.bytes ?? null;
    },
    stat: async () => {
      order.push("stat");
      return options.localFile === true ? { sizeBytes: 4, mtimeMs: 1 } : null;
    },
    fileIdAt: () => options.holder ?? null,
    run: async (path, job) => {
      order.push(`run:${path}`);
      return await job();
    },
    beforeWrite: async (path, bytes) => {
      order.push(`before:${path}:${bytes.byteLength}`);
    },
    write: async (path) => {
      order.push(`write:${path}`);
    },
    pushRestore: async (fileId, target, _bytes, baseVersionId) => {
      order.push(`push:${fileId}:${target}:${baseVersionId}`);
    },
    persist: () => order.push("persist"),
  };
  return { restorer: new Restorer(host), order, host };
}

describe("Restorer.inspect", () => {
  it("answers same-chain for the chain itself, without touching the adapter", async () => {
    const { restorer, order } = makeRestorer({ holder: "f1", localFile: true });
    expect(await restorer.inspect("f1", "note.md")).toEqual({
      kind: "same-chain",
      holderFileId: null,
    });
    expect(order).toEqual([]);
  });

  it("answers other-file with the chain that holds the path", async () => {
    const { restorer, order } = makeRestorer({ holder: "f2" });
    expect(await restorer.inspect("f1", "note.md")).toEqual({
      kind: "other-file",
      holderFileId: "f2",
    });
    expect(order).toEqual([]);
  });

  it("answers unattributed when a local file no chain claims sits there", async () => {
    const { restorer } = makeRestorer({ localFile: true });
    expect(await restorer.inspect("f1", "note.md")).toEqual({
      kind: "unattributed",
      holderFileId: null,
    });
  });

  it("answers free when nothing holds the path", async () => {
    const { restorer } = makeRestorer();
    expect(await restorer.inspect("f1", "note.md")).toEqual({ kind: "free", holderFileId: null });
  });
});

describe("Restorer.restore", () => {
  it("refuses a path another chain holds, before fetching or writing anything", async () => {
    const { restorer, order } = makeRestorer({ holder: "f2" });
    await expect(restorer.restore("f1", "note.md", "h1")).rejects.toBeInstanceOf(
      RestoreBlockedError,
    );
    expect(order).toEqual(["run:note.md"]);
    await expect(restorer.restore("f1", "note.md", "h1")).rejects.toMatchObject({
      reason: "occupied-by-other-file",
      holderFileId: "f2",
    });
  });

  it("refuses a path with a local file no chain claims", async () => {
    const { restorer, order } = makeRestorer({ localFile: true });
    await expect(restorer.restore("f1", "note.md", "h1")).rejects.toMatchObject({
      reason: "unattributed-local-file",
      holderFileId: null,
    });
    expect(order).toEqual(["run:note.md", "stat"]);
  });

  it("refuses a version the chain does not hold", async () => {
    const { restorer, order } = makeRestorer({ chain: chain({ contentHash: "h1" }) });
    await expect(restorer.restore("f1", "note.md", "h9")).rejects.toThrow(
      "Version h9 is not in this file's history",
    );
    expect(order).toEqual(["run:note.md", "stat", "chain"]);
  });

  it("refuses when the store cannot provide the version's bytes", async () => {
    const { restorer, order } = makeRestorer({
      chain: chain({ contentHash: "h1" }),
      bytes: null,
    });
    await expect(restorer.restore("f1", "note.md", "h1")).rejects.toThrow(
      "Version content not found for h1",
    );
    expect(order).toEqual(["run:note.md", "stat", "chain", "bytes:4"]);
  });

  it("writes, marks the write as its own, pushes on the head and persists — in that order", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { restorer, order } = makeRestorer({
      chain: chain({ contentHash: "h1" }, { contentHash: "h2", versionId: "v2" }),
      bytes,
    });
    await restorer.restore("f1", "note.md", "h1");
    expect(order).toEqual([
      "run:note.md",
      "stat",
      "chain",
      "bytes:4",
      "before:note.md:4",
      "write:note.md",
      // The base is the chain's head, not the version being restored.
      "push:f1:note.md:v2",
      "persist",
    ]);
  });

  it("prefers the caller's target, then the chain's live path, then the argument", async () => {
    const withTarget = makeRestorer({
      pathFor: "live.md",
      chain: chain({ contentHash: "h1" }),
      bytes: new Uint8Array(1),
    });
    await withTarget.restorer.restore("f1", "deleted.md", "h1", { targetPath: "renamed.md" });
    expect(withTarget.order).toContain("run:renamed.md");
    expect(withTarget.order).toContain("push:f1:renamed.md:v1");

    const withLive = makeRestorer({
      pathFor: "live.md",
      chain: chain({ contentHash: "h1" }),
      bytes: new Uint8Array(1),
    });
    await withLive.restorer.restore("f1", "deleted.md", "h1");
    expect(withLive.order).toContain("run:live.md");

    const withArgument = makeRestorer({
      chain: chain({ contentHash: "h1" }),
      bytes: new Uint8Array(1),
    });
    await withArgument.restorer.restore("f1", "deleted.md", "h1");
    expect(withArgument.order).toContain("run:deleted.md");
  });

  it("restores onto the chain's own path instead of refusing it", async () => {
    const { restorer, order } = makeRestorer({
      holder: "f1",
      chain: chain({ contentHash: "h1" }),
      bytes: new Uint8Array(1),
    });
    await restorer.restore("f1", "note.md", "h1");
    expect(order).toContain("write:note.md");
  });
});
