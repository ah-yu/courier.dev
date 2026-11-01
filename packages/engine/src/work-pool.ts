import { DEFAULT_OP_QUEUE_LIMITS, type OpQueueLimits, type OpWeight } from "./op-queue";

/**
 * A bounded pool for the work **inside** one pass.
 *
 * The host already bounds event-driven work with `OpQueue`; a full reconcile was
 * serial for a different reason (it decides from one snapshot and pushes as it goes),
 * and that reason does not require one file at a time: every item the pass schedules is
 * a different fileId, so the state mutations it makes are disjoint. What serialising
 * did cost is the network: a cold start pulled one file per round trip, which on a
 * phone is the whole latency of the sync.
 *
 * Paths are not always disjoint even when fileIds are: a peer's move can leave two
 * chains naming one path for a moment. `SyncEngine` serialises those through
 * `PathClaims`; this pool only bounds how many may run.
 *
 * This is the awaitable half of the same policy `OpQueue` implements for events:
 *
 * - at most `maxConcurrent` small operations run at once;
 * - an operation at or above `exclusiveBytes` runs alone, and — because the queue is
 *   FIFO — also holds back the small operations behind it, so a steady stream of notes
 *   cannot starve a large attachment;
 * - nothing here decides *what* to do with a file; the pool only decides how many of
 *   the pass's per-file operations may be in flight. The engine's no-lock rule (nothing
 *   ever waits on a path) is untouched: a pool slot never waits on another slot.
 */
export class WorkPool {
  private readonly waiting: WaitingTask[] = [];
  private inFlight = 0;
  private exclusiveInFlight = false;

  constructor(private readonly limits: OpQueueLimits = DEFAULT_OP_QUEUE_LIMITS) {}

  /** How many tasks are running right now (diagnostics and tests). */
  get running(): number {
    return this.inFlight;
  }

  /** How many tasks are waiting for a slot (diagnostics and tests). */
  get queued(): number {
    return this.waiting.length;
  }

  /**
   * Run `task` as soon as the limits allow, and answer with **its** result.
   *
   * A rejected task rejects this promise and frees its slot for the next one. The
   * caller of a pass awaits every task, so one failure is collected by the caller
   * rather than dropping the unstarted work behind it.
   */
  run<T>(weight: OpWeight, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({
        weight,
        run: task,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.pump();
    });
  }

  private pump(): void {
    for (;;) {
      const next = this.waiting[0];
      if (!next) return;
      if (next.weight === "exclusive") {
        if (this.inFlight > 0) return;
      } else if (this.exclusiveInFlight || this.inFlight >= this.limits.maxConcurrent) {
        return;
      }

      this.waiting.shift();
      this.inFlight++;
      if (next.weight === "exclusive") this.exclusiveInFlight = true;

      void Promise.resolve()
        .then(next.run)
        .then(next.resolve, next.reject)
        .finally(() => {
          this.inFlight--;
          if (next.weight === "exclusive") this.exclusiveInFlight = false;
          this.pump();
        });
    }
  }
}

interface WaitingTask {
  weight: OpWeight;
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}
