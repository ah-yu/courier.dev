import { isRateLimitError } from "./rate-limit";

/** One answer from the push route, as a batch reads it. */
export interface BatchPushResult {
  status: string;
  error?: string;
}

/**
 * What one file's answer from the push route means.
 *
 * `content_missing` and `stale_base` are answers, not failures: the first says the store
 * does not hold the content a content-less version claimed, the second says the chain moved
 * since this push was decided. Every other status — and a result the server did not include
 * at all — is a refusal the caller reports.
 *
 * The classification is one function because the four call sites answer the three named
 * statuses differently, and inline `status === "…"` chains let a site silently treat
 * `stale_base` (or `content_missing`) as a plain refusal. A create names
 * `baseVersionId: null`, so a stale base cannot reach it — but that is a property of the
 * push, and the caller should have to state which statuses it expects.
 *
 * Lives beside {@link BatchPushResult} rather than in the decision module so it stays off
 * the package surface: it is the batch's answer vocabulary, not a sync rule a host needs.
 */
export type PushResultOutcome = "ok" | "stale_base" | "content_missing" | "refused";

export function classifyPushResult(result: BatchPushResult | undefined): PushResultOutcome {
  switch (result?.status) {
    case "ok":
      return "ok";
    case "stale_base":
      return "stale_base";
    case "content_missing":
      return "content_missing";
    default:
      return "refused";
  }
}

/**
 * The part of a prepared version a batch moves around.
 *
 * `content` is the one field the batch writes: a version whose bytes the store already
 * holds sends no payload, so the ciphertext is only produced when a request needs it.
 */
export interface BatchVersion {
  readonly fileId: string;
  /**
   * The version this push creates. A batch never reads it; the event job's tombstone ledger
   * does, so a refused create half can recognise this device's own tombstone on the fresh
   * chain (`SyncEngine.settleRefusedMove`).
   */
  readonly versionId: string;
  readonly plainPath: string;
  /** How many chunks the payload travels in, or `0` for a single request (see `chunkCount`). */
  readonly chunkCount: number;
  /** Whether the store already holds these bytes, so the payload can be omitted. */
  readonly reusesStoredContent: boolean;
  /** The ciphertext, filled in by the batch before the request. */
  content: Uint8Array | null;
}

/**
 * What a batch needs from the code that owns the versions and the sync rules.
 *
 * Everything semantic stays out here: the batch owns the request window (one request in
 * flight, the file and byte bounds, a limiter that ends the sequence) and answers every
 * version through one of these calls. It never touches the state, the adapter or the API.
 */
export interface PushBatchHost<T extends BatchVersion, M> {
  /** Send one request's worth of versions, in order. */
  send(prepared: readonly T[]): Promise<readonly BatchPushResult[]>;
  /** The version landed: record it as the chain's sync point. */
  applied(prepared: T, meta: M): void;
  /**
   * The server refused the version: settle it with the caller's rules, and answer the
   * failure to record (or `null` when the refusal was handled — a re-decision,
   * a lost response whose bytes the head already holds, a conflict resolved).
   *
   * A throw is recorded as a failure too, so a settlement that fails surfaces at the end
   * of the pass instead of disappearing.
   */
  refused(prepared: T, meta: M, result: BatchPushResult | undefined): Promise<unknown>;
  /**
   * The version will never be sent: drop its echo suppression and any pending identity.
   *
   * Called for a refusal **before** {@link refused}, for a version a limiter leaves
   * unsent, and for every version of a request that failed as a whole.
   */
  forget(prepared: T, meta: M): void;
  /** The ciphertext for a version, encrypted on first use. */
  contentFor(prepared: T): Promise<Uint8Array | null>;
  /**
   * Send one version on its own, naming its chunks: a version above the chunking
   * threshold stages them through their own endpoints and cannot travel in a batch.
   *
   * Answers a failure to record rather than throwing (the caller that has no other way to
   * report it may throw instead — the batch lets that through).
   */
  sendAlone?(prepared: T, meta: M): Promise<unknown>;
  /** One request's answers were all settled: persist the state once, not once per file. */
  settled?(): void;
}

/** The server's bounds for one batched push request. */
export interface PushBatchLimits {
  maxFiles: number;
  maxBytes: number;
}

/** What {@link PushBatch.add} did with the version it was given. */
export type PushQueueOutcome = "queued" | "sent" | "dropped";

/** Options for {@link PushBatch.add}. */
export interface PushQueueOptions {
  /**
   * Start a request at a bound instead of waiting for it.
   *
   * A first bind prepares every new file (read, hash, encrypt path and content) while the
   * previous request is on the wire: waiting would leave the network idle for half the
   * bind (`docs/first-bind-performance.md` measures it). The next batch is at most one, so a
   * pipelined sender still holds two batches — one on the wire, one under construction.
   *
   * Every other caller leaves this off: a burst of vault events and a pass's tombstones
   * send one request at a time, so their failures are settled before the next request is
   * prepared.
   */
  pipelined?: boolean;
}

interface Queued<T, M> {
  readonly prepared: T;
  readonly meta: M;
}

/**
 * One batch of prepared versions on its way to the push route: the wire mechanics both the
 * pass and a burst of local events need, with no sync rule of its own.
 *
 * Three senders share it — a pass's creates (pipelined), a pass's tombstones, and
 * `LocalEventJob` — because they were three copies of the same code: a 100-file / 8 MiB
 * bound, at most one request in flight, a limiter that ends the sequence, the first failure
 * recorded rather than thrown, and every version of a failed request forgotten so the next
 * pass retries it in a batch instead of one request per file.
 *
 * The batch does **not** own what happens to an answer: `applied`, `refused` and `forget`
 * are the caller's, which is what keeps the identity, tombstone and echo rules in one place
 * (the engine) and lets the same window serve a create, a delete and a move.
 */
export class PushBatch<T extends BatchVersion, M = void> {
  private queue: Queued<T, M>[] = [];
  private queuedBytes = 0;
  /** The request on the wire, if any. */
  private inFlight: Promise<unknown> | null = null;
  /** The limiter outlasted its waits: every further request would be refused too. */
  private stopped = false;
  /** The first failure of the sequence; the rest are dropped. */
  private firstFailure: unknown = null;

  constructor(
    private readonly host: PushBatchHost<T, M>,
    private readonly limits: PushBatchLimits,
  ) {}

  /** Whether a limiter ended the sequence (the caller stops preparing more work). */
  get rateLimited(): boolean {
    return this.stopped;
  }

  /** The first failure the sequence recorded, for the caller to raise or report. */
  get failure(): unknown {
    return this.firstFailure;
  }

  /**
   * Whether the queued batch has reached the file bound.
   *
   * A caller whose next version has to be **prepared after** the queued request lands (a
   * tombstone re-checks that its path is still gone, and a write-back can happen while the
   * request is on the wire) asks this before preparing it, so the re-check sees the disk as
   * the request left it.
   */
  get atCapacity(): boolean {
    return this.queue.length >= this.limits.maxFiles;
  }

  /**
   * Queue one version, sending the batch when a bound is crossed.
   *
   * Answers `"dropped"` when a limiter ended the sequence before this version could travel:
   * the caller stops preparing work and leaves the rest to the next pass or event.
   */
  async add(prepared: T, meta: M, options: PushQueueOptions = {}): Promise<PushQueueOutcome> {
    if (this.stopped) return this.drop(prepared, meta);
    try {
      return await this.queueOrSend(prepared, meta, options.pipelined === true);
    } catch (err) {
      // A throw from the adapter or the encryption must not leave this version looking
      // prepared: its state entry was written before the request, and a pass that finds it
      // would push it one request per file (see `dropPendingCreate`).
      this.host.forget(prepared, meta);
      throw err;
    }
  }

  /**
   * Wait for the request in flight, if any, and answer whether the sequence has stopped.
   *
   * A request that failed as a whole is folded into the first failure here, because this is
   * the only place that waits for it (see {@link begin}).
   */
  async settle(): Promise<boolean> {
    const inFlight = this.inFlight;
    if (inFlight !== null) {
      this.inFlight = null;
      this.record(await inFlight);
    }
    return this.stopped;
  }

  /**
   * Send what is queued and wait for it: the tail of a pass, or the end of an event job.
   *
   * A sequence the limiter already ended drops its queue instead: those versions are left
   * for the next pass/event rather than sent into a refusal.
   */
  async drain(): Promise<void> {
    await this.settle();
    if (this.stopped) {
      this.dropQueued();
      return;
    }
    this.begin();
    await this.settle();
  }

  /** Record a failure met outside the batch (a chain read, a prepare, a chunk upload). */
  recordFailure(err: unknown): void {
    this.record(err);
  }

  /**
   * Forget everything still queued: the caller is throwing, and these versions were never
   * sent (their state entries were written before the request, see `dropPendingCreate`).
   *
   * A request already on the wire is not abandoned here — {@link settle} is the only safe
   * way to wait for it, and the caller that throws does so before starting one, or settles
   * first.
   */
  abandon(): void {
    this.dropQueued();
  }

  /** Queue the version, crossing a bound by sending first (or starting, when pipelined). */
  private async queueOrSend(prepared: T, meta: M, pipelined: boolean): Promise<PushQueueOutcome> {
    if (prepared.chunkCount > 0) {
      // A version above the chunking threshold stages its chunks through their own
      // endpoints and then names the upload: it travels alone, after the batch. Whatever is
      // queued goes first — and finishes — so the chunk upload never interleaves with a
      // request, and a limiter that ends the sequence drops this version instead of staging
      // its chunks into the same refused window.
      await this.drain();
      if (this.stopped) return this.drop(prepared, meta);
      this.record(await this.sendAlone(prepared, meta));
      return "sent";
    }
    if (!prepared.reusesStoredContent) {
      prepared.content = await this.host.contentFor(prepared);
    }
    const size = prepared.content?.byteLength ?? 0;
    if (size > this.limits.maxBytes) {
      // A version over the byte bound travels alone: the queued small files go first —
      // and finish — before it starts, so the batch never holds two payloads at once, and
      // the large file is settled before the caller reads the next one.
      await this.drain();
      if (this.stopped) return this.drop(prepared, meta);
      this.enqueue(prepared, meta, size);
      this.begin();
      await this.settle();
      return "sent";
    }
    if (
      this.queue.length >= this.limits.maxFiles ||
      this.queuedBytes + size > this.limits.maxBytes
    ) {
      if (pipelined) {
        // The previous request has to be settled before its slot is reused (one request in
        // flight), but this batch's turn on the wire is not waited for.
        if (await this.settle()) return this.drop(prepared, meta);
        this.begin();
      } else {
        this.begin();
        if (await this.settle()) return this.drop(prepared, meta);
      }
    }
    this.enqueue(prepared, meta, size);
    return "queued";
  }

  /** Start the queued versions on the wire, without waiting for them. */
  private begin(): void {
    if (this.queue.length === 0) return;
    const sending = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    this.inFlight = this.sendNow(sending);
  }

  /** Send one request and settle each answer through the host. */
  private async sendNow(sending: readonly Queued<T, M>[]): Promise<unknown> {
    let results: readonly BatchPushResult[];
    try {
      results = await this.host.send(sending.map(({ prepared }) => prepared));
    } catch (err) {
      // The whole request failed: nothing landed, so no echo can arrive for any of these
      // versions and none of them may stay suppressed. The batch is dropped — its files are
      // retried by the next pass or event — and the failure is recorded for the caller.
      for (const { prepared, meta } of sending) this.host.forget(prepared, meta);
      return err;
    }
    let failure: unknown = null;
    for (const [index, { prepared, meta }] of sending.entries()) {
      const result = results[index];
      if (result?.status === "ok") {
        this.host.applied(prepared, meta);
        continue;
      }
      this.host.forget(prepared, meta);
      try {
        // Not `failure ??= await …`: once a failure exists, `??=` would skip the `await`
        // itself and leave this version unsettled (the same trap the old batch code
        // documented for its tail flush).
        const settled = await this.host.refused(prepared, meta, result);
        if (failure === null) failure = settled;
      } catch (err) {
        // One version the settlement refuses must not cost the rest of the request: the
        // versions after it were answered by the same request, and leaving them unsettled
        // would drop their sync points.
        if (failure === null) failure = err;
      }
    }
    this.host.settled?.();
    return failure;
  }

  /** Send a chunked version on its own, turning a missing host into a clear failure. */
  private async sendAlone(prepared: T, meta: M): Promise<unknown> {
    if (this.host.sendAlone === undefined) {
      return new Error(`${prepared.plainPath} is chunked, but this batch cannot send one alone`);
    }
    return await this.host.sendAlone(prepared, meta);
  }

  private enqueue(prepared: T, meta: M, size: number): void {
    this.queue.push({ prepared, meta });
    this.queuedBytes += size;
  }

  /** Forget one version the sequence will never send, and answer {@link PushQueueOutcome}. */
  private drop(prepared: T, meta: M): PushQueueOutcome {
    this.host.forget(prepared, meta);
    return "dropped";
  }

  private dropQueued(): void {
    const queued = this.queue;
    this.queue = [];
    this.queuedBytes = 0;
    for (const { prepared, meta } of queued) this.host.forget(prepared, meta);
  }

  private record(failure: unknown): void {
    if (failure === null || failure === undefined) return;
    if (isRateLimitError(failure)) this.stopped = true;
    if (this.firstFailure === null) this.firstFailure = failure;
  }
}
