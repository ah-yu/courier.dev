import { describe, expect, it } from "vitest";
import type { VersionChainEntry } from "@courier/shared";
import type { FileStamp } from "./adapter";
import { weightForSize, type OpQueueLimits } from "./op-queue";
import {
  chainPaths,
  listedStampPath,
  orderedFileIds,
  prefetchCandidatesForBurst,
  prefetchCandidatesForPass,
  weightOfFile,
  type PassView,
} from "./pass-view";
import { priorityRanks } from "./priority";
import { RemoteIndex } from "./remote-index";
import type { LocalVersionState } from "./state";

/**
 * The pass geometry: where a chain lives, which path actually carries a stamp, the order
 * a pass works in, the weight one file's operation holds and the versions the read-ahead
 * should fetch.
 *
 * The functions are pure, so there is no adapter here. The `PassView` is built over a
 * **real** `RemoteIndex` — the object a pass passes in — rather than a cast, so the path
 * answers are the index's own.
 */

type StateEntry = LocalVersionState[string];

interface ChainFixture {
  /** Where the server records this chain, or null when the index does not know it. */
  recordedPath: string | null;
  /** Oldest → newest. */
  versions: VersionChainEntry[];
}

/** One version, with only the fields the pass functions read spelled out per case. */
function version(
  versionId: string,
  contentHash: string,
  overrides: Partial<VersionChainEntry> = {},
): VersionChainEntry {
  return {
    versionId,
    contentHash,
    encryptedPath: "cGF0aA==",
    action: "modify",
    sizeBytes: 1,
    mtimeMs: 1,
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A pass view over a real index, plus the local stamps and ranks a case states. */
function passView(
  chains: Record<string, ChainFixture>,
  overrides: {
    localStamps?: ReadonlyMap<string, FileStamp>;
    priority?: ReadonlyMap<string, number>;
  } = {},
): PassView {
  const remote = new RemoteIndex();
  const chainByFileId = new Map<string, readonly VersionChainEntry[]>();
  for (const [fileId, fixture] of Object.entries(chains)) {
    chainByFileId.set(fileId, fixture.versions);
    const head = fixture.versions[fixture.versions.length - 1];
    if (head !== undefined && fixture.recordedPath !== null) {
      remote.remember(fileId, head, fixture.recordedPath);
    }
  }
  return {
    remote,
    chainByFileId,
    localStamps: overrides.localStamps ?? new Map<string, FileStamp>(),
    priority: overrides.priority ?? new Map<string, number>(),
  };
}

function trackedState(plainPath: string, overrides: Partial<StateEntry> = {}): StateEntry {
  return { lastKnownVersionId: null, lastKnownContentHash: null, plainPath, ...overrides };
}

function stamp(sizeBytes: number, mtimeMs = 1): FileStamp {
  return { sizeBytes, mtimeMs };
}

/** A scope predicate: only notes are this device's to sync. */
const syncable = (path: string): boolean => path.startsWith("notes/");

describe("chainPaths", () => {
  it("uses the state's own path when the remote index records none", () => {
    const view = passView({ f1: { recordedPath: null, versions: [version("v1", "h1")] } });

    expect(chainPaths("f1", view, { f1: trackedState("notes/a.md") })).toEqual({
      plainPath: "notes/a.md",
      recordedPath: "notes/a.md",
      claimed: ["notes/a.md"],
    });
  });

  it("falls back to the recorded path when this device has no state entry", () => {
    // A chain this device only knows remotely: the server's path is the only one there is.
    const view = passView({
      f1: { recordedPath: "notes/peer.md", versions: [version("v1", "h1")] },
    });

    expect(chainPaths("f1", view, {})).toEqual({
      plainPath: "notes/peer.md",
      recordedPath: "notes/peer.md",
      claimed: ["notes/peer.md"],
    });
  });

  it("prefers the state's path and claims both while a peer's move is in flight", () => {
    // The server already records the new path, while the file — and this device's mapping —
    // is still at the old one. Both have to be claimed: a task may read either one.
    const view = passView({
      f1: { recordedPath: "notes/new.md", versions: [version("v1", "h1")] },
    });

    expect(chainPaths("f1", view, { f1: trackedState("notes/old.md") })).toEqual({
      plainPath: "notes/old.md",
      recordedPath: "notes/new.md",
      claimed: ["notes/old.md", "notes/new.md"],
    });
  });
});

describe("listedStampPath", () => {
  it("answers the plain path when this pass listed it", () => {
    // Both paths have a stamp, which is the interesting case: the state path wins.
    const stamps = new Map([
      ["notes/old.md", stamp(10)],
      ["notes/new.md", stamp(20)],
    ]);

    expect(listedStampPath("notes/old.md", "notes/new.md", stamps)).toBe("notes/old.md");
  });

  it("answers the recorded path when only that one was listed", () => {
    // The vault already applied a peer's move: the state's plainPath is stale and carries
    // no stamp, while the file this pass listed sits at the recorded path.
    const stamps = new Map([["notes/new.md", stamp(10)]]);

    expect(listedStampPath("notes/old.md", "notes/new.md", stamps)).toBe("notes/new.md");
  });

  it("answers null when neither path was listed", () => {
    expect(listedStampPath("notes/old.md", "notes/new.md", new Map())).toBeNull();
  });
});

describe("orderedFileIds", () => {
  it("orders by the user's priority ranks", () => {
    const view = passView(
      {
        a: { recordedPath: "a.md", versions: [version("v1", "h1")] },
        b: { recordedPath: "b.md", versions: [version("v1", "h2")] },
        c: { recordedPath: "c.md", versions: [version("v1", "h3")] },
      },
      { priority: priorityRanks(["b.md", "a.md"]) },
    );

    expect(orderedFileIds(["a", "b", "c"], view, {})).toEqual(["b", "a", "c"]);
  });

  it("puts a locally tracked chain before a remote-only one at the same rank", () => {
    // A peer's move can leave two chains naming one path for a moment. The chain whose
    // file is on disk has to settle the path first, so it goes first even when it comes
    // later in the pass's own list.
    const head = version("v1", "h1", { mtimeMs: 5_000 });
    const view = passView(
      {
        remote: { recordedPath: "same.md", versions: [head] },
        tracked: { recordedPath: "same.md", versions: [head] },
      },
      { priority: priorityRanks(["same.md"]) },
    );
    const state: LocalVersionState = { tracked: trackedState("same.md") };

    expect(orderedFileIds(["remote", "tracked"], view, state)).toEqual(["tracked", "remote"]);
  });

  it("keeps the pass's own order when rank and time do not distinguish two files", () => {
    const view = passView({
      first: { recordedPath: "first.md", versions: [version("v1", "h1")] },
      second: { recordedPath: "second.md", versions: [version("v1", "h2")] },
    });

    expect(orderedFileIds(["second", "first"], view, {})).toEqual(["second", "first"]);
  });
});

describe("weightOfFile", () => {
  const limits: OpQueueLimits = { maxConcurrent: 4, exclusiveBytes: 1_024 };

  it("takes the larger of the head's size and the local stamp's size", () => {
    const view = passView(
      {
        headHeavy: {
          recordedPath: "head-heavy.md",
          versions: [version("v1", "h1", { sizeBytes: 4_096 })],
        },
        stampHeavy: {
          recordedPath: "stamp-heavy.md",
          versions: [version("v1", "h2", { sizeBytes: 16 })],
        },
      },
      {
        localStamps: new Map([
          ["head-heavy.md", stamp(16)],
          ["stamp-heavy.md", stamp(4_096)],
        ]),
      },
    );
    const state: LocalVersionState = {
      headHeavy: trackedState("head-heavy.md"),
      stampHeavy: trackedState("stamp-heavy.md"),
    };

    expect(weightOfFile("headHeavy", view, state, limits)).toBe(weightForSize(limits, 4_096));
    // A head-only measure would call this one small: only the local payload is large.
    expect(weightOfFile("stampHeavy", view, state, limits)).toBe(weightForSize(limits, 4_096));
  });

  it("weighs a chain with no known size as the smallest weight, not as exclusive", () => {
    // A state entry the pass holds no chain for, with no stamp: neither side knows a size.
    // `weightOfFile` measures 0, not null, so this is `weightForSize`'s small weight — the
    // `null` → exclusive rule is for a caller that cannot measure at all.
    const view = passView({});
    const state: LocalVersionState = { f1: trackedState("notes/a.md") };

    expect(weightForSize(limits, 0)).toBe("small");
    expect(weightOfFile("f1", view, state, limits)).toBe(weightForSize(limits, 0));
  });
});

describe("prefetchCandidatesForPass", () => {
  it("names each live head's content in the loop's order", () => {
    const view = passView(
      {
        f1: { recordedPath: "notes/b.md", versions: [version("v1", "h1", { sizeBytes: 10 })] },
        f2: { recordedPath: "notes/a.md", versions: [version("v1", "h2", { sizeBytes: 20 })] },
      },
      {
        localStamps: new Map([
          ["notes/b.md", stamp(10)],
          ["notes/a.md", stamp(20)],
        ]),
      },
    );
    const state: LocalVersionState = {
      f1: trackedState("notes/b.md"),
      f2: trackedState("notes/a.md"),
    };

    expect(
      prefetchCandidatesForPass(["f2", "f1"], view, state, new Map<string, string>(), syncable),
    ).toEqual([
      { contentHash: "h2", sizeBytes: 20 },
      { contentHash: "h1", sizeBytes: 10 },
    ]);
  });

  it("skips a head whose last action is a delete", () => {
    const view = passView({
      gone: {
        recordedPath: null,
        versions: [
          version("v1", "h1", { sizeBytes: 10 }),
          version("v2", "h-empty", { action: "delete", sizeBytes: 0 }),
        ],
      },
      live: { recordedPath: "notes/a.md", versions: [version("v1", "h2", { sizeBytes: 5 })] },
    });
    const state: LocalVersionState = {
      gone: trackedState("notes/gone.md"),
      live: trackedState("notes/a.md"),
    };

    expect(
      prefetchCandidatesForPass(["gone", "live"], view, state, new Map<string, string>(), syncable),
    ).toEqual([{ contentHash: "h2", sizeBytes: 5 }]);
  });

  it("skips a head whose content this pass already holds", () => {
    // A converged file is in the scan's hashes, so there is nothing to download. The pass
    // reads that scan rather than the state's versionId: a peer's revert to older content
    // is still a pull, and still worth reading ahead.
    const view = passView({
      held: { recordedPath: "notes/a.md", versions: [version("v1", "h1", { sizeBytes: 10 })] },
      live: { recordedPath: "notes/b.md", versions: [version("v1", "h2", { sizeBytes: 20 })] },
    });
    const state: LocalVersionState = {
      held: trackedState("notes/a.md", {
        lastKnownVersionId: "v1",
        lastKnownContentHash: "h1",
      }),
      live: trackedState("notes/b.md"),
    };

    expect(
      prefetchCandidatesForPass(
        ["held", "live"],
        view,
        state,
        new Map([["notes/a.md", "h1"]]),
        syncable,
      ),
    ).toEqual([{ contentHash: "h2", sizeBytes: 20 }]);
  });

  it("skips a path the scope predicate rejects", () => {
    const view = passView({
      private: { recordedPath: "private/a.md", versions: [version("v1", "h1")] },
      live: { recordedPath: "notes/a.md", versions: [version("v1", "h2")] },
    });
    const state: LocalVersionState = {
      private: trackedState("private/a.md"),
      live: trackedState("notes/a.md"),
    };

    expect(
      prefetchCandidatesForPass(
        ["private", "live"],
        view,
        state,
        new Map<string, string>(),
        syncable,
      ),
    ).toEqual([{ contentHash: "h2", sizeBytes: 1 }]);
  });
});

describe("prefetchCandidatesForBurst", () => {
  it("names each live head in the batch's own order", () => {
    const chains = new Map<string, readonly VersionChainEntry[]>([
      ["f2", [version("v2", "h2", { sizeBytes: 20 })]],
      ["f1", [version("v1", "h1", { sizeBytes: 10 })]],
    ]);
    const applyPaths = new Map<string, string | null>([
      ["f2", "notes/b.md"],
      ["f1", "notes/a.md"],
    ]);

    expect(prefetchCandidatesForBurst(chains, applyPaths, {}, () => true)).toEqual([
      { contentHash: "h2", sizeBytes: 20 },
      { contentHash: "h1", sizeBytes: 10 },
    ]);
  });

  it("skips a head whose last action is a delete", () => {
    const chains = new Map<string, readonly VersionChainEntry[]>([
      ["gone", [version("v2", "h-empty", { action: "delete", sizeBytes: 0 })]],
      ["live", [version("v1", "h1", { sizeBytes: 10 })]],
    ]);
    const applyPaths = new Map<string, string | null>([
      ["gone", "notes/gone.md"],
      ["live", "notes/a.md"],
    ]);

    expect(prefetchCandidatesForBurst(chains, applyPaths, {}, () => true)).toEqual([
      { contentHash: "h1", sizeBytes: 10 },
    ]);
  });

  it("skips the head that is this device's own sync point", () => {
    // The head being the sync point is the one case that cannot pull — unlike the content
    // hash, which a peer can revert to with a newer version.
    const chains = new Map<string, readonly VersionChainEntry[]>([
      ["mine", [version("v1", "h1", { sizeBytes: 10 })]],
      ["theirs", [version("v2", "h2", { sizeBytes: 20 })]],
    ]);
    const applyPaths = new Map<string, string | null>([
      ["mine", "notes/a.md"],
      ["theirs", "notes/b.md"],
    ]);
    const state: LocalVersionState = {
      mine: trackedState("notes/a.md", {
        lastKnownVersionId: "v1",
        lastKnownContentHash: "h1",
      }),
    };

    expect(prefetchCandidatesForBurst(chains, applyPaths, state, () => true)).toEqual([
      { contentHash: "h2", sizeBytes: 20 },
    ]);
  });

  it("skips a chain with no apply path, stated as null or absent", () => {
    // The apply decides on the state's path when it tracks the chain, otherwise the head's
    // recorded path. No path at all means nothing can be applied, so nothing is read ahead.
    const chains = new Map<string, readonly VersionChainEntry[]>([
      ["nullPath", [version("v1", "h1")]],
      ["absentPath", [version("v2", "h2")]],
      ["live", [version("v3", "h3")]],
    ]);
    const applyPaths = new Map<string, string | null>([
      ["nullPath", null],
      ["live", "notes/a.md"],
    ]);

    expect(prefetchCandidatesForBurst(chains, applyPaths, {}, () => true)).toEqual([
      { contentHash: "h3", sizeBytes: 1 },
    ]);
  });

  it("skips an apply path the scope predicate rejects", () => {
    const chains = new Map<string, readonly VersionChainEntry[]>([
      ["hidden", [version("v1", "h1")]],
      ["live", [version("v2", "h2")]],
    ]);
    const applyPaths = new Map<string, string | null>([
      ["hidden", "private/a.md"],
      ["live", "notes/a.md"],
    ]);

    expect(prefetchCandidatesForBurst(chains, applyPaths, {}, syncable)).toEqual([
      { contentHash: "h2", sizeBytes: 1 },
    ]);
  });
});
