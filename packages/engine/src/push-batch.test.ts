import { describe, expect, it, vi } from "vitest";
import {
  PushBatch,
  classifyPushResult,
  type BatchPushResult,
  type BatchVersion,
  type PushBatchHost,
} from "./push-batch";

/**
 * L0 for `PushBatch`: the window itself is real, everything semantic (sending, adopting,
 * refusing, forgetting) is a mock.
 *
 * The engine suites exercise these paths end to end, but they reach the orderings below
 * only through a pass or a burst with a reason to hit them. The three senders depend on
 * this one class for the same guarantees, so they are pinned here.
 */

interface V extends BatchVersion {
  /** The name a test asserts on (`plainPath`). */
  readonly name: string;
}

function version(name: string, size: number, chunkCount = 0): V {
  return {
    fileId: `id-${name}`,
    versionId: `v-${name}`,
    plainPath: name,
    name,
    chunkCount,
    reusesStoredContent: false,
    content: new Uint8Array(size),
  };
}

interface Harness {
  batch: PushBatch<V, string>;
  host: PushBatchHost<V, string>;
  pushed: string[][];
  alone: string[];
  applied: string[];
  forgotten: string[];
  refused: Array<{ name: string; meta: string; status: string }>;
  settled: () => number;
  /** Resolves the request a `controlled` push holds open. */
  release: (results?: readonly BatchPushResult[]) => void;
  /** Rejects the request a `controlled` push holds open. */
  fail: (err: unknown) => void;
}

function makeBatch(
  options: {
    maxFiles?: number;
    maxBytes?: number;
    /** Answer a request; the default answers `ok` for every version. */
    push?: (prepared: readonly V[]) => Promise<readonly BatchPushResult[]>;
    /** Settle a refusal; the default answers `null`. */
    refused?: PushBatchHost<V, string>["refused"];
    /** Hold the **first** request open until {@link Harness.release} or {@link Harness.fail}. */
    controlled?: boolean;
  } = {},
): Harness {
  const pushed: string[][] = [];
  const alone: string[] = [];
  const applied: string[] = [];
  const forgotten: string[] = [];
  const refused: Array<{ name: string; meta: string; status: string }> = [];
  const settled = vi.fn();
  let held: {
    resolve: (results: readonly BatchPushResult[]) => void;
    reject: (err: unknown) => void;
  } | null = null;

  const host: PushBatchHost<V, string> = {
    send: async (prepared) => {
      pushed.push(prepared.map((one) => one.name));
      if (options.push) return await options.push(prepared);
      if (options.controlled && pushed.length === 1) {
        return await new Promise<readonly BatchPushResult[]>((resolve, reject) => {
          held = { resolve, reject };
        });
      }
      return prepared.map(() => ({ status: "ok" }));
    },
    contentFor: async (prepared) => prepared.content,
    sendAlone: async (prepared) => {
      alone.push(prepared.name);
      return null;
    },
    applied: (prepared) => applied.push(prepared.name),
    forget: (prepared) => forgotten.push(prepared.name),
    refused: async (prepared, meta, result) => {
      refused.push({ name: prepared.name, meta, status: result?.status ?? "none" });
      return options.refused ? await options.refused(prepared, meta, result) : null;
    },
    settled,
  };

  return {
    batch: new PushBatch(host, {
      maxFiles: options.maxFiles ?? 100,
      maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
    }),
    host,
    pushed,
    alone,
    applied,
    forgotten,
    refused,
    settled: () => settled.mock.calls.length,
    release: (results = []) => held?.resolve(results),
    fail: (err) => held?.reject(err),
  };
}

describe("PushBatch — the serial mode", () => {
  it("sends at the file bound, applying each answer, and drains the tail", async () => {
    const { batch, pushed, applied } = makeBatch({ maxFiles: 2 });
    await batch.add(version("a", 1), "m");
    await batch.add(version("b", 1), "m");
    // The crossing sends and waits: a serial caller never has a request it has not awaited.
    await batch.add(version("c", 1), "m");
    expect(pushed).toEqual([["a", "b"]]);
    expect(applied).toEqual(["a", "b"]);

    await batch.drain();
    expect(pushed).toEqual([["a", "b"], ["c"]]);
    expect(applied).toEqual(["a", "b", "c"]);
  });

  it("starts a request only when the caller crosses a bound, and drains it on demand", async () => {
    const { batch, pushed } = makeBatch();
    await batch.add(version("a", 1), "m");
    expect(pushed).toEqual([]);
    await batch.drain();
    expect(pushed).toEqual([["a"]]);
  });

  it("sends a version over the byte bound alone, after the queued files have landed", async () => {
    const { batch, pushed, applied } = makeBatch({ maxBytes: 10 });
    await batch.add(version("small", 4), "m");
    await batch.add(version("big", 11), "m");
    expect(pushed).toEqual([["small"], ["big"]]);
    expect(applied).toEqual(["small", "big"]);
  });

  it("reports the first refusal and settles the rest of the request", async () => {
    const { batch, pushed, refused, applied } = makeBatch({
      maxFiles: 2,
      push: async (prepared) =>
        prepared.map((one) => (one.name === "a" ? { status: "quota" } : { status: "ok" })),
      refused: async () => new Error("quota"),
    });
    await batch.add(version("a", 1), "m");
    await batch.add(version("b", 1), "m");
    await batch.drain();
    expect(pushed).toEqual([["a", "b"]]);
    expect(refused).toEqual([{ name: "a", meta: "m", status: "quota" }]);
    // The version after the refused one was answered by the same request: its sync point
    // must still be adopted (leaving it unapplied would read as a deletion next pass).
    expect(applied).toEqual(["b"]);
    expect(batch.failure).toBeInstanceOf(Error);
  });

  it("forgets a refused version before settling it, and records a throwing settlement", async () => {
    const order: string[] = [];
    const { batch, forgotten } = makeBatch({
      maxFiles: 2,
      push: async (prepared) => prepared.map(() => ({ status: "stale_base" })),
      refused: (prepared) => {
        order.push(`refused:${prepared.name}`);
        throw new Error(`settle ${prepared.name}`);
      },
    });
    await batch.add(version("a", 1), "m");
    await batch.add(version("b", 1), "m");
    await batch.drain();
    // Both answers were settled even though the first settlement threw.
    expect(order).toEqual(["refused:a", "refused:b"]);
    expect(forgotten).toEqual(["a", "b"]);
    expect((batch.failure as Error).message).toBe("settle a");
  });

  it("forgets the version whose content cannot be prepared", async () => {
    const { batch, host, forgotten } = makeBatch();
    host.contentFor = async () => {
      throw new Error("encryption failed");
    };
    await expect(batch.add(version("x", 1), "m")).rejects.toThrow("encryption failed");
    expect(forgotten).toEqual(["x"]);
  });
});

describe("PushBatch — the pipelined mode", () => {
  it("waits for the request in flight before starting the next one", async () => {
    const { batch, pushed, settled, release } = makeBatch({ maxFiles: 1, controlled: true });
    await batch.add(version("a", 1), "m", { pipelined: true });
    await batch.add(version("b", 1), "m", { pipelined: true });
    // a is on the wire now, and b is queued behind it.
    expect(pushed).toEqual([["a"]]);
    expect(settled()).toBe(0);

    // c's arrival crosses the bound: it must settle a (still held) before it starts b, so
    // this add cannot resolve yet.
    let crossed = false;
    const addingC = batch.add(version("c", 1), "m", { pipelined: true }).then(() => {
      crossed = true;
    });
    await Promise.resolve();
    expect(crossed).toBe(false);

    release([{ status: "ok" }]);
    await addingC;
    expect(pushed).toEqual([["a"], ["b"]]);
    // b's request settles on its own turn (the harness answers it immediately); what matters
    // is that a was settled before b started.
    expect(settled()).toBeGreaterThanOrEqual(1);
    await batch.drain();
    expect(pushed).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps the failure of the request it settles at a crossing, even though the next one started", async () => {
    const { batch, pushed, forgotten, fail } = makeBatch({ maxFiles: 1, controlled: true });
    await batch.add(version("a", 1), "m", { pipelined: true });
    // b's arrival starts a's request; it is held open.
    await batch.add(version("b", 1), "m", { pipelined: true });
    fail(new Error("first batch failed"));

    // c's arrival settles a before starting b: the rejection has to be folded in there, or
    // starting b would overwrite the only reference to it (the defect W11 fixed).
    await batch.add(version("c", 1), "m", { pipelined: true });
    expect((batch.failure as Error).message).toBe("first batch failed");
    expect(forgotten).toEqual(["a"]);
    await batch.drain();
    expect(pushed).toEqual([["a"], ["b"], ["c"]]);
  });

  it("keeps the queued batch's failure when a large version drains it", async () => {
    const { batch, pushed, forgotten, fail } = makeBatch({ maxBytes: 10, controlled: true });
    await batch.add(version("small", 4), "m");
    // The large version drains the queued batch first; that request is held open and then
    // fails. The failure must survive even though the large one is sent afterwards.
    const addingBig = batch.add(version("big", 11), "m");
    // The drain starts the small request on a later turn, so wait for it before failing it.
    while (pushed.length === 0) await Promise.resolve();
    fail(new Error("small batch failed"));
    await addingBig;
    expect((batch.failure as Error).message).toBe("small batch failed");
    expect(pushed).toEqual([["small"], ["big"]]);
    expect(forgotten).toEqual(["small"]);
  });
});

describe("PushBatch — the limiter", () => {
  it("ends the sequence and drops every later version", async () => {
    const { batch, forgotten, pushed } = makeBatch({
      maxFiles: 1,
      push: async () => {
        throw { status: 429 };
      },
    });
    await batch.add(version("a", 1), "m");
    await batch.drain();
    expect(batch.rateLimited).toBe(true);
    expect(forgotten).toEqual(["a"]);

    // The sequence is over: the next version is forgotten without a request.
    const outcome = await batch.add(version("b", 1), "m");
    expect(outcome).toBe("dropped");
    expect(forgotten).toEqual(["a", "b"]);
    expect(pushed).toEqual([["a"]]);
  });

  it("drops the queued versions on drain instead of sending them into a refused window", async () => {
    const { batch, forgotten, pushed } = makeBatch();
    await batch.add(version("a", 1), "m");
    batch.recordFailure({ status: 429 });
    await batch.drain();
    expect(pushed).toEqual([]);
    expect(forgotten).toEqual(["a"]);
  });

  it("drops a chunked version when the request before it hits the limiter", async () => {
    const { batch, alone, forgotten, pushed } = makeBatch({
      push: async () => {
        throw { status: 429 };
      },
    });
    await batch.add(version("small", 1), "m");
    const outcome = await batch.add(version("big", 1, 2), "m");
    expect(outcome).toBe("dropped");
    expect(pushed).toEqual([["small"]]);
    expect(alone).toEqual([]);
    expect(forgotten).toEqual(["small", "big"]);
  });
});

describe("PushBatch — chunked versions and abandonment", () => {
  it("drains the batch before staging a chunked version, which travels alone", async () => {
    const { batch, alone, pushed } = makeBatch();
    await batch.add(version("small", 1), "m");
    await batch.add(version("big", 1, 2), "m");
    expect(pushed).toEqual([["small"]]);
    expect(alone).toEqual(["big"]);
  });

  it("forgets a chunked version whose own send fails, and records the failure", async () => {
    const { batch, host } = makeBatch();
    host.sendAlone = async () => new Error("chunk upload failed");
    await batch.add(version("big", 1, 2), "m");
    expect((batch.failure as Error).message).toBe("chunk upload failed");
  });

  it("abandons only what is still queued", async () => {
    const { batch, forgotten, pushed } = makeBatch();
    await batch.add(version("a", 1), "m");
    batch.abandon();
    expect(forgotten).toEqual(["a"]);
    await batch.drain();
    expect(pushed).toEqual([]);
  });

  it("persists once per request, and never for a request that failed as a whole", async () => {
    const ok = makeBatch();
    await ok.batch.add(version("a", 1), "m");
    await ok.batch.drain();
    expect(ok.settled()).toBe(1);

    const failed = makeBatch({
      push: async () => {
        throw new Error("network down");
      },
    });
    await failed.batch.add(version("a", 1), "m");
    await failed.batch.drain();
    expect(failed.settled()).toBe(0);
  });
});

describe("classifyPushResult", () => {
  it("names the three statuses a caller has to answer differently", () => {
    expect(classifyPushResult({ status: "ok" })).toBe("ok");
    expect(classifyPushResult({ status: "stale_base" })).toBe("stale_base");
    expect(classifyPushResult({ status: "content_missing" })).toBe("content_missing");
  });

  it("treats every other status, and a missing answer, as a refusal", () => {
    // The route answers `error`/`quota`/… for a push it will not take, and a result the
    // server did not include at all is a refused version too (the caller reports it).
    expect(classifyPushResult({ status: "quota" })).toBe("refused");
    expect(classifyPushResult({ status: "error", error: "boom" })).toBe("refused");
    expect(classifyPushResult(undefined)).toBe("refused");
  });
});
