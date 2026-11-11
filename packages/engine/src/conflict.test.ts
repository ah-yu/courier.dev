import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionChainEntry } from "@courier/shared";
import type { FileStamp, SyncAdapter } from "./adapter";
import { ConflictResolver, type ConflictResolverOptions } from "./conflict";
import type { ConflictResolvedEvent } from "./engine";
import { NO_SETTINGS_GROUPS, normalizeScope, type SyncScope } from "./sync-scope";

/**
 * The conflict copy is named after the second it was parked at, so the clock has to be a
 * constant for the name to be assertable. Only `Date` is frozen: `setSystemTime` without
 * `useFakeTimers` leaves every scheduler real, and nothing here waits on a timer.
 */
beforeEach(() => {
  vi.setSystemTime(new Date(2026, 1, 14, 10, 15, 30));
});

afterEach(() => {
  vi.useRealTimers();
});

/** A vault scope with the config folder named but every settings group off. */
const vaultScope = normalizeScope({ configDir: ".obsidian" });

/** The same scope with the `app` group on, so `.obsidian/app.json` may conflict. */
const settingsScope: SyncScope = {
  ...vaultScope,
  settingsGroups: { ...NO_SETTINGS_GROUPS, app: true },
};

const settingsPath = ".obsidian/app.json";

/** The three file calls the resolver is allowed to make, over an in-memory vault. */
class FakeConflictAdapter implements Pick<SyncAdapter, "readFile" | "writeFile" | "statFile"> {
  readonly files = new Map<string, Uint8Array>();
  readonly writes: Array<{ path: string; bytes: Uint8Array }> = [];

  readFile = vi.fn(
    async (path: string): Promise<Uint8Array | null> => this.files.get(path) ?? null,
  );

  statFile = vi.fn(async (path: string): Promise<FileStamp | null> => {
    const bytes = this.files.get(path);
    // `park` only asks whether the candidate name is taken; a real adapter also answers
    // a size and an mtime, which no conflict copy rule reads.
    return bytes === undefined ? null : { sizeBytes: bytes.byteLength, mtimeMs: 0 };
  });

  writeFile = vi.fn(async (path: string, bytes: Uint8Array): Promise<void> => {
    this.files.set(path, bytes);
    this.writes.push({ path, bytes });
  });
}

/** One remote version, with the fields each rule reads filled in. */
function version(overrides: Partial<VersionChainEntry> = {}): VersionChainEntry {
  return {
    versionId: "v1",
    contentHash: "hash-1",
    encryptedPath: "encrypted-path",
    action: "modify",
    sizeBytes: 0,
    mtimeMs: 0,
    createdAt: "2026-02-14T00:00:00.000Z",
    ...overrides,
  };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * A resolver over the five seams the engine injects and a fake filesystem.
 *
 * The seams are `vi.fn`s so the test can read both the arguments and the order they were
 * called in — the two rules this file exists for (read before apply, and re-decide after
 * a refusal) are about order and arguments, not only about the return value.
 */
function makeResolver(scope: SyncScope = vaultScope) {
  const adapter = new FakeConflictAdapter();
  const events: ConflictResolvedEvent[] = [];
  const applyRemote = vi.fn<ConflictResolverOptions["applyRemote"]>(async () => true);
  const push = vi.fn<ConflictResolverOptions["push"]>(async () => {});
  const withinSizeCap = vi.fn<ConflictResolverOptions["withinSizeCap"]>(async () => true);
  const readLocal = vi.fn<ConflictResolverOptions["readLocal"]>(async () => null);
  const refusalChain = vi.fn<ConflictResolverOptions["refusalChain"]>(() => null);
  const resolver = new ConflictResolver({
    scope,
    adapter,
    applyRemote,
    push,
    withinSizeCap,
    readLocal,
    refusalChain,
    onConflictResolved: (event) => events.push(event),
  });
  return { resolver, adapter, events, applyRemote, push, withinSizeCap, readLocal, refusalChain };
}

describe("ConflictResolver — guards", () => {
  it("answers true when there is no remote head, and touches nothing", async () => {
    const h = makeResolver();

    await expect(h.resolver.resolve("file-1", "notes/plan.md", undefined, true)).resolves.toBe(
      true,
    );

    expect(h.adapter.readFile).not.toHaveBeenCalled();
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("answers true when there is no plain path, and touches nothing", async () => {
    const h = makeResolver();

    // A chain whose path this device cannot name has nowhere to park a copy and nowhere
    // to apply the head: the caller's decision has nothing to settle here.
    await expect(h.resolver.resolve("file-1", null, version(), true)).resolves.toBe(true);

    expect(h.adapter.readFile).not.toHaveBeenCalled();
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });
});

describe("ConflictResolver — vault paths", () => {
  it("reads the local bytes before applying the head, then parks them beside the file", async () => {
    const h = makeResolver();
    const local = bytesOf("local text");
    h.adapter.files.set("notes/plan.md", local);
    const head = version();

    await expect(h.resolver.resolve("file-1", "notes/plan.md", head, true, "laptop")).resolves.toBe(
      true,
    );

    // The read has to come first: applying the head is the write (or delete) that would
    // destroy the only copy of these bytes.
    expect(h.adapter.readFile).toHaveBeenCalledWith("notes/plan.md");
    expect(h.adapter.readFile.mock.invocationCallOrder[0]!).toBeLessThan(
      h.applyRemote.mock.invocationCallOrder[0]!,
    );
    // A live head holds bytes this device is known to lack, so no hash is offered.
    expect(h.applyRemote).toHaveBeenCalledWith("file-1", "notes/plan.md", head, null, "laptop");

    const parked = "notes/plan-2026-02-14-101530.conflict.md";
    expect(h.adapter.statFile).toHaveBeenCalledWith(parked);
    // A raw adapter write, not the engine's push path: the copy is never re-synced.
    expect(h.adapter.writeFile).toHaveBeenCalledWith(parked, local);
    expect(h.adapter.writes).toEqual([{ path: parked, bytes: local }]);
    expect(h.events).toEqual([
      {
        fileId: "file-1",
        plainPath: "notes/plan.md",
        conflictPath: parked,
        remoteAction: "write",
      },
    ]);
  });

  it("applies the head with nothing parked when the local file is gone", async () => {
    const h = makeResolver();
    const head = version();

    await expect(h.resolver.resolve("file-1", "notes/plan.md", head, false)).resolves.toBe(true);

    // Nothing local exists to keep, so there is no copy — the file comes back. The read is
    // how the resolver confirms that itself instead of trusting the caller's `localExists`
    // hint, which can be one await stale (a note recreated in between is the only copy).
    expect(h.adapter.readFile).toHaveBeenCalledTimes(1);
    expect(h.adapter.statFile).not.toHaveBeenCalled();
    expect(h.adapter.writeFile).not.toHaveBeenCalled();
    expect(h.applyRemote).toHaveBeenCalledWith("file-1", "notes/plan.md", head, null, null);
    // The event still fires: `conflictPath: null` is the "nothing to keep" shape the CLI
    // words as "adopted", and it is how the host learns what the remote side did.
    expect(h.events).toEqual([
      {
        fileId: "file-1",
        plainPath: "notes/plan.md",
        conflictPath: null,
        remoteAction: "write",
      },
    ]);
  });

  it("treats a local file that vanished before the read as settled, without applying", async () => {
    const h = makeResolver();
    // The listing said the path existed; by the time the resolver read it, it did not.
    h.adapter.readFile.mockResolvedValue(null);

    await expect(h.resolver.resolve("file-1", "notes/plan.md", version(), true)).resolves.toBe(
      true,
    );

    // Nothing to park and nothing to overwrite: the next pass decides from what it finds.
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.adapter.statFile).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("answers false and parks nothing when the head cannot be applied", async () => {
    const h = makeResolver();
    h.adapter.files.set("notes/plan.md", bytesOf("local text"));
    h.applyRemote.mockResolvedValue(false);

    await expect(h.resolver.resolve("file-1", "notes/plan.md", version(), true)).resolves.toBe(
      false,
    );

    // A copy announced before the apply would tell the user their text is safe while the
    // note still holds it (and one more copy would be parked on every retry).
    expect(h.adapter.statFile).not.toHaveBeenCalled();
    expect(h.adapter.writeFile).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("parks under the next free name when the first name is taken", async () => {
    const h = makeResolver();
    const first = "notes/plan-2026-02-14-101530.conflict.md";
    h.adapter.files.set(first, bytesOf("an earlier conflict"));
    h.adapter.files.set("notes/plan.md", bytesOf("local text"));

    await expect(h.resolver.resolve("file-1", "notes/plan.md", version(), true)).resolves.toBe(
      true,
    );

    // `park` starts at index 1, which `conflictFilePath` renders without a counter, so
    // the second name is `-2` — a parked copy never overwrites the earlier one.
    const second = "notes/plan-2026-02-14-101530-2.conflict.md";
    expect(h.adapter.statFile.mock.calls.map(([path]) => path)).toEqual([first, second]);
    expect(h.adapter.writes.map((write) => write.path)).toEqual([second]);
    expect(h.events[0]?.conflictPath).toBe(second);
  });
});

describe("ConflictResolver — config-folder paths", () => {
  /** The local settings file, its stamp, and the shape every config case starts from. */
  function configConflict(localMtimeMs: number) {
    const h = makeResolver(settingsScope);
    const bytes = bytesOf('{"theme":"moonstone"}');
    const stamp: FileStamp = { sizeBytes: bytes.byteLength, mtimeMs: localMtimeMs };
    h.readLocal.mockResolvedValue({ bytes, stamp });
    return { h, bytes, stamp };
  }

  it("pushes the newer local file over the head, silently and with no copy", async () => {
    const { h, bytes, stamp } = configConflict(2_000);

    await expect(
      h.resolver.resolve("file-1", settingsPath, version({ mtimeMs: 1_000 }), true),
    ).resolves.toBe(true);

    // The local half of the size cap is asked before the read, like every other push.
    expect(h.withinSizeCap).toHaveBeenCalledWith(settingsPath);
    expect(h.readLocal).toHaveBeenCalledWith(settingsPath);
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.push).toHaveBeenCalledWith({
      fileId: "file-1",
      plainPath: settingsPath,
      action: "modify",
      bytes,
      baseVersionId: "v1",
      stamp,
    });
    // A copy here would sit outside Obsidian's file index; there is no one to show it to.
    expect(h.adapter.statFile).not.toHaveBeenCalled();
    expect(h.adapter.writeFile).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("applies the head when the remote side is newer, silently and with no copy", async () => {
    const { h } = configConflict(2_000);
    const head = version({ mtimeMs: 3_000 });

    await expect(h.resolver.resolve("file-1", settingsPath, head, true)).resolves.toBe(true);

    expect(h.applyRemote).toHaveBeenCalledWith("file-1", settingsPath, head, null, null);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.adapter.statFile).not.toHaveBeenCalled();
    expect(h.adapter.writeFile).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("resolves an equal modification time to the remote side, silently", async () => {
    const { h } = configConflict(2_000);
    const head = version({ mtimeMs: 2_000 });

    await expect(h.resolver.resolve("file-1", settingsPath, head, true)).resolves.toBe(true);

    // Both devices apply the same tie rule, so they converge instead of pushing past
    // each other on every pass.
    expect(h.applyRemote).toHaveBeenCalledWith("file-1", settingsPath, head, null, null);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("pushes a restore when a newer local file follows a delete head", async () => {
    const { h, bytes, stamp } = configConflict(2_000);
    const head = version({ action: "delete", mtimeMs: 1_000 });

    await expect(h.resolver.resolve("file-1", settingsPath, head, true)).resolves.toBe(true);

    // A live version after a tombstone is the recycle bin's own action, on the same chain.
    expect(h.push).toHaveBeenCalledWith({
      fileId: "file-1",
      plainPath: settingsPath,
      action: "restore",
      bytes,
      baseVersionId: head.versionId,
      stamp,
    });
    expect(h.events).toEqual([]);
  });

  it("answers true without reading when the file is over the size cap", async () => {
    const h = makeResolver(settingsScope);
    h.withinSizeCap.mockResolvedValue(false);

    await expect(h.resolver.resolve("file-1", settingsPath, version(), true)).resolves.toBe(true);

    // The hash and the encryption read the whole file into memory, so the cap is asked
    // before the bytes are touched; the skip is reported by the engine, not here.
    expect(h.readLocal).not.toHaveBeenCalled();
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("answers true when the local file vanished between the listing and the read", async () => {
    const h = makeResolver(settingsScope);
    h.readLocal.mockResolvedValue(null);

    await expect(h.resolver.resolve("file-1", settingsPath, version(), true)).resolves.toBe(true);

    // There is no stamp to compare: the next settings pass decides from what it finds.
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.push).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });
});

describe("ConflictResolver — refusals", () => {
  function refusedConflict() {
    const h = makeResolver(settingsScope);
    const bytes = bytesOf('{"theme":"moonstone"}');
    const stamp: FileStamp = { sizeBytes: bytes.byteLength, mtimeMs: 2_000 };
    h.readLocal.mockResolvedValue({ bytes, stamp });
    return { h, bytes, stamp };
  }

  it("re-decides once from the fresh chain, naming the fresh version as the base", async () => {
    const { h, bytes, stamp } = refusedConflict();
    const head = version({ versionId: "v1", mtimeMs: 1_000 });
    const fresh = version({ versionId: "v2", mtimeMs: 1_500 });
    const refusal = new Error("stale base");
    // A peer's push landed between the decision and this device's push.
    h.push.mockRejectedValueOnce(refusal).mockResolvedValueOnce(undefined);
    h.refusalChain.mockReturnValueOnce([head, fresh]);

    await expect(h.resolver.resolve("file-1", settingsPath, head, true)).resolves.toBe(true);

    expect(h.refusalChain).toHaveBeenCalledWith(refusal);
    // The new head is older than the local stamp, so the local side wins again — but
    // against the chain the server just showed us.
    expect(h.push).toHaveBeenCalledTimes(2);
    expect(h.push.mock.calls[0]?.[0].baseVersionId).toBe("v1");
    expect(h.push.mock.calls[1]?.[0]).toEqual({
      fileId: "file-1",
      plainPath: settingsPath,
      action: "modify",
      bytes,
      baseVersionId: "v2",
      stamp,
    });
    expect(h.applyRemote).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it("answers true when the fresh decision is refused too", async () => {
    const { h } = refusedConflict();
    const head = version({ versionId: "v1", mtimeMs: 1_000 });
    const fresh = version({ versionId: "v2", mtimeMs: 1_500 });
    h.push.mockRejectedValue(new Error("stale base"));
    h.refusalChain.mockReturnValue([head, fresh]);

    await expect(h.resolver.resolve("file-1", settingsPath, head, true)).resolves.toBe(true);

    // A third party keeps pushing. Nothing was written and nothing was lost, so this is
    // contention rather than failure: the next settings pass decides again.
    expect(h.push).toHaveBeenCalledTimes(2);
    expect(h.events).toEqual([]);
  });

  it("answers false when the push failed for a reason other than a stale base", async () => {
    const { h } = refusedConflict();
    h.push.mockRejectedValue(new Error("network down"));
    h.refusalChain.mockReturnValue(null);

    await expect(
      h.resolver.resolve("file-1", settingsPath, version({ mtimeMs: 1_000 }), true),
    ).resolves.toBe(false);

    // The caller reports this instead of assuming the conflict was settled.
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([]);
  });
});
