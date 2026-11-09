import { describe, expect, it } from "vitest";
import { LocalEventJob } from "./local-event-job";
import type {
  JobPushResult,
  JobVersion,
  LocalEventJobHost,
  LocalEventLists,
  PendingKind,
} from "./local-event-job";

function version(fileId: string, size: number, overrides: Partial<JobVersion> = {}): JobVersion {
  return {
    fileId,
    plainPath: `${fileId}.md`,
    chunkCount: 0,
    reusesStoredContent: true,
    content: new Uint8Array(size),
    ...overrides,
  };
}

interface JobOptions {
  push?: (batch: readonly JobVersion[]) => Promise<readonly JobPushResult[]>;
  maxFiles?: number;
  maxBytes?: number;
  lists?: Partial<LocalEventLists>;
}

/** A job over a recording host, so every settle can be read back by the test. */
function makeJob(options: JobOptions = {}) {
  const pushed: string[][] = [];
  const applied: string[] = [];
  const forgotten: string[] = [];
  const refused: Array<{ fileId: string; kind: PendingKind }> = [];
  const alone: string[] = [];
  let persisted = 0;
  const host: LocalEventJobHost<JobVersion> = {
    contentFor: async (prepared) => prepared.content,
    push: async (batch) => {
      pushed.push(batch.map((prepared) => prepared.fileId));
      return options.push ? options.push(batch) : batch.map(() => ({ status: "ok" }));
    },
    applied: (prepared) => applied.push(prepared.fileId),
    refused: async (prepared, kind) => {
      refused.push({ fileId: prepared.fileId, kind });
    },
    forget: (prepared) => forgotten.push(prepared.fileId),
    sendAlone: async (prepared) => {
      alone.push(prepared.fileId);
    },
    persist: () => {
      persisted += 1;
    },
  };
  const job = new LocalEventJob<JobVersion>(
    host,
    {
      changed: options.lists?.changed ?? [],
      deleted: options.lists?.deleted ?? [],
      renamed: options.lists?.renamed ?? [],
    },
    { maxFiles: options.maxFiles ?? 100, maxBytes: options.maxBytes ?? 8 * 1024 * 1024 },
  );
  return {
    job,
    pushed,
    applied,
    forgotten,
    refused,
    alone,
    persisted: () => persisted,
  };
}

describe("LocalEventJob — batching", () => {
  it("sends one request for a burst of small versions", async () => {
    const { job, pushed, applied } = makeJob();
    for (let i = 0; i < 5; i++) await job.add(version(`f${i}`, 10), "create");
    await job.complete();
    expect(pushed).toEqual([["f0", "f1", "f2", "f3", "f4"]]);
    expect(applied).toEqual(["f0", "f1", "f2", "f3", "f4"]);
  });

  it("bounds a batch by file count", async () => {
    const { job, pushed } = makeJob({ maxFiles: 2 });
    for (let i = 0; i < 5; i++) await job.add(version(`f${i}`, 1), "create");
    await job.complete();
    expect(pushed).toEqual([["f0", "f1"], ["f2", "f3"], ["f4"]]);
  });

  it("bounds a batch by bytes", async () => {
    // 6 + 6 would pass 10, so the second version starts a new batch; 6 + 4 fits exactly.
    const { job, pushed } = makeJob({ maxBytes: 10 });
    await job.add(version("a", 6), "create");
    await job.add(version("b", 6), "create");
    await job.add(version("c", 4), "create");
    await job.complete();
    expect(pushed).toEqual([["a"], ["b", "c"]]);
  });

  it("sends a version over the byte bound alone", async () => {
    const { job, pushed } = makeJob({ maxBytes: 10 });
    await job.add(version("small", 4), "create");
    await job.add(version("big", 11), "create");
    await job.add(version("after", 1), "create");
    await job.complete();
    expect(pushed).toEqual([["small"], ["big"], ["after"]]);
  });

  it("stages a chunked version through its own settle path, not the batch", async () => {
    const { job, pushed, alone } = makeJob();
    await job.add(version("small", 1), "create");
    await job.add(version("big", 10, { chunkCount: 2 }), "create");
    await job.add(version("after", 1), "create");
    await job.complete();
    expect(pushed).toEqual([["small"], ["after"]]);
    expect(alone).toEqual(["big"]);
  });
});

describe("LocalEventJob — settlement", () => {
  it("drops every version of a request that fails, and reports the failure once", async () => {
    const { job, forgotten, applied } = makeJob({
      push: async () => {
        throw new Error("boom");
      },
    });
    await job.add(version("a", 1), "create");
    await job.add(version("b", 1), "create");
    await expect(job.complete()).rejects.toThrow("boom");
    expect(forgotten).toEqual(["a", "b"]);
    expect(applied).toEqual([]);
  });

  it("settles a per-file refusal through the host, with the version's kind", async () => {
    const { job, refused, applied } = makeJob({
      push: async (batch) => batch.map(() => ({ status: "stale_base" })),
    });
    await job.add(version("tracked", 1), "tracked");
    await job.complete();
    expect(refused).toEqual([{ fileId: "tracked", kind: "tracked" }]);
    expect(applied).toEqual([]);
  });

  it("stops sending once the limiter outlasts its waits", async () => {
    const { job, pushed, forgotten } = makeJob({
      maxFiles: 1,
      push: async () => {
        throw { status: 429 };
      },
    });
    await job.add(version("a", 1), "create");
    await job.add(version("b", 1), "create");
    expect(job.rateLimited).toBe(true);
    // A non-Error throw is wrapped: a host's failure path reads `status`/`code`, not a string.
    await expect(job.complete()).rejects.toThrow("local event batch failed");
    expect(pushed).toEqual([["a"]]);
    expect(forgotten).toContain("b");
  });

  it("forgets a prepared version its caller abandons before any request", async () => {
    const { job, forgotten } = makeJob();
    await job.add(version("a", 1), "create");
    job.abandon();
    expect(forgotten).toEqual(["a"]);
  });
});

describe("LocalEventJob — the tombstone ledger", () => {
  it("finds a prepared tombstone by content hash, and takes it back", async () => {
    const { job, pushed } = makeJob();
    job.noteTombstone("a.md", version("a", 0, { content: null }), "h1");
    expect(job.deletedFileIdForHash("h1")).toBe("a");
    expect(job.tombstoneAt("a.md")).toBe("a");
    job.takeBackTombstone("a");
    expect(job.deletedFileIdForHash("h1")).toBeNull();
    expect(job.tombstoneAt("a.md")).toBeNull();
    await job.drainTombstones();
    await job.complete();
    expect(pushed).toEqual([]);
  });

  it("sends the tombstones no create consumed, in arrival order", async () => {
    const { job, pushed, refused } = makeJob({
      push: async (batch) => batch.map(() => ({ status: "stale_base" })),
    });
    job.noteTombstone("a.md", version("a", 0, { content: null }), "ha");
    job.noteTombstone("b.md", version("b", 0, { content: null }), "hb");
    await job.drainTombstones();
    await job.complete();
    expect(pushed).toEqual([["a", "b"]]);
    expect(refused.map((entry) => entry.kind)).toEqual(["delete", "delete"]);
  });

  it("drops a tombstone whose whole request is refused", async () => {
    const { job, forgotten } = makeJob({
      push: async () => {
        throw new Error("offline");
      },
    });
    job.noteTombstone("a.md", version("a", 0, { content: null }), "ha");
    await job.drainTombstones();
    await expect(job.complete()).rejects.toThrow("offline");
    expect(forgotten).toEqual(["a"]);
    expect(job.tombstoneAt("a.md")).toBeNull();
  });

  it("tracks a destination it must retire before a move lands on it", () => {
    const { job } = makeJob();
    job.captureReplacedDestination("dest.md", "chain");
    expect(job.replacedDestination("dest.md")).toBe("chain");
    job.forgetReplacedDestination("dest.md");
    expect(job.replacedDestination("dest.md")).toBeUndefined();
    job.markDeleteConsumed("dest.md");
    expect(job.isDeleteConsumed("dest.md")).toBe(true);
  });
});

describe("LocalEventJob — the change list", () => {
  it("appends a move's destination once", () => {
    const { job } = makeJob({ lists: { changed: ["a.md"] } });
    job.noteChange("a.md");
    job.noteChange("b.md");
    job.noteChange("b.md");
    expect(job.changes).toEqual(["a.md", "b.md"]);
    expect(job.hasPendingChange("b.md")).toBe(true);
  });
});
