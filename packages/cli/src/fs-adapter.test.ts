import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { FileTypeGroup, SettingsGroup, SyncScope } from "@courier/engine";
import {
  NO_FILE_TYPES,
  NO_SETTINGS_GROUPS,
  SETTINGS_GROUPS,
  normalizeScope,
  sha256Hex,
} from "@courier/engine";
import { FsAdapter } from "./fs-adapter";
import { setLocale } from "./i18n";

afterEach(() => {
  setLocale("en");
});

/** A scope with exactly the named config-folder groups on and no vault file types. */
function scopeWith(...groups: SettingsGroup[]): SyncScope {
  const settingsGroups: Record<string, boolean> = { ...NO_SETTINGS_GROUPS };
  for (const group of groups) settingsGroups[group] = true;
  return normalizeScope({ configDir: ".obsidian", settingsGroups, fileTypes: NO_FILE_TYPES });
}

/** A scope with exactly the named vault file types on (no config-folder group). */
function fileTypesWith(...types: FileTypeGroup[]): SyncScope {
  const fileTypes: Record<string, boolean> = { ...NO_FILE_TYPES };
  for (const type of types) fileTypes[type] = true;
  return normalizeScope({ fileTypes });
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
 * The filesystem contract the sync engine relies on when the CLI (or the e2e
 * harness) hosts it.
 *
 * This cannot be tested through `SyncEngine`'s in-memory `FakeAdapter`: a `Map`
 * of paths has no parent folders, no separators and no path-traversal rules, so
 * the engine's own unit tests are blind to exactly the behaviour asserted here.
 * Everything below runs against a real temporary directory.
 */
describe("FsAdapter", () => {
  const roots: string[] = [];

  /**
   * A real temp directory, exposed by its **canonical** path: `resolve()` in the
   * adapter compares against `path.resolve(root)`, so a symlinked root (macOS
   * `/var` → `/private/var`) would make even a legitimate path look like an
   * escape.
   */
  function makeRoot(): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "courier-adapter-")));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates parent folders for a nested write", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root);

    await adapter.writeFile("folder/deep/a.md", new TextEncoder().encode("# deep"));

    expect(statSync(join(root, "folder", "deep")).isDirectory()).toBe(true);
    expect(new TextDecoder().decode((await adapter.readFile("folder/deep/a.md"))!)).toBe("# deep");
  });

  it("renames across folders, creating the target folder", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root);
    await adapter.writeFile("a/x.md", new TextEncoder().encode("content"));

    await adapter.renameFile("a/x.md", "b/c/y.md");

    expect(new TextDecoder().decode((await adapter.readFile("b/c/y.md"))!)).toBe("content");
    expect(await adapter.readFile("a/x.md")).toBeNull();
    expect(await adapter.listSyncableFiles()).toEqual(["b/c/y.md"]);
  });

  it("lists markdown files as sorted, forward-slash, vault-relative paths", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root);
    await adapter.writeFile("zeta.md", new TextEncoder().encode("z"));
    await adapter.writeFile("folder/note.md", new TextEncoder().encode("n"));
    await adapter.writeFile("alpha.md", new TextEncoder().encode("a"));
    // Excluded by extension.
    await adapter.writeFile("folder/data.json", new TextEncoder().encode("{}"));
    await adapter.writeFile("notes-2026-01-01-090000.conflict.md", new TextEncoder().encode("c"));
    // Excluded because a path segment starts with a dot.
    await adapter.writeFile(".obsidian/workspace.md", new TextEncoder().encode("w"));
    await adapter.writeFile(".hidden/secret.md", new TextEncoder().encode("s"));
    await adapter.writeFile("folder/.hidden.md", new TextEncoder().encode("h"));

    expect(await adapter.listSyncableFiles()).toEqual(["alpha.md", "folder/note.md", "zeta.md"]);
  });

  it("lists the vault file types the scope allows, alongside the always-synced pair", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root, fileTypesWith("images", "pdf"));
    const files: Array<[string, string]> = [
      ["assets/raw.png", "png"],
      ["assets/paper.pdf", "pdf"],
      ["assets/board.canvas", "canvas"],
      ["assets/song.mp3", "mp3"],
      ["assets/clip.mp4", "mp4"],
      ["assets/archive.zip", "zip"],
      ["note.md", "note"],
    ];
    for (const [path, content] of files) {
      await adapter.writeFile(path, new TextEncoder().encode(content));
    }

    // Audio, video and the unlisted type are off: they are not even listed.
    expect(await adapter.listSyncableFiles()).toEqual([
      "assets/board.canvas",
      "assets/paper.pdf",
      "assets/raw.png",
      "note.md",
    ]);
  });

  it("reports the files the size cap keeps out, and nothing when there is no cap", async () => {
    const root = makeRoot();
    const capped = new FsAdapter(
      root,
      normalizeScope({ fileTypes: { otherTypes: true }, maxFileBytes: 4 }),
    );
    await capped.writeFile("small.md", new TextEncoder().encode("ok"));
    await capped.writeFile("big.md", new TextEncoder().encode("much too long"));
    await capped.writeFile("archive.zip", new TextEncoder().encode("zip"));

    // `status` reports this list: without it, a file the daemon never uploads is invisible.
    expect(await capped.listOversizeFiles()).toEqual([{ path: "big.md", sizeBytes: 13 }]);
    expect(
      await new FsAdapter(root, normalizeScope({ maxFileBytes: 0 })).listOversizeFiles(),
    ).toEqual([]);
  });

  it("rejects paths that escape the vault root", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root);

    await expect(adapter.readFile("../outside.md")).rejects.toThrow("Path escapes vault root");
    await expect(adapter.writeFile("../../etc/evil.md", new Uint8Array([1]))).rejects.toThrow(
      "Path escapes vault root",
    );
    // The folder a write needs is created by the write itself, so the traversal guard
    // is reached through it too.
    await expect(adapter.writeFile("../sneaky/a.md", new Uint8Array([1]))).rejects.toThrow(
      "Path escapes vault root",
    );
  });

  it("localizes the traversal error", async () => {
    setLocale("zh");
    const adapter = new FsAdapter(makeRoot());

    await expect(adapter.readFile("../outside.md")).rejects.toThrow(
      "路径超出库根目录：../outside.md",
    );
  });

  it("treats a missing file as null / no-op instead of throwing", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root);

    expect(await adapter.readFile("nope.md")).toBeNull();
    await expect(adapter.deleteFile("nope.md")).resolves.toBeUndefined();
  });

  it("creates the folders a write needs, idempotently", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root);

    // Two writes into the same new folder chain: the second must not fail on the
    // folders the first one made.
    await adapter.writeFile("x/y/a.md", new Uint8Array([1]));
    await adapter.writeFile("x/y/b.md", new Uint8Array([2]));
    // A root-level write needs no folder at all.
    await adapter.writeFile("top.md", new Uint8Array([3]));

    expect(existsSync(join(root, "x", "y"))).toBe(true);
    expect(existsSync(join(root, "x", "y", "b.md"))).toBe(true);
  });

  it("reads a file written directly on disk", async () => {
    const root = makeRoot();
    const nested = join(root, "folder", "sub", "direct.md");
    mkdirSync(dirname(nested), { recursive: true });
    writeFileSync(nested, "written by a human");

    const adapter = new FsAdapter(root);
    expect(new TextDecoder().decode((await adapter.readFile("folder/sub/direct.md"))!)).toBe(
      "written by a human",
    );
  });

  it("hashes streamed chunks with the same SHA-256 as the engine", async () => {
    const adapter = new FsAdapter(makeRoot());
    const hasher = adapter.createHasher();
    hasher.update(new TextEncoder().encode("ab"));
    hasher.update(new TextEncoder().encode("cd"));

    expect(hasher.digestHex()).toBe(await sha256Hex(new TextEncoder().encode("abcd")));
  });

  it("streams a write through a temporary file and places it with one rename", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root);
    const writer = await adapter.beginWrite("media/big.mp4");

    await writer.write(new Uint8Array([1, 2, 3]));
    await writer.write(new Uint8Array([4, 5]));

    // The target must not exist while the pieces are arriving: a watcher that read it
    // would see a half-written file and could push it as a local edit.
    expect(existsSync(join(root, "media", "big.mp4"))).toBe(false);
    // The temporary file lives under a hidden folder the scope never lists.
    const temp = join(root, ".courier", "tmp");
    expect(existsSync(temp)).toBe(true);
    expect(await adapter.listSyncableFiles()).toEqual([]);

    await writer.close();

    expect(Array.from((await adapter.readFile("media/big.mp4"))!)).toEqual([1, 2, 3, 4, 5]);
    // Committing consumed the temporary file.
    expect(existsSync(temp) && readdirSync(temp).length > 0).toBe(false);
    // The hidden temporary folder is still not part of the vault listing.
    expect(await adapter.listSyncableFiles()).toEqual(["media/big.mp4"]);
  });

  it("replaces an existing file only when a streamed write commits", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root);
    await adapter.writeFile("note.md", new TextEncoder().encode("old"));

    const writer = await adapter.beginWrite("note.md");
    await writer.write(new TextEncoder().encode("new"));
    expect(new TextDecoder().decode((await adapter.readFile("note.md"))!)).toBe("old");

    await writer.close();
    expect(new TextDecoder().decode((await adapter.readFile("note.md"))!)).toBe("new");
  });

  it("discards the temporary file and keeps the old content when a stream aborts", async () => {
    const root = makeRoot();
    const adapter = new FsAdapter(root);
    await adapter.writeFile("note.md", new TextEncoder().encode("old"));

    const writer = await adapter.beginWrite("note.md");
    await writer.write(new TextEncoder().encode("partial"));
    await writer.abort();
    // A second abort is harmless (the engine calls it from a `finally`).
    await writer.abort();

    expect(new TextDecoder().decode((await adapter.readFile("note.md"))!)).toBe("old");
    const temp = join(root, ".courier", "tmp");
    expect(existsSync(temp) ? readdirSync(temp).length : 0).toBe(0);
  });

  /**
   * Conflict files are the one thing a conflict leaves behind on a headless machine,
   * and they must never be synced: the listing that decides what to push has to
   * exclude them, while `listConflictFiles` is how a host reports them.
   */
  it("keeps conflict files out of the sync listing and reports them separately", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "notes"), { recursive: true });
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    writeFileSync(join(root, "notes", "plan.md"), "the note");
    writeFileSync(join(root, "notes", "plan-2026-02-14-101530.conflict.md"), "the losing side");
    writeFileSync(
      join(root, "notes", "plan-2026-02-14-101530-2.conflict.md"),
      "an older losing side",
    );
    writeFileSync(join(root, "notes", "notes.txt"), "not markdown");
    writeFileSync(join(root, ".obsidian", "app-2026-02-14-101530.conflict.md"), "a parked setting");

    // The config folder is named by whoever owns the vault; this fixture is an Obsidian one.
    const adapter = new FsAdapter(root, normalizeScope({ configDir: ".obsidian" }));

    expect(await adapter.listSyncableFiles()).toEqual(["notes/plan.md"]);
    // The walk enters the config folder's root (only its subfolders are pruned), so a copy
    // sitting there is reported like any other; nothing under `.obsidian` is ever synced.
    expect(await adapter.listConflictFiles()).toEqual([
      ".obsidian/app-2026-02-14-101530.conflict.md",
      "notes/plan-2026-02-14-101530-2.conflict.md",
      "notes/plan-2026-02-14-101530.conflict.md",
    ]);
  });

  it("prunes the config folder's subfolders, which this host never syncs", async () => {
    const root = makeRoot();
    mkdirSync(join(root, ".obsidian", "snippets"), { recursive: true });
    writeFileSync(
      join(root, ".obsidian", "snippets", "wide-2026-02-14-101530.conflict.css"),
      "body {}",
    );

    const adapter = new FsAdapter(root);

    expect(await adapter.listConflictFiles()).toEqual([]);
  });

  it("reports conflict copies inside an excluded folder, but never lists them for sync", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "private"), { recursive: true });
    writeFileSync(join(root, "private", "plan.md"), "the note");
    writeFileSync(join(root, "private", "plan-2026-02-14-101530.conflict.md"), "the losing side");
    writeFileSync(join(root, "public.md"), "the public note");

    const scope = normalizeScope({
      configDir: ".obsidian",
      fileTypes: NO_FILE_TYPES,
      excludedFolders: ["private"],
    });
    const adapter = new FsAdapter(root, scope);

    expect(await adapter.listSyncableFiles()).toEqual(["public.md"]);
    // The exclusion was configured after the conflict was parked (or the folder was
    // excluded with an old copy still inside): status has to keep naming it.
    expect(await adapter.listConflictFiles()).toEqual([
      "private/plan-2026-02-14-101530.conflict.md",
    ]);
  });

  /**
   * The listing the engine uses to tell "moved into an excluded folder" from
   * "deleted": it is walked only when a tracked file disappears, and it has to name
   * every file (whatever its type) exactly once — the engine narrows it by name and
   * content, not this adapter.
   */
  it("lists the files under an excluded folder once, without their conflict copies", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "private", "deep"), { recursive: true });
    mkdirSync(join(root, "private2"), { recursive: true });
    writeFileSync(join(root, "private", "a.md"), "a");
    writeFileSync(join(root, "private", "deep", "b.md"), "b");
    writeFileSync(join(root, "private", "deep", "c.txt"), "c");
    writeFileSync(join(root, "private", "a-2026-02-14-101530.conflict.md"), "parked");
    writeFileSync(join(root, "private2", "d.md"), "d");

    // A nested entry is already covered by its parent; the listing must not repeat it,
    // and the order the user stored them in must not matter (the walk sorts parents
    // before children). `private2` is a separate sibling and must still be walked — a
    // parent check that skips too much would silently drop it.
    const scope = normalizeScope({
      fileTypes: NO_FILE_TYPES,
      excludedFolders: ["private/deep", "private", "private2"],
    });
    const adapter = new FsAdapter(root, scope);

    expect(await adapter.listExcludedFiles()).toEqual([
      "private/a.md",
      "private/deep/b.md",
      "private/deep/c.txt",
      "private2/d.md",
    ]);
  });

  it("lists no excluded files when the scope excludes nothing", async () => {
    const root = makeRoot();
    mkdirSync(join(root, "private"), { recursive: true });
    writeFileSync(join(root, "private", "a.md"), "a");

    expect(await new FsAdapter(root, MARKDOWN_ONLY).listExcludedFiles()).toEqual([]);
  });

  it("ignores an excluded folder that is not on disk", async () => {
    const root = makeRoot();
    const scope = normalizeScope({ fileTypes: NO_FILE_TYPES, excludedFolders: ["missing"] });
    const adapter = new FsAdapter(root, scope);

    // The listing is a fallback for the engine, not a validation of the setting: a
    // deleted folder simply contributes nothing.
    expect(await adapter.listExcludedFiles()).toEqual([]);
  });
});

/**
 * The settings half of the walk. The config folder is the one dot-folder whose
 * contents can be synced, and only the paths the scope allows — the whitelist
 * lives in the engine, so these cases pin that the *walk* reaches the folder and
 * prunes what it must not enumerate.
 *
 * The CLI itself no longer builds such a scope (it never enables a settings group;
 * see `syncScopeOf`). These cases stay because this adapter is also the L1 harness's
 * real-filesystem device, so the engine's config-folder half runs through it.
 */
describe("FsAdapter — the config folder", () => {
  const roots: string[] = [];

  function makeRoot(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "courier-adapter-")));
    roots.push(root);
    for (const [relPath, content] of Object.entries(files)) {
      const absolute = join(root, ...relPath.split("/"));
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
    }
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const VAULT = {
    "note.md": "# note",
    "notes/deep/plan.md": "# plan",
    ".obsidian/app.json": '{"theme":"moonstone"}',
    ".obsidian/workspace.json": "{}",
    ".obsidian/snippets/wide.css": "body {}",
    ".obsidian/themes/Minimal/theme.css": "body {}",
    ".obsidian/plugins/dataview/main.js": "module.exports = {}",
    ".obsidian/plugins/dataview/data.json": "{}",
    ".obsidian/plugins/courier/data.json": '{"deviceName":"x"}',
    ".obsidian/cache/hashes.json": "{}",
  };

  it("lists notes only when the scope is markdown only", async () => {
    const adapter = new FsAdapter(makeRoot(VAULT), MARKDOWN_ONLY);

    expect(await adapter.listSyncableFiles()).toEqual(["note.md", "notes/deep/plan.md"]);
  });

  it("adds the settings files the scope allows", async () => {
    const root = makeRoot(VAULT);

    expect(await new FsAdapter(root, SETTINGS).listSyncableFiles()).toEqual([
      ".obsidian/app.json",
      ".obsidian/snippets/wide.css",
      ".obsidian/themes/Minimal/theme.css",
      "note.md",
      "notes/deep/plan.md",
    ]);

    expect(await new FsAdapter(root, PLUGINS).listSyncableFiles()).toEqual([
      ".obsidian/app.json",
      ".obsidian/plugins/dataview/data.json",
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/snippets/wide.css",
      ".obsidian/themes/Minimal/theme.css",
      "note.md",
      "notes/deep/plan.md",
    ]);
  });

  it("reads and writes a settings file like any other path", async () => {
    const root = makeRoot(VAULT);
    const adapter = new FsAdapter(root, SETTINGS);

    await adapter.writeFile(".obsidian/hotkeys.json", new TextEncoder().encode("[]"));
    await adapter.renameFile(".obsidian/hotkeys.json", ".obsidian/hotkeys-2.json");
    expect(new TextDecoder().decode((await adapter.readFile(".obsidian/hotkeys-2.json"))!)).toBe(
      "[]",
    );
    await adapter.deleteFile(".obsidian/hotkeys-2.json");
    expect(await adapter.readFile(".obsidian/hotkeys-2.json")).toBeNull();
    // The parent folder chain is created for a settings path like any other.
    await adapter.writeFile(".obsidian/snippets/deep/nested.css", new TextEncoder().encode("a{}"));
    expect(existsSync(join(root, ".obsidian", "snippets", "deep", "nested.css"))).toBe(true);
  });
});
