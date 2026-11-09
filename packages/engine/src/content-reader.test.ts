/**
 * The batched whole-file read a download pulls through (`content-reader.ts`).
 *
 * `engine.batching.test.ts` pins the batch end to end — one request per wave, the byte and
 * file caps, a real pass consuming the answers. This file pins the seam itself, including
 * the arms an engine run does not reach on purpose: a read-ahead `missing` answer (returned
 * without a request), a read-ahead `failed` answer (which must be read again), and a flush
 * with nothing pending.
 *
 * The platform is a fake that records its callbacks instead of scheduling them, so a test
 * fires the batch on the spot. Nothing here sleeps, and no fake timers are needed.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_CONTENT_BATCH_FILES } from "@courier/shared";
import type { SyncApi } from "./api";
import { ContentReader, type ContentReaderOptions } from "./content-reader";
import { ContentPrefetcher, type PrefetchAnswer } from "./content-prefetch";
import type { Platform, TimerHandle } from "./platform";

const VAULT_ID = "vault-1";

/** The batch's whole-batch byte bound, so a version that fills it travels alone. */
const CONTENT_BATCH_MAX_BYTES = 8 * 1024 * 1024;

/** Deterministic bytes, so a test can tell two answers apart. */
function blob(size: number, fill: number): Uint8Array {
  return new Uint8Array(size).fill(fill);
}

/** What the fake API answers for one batch; `null` is the store's "nothing to apply". */
type ContentsReply = (contentHashes: readonly string[]) => Array<Uint8Array | null>;

/** A platform whose `after` only records the callback, so the test fires the batch. */
class FakePlatform implements Platform {
  readonly process = undefined;
  readonly timers: Array<{ readonly ms: number; readonly fn: () => void; cancelled: boolean }> = [];

  after(ms: number, fn: () => void): TimerHandle {
    const timer = { ms, fn, cancelled: false };
    this.timers.push(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
      },
    };
  }

  every(): TimerHandle {
    throw new Error("ContentReader arms no repeating timer");
  }

  /** Run the most recently scheduled callback, as the event loop would. */
  fireLast(): void {
    const timer = this.timers.at(-1);
    if (timer === undefined) throw new Error("no timer was scheduled");
    timer.fn();
  }
}

/**
 * A read-ahead that answers from a table. `ContentReader` calls `take` and nothing else, so
 * that is the whole contract the fake replaces.
 */
class FakePrefetcher extends ContentPrefetcher {
  /** The hashes the reader asked about, in order. */
  readonly taken: string[] = [];
  private readonly answers: ReadonlyMap<string, PrefetchAnswer>;

  constructor(answers: ReadonlyMap<string, PrefetchAnswer>) {
    super(async () => []);
    this.answers = answers;
  }

  override take(contentHash: string): Promise<PrefetchAnswer> | undefined {
    const answer = this.answers.get(contentHash);
    if (answer === undefined) return undefined;
    this.taken.push(contentHash);
    return Promise.resolve(answer);
  }
}

/** A table-backed read-ahead, from hash to the answer `take` returns for it. */
function prefetched(answers: Record<string, PrefetchAnswer>): FakePrefetcher {
  return new FakePrefetcher(new Map(Object.entries(answers)));
}

/** A `SyncApi` route a whole-file content read never speaks. */
function unreachable(): never {
  throw new Error("ContentReader never calls this route");
}

/** A `SyncApi` whose only meaningful answer is the batched content route. */
function fakeApi(reply: ContentsReply) {
  const getVersionContents = vi.fn<SyncApi["getVersionContents"]>(async (_vaultId, contentHashes) =>
    reply(contentHashes),
  );
  const api: SyncApi = {
    push: unreachable,
    pull: unreachable,
    getVersionContent: unreachable,
    getVersionContents,
    getVersionContentRange: unreachable,
    uploadChunk: unreachable,
    getChunkStatus: unreachable,
    getVaultSyncIndex: unreachable,
  };
  return { api, getVersionContents };
}

interface HarnessOptions {
  /** Answers each batch request; the cases that assert no request never reach it. */
  reply?: ContentsReply;
  maxConcurrent?: number;
  prefetcher?: ContentPrefetcher | null;
}

function makeHarness(options: HarnessOptions = {}) {
  const platform = new FakePlatform();
  const { api, getVersionContents } = fakeApi(options.reply ?? (() => []));
  // `vi.fn`'s `Mock<T>` erases a generic call signature, so a plain spy records the calls
  // and a typed wrapper forwards them; the reader still gets the real `wait` contract.
  const waitCalls = vi.fn();
  const wait: ContentReaderOptions["wait"] = async (send) => {
    waitCalls();
    return await send();
  };
  const reader = new ContentReader({
    api,
    vaultId: VAULT_ID,
    platform,
    maxConcurrent: options.maxConcurrent ?? 4,
    prefetcher: options.prefetcher ?? null,
    wait,
  });
  return { reader, platform, getVersionContents, waitCalls };
}

describe("ContentReader — the read-ahead beside the batch", () => {
  it("uses a content answer without a request", async () => {
    const bytes = blob(8, 1);
    const prefetcher = prefetched({ h: { kind: "content", bytes } });
    const { reader, platform, getVersionContents } = makeHarness({ prefetcher });

    await expect(reader.read("h", 8)).resolves.toBe(bytes);

    expect(prefetcher.taken).toEqual(["h"]);
    expect(getVersionContents).not.toHaveBeenCalled();
    expect(platform.timers).toHaveLength(0);
  });

  it("returns null for a missing answer without a request", async () => {
    // `missing` is the store's own "nothing to apply" (a 404, or reclaimed bytes), so it is
    // answered here instead of being sent through the batch as a second read.
    const { reader, platform, getVersionContents } = makeHarness({
      prefetcher: prefetched({ h: { kind: "missing" } }),
    });

    await expect(reader.read("h", 8)).resolves.toBeNull();

    expect(getVersionContents).not.toHaveBeenCalled();
    expect(platform.timers).toHaveLength(0);
  });

  it("reads a version again after a failed answer", async () => {
    // `failed` is "the read-ahead's request did not happen", which must not look like a
    // missing blob: the caller's own read is the retry.
    const again = blob(8, 2);
    const prefetcher = prefetched({ h: { kind: "failed" } });
    const { reader, platform, getVersionContents } = makeHarness({
      prefetcher,
      reply: () => [again],
    });

    const read = reader.read("h", 8);
    // The answer is already settled, so one microtask carries the read into the batch.
    await Promise.resolve();
    expect(platform.timers).toHaveLength(1);
    platform.fireLast();

    await expect(read).resolves.toBe(again);
    expect(getVersionContents).toHaveBeenCalledTimes(1);
    expect(getVersionContents.mock.calls[0]?.[1]).toEqual(["h"]);
  });
});

describe("ContentReader — one request per wave", () => {
  it("carries two hashes in one request and answers the right caller", async () => {
    const first = blob(4, 1);
    const second = blob(5, 2);
    const { reader, platform, getVersionContents } = makeHarness({
      reply: (hashes) => hashes.map((hash) => (hash === "a" ? first : second)),
    });

    const readA = reader.read("a", 4);
    const readB = reader.read("b", 5);
    expect(platform.timers).toHaveLength(1);
    // 0 ms is the batch's one-turn window (see `CONTENT_BATCH_WINDOW_MS`).
    expect(platform.timers[0]?.ms).toBe(0);
    platform.fireLast();

    await expect(readA).resolves.toBe(first);
    await expect(readB).resolves.toBe(second);
    expect(getVersionContents).toHaveBeenCalledTimes(1);
    expect(getVersionContents.mock.calls[0]?.[1]).toEqual(["a", "b"]);
  });

  it("shares one request entry between two callers of the same hash", async () => {
    const bytes = blob(6, 3);
    const { reader, platform, getVersionContents } = makeHarness({ reply: () => [bytes] });

    const first = reader.read("same", 6);
    const second = reader.read("same", 6);
    // The second read added a waiter; the first read's timer is still the only one.
    expect(platform.timers).toHaveLength(1);
    platform.fireLast();

    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(bytes);
    expect(two).toBe(bytes);
    expect(getVersionContents).toHaveBeenCalledTimes(1);
    expect(getVersionContents.mock.calls[0]?.[1]).toEqual(["same"]);
  });

  it("flushes a full batch at maxConcurrent without waiting for the timer", async () => {
    const { reader, platform, getVersionContents } = makeHarness({
      maxConcurrent: 3,
      reply: (hashes) => hashes.map((hash) => blob(hash.length, 4)),
    });

    const reads = ["aa", "bbb", "cccc"].map((hash) => reader.read(hash, hash.length));
    // The third read filled the pool's width, so the request is already on its way.
    expect(getVersionContents).toHaveBeenCalledTimes(1);
    expect(platform.timers).toHaveLength(1);
    expect(platform.timers[0]?.cancelled).toBe(true);

    await Promise.all(reads);
    expect(getVersionContents.mock.calls[0]?.[1]).toEqual(["aa", "bbb", "cccc"]);
  });

  it("clamps a full batch to the route's file cap however wide the pool runs", async () => {
    const { reader, getVersionContents } = makeHarness({
      // Wider than the route accepts: the clamp, not `maxConcurrent`, sizes the batch.
      maxConcurrent: MAX_CONTENT_BATCH_FILES * 2,
      reply: (hashes) => hashes.map(() => blob(1, 5)),
    });
    const hashes = Array.from({ length: MAX_CONTENT_BATCH_FILES }, (_, index) => `hash-${index}`);

    const reads = hashes.map((hash) => reader.read(hash, 1));
    // Flushed at the route's cap, before the timer could fire.
    expect(getVersionContents).toHaveBeenCalledTimes(1);
    expect(getVersionContents.mock.calls[0]?.[1]).toEqual(hashes);

    await Promise.all(reads);
  });

  it("sends a version that fills the byte budget alone", async () => {
    const big = blob(CONTENT_BATCH_MAX_BYTES, 6);
    const small = blob(4, 7);
    const { reader, platform, getVersionContents } = makeHarness({
      reply: (hashes) => hashes.map((hash) => (hash === "big" ? big : small)),
    });

    const bigRead = reader.read("big", CONTENT_BATCH_MAX_BYTES);
    expect(platform.timers).toHaveLength(1);
    // Nothing can join a batch already at its byte budget: the next read flushes the big
    // version alone and starts a batch of its own.
    const smallRead = reader.read("small", 4);
    expect(getVersionContents).toHaveBeenCalledTimes(1);
    expect(getVersionContents.mock.calls[0]?.[1]).toEqual(["big"]);
    platform.fireLast();

    await expect(bigRead).resolves.toBe(big);
    await expect(smallRead).resolves.toBe(small);
    expect(getVersionContents.mock.calls.map((call) => call[1])).toEqual([["big"], ["small"]]);
  });

  it("rejects every waiter when the whole request fails", async () => {
    const failure = new Error("the connection dropped");
    const { reader, platform, getVersionContents } = makeHarness({
      reply: () => {
        throw failure;
      },
    });

    const first = reader.read("a", 4);
    const second = reader.read("b", 5);
    const settled = Promise.allSettled([first, second]);
    platform.fireLast();

    const reasons: unknown[] = (await settled).map((result) =>
      result.status === "rejected" ? result.reason : null,
    );
    expect(reasons[0]).toBe(failure);
    expect(reasons[1]).toBe(failure);
    expect(getVersionContents).toHaveBeenCalledTimes(1);
  });

  it("does nothing when the flush timer fires with nothing pending", async () => {
    const bytes = blob(2, 8);
    const { reader, platform, getVersionContents } = makeHarness({
      maxConcurrent: 2,
      reply: () => [bytes],
    });

    const first = reader.read("a", 2);
    const second = reader.read("b", 2);
    // The full batch flushed at once and cancelled the timer; a callback the loop had
    // already queued still runs, and must find nothing to send.
    expect(getVersionContents).toHaveBeenCalledTimes(1);
    platform.timers[0]?.fn();

    await Promise.all([first, second]);
    expect(getVersionContents).toHaveBeenCalledTimes(1);
    expect(platform.timers).toHaveLength(1);
  });

  it("fetches through the injected wait wrapper", async () => {
    const one = blob(1, 9);
    const two = blob(2, 10);
    const { reader, getVersionContents, waitCalls } = makeHarness({
      reply: (hashes) => hashes.map((hash) => (hash === "a" ? one : two)),
    });

    const results = await reader.fetch(["a", "bb"]);

    expect(waitCalls).toHaveBeenCalledTimes(1);
    expect(getVersionContents).toHaveBeenCalledTimes(1);
    expect(getVersionContents).toHaveBeenCalledWith(VAULT_ID, ["a", "bb"]);
    expect(results[0]).toBe(one);
    expect(results[1]).toBe(two);
  });
});
