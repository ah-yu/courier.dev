/**
 * The read-ahead beside a download (see `content-prefetch.ts`).
 *
 * These pin the properties the engine relies on and nothing more: one request per hash,
 * the caps, the LRU, and — the rule that matters for correctness — that "not prefetched"
 * and "the request did not happen" both read as *misses* for the caller, never as "the
 * store holds nothing".
 */
import { describe, expect, it } from "vitest";
import { MAX_CONTENT_BATCH_BYTES, MAX_CONTENT_BATCH_FILES } from "@courier/shared";
import {
  ContentPrefetcher,
  DEFAULT_CONTENT_PREFETCH_LIMITS,
  normalizePrefetchLimits,
  type ContentPrefetchLimits,
  type PrefetchRead,
} from "./content-prefetch";

/** Deterministic bytes, so a test can tell two answers apart by size and fill. */
function blob(size: number, fill = 1): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

/** A candidate list of `count` hashes, `size` bytes each. */
function candidates(count: number, size = 4): Array<{ contentHash: string; sizeBytes: number }> {
  return Array.from({ length: count }, (_, index) => ({
    contentHash: `hash-${index}`,
    sizeBytes: size,
  }));
}

function limits(overrides: Partial<ContentPrefetchLimits> = {}): ContentPrefetchLimits {
  return { ...DEFAULT_CONTENT_PREFETCH_LIMITS, ...overrides };
}

/** A reader that answers every hash it is given, and records the requests it saw. */
function recordingReader(): { read: PrefetchRead; calls: string[][] } {
  const calls: string[][] = [];
  const read: PrefetchRead = async (contentHashes) => {
    calls.push([...contentHashes]);
    return contentHashes.map((hash) => blob(hash.length));
  };
  return { read, calls };
}

/** A reader whose requests all wait for one gate the test opens. */
function gatedReader(size = 8): {
  read: PrefetchRead;
  calls: string[][];
  waiting: () => number;
  maxInFlight: () => number;
  open: () => void;
} {
  const calls: string[][] = [];
  let started = 0;
  let finished = 0;
  let inFlight = 0;
  let peak = 0;
  let releaseGate: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const read: PrefetchRead = async (contentHashes) => {
    calls.push([...contentHashes]);
    started++;
    inFlight++;
    peak = Math.max(peak, inFlight);
    await gate;
    inFlight--;
    finished++;
    return contentHashes.map(() => blob(size));
  };
  return {
    read,
    calls,
    waiting: () => started - finished,
    maxInFlight: () => peak,
    open: () => releaseGate?.(),
  };
}

describe("ContentPrefetcher — what it reads", () => {
  it("reads the hashes it was asked for, in order, and answers each one", async () => {
    const { read, calls } = recordingReader();
    const prefetcher = new ContentPrefetcher(read, limits({ concurrency: 1 }));

    prefetcher.request(candidates(3));
    await prefetcher.whenIdle();

    expect(calls).toEqual([["hash-0", "hash-1", "hash-2"]]);
    const answer = await prefetcher.take("hash-1");
    expect(answer?.kind).toBe("content");
    expect(answer?.kind === "content" ? answer.bytes.byteLength : 0).toBe("hash-1".length);
  });

  it("names no more than `batchFiles` hashes in one request", async () => {
    const { read, calls } = recordingReader();
    const prefetcher = new ContentPrefetcher(read, limits({ batchFiles: 4, concurrency: 1 }));

    prefetcher.request(candidates(10));
    await prefetcher.whenIdle();

    expect(calls.map((call) => call.length)).toEqual([4, 4, 2]);
  });

  it("stops a batch when the next hash would pass `batchBytes`", async () => {
    const { read, calls } = recordingReader();
    const prefetcher = new ContentPrefetcher(
      read,
      // Payload plus the 28-byte envelope is what a request carries.
      limits({ batchFiles: 100, batchBytes: 140, concurrency: 1 }),
    );

    prefetcher.request(candidates(3, 40));
    await prefetcher.whenIdle();

    // 68 + 68 fits in 140, the third would make 204.
    expect(calls.map((call) => call.length)).toEqual([2, 1]);
  });

  it("never sends a hash bigger than one request; the caller reads it itself", async () => {
    const { read, calls } = recordingReader();
    const prefetcher = new ContentPrefetcher(read, limits({ batchBytes: 10 }));

    prefetcher.request([{ contentHash: "big", sizeBytes: 11 }]);

    expect(calls).toEqual([]);
    expect(prefetcher.take("big")).toBeUndefined();
  });

  it("sends a hash once, however often it is asked for", async () => {
    const { read, calls } = recordingReader();
    const prefetcher = new ContentPrefetcher(read, limits({ concurrency: 1 }));

    prefetcher.request(candidates(2));
    prefetcher.request(candidates(2));
    await prefetcher.whenIdle();

    expect(calls).toEqual([["hash-0", "hash-1"]]);
  });

  it("runs no more requests at once than `concurrency`", async () => {
    const gate = gatedReader();
    const prefetcher = new ContentPrefetcher(gate.read, limits({ batchFiles: 1, concurrency: 2 }));

    prefetcher.request(candidates(6));
    await Promise.resolve();

    expect(gate.waiting()).toBe(2);
    expect(gate.maxInFlight()).toBe(2);

    gate.open();
    await prefetcher.whenIdle();

    expect(gate.calls).toHaveLength(6);
    expect(gate.maxInFlight()).toBe(2);
  });

  it("answers a hash it never queued with undefined, so the caller reads it", () => {
    const prefetcher = new ContentPrefetcher(async () => [], limits());

    expect(prefetcher.take("unknown")).toBeUndefined();
  });

  it("serves a hash a caller is waiting for before the ones it queued earlier", async () => {
    // The priority rule: a pass and a peer's burst can be in flight together, and the
    // burst's apply loop blocks on its own hashes — those must not wait behind the pass's
    // speculative ones.
    const gate = gatedReader();
    const prefetcher = new ContentPrefetcher(gate.read, limits({ batchFiles: 1, concurrency: 1 }));
    prefetcher.request(candidates(4));
    await Promise.resolve();

    const waiting = prefetcher.take("hash-3");
    gate.open();
    await waiting;
    await prefetcher.whenIdle();

    expect(gate.calls.map((call) => call[0])).toEqual(["hash-0", "hash-3", "hash-1", "hash-2"]);
  });
});

describe("ContentPrefetcher — a host's limits", () => {
  it("falls back to the default for a value that would stall the queue", () => {
    // `concurrency: 0` (or an explicit `undefined` from a spread) would otherwise leave a
    // queue that never sends, and the pass waiting on it forever.
    const stalled = normalizePrefetchLimits({ concurrency: 0 });
    expect(stalled.concurrency).toBe(DEFAULT_CONTENT_PREFETCH_LIMITS.concurrency);
    const spread = normalizePrefetchLimits({ concurrency: undefined as unknown as number });
    expect(spread.concurrency).toBe(DEFAULT_CONTENT_PREFETCH_LIMITS.concurrency);
  });

  it("narrows the batch to what the content route accepts", () => {
    const wide = normalizePrefetchLimits({ batchFiles: 1000, batchBytes: 64 * 1024 * 1024 });
    expect(wide.batchFiles).toBe(MAX_CONTENT_BATCH_FILES);
    // Half of the route's *answer* cap: the request's framing rides on top of the payload.
    expect(wide.batchBytes).toBe(MAX_CONTENT_BATCH_BYTES / 2);
  });

  it("never gives the store less room than one request", () => {
    const tiny = normalizePrefetchLimits({ batchBytes: 4 * 1024 * 1024, storeBytes: 1_024 });
    expect(tiny.storeBytes).toBe(tiny.batchBytes);
  });

  it("keeps a limit the host did set, and the defaults for the rest", () => {
    const custom = normalizePrefetchLimits({ concurrency: 3 });
    expect(custom.concurrency).toBe(3);
    expect(custom.batchFiles).toBe(DEFAULT_CONTENT_PREFETCH_LIMITS.batchFiles);
  });
});

describe("ContentPrefetcher — the store", () => {
  it("stops reading ahead when the store is full, and resumes when a caller takes one", async () => {
    // The room check: fetched-but-untaken bytes plus requests in flight may not pass
    // `storeBytes`, or a fast link would read far ahead of a slow writer, the LRU would
    // drop entries nobody consumed, and those pulls would cost a second read.
    const calls: string[][] = [];
    const prefetcher = new ContentPrefetcher(
      // The store holds ciphertext: the plaintext of 8 bytes plus the 28-byte envelope.
      async (hashes) => {
        calls.push([...hashes]);
        return hashes.map(() => blob(8 + 28));
      },
      limits({ batchFiles: 2, batchBytes: 1_000, concurrency: 4, storeBytes: 72 }),
    );

    prefetcher.request(candidates(6, 8));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Two answers fill the 72-byte store, so only one request went out.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);

    // Taking one frees exactly its room: one more entry fits, and no more.
    await prefetcher.take("hash-0");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(["hash-2"]);
  });

  it("drops the guesses nobody asked for, and keeps the ones a caller is waiting on", async () => {
    const gate = gatedReader(8);
    const prefetcher = new ContentPrefetcher(gate.read, limits({ batchFiles: 1, concurrency: 1 }));
    prefetcher.request(candidates(4));
    await Promise.resolve();

    const waiting = prefetcher.take("hash-2");
    prefetcher.dropSpeculative();
    gate.open();

    // A demanded hash survives the drop; the speculative ones behind it do not.
    expect((await waiting)?.kind).toBe("content");
    expect(prefetcher.take("hash-1")).toBeUndefined();
    expect(prefetcher.take("hash-3")).toBeUndefined();
  });

  it("releases the buffered guesses on dropSpeculative, so the next pass can read ahead", async () => {
    // The pass is over: the bytes nobody took must not keep the room the next pass needs
    // (and `request` skips a hash the store still holds, so the next read-ahead could not
    // start until those entries were evicted one at a time).
    const prefetcher = new ContentPrefetcher(
      async (hashes) => hashes.map(() => blob(36)),
      limits({ batchFiles: 2, concurrency: 1, storeBytes: 72 }),
    );
    prefetcher.request(candidates(2, 8));
    await prefetcher.whenIdle();
    expect(prefetcher.stats().storedBytes).toBe(72);

    prefetcher.dropSpeculative();

    expect(prefetcher.stats()).toMatchObject({ storedBytes: 0, storedEntries: 0 });
    const calls: string[][] = [];
    const fresh = new ContentPrefetcher(
      async (hashes) => {
        calls.push([...hashes]);
        return hashes.map(() => blob(36));
      },
      limits({ batchFiles: 2, concurrency: 1, storeBytes: 72 }),
    );
    fresh.request(candidates(2, 8));
    await fresh.whenIdle();
    expect(calls).toEqual([["hash-0", "hash-1"]]);
  });

  it("counts a read-ahead with no room left as idle, so a drain does not wait for it", async () => {
    const prefetcher = new ContentPrefetcher(
      async (hashes) => hashes.map(() => blob(36)),
      limits({ batchFiles: 1, concurrency: 1, storeBytes: 36 }),
    );
    prefetcher.request(candidates(3, 8));
    // The store is full after one answer; the other two can only move when a take frees
    // room, so nothing is in flight and nothing will start by itself.
    await prefetcher.whenIdle();
    expect(prefetcher.stats().storedEntries).toBe(1);
  });

  it("stops at the entry cap as well, so a small-entry store is not overrun", async () => {
    // Sub-2 KiB notes fill `storeEntries` before `storeBytes`; gating only on bytes would
    // let the read-ahead fetch the whole candidate list while `remember` evicted entries
    // nobody had taken, and every one of those pulls would cost a second read.
    const calls: string[][] = [];
    const prefetcher = new ContentPrefetcher(
      async (hashes) => {
        calls.push([...hashes]);
        return hashes.map(() => blob(28));
      },
      limits({ batchFiles: 4, concurrency: 1, storeBytes: 8 * 1024 * 1024, storeEntries: 3 }),
    );

    prefetcher.request(candidates(10, 0));
    await prefetcher.whenIdle();

    // Three entry slots: one batch of three, and nothing more until a take frees a slot.
    expect(calls.map((call) => call.length)).toEqual([3]);
    expect(prefetcher.stats().storedEntries).toBe(3);

    await prefetcher.take("hash-0");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.map((call) => call.length)).toEqual([3, 1]);
  });

  it("does not re-store a request that was in flight when the pass dropped its guesses", async () => {
    const gate = gatedReader(36);
    const prefetcher = new ContentPrefetcher(gate.read, limits({ batchFiles: 1, concurrency: 1 }));
    prefetcher.request(candidates(1, 8));
    await Promise.resolve();

    prefetcher.dropSpeculative();
    gate.open();
    await prefetcher.whenIdle();

    expect(prefetcher.stats()).toMatchObject({ storedBytes: 0, storedEntries: 0 });
  });

  it("drops only the source that asked, so a pass ending keeps a burst's read-ahead", async () => {
    // A pass and a burst can overlap; a pass that drops its own guesses must not cancel
    // the burst's (its own drop happens at the end of the burst).
    const gate = gatedReader(36);
    const prefetcher = new ContentPrefetcher(gate.read, limits({ batchFiles: 1, concurrency: 1 }));
    prefetcher.request(candidates(2, 8), "pass");
    await Promise.resolve();
    prefetcher.request([{ contentHash: "burst-0", sizeBytes: 8 }], "burst");

    prefetcher.dropSpeculative("pass");
    gate.open();
    await prefetcher.whenIdle();

    expect(prefetcher.take("hash-1")).toBeUndefined();
    expect(prefetcher.take("hash-0")).toBeUndefined();
    expect((await prefetcher.take("burst-0"))?.kind).toBe("content");
  });

  it("keeps a burst's already-stored bytes when a pass drops its own", async () => {
    // The other half of the cross-source rule: the stored entries are filtered by origin,
    // not just the queue.
    const prefetcher = new ContentPrefetcher(
      async (hashes) => hashes.map(() => blob(36)),
      limits({ batchFiles: 4, concurrency: 2 }),
    );
    prefetcher.request([{ contentHash: "burst-0", sizeBytes: 8 }], "burst");
    await prefetcher.whenIdle();
    prefetcher.request(candidates(2, 8), "pass");
    await prefetcher.whenIdle();

    prefetcher.dropSpeculative("pass");

    expect((await prefetcher.take("burst-0"))?.kind).toBe("content");
    expect(prefetcher.take("hash-0")).toBeUndefined();
  });

  it("settles a take whose request fails synchronously", async () => {
    // The hash is queued but cannot be sent (no room), so the **take** is what starts the
    // request — and a reader that throws without awaiting makes that request fail before
    // `take` returns. Registering the waiter first is what keeps it from hanging forever.
    const prefetcher = new ContentPrefetcher(
      () => {
        throw new Error("the connection never opened");
      },
      limits({ storeBytes: 8 }),
    );
    prefetcher.request(candidates(1, 8));

    await expect(prefetcher.take("hash-0")).resolves.toEqual({ kind: "failed" });
  });

  it("evicts the oldest entry when a demanded read takes the store past its byte cap", async () => {
    // Speculative reads respect the room, so the cap can only be passed by a **demanded**
    // batch (which a caller is blocked on), and the oldest entry goes.
    const prefetcher = new ContentPrefetcher(
      async (hashes) => hashes.map(() => blob(36)),
      limits({ batchFiles: 1, concurrency: 1, storeBytes: 72 }),
    );

    prefetcher.request(candidates(3, 8));
    await prefetcher.whenIdle();
    expect(prefetcher.stats().storedBytes).toBe(72);

    await prefetcher.take("hash-2");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prefetcher.stats().storedBytes).toBe(72);
    expect(prefetcher.take("hash-0")).toBeUndefined();
    expect((await prefetcher.take("hash-2"))?.kind).toBe("content");
  });

  it("evicts the oldest entry when a demanded read takes the store past its entry cap", async () => {
    // Speculative reads respect the entry slots too, so (like the byte cap) the store can
    // only be pushed over them by a **demanded** batch, which ignores the room checks.
    const prefetcher = new ContentPrefetcher(
      async (hashes) => hashes.map(() => blob(28)),
      limits({ batchFiles: 1, concurrency: 1, storeBytes: 8 * 1024 * 1024, storeEntries: 2 }),
    );

    prefetcher.request(candidates(4, 0));
    await prefetcher.whenIdle();
    expect(prefetcher.stats().storedEntries).toBe(2);

    await prefetcher.take("hash-2");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prefetcher.stats().storedEntries).toBe(2);
    expect(prefetcher.take("hash-0")).toBeUndefined();
    expect((await prefetcher.take("hash-2"))?.kind).toBe("content");
  });

  it("counts a stored answer as a hit and an absent hash as a miss", async () => {
    const prefetcher = new ContentPrefetcher(async (hashes) => hashes.map(() => blob(1)), limits());
    prefetcher.request(candidates(1, 1));
    await prefetcher.whenIdle();

    await prefetcher.take("hash-0");
    prefetcher.take("absent");

    expect(prefetcher.stats()).toMatchObject({ hits: 1, misses: 1 });
  });
});

describe("ContentPrefetcher — failure", () => {
  it("answers failed when the request fails, and keeps nothing", async () => {
    let attempts = 0;
    const read: PrefetchRead = async (hashes) => {
      attempts++;
      if (attempts === 1) throw new Error("the connection dropped");
      return hashes.map(() => blob(2));
    };
    const prefetcher = new ContentPrefetcher(read, limits());

    prefetcher.request(candidates(2));
    const answer = await prefetcher.take("hash-0");

    expect(answer).toEqual({ kind: "failed" });
    // Not cached: the next pass asks again, and this time the read succeeds.
    expect(prefetcher.take("hash-0")).toBeUndefined();
    prefetcher.request(candidates(2));
    await prefetcher.whenIdle();
    expect((await prefetcher.take("hash-0"))?.kind).toBe("content");
  });

  it("answers missing for a hash the store does not hold, and does not cache it", async () => {
    const prefetcher = new ContentPrefetcher(async (hashes) => hashes.map(() => null), limits());

    prefetcher.request(candidates(1));
    const answer = await prefetcher.take("hash-0");

    expect(answer).toEqual({ kind: "missing" });
    // A reclaimed blob can come back: the next read must happen rather than be answered
    // from a cached "nothing here".
    expect(prefetcher.take("hash-0")).toBeUndefined();
  });

  it("answers waiters with failed on stop, and sends nothing afterwards", async () => {
    const gate = gatedReader();
    const prefetcher = new ContentPrefetcher(gate.read, limits({ batchFiles: 1, concurrency: 1 }));
    prefetcher.request(candidates(3));
    await Promise.resolve();

    const waiting = prefetcher.take("hash-1");
    prefetcher.stop();
    gate.open();

    expect(await waiting).toEqual({ kind: "failed" });
    prefetcher.request(candidates(3));
    await prefetcher.whenIdle();
    expect(gate.calls).toHaveLength(1);
  });
});
