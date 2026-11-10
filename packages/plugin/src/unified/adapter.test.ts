import { describe, expect, it } from "vitest";
import type { FileManager, TFile, Vault } from "obsidian";
import { ObsidianVaultAdapter } from "./adapter";
import {
  NO_FILE_TYPES,
  normalizeScope,
  SETTINGS_GROUPS,
  type SettingsGroup,
  type SyncScope,
} from "@courier/engine";

/**
 * `ObsidianVaultAdapter` is a thin shim, so what can go wrong is *which*
 * Obsidian method it calls: `modifyBinary` vs `createBinary` for a note, or
 * `vault.adapter.*` instead of the `Vault` API for a settings file inside the
 * config folder (which Obsidian keeps out of its index, so the `Vault` methods
 * cannot see it at all). `FakeVault` (the e2e harness) cannot observe that split
 * because it stores bytes in a flat map, so the branching is pinned here against
 * a recording stub.
 *
 * This file must not import the `obsidian` runtime (the package ships types
 * only), which is why the stub below is hand-written rather than aliased.
 */

/**
 * The `FileManager` the adapter deletes through. The stub records it like any other
 * vault call, so a test that cares about a deletion can still see it.
 */
function fileManagerFor(vault: Vault): FileManager {
  return { trashFile: (file: TFile) => vault.delete(file) } as unknown as FileManager;
}

type VaultCall = [method: string, ...args: unknown[]];

/** A scope with exactly the named config-folder groups on and no vault file types. */
function scopeWith(...groups: SettingsGroup[]): SyncScope {
  const settingsGroups: Record<string, boolean> = {};
  for (const group of groups) settingsGroups[group] = true;
  return normalizeScope({ configDir: ".obsidian", settingsGroups, fileTypes: NO_FILE_TYPES });
}

const MARKDOWN_ONLY: SyncScope = scopeWith();
const SETTINGS: SyncScope = scopeWith(
  "app",
  "appearance",
  "themes",
  "snippets",
  "hotkeys",
  "corePlugins",
  "corePluginSettings",
);
const PLUGINS: SyncScope = scopeWith(...SETTINGS_GROUPS);

/**
 * A file object shaped the way the adapter distinguishes files from folders:
 * `TFile` carries `extension`, `TFolder` does not — plus the `stat.size` the
 * adapter's `statFile` reads instead of opening the file.
 */
function fileFor(path: string, sizeBytes = 0, mtimeMs = 0): TFile {
  const name = path.split("/").at(-1)!;
  const dot = name.lastIndexOf(".");
  return {
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot > 0 ? name.slice(dot + 1) : "",
    stat: { ctime: 0, mtime: mtimeMs, size: sizeBytes },
  } as unknown as TFile;
}

/** Directory part of a vault path (`""` at the root). */
function parentDir(path: string): string {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.join("/");
}

/** A byte array as text, for the streaming cases that write strings in chunks. */
function decode(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/**
 * The slice of the `Vault` surface this adapter uses. Narrowing it here keeps
 * the stub honest (no `as unknown as Vault` cast hiding a signature mistake)
 * while still being assignable to the constructor's parameter.
 */
interface RecordingVault {
  configDir: string;
  adapter: {
    exists(path: string): Promise<boolean>;
    stat(path: string): Promise<{ type: string; size: number; mtime: number } | null>;
    list(path: string): Promise<{ files: string[]; folders: string[] }>;
    readBinary(path: string): Promise<ArrayBuffer>;
    writeBinary(path: string, data: ArrayBuffer): Promise<void>;
    appendBinary(path: string, data: ArrayBuffer): Promise<void>;
    mkdir(path: string): Promise<void>;
    remove(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
  };
  getFiles(): TFile[];
  getMarkdownFiles(): TFile[];
  getAbstractFileByPath(path: string): TFile | null;
  getFolderByPath(path: string): { path: string } | null;
  readBinary(file: TFile): Promise<ArrayBuffer>;
  modifyBinary(file: TFile, data: ArrayBuffer): Promise<void>;
  createBinary(path: string, data: ArrayBuffer): Promise<TFile>;
  delete(file: TFile): Promise<void>;
  rename(file: TFile, newPath: string): Promise<void>;
  createFolder(path: string): Promise<unknown>;
}

/**
 * A `Vault` stand-in that records every call instead of touching a real vault.
 *
 * `folders` is the folder set the stub keeps, so `getFolderByPath` answers and
 * `createFolder` mirrors Obsidian by **throwing when the folder exists** — the
 * adapter guards every step because of that. `racedFolders` models the window that
 * guard cannot close: Obsidian registers a folder only after its adapter call
 * resolves, so a second caller's `getFolderByPath` still answers `null` and its
 * `createFolder` then throws on a folder that is there now. Naming a path in
 * `racedFolders` makes `createFolder` behave exactly like that loser (create it, then
 * throw), and `uncreatableFolders` models a genuine failure (nothing is created, the
 * error is the truth). `createBinary` also refuses an existing path, after an await —
 * the window in which a concurrent write can win the same path. The data adapter
 * underneath shares the same byte store but does *not* report into the vault index
 * (there is no index for the config folder) and, like the real one, fires no vault
 * events.
 */
function recordingVault(
  files: Record<string, string> = {},
  folders: string[] = [],
  configDir = ".obsidian",
  races: {
    racedFolders?: string[];
    uncreatableFolders?: string[];
    failingCreates?: string[];
    /** Paths the index still lists though another delete already removed them from disk. */
    vanishedDeletes?: string[];
    /** Paths whose unlink fails while the file is still there (permissions). */
    failingDeletes?: string[];
    /**
     * Paths whose bytes are on disk but not in the index yet.
     *
     * A streamed write goes through the data adapter and rename, so Obsidian's watcher
     * indexes it a pass later; until then `getFiles` and `getAbstractFileByPath` are
     * blind to it. The adapter has to keep reporting the path anyway.
     */
    laggingIndex?: Set<string>;
    /** Paths whose `TFile.stat` still describes the bytes from before a streamed replace. */
    staleIndexStats?: Map<string, { size: number; mtime: number }>;
  } = {},
) {
  const calls: VaultCall[] = [];
  const contents = new Map(Object.entries(files));
  const folderPaths = [...folders];

  const adapter: RecordingVault["adapter"] = {
    exists: async (path) => {
      calls.push(["adapter.exists", path]);
      return contents.has(path) || folderPaths.includes(path);
    },
    stat: async (path) => {
      calls.push(["adapter.stat", path]);
      const content = contents.get(path);
      return content === undefined ? null : { type: "file", size: content.length, mtime: 0 };
    },
    list: async (dir) => {
      calls.push(["adapter.list", dir]);
      const directChildren = (path: string) => parentDir(path) === dir;
      return {
        files: [...contents.keys()].filter(directChildren),
        folders: folderPaths.filter(directChildren),
      };
    },
    readBinary: async (path) => {
      calls.push(["adapter.readBinary", path]);
      const content = contents.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return new TextEncoder().encode(content).buffer as ArrayBuffer;
    },
    writeBinary: async (path, data) => {
      calls.push(["adapter.writeBinary", path, new TextDecoder().decode(data)]);
      contents.set(path, new TextDecoder().decode(data));
    },
    appendBinary: async (path, data) => {
      calls.push(["adapter.appendBinary", path, new TextDecoder().decode(data)]);
      const current = contents.get(path);
      if (current === undefined) throw new Error(`ENOENT: ${path}`);
      contents.set(path, current + new TextDecoder().decode(data));
    },
    mkdir: async (path) => {
      calls.push(["adapter.mkdir", path]);
      if (races.uncreatableFolders?.includes(path)) throw new Error(`EPERM: ${path}`);
      if (races.racedFolders?.includes(path)) throw new Error(`Folder already exists: ${path}`);
      folderPaths.push(path);
    },
    remove: async (path) => {
      calls.push(["adapter.remove", path]);
      if (!contents.delete(path)) throw new Error(`ENOENT: ${path}`);
    },
    rename: async (from, to) => {
      calls.push(["adapter.rename", from, to]);
      const content = contents.get(from);
      if (content === undefined) throw new Error(`ENOENT: ${from}`);
      contents.delete(from);
      contents.set(to, content);
    },
  };

  const vault: RecordingVault = {
    configDir,
    adapter,
    getFiles: () => {
      calls.push(["getFiles"]);
      // Obsidian's index holds no dot-folder, the config folder included — but it does
      // hold every other file, attachments and `.canvas` included.
      return [...contents.keys()]
        .filter((path) => !path.split("/")[0]!.startsWith(".") && !races.laggingIndex?.has(path))
        .map((path) => fileFor(path, contents.get(path)!.length));
    },
    getMarkdownFiles: () => {
      calls.push(["getMarkdownFiles"]);
      // Obsidian's index holds no dot-folder, the config folder included.
      return [...contents.keys()]
        .filter((path) => path.endsWith(".md") && !path.split("/")[0]!.startsWith("."))
        .map((path) => fileFor(path, contents.get(path)!.length));
    },
    getAbstractFileByPath: (path: string) => {
      calls.push(["getAbstractFileByPath", path]);
      // The index never knows a config path, even one that exists on disk.
      if (path.startsWith(`${configDir}/`)) return null;
      if (races.laggingIndex?.has(path)) return null;
      const stale = races.staleIndexStats?.get(path);
      if (stale !== undefined) return fileFor(path, stale.size, stale.mtime);
      const content = contents.get(path);
      if (content === undefined) {
        // The app's index lags a delete by one watcher pass: a path another writer
        // already unlinked is still answered here while `adapter.exists` says no.
        return races.vanishedDeletes?.includes(path) ? fileFor(path, 0) : null;
      }
      return fileFor(path, content.length);
    },
    getFolderByPath: (path: string) => {
      calls.push(["getFolderByPath", path]);
      return folderPaths.includes(path) ? { path } : null;
    },
    readBinary: async (file: TFile) => {
      calls.push(["readBinary", file.path]);
      return new TextEncoder().encode(contents.get(file.path)!).buffer as ArrayBuffer;
    },
    modifyBinary: async (file: TFile, data: ArrayBuffer) => {
      calls.push(["modifyBinary", file.path, new TextDecoder().decode(data)]);
    },
    createBinary: async (path: string, data: ArrayBuffer) => {
      // The app refuses a path that already exists; the await stands in for the write
      // itself, and is what lets two `writeFile` calls both pass the adapter's lookup
      // before either of them registers the file.
      await Promise.resolve();
      if (races.failingCreates?.includes(path)) throw new Error(`EACCES: ${path}`);
      if (contents.has(path)) throw new Error(`File already exists: ${path}`);
      calls.push(["createBinary", path, new TextDecoder().decode(data)]);
      contents.set(path, new TextDecoder().decode(data));
      return fileFor(path, contents.get(path)!.length);
    },
    delete: async (file: TFile) => {
      calls.push(["delete", file.path]);
      // A real `Vault.delete` awaits the adapter's unlink and leaves the index to the
      // watcher, so a path another writer already unlinked answers `ENOENT` here.
      if (races.failingDeletes?.includes(file.path)) throw new Error(`EACCES: ${file.path}`);
      if (!contents.delete(file.path)) throw new Error(`ENOENT: ${file.path}`);
    },
    rename: async (file: TFile, newPath: string) => {
      calls.push(["rename", file.path, newPath]);
    },
    createFolder: async (path: string) => {
      if (races.uncreatableFolders?.includes(path)) throw new Error(`EPERM: ${path}`);
      // The race: the folder is there now even though the check above said otherwise,
      // and Obsidian still reports it as a failure.
      if (races.racedFolders?.includes(path)) {
        folderPaths.push(path);
        throw new Error(`Folder already exists: ${path}`);
      }
      if (folderPaths.includes(path)) throw new Error(`Folder already exists: ${path}`);
      calls.push(["createFolder", path]);
      folderPaths.push(path);
    },
  };

  return {
    vault: vault as unknown as Vault,
    calls,
    /**
     * The call log without the existence probes the adapter always issues, so
     * an assertion reads as the actions taken.
     */
    meaningful: () =>
      calls.filter(
        ([method]) =>
          method !== "getAbstractFileByPath" &&
          method !== "getFolderByPath" &&
          method !== "adapter.exists" &&
          method !== "adapter.list",
      ),
    /** The adapter-level calls only — what the config-folder routing produces. */
    adapterCalls: () => calls.filter(([method]) => method.startsWith("adapter.")),
  };
}

describe("ObsidianVaultAdapter — notes", () => {
  it("modifies an existing file instead of recreating it", async () => {
    const { vault, meaningful } = recordingVault({ "note.md": "old" });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    await adapter.writeFile("note.md", new TextEncoder().encode("new"));

    expect(meaningful()).toEqual([["modifyBinary", "note.md", "new"]]);
  });

  it("creates the missing parent folders before a nested write", async () => {
    const { vault, meaningful } = recordingVault();
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    await adapter.writeFile("folder/sub/new.md", new TextEncoder().encode("body"));

    // Obsidian's `createBinary` throws ENOENT (and leaves the file absent) when
    // the parent folder is missing, which is how a nested note pushed by a peer
    // used to vanish instead of landing in the vault.
    expect(meaningful()).toEqual([
      ["createFolder", "folder"],
      ["createFolder", "folder/sub"],
      ["createBinary", "folder/sub/new.md", "body"],
    ]);
  });

  it("does not recreate folders that already exist", async () => {
    const { vault, meaningful } = recordingVault({}, ["folder", "folder/sub"]);
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    // Would throw if the adapter called createFolder on an existing folder.
    await adapter.writeFile("folder/sub/another.md", new TextEncoder().encode("body"));

    expect(meaningful()).toEqual([["createBinary", "folder/sub/another.md", "body"]]);
  });

  it("carries on when another operation created the folder first", async () => {
    // Two notes of a renamed folder (or two notes dropped into a new one) need the
    // same folder at the same time: both read `null` from `getFolderByPath`, and the
    // loser's `createFolder` throws even though the folder is there now. Aborting on
    // that left the note unmoved until the next reconcile.
    const { vault, meaningful } = recordingVault({}, [], ".obsidian", {
      racedFolders: ["folder"],
    });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    await adapter.writeFile("folder/new.md", new TextEncoder().encode("body"));

    expect(meaningful()).toEqual([["createBinary", "folder/new.md", "body"]]);
  });

  it("treats losing a create race as success when both sides wrote the same bytes", async () => {
    // A reconcile and a `files_pushed` notification can pull one path at once. Both
    // read `null` from the index before either `createBinary` resolves, and the app
    // refuses the loser with `File already exists.` — harmless when both wrote the
    // same version, and the pull must not fail for it.
    const { vault, meaningful } = recordingVault();
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));
    const bytes = new TextEncoder().encode("same");

    await Promise.all([adapter.writeFile("note.md", bytes), adapter.writeFile("note.md", bytes)]);

    const creates = meaningful().filter(([method]) => method === "createBinary");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.[2]).toBe("same");
  });

  it("rethrows the create race when the file that won holds different bytes", async () => {
    // The other half of the same rule: overwriting would destroy content the engine
    // has not seen, so the loser must report the failure rather than adopt the file.
    const { vault, meaningful } = recordingVault();
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const results = await Promise.allSettled([
      adapter.writeFile("note.md", new TextEncoder().encode("mine")),
      adapter.writeFile("note.md", new TextEncoder().encode("theirs")),
    ]);

    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as Error).message).toMatch(/File already exists/);
    // Exactly one call created the file; the loser did not write over it.
    expect(meaningful().filter(([method]) => method === "createBinary")).toHaveLength(1);
  });

  it("still reports a create failure that left no file behind", async () => {
    const { vault } = recordingVault({}, [], ".obsidian", { failingCreates: ["note.md"] });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    // The catch above is not a blanket swallow: when the path is still absent, the
    // original failure is the truth and must reach the caller.
    await expect(adapter.writeFile("note.md", new TextEncoder().encode("body"))).rejects.toThrow(
      /EACCES/,
    );
  });

  it("still reports a folder it genuinely could not create", async () => {
    const { vault } = recordingVault({}, [], ".obsidian", {
      uncreatableFolders: ["folder"],
    });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    await expect(
      adapter.writeFile("folder/new.md", new TextEncoder().encode("body")),
    ).rejects.toThrow(/EPERM/);
  });

  it("writes a root-level file without touching any folder", async () => {
    const { vault, meaningful } = recordingVault();
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    await adapter.writeFile("top.md", new TextEncoder().encode("body"));

    expect(meaningful()).toEqual([["createBinary", "top.md", "body"]]);
  });

  it("reads bytes for a tracked file and null for anything else", async () => {
    const { vault, calls } = recordingVault({ "a.md": "content" });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const bytes = await adapter.readFile("a.md");
    expect(new TextDecoder().decode(bytes!)).toBe("content");
    expect(await adapter.readFile("missing.md")).toBeNull();
    // A folder-shaped entry is not a file: no read should be attempted.
    expect(calls.filter(([method]) => method === "readBinary").length).toBe(1);
  });

  it("prepares the target folder before renaming into it, and skips a missing source", async () => {
    const { vault, meaningful } = recordingVault({ "old.md": "x" });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    await adapter.renameFile("old.md", "folder/new.md");
    await adapter.renameFile("never-existed.md", "folder/other.md");

    // A peer moving a note into a folder this device lacks needs the folder
    // first, and a missing source must not create anything.
    expect(meaningful()).toEqual([
      ["createFolder", "folder"],
      ["rename", "old.md", "folder/new.md"],
    ]);
  });

  it("ignores a delete for a path Obsidian does not know", async () => {
    const { vault, meaningful } = recordingVault({ "gone.md": "x" });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    await adapter.deleteFile("gone.md");
    await adapter.deleteFile("never-existed.md");

    expect(meaningful()).toEqual([["delete", "gone.md"]]);
  });

  it("treats a delete another writer already carried out as done", async () => {
    // The window is the index's, not a microtask: `Vault.delete` awaits only the adapter's
    // unlink, and the watcher drops the entry a pass later. A peer's delete arriving
    // through sync — or a second pull of the same delete head — therefore leaves the path
    // listed while the disk no longer holds it, and this unlink answers `ENOENT`. The
    // deletion the pull was asked for has happened; reporting a failed pull for it would
    // turn a succeeded delete into an error the host shows the user.
    const { vault, calls } = recordingVault({}, [], ".obsidian", { vanishedDeletes: ["gone.md"] });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    await expect(adapter.deleteFile("gone.md")).resolves.toBeUndefined();

    expect(calls.some(([method, path]) => method === "delete" && path === "gone.md")).toBe(true);
    // The adapter asked the disk, not the stale index, before accepting the outcome.
    expect(calls).toContainEqual(["adapter.exists", "gone.md"]);
  });

  it("still reports a delete whose file is still on disk", async () => {
    // Not a blanket swallow: a failed unlink that left the file in place (permissions,
    // a vanished parent) is a real failure and stays the caller's error.
    const { vault } = recordingVault({ "stuck.md": "x" }, [], ".obsidian", {
      failingDeletes: ["stuck.md"],
    });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    await expect(adapter.deleteFile("stuck.md")).rejects.toThrow(/EACCES/);
  });

  it("lists markdown files without the conflict files", async () => {
    const { vault } = recordingVault({
      "note.md": "",
      "other.md": "",
      "note-2026-01-01-090000.conflict.md": "",
    });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    expect(await adapter.listSyncableFiles()).toEqual(["note.md", "other.md"]);
  });
});

/**
 * The streaming half. Obsidian has no API that appends to a vault file and keeps the
 * index in step, so a large download is written to `.courier/tmp` through the data
 * adapter and renamed into place. These cases pin the two properties that matter:
 * the target never exists half-written, and an aborted write leaves the old file.
 */
describe("ObsidianVaultAdapter — streaming writes", () => {
  it("writes chunks to a hidden temporary file and renames once", async () => {
    const { vault, meaningful } = recordingVault();
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("media/big.mp4");
    await writer.write(new TextEncoder().encode("abcd"));
    await writer.write(new TextEncoder().encode("ef"));

    // Nothing at the target while the chunks arrive — a watcher must never read a
    // partial file and push it as an edit.
    expect(await adapter.readFile("media/big.mp4")).toBeNull();

    const calls = meaningful();
    const temp = calls.find(
      ([method, path]) =>
        method === "adapter.writeBinary" &&
        typeof path === "string" &&
        path.startsWith(".courier/tmp/"),
    )?.[1] as string | undefined;
    expect(temp).toMatch(/^\.courier\/tmp\/[^/]+\.part$/);
    expect(calls).toContainEqual(["adapter.appendBinary", temp, "ef"]);

    await writer.close();

    expect(decode(await adapter.readFile("media/big.mp4"))).toBe("abcdef");
    expect(meaningful()).toContainEqual(["adapter.rename", temp, "media/big.mp4"]);
    // The target is in the sync listing; the temporary folder never is.
    expect(await adapter.listSyncableFiles()).toEqual(["media/big.mp4"]);
  });

  it("replaces an existing file only when the stream commits", async () => {
    const { vault } = recordingVault({ "note.md": "old" });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("note.md");
    await writer.write(new TextEncoder().encode("new"));
    expect(decode(await adapter.readFile("note.md"))).toBe("old");

    await writer.close();
    expect(decode(await adapter.readFile("note.md"))).toBe("new");
  });

  it("discards the temporary file and keeps the old content on abort", async () => {
    const { vault, meaningful } = recordingVault({ "note.md": "old" });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("note.md");
    await writer.write(new TextEncoder().encode("partial"));
    await writer.abort();
    await writer.abort();

    expect(decode(await adapter.readFile("note.md"))).toBe("old");
    expect(meaningful().some(([method]) => method === "adapter.rename")).toBe(false);
    // The engine's `finally` may call abort after a failed close; a second remove of an
    // already-discarded file must not throw.
    expect(meaningful().filter(([method]) => method === "adapter.remove")).toHaveLength(1);
  });

  it("streams a settings file through the data adapter too", async () => {
    const { vault } = recordingVault({}, [".obsidian"]);
    const adapter = new ObsidianVaultAdapter(vault, SETTINGS, fileManagerFor(vault));

    const writer = await adapter.beginWrite(".obsidian/snippets/wide.css");
    await writer.write(new TextEncoder().encode("body {}"));
    await writer.close();

    expect(decode(await adapter.readFile(".obsidian/snippets/wide.css"))).toBe("body {}");
  });

  it("turns a stream with no chunk into an empty file", async () => {
    // The engine only streams a version above 8 MiB, so this is the adapter contract's
    // edge, not a pull the engine makes today: `close` still has to produce the target.
    const { vault } = recordingVault();
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("empty.md");
    await writer.close();

    expect(decode(await adapter.readFile("empty.md"))).toBe("");
  });

  it("reports a streamed file while the index lags, and lets it go once indexed", async () => {
    // A rename through the data adapter fires no vault event; the app's watcher indexes
    // the file a pass later. In that window a reconcile must still list, stat and read
    // it, or the chain looks deleted here and a tombstone would be pushed.
    const lagging = new Set<string>();
    const { vault } = recordingVault({}, [], ".obsidian", { laggingIndex: lagging });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("media/big.mp4");
    await writer.write(new TextEncoder().encode("data"));
    lagging.add("media/big.mp4");
    await writer.close();

    // The index is blind, but the listing and the reads are not.
    expect(await adapter.listSyncableFiles()).toEqual(["media/big.mp4"]);
    expect(await adapter.statFile("media/big.mp4")).toEqual({ sizeBytes: 4, mtimeMs: 0 });
    expect(decode(await adapter.readFile("media/big.mp4"))).toBe("data");

    // Once the watcher catches up the pending entry is dropped and the index carries it.
    lagging.delete("media/big.mp4");
    expect(await adapter.listSyncableFiles()).toEqual(["media/big.mp4"]);
  });

  it("forgets a pending streamed path the user deleted before it was indexed", async () => {
    const lagging = new Set<string>();
    const { vault } = recordingVault({}, [], ".obsidian", { laggingIndex: lagging });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("media/gone.mp4");
    await writer.write(new TextEncoder().encode("data"));
    lagging.add("media/gone.mp4");
    await writer.close();
    expect(await adapter.listSyncableFiles()).toEqual(["media/gone.mp4"]);

    // The user removed it through the app before the watcher ever indexed the streamed
    // write: the disk and the index both say absent, so the pending entry must not
    // resurrect it on every later pass.
    await vault.adapter.remove("media/gone.mp4");
    expect(await adapter.listSyncableFiles()).toEqual([]);
  });

  it("deletes a streamed path the index has not caught up with", async () => {
    // A peer's delete can arrive in the watcher window. `Vault.delete` would be a silent
    // no-op (no TFile), leaving the bytes on disk while the engine drops the chain — and
    // the next pass would push it as a new create.
    const lagging = new Set<string>();
    const { vault, meaningful } = recordingVault({}, [], ".obsidian", {
      laggingIndex: lagging,
    });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("media/gone.mp4");
    await writer.write(new TextEncoder().encode("data"));
    lagging.add("media/gone.mp4");
    await writer.close();

    await adapter.deleteFile("media/gone.mp4");

    expect(await adapter.readFile("media/gone.mp4")).toBeNull();
    expect(await adapter.listSyncableFiles()).toEqual([]);
    expect(meaningful()).toContainEqual(["adapter.remove", "media/gone.mp4"]);
  });

  it("writes a small replacement through the index-lag window", async () => {
    const lagging = new Set<string>();
    const { vault } = recordingVault({}, [], ".obsidian", { laggingIndex: lagging });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("media/note.md");
    await writer.write(new TextEncoder().encode("old"));
    lagging.add("media/note.md");
    await writer.close();

    // `Vault.createBinary` would refuse the path; the data adapter is the disk the
    // engine just wrote, and the path stays reportable until the index catches up.
    await adapter.writeFile("media/note.md", new TextEncoder().encode("new"));

    expect(decode(await adapter.readFile("media/note.md"))).toBe("new");
    expect(await adapter.listSyncableFiles()).toEqual(["media/note.md"]);
  });

  it("moves a streamed path the index has not caught up with", async () => {
    const lagging = new Set<string>();
    const { vault } = recordingVault({}, [], ".obsidian", { laggingIndex: lagging });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("media/old.mp4");
    await writer.write(new TextEncoder().encode("payload"));
    lagging.add("media/old.mp4");
    await writer.close();

    // `Vault.rename` needs a TFile; this one only exists on disk so far.
    await adapter.renameFile("media/old.mp4", "archive/new.mp4");

    expect(await adapter.readFile("media/old.mp4")).toBeNull();
    expect(decode(await adapter.readFile("archive/new.mp4"))).toBe("payload");
    expect(await adapter.listSyncableFiles()).toEqual(["archive/new.mp4"]);
  });

  it("serves the replaced file's disk stat while the index is stale", async () => {
    // A data-adapter rename does not refresh the TFile Obsidian still holds. Recording
    // the old file's size/mtime with the new content hash would let the next pass trust
    // the old stamp for the new bytes.
    const stale = new Map([["media/big.mp4", { size: 3, mtime: 1 }]]);
    const { vault } = recordingVault({ "media/big.mp4": "old" }, [], ".obsidian", {
      staleIndexStats: stale,
    });
    const adapter = new ObsidianVaultAdapter(vault, undefined, fileManagerFor(vault));

    const writer = await adapter.beginWrite("media/big.mp4");
    await writer.write(new TextEncoder().encode("new-data"));
    await writer.close();

    expect(await adapter.statFile("media/big.mp4")).toEqual({ sizeBytes: 8, mtimeMs: 0 });

    // Once the watcher's stat agrees with the disk, the index is the cheap answer again.
    stale.delete("media/big.mp4");
    expect(await adapter.statFile("media/big.mp4")).toEqual({ sizeBytes: 8, mtimeMs: 0 });
  });
});

/**
 * The settings half. Obsidian keeps the config folder out of the vault index, so
 * none of the `Vault` methods can reach it: a settings file has to be listed by
 * walking `vault.adapter.list` and read/written through `vault.adapter`, or it
 * simply never syncs (and a pull would put a config file into the note tree).
 */
describe("ObsidianVaultAdapter — excluded folders", () => {
  const scope = normalizeScope({ fileTypes: NO_FILE_TYPES, excludedFolders: ["private"] });

  /**
   * The engine asks for this listing when a tracked file has disappeared and it has to
   * tell a move into an excluded folder from a deletion. Obsidian indexes those files
   * like any other vault file, so the adapter answers without touching the disk — but
   * the sync listing must keep leaving them out.
   */
  it("lists the indexed files under an excluded folder, separately from the sync listing", async () => {
    const { vault } = recordingVault({
      "note.md": "public",
      "private/a.md": "a",
      "private/deep/b.md": "b",
      "private/a-2026-02-14-101530.conflict.md": "parked",
      "private2/c.md": "c",
    });
    const adapter = new ObsidianVaultAdapter(vault, scope, fileManagerFor(vault));

    expect(await adapter.listExcludedFiles()).toEqual(["private/a.md", "private/deep/b.md"]);
    expect(await adapter.listSyncableFiles()).toEqual(["note.md", "private2/c.md"]);
  });

  it("lists no excluded files when the scope excludes nothing", async () => {
    const { vault } = recordingVault({ "private/a.md": "a" });

    expect(
      await new ObsidianVaultAdapter(
        vault,
        MARKDOWN_ONLY,
        fileManagerFor(vault),
      ).listExcludedFiles(),
    ).toEqual([]);
  });
});

describe("ObsidianVaultAdapter — the config folder", () => {
  it("routes a settings file through the data adapter, not the Vault API", async () => {
    const { vault, meaningful } = recordingVault({ ".obsidian/app.json": '{"theme":"x"}' }, [
      ".obsidian",
    ]);
    const adapter = new ObsidianVaultAdapter(vault, SETTINGS, fileManagerFor(vault));

    const bytes = await adapter.readFile(".obsidian/app.json");
    expect(new TextDecoder().decode(bytes!)).toBe('{"theme":"x"}');
    await adapter.writeFile(".obsidian/app.json", new TextEncoder().encode('{"theme":"y"}'));
    await adapter.renameFile(".obsidian/app.json", ".obsidian/appearance.json");
    await adapter.deleteFile(".obsidian/appearance.json");

    expect(meaningful()).toEqual([
      ["adapter.readBinary", ".obsidian/app.json"],
      ["adapter.writeBinary", ".obsidian/app.json", '{"theme":"y"}'],
      ["adapter.rename", ".obsidian/app.json", ".obsidian/appearance.json"],
      ["adapter.remove", ".obsidian/appearance.json"],
    ]);
  });

  it("creates the config folder chain before a nested settings write", async () => {
    const { vault, meaningful } = recordingVault({}, [".obsidian"]);
    const adapter = new ObsidianVaultAdapter(vault, SETTINGS, fileManagerFor(vault));

    await adapter.writeFile(".obsidian/snippets/deep/wide.css", new TextEncoder().encode("body{}"));

    // `getFolderByPath` cannot answer for a config folder, so the adapter's own
    // `exists` decides — and only the missing steps are created.
    expect(meaningful()).toEqual([
      ["adapter.mkdir", ".obsidian/snippets"],
      ["adapter.mkdir", ".obsidian/snippets/deep"],
      ["adapter.writeBinary", ".obsidian/snippets/deep/wide.css", "body{}"],
    ]);
  });

  it("reads a missing settings file as absent instead of throwing", async () => {
    const { vault } = recordingVault({}, [".obsidian"]);
    const adapter = new ObsidianVaultAdapter(vault, SETTINGS, fileManagerFor(vault));

    expect(await adapter.readFile(".obsidian/app.json")).toBeNull();
    // A delete for a file that is not there is a no-op, not an error.
    await expect(adapter.deleteFile(".obsidian/app.json")).resolves.toBeUndefined();
  });

  it("walks the settings it is allowed to sync and prunes the rest", async () => {
    const { vault, calls } = recordingVault(
      {
        ".obsidian/app.json": "{}",
        ".obsidian/workspace.json": "{}",
        ".obsidian/snippets/wide.css": "body{}",
        ".obsidian/themes/Minimal/theme.css": "body{}",
        ".obsidian/themes/Minimal/manifest.json": "{}",
        ".obsidian/plugins/dataview/main.js": "module.exports={}",
        ".obsidian/plugins/dataview/data.json": "{}",
        ".obsidian/plugins/courier/data.json": '{"deviceName":"x"}',
        ".obsidian/cache/hashes.json": "{}",
        "note.md": "# note",
      },
      [
        ".obsidian",
        ".obsidian/snippets",
        ".obsidian/themes",
        ".obsidian/themes/Minimal",
        ".obsidian/plugins",
        ".obsidian/plugins/dataview",
        ".obsidian/plugins/courier",
        ".obsidian/cache",
      ],
    );

    const settingsOnly = await new ObsidianVaultAdapter(
      vault,
      SETTINGS,
      fileManagerFor(vault),
    ).listSyncableFiles();
    expect(settingsOnly).toEqual([
      ".obsidian/app.json",
      ".obsidian/snippets/wide.css",
      ".obsidian/themes/Minimal/manifest.json",
      ".obsidian/themes/Minimal/theme.css",
      "note.md",
    ]);
    // Plugins and the cache are not even enumerated while their switch is off.
    expect(calls.some(([, path]) => path === ".obsidian/plugins")).toBe(false);
    expect(calls.some(([, path]) => path === ".obsidian/cache")).toBe(false);

    const withPlugins = await new ObsidianVaultAdapter(
      vault,
      PLUGINS,
      fileManagerFor(vault),
    ).listSyncableFiles();
    expect(withPlugins).toEqual([
      ".obsidian/app.json",
      ".obsidian/plugins/dataview/data.json",
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/snippets/wide.css",
      ".obsidian/themes/Minimal/manifest.json",
      ".obsidian/themes/Minimal/theme.css",
      "note.md",
    ]);
    // Still never this plugin's own folder.
    expect(withPlugins.some((path) => path.includes("plugins/courier"))).toBe(false);
  });

  it("walks an unknown config subfolder only for the otherFiles group", async () => {
    const files = {
      ".obsidian/app.json": "{}",
      ".obsidian/notes.txt": "scratch",
      ".obsidian/my-tool/state.json": '{"x":1}',
      ".obsidian/icons/star.svg": "<svg/>",
    };
    const folders = [".obsidian", ".obsidian/my-tool", ".obsidian/icons"];

    const settingsVault = recordingVault(files, folders).vault;
    const settingsOnly = await new ObsidianVaultAdapter(
      settingsVault,
      SETTINGS,
      fileManagerFor(settingsVault),
    ).listSyncableFiles();
    expect(settingsOnly).toEqual([".obsidian/app.json"]);

    const { vault, calls } = recordingVault(files, folders);
    const withOther = await new ObsidianVaultAdapter(
      vault,
      scopeWith("otherFiles"),
      fileManagerFor(vault),
    ).listSyncableFiles();
    // The unclaimed paths only — `app.json` belongs to a group that is off.
    expect(withOther).toEqual([
      ".obsidian/icons/star.svg",
      ".obsidian/my-tool/state.json",
      ".obsidian/notes.txt",
    ]);
    expect(calls.some(([, path]) => path === ".obsidian/my-tool")).toBe(true);
  });

  it("lists no settings at all when the scope is markdown only", async () => {
    const { vault, calls } = recordingVault({ ".obsidian/app.json": "{}", "note.md": "" }, [
      ".obsidian",
    ]);
    const adapter = new ObsidianVaultAdapter(vault, MARKDOWN_ONLY, fileManagerFor(vault));

    expect(await adapter.listSyncableFiles()).toEqual(["note.md"]);
    expect(calls.some(([method]) => method === "adapter.list")).toBe(false);
  });
});
