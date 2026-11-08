/**
 * A read-ahead of content, so a download's round trips carry more files than the pool
 * has slots.
 *
 * A pass runs four per-file operations at a time (`WorkPool`), and a pull needs one
 * answer per file, so a cold download used to cost `files / 4` round trips no matter how
 * the reads were grouped: batching a wave's four reads into one request divided the
 * **request count** by four and left the **wall clock** where it was (measured at 30 ms
 * RTT: 9.25 s one request per file, 9.31 s batched — `docs/first-bind-performance.md`).
 * The only way to move the clock without widening the pool is for one round trip to
 * carry more files than the pool can run at once.
 *
 * This is that: a **side channel** beside the pass, not a wider pool. It holds
 * ciphertext only — never plaintext — so it does not raise the per-file memory bound
 * that protects a phone; the pass consumes what it stored through `take` and keeps
 * decrypting, verifying and writing exactly as it did.
 *
 * The three rules that keep it safe:
 *
 * - **A miss is not a failure.** `take` answers `undefined` for a hash this store never
 *   had, and the caller reads it the way it always did. A request that fails answers
 *   `failed` for its hashes, which is also a miss: the on-demand read retries and is
 *   the one that can raise.
 * - **A guessed file costs bytes, never a decision.** The candidates are what the pass
 *   is *about* to pull, computed before it decides; a wrong guess is downloaded and
 *   dropped. Nothing here decides, applies or writes.
 * - **The store and the requests are bounded; the queue only holds hashes.** A
 *   read-ahead may be ahead of the consumer by no more than the store can hold — bytes
 *   and entries, both counting what is in flight — so a fast link cannot outrun a slow
 *   writer and turn each eviction into a second read. The queue itself is just hashes
 *   and sizes, and a pass releases its own when its loop ends.
 */
import { MAX_CONTENT_BATCH_BYTES, MAX_CONTENT_BATCH_FILES } from "@courier/shared";

export interface ContentPrefetchLimits {
  /** Most hashes one request may name (the route's own ceiling is 64). */
  batchFiles: number;
  /** Most plaintext bytes one request may name. */
  batchBytes: number;
  /** Most requests in flight at once (never less than one: a queue that never moves hangs). */
  concurrency: number;
  /** Most ciphertext the store keeps. */
  storeBytes: number;
  /** Most entries the store keeps. */
  storeEntries: number;
}

/**
 * A host's overrides, made safe.
 *
 * `EngineOptions.contentPrefetch` takes a `Partial`, which allows both a value that is
 * `undefined` (a spread of a settings object that never set it) and a nonsensical one
 * (`concurrency: 0`). Taking those as written would leave a queue that never sends, and
 * the pass waiting on it forever — a hang is much worse than the default. Every field is
 * therefore resolved against the default and clamped: counts to at least one, and both
 * byte budgets and the batch's file count to what the route itself accepts.
 */
export function normalizePrefetchLimits(
  partial?: Partial<ContentPrefetchLimits>,
): ContentPrefetchLimits {
  const ask = (key: keyof ContentPrefetchLimits): number => {
    const value = partial?.[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
      return DEFAULT_CONTENT_PREFETCH_LIMITS[key];
    }
    return Math.floor(value);
  };
  const batchBytes = Math.min(ask("batchBytes"), MAX_PREFETCH_BATCH_BYTES);
  return {
    batchFiles: Math.min(ask("batchFiles"), MAX_CONTENT_BATCH_FILES),
    batchBytes,
    concurrency: ask("concurrency"),
    // The store has to hold at least one request, or the room check would never let the
    // read-ahead start and a reader waiting on a queued hash would wait for nothing.
    storeBytes: Math.max(ask("storeBytes"), batchBytes),
    storeEntries: ask("storeEntries"),
  };
}

/**
 * Most plaintext one prefetch request may name.
 *
 * The route **answers** up to `MAX_CONTENT_BATCH_BYTES` (16 MiB), but that is the size of
 * the response, not of the request: the framing adds a 28-byte envelope per version on top
 * of the payload, so a request whose plaintext reaches the answer cap produces a response
 * the server refuses — and a refused batch rejects every read in it. Half of the answer
 * cap is the same budget the engine's own wave batch uses.
 */
const MAX_PREFETCH_BATCH_BYTES = MAX_CONTENT_BATCH_BYTES / 2;

/**
 * Bytes the combined encryption adds to one version: a 12-byte IV and a 16-byte tag (see
 * `encryptCombinedBytes`).
 *
 * The store counts ciphertext, but a candidate states plaintext, so this is what the room
 * check charges for a version that has not been read yet — the same unit on both sides, or
 * a settled batch would overshoot the cap by 28 bytes per file and evict an entry that was
 * still waiting to be taken.
 */
const COMBINED_ENVELOPE_BYTES = 28;

/**
 * Defaults, sized against the route's own ceiling and a phone's memory.
 *
 * 64 hashes is what the content route accepts (`MAX_CONTENT_BATCH_FILES`), and it is
 * sixteen waves of the pool — so a round trip stops being the unit of progress. 4 MiB per
 * request is half of {@link MAX_PREFETCH_BATCH_BYTES}, so two requests and the 8 MiB of
 * retention are the ~16 MiB of ciphertext a first bind may hold at worst. Measured on
 * 1 001 files (3.3 MiB) at an injected 30 ms per request: 10 132 ms / 251 requests
 * without the read-ahead, 764 ms / 16 requests with it; the wider 8 MiB batch measured
 * 827 ms and the narrower 32-file one 932 ms in an earlier run, which is why the byte cap
 * is the conservative half (`docs/first-bind-performance.md`).
 */
export const DEFAULT_CONTENT_PREFETCH_LIMITS: ContentPrefetchLimits = {
  batchFiles: 64,
  batchBytes: 4 * 1024 * 1024,
  concurrency: 2,
  storeBytes: 8 * 1024 * 1024,
  storeEntries: 4096,
};

/** One version a caller expects to read: its content hash and plaintext size. */
export interface PrefetchCandidate {
  contentHash: string;
  sizeBytes: number;
}

/**
 * Who asked for a hash.
 *
 * A reconcile pass and a `file_pushed` burst can be in flight at the same time, and a pass
 * drops its leftover guesses when its loop ends — it must not take the burst's read-ahead
 * with them, because the burst is the download this feature exists for. Each source has
 * its own drop epoch, and an answer that arrives after its source's drop is delivered but
 * not stored.
 */
export type PrefetchSource = "pass" | "burst";

/** A candidate waiting for a request, with the source that asked for it. */
interface QueuedCandidate extends PrefetchCandidate {
  source: PrefetchSource;
}

/**
 * What became of a hash a caller asked for.
 *
 * `missing` is the store's own "nothing to apply" (a `404` on the read, or bytes that
 * were reclaimed), which the pull path already handles; `failed` is "the request did not
 * happen" — a 5xx, a dropped connection, a rate limit that outlasted its waits — and the
 * caller must fall back to its own read rather than treat the file as absent.
 */
export type PrefetchAnswer =
  | { kind: "content"; bytes: Uint8Array }
  | { kind: "missing" }
  | { kind: "failed" };

/** Reads one batch of hashes; the engine supplies `POST …/sync/contents` for it. */
export type PrefetchRead = (contentHashes: readonly string[]) => Promise<Array<Uint8Array | null>>;

/** How the store is doing, for the tests and the diagnostic counters of a measurement. */
export interface ContentPrefetchStats {
  /** Requests started since the store was built. */
  requests: number;
  /** Hashes delivered to a caller from the store without a request of their own. */
  hits: number;
  /** Hashes a caller asked for that this store could not answer. */
  misses: number;
  /** Ciphertext currently held. */
  storedBytes: number;
  /** Entries currently held. */
  storedEntries: number;
}

/**
 * Reads content ahead of the pass, and answers the pass from what it read.
 *
 * Not thread-safe by design: one engine owns one of these, and every method is called
 * from the engine's own job (the queue is fed between awaits, never mutated from a
 * request's callback while the engine is inside `take`).
 */
export class ContentPrefetcher {
  private readonly limits: ContentPrefetchLimits;
  private readonly read: PrefetchRead;

  /**
   * Hashes waiting for a read: the ones a caller is **blocked on** first, then the
   * speculative ones, each in the order they were asked for.
   *
   * Two queues, not one, because the two are not equally urgent. A pass and a
   * `file_pushed` burst can be in flight together (a reconnect while a peer pushes), and
   * the burst's apply loop runs as an exclusive job in the host — a hash it waits for that
   * sits behind several hundred speculative ones stalls files the user can see, and the
   * events queued behind that job with them. A demand therefore jumps the queue: `take`
   * moves the hash here, and `nextBatch` drains this map before the speculative one.
   */
  private readonly demand = new Map<string, QueuedCandidate>();
  private readonly speculative = new Map<string, QueuedCandidate>();
  /** Hashes queued, demanded or in flight — each is requested once, however often asked for. */
  private readonly known = new Set<string>();
  /** Hashes in a request that has been sent and not settled (a demand must not re-send them). */
  private readonly inFlight = new Set<string>();
  /** Which source asked for a hash, kept until its answer is stored (see `PrefetchSource`). */
  private readonly origins = new Map<string, PrefetchSource>();
  /** Per-source drop epochs: a request settles under the epoch it was sent in. */
  private readonly generations: Record<PrefetchSource, number> = { pass: 0, burst: 0 };
  /** Ciphertext already read, in least-recently-used-first order (a `Map` keeps it). */
  private readonly store = new Map<string, PrefetchAnswer>();
  /** Callers blocked on a hash a request is going to answer. */
  private readonly waiters = new Map<string, Array<(answer: PrefetchAnswer) => void>>();
  private storedBytes = 0;
  private requestsInFlight = 0;
  /** Plaintext bytes of the requests in flight, for the room check in `nextBatch`. */
  private inFlightBytes = 0;
  private stopped = false;
  private idleWaiters: Array<() => void> = [];
  private requestCount = 0;
  private hitCount = 0;
  private missCount = 0;

  constructor(read: PrefetchRead, limits: ContentPrefetchLimits = DEFAULT_CONTENT_PREFETCH_LIMITS) {
    this.read = read;
    this.limits = limits;
  }

  /**
   * Ask for these versions to be read ahead, in this order, on behalf of `source`.
   *
   * A hash already stored, already queued or bigger than one request is skipped: the
   * first two are answered already, and the last is a read whose memory the pool bounds
   * instead (a 200 MiB attachment must never be held here). The queue itself is only
   * hashes and sizes; what is bounded is the store and the requests (see `pump`).
   */
  request(candidates: readonly PrefetchCandidate[], source: PrefetchSource = "pass"): void {
    if (this.stopped) return;
    let added = false;
    for (const candidate of candidates) {
      if (this.known.has(candidate.contentHash)) continue;
      if (this.store.has(candidate.contentHash)) continue;
      // Queued by the charge, not the payload: a version at the cap would otherwise be
      // admitted here and never fit a request, stalling the queue behind it.
      if (candidate.sizeBytes + COMBINED_ENVELOPE_BYTES > this.limits.batchBytes) continue;
      this.known.add(candidate.contentHash);
      this.origins.set(candidate.contentHash, source);
      this.speculative.set(candidate.contentHash, { ...candidate, source });
      added = true;
    }
    if (added) this.pump();
  }

  /**
   * The bytes for `contentHash`, when this store is going to produce them.
   *
   * `undefined` means "not prefetched" — the caller reads it itself. A promise means the
   * hash is stored, queued or in flight, and settles with the answer; every promise here
   * settles, because a request that fails or a `stop` answers its waiters.
   *
   * A hash still waiting for a request is **promoted** to the demand queue, so the caller
   * that is blocked on it is served next rather than after everything else queued.
   */
  take(contentHash: string): Promise<PrefetchAnswer> | undefined {
    const stored = this.store.get(contentHash);
    if (stored !== undefined) {
      this.hitCount++;
      // Taking it hands the bytes over: the entry leaves the store and its room is free
      // for the read-ahead again (see `pump`). The store is a buffer between the reader
      // and the consumer, not a cache — a second file with the same content reads it on
      // demand, and the read-ahead's own queue would have deduplicated the two anyway.
      this.store.delete(contentHash);
      this.storedBytes -= storedBytesOf(stored);
      // Its origin goes with it: the map is bounded by what the store holds, never by how
      // many hashes this engine has seen (a first bind would keep 50 000 of them).
      this.origins.delete(contentHash);
      this.pump();
      return Promise.resolve(stored);
    }
    if (!this.known.has(contentHash)) {
      this.missCount++;
      return undefined;
    }
    const queued = this.speculative.get(contentHash);
    const promote = queued !== undefined && !this.inFlight.has(contentHash);
    if (promote) {
      this.speculative.delete(contentHash);
      this.demand.set(contentHash, queued);
    }
    // The waiter is registered **before** the pump: a send can settle (or fail) the hash
    // synchronously — a reader that throws without awaiting does — and answering it then
    // would find no waiter, leaving this promise unresolved for good.
    const waiting = new Promise<PrefetchAnswer>((resolve) => {
      const registered = this.waiters.get(contentHash);
      if (registered === undefined) this.waiters.set(contentHash, [resolve]);
      else registered.push(resolve);
    });
    if (promote) this.pump();
    return waiting;
  }

  /**
   * Drop the guesses one source has not been asked for, and the bytes read for them.
   *
   * A pass calls this when its per-file loop is over: what is left is a superset that
   * turned out not to be pulled (a conflict copy, an edit that decided as a push, a path
   * the cap refused). Leaving it would spend bytes — the store's copy would keep the room
   * the next pass needs, and `request` skips a hash it already holds, so the next
   * read-ahead could not start until demanded reads had evicted it batch by batch.
   * Demanded reads are left alone, because a caller is blocked on those.
   *
   * `source` is what keeps a pass that ends mid-burst from cancelling the burst's own
   * read-ahead (the two do overlap: a host runs a reconcile in the background while its
   * `OpQueue` applies notifications). An answer belonging to a dropped source that is
   * already in flight is still delivered to whoever waits for it, but it is not stored.
   */
  dropSpeculative(source: PrefetchSource = "pass"): void {
    for (const [hash, entry] of this.speculative) {
      if (entry.source !== source) continue;
      this.speculative.delete(hash);
      this.known.delete(hash);
      this.origins.delete(hash);
    }
    for (const [hash, origin] of this.origins) {
      if (origin !== source) continue;
      const stored = this.store.get(hash);
      if (stored === undefined) continue;
      this.store.delete(hash);
      this.storedBytes -= storedBytesOf(stored);
      this.origins.delete(hash);
    }
    this.generations[source]++;
    this.pump();
    this.settleIdle();
  }

  /**
   * Stop reading ahead and answer every caller still waiting with `failed`.
   *
   * `failed` means "not prefetched", which makes the caller read the version itself — a
   * stopped store must never look like `missing`, or a file would be skipped as "the
   * store holds nothing". The engine calls `dropSpeculative` when a pass ends and lets
   * every other read settle on its own (a read is read-only, so an engine discarded
   * mid-pass leaves nothing behind but that request); this is the contract a host would
   * need to abandon one outright, and what the cases below use to pin that answer.
   */
  stop(): void {
    this.stopped = true;
    this.demand.clear();
    this.speculative.clear();
    for (const hash of this.known) this.fail(hash);
    this.known.clear();
    this.settleIdle();
  }

  /** Resolve when nothing is queued and nothing is in flight (tests and a drain). */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** A snapshot of the counters; `storedBytes`/`storedEntries` say how full it is. */
  stats(): ContentPrefetchStats {
    return {
      requests: this.requestCount,
      hits: this.hitCount,
      misses: this.missCount,
      storedBytes: this.storedBytes,
      storedEntries: this.store.size,
    };
  }

  /**
   * True when nothing will happen without a caller.
   *
   * A speculative queue that has no room to grow — bytes or entry slots — is **idle**: the
   * read-ahead will not send anything until a `take` frees room, so a drain that waited on
   * it would wait forever. Only requests in flight, demanded hashes, and a queue with room
   * to run, are work.
   */
  private isIdle(): boolean {
    if (this.inFlight.size > 0 || this.demand.size > 0) return false;
    if (this.speculative.size === 0) return true;
    if (this.entryRoom() <= 0) return true;
    const head = this.speculative.values().next().value;
    if (head === undefined) return true;
    // A head that does not fit the room is not going anywhere until a take frees some.
    return this.room() < head.sizeBytes + COMBINED_ENVELOPE_BYTES;
  }

  /**
   * Start as many requests as the limits allow, each with as many hashes as it can take.
   *
   * **Backpressure is by bytes, not by queue length.** The read-ahead may only be ahead of
   * the reader by what the store can hold: bytes fetched and not yet taken, plus the
   * requests in flight, against `storeBytes` (see `nextBatch`). Without that a fast link
   * and a slow writer — a phone decrypting and writing, the case the memory bound exists
   * for — would let the reader outrun the consumer, the LRU would evict entries nobody had
   * consumed, and those pulls would fall back to the wave batch: more bytes than the
   * read-ahead saves. The consumer frees room in `take`, which pumps again.
   */
  private pump(): void {
    while (!this.stopped && this.requestsInFlight < this.limits.concurrency) {
      const batch = this.nextBatch();
      if (batch === null) break;
      void this.send(batch);
    }
    this.settleIdle();
  }

  /**
   * Take the next request's worth of hashes off the queues, demanded ones first.
   *
   * A **demanded** batch ignores the room checks: a caller is blocked on it, and every one
   * of its hashes is taken as soon as it lands. A speculative one may only use the room
   * that is left — bytes **and** entry slots, both counting what is in flight — so a
   * read-ahead can never push the store past either cap (which would make `remember` evict
   * an entry nobody had consumed, and that pull would cost a second read: the exact loss
   * this exists to prevent).
   *
   * The first hash of a demand always goes, whatever its size; a speculative batch admits
   * only what fits. Waiting for a full batch would put a timer in the pipeline, which is
   * what made an early version of the batch route slower than one request per file.
   */
  private nextBatch(): QueuedCandidate[] | null {
    const demanded = this.takeBatch(this.demand, this.limits.batchBytes, this.limits.batchFiles);
    if (demanded.length > 0) return demanded;

    const room = this.room();
    if (room <= 0 || this.entryRoom() <= 0) return null;
    const speculative = this.takeBatch(
      this.speculative,
      Math.min(this.limits.batchBytes, room),
      Math.min(this.limits.batchFiles, this.entryRoom()),
    );
    return speculative.length === 0 ? null : speculative;
  }

  /** Ciphertext room the read-ahead may still fill: the store's cap minus what it holds. */
  private room(): number {
    return this.limits.storeBytes - this.storedBytes - this.inFlightBytes;
  }

  /** Free entry slots the read-ahead may still fill, counting the ones already asked for. */
  private entryRoom(): number {
    return this.limits.storeEntries - this.store.size - this.inFlight.size;
  }

  /**
   * Fill one request from `queue`, inside the batch's file, byte and entry budgets.
   *
   * A candidate that does not fit is **not** admitted — not even as the first hash of the
   * request — because the request's answers become stored entries and `remember` would then
   * evict one nobody had taken, which is the loss the room check exists to prevent. That
   * rule holds for a demanded batch too: a demanded hash is one a caller is blocked on, so
   * waiting for a take to free room costs it a round trip, never a wrong answer (and the
   * demand queue is what the consumer's own pull is waiting for, so a take is exactly what
   * happens next).
   */
  private takeBatch(
    queue: Map<string, QueuedCandidate>,
    maxBytes: number,
    maxEntries: number,
  ): QueuedCandidate[] {
    const batch: QueuedCandidate[] = [];
    let bytes = 0;
    for (const [hash, candidate] of queue) {
      if (batch.length >= maxEntries) break;
      const charge = candidate.sizeBytes + COMBINED_ENVELOPE_BYTES;
      if (bytes + charge > maxBytes) break;
      queue.delete(hash);
      batch.push(candidate);
      bytes += charge;
    }
    return batch;
  }

  /** Read one batch, settle its hashes and its waiters, then let the queues move again. */
  private async send(batch: readonly QueuedCandidate[]): Promise<void> {
    const bytes = batch.reduce(
      (total, entry) => total + entry.sizeBytes + COMBINED_ENVELOPE_BYTES,
      0,
    );
    // A drop must not be undone by a request that was already flying: the epoch each
    // entry was sent under is what decides whether its bytes are kept.
    const generations = { ...this.generations };
    this.requestsInFlight++;
    this.inFlightBytes += bytes;
    this.requestCount++;
    for (const entry of batch) this.inFlight.add(entry.contentHash);
    try {
      const results = await this.read(batch.map((entry) => entry.contentHash));
      for (const [index, entry] of batch.entries()) {
        const content = results[index];
        this.settle(
          entry.contentHash,
          content === null || content === undefined
            ? { kind: "missing" }
            : { kind: "content", bytes: content },
          generations[entry.source] === this.generations[entry.source],
          entry.source,
        );
      }
    } catch {
      // The request did not happen. Every hash in it is "not prefetched" — the pass's
      // own read is the retry, and it is the one that must raise if it fails.
      for (const entry of batch) this.fail(entry.contentHash);
    } finally {
      this.requestsInFlight--;
      this.inFlightBytes -= bytes;
      this.pump();
    }
  }

  /**
   * Answer one hash with what the request returned, and remember it.
   *
   * `keep` is false for a request that was in flight when a pass dropped its guesses: its
   * caller still gets the answer, but the bytes are not stored for a consumer that has
   * already moved on.
   */
  private settle(
    contentHash: string,
    answer: PrefetchAnswer,
    keep = true,
    source: PrefetchSource | undefined = undefined,
  ): void {
    this.forget(contentHash);
    const waiting = this.waiters.get(contentHash);
    this.waiters.delete(contentHash);
    // Only bytes are kept. A "nothing to apply" answer is **not** cached: a blob can be
    // reclaimed and restored (a retry that finds it again is legitimate), and a cached
    // miss would make the pull path — whose whole rule is "the next pass is the retry" —
    // converge never. A miss costs one extra request when it happens; caching it would
    // cost the file.
    if (keep && !this.stopped && answer.kind === "content")
      this.remember(contentHash, answer, source);
    for (const resolve of waiting ?? []) resolve(answer);
  }

  /** Answer one hash with `failed`, without storing anything. */
  private fail(contentHash: string): void {
    this.forget(contentHash);
    const waiting = this.waiters.get(contentHash);
    this.waiters.delete(contentHash);
    for (const resolve of waiting ?? []) resolve({ kind: "failed" });
  }

  /** Take a hash out of the bookkeeping, wherever it was. */
  private forget(contentHash: string): void {
    this.known.delete(contentHash);
    this.inFlight.delete(contentHash);
    this.demand.delete(contentHash);
    this.speculative.delete(contentHash);
    this.origins.delete(contentHash);
  }

  /**
   * Keep an answer, evicting the oldest until the store is inside its caps again.
   *
   * The bytes are **copied** out of the response: `parseContentBatchBody` answers with
   * views into one buffer, so keeping a view would bind the whole body in memory while the
   * store accounted only the entry's own length — a partially consumed 4 MiB batch would
   * hold 4 MiB for a few kilobytes. Eviction is what makes a wrong guess cheap and a slow
   * consumer harmless: the next `take` for an evicted hash is a miss, and the caller reads
   * it itself.
   */
  private remember(
    contentHash: string,
    answer: PrefetchAnswer,
    source: PrefetchSource | undefined,
  ): void {
    const previous = this.store.get(contentHash);
    if (previous !== undefined) {
      this.store.delete(contentHash);
      this.storedBytes -= storedBytesOf(previous);
    }
    const kept: PrefetchAnswer =
      answer.kind === "content" ? { kind: "content", bytes: answer.bytes.slice() } : answer;
    this.store.set(contentHash, kept);
    this.storedBytes += storedBytesOf(kept);
    const origin = source ?? this.origins.get(contentHash);
    if (origin !== undefined) this.origins.set(contentHash, origin);
    while (
      this.store.size > this.limits.storeEntries ||
      this.storedBytes > this.limits.storeBytes
    ) {
      const oldest = this.store.keys().next();
      if (oldest.done === true) break;
      const evicted = this.store.get(oldest.value);
      this.store.delete(oldest.value);
      this.origins.delete(oldest.value);
      if (evicted !== undefined) this.storedBytes -= storedBytesOf(evicted);
      if (this.store.size === 0) break;
    }
  }

  private settleIdle(): void {
    if (!this.isIdle()) return;
    const waiting = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiting) resolve();
  }
}

/** The ciphertext an answer occupies in the store (a miss occupies none). */
function storedBytesOf(answer: PrefetchAnswer): number {
  return answer.kind === "content" ? answer.bytes.byteLength : 0;
}
