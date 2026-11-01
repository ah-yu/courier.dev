import type { DataAdapter, FileManager, TAbstractFile, TFile, Vault } from "obsidian";
import {
  DEFAULT_SYNC_SCOPE,
  isConflictFile,
  isConfigPath,
  isExcludedPath,
  isSyncableDir,
  isSyncablePath,
  syncsAnySettings,
  type FileStamp,
  type SyncAdapter,
  type SyncScope,
  type SyncWriteStream,
} from "@courier/engine";
import { sortedCopy } from "@courier/shared";
import { exactBuffer } from "../shared/bytes";

/**
 * Type guard for {@link TFile} that avoids importing the `obsidian` runtime
 * (the package ships types only). TFile has an `extension`; TFolder does not.
 */
function isFile(abstractFile: TAbstractFile | null): abstractFile is TFile {
  return abstractFile !== null && "extension" in abstractFile;
}

/**
 * Whether two byte arrays hold exactly the same content.
 *
 * Used only after a failed `createBinary`: the loser of a create race may accept
 * the outcome, but only when the file that beat it holds the bytes it was about
 * to write. Nothing here is security-sensitive, so a plain length check and
 * element loop is enough.
 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * How deep the config-folder walk may go. Obsidian's own layout is two levels
 * (`snippets/`, `themes/<name>/`, `plugins/<id>/`); the cap only exists so a
 * symlink loop cannot turn a settings poll into an infinite walk.
 */
const MAX_SETTINGS_DEPTH = 6;

/** Directory part of a vault path (`""` at the root). */
function parentDir(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

/**
 * Create the folder chain for a vault-relative path, outermost first.
 *
 * `Vault.createFolder` throws when the folder already exists, so every step is
 * guarded; `Vault.createBinary` (and a cross-folder `Vault.rename`) only works
 * once the target folder does, which is why writes call this first.
 *
 * The guard alone is **not** enough. Obsidian reports a folder rename — and a batch
 * of notes dropped into a new folder — as one event per file, the host handles those
 * concurrently, and two operations that need the same not-yet-existing folder both
 * read `null` from `getFolderByPath` before either `createFolder` has resolved. The
 * loser then threw `Folder already exists.`, which aborted that note's whole move or
 * write until the next reconcile (five minutes, in the plugin) — a folder rename
 * losing one of its notes, and the note a peer saw was later re-created at the old
 * path. Losing that race is harmless: the folder exists either way, which is all the
 * caller needs. A genuine failure (no permission, a bad path) leaves no folder
 * behind, so it is still reported.
 */
export async function ensureParentFolder(vault: Vault, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  segments.pop(); // the file name itself
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (vault.getFolderByPath(current)) continue;
    try {
      await vault.createFolder(current);
    } catch (err) {
      // A concurrent caller created it in the meantime.
      if (!vault.getFolderByPath(current)) throw err;
    }
  }
}

/**
 * The same chain, on the raw data adapter, for paths Obsidian does not index.
 *
 * The config folder is outside the vault index, so `getFolderByPath` answers
 * `null` for `.obsidian/snippets` even when it exists — the adapter's own
 * `exists` is the only reliable check there, and `mkdir` is guarded with it
 * because Obsidian's implementations differ on whether an existing directory is
 * an error. That guard has the same race as {@link ensureParentFolder}, and it is
 * answered the same way: two settings files arriving together may both need the
 * folder, and losing the race is not a failure.
 */
async function ensureFoldersInAdapter(adapter: DataAdapter, dir: string): Promise<void> {
  const segments = dir.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (await adapter.exists(current)) continue;
    try {
      await adapter.mkdir(current);
    } catch (err) {
      if (!(await adapter.exists(current))) throw err;
    }
  }
}

/**
 * Remove partial files a crashed process left in `.courier/tmp`.
 *
 * A crash between chunks leaves a `.part` file the index never sees; it is harmless
 * but accumulates. Only files older than a day are touched, so a concurrent writer's
 * live stream is never removed.
 */
async function sweepStaleParts(adapter: DataAdapter): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  let listed: { files: string[] };
  try {
    listed = await adapter.list(".courier/tmp");
  } catch {
    return;
  }
  for (const entry of listed.files) {
    const path = absoluteListedPath(".courier/tmp", entry);
    if (!path.endsWith(".part")) continue;
    try {
      const stat = await adapter.stat(path);
      if (stat !== null && stat.mtime < cutoff) await adapter.remove(path);
    } catch {
      // Opportunistic: a file another writer already removed must not fail the pull.
    }
  }
}

/**
 * {@link SyncAdapter} that operates on an Obsidian {@link Vault}.
 *
 * Two distinct worlds meet here, and the split is the whole point of the class:
 *
 * - **Vault files** live in Obsidian's index. They are listed with `getFiles` — every
 *   indexed file, so notes, `.canvas`, images, audio, video and PDFs alike — and
 *   read/written through `Vault.readBinary` / `modifyBinary` / `createBinary`, so
 *   Obsidian keeps its metadata cache, links, embeds and events in step.
 * - **Settings** live in the config folder (`vault.configDir`, normally
 *   `.obsidian`), which Obsidian deliberately keeps **out of the index**:
 *   `getAbstractFileByPath(".obsidian/app.json")` is always `null` and
 *   `createBinary` would put a config file into the vault's file tree. Every
 *   config path therefore goes through `vault.adapter`, the plain filesystem
 *   layer — which also fires no vault events, so pulling a peer's settings cannot
 *   echo back as a local change.
 */
export class ObsidianVaultAdapter implements SyncAdapter {
  /**
   * Paths a streaming write has already placed on disk but Obsidian's index has
   * not caught up with yet.
   *
   * A large download is written through `DataAdapter` and renamed into place, so it
   * fires no `Vault` event and the watcher updates the index on its own schedule. A
   * reconcile that starts inside that window must still see the file, or it reads
   * the chain as "deleted here" and pushes a tombstone for a file that is present.
   * Entries are dropped as soon as the index (or the disk) answers.
   */
  private readonly pendingIndex = new Set<string>();

  /**
   * Paths a streamed write just replaced, served from the disk for a short window.
   *
   * Replacing an existing file through `DataAdapter.rename` does not refresh the
   * `TFile` object the index holds, so `TFile.stat` can still describe the *old* file
   * after the commit. Pairing the new content hash with that stale stamp would make the
   * next pass trust the old bytes' stamp for the new bytes (invariant 11). Until the
   * watcher's stat agrees with the disk, `statFile` answers from the data adapter.
   */
  private readonly streamedStats = new Map<string, number>();

  constructor(
    private readonly vault: Vault,
    private readonly scope: SyncScope = DEFAULT_SYNC_SCOPE,
    /**
     * Obsidian's file manager, for the deletions this adapter makes on the engine's
     * behalf. `Vault.delete` is the obvious call and the wrong one: it ignores the user's
     * "deleted files" preference, so a note the engine removed would not land in the trash
     * they configured. `FileManager.trashFile` is the API that respects it.
     */
    private readonly fileManager: FileManager,
  ) {}

  /** True for paths inside the config folder — the adapter-backed ones. */
  private inConfig(path: string): boolean {
    return isConfigPath(path, this.scope);
  }

  /** Remember a path whose bytes just came from a streamed write. */
  private markStreamedPath(path: string): void {
    if (this.inConfig(path)) return;
    this.pendingIndex.add(path);
    // Long enough for the watcher to deliver its event; the set is only a hint, so an
    // expired entry that was never refreshed simply falls back to the index.
    this.streamedStats.set(path, Date.now() + 10_000);
  }

  /** Stop reporting a path as freshly streamed (deleted, or moved elsewhere). */
  private forgetStreamedPath(path: string): void {
    this.pendingIndex.delete(path);
    this.streamedStats.delete(path);
  }

  async listSyncableFiles(): Promise<string[]> {
    // Every indexed file, not `getMarkdownFiles()`: attachments and `.canvas` are in the
    // same index, and the scope decides which of them this device syncs.
    const indexed = new Set(this.vault.getFiles().map((f) => f.path));
    const streamed = await this.takePendingIndexedPaths(indexed);
    const settings = syncsAnySettings(this.scope) ? await this.listSettingsFiles() : [];
    return sortedCopy(
      [...new Set([...indexed, ...streamed, ...settings])].filter((p) =>
        isSyncablePath(p, this.scope),
      ),
    );
  }

  /**
   * The streamed paths this device still has to report even though the index does
   * not list them yet, dropping the ones the index or the disk has caught up with.
   *
   * `indexed` is the snapshot the caller is about to return. A pending path that became
   * indexed while an earlier `stat` was awaiting is still in that snapshot, so it must
   * be dropped without adding it a second time. A path not in the snapshot is added only
   * while the disk still has it as a file; otherwise a stale entry would resurrect a
   * file the user already removed (or a path that is now a folder).
   */
  private async takePendingIndexedPaths(indexed: ReadonlySet<string>): Promise<string[]> {
    if (this.pendingIndex.size === 0) return [];
    const listed: string[] = [];
    for (const path of this.pendingIndex) {
      if (indexed.has(path)) {
        this.pendingIndex.delete(path);
      } else if ((await this.vault.adapter.stat(path))?.type === "file") {
        listed.push(path);
      } else {
        this.pendingIndex.delete(path);
      }
    }
    return listed;
  }

  /**
   * The indexed files under a folder this device excludes — a listing only.
   *
   * Obsidian keeps those files in its index (they are ordinary vault folders), so this
   * costs no I/O: a filter over `getFiles()`. The engine asks for it only when a tracked
   * file has gone missing and it has to tell a move into the excluded folder from a
   * deletion. Conflict copies are left out — they never belonged to a chain.
   */
  async listExcludedFiles(): Promise<string[]> {
    if (this.scope.excludedFolders.length === 0) return [];
    return this.vault
      .getFiles()
      .map((file) => file.path)
      .filter((path) => isExcludedPath(path, this.scope) && !isConflictFile(path));
  }

  /**
   * Size and modification time, from the cheap metadata each world already has:
   * `TFile.stat` for an indexed file, `DataAdapter.stat` for a config path — no read,
   * which is what lets the engine refuse an oversized file before loading it, and
   * skip a file whose stamp it has already hashed.
   */
  async statFile(path: string): Promise<FileStamp | null> {
    if (this.inConfig(path)) {
      const stat = await this.vault.adapter.stat(path);
      return stat ? { sizeBytes: stat.size, mtimeMs: stat.mtime } : null;
    }
    // A streamed commit just replaced this path. The TFile the index still holds may
    // describe the bytes that were there before the rename, so answer from the disk
    // until the watcher's stat catches up (see `streamedStats`).
    const streamedUntil = this.streamedStats.get(path);
    if (streamedUntil !== undefined) {
      const disk = await this.vault.adapter.stat(path);
      if (disk?.type !== "file") {
        this.streamedStats.delete(path);
        return null;
      }
      const indexed = this.vault.getAbstractFileByPath(path);
      if (isFile(indexed) && indexed.stat.size === disk.size && indexed.stat.mtime === disk.mtime) {
        this.streamedStats.delete(path);
      } else if (Date.now() > streamedUntil) {
        // The watcher is taking unusually long; the index is still the cheaper answer.
        this.streamedStats.delete(path);
      }
      return { sizeBytes: disk.size, mtimeMs: disk.mtime };
    }
    const file = this.vault.getAbstractFileByPath(path);
    if (isFile(file)) return { sizeBytes: file.stat.size, mtimeMs: file.stat.mtime };
    // The index can lag the disk after a streaming write (see `pendingIndex`), and a
    // null here would make the next pass treat the bytes as unreadable. The data
    // adapter is the plain filesystem, so it answers for a file the index has not
    // indexed yet — and for a genuinely missing path it answers nothing.
    const stat = await this.vault.adapter.stat(path);
    return stat && stat.type === "file" ? { sizeBytes: stat.size, mtimeMs: stat.mtime } : null;
  }

  /**
   * The settings files the scope allows, found by walking the config folder
   * through the data adapter.
   *
   * The walk is pruned by `isSyncableDir`, so a vault that does not sync plugins
   * never even enumerates `.obsidian/plugins` (which is where the bulk of the
   * config folder lives). A folder the adapter cannot list — no `.obsidian` at
   * all on a headless mirror, or a missing subfolder — yields nothing instead of
   * failing the pass.
   */
  private async listSettingsFiles(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > MAX_SETTINGS_DEPTH) return;
      let listed: { files: string[]; folders: string[] };
      try {
        listed = await this.vault.adapter.list(dir);
      } catch {
        return;
      }
      for (const entry of listed.files) {
        const path = absoluteListedPath(dir, entry);
        if (isSyncablePath(path, this.scope)) out.push(path);
      }
      for (const entry of listed.folders) {
        const path = absoluteListedPath(dir, entry);
        if (isSyncableDir(path, this.scope)) await walk(path, depth + 1);
      }
    };
    // A host with no config folder (the CLI) has nothing to walk; without this guard the
    // walk would start at the vault root and enumerate every file a second time.
    if (this.scope.configDir !== "") await walk(this.scope.configDir, 0);
    return out;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    if (this.inConfig(path)) {
      if (!(await this.vault.adapter.exists(path))) return null;
      return new Uint8Array(await this.vault.adapter.readBinary(path));
    }
    const file = this.vault.getAbstractFileByPath(path);
    if (isFile(file)) {
      const buffer = await this.vault.readBinary(file);
      return new Uint8Array(buffer);
    }
    // Same index lag as `statFile`: read the file the index does not know yet rather
    // than let an event or a pass believe it is absent. A folder at the path is not a
    // file (and `readBinary` on one throws), so the adapter's own stat decides.
    if ((await this.vault.adapter.stat(path))?.type !== "file") return null;
    return new Uint8Array(await this.vault.adapter.readBinary(path));
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    if (this.inConfig(path)) {
      await ensureFoldersInAdapter(this.vault.adapter, parentDir(path));
      await this.vault.adapter.writeBinary(path, exactBuffer(bytes));
      return;
    }
    const existing = this.vault.getAbstractFileByPath(path);
    if (isFile(existing)) {
      await this.vault.modifyBinary(existing, exactBuffer(bytes));
      return;
    }
    // The index does not know this path yet, but the disk does because this engine just
    // streamed it there. Writing through the Vault API would throw `File already exists`,
    // so use the data adapter and keep the path in the lagging set until the index
    // catches up. A disk file this engine did **not** write is not ours to overwrite:
    // it falls through to `createBinary`, which refuses it and lets the race check below
    // decide whether the bytes are the same.
    if (
      (this.pendingIndex.has(path) || this.streamedStats.has(path)) &&
      (await this.vault.adapter.stat(path))?.type === "file"
    ) {
      await this.vault.adapter.writeBinary(path, exactBuffer(bytes));
      this.markStreamedPath(path);
      return;
    }
    await ensureParentFolder(this.vault, path);
    try {
      await this.vault.createBinary(path, exactBuffer(bytes));
      this.pendingIndex.delete(path);
      this.streamedStats.delete(path);
    } catch (err) {
      // Another operation may have created this path between the lookup above and
      // this call: a reconcile and a `file_pushed` notification can pull the same
      // path at once, and both can see it absent before either `createBinary`
      // resolves. `Vault.createBinary` refuses an existing path with
      // `File already exists.`; losing that race is harmless **only** when the file
      // now holds exactly the bytes this call was writing. Anything else — different
      // bytes, a folder, a read that fails — is still the caller's error: writing
      // over it would destroy content this engine has not seen.
      const file = this.vault.getAbstractFileByPath(path);
      if (!isFile(file)) throw err;
      let stored: Uint8Array;
      try {
        stored = new Uint8Array(await this.vault.readBinary(file));
      } catch {
        throw err;
      }
      if (!sameBytes(stored, bytes)) throw err;
      this.forgetStreamedPath(path);
    }
  }

  /**
   * Stream a large file into a temporary file and rename it into place.
   *
   * Obsidian has no streaming write that goes through the vault index: `createBinary`
   * and `modifyBinary` take a whole buffer. The data adapter can append bytes, but a
   * file appended to **at its own path** fires one vault event per chunk and is
   * readable (and pushable) half-written — exactly the "one write = one event = one
   * hash" invariant this has to preserve. So the bytes go to `.courier/tmp`, a hidden
   * folder neither the index nor the sync scope knows, and `rename` makes the target
   * appear complete in one step.
   *
   * The index catches up through Obsidian's own watcher. Until it does, the path is
   * remembered in `pendingIndex` and answered by `statFile`/`readFile` from the data
   * adapter — see those methods for why a lagging index must not read as a deletion.
   *
   * `DataAdapter.appendBinary` exists since Obsidian 1.12.3, and the plugin's floor is
   * 1.13.0 (`manifest.json`), so the app always has it: there is no buffering fallback.
   */
  async beginWrite(path: string): Promise<SyncWriteStream> {
    const adapter = this.vault.adapter;
    const temp = `.courier/tmp/${crypto.randomUUID()}.part`;
    // Bound once: the method reads the adapter's own state.
    const appendBinary = adapter.appendBinary.bind(adapter);
    let started = false;
    let closed = false;
    await ensureFoldersInAdapter(adapter, parentDir(temp));
    await sweepStaleParts(adapter);

    const discard = async (): Promise<void> => {
      closed = true;
      try {
        if (await adapter.exists(temp)) await adapter.remove(temp);
      } catch {
        // A temporary file that is already gone costs nothing; the pull reports its
        // own failure through `abort`'s caller.
      }
    };

    return {
      write: async (chunk) => {
        if (closed) throw new Error(`write: ${path} is already closed`);
        const bytes = exactBuffer(chunk);
        if (!started) {
          await adapter.writeBinary(temp, bytes);
          started = true;
        } else {
          await appendBinary(temp, bytes);
        }
      },
      close: async () => {
        if (closed) return;
        try {
          // A stream with no chunk still has to produce an (empty) temp file for the
          // rename below.
          if (!started) await adapter.writeBinary(temp, new ArrayBuffer(0));
          if (this.inConfig(path)) {
            await ensureFoldersInAdapter(adapter, parentDir(path));
          } else {
            await ensureParentFolder(this.vault, path);
          }
          // One rename = one visible change: the target is absent until this line
          // and complete after it. `DataAdapter.rename` replaces an existing file,
          // which is the same path the pull already decided it may overwrite.
          await adapter.rename(temp, path);
        } catch (err) {
          await discard();
          throw err;
        }
        closed = true;
        this.markStreamedPath(path);
      },
      abort: async () => {
        await discard();
      },
    };
  }

  async deleteFile(path: string): Promise<void> {
    if (this.inConfig(path)) {
      if (await this.vault.adapter.exists(path)) await this.vault.adapter.remove(path);
      return;
    }
    const file = this.vault.getAbstractFileByPath(path);
    if (!isFile(file)) {
      // The index has not caught up with a path this engine just streamed. Deleting it
      // through the Vault API would be a silent no-op (there is no TFile), leaving the
      // bytes on disk while the engine drops the chain — the next pass would then push
      // this file as a brand-new `create` and resurrect a peer's deletion.
      if (
        (this.pendingIndex.has(path) || this.streamedStats.has(path)) &&
        (await this.vault.adapter.stat(path))?.type === "file"
      ) {
        try {
          await this.vault.adapter.remove(path);
        } catch (err) {
          // Same "already gone is done" rule as the Vault path below.
          if ((await this.vault.adapter.stat(path))?.type === "file") throw err;
        }
        this.forgetStreamedPath(path);
      }
      return;
    }
    try {
      await this.fileManager.trashFile(file);
      this.forgetStreamedPath(path);
    } catch (err) {
      // `trashFile` resolves once the file has left its path (moved to the trash the user
      // configured, or unlinked). Another writer that got there first — the user's own
      // delete, or a second pull of the same delete head (a reconcile and a `file_pushed`
      // notification can apply one head at once) — makes the move fail instead. The
      // deletion was asked for and has happened; failing the pull for it would report a
      // succeeded delete as an error. A path still on disk after a failed move — a
      // permission problem, an unavailable trash — is the truth and stays the caller's
      // error.
      if (!(await this.vault.adapter.exists(path))) {
        this.forgetStreamedPath(path);
        return;
      }
      throw err;
    }
  }

  async renameFile(from: string, to: string): Promise<void> {
    if (this.inConfig(from) || this.inConfig(to)) {
      if (!(await this.vault.adapter.exists(from))) return;
      await ensureFoldersInAdapter(this.vault.adapter, parentDir(to));
      // Same window as below: the folder chain took awaits, so the source can be gone by
      // the time it exists. `DataAdapter.rename` reports that as `ENOENT`.
      if (!(await this.vault.adapter.exists(from))) return;
      await this.vault.adapter.rename(from, to);
      this.forgetStreamedPath(from);
      this.markStreamedPath(to);
      return;
    }
    const file = this.vault.getAbstractFileByPath(from);
    if (!isFile(file)) {
      // The source is a path this engine streamed and the index has not caught up with.
      // `Vault.rename` needs a TFile, so move it through the data adapter and carry the
      // lagging markers to the target.
      if (
        (this.pendingIndex.has(from) || this.streamedStats.has(from)) &&
        (await this.vault.adapter.stat(from))?.type === "file"
      ) {
        await ensureParentFolder(this.vault, to);
        await this.vault.adapter.rename(from, to);
        this.forgetStreamedPath(from);
        this.markStreamedPath(to);
      }
      return;
    }
    // Moving into a folder this device does not have yet (a peer renamed the
    // note into one) needs the folder before the rename can succeed.
    await ensureParentFolder(this.vault, to);
    // Re-read after that await: a concurrent operation can remove the source in the window
    // — Obsidian reports a folder rename as one event per file and the host runs those
    // concurrently, so one note of a burst can be moved while another is still preparing
    // its folder. `Vault.rename` on a file the vault no longer holds throws `ENOENT`, which
    // would fail the whole pull for a move that no longer has anything to move. A source
    // that is gone is not an error; there is simply nothing left to rename.
    const current = this.vault.getAbstractFileByPath(from);
    if (!isFile(current)) return;
    await this.vault.rename(current, to);
    this.forgetStreamedPath(from);
    this.markStreamedPath(to);
  }
}

/**
 * A path as `DataAdapter.list` reports it, in the vault-relative form the engine
 * uses.
 *
 * Obsidian's adapter returns vault-relative paths for both files and folders; a
 * stub or a future implementation that returns them relative to the listed
 * folder is joined here rather than silently producing paths nothing matches.
 */
function absoluteListedPath(dir: string, entry: string): string {
  if (entry === dir || entry.startsWith(`${dir}/`)) return entry;
  return dir ? `${dir}/${entry}` : entry;
}
