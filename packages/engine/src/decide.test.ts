import { describe, expect, it } from "vitest";
import {
  adoptsOwnTombstone,
  decideFile,
  decideInputFrom,
  decideNewLocalFile,
  decideRefusedPush,
  isLocalDeletion,
  needsFreshRead,
} from "./decide";
import type { DecideContext, RemoteOwner, TombstoneHandling } from "./decide";
import type { VersionChainEntry } from "@courier/shared";

function chain(...entries: Partial<VersionChainEntry>[]): VersionChainEntry[] {
  return entries.map((e, i) => ({
    versionId: `v${i + 1}`,
    contentHash: `h${i + 1}`,
    encryptedPath: `encrypted-path-${i + 1}`,
    action: "modify",
    // The decision is not size-aware: the engine refuses an over-cap chain before it
    // ever reaches `decideFile`.
    sizeBytes: 0,
    // Nor is it aware of modification times: that rule lives in the conflict
    // resolution, not in "what kind of change is this".
    mtimeMs: i + 1,
    createdAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    ...e,
  }));
}

const lastKnown = { versionId: "v1", contentHash: "h1" };

/** `sha256("")` — what a `delete` version records as its content hash. */
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A decision context, with everything filled in for a tracked file that is gone. */
function context(overrides: Partial<DecideContext> = {}): DecideContext {
  return {
    entry: { lastKnownVersionId: "v1", lastKnownContentHash: "h1" },
    localExists: false,
    localContentHash: null,
    remoteChain: chain({ versionId: "v1" }, { versionId: "v2", contentHash: "h2" }),
    tombstone: "apply-remote-delete",
    headPathHasLocalFile: false,
    emptyHash: EMPTY_HASH,
    ...overrides,
  };
}

/**
 * Every input plus the tombstone mode, which defaults to a running client that
 * has never tracked the file — and `localDeletion`, which only the engine can
 * answer (a missing local file is a deletion of ours or a remote file we lack).
 */
function decide(
  input: Omit<
    Parameters<typeof decideFile>[0],
    "tombstone" | "locallyTracked" | "localDeletion"
  > & {
    tombstone?: TombstoneHandling;
    locallyTracked?: boolean;
    localDeletion?: boolean;
  },
) {
  return decideFile({
    tombstone: "apply-remote-delete",
    locallyTracked: false,
    localDeletion: false,
    ...input,
  });
}

describe("decideFile", () => {
  it("pushes a create when the file is untracked remotely", () => {
    expect(
      decide({ localExists: true, localContentHash: "x", lastKnown, remoteChain: [] }),
    ).toEqual({
      action: "push",
      pushAction: "create",
    });
  });

  it("does nothing when both sides are empty", () => {
    expect(
      decide({ localExists: false, localContentHash: null, lastKnown, remoteChain: [] }),
    ).toEqual({ action: "none" });
  });

  it("is synced when on the same point and content matches", () => {
    expect(
      decide({
        localExists: true,
        localContentHash: "h1",
        lastKnown,
        remoteChain: chain({ versionId: "v1", contentHash: "h1" }),
      }),
    ).toEqual({ action: "synced" });
  });

  it("pushes a modify when local changed after the shared point", () => {
    expect(
      decide({
        localExists: true,
        localContentHash: "h2-local",
        lastKnown,
        remoteChain: chain({ versionId: "v1", contentHash: "h1" }),
      }),
    ).toEqual({ action: "push", pushAction: "modify" });
  });

  it("pushes a delete when the local file vanished after the shared point", () => {
    expect(
      decide({
        localExists: false,
        localContentHash: null,
        lastKnown,
        remoteChain: chain({ versionId: "v1", contentHash: "h1" }),
      }),
    ).toEqual({ action: "push", pushAction: "delete" });
  });

  it("pulls when remote advanced and local is untouched", () => {
    expect(
      decide({
        localExists: true,
        localContentHash: "h1",
        lastKnown,
        remoteChain: chain({ versionId: "v1" }, { versionId: "v2", contentHash: "h2" }),
      }),
    ).toEqual({ action: "pull" });
  });

  it("conflicts when both sides changed", () => {
    expect(
      decide({
        localExists: true,
        localContentHash: "h1-local",
        lastKnown,
        remoteChain: chain({ versionId: "v1" }, { versionId: "v2", contentHash: "h2" }),
      }),
    ).toEqual({ action: "conflict" });
  });

  it("pulls when nothing is local and the absence is not this device's deletion", () => {
    expect(
      decide({
        localExists: false,
        localContentHash: null,
        lastKnown: { versionId: null, contentHash: null },
        remoteChain: chain({ versionId: "v1" }, { versionId: "v2", contentHash: "h2" }),
      }),
    ).toEqual({ action: "pull" });
  });

  it("conflicts when the local absence is this device's deletion and the chain moved on", () => {
    // The peer edited the file this device deleted: the chain advanced past the
    // point both sides last agreed on, and there is nothing local to compare — the
    // answer is a conflict, not a pull that would hand the deletion away.
    expect(
      decide({
        localExists: false,
        localContentHash: null,
        lastKnown,
        remoteChain: chain({ versionId: "v1" }, { versionId: "v2", contentHash: "h2" }),
        localDeletion: true,
      }),
    ).toEqual({ action: "conflict" });
  });

  it("still pushes the deletion when the chain has not moved", () => {
    expect(
      decide({
        localExists: false,
        localContentHash: null,
        lastKnown,
        remoteChain: chain({ versionId: "v1" }),
        localDeletion: true,
      }),
    ).toEqual({ action: "push", pushAction: "delete" });
  });

  it("treats the same content as synced even without a shared point", () => {
    expect(
      decide({
        localExists: true,
        localContentHash: "h2",
        lastKnown: { versionId: null, contentHash: null },
        remoteChain: chain({ versionId: "v1" }, { versionId: "v2", contentHash: "h2" }),
      }),
    ).toEqual({ action: "synced" });
  });

  /**
   * A `delete` head means the server holds no live version of this file, and what
   * that implies for a local copy depends on the pass — see `TombstoneHandling`.
   * These cases are the contract behind "connecting a vault whose remote already
   * deleted a note keeps that note", versus "a peer's deletion reaches me".
   */
  describe("a local file under a remote delete", () => {
    const tombstone = chain({ versionId: "v1" }, { action: "delete", versionId: "v2" });

    it("is pushed as a new file while binding the vault", () => {
      expect(
        decide({
          localExists: true,
          localContentHash: "h1",
          lastKnown,
          remoteChain: tombstone,
          tombstone: "bind-merge",
        }),
      ).toEqual({ action: "push", pushAction: "create" });
    });

    it("is pushed as a new file while binding, even with no shared point", () => {
      expect(
        decide({
          localExists: true,
          localContentHash: "edited-locally",
          lastKnown: { versionId: null, contentHash: null },
          remoteChain: tombstone,
          tombstone: "bind-merge",
        }),
      ).toEqual({ action: "push", pushAction: "create" });
    });

    it("applies the deletion while binding when this device already tracked the file", () => {
      // Re-binding must not mint another chain for a file whose tombstone this
      // device already merged: that would push a duplicate on every reconnect.
      expect(
        decide({
          localExists: true,
          localContentHash: "h1",
          lastKnown,
          remoteChain: tombstone,
          tombstone: "bind-merge",
          locallyTracked: true,
        }),
      ).toEqual({ action: "pull" });
    });

    /**
     * A delete version's content hash is the hash of an empty string. A local file
     * that happens to hash the same (an empty note) used to look like "the same
     * content, no shared point" and was reported as synced — the note then
     * silently stayed on one device.
     */
    it("is pushed as a new file while binding when its content matches the delete's empty-string hash", () => {
      const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
      expect(
        decide({
          localExists: true,
          localContentHash: emptyHash,
          lastKnown: { versionId: null, contentHash: null },
          remoteChain: chain({ versionId: "v1", action: "delete", contentHash: emptyHash }),
          tombstone: "bind-merge",
        }),
      ).toEqual({ action: "push", pushAction: "create" });
    });

    it("applies the deletion on a running client when the local copy is unchanged", () => {
      expect(
        decide({
          localExists: true,
          localContentHash: "h1",
          lastKnown,
          remoteChain: tombstone,
        }),
      ).toEqual({ action: "pull" });
    });

    it("conflicts on a running client when the local copy diverged", () => {
      expect(
        decide({
          localExists: true,
          localContentHash: "edited-locally",
          lastKnown,
          remoteChain: tombstone,
        }),
      ).toEqual({ action: "conflict" });
    });

    /**
     * The tombstone can be **this device's own** sync point — it deleted the file
     * and the server accepted that. A file on disk under that point is therefore one
     * the user created afterwards, with no remote content to compete with: a
     * recreate, pushed as a `restore` on the same chain rather than resolved as a
     * conflict (which, under "the remote side wins", would delete the new note).
     */
    it("is a restore when the tombstone is this device's own sync point", () => {
      for (const mode of ["bind-merge", "apply-remote-delete"] as const) {
        expect(
          decide({
            localExists: true,
            localContentHash: "recreated",
            lastKnown: { versionId: "v2", contentHash: "" },
            remoteChain: tombstone,
            tombstone: mode,
            locallyTracked: true,
          }),
        ).toEqual({ action: "push", pushAction: "restore" });
      }
    });

    it("is synced when there is no local copy, whatever the mode", () => {
      for (const mode of ["bind-merge", "apply-remote-delete"] as const) {
        expect(
          decide({
            localExists: false,
            localContentHash: null,
            lastKnown: { versionId: "v2", contentHash: "" },
            remoteChain: tombstone,
            tombstone: mode,
          }),
        ).toEqual({ action: "synced" });
      }
    });
  });
});

/**
 * The merge matrix, one row per comparison the user can hit when a vault is
 * connected (or reconnected) to a remote that already has content. Each row is
 * asserted in both tombstone modes where the mode matters, so the matrix is the
 * contract the higher layers re-check against a real filesystem, a real plugin
 * and a real Obsidian.
 */
describe("decideFile — the merge matrix", () => {
  const remoteLive = chain({ versionId: "v1", contentHash: "h1" });
  const remoteChainSameName = chain({ versionId: "v1" }, { versionId: "v2", contentHash: "h2" });
  const tombstone = chain({ versionId: "v1" }, { action: "delete", versionId: "v2" });
  const fresh = { versionId: null, contentHash: null };
  const BOTH_MODES = ["bind-merge", "apply-remote-delete"] as const;

  it("1. local only — the local file is created on the server, in both modes", () => {
    for (const mode of BOTH_MODES) {
      expect(
        decide({
          localExists: true,
          localContentHash: "h1",
          lastKnown: fresh,
          remoteChain: [],
          tombstone: mode,
        }),
      ).toEqual({ action: "push", pushAction: "create" });
    }
  });

  it("2. remote only — the remote file is pulled, in both modes", () => {
    for (const mode of BOTH_MODES) {
      expect(
        decide({
          localExists: false,
          localContentHash: null,
          lastKnown: fresh,
          remoteChain: remoteLive,
          tombstone: mode,
        }),
      ).toEqual({ action: "pull" });
    }
  });

  it("3. same name, different content — a conflict, in both modes", () => {
    for (const mode of BOTH_MODES) {
      expect(
        decide({
          localExists: true,
          localContentHash: "mine",
          lastKnown: fresh,
          remoteChain: remoteChainSameName,
          tombstone: mode,
        }),
      ).toEqual({ action: "conflict" });
    }
  });

  it("4. same name, same content — converges silently, in both modes", () => {
    for (const mode of BOTH_MODES) {
      expect(
        decide({
          localExists: true,
          localContentHash: "h2",
          lastKnown: fresh,
          remoteChain: remoteChainSameName,
          tombstone: mode,
        }),
      ).toEqual({ action: "synced" });
    }
  });

  it("5. remote tombstone + local file — new file while binding, deletion after", () => {
    const binding = decide({
      localExists: true,
      localContentHash: "h1",
      lastKnown: fresh,
      remoteChain: tombstone,
      tombstone: "bind-merge",
    });
    const running = decide({
      localExists: true,
      localContentHash: "h1",
      lastKnown: fresh,
      remoteChain: tombstone,
      tombstone: "apply-remote-delete",
    });

    expect(binding).toEqual({ action: "push", pushAction: "create" });
    expect(running).toEqual({ action: "pull" });
  });
});

/**
 * `isLocalDeletion` — "is this file's absence *our* deletion, or a remote file we
 * simply do not have?".
 *
 * A mutation run found this function's third rule pinned by nothing: flipping
 * `entry.lastKnownContentHash === emptyHash` to `!==` left the whole engine suite green.
 * The rule is not decorative — a chain whose **own sync point is the tombstone** is one
 * this device deleted and a peer then restored, so the absence is not a deletion of ours
 * and the caller has to pull the restored file instead of resolving a conflict over it.
 * One case per rule, because a rule that only the integration suite happens to exercise
 * is a rule someone will "simplify" away.
 */
describe("isLocalDeletion", () => {
  it("is not a deletion while the file is on disk", () => {
    expect(isLocalDeletion(context({ localExists: true, localContentHash: "h1" }))).toBe(false);
  });

  it("is not a deletion for a chain this device never tracked", () => {
    expect(isLocalDeletion(context({ entry: undefined }))).toBe(false);
  });

  it("is not a deletion without a sync point", () => {
    expect(
      isLocalDeletion(context({ entry: { lastKnownVersionId: null, lastKnownContentHash: null } })),
    ).toBe(false);
  });

  it("is not a deletion when the sync point is itself the tombstone — a peer restored it", () => {
    // The chain moved past a point this device made by deleting: the absence is already
    // on the chain, so a newer live head is a peer restoring the file. Answering `true`
    // here turns that restore into a conflict on this device.
    expect(
      isLocalDeletion(
        context({
          entry: { lastKnownVersionId: "v2", lastKnownContentHash: EMPTY_HASH },
          remoteChain: chain(
            { versionId: "v1", contentHash: "h1" },
            { versionId: "v2", action: "delete", contentHash: EMPTY_HASH },
            { versionId: "v3", contentHash: "h1", action: "restore" },
          ),
        }),
      ),
    ).toBe(false);
  });

  it("is not a deletion when a local file sits at the path the head records", () => {
    // A peer's move this vault already applied: the file is at the new path, so the old
    // path's absence is a move to follow rather than a deletion to report.
    expect(isLocalDeletion(context({ headPathHasLocalFile: true }))).toBe(false);
  });

  it("is a deletion when the file is gone, tracked, and nothing sits at the head's path", () => {
    expect(isLocalDeletion(context())).toBe(true);
  });

  it("reads the empty-string hash from the context, not a constant of its own", () => {
    // The engine computes `sha256("")` once per engine; a caller passing a different
    // value must get that value's verdict, not a hardcoded one.
    expect(
      isLocalDeletion(
        context({
          entry: { lastKnownVersionId: "v2", lastKnownContentHash: "not-empty" },
          emptyHash: "not-empty",
        }),
      ),
    ).toBe(false);
  });
});

/**
 * `decideInputFrom` — the one place a {@link DecideContext} becomes a decision input.
 *
 * A mutation run found it pinned by nothing at all: replacing `context.entry !== undefined`
 * with `true` left the suite green, so nothing asserted that a file the engine has no state
 * entry for is reported as **untracked**. That flag is what makes a bind push a local file
 * under a remote tombstone as a new file instead of applying the deletion to it.
 */
describe("decideInputFrom", () => {
  it("reports a file with no state entry as untracked, with no sync point", () => {
    const input = decideInputFrom(context({ entry: undefined }));

    expect(input.locallyTracked).toBe(false);
    expect(input.lastKnown).toEqual({ versionId: null, contentHash: null });
  });

  it("reports a tracked file as tracked, carrying the point both sides agreed on", () => {
    const input = decideInputFrom(context());

    expect(input.locallyTracked).toBe(true);
    expect(input.lastKnown).toEqual({ versionId: "v1", contentHash: "h1" });
  });

  it("derives localDeletion rather than taking it from a caller", () => {
    expect(decideInputFrom(context()).localDeletion).toBe(true);
    expect(
      decideInputFrom(context({ localExists: true, localContentHash: "h1" })).localDeletion,
    ).toBe(false);
  });

  it("passes the chain and the tombstone mode through unchanged", () => {
    const remoteChain = chain({ versionId: "v9", contentHash: "h9" });
    const input = decideInputFrom(context({ remoteChain, tombstone: "bind-merge" }));

    expect(input.remoteChain).toBe(remoteChain);
    expect(input.tombstone).toBe("bind-merge");
  });
});

describe("decideFile — the edges a mutation run found unasserted", () => {
  it("conflicts instead of throwing when the chain holds nothing but tombstones", () => {
    // Retention pruning can leave a chain whose every version is a `delete`: there is no
    // live version to compare the local content against, and `previous !== undefined` is
    // the guard that keeps that from being a property access on `undefined`. The answer is
    // still a decision — the local copy is not something a tombstone may silently remove.
    const onlyDeletes = chain(
      { versionId: "v1", action: "delete", contentHash: EMPTY_HASH },
      { versionId: "v2", action: "delete", contentHash: EMPTY_HASH },
    );

    expect(
      decide({
        localExists: true,
        localContentHash: "local",
        lastKnown: { versionId: "v1", contentHash: EMPTY_HASH },
        remoteChain: onlyDeletes,
      }),
    ).toEqual({ action: "conflict" });
  });

  it("reads the last live version of a longer chain, not the first", () => {
    // The chain was edited once more before the delete, so the version the tombstone
    // removed is `v2`, not `v1`. A local file still holding `v2` is unchanged and the
    // deletion may simply be applied; reading the *first* live version would compare the
    // file against `v1`, call it a divergence and park a conflict copy of a file the
    // remote never touched.
    expect(
      decide({
        localExists: true,
        localContentHash: "h2",
        lastKnown: { versionId: "v2", contentHash: "h2" },
        remoteChain: chain(
          { versionId: "v1", contentHash: "h1" },
          { versionId: "v2", contentHash: "h2" },
          { versionId: "v3", action: "delete", contentHash: EMPTY_HASH },
        ),
        locallyTracked: true,
      }),
    ).toEqual({ action: "pull" });
  });

  it("converges when the chain moved past our point but the head holds our bytes", () => {
    // Both sides hold the same bytes. This used to be a conflict — "we cannot tell a
    // converged edit from two independent ones" — and the cost was real: a push whose
    // response had not yet updated our sync point, met again by another decision on the
    // same path, parked a copy of the file over itself and reported a conflict nobody
    // had. Identical bytes are not a divergence; the caller records the head as the sync
    // point, which is exactly what it does for a never-synced file with the same content.
    expect(
      decide({
        localExists: true,
        localContentHash: "h3",
        lastKnown,
        remoteChain: chain({ versionId: "v1" }, { versionId: "v2", contentHash: "h3" }),
      }),
    ).toEqual({ action: "synced" });
  });
});

/** A live chain that could own a path or a set of bytes. */
function owner(fileId: string, contentHash: string, versionId = "v9"): RemoteOwner {
  return { fileId, head: chain({ versionId, contentHash })[0] };
}

describe("decideNewLocalFile", () => {
  it("re-points the chain of a delete whose bytes reappear", () => {
    // The delete is the other half of a move: creating a second chain here is what left
    // both `old.md` and `new.md` on disk for one file.
    expect(
      decideNewLocalFile({
        contentHash: "h1",
        deletedFileId: "deleted",
        pathOwner: owner("path-owner", "h1"),
        contentOwner: owner("content-owner", "h1"),
      }),
    ).toEqual({ kind: "rename-on-deleted", fileId: "deleted" });
  });

  it("adopts the live chain the server records at the path, above the content fallback", () => {
    expect(
      decideNewLocalFile({
        contentHash: "h1",
        deletedFileId: null,
        pathOwner: owner("path-owner", "h1"),
        contentOwner: owner("content-owner", "h1"),
      }),
    ).toEqual({ kind: "adopt", owner: owner("path-owner", "h1"), sameContent: true });
  });

  it("calls the adoption a conflict when the bytes are not the head's", () => {
    // Same identity, different content: the move is adopted, but the copy on disk did
    // not travel with it — that is an edit to park, not a rename to push.
    const decision = decideNewLocalFile({
      contentHash: "h1",
      deletedFileId: null,
      pathOwner: owner("path-owner", "h2"),
      contentOwner: null,
    });
    expect(decision.kind).toBe("adopt");
    expect(decision.kind === "adopt" && decision.sameContent).toBe(false);
  });

  it("falls back to the content owner when no chain records the path", () => {
    expect(
      decideNewLocalFile({
        contentHash: "h1",
        deletedFileId: null,
        pathOwner: null,
        contentOwner: owner("content-owner", "h1"),
      }),
    ).toEqual({ kind: "adopt", owner: owner("content-owner", "h1"), sameContent: true });
  });

  it("creates a chain when nothing is known", () => {
    expect(
      decideNewLocalFile({
        contentHash: "h1",
        deletedFileId: null,
        pathOwner: null,
        contentOwner: null,
      }),
    ).toEqual({ kind: "create" });
  });
});

describe("needsFreshRead", () => {
  it("re-reads before a pull taken from the caller's pre-fetched bytes", () => {
    // The chain request between the read and the decision gave the file time to change,
    // and a pull overwrites it.
    expect(needsFreshRead({ action: "pull" }, true)).toBe(true);
  });

  it("re-reads before a conflict or a synced adoption", () => {
    expect(needsFreshRead({ action: "conflict" }, true)).toBe(true);
    expect(needsFreshRead({ action: "synced" }, true)).toBe(true);
  });

  it("lets a push keep the bytes it read", () => {
    // A push sends what it read, and the caller's stamp check already proved the file
    // did not move.
    expect(needsFreshRead({ action: "push", pushAction: "modify" }, true)).toBe(false);
  });

  it("does not re-read bytes that were just read afresh", () => {
    expect(needsFreshRead({ action: "pull" }, false)).toBe(false);
  });
});

describe("decideRefusedPush", () => {
  it("decides again from the refused chain on the first attempt", () => {
    expect(decideRefusedPush(0)).toBe("re-decide");
  });

  it("reports the second refusal instead of looping", () => {
    expect(decideRefusedPush(1)).toBe("report");
  });
});
describe("adoptsOwnTombstone", () => {
  it("adopts the tombstone version the create half captured", () => {
    expect(
      adoptsOwnTombstone({
        headAction: "delete",
        headVersionId: "v1",
        captured: "v1",
        minted: ["v1"],
      }),
    ).toBe(true);
  });

  it("adopts a newer tombstone this chain minted after the capture", () => {
    // The record can be replaced while the create half is deciding, so the head it is
    // refused against is not always the version it carries.
    expect(
      adoptsOwnTombstone({
        headAction: "delete",
        headVersionId: "v2",
        captured: "v1",
        minted: ["v1", "v2"],
      }),
    ).toBe(true);
  });

  it("never adopts a peer's tombstone, nor a live head", () => {
    expect(
      adoptsOwnTombstone({
        headAction: "delete",
        headVersionId: "peer",
        captured: "v1",
        minted: ["v1"],
      }),
    ).toBe(false);
    expect(
      adoptsOwnTombstone({
        headAction: "modify",
        headVersionId: "v1",
        captured: "v1",
        minted: ["v1"],
      }),
    ).toBe(false);
    expect(
      adoptsOwnTombstone({
        headAction: undefined,
        headVersionId: undefined,
        captured: null,
        minted: [],
      }),
    ).toBe(false);
  });
});
