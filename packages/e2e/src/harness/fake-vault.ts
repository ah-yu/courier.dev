import { TFile, TFolder } from "obsidian";

/**
 * In-memory stand-in for an Obsidian `Vault`, backed by a plain
 * `Map<path, bytes>`.
 *
 * It implements the surface `ObsidianVaultAdapter` + `EngineHost` use
 * (`getMarkdownFiles`, `getFiles`, `getAbstractFileByPath`, `getFolderByPath`,
 * `readBinary`, `modifyBinary`, `createBinary`, `delete`, `rename`,
 * `createFolder`, `on`, `offref`) and —
 * importantly — **emits vault events like the real Obsidian does**, including
 * for writes the sync engine itself performs. That is what makes echo
 * suppression, the `create`/`modify`/`delete`/`rename` wiring in `EngineHost`
 * and the local→remote push path testable without the app.
 *
 * Folder operations are modelled on Obsidian's own semantics, because a folder
 * rename is a **burst**, not one event: {@link FakeVault.renameFolder} renames
 * the folder and every descendant and emits breadth first — the folder itself
 * first, then one `rename` per descendant file. `EngineHost` drops the `TFolder`
 * event (`"extension" in file`), so the child events are the only thing that can
 * carry such a move to the server.
 *
 * It also carries the second half of the surface, `configDir` + `adapter`: the
 * config folder (normally `.obsidian`) is **not in Obsidian's index**, so a
 * settings file is invisible to `getMarkdownFiles`/`getAbstractFileByPath` and
 * has to be listed and read through the data adapter. The adapter here shares the
 * byte store but, exactly like the real one, fires **no vault events** — which is
 * why picking up a local settings change is a poll and not an event.
 *
 * Events are dispatched on a microtask, not synchronously, so a handler never
 * re-enters the engine while it is still finishing the write that triggered it
 * (the real Obsidian is asynchronous here too). Call {@link FakeVault.settle}
 * to drain the queue.
 */

type VaultEvent = "create" | "modify" | "delete" | "rename";

/**
 * What a listener receives. Obsidian hands a `TFolder` to a folder event and a
 * `TFile` to a file one, and the distinction is exactly what a host's
 * `"extension" in file` test reads — so the fake has to be able to send both.
 */
type VaultEntry = TFile | TFolder;

interface Listener {
  event: VaultEvent;
  cb: (file: VaultEntry, oldPath?: string) => void;
}

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

function fileFor(path: string, sizeBytes = 0, mtimeMs = 0): TFile {
  const file = new TFile();
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  file.path = path;
  file.name = name;
  file.basename = dot > 0 ? name.slice(0, dot) : name;
  file.extension = extensionOf(path);
  // Obsidian's index carries each file's metadata; the plugin adapter reads the size
  // and the modification time from here (never by reading the file), so the fake has
  // to carry both. A real filesystem moves `mtime` on every write, and the engine's
  // "do not re-read what has not changed" rule depends on that — a fake that left it
  // at zero would let a same-size rewrite look untouched.
  file.stat = { ctime: 0, mtime: mtimeMs, size: sizeBytes };
  return file;
}

/** A `TFolder` for `path` — no `extension`, which is exactly how hosts tell it apart. */
function folderFor(path: string): TFolder {
  const folder = new TFolder();
  folder.path = path;
  folder.name = path.split("/").pop() ?? path;
  return folder;
}

/** How many segments a vault path has (`0` for the root). */
function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

export class FakeVault {
  /** Obsidian's config folder name — the one dot-folder that can be synced. */
  readonly configDir = ".obsidian";

  private files = new Map<string, Uint8Array>();
  /** Folders that exist but hold nothing yet (`adapter.mkdir`). */
  private folders = new Set<string>();
  private listeners: Listener[] = [];
  private queue: Array<() => void> = [];
  /**
   * Modification time per path, moved by every write — the fake's stand-in for the
   * filesystem clock. `indexedFile` and the data adapter's `stat` read it, so the
   * engine's stamp cache sees a changed file as changed.
   */
  private mtimes = new Map<string, number>();
  private clock = 1;

  constructor() {
    // Every real vault has its config folder on disk from the start. The fake used to
    // start empty, which let a settings write implicitly "create" `.obsidian` — and hid
    // the fact that the plugin has to create any folder *inside* it itself.
    this.folders.add(this.configDir);
  }

  /** Store bytes and move that path's modification time. */
  private put(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
    this.mtimes.set(path, this.clock++);
  }

  // ── Obsidian Vault surface ──

  on(event: VaultEvent, cb: (file: VaultEntry, oldPath?: string) => void): unknown {
    const ref: Listener = { event, cb };
    this.listeners.push(ref);
    return ref;
  }

  offref(ref: unknown): void {
    const index = this.listeners.indexOf(ref as Listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  /** Wired listeners — lets tests assert the host wires and unwires cleanly. */
  get listenerCount(): number {
    return this.listeners.length;
  }

  getMarkdownFiles(): TFile[] {
    // Obsidian's index holds no dot-folder, the config folder included.
    return [...this.files.keys()]
      .filter((path) => path.endsWith(".md") && !isHidden(path))
      .toSorted()
      .map((path) => this.indexedFile(path));
  }

  /**
   * Every file in Obsidian's index — notes, `.canvas`, attachments, PDFs alike.
   *
   * This is what `ObsidianVaultAdapter.listSyncableFiles` lists (the file-type scope
   * then decides what actually syncs), and the difference from `getMarkdownFiles` is
   * exactly the gap the attachment cases exist to cover.
   */
  getFiles(): TFile[] {
    return [...this.files.keys()]
      .filter((path) => !isHidden(path))
      .toSorted()
      .map((path) => this.indexedFile(path));
  }

  /**
   * Every indexed file **and folder** — what the excluded-folder dialog walks.
   *
   * Obsidian's index holds no dot-folder, the config folder included, so this mirrors
   * `getFiles`/`getMarkdownFiles` and drops hidden paths. Empty folders are included:
   * they are legitimate exclusion targets and a tree built from file paths alone would
   * silently hide them.
   */
  getAllLoadedFiles(): Array<TFile | TFolder> {
    const files = [...this.files.keys()]
      .filter((path) => !isHidden(path))
      .map((path) => this.indexedFile(path));
    const folders = [...this.folders]
      .filter((path) => path && !isHidden(path))
      .toSorted()
      .map((path) => folderFor(path));
    return [...files, ...folders];
  }

  /** A TFile carrying the byte size and stamp the adapter's `statFile` reads. */
  private indexedFile(path: string): TFile {
    return fileFor(path, this.files.get(path)?.byteLength ?? 0, this.mtimes.get(path) ?? 0);
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (path === this.configDir || path.startsWith(`${this.configDir}/`)) return null;
    if (this.files.has(path)) return this.indexedFile(path);
    return this.hasFolder(path) ? folderFor(path) : null;
  }

  /**
   * Whether a folder is in Obsidian's index.
   *
   * Obsidian's index knows every folder an indexed file lives under, plus the empty
   * ones created through the API — which is what `createBinary` and `rename` need to
   * ask before they can write, and why the plugin adapter's `ensureParentFolder`
   * exists at all (a folder the index does not have has to be created first).
   */
  private hasFolder(path: string): boolean {
    if (!path) return true;
    if (this.folders.has(path)) return true;
    const prefix = `${path}/`;
    for (const known of this.files.keys()) if (known.startsWith(prefix)) return true;
    for (const known of this.folders) if (known.startsWith(prefix)) return true;
    return false;
  }

  /** The folder a vault path lives in (`""` at the root). */
  private parentOf(path: string): string {
    return path.split("/").slice(0, -1).join("/");
  }

  /** The `ENOENT` a real `Vault` throws when the target's folder does not exist. */
  private assertParentFolder(path: string): void {
    const parent = this.parentOf(path);
    if (parent && !this.hasFolder(parent)) throw new Error(`ENOENT: ${parent}`);
  }

  /**
   * Register every folder on the way to `path`, without a vault event.
   *
   * This is what Obsidian's **UI** does when a user puts a note in a folder that does not
   * exist yet — and what the test helpers use, so a test can say "a note lives here"
   * without spelling out the chain. The API the plugin calls (`createBinary`) stays
   * strict; see {@link assertParentFolder}.
   */
  private ensureFolders(path: string): void {
    const segments = path.split("/").filter(Boolean);
    segments.pop();
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      this.folders.add(current);
    }
  }

  getFolderByPath(path: string): TFolder | null {
    return this.hasFolder(path) && path ? folderFor(path) : null;
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    const bytes = this.files.get(file.path);
    if (!bytes) throw new Error(`ENOENT: ${file.path}`);
    return bytes.slice().buffer;
  }

  /**
   * Obsidian's cached text read, which the conflict-comparison view shows both sides
   * through. The fake answers from the same bytes the harness's own {@link read} accessor
   * holds: a view that read the vault through a method the fake lacked would render
   * "cannot read" in every case, which is a passing test that proves nothing.
   */
  async cachedRead(file: TFile): Promise<string> {
    const bytes = this.files.get(file.path);
    if (!bytes) throw new Error(`ENOENT: ${file.path}`);
    return new TextDecoder().decode(bytes);
  }

  async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
    // Real Obsidian writes *through the index*: a TFile the vault no longer holds — the
    // file was deleted between the lookup and the write — throws instead of quietly
    // resurrecting the path. A fake that always wrote let the plugin skip the
    // `getAbstractFileByPath` half of its own `writeFile` and still pass.
    if (!this.files.has(file.path)) throw new Error(`ENOENT: ${file.path}`);
    this.put(file.path, new Uint8Array(data));
    this.emit("modify", this.indexedFile(file.path));
  }

  async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
    // `Vault.createBinary` does **not** create missing parents: it throws ENOENT and
    // leaves the file absent, which is the whole reason `ObsidianVaultAdapter.writeFile`
    // walks the folder chain first. This fake used to register the file regardless, so a
    // plugin that forgot `ensureParentFolder` looked fine here and lost the note in the
    // app — the defect class the fidelity suite below exists to prevent.
    this.assertParentFolder(path);
    // It also refuses a path that already exists, and registers the file only after its
    // adapter write resolves. The yield below gives two concurrent callers — a reconcile
    // pull and a `files_pushed` pull of the same path — the app's window: both can see the
    // index empty, and the loser then gets `File already exists.`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.files.has(path)) throw new Error(`File already exists: ${path}`);
    this.put(path, new Uint8Array(data));
    const file = this.indexedFile(path);
    this.emit("create", file);
    return file;
  }

  async delete(file: TFile): Promise<void> {
    // Deleting what the index does not hold is an error in the app, not a no-op.
    if (!this.files.delete(file.path)) throw new Error(`ENOENT: ${file.path}`);
    this.mtimes.delete(file.path);
    this.emit("delete", file);
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    if (!this.files.has(file.path)) throw new Error(`ENOENT: ${file.path}`);
    // A cross-folder move needs the target folder too (`Vault.rename` fails otherwise),
    // which is why `ObsidianVaultAdapter.renameFile` prepares it.
    this.assertParentFolder(newPath);
    const bytes = this.files.get(file.path);
    if (bytes) {
      this.files.delete(file.path);
      const mtime = this.mtimes.get(file.path);
      this.mtimes.delete(file.path);
      this.files.set(newPath, bytes);
      // A real rename carries the timestamp with the file.
      if (mtime !== undefined) this.mtimes.set(newPath, mtime);
    }
    this.emit("rename", this.indexedFile(newPath), file.path);
  }

  async createFolder(path: string): Promise<void> {
    // Obsidian's `createFolder` throws on a folder that exists, and it only
    // registers the folder **after** its adapter call resolves — a real disk
    // round-trip, not a microtask. That window is what makes two concurrent creates
    // of one folder a real race: the second caller's `getFolderByPath` still answers
    // `null`, and its `createFolder` then throws `Folder already exists.`. The yield
    // below models that window (a microtask alone is too narrow to reproduce it), so
    // a fake vault cannot hide a defect the real one has.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (this.hasFolder(path)) throw new Error(`Folder already exists: ${path}`);
    this.folders.add(path);
  }

  /**
   * The data adapter: plain filesystem access, no vault index and **no events**
   * (Obsidian's own adapter fires none). The config folder is reached only
   * through here.
   */
  readonly adapter = {
    exists: async (path: string): Promise<boolean> =>
      this.files.has(path) || this.folders.has(path),

    stat: async (path: string) =>
      this.files.has(path)
        ? {
            type: "file",
            size: this.files.get(path)!.byteLength,
            ctime: 0,
            mtime: this.mtimes.get(path) ?? 0,
          }
        : this.folders.has(path)
          ? { type: "folder", size: 0, ctime: 0, mtime: 0 }
          : null,

    list: async (path: string): Promise<{ files: string[]; folders: string[] }> => {
      const prefix = path ? `${path}/` : "";
      const files: string[] = [];
      const folders = new Set<string>();
      for (const known of this.files.keys()) {
        if (!known.startsWith(prefix)) continue;
        const rest = known.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf("/");
        if (slash === -1) files.push(known);
        else folders.add(`${prefix}${rest.slice(0, slash)}`);
      }
      for (const known of this.folders) {
        if (!known.startsWith(prefix)) continue;
        const rest = known.slice(prefix.length);
        if (rest && !rest.includes("/")) folders.add(known);
      }
      return { files: files.toSorted(), folders: [...folders].toSorted() };
    },

    read: async (path: string): Promise<string> => {
      const bytes = this.files.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return new TextDecoder().decode(bytes);
    },

    readBinary: async (path: string): Promise<ArrayBuffer> => {
      const bytes = this.files.get(path);
      if (!bytes) throw new Error(`ENOENT: ${path}`);
      return bytes.slice().buffer;
    },

    write: async (path: string, data: string): Promise<void> => {
      this.ensureFolders(path);
      this.put(path, new TextEncoder().encode(data));
    },

    writeBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      // The data adapter is the plain filesystem: the folder has to exist, which is what
      // `ObsidianVaultAdapter.writeFile`'s `ensureFoldersInAdapter` is for. A fake that
      // created the parent implicitly let a missing `mkdir` pass here and fail in the app
      // (a snippet landing in a folder the peer does not have).
      this.assertParentFolder(path);
      this.put(path, new Uint8Array(data));
    },

    appendBinary: async (path: string, data: ArrayBuffer): Promise<void> => {
      // Appending is how the plugin streams a large download into `.courier/tmp`: the
      // first chunk creates the file, later ones extend it. The real adapter refuses a
      // path that is not there, and fires no vault event (this is the data adapter, not
      // `Vault`).
      this.assertParentFolder(path);
      const current = this.files.get(path);
      if (!current) throw new Error(`ENOENT: ${path}`);
      const extra = new Uint8Array(data);
      const next = new Uint8Array(current.byteLength + extra.byteLength);
      next.set(current, 0);
      next.set(extra, current.byteLength);
      this.put(path, next);
    },

    mkdir: async (path: string): Promise<void> => {
      this.folders.add(path);
    },

    remove: async (path: string): Promise<void> => {
      if (!this.files.delete(path)) throw new Error(`ENOENT: ${path}`);
      this.mtimes.delete(path);
    },

    rmdir: async (path: string): Promise<void> => {
      // The lease store (and every folder delete) asks for a recursive removal: Obsidian's
      // `rmdir(path, true)` takes the children with the folder. A fake that dropped only
      // the folder entry left the files behind under a path nothing could reach.
      this.folders.delete(path);
      for (const known of this.files.keys()) {
        if (known.startsWith(`${path}/`)) {
          this.files.delete(known);
          this.mtimes.delete(known);
        }
      }
      for (const known of this.folders) {
        if (known.startsWith(`${path}/`)) this.folders.delete(known);
      }
    },

    /**
     * Obsidian's `DataAdapter.rename` moves a file **or a folder**, children included.
     *
     * The lease takeover renames `.courier/sync-lease` aside with exactly this call; a fake
     * that only moved files would have made the takeover unreachable in L2 and hidden the
     * real adapter's contract.
     */
    rename: async (from: string, to: string): Promise<void> => {
      const bytes = this.files.get(from);
      if (bytes) {
        const mtime = this.mtimes.get(from);
        this.files.delete(from);
        this.mtimes.delete(from);
        this.files.set(to, bytes);
        if (mtime !== undefined) this.mtimes.set(to, mtime);
        return;
      }
      if (!this.folders.has(from)) throw new Error(`ENOENT: ${from}`);
      for (const known of this.files.keys()) {
        if (!known.startsWith(`${from}/`)) continue;
        const moved = `${to}${known.slice(from.length)}`;
        const content = this.files.get(known)!;
        const mtime = this.mtimes.get(known);
        this.files.delete(known);
        this.mtimes.delete(known);
        this.files.set(moved, content);
        if (mtime !== undefined) this.mtimes.set(moved, mtime);
      }
      for (const known of this.folders) {
        if (known === from || known.startsWith(`${from}/`)) {
          this.folders.delete(known);
          this.folders.add(`${to}${known.slice(from.length)}`);
        }
      }
    },

    getBasePath: (): string => "",
  };

  // ── Text helpers used by tests to act like a human editing notes ──

  /** Create (or overwrite) a note and fire the matching vault event. */
  async create(path: string, content: string): Promise<TFile> {
    // A test placing a note the way a *user* would: Obsidian's UI creates the folder chain
    // first. `createBinary` deliberately does not (see `assertParentFolder`), so the
    // helper does it here rather than making every test spell the chain out.
    this.ensureFolders(path);
    const bytes = new TextEncoder().encode(content);
    // Overwriting an existing note is a `modify` in Obsidian; `createBinary` now refuses
    // an existing path in this fake too, so the helper's documented overwrite half has to
    // go through `modifyBinary`.
    if (this.files.has(path)) {
      await this.modifyBinary(this.indexedFile(path), bytes.buffer as ArrayBuffer);
      return this.indexedFile(path);
    }
    return await this.createBinary(path, bytes.buffer as ArrayBuffer);
  }

  /** Edit an existing note and fire `modify`. */
  async modify(path: string, content: string): Promise<void> {
    await this.modifyBinary(
      this.indexedFile(path),
      new TextEncoder().encode(content).buffer as ArrayBuffer,
    );
  }

  /**
   * Put a binary (an attachment) in the vault the way a user's Obsidian would: the folder
   * chain exists before the file does, because `createBinary` refuses a missing parent.
   * Re-placing an existing path is a `modify`, for the same reason as {@link create}.
   */
  async createAttachment(path: string, bytes: Uint8Array): Promise<TFile> {
    this.ensureFolders(path);
    if (this.files.has(path)) {
      await this.modifyBinary(this.indexedFile(path), bytes.buffer as ArrayBuffer);
      return this.indexedFile(path);
    }
    return await this.createBinary(path, bytes.buffer as ArrayBuffer);
  }

  /** Delete a note by path and fire `delete`. */
  async remove(path: string): Promise<void> {
    await this.delete(this.indexedFile(path));
  }

  /** Rename a note by path and fire `rename` (creating the target folder, as the UI does). */
  async move(from: string, to: string): Promise<void> {
    this.ensureFolders(to);
    await this.rename(this.indexedFile(from), to);
  }

  /**
   * Every folder `path` is an ancestor of (or is itself), in vault order.
   *
   * A folder exists in Obsidian's index once an indexed file lives under it, so the
   * set is derived from the files as well as from the folders created explicitly —
   * which is what makes a burst emit an event for a subfolder nobody ever created
   * through the API, exactly as the real app does.
   */
  private foldersUnder(path: string): string[] {
    const found = new Set<string>(this.folders);
    for (const known of this.files.keys()) {
      const segments = known.split("/").filter(Boolean);
      segments.pop(); // the file name itself
      let current = "";
      for (const segment of segments) {
        current = current ? `${current}/${segment}` : segment;
        found.add(current);
      }
    }
    return [...found].filter((known) => known === path || known.startsWith(`${path}/`)).toSorted();
  }

  /**
   * Rename (or move) a folder, the way Obsidian does it.
   *
   * Obsidian does not report a folder rename once: every descendant is renamed
   * with it, and the events arrive **breadth first** — the folder itself, then its
   * children level by level (verified against a real Obsidian with a temporary
   * listener, and documented the same way by another sync plugin). The store is moved
   * before anything is emitted, so a listener that reads the new path finds the
   * vault already consistent — which is what the real app does too.
   *
   * The `TFolder` events are emitted first and deliberately: `EngineHost` ignores
   * them (`"extension" in file`), so a folder rename can only reach the server
   * through the child `rename` events that follow.
   */
  async renameFolder(from: string, to: string): Promise<void> {
    const folders = this.foldersUnder(from).map((known): [string, string] => [
      known,
      `${to}${known.slice(from.length)}`,
    ]);
    const files: Array<[string, string]> = [];
    for (const known of [...this.files.keys()].toSorted()) {
      if (known.startsWith(`${from}/`)) files.push([known, `${to}${known.slice(from.length)}`]);
    }
    if (folders.length === 0 && files.length === 0) throw new Error(`ENOENT: ${from}`);

    // Only the folders created through the API are entries of their own; the rest
    // are implied by the files, which the loop below moves.
    for (const [oldPath, newPath] of folders) {
      if (!this.folders.delete(oldPath)) continue;
      this.folders.add(newPath);
    }
    for (const [oldPath, newPath] of files) {
      const bytes = this.files.get(oldPath)!;
      this.files.delete(oldPath);
      this.files.set(newPath, bytes);
    }

    // Breadth first: a parent before its own children, which is the order Obsidian
    // fires them in.
    const entries: Array<{ from: string; to: string; folder: boolean }> = [
      ...folders.map(([oldPath, newPath]) => ({ from: oldPath, to: newPath, folder: true })),
      ...files.map(([oldPath, newPath]) => ({ from: oldPath, to: newPath, folder: false })),
    ].toSorted((a, b) => pathDepth(a.to) - pathDepth(b.to) || Number(b.folder) - Number(a.folder));
    for (const entry of entries) {
      this.emit(
        "rename",
        entry.folder ? folderFor(entry.to) : this.indexedFile(entry.to),
        entry.from,
      );
    }
  }

  /**
   * Delete a folder and everything under it.
   *
   * Obsidian fires one `delete` per descendant here too, but — unlike `rename` —
   * **no defined order**, so they are emitted as one batch starting with the folder.
   * `EngineHost` drops the `TFolder` events; the child ones are what sync.
   */
  async deleteFolder(path: string): Promise<void> {
    const files = [...this.files.keys()].filter((known) => known.startsWith(`${path}/`)).toSorted();
    const folders = this.foldersUnder(path).toSorted((a, b) => pathDepth(a) - pathDepth(b));
    for (const known of files) this.files.delete(known);
    for (const known of folders) this.folders.delete(known);
    this.emit("delete", folderFor(path));
    for (const known of files) this.emit("delete", fileFor(known));
    for (const known of folders) if (known !== path) this.emit("delete", folderFor(known));
  }

  /**
   * Write a settings file the way Obsidian does: through the data adapter, i.e.
   * **without** a vault event — the host only finds out by polling. The folder chain is
   * created first, as a user's own Obsidian would already have it.
   */
  async writeConfig(path: string, content: string): Promise<void> {
    this.ensureFolders(path);
    await this.adapter.writeBinary(path, new TextEncoder().encode(content).buffer as ArrayBuffer);
  }

  /**
   * Set a path's modification time.
   *
   * The fake's clock is a logical counter, so it is not comparable with the epoch
   * milliseconds a peer's real filesystem reports — a test that exercises the
   * config-folder "newer modification wins" rule states both sides explicitly.
   */
  setMtime(path: string, mtimeMs: number): void {
    if (!this.files.has(path)) throw new Error(`setMtime: ${path} does not exist`);
    this.mtimes.set(path, mtimeMs);
  }

  // ── Inspection ──

  read(path: string): string | null {
    const bytes = this.files.get(path);
    return bytes ? new TextDecoder().decode(bytes) : null;
  }

  paths(): string[] {
    return [...this.files.keys()].toSorted();
  }

  has(path: string): boolean {
    return this.files.has(path);
  }

  /** Drain queued vault events (several macrotask turns). */
  async settle(turns = 4): Promise<void> {
    for (let i = 0; i < turns; i++) {
      this.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.flush();
  }

  private emit(event: VaultEvent, file: VaultEntry, oldPath?: string): void {
    this.queue.push(() => {
      // Snapshot: a listener may unwire itself or a sibling while running.
      for (const listener of Array.from(this.listeners)) {
        if (listener.event === event) listener.cb(file, oldPath);
      }
    });
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    const pending = this.queue;
    this.queue = [];
    for (const run of pending) run();
  }
}

/** True when any segment of the path starts with a dot. */
function isHidden(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}
