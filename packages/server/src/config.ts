import { existsSync } from "fs";
import path, { dirname, resolve } from "path";
import { z } from "zod";

/**
 * True for the virtual filesystem a bundled binary reports.
 *
 * `bun build --compile` puts the bundle in a virtual root and points `import.meta.dir`
 * at it: `/$bunfs/root` on Linux, `B:\~BUN\root` on Windows. The runtime considers that
 * directory to exist — `existsSync` says yes — while a write into it never reaches the
 * disk (`mkdir` under it fails with EPERM or ENOENT). Asking "does `import.meta.dir`
 * exist" is therefore not a test that separates a real directory from the virtual one.
 */
export function isBundledPath(dir: string): boolean {
  return dir.includes("~BUN") || dir.startsWith("/$bunfs");
}

/**
 * The directory a deployed binary keeps its `data/` beside.
 *
 * Only the executable's own directory survives a compiled build: it is a real path on
 * the host, and it is what "next to the binary" means for the systemd unit. The virtual
 * path is rejected before `exists` is consulted, because the runtime says it exists.
 */
export function resolveDataDir(
  metaDir: string,
  execPath: string,
  exists: (path: string) => boolean = existsSync,
  dirnameOf: (path: string) => string = dirname,
): string {
  if (!isBundledPath(metaDir) && exists(metaDir)) return metaDir;
  return dirnameOf(execPath);
}

function getExeDir(): string {
  return resolveDataDir(import.meta.dir, process.execPath);
}

const envSchema = z.object({
  SQLITE_PATH: z.string().default("./data/courier.db"),
  BLOB_STORE_DIR: z.string().default("./data/blobs"),
  PORT: z.coerce.number().default(80),
  /** Retention-pruning interval in ms. 0 disables the background job. */
  PRUNE_INTERVAL_MS: z.coerce.number().default(3_600_000),
  /**
   * Largest push body the sync route accepts, in bytes.
   *
   * A push body carries the ciphertext of every file in the batch, so this is the
   * bound on what one request can make the server hold in memory. It has to sit
   * above any account's file cap (an administrator may set `maxFileBytes: 0` for
   * "unlimited"), which is why the default is far above the 50 MiB a client syncs
   * by default: it is a guard against a runaway or hostile body, not a product
   * limit. A body over it is refused with 413 before anything is parsed.
   */
  SYNC_MAX_PUSH_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024 * 1024),
  /**
   * Largest single chunk request a chunked upload may send, in bytes.
   *
   * A chunk is 4 MiB of plaintext plus the 28 bytes of IV and tag, so this is a guard
   * against a malformed or hostile body, not a product limit. The route refuses a
   * larger body before it reads it.
   */
  SYNC_MAX_CHUNK_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(8 * 1024 * 1024),
  /**
   * How long a staged chunk upload is kept before the sweep reclaims it.
   *
   * A client that disconnects mid-upload and never retries would otherwise leave its
   * chunks on disk for good. The sweep measures a directory's own mtime, so a retry
   * keeps the upload alive.
   */
  UPLOAD_TTL_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(24 * 60 * 60 * 1000),
  /**
   * How often staged uploads are swept, in ms. Independent of retention pruning so that
   * turning pruning off does not also stop reclaiming abandoned uploads; `0` disables
   * this loop.
   */
  UPLOAD_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(60 * 60 * 1000),
  /**
   * How old an unreferenced blob must be before the orphan sweep deletes it, in ms.
   *
   * A push writes its blob before the conditional insert; a refused insert leaves it
   * with no row. The age gate keeps a push that is still in flight (blob written, row
   * not yet inserted) out of the sweep's reach. A day is far longer than any insert.
   */
  ORPHAN_TTL_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(24 * 60 * 60 * 1000),
  /**
   * How often unreferenced blobs are swept, in ms. It runs for every vault, including
   * accounts with retention pruning disabled; `0` disables this loop.
   */
  ORPHAN_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(6 * 60 * 60 * 1000),
  /**
   * The identifier the service's certificate is issued for: a public IP literal
   * (RFC 8738) or a DNS name. Empty means plain HTTP — the dev loop and the
   * L1/L2 harnesses must never need TLS.
   */
  TLS_NAME: z.string().default(""),
  /** Optional ACME account contact, e.g. `admin@example.com` (sent as `mailto:`). */
  TLS_EMAIL: z.string().default(""),
  /** Account key, certificate key and chain live here. */
  TLS_DIR: z.string().default("./data/tls"),
  /** The port ACME's http-01 challenge listener binds (ACME validates it on port 80). */
  ACME_CHALLENGE_PORT: z.coerce.number().default(80),
  /** ACME directory; overridden by tests and by Let's Encrypt's staging endpoint. */
  ACME_DIRECTORY_URL: z.string().default("https://acme-v02.api.letsencrypt.org/directory"),
  /**
   * The JSON-lines log file, and the level that gates it.
   *
   * Empty `LOG_FILE` keeps the file sink off: a test run, the dev loop and the L1/L2
   * harnesses must not write one. The deployed unit sets it to
   * `~/courier/logs/courier.log`, which is the path a monitoring client reads over
   * SSH — the web surface never reads the log.
   *
   * The file is rotated by the process itself (`LOG_MAX_BYTES`, keeping
   * `LOG_MAX_FILES` of them) rather than by journald, because it is the one store
   * whose retention this service controls on a machine it does not administer.
   */
  LOG_FILE: z.string().default(""),
  /** `debug` | `info` | `warn` | `error`; an unknown value falls back to `info`. */
  LOG_LEVEL: z.string().default("info"),
  LOG_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
  LOG_MAX_FILES: z.coerce.number().int().min(1).default(3),
  /** A request that took at least this long is logged at warn even when it succeeded. */
  LOG_SLOW_MS: z.coerce.number().int().nonnegative().default(500),
});

const isProd: boolean = process.env.COURIER_ENV === "production";
// The dev loop defaults to 3002, but a second worktree can pass its own port. Only fill in
// the default: an explicit `PORT` belongs to the caller (a test harness, a second dev loop).
if (!isProd && !process.env["PORT"]) {
  process.env["PORT"] = "3002";
}
const rawConfig = envSchema.parse(process.env);
const basedir = isProd ? getExeDir() : path.resolve(import.meta.dirname, "..");

export const config = {
  ...rawConfig,
  SQLITE_PATH: resolve(basedir, rawConfig.SQLITE_PATH),
  BLOB_STORE_DIR: resolve(basedir, rawConfig.BLOB_STORE_DIR),
  TLS_DIR: resolve(basedir, rawConfig.TLS_DIR),
  // An absolute value (the unit passes `%h/courier/logs/courier.log`) wins over
  // the executable's directory; an empty one stays empty, which means "no file".
  LOG_FILE: rawConfig.LOG_FILE === "" ? "" : resolve(basedir, rawConfig.LOG_FILE),
};
