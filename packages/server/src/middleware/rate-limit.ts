import { RateLimitError } from "../lib/errors";

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
  keyPrefix?: string;
}

const stores = new Map<string, Map<string, RateLimitEntry>>();

/**
 * How often expired entries are swept out of every store (ms).
 *
 * The sweep exists because a limiter keyed by vault id accumulates one entry per vault
 * that ever made a request, and nothing else would ever remove them.
 */
const SWEEP_INTERVAL_MS = 60_000;

let sweep: Timer | null = null;

/**
 * Start the sweep the first time a limiter is built.
 *
 * It used to run at **import** time, from a module that is imported by the app, the
 * routes and the test harnesses: importing anything that reached this file started a
 * timer, and a timer that is never `unref`'d keeps a process alive. Starting it when a
 * limiter actually exists, and unreferencing it, means a CLI command or a test that only
 * touches the app does not acquire a background timer it never asked for.
 */
function ensureSweep(): void {
  if (sweep !== null) return;
  sweep = setInterval(() => {
    const now = Date.now();
    for (const store of stores.values()) {
      for (const [key, entry] of store) {
        if (now > entry.resetAt) {
          store.delete(key);
        }
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweep.unref?.();
}

function getStore(keyPrefix: string): Map<string, RateLimitEntry> {
  let store = stores.get(keyPrefix);
  if (!store) {
    store = new Map<string, RateLimitEntry>();
    stores.set(keyPrefix, store);
  }
  return store;
}

/** The bucket check on its own, for the Bun route table (no Hono in the type). */
export interface RateLimiter {
  /** Throw `RateLimitError` when this vault has spent its window. */
  check(vaultId: string): void;
}

export function createRateLimiter(opts: RateLimitOptions): RateLimiter {
  const { maxAttempts, windowMs, keyPrefix = "default" } = opts;
  const store = getStore(keyPrefix);
  ensureSweep();

  return {
    check(vaultId: string): void {
      const key = `${keyPrefix}:${vaultId}`;
      const now = Date.now();

      const entry = store.get(key);
      if (entry && now > entry.resetAt) {
        store.delete(key);
      }

      const current = store.get(key);
      if (current && current.count >= maxAttempts) {
        const retryAfter = Math.max(1, Math.ceil((current.resetAt - now) / 1000));
        throw new RateLimitError(
          `Rate limit exceeded. Please try again in ${retryAfter} seconds.`,
          retryAfter,
        );
      }

      if (!store.has(key)) {
        store.set(key, { count: 0, resetAt: now + windowMs });
      }

      store.get(key)!.count++;
    },
  };
}

/**
 * Parse an integer override from the environment, ignoring unusable values so a
 * typo cannot silently disable the limit (`0` and negatives are therefore
 * rejected — use a large number to lift it instead).
 */
function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Sync-route limits, overridable by `SYNC_RATE_LIMIT_MAX_ATTEMPTS` /
 * `SYNC_RATE_LIMIT_WINDOW_MS`.
 *
 * **Sized for a first bind, not for an edit.** One request carries up to 100 files,
 * so 600 requests/minute is 60 000 files/minute — enough that a vault of tens of
 * thousands of files binds inside one or two windows, while a steady-state device
 * (about three requests per edit) is nowhere near it. The old 120/min was sized for
 * "one user's devices" in steady state and turned every first bind above ~12 000
 * files into a failed pass followed by five-minute retries
 * (see `docs/first-bind-performance.md`).
 *
 * Read per `toRouteTable()` call (not at import) so the e2e harness can raise the
 * ceiling for its test server: the suite drives two real Obsidian instances that
 * burst well past the production allowance, and a 429 in the middle of a
 * scenario reads as a sync failure instead of the rate limit it is. Production
 * never sets the variables and gets the defaults below.
 */
export function syncRateLimitOptions(): RateLimitOptions {
  return {
    maxAttempts: envPositiveInt("SYNC_RATE_LIMIT_MAX_ATTEMPTS", 600),
    windowMs: envPositiveInt("SYNC_RATE_LIMIT_WINDOW_MS", 60_000),
    keyPrefix: "sync",
  };
}

/**
 * Limits for the **transfer** routes: version content, chunk staging and upload status.
 *
 * These are not "requests the user makes"; they are the blocks of one file. A 50 MiB
 * version is 13 ranges and a 1 GiB one is 256, so sharing the sync allowance made a
 * large download impossible to finish (each failed pass restarted at chunk 0). The
 * budget is per vault like the sync one, but high enough that a full download plus a
 * retry fits in a minute; the push itself still uses the sync limiter.
 *
 * It is also the ceiling on a **first download**: a content request carries a wave of
 * reads (four today, up to 64 when the client's prefetch pipeline lands), so 60 000/min
 * is what lets a 50 000-file remote vault arrive without being truncated silently (see
 * `docs/first-bind-performance.md`). A client that is
 * refused anyway waits the window out (the engine does), so this number bounds how long
 * a download takes, not whether it completes.
 *
 * Overridable with `SYNC_TRANSFER_RATE_LIMIT_MAX_ATTEMPTS` /
 * `SYNC_TRANSFER_RATE_LIMIT_WINDOW_MS`, read per `toRouteTable()` call like the sync pair.
 */
export function syncTransferRateLimitOptions(): RateLimitOptions {
  return {
    maxAttempts: envPositiveInt("SYNC_TRANSFER_RATE_LIMIT_MAX_ATTEMPTS", 60_000),
    windowMs: envPositiveInt("SYNC_TRANSFER_RATE_LIMIT_WINDOW_MS", 60_000),
    keyPrefix: "sync-transfer",
  };
}
