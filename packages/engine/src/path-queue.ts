/**
 * One FIFO per path.
 *
 * Every engine operation that may read or write a path runs as a job that starts after the
 * jobs already queued for that path have settled, and holds the path until it ends. Two
 * jobs on one path therefore never interleave: a pull's write and its sync point are one
 * job, so no other decision can observe the half-applied state between them (see
 * `docs/sync-engine.md#pass-order-and-concurrency`).
 *
 * A job may name several paths (a rename touches the old and the new one); it waits for
 * all of them and holds all of them. The wait happens **before** the job runs — a job never
 * holds a path while waiting for another — so two multi-path jobs cannot form a cycle.
 *
 * A job must not call {@link run} for a path it already holds: it would wait for itself.
 * The engine's inner work (`pullRemote`, `handleConflict`, `pushFile`) is called directly
 * from inside the job for that reason.
 */
export class PathQueue {
  /** path → the tail of the jobs queued for it (always a promise that cannot reject). */
  private readonly tails = new Map<string, Promise<void>>();
  /** path → how many jobs are queued for it and have not started yet. */
  private readonly queued = new Map<string, number>();

  /** How many paths currently have a job queued or running (diagnostics and tests). */
  get size(): number {
    return this.tails.size;
  }

  /**
   * Whether a job for `path` is queued behind the one running now.
   *
   * A pass's job uses this before acting on a snapshot: an event that arrived while it
   * was deciding is queued behind it, so its decision is already stale and belongs to
   * that event's job instead.
   */
  hasQueued(path: string): boolean {
    return (this.queued.get(path) ?? 0) > 0;
  }

  /**
   * Resolve once no job is queued or running.
   *
   * A job can queue another (a pass's job decides, a conflict's job pulls), so this
   * re-reads the tails after each round instead of awaiting one snapshot.
   */
  async whenIdle(): Promise<void> {
    while (this.tails.size > 0) {
      await Promise.all(this.tails.values());
    }
  }

  /**
   * Run `job` after every job already queued for `paths` has settled, and answer its
   * result (or its rejection). The paths are held until the job settles, including when it
   * throws.
   */
  run<T>(paths: readonly string[], job: () => Promise<T> | T): Promise<T> {
    // The order does not matter (the wait is before the run, never while holding
    // another path); a stable set keeps the tail map deterministic enough to read.
    const keys = [...new Set(paths)];
    for (const key of keys) this.queued.set(key, (this.queued.get(key) ?? 0) + 1);
    const previous = keys.map((key) => this.tails.get(key) ?? RESOLVED);
    const start = Promise.all(previous).then(() => {
      // This job has started: what remains in `queued` is the work behind it.
      for (const key of keys) {
        const remaining = (this.queued.get(key) ?? 1) - 1;
        if (remaining > 0) this.queued.set(key, remaining);
        else this.queued.delete(key);
      }
      return job();
    });
    // The tail never rejects: a failed job must not hold its paths, and must not fail the
    // jobs queued behind it — each job answers its own caller.
    const tail = start.then(
      () => undefined,
      () => undefined,
    );
    for (const key of keys) {
      this.tails.set(key, tail);
      void tail.then(() => {
        // Only the last job queued for the path removes the entry, so a newer tail is
        // never dropped by an older job settling.
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });
    }
    return start;
  }
}

/** The tail of a path with no queued job. */
const RESOLVED: Promise<void> = Promise.resolve();
