import type { SyncAction, VersionChainEntry } from "@courier/shared";
import type { FileStamp, SyncAdapter } from "./adapter";
import { conflictFilePath } from "./conflict-file";
import { remoteHead } from "./decide";
import type { ConflictResolvedEvent } from "./engine-events";
import { settingsGroupOf, type SyncScope } from "./sync-scope";

/** What the resolver needs from the engine: five narrow calls, no engine state. */
export interface ConflictResolverOptions {
  /** Which paths this device syncs, for the config-folder rule. */
  scope: SyncScope;
  /** The conflict copy's own file operations (a raw write, never a self-write record). */
  adapter: Pick<SyncAdapter, "readFile" | "writeFile" | "statFile">;
  onConflictResolved?: (event: ConflictResolvedEvent) => void;
  /**
   * Apply the remote head locally, and answer whether the local side now matches it
   * (the engine's `pullRemote`: a live head is written at the path its version records, a
   * `delete` head removes the local file).
   */
  applyRemote(
    fileId: string,
    plainPath: string,
    head: VersionChainEntry,
    localContentHash: string | null,
    deviceName: string | null,
  ): Promise<boolean>;
  /** Push one version (the engine's `pushFile`). */
  push(request: {
    fileId: string;
    plainPath: string;
    action: SyncAction;
    bytes: Uint8Array;
    baseVersionId: string | null;
    stamp: FileStamp | null;
  }): Promise<void>;
  /** The local half of the size cap, asked before any read (the engine's `withinLocalSizeCap`). */
  withinSizeCap(path: string): Promise<boolean>;
  /** Read a local file and the stamp it came with (the engine's `readWithStamp`). */
  readLocal(path: string): Promise<{ bytes: Uint8Array; stamp: FileStamp | null } | null>;
  /**
   * The fresh chain when a push was refused with `stale_base`, or null when `err` is not a
   * refusal. The engine answers this from `SyncPushBaseError`; the resolver never needs the
   * error class itself.
   */
  refusalChain(err: unknown): readonly VersionChainEntry[] | null;
}

/**
 * A conflict, resolved on this device.
 *
 * There are two rules, decided by the path.
 *
 * **A config-folder path** (`settingsGroupOf` answers a group) resolves by **last
 * modification time** and reports nothing: a conflict copy parked in `.obsidian/` is
 * invisible to Obsidian's file explorer, so there is no way for the user to see or act on
 * it. The newer side wins — the local file is pushed over the head when it is newer, the
 * remote head is applied when it is not — and no `onConflictResolved` event is raised,
 * because nothing the host could say would be actionable.
 *
 * **Everywhere else** the remote head wins, and the local content — when there is any — is
 * parked beside the file as a conflict copy so nothing the user wrote is thrown away.
 *
 * The remote side is applied through `applyRemote`, which already knows both shapes. A
 * local side that no longer exists — this device deleted the file and a peer edited it —
 * has nothing to park; the file simply comes back.
 *
 * The local bytes are read **before** the remote side is applied — that write (or deletion)
 * is what would otherwise destroy the only copy of them — but the copy is parked, and the
 * conflict announced, only once the remote head is really in place. It used to be the other
 * way round, which meant a conflict whose content could not be read (a missing or truncated
 * blob, a request that failed) was reported as "the remote version won, your copy is at …"
 * while the note still held the local text — and, since the same decision came up from the
 * same bytes, it parked one more copy on every pass.
 */
export class ConflictResolver {
  constructor(private readonly opts: ConflictResolverOptions) {}

  /**
   * Resolve one conflict, and answer whether the local side now matches the decision.
   *
   * `plainPath` is where the local side lived; that is the path the conflict file is named
   * after, even when the remote head records a different one. `false` means the remote side
   * could not be applied (its content was unreadable, or the push could not be made): the
   * caller reports that instead of assuming the conflict was settled.
   */
  async resolve(
    fileId: string,
    plainPath: string | null,
    head: VersionChainEntry | undefined,
    localExists: boolean,
    deviceName: string | null = null,
  ): Promise<boolean> {
    if (!head) return true;
    if (!plainPath) return true;

    // Ownership is the test, not "is inside the config folder": it answers null for a path
    // nothing may sync, and a path in a group this device has off never reaches a conflict
    // at all (the scope guard drops it upstream).
    if (settingsGroupOf(plainPath, this.opts.scope) !== null) {
      return await this.resolveSettings(fileId, plainPath, head, localExists, deviceName);
    }

    const localBytes = localExists ? await this.opts.adapter.readFile(plainPath) : null;
    if (localExists && !localBytes) return true;

    const applied = await this.opts.applyRemote(fileId, plainPath, head, null, deviceName);
    if (!applied) return false;

    const conflictPath = localBytes === null ? null : await this.park(plainPath, localBytes);
    this.opts.onConflictResolved?.({
      fileId,
      plainPath,
      conflictPath,
      remoteAction: head.action === "delete" ? "delete" : "write",
    });
    return true;
  }

  /**
   * Settle a config-folder conflict by **last modification time**, with no copy and no
   * event.
   *
   * The local file's stamp is compared with the head's `mtimeMs` — the modification time
   * the pushing device recorded — so the answer is "who changed it last", not "who pushed
   * last". That is what makes an edit made offline win over a peer's later push when it
   * really was the later edit. A tie or a missing stamp resolves to the remote head: both
   * devices apply the same rule, so a tie converges instead of letting them push past each
   * other. A local file that vanishes between the size check and the read is not settled
   * here at all — the next pass decides it.
   *
   * A local side that no longer exists — this device deleted the file and a peer edited it
   * — has nothing to compare or keep, so the remote head is applied. A deletion this device
   * never pushed carries no timestamp to argue with.
   *
   * The local-won branch is a normal conditional push (`baseVersionId` = the head). It
   * pushes at **the path the local file actually has**, not at the path the head records: a
   * version names the path its bytes live at, and writing one for a path whose file sits
   * somewhere else is how one chain ends up claiming two paths. A peer that moved the file
   * while this device edited it therefore follows the win back to this path — the same "the
   * winning side's content, at the winning side's path" the vault-file rule gives when the
   * remote side wins.
   *
   * A refusal is answered by deciding again from the chain the server just showed us. A
   * second refusal is contention, not failure — nothing was written and nothing was lost —
   * so it is answered `true` and left to the next pass, which the settings poll runs every
   * second. Answering `false` there would make a notification report a failed conflict for
   * a race the engine simply lost twice.
   */
  private async resolveSettings(
    fileId: string,
    plainPath: string,
    head: VersionChainEntry,
    localExists: boolean,
    deviceName: string | null,
  ): Promise<boolean> {
    if (!localExists) return await this.opts.applyRemote(fileId, plainPath, head, null, deviceName);

    let currentHead = head;
    for (let attempt = 0; attempt < 2; attempt++) {
      // The local half of the size cap, asked **before** the read and for the same reason as
      // everywhere else: the engine hashes and encrypts the whole file in memory. A file
      // that grew past the cap between the listing and this conflict is skipped and
      // reported, exactly like one the list already filtered out.
      if (!(await this.opts.withinSizeCap(plainPath))) {
        // `false` is "too large" (reported) or "vanished since the listing", and the next
        // pass decides the latter.
        return true;
      }
      const read = await this.opts.readLocal(plainPath);
      // The file vanished between the size check and here: the next pass decides.
      if (!read) return true;
      const { bytes, stamp } = read;
      // A missing stamp is treated as "no usable modification time", which loses to any
      // real remote version — the same answer a tie gets.
      const localMtimeMs = Math.max(0, Math.floor(stamp?.mtimeMs ?? 0));
      if (localMtimeMs <= currentHead.mtimeMs) {
        // No content hash is offered: the losing side's bytes differ from the head's by
        // definition, so the "this device already holds them" shortcut cannot apply. It has
        // to write the winner's bytes over them.
        return await this.opts.applyRemote(fileId, plainPath, currentHead, null, deviceName);
      }
      try {
        await this.opts.push({
          fileId,
          plainPath,
          // A live head is modified; a tombstone means the file is being brought back,
          // which is a `restore` on the same chain (the recycle bin's own action).
          action: currentHead.action === "delete" ? "restore" : "modify",
          bytes,
          baseVersionId: currentHead.versionId,
          stamp,
        });
        return true;
      } catch (err) {
        const chain = this.opts.refusalChain(err);
        // Anything but a refusal means the push could not be made at all (the file could
        // not be read, the network is down): the callers report that instead of assuming
        // the conflict was settled.
        if (chain === null) return false;
        // A second refusal: a third party keeps pushing. Nothing was written, so this is
        // not a failure — the next pass decides again from the newer chain.
        if (attempt === 1) return true;
        const fresh = remoteHead(chain);
        if (!fresh) return true;
        currentHead = fresh;
      }
    }
    return true;
  }

  /**
   * Write the local side of a conflict beside the original and return where it landed.
   *
   * The name is `{stem}-{YYYY-MM-DD-HHmmss}.conflict{ext}` — the extension the original has,
   * because the copy has to open in the app that owns it — with a counter when that name is
   * already taken: two copies parked inside the same second must not overwrite each other.
   * The timestamp is taken once, so every candidate this call tries names the same instant.
   *
   * Deliberately a raw adapter write: the copy must not be recorded as a self-write, and the
   * scope refuses conflict copies on the way in, so nothing re-syncs it.
   */
  private async park(plainPath: string, bytes: Uint8Array): Promise<string> {
    const now = new Date();
    for (let index = 1; ; index++) {
      const candidate = conflictFilePath(plainPath, now, index);
      if ((await this.opts.adapter.statFile(candidate)) === null) {
        await this.opts.adapter.writeFile(candidate, bytes);
        return candidate;
      }
    }
  }
}
