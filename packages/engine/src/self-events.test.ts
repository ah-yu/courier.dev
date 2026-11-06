import { describe, expect, it } from "vitest";
import { SelfEventLog } from "./self-events";

/**
 * The records that let the engine recognise its own events.
 *
 * The clock is injected, so these cases move time instead of freezing a global `Date`
 * (which is what the engine's own tests had to do before this module existed). What
 * matters is that every record is **narrow**: a write matches on content, a rename on
 * its target, and a delete is consumed once — so a genuine user action that lands
 * inside a window is still handled as one.
 */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("SelfEventLog — pushed versions", () => {
  it("suppresses an echo once, and keeps nothing after it", () => {
    const log = new SelfEventLog({ now: fakeClock().now });
    log.rememberPushedVersion("v1");

    expect(log.consumePushedVersion("v1")).toBe(true);
    // Consumed: a second echo for the same id is not suppressed again.
    expect(log.consumePushedVersion("v1")).toBe(false);
    expect(log.consumePushedVersion("other")).toBe(false);
  });

  it("drops a version whose echo never came, once its window closes", () => {
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.rememberPushedVersion("v1");

    clock.advance(10_001);
    // The sweep runs as records are added: without it a host that stays up for weeks
    // accumulates one entry per push (the server never echoes a device its own push).
    log.rememberPushedVersion("v2");

    expect(log.consumePushedVersion("v1")).toBe(false);
    expect(log.consumePushedVersion("v2")).toBe(true);
  });

  it("stops suppressing a push that never landed", () => {
    const log = new SelfEventLog({ now: fakeClock().now });
    log.rememberPushedVersion("v1");
    log.forgetPushedVersion("v1");

    expect(log.consumePushedVersion("v1")).toBe(false);
  });

  it("keeps suppressing an earlier push while a later one is recorded", () => {
    // The sweep drops only what has **expired**. Forgetting every earlier id on each push
    // (or dating the deadline in the past) would let the echo of a push still in flight be
    // applied as a peer's change — the engine would pull its own push back and, if the
    // bytes moved in between, park a conflict over them.
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.rememberPushedVersion("v1");
    clock.advance(1_000);
    log.rememberPushedVersion("v2");

    expect(log.consumePushedVersion("v1")).toBe(true);
    expect(log.consumePushedVersion("v2")).toBe(true);
  });
});

describe("SelfEventLog — self writes", () => {
  it("matches by content hash, so a real edit inside the window is not swallowed", () => {
    const log = new SelfEventLog({ now: fakeClock().now });
    log.recordSelfWrite("notes/a.md", "hash-of-what-we-wrote");

    expect(log.isSelfWrite("notes/a.md", "hash-of-what-we-wrote")).toBe(true);
    expect(log.isSelfWrite("notes/a.md", "hash-of-a-user-edit")).toBe(false);
    expect(log.isSelfWrite("notes/other.md", "hash-of-what-we-wrote")).toBe(false);
  });

  it("keeps matching a second event for the same write (one write, two events)", () => {
    // Obsidian reports a file the engine created as `create` *and* `modify`; consuming
    // the record on the first left the second to be read as a user edit.
    const log = new SelfEventLog({ now: fakeClock().now });
    log.recordSelfWrite("notes/a.md", "h");

    expect(log.isSelfWrite("notes/a.md", "h")).toBe(true);
    expect(log.isSelfWrite("notes/a.md", "h")).toBe(true);
  });

  it("forgets the record once its window closes", () => {
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfWrite("notes/a.md", "h");

    clock.advance(10_001);

    expect(log.isSelfWrite("notes/a.md", "h")).toBe(false);
  });

  it("keeps a live record when another path is written", () => {
    // The sweep must take the expired ones only: a sweep that dropped live records would
    // make the next write of *any* path lose the suppression for this one, and the vault
    // event of our own write would be pushed again as a user edit.
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfWrite("notes/a.md", "ha");
    clock.advance(1_000);
    log.recordSelfWrite("notes/b.md", "hb");

    expect(log.isSelfWrite("notes/a.md", "ha")).toBe(true);
    expect(log.isSelfWrite("notes/b.md", "hb")).toBe(true);
  });

  it("matches a streamed write by its stamp, and stops when the file moves", () => {
    // A streamed pull records the committed file's stamp so the vault event can be
    // recognised without reading the file back. A different size or mtime is a genuine
    // edit (or a different file) and must take the ordinary read-and-hash path.
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfWrite("media/big.mp4", "hash", { sizeBytes: 9, mtimeMs: 123 });

    expect(log.matchesSelfWriteStamp("media/big.mp4", { sizeBytes: 9, mtimeMs: 123 })).toBe(true);
    expect(log.matchesSelfWriteStamp("media/big.mp4", { sizeBytes: 9, mtimeMs: 124 })).toBe(false);
    expect(log.matchesSelfWriteStamp("media/big.mp4", { sizeBytes: 10, mtimeMs: 123 })).toBe(false);
    expect(log.matchesSelfWriteStamp("media/other.mp4", { sizeBytes: 9, mtimeMs: 123 })).toBe(
      false,
    );

    clock.advance(10_001);
    expect(log.matchesSelfWriteStamp("media/big.mp4", { sizeBytes: 9, mtimeMs: 123 })).toBe(false);
  });

  it("does not answer a stamp match for a write recorded without one", () => {
    // The ordinary whole-buffer path has no stamp to trust; it must still match by hash,
    // and must not be mistaken for a streamed write by an unrelated file stamp.
    const log = new SelfEventLog({ now: fakeClock().now });
    log.recordSelfWrite("notes/a.md", "h");

    expect(log.matchesSelfWriteStamp("notes/a.md", { sizeBytes: 1, mtimeMs: 1 })).toBe(false);
    expect(log.isSelfWrite("notes/a.md", "h")).toBe(true);
  });

  it("answers no for a path it never recorded and for a write whose window closed", () => {
    // `hasSelfWrite` is the cheap pre-check: a true here makes the caller skip hashing a
    // large file, so it must not answer true for a path the engine never wrote (the file
    // is a user edit) nor for a record the window already dropped (the engine's own
    // write from long ago).
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfWrite("notes/a.md", "h");

    expect(log.hasSelfWrite("notes/never-written.md")).toBe(false);
    expect(log.hasSelfWrite("notes/a.md")).toBe(true);

    clock.advance(10_001);

    expect(log.hasSelfWrite("notes/a.md")).toBe(false);
  });

  it("drops an expired write when the next one is recorded", () => {
    // The sweep is what bounds the map: a host that stays up accumulates one entry per
    // write it performs, and nothing but a later write ever prunes them. What the caller
    // can observe is that the stale record never answers for the next write's path.
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfWrite("notes/a.md", "ha");
    clock.advance(10_001);

    log.recordSelfWrite("notes/b.md", "hb");

    expect(log.hasSelfWrite("notes/a.md")).toBe(false);
    expect(log.isSelfWrite("notes/a.md", "ha")).toBe(false);
    expect(log.isSelfWrite("notes/b.md", "hb")).toBe(true);
  });
});

describe("SelfEventLog — self deletes", () => {
  it("consumes a delete once, and reports an expired one as not ours", () => {
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfDelete("notes/gone.md");

    expect(log.consumeSelfDelete("notes/gone.md")).toBe(true);
    expect(log.consumeSelfDelete("notes/gone.md")).toBe(false);

    log.recordSelfDelete("notes/gone.md");
    clock.advance(10_001);
    // The record is gone and the delete is treated as a genuine local one, which the
    // next reconcile pushes.
    expect(log.consumeSelfDelete("notes/gone.md")).toBe(false);
  });

  it("keeps a live delete record when another path is deleted", () => {
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfDelete("notes/a.md");
    clock.advance(1_000);
    log.recordSelfDelete("notes/b.md");

    // Losing the first record means applying a peer's delete pushes a second tombstone,
    // and the extra tombstone is what makes the file unrestorable.
    expect(log.consumeSelfDelete("notes/a.md")).toBe(true);
    expect(log.consumeSelfDelete("notes/b.md")).toBe(true);
  });

  it("drops an expired delete when the next one is recorded", () => {
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfDelete("notes/a.md");
    clock.advance(10_001);

    log.recordSelfDelete("notes/b.md");

    expect(log.consumeSelfDelete("notes/a.md")).toBe(false);
    expect(log.consumeSelfDelete("notes/b.md")).toBe(true);
  });
});

describe("SelfEventLog — self renames", () => {
  it("matches the move by its target", () => {
    const log = new SelfEventLog({ now: fakeClock().now });
    log.recordSelfRename("old.md", "new.md");

    expect(log.consumeSelfRename("old.md", "elsewhere.md")).toBe(false);
    // Consumed by the first (non-matching) event, so a genuine move is not swallowed.
    expect(log.consumeSelfRename("old.md", "new.md")).toBe(false);

    log.recordSelfRename("a.md", "b.md");
    expect(log.consumeSelfRename("a.md", "b.md")).toBe(true);
  });

  it("does not match a move whose window has closed", () => {
    // The deadline is checked when the record is read, not only by the sweep: a stale
    // record would swallow a genuine move of the same path as "ours".
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfRename("old.md", "new.md");

    clock.advance(10_001);

    expect(log.consumeSelfRename("old.md", "new.md")).toBe(false);
  });

  it("keeps a live move when another move is recorded", () => {
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfRename("a.md", "b.md");
    clock.advance(1_000);
    log.recordSelfRename("c.md", "d.md");

    expect(log.consumeSelfRename("a.md", "b.md")).toBe(true);
    expect(log.consumeSelfRename("c.md", "d.md")).toBe(true);
  });

  it("drops an expired move when the next one is recorded", () => {
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.recordSelfRename("a.md", "b.md");
    clock.advance(10_001);

    log.recordSelfRename("c.md", "d.md");

    expect(log.consumeSelfRename("a.md", "b.md")).toBe(false);
    expect(log.consumeSelfRename("c.md", "d.md")).toBe(true);
  });
});

describe("SelfEventLog — a delete awaiting a rename", () => {
  it("matches a new file with the same content inside the window", () => {
    const log = new SelfEventLog({ now: fakeClock().now });
    log.rememberDelete("f1", "same-content");

    expect(log.matchDeletedFile("same-content")).toMatchObject({ fileId: "f1" });
    // Consumed: one delete explains one new file.
    expect(log.matchDeletedFile("same-content")).toBeNull();
  });

  it("does not match outside the window, and sweeps the expired record", () => {
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.rememberDelete("f1", "same-content");

    clock.advance(5_001);

    expect(log.matchDeletedFile("same-content")).toBeNull();
  });

  it("ignores a file that merely shares content with a delete from long ago", () => {
    const clock = fakeClock();
    const log = new SelfEventLog({ now: clock.now });
    log.rememberDelete("f1", "shared");

    clock.advance(4_000);
    log.rememberDelete("f2", "other");

    expect(log.matchDeletedFile("shared")).toMatchObject({ fileId: "f1" });
    expect(log.matchDeletedFile("shared")).toBeNull();
  });
});
