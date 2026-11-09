import { MAX_CONTENT_BATCH_FILES } from "@courier/shared";
import type { SyncApi } from "./api";
import type { ContentPrefetcher } from "./content-prefetch";
import type { Platform, TimerHandle } from "./platform";

/**
 * How long a whole-file content read waits for other reads to travel with it (ms).
 *
 * The wait only applies to a batch that is **not** full: the pool's concurrency is the most
 * reads that can be outstanding, so a batch that many entries is flushed at once (see
 * {@link ContentReader.read}). This timer covers the tail of a pass, where fewer files are
 * left than the pool could run.
 *
 * `0` — the next turn of the event loop — is deliberate: a timer here is a *sync point* in
 * the download pipeline, and every millisecond of it is paid once per wave (250 waves for
 * 1 000 files). Waiting longer than a turn made a 1 000-file cold bind slower than one
 * request per file; one turn is free next to a network round trip and still groups the
 * reads that finish together.
 */
const CONTENT_BATCH_WINDOW_MS = 0;

/**
 * Most plaintext one content batch may name.
 *
 * The batch holds every file's ciphertext until the request is answered, so this is what
 * bounds a download's memory; a file above it travels alone. The server's own bound is
 * `MAX_CONTENT_BATCH_BYTES`, twice this, so a batch built here is always accepted.
 */
const CONTENT_BATCH_MAX_BYTES = 8 * 1024 * 1024;

/** One file waiting for the next batched content read. */
interface PendingContent {
  /** The version's plaintext size, for the batch's byte budget. */
  sizeBytes: number;
  resolve: (bytes: Uint8Array | null) => void;
  reject: (err: unknown) => void;
}

export interface ContentReaderOptions {
  api: SyncApi;
  vaultId: string;
  platform: Platform;
  /**
   * How many per-file operations one pass may run at once.
   *
   * A batch that many entries cannot grow — the reads waiting for content are exactly the
   * operations using the pool — so it is flushed at once instead of waiting for the timer.
   */
  maxConcurrent: number;
  /** The read-ahead beside the per-file loop, or `null` when the host turned it off. */
  prefetcher: ContentPrefetcher | null;
  /** How a request waits out a rate limiter's window (the engine's `withRateLimitWaits`). */
  wait: <T>(send: () => Promise<T>) => Promise<T>;
}

/**
 * The ciphertext of every whole-file version a pass or a notification burst pulls, read in
 * batches. A version above the chunking threshold never reaches this class: it travels
 * through the ranged path (`fetchRemoteChunk`), and the read-ahead refuses it as a candidate.
 *
 * A download used to be one content request per file, and that was the last per-file cost on
 * the sync path (`docs/first-bind-performance.md`): a first bind of 50 000 files made 50 000
 * requests. The engine runs a few per-file operations at a time, so a short window groups
 * their reads into one request (the server answers several versions per route, see
 * `buildContentBatchBody`), and a lone read still costs one request.
 *
 * The read-ahead is consulted first: a hit costs no request at all, and a miss falls back to
 * the batch. The two are interchangeable because they read the same route and answer the
 * same "nothing to apply" — a read-ahead whose request failed answers `failed`, which is a
 * **miss**, not a missing blob, so reading it again here is what keeps a dropped connection
 * from looking like a reclaimed one.
 */
export class ContentReader {
  /** Whole-file content reads waiting for the next batched request. */
  private pending = new Map<string, PendingContent[]>();
  /** Plaintext bytes the pending batch would fetch, for its memory bound. */
  private pendingBytes = 0;
  /** The timer that flushes {@link pending}; `null` when none is armed. */
  private timer: TimerHandle | null = null;

  constructor(private readonly opts: ContentReaderOptions) {}

  /**
   * One version's ciphertext: from the read-ahead when it holds it, otherwise the wave batch
   * that a pass or a burst forms from the reads it is making right now.
   *
   * A read-ahead answer that is not content (a missing blob, or a request that failed) is
   * resolved here rather than in the batch: `null` means the store holds nothing, and only
   * a failure is worth reading again.
   */
  async read(contentHash: string, sizeBytes: number): Promise<Uint8Array | null> {
    const prefetched = this.opts.prefetcher?.take(contentHash);
    if (prefetched === undefined) return await this.queue(contentHash, sizeBytes);
    const answer = await prefetched;
    if (answer.kind === "content") return answer.bytes;
    if (answer.kind === "missing") return null;
    return await this.queue(contentHash, sizeBytes);
  }

  /**
   * The ciphertext of `contentHashes`, in one request.
   *
   * Exposed because the download read-ahead sends its own speculative batches through the
   * same route and the same limiter handling.
   */
  async fetch(contentHashes: readonly string[]): Promise<Array<Uint8Array | null>> {
    return await this.opts.wait(() =>
      this.opts.api.getVersionContents(this.opts.vaultId, [...contentHashes]),
    );
  }

  /**
   * Hold `contentHash` for at most {@link CONTENT_BATCH_WINDOW_MS} to travel with the reads
   * other files of the same pass or burst are making.
   *
   * `sizeBytes` is the version's plaintext size: the batch's byte budget is what bounds the
   * memory a batch holds, and a file big enough to fill it travels alone.
   */
  private queue(contentHash: string, sizeBytes: number): Promise<Uint8Array | null> {
    return new Promise((resolve, reject) => {
      // The same content is often needed by more than one file (a copy, or two chains that
      // converged): one entry in the request answers all of them.
      const waiting = this.pending.get(contentHash);
      if (waiting !== undefined) {
        waiting.push({ sizeBytes, resolve, reject });
        return;
      }
      if (this.pendingBytes > 0 && this.pendingBytes + sizeBytes > CONTENT_BATCH_MAX_BYTES) {
        this.flush();
      }
      this.pending.set(contentHash, [{ sizeBytes, resolve, reject }]);
      this.pendingBytes += sizeBytes;
      // A full wave goes out at once: the pool's concurrency is how many per-file
      // operations can be waiting for content, so that many entries is a batch that cannot
      // grow — waiting for the timer would only add a turn to every wave.
      // A batch never names more hashes than the route accepts, whatever the pool runs:
      // `opLimits` is caller-settable, and a request the schema refuses would reject every
      // waiter and fail the pass.
      const batchFiles = Math.min(this.opts.maxConcurrent, MAX_CONTENT_BATCH_FILES);
      if (this.pending.size >= batchFiles) {
        this.flush();
        return;
      }
      this.timer ??= this.opts.platform.after(CONTENT_BATCH_WINDOW_MS, () => {
        this.timer = null;
        this.flush();
      });
    });
  }

  /** Send the held content reads as one request, and settle every waiter for each hash. */
  private flush(): void {
    if (this.timer !== null) {
      this.timer.cancel();
      this.timer = null;
    }
    if (this.pending.size === 0) return;
    const hashes = [...this.pending.keys()];
    const waiting = this.pending;
    this.pending = new Map();
    this.pendingBytes = 0;
    void this.fetch(hashes).then(
      (results) => {
        for (const [index, hash] of hashes.entries()) {
          for (const waiter of waiting.get(hash) ?? []) waiter.resolve(results[index] ?? null);
        }
      },
      (err: unknown) => {
        for (const waiters of waiting.values()) for (const waiter of waiters) waiter.reject(err);
      },
    );
  }
}
