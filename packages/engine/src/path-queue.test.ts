import { describe, expect, it } from "vitest";
import { PathQueue } from "./path-queue";

/** A promise that resolves when `open` is called. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Let the queue's microtasks (and any timers a job schedules) run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("PathQueue", () => {
  it("runs jobs on one path one at a time, in order", async () => {
    const queue = new PathQueue();
    const events: string[] = [];
    const first = gate();

    const a = queue.run(["n.md"], async () => {
      events.push("a:start");
      await first.promise;
      events.push("a:end");
    });
    const b = queue.run(["n.md"], async () => {
      events.push("b");
    });

    await settle();
    expect(events).toEqual(["a:start"]);

    first.open();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b"]);
  });

  it("runs jobs on different paths at the same time", async () => {
    const queue = new PathQueue();
    const held = gate();
    const events: string[] = [];

    const a = queue.run(["a.md"], async () => {
      await held.promise;
      events.push("a");
    });
    const b = queue.run(["b.md"], async () => {
      events.push("b");
    });

    // b does not wait for a: different paths.
    await b;
    expect(events).toEqual(["b"]);

    held.open();
    await a;
    expect(events).toEqual(["b", "a"]);
  });

  it("waits for every path a multi-path job names", async () => {
    const queue = new PathQueue();
    const held = gate();
    const order: string[] = [];

    const a = queue.run(["a.md"], async () => {
      await held.promise;
      order.push("a");
    });
    const ab = queue.run(["a.md", "b.md"], async () => {
      order.push("ab");
    });
    const b = queue.run(["b.md"], async () => {
      order.push("b");
    });

    await settle();
    expect(order).toEqual([]);

    held.open();
    await Promise.all([a, ab, b]);
    // a was already running; ab waited for a (and for b's queue, empty at the time);
    // b was queued after ab, so it waits for ab.
    expect(order).toEqual(["a", "ab", "b"]);
  });

  it("releases a path when its job fails, and fails only that caller", async () => {
    const queue = new PathQueue();
    const failed = queue.run(["n.md"], async () => {
      throw new Error("boom");
    });

    await expect(failed).rejects.toThrow("boom");
    await expect(queue.run(["n.md"], async () => "ok")).resolves.toBe("ok");
  });

  it("drops a path once its last job settles", async () => {
    const queue = new PathQueue();
    expect(queue.size).toBe(0);

    const job = queue.run(["a.md", "b.md"], async () => {});
    expect(queue.size).toBe(2);

    await job;
    await settle();
    expect(queue.size).toBe(0);
  });

  it("reports a job queued behind the one running", async () => {
    const queue = new PathQueue();
    const held = gate();
    let queuedBehind: boolean | null = null;

    const a = queue.run(["n.md"], async () => {
      await held.promise;
      queuedBehind = queue.hasQueued("n.md");
    });
    await settle();
    // a is running; nothing is behind it yet.
    expect(queue.hasQueued("n.md")).toBe(false);

    const b = queue.run(["n.md"], async () => {});
    expect(queue.hasQueued("n.md")).toBe(true);

    held.open();
    await Promise.all([a, b]);
    expect(queuedBehind).toBe(true);
    await settle();
    expect(queue.hasQueued("n.md")).toBe(false);
  });
});
