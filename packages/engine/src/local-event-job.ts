import { isRateLimitError } from "./rate-limit";
import type { FileStamp } from "./adapter";

/**
 * The state and the wire mechanics of one burst of local vault events.
 *
 * A bulk write — an agent, a script, a folder operation — reaches a host as one event per
 * file. Handled one at a time that is one push per file, which the sync route's per-vault
 * allowance refuses after about a minute; {@link LocalEventJob} is the object that lets
 * the burst be decided file by file but travel in batches of 100 (or 8 MiB). The phases
 * that *decide* stay in the engine, which is where the identity and tombstone rules live;
 * this object owns the shared bookkeeping they hand each other:
 *
 * - the change list and the tracked files waiting for the job's one bulk chain read;
 * - the tombstones prepared but not queued yet, so a create that is the other half of a
 *   move can take one back before anything reaches the server;
 * - the versions prepared but not settled yet, so a throw anywhere in the job drops all
 *   of them instead of leaving pending state entries for the next pass to push one
 *   request per file;
 * - the batch itself, its bounds, and the settle/abandon rules for a whole-request
 *   failure and a limiter that outlasted its waits.
 *
 * The engine supplies the semantic half through {@link LocalEventJobHost}; the job never
 * touches the adapter, the API or the state except through it.
 */

/** One event's read of a file: the bytes and the stamp they were taken at. */
export interface JobFileRead {
  bytes: Uint8Array;
  stamp: FileStamp;
}

/** One tracked file's change, waiting for the job's bulk chain read. */
export interface JobTrackedChange {
  fileId: string;
  path: string;
  read: JobFileRead;
}

/**
 * How a refused version is settled.
 *
 * `create` is a chain the engine just generated (its refusal is retried through the
 * version's own lost-response handling); `tracked` is an existing chain, whose refusal is
 * decided again from the fresh chain; `delete` is a tombstone, whose refusal means a peer
 * pushed after the point it was decided from and is settled as the deletion that raced an
 * edit; `rename` is a move, whose refusal is decided again from the fresh chain at the
 * destination.
 */
export type PendingKind = "create" | "tracked" | "delete" | "rename";

/** The part of a prepared version this job moves around. */
export interface JobVersion {
  readonly fileId: string;
  readonly plainPath: string;
  readonly chunkCount: number;
  readonly reusesStoredContent: boolean;
  /** The ciphertext, filled in just before the request. */
  content: Uint8Array | null;
}

/** One prepared version waiting in the batch, and how its refusal is settled. */
export interface JobEntry<T extends JobVersion> {
  prepared: T;
  kind: PendingKind;
}

/** One answer from the push route. */
export interface JobPushResult {
  status: string;
  error?: string;
}

/**
 * What the engine does for the job. Everything semantic — preparing a version, adopting
 * one that landed, settling a refusal, forgetting one that will never be sent — stays
 * behind these, so this file holds no sync rule of its own.
 */
export interface LocalEventJobHost<T extends JobVersion> {
  /** The ciphertext for a version, encrypted on first use; null when it carries none. */
  contentFor(prepared: T): Promise<Uint8Array | null>;
  /** Send one request's worth of versions and return its answers in the same order. */
  push(prepared: readonly T[]): Promise<readonly JobPushResult[]>;
  /** The version landed: adopt it as the sync point. */
  applied(prepared: T): void;
  /** The server refused this version: settle it with the event path's rules. */
  refused(prepared: T, kind: PendingKind): Promise<void>;
  /** Forget a version that will never be sent (echo record and pending state entry). */
  forget(prepared: T): void;
  /**
   * Send one version on its own, with the full single-file settle path: a version above
   * the chunking threshold stages its chunks through their own endpoints first.
   */
  sendAlone(prepared: T): Promise<void>;
  persist(): void;
}

/** The paths one burst covers, already filtered to this device's scope. */
export interface LocalEventLists {
  changed: readonly string[];
  deleted: readonly string[];
  renamed: ReadonlyArray<{ from: string; to: string }>;
}

/** The server's bounds for one batched push request. */
export interface LocalEventBatchLimits {
  maxFiles: number;
  maxBytes: number;
}

/** A prepared tombstone, with the content hash the chain held before the deletion. */
interface Tombstone<T extends JobVersion> {
  entry: JobEntry<T>;
  contentHash: string;
}

/** The ledger a new-file decision can ask about and take a tombstone back from. */
export interface TombstoneLedger {
  /** The chain this job already prepared a delete for, when its bytes match. */
  deletedFileIdForHash(contentHash: string): string | null;
  /** The tombstone this job prepared for `fileId`, if it still holds one. */
  takeBackTombstone(fileId: string): void;
}

export class LocalEventJob<T extends JobVersion> implements TombstoneLedger {
  /**
   * The change list this job decides: the events it was given, plus the destination of
   * any move whose source this device never tracked (that is a create at the new path,
   * appended by the rename phase before this list is walked).
   */
  readonly changes: string[];
  /** Tracked files waiting for the job's one bulk chain read, in arrival order. */
  readonly tracked: JobTrackedChange[] = [];

  private readonly host: LocalEventJobHost<T>;
  private readonly limits: LocalEventBatchLimits;
  private readonly deleted: readonly string[];
  private readonly renamed: ReadonlyArray<{ from: string; to: string }>;
  /** The paths already in {@link changes}, so a move is not decided twice. */
  private readonly pendingChanges: Set<string>;
  /**
   * A path this job deletes **and** a move lands on, with the chain its tombstone must
   * retire first. Captured before the move re-points the destination's mapping.
   */
  private readonly replacedDestinations = new Map<string, string>();
  /** Destinations this job already tombstoned, so the delete pass does not repeat it. */
  private readonly consumedDeletes = new Set<string>();
  /**
   * Tombstones prepared but **not queued yet**, keyed by the chain's fileId.
   *
   * A batch has no arrival order to lean on, and a move the watcher reports as
   * delete+create (the CLI's `fs.watch`, an external tool) must not publish a deletion the
   * chain never had: the create carrying the same content is the other half of the move,
   * and its version is a `rename` on the live head. Holding the tombstones until every
   * change has been decided lets a matching create take its delete back — the chain never
   * leaves the path, so nothing is sent for the old one. Whatever no create consumed goes
   * out afterwards, in arrival order.
   */
  private readonly pendingDeletes = new Map<string, JobEntry<T>>();
  /**
   * Content hash → the delete this same job prepared, so its create finds it without the
   * self-event log's time window: the window is sized for one event, and the tail of a
   * 600-event job (hashing and preparing every file) can outlive it.
   */
  private readonly pendingRenames = new Map<string, string>();
  /**
   * A prepared tombstone, by the path it deletes.
   *
   * A file that disappears and reappears with **different** bytes inside one job would be
   * decided against a remote index that still names the live chain its tombstone is about
   * to remove — a conflict with the very version being deleted. The change phase takes the
   * tombstone back and decides the path as the tracked chain it still is.
   */
  private readonly pendingDeleteByPath = new Map<string, Tombstone<T>>();
  /**
   * Versions prepared but not yet settled (applied or forgotten).
   *
   * Every entry has a pending state entry written before its request went out; a throw
   * anywhere in the job has to drop them all, or the next pass pushes them one request
   * per file — the regression `dropPendingCreate` exists to prevent.
   */
  private readonly preparedPending = new Set<T>();
  private batch: JobEntry<T>[] = [];
  private batchBytes = 0;
  /** The limiter outlasted its waits: every further batch would be refused too. */
  private rateLimitedOut = false;
  /** The first failure of the job; the rest are dropped, and it is thrown at the end. */
  private firstFailure: unknown = null;

  constructor(host: LocalEventJobHost<T>, lists: LocalEventLists, limits: LocalEventBatchLimits) {
    this.host = host;
    this.limits = limits;
    this.changes = [...lists.changed];
    this.pendingChanges = new Set(this.changes);
    this.deleted = lists.deleted;
    this.renamed = lists.renamed;
  }

  get rateLimited(): boolean {
    return this.rateLimitedOut;
  }

  /** The deletions this burst covered, in arrival order. */
  get deletions(): readonly string[] {
    return this.deleted;
  }

  /** The moves this burst covered, in arrival order. */
  get renames(): ReadonlyArray<{ from: string; to: string }> {
    return this.renamed;
  }

  /** Add a destination that a move decided as a change at its new path. */
  noteChange(path: string): void {
    if (this.pendingChanges.has(path)) return;
    this.pendingChanges.add(path);
    this.changes.push(path);
  }

  /** Whether a path is already being decided as a change in this job. */
  hasPendingChange(path: string): boolean {
    return this.pendingChanges.has(path);
  }

  /** Queue one tracked file's already-read change for the job's bulk chain read. */
  track(fileId: string, path: string, read: JobFileRead): void {
    this.tracked.push({ fileId, path, read });
  }

  /**
   * Record that a path this job deletes is also a move's destination, so its tombstone
   * reaches the server before the move's version (see `applyRenames`).
   */
  captureReplacedDestination(path: string, fileId: string): void {
    this.replacedDestinations.set(path, fileId);
  }

  replacedDestination(path: string): string | undefined {
    return this.replacedDestinations.get(path);
  }

  forgetReplacedDestination(path: string): void {
    this.replacedDestinations.delete(path);
  }

  markDeleteConsumed(path: string): void {
    this.consumedDeletes.add(path);
  }

  isDeleteConsumed(path: string): boolean {
    return this.consumedDeletes.has(path);
  }

  /** Remember a prepared tombstone until every change has had its chance to take it back. */
  noteTombstone(path: string, prepared: T, contentHash: string): void {
    const entry: JobEntry<T> = { prepared, kind: "delete" };
    this.pendingDeletes.set(prepared.fileId, entry);
    if (contentHash !== "") this.pendingRenames.set(contentHash, prepared.fileId);
    this.pendingDeleteByPath.set(path, { entry, contentHash });
  }

  /**
   * The tombstone this job still holds for `path`, when it has not been sent or taken
   * back. A tombstone already settled is not one the change phase may revive.
   */
  tombstoneAt(path: string): string | null {
    const tombstone = this.pendingDeleteByPath.get(path);
    if (tombstone === undefined) return null;
    if (this.pendingDeletes.get(tombstone.entry.prepared.fileId) !== tombstone.entry) return null;
    return tombstone.entry.prepared.fileId;
  }

  /**
   * The tombstone this job prepared whose content hash matches, if it still holds one.
   * The self-event log cannot answer this once a burst's tail outlives its window.
   */
  deletedFileIdForHash(contentHash: string): string | null {
    return this.pendingRenames.get(contentHash) ?? null;
  }

  /**
   * Take back a tombstone this job prepared: its chain never left the tree, so nothing is
   * sent for the old path and the file is decided against it as the chain it still is.
   */
  takeBackTombstone(fileId: string): void {
    this.pendingDeletes.delete(fileId);
    for (const [hash, owner] of this.pendingRenames) {
      if (owner === fileId) this.pendingRenames.delete(hash);
    }
    for (const [path, tombstone] of this.pendingDeleteByPath) {
      if (tombstone.entry.prepared.fileId === fileId) this.pendingDeleteByPath.delete(path);
    }
  }

  /** Add one prepared version to the batch, or send it on its own when it cannot share. */
  async add(prepared: T, kind: PendingKind): Promise<void> {
    // Track the version until it is settled: a throw between here and its answer (an
    // encryption failure, a chunk upload, a chain read) must not leave its pending state
    // entry behind — the next pass would push it one request per file.
    this.preparedPending.add(prepared);
    // Whatever has to travel on its own first can drain the limiter; a version that will
    // be refused is dropped here rather than paying another wait window.
    const abandon = (): void => {
      this.host.forget(prepared);
      this.preparedPending.delete(prepared);
    };
    if (prepared.chunkCount > 0) {
      // A version above the chunking threshold stages its chunks through their own
      // endpoints and then names the upload: it travels alone, after the batch.
      await this.flush();
      if (this.rateLimitedOut) {
        abandon();
        return;
      }
      await this.host.sendAlone(prepared);
      this.preparedPending.delete(prepared);
      return;
    }
    // A version the store already holds the bytes for — a move — sends no payload, so it
    // never pays for the ciphertext either (the single-file path skips the same step).
    if (!prepared.reusesStoredContent) prepared.content = await this.host.contentFor(prepared);
    const size = prepared.content?.byteLength ?? 0;
    if (size > this.limits.maxBytes) {
      await this.flush();
      if (this.rateLimitedOut) {
        abandon();
        return;
      }
      this.batch.push({ prepared, kind });
      await this.flush();
      return;
    }
    if (
      this.batch.length >= this.limits.maxFiles ||
      this.batchBytes + size > this.limits.maxBytes
    ) {
      await this.flush();
      if (this.rateLimitedOut) {
        abandon();
        return;
      }
    }
    this.batch.push({ prepared, kind });
    this.batchBytes += size;
  }

  /**
   * Send the versions prepared so far, and settle each answer.
   *
   * A whole-request failure costs the batch (nothing landed, so every echo record and
   * pending identity goes and the next event or pass retries the files from disk). A
   * per-file refusal is handed back to the engine, which settles it with the code the
   * single-file path already uses — duplicating those rules here is how the two paths
   * would drift.
   */
  async flush(): Promise<void> {
    if (this.batch.length === 0) return;
    if (this.rateLimitedOut) {
      this.dropUnsent(this.batch);
      this.batch = [];
      this.batchBytes = 0;
      return;
    }
    const sending = this.batch;
    this.batch = [];
    this.batchBytes = 0;
    let results: readonly JobPushResult[];
    try {
      results = await this.host.push(sending.map(({ prepared }) => prepared));
    } catch (err) {
      this.dropUnsent(sending);
      // A limiter that outlasted its waits ends the job: every further batch would be
      // refused too, and the files are better left for the next event or pass.
      if (isRateLimitError(err)) this.rateLimitedOut = true;
      this.firstFailure ??= err;
      return;
    }
    for (const [index, { prepared, kind }] of sending.entries()) {
      // Settled either way: the version is answered, and its tombstone (if it was one)
      // must not be swept by a later throw in this job.
      this.pendingDeletes.delete(prepared.fileId);
      if (results[index]?.status === "ok") {
        this.host.applied(prepared);
        this.preparedPending.delete(prepared);
        continue;
      }
      this.host.forget(prepared);
      this.preparedPending.delete(prepared);
      try {
        await this.host.refused(prepared, kind);
      } catch (err) {
        this.firstFailure ??= err;
      }
    }
    this.host.persist();
  }

  /** Send the tombstones no move consumed, in the order the deletions arrived. */
  async drainTombstones(): Promise<void> {
    for (const entry of this.pendingDeletes.values()) {
      if (this.rateLimitedOut) break;
      await this.add(entry.prepared, entry.kind);
    }
  }

  /** Flush the last batch and surface the job's first failure, if it has one. */
  async complete(): Promise<void> {
    await this.flush();
    if (this.firstFailure !== null) {
      // A host's failure path reads the error's status/code (a dead credential stops it),
      // so a rare non-Error throw is wrapped rather than stringified.
      throw this.firstFailure instanceof Error
        ? this.firstFailure
        : new Error("local event batch failed", { cause: this.firstFailure });
    }
  }

  /**
   * Drop every version this job prepared but never settled, for a failure outside
   * {@link flush} (a chain read, a prepare, an encryption, a chunk upload, the
   * restore-owner check). Their state entries were recorded before the request, and a
   * pass that finds them would push them one request per file.
   */
  abandon(): void {
    for (const prepared of this.preparedPending) this.host.forget(prepared);
    for (const { prepared } of this.pendingDeletes.values()) this.host.forget(prepared);
  }

  /** Record a failure a phase met; the first one is thrown by {@link complete}. */
  recordFailure(err: unknown): void {
    if (isRateLimitError(err)) this.rateLimitedOut = true;
    this.firstFailure ??= err;
  }

  /** Forget versions that will never be sent: echo records, pending entries, tombstones. */
  private dropUnsent(entries: readonly JobEntry<T>[]): void {
    for (const { prepared } of entries) {
      this.host.forget(prepared);
      this.preparedPending.delete(prepared);
      this.pendingDeletes.delete(prepared.fileId);
    }
  }
}
