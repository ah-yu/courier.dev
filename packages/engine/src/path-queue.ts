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
 * The engine's inner work (`pullRemote`, `conflicts.resolve`, `pushFile`) is called directly
 * from inside the job for that reason.
 */
export type PathJobOrigin = "event" | "pass" | "batch";

export class PathQueue {
  /** path → the tail of the jobs queued for it (always a promise that cannot reject). */
  private readonly tails = new Map<string, Promise<void>>();
  /** path → queued jobs per origin, so a pass can tell an event from a sibling task. */
  private readonly queued = new Map<string, Map<PathJobOrigin, number>>();

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
  hasQueued(path: string, origin?: PathJobOrigin): boolean {
    const byOrigin = this.queued.get(path);
    if (!byOrigin) return false;
    if (origin !== undefined) return (byOrigin.get(origin) ?? 0) > 0;
    for (const count of byOrigin.values()) if (count > 0) return true;
    return false;
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
  run<T>(
    paths: readonly string[],
    job: () => Promise<T> | T,
    origin: PathJobOrigin = "pass",
  ): Promise<T> {
    // The order does not matter (the wait is before the run, never while holding
    // another path); a stable set keeps the tail map deterministic enough to read.
    const keys = [...new Set(paths)];
    for (const key of keys) {
      const byOrigin = this.queued.get(key) ?? new Map<PathJobOrigin, number>();
      byOrigin.set(origin, (byOrigin.get(origin) ?? 0) + 1);
      this.queued.set(key, byOrigin);
    }
    const previous = keys.map((key) => this.tails.get(key) ?? RESOLVED);
    const start = Promise.all(previous).then(() => {
      // This job has started: what remains in `queued` is the work behind it.
      for (const key of keys) {
        const byOrigin = this.queued.get(key);
        if (!byOrigin) continue;
        const remaining = (byOrigin.get(origin) ?? 1) - 1;
        if (remaining > 0) byOrigin.set(origin, remaining);
        else byOrigin.delete(origin);
        if (byOrigin.size === 0) this.queued.delete(key);
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
