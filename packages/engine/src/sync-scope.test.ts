import { describe, expect, it } from "vitest";
import { sortedCopy } from "@courier/shared";
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_SYNC_SCOPE,
  NO_SETTINGS_GROUPS,
  OBSIDIAN_DEFAULT_GROUPS,
  SETTINGS_GROUPS,
  isConfigPath,
  isExcludedPath,
  isSyncableDir,
  isSyncablePath,
  normalizeExcludedFolders,
  normalizeScope,
  outOfScopeReason,
  settingsGroupOf,
  syncsAnySettings,
  withinFileSizeCap,
  type SettingsGroup,
  type SyncScope,
} from "./sync-scope";
import {
  DEFAULT_FILE_TYPES,
  FILE_TYPE_GROUPS,
  NO_FILE_TYPES,
  fileTypeOf,
  type FileTypeGroup,
} from "./file-types";

/**
 * The scope is the single answer to "may this device sync this path", and the
 * grouping is what makes it controllable: a device can sync appearance and not
 * hotkeys, images and not video, a core plugin's settings and not the theme. The scope
 * is applied on both ends of the wire (the local listing and the remote chains), so a
 * mistake here is either a file that silently stops syncing or one that reaches a device
 * which never asked for it.
 */

/**
 * A scope with exactly the named config-folder groups on and **no** vault file types —
 * i.e. markdown and canvas only, the strictest scope a device can have.
 */
function scopeWith(...groups: SettingsGroup[]): SyncScope {
  const settingsGroups: Record<string, boolean> = {};
  for (const group of groups) settingsGroups[group] = true;
  return normalizeScope({ settingsGroups, fileTypes: NO_FILE_TYPES, configDir: THE_CONFIG_DIR });
}

/**
 * The same, with exactly the named vault file types on — every other type explicitly
 * off, because a missing key keeps its default (on) in `normalizeScope`.
 */
function scopeWithFileTypes(...types: FileTypeGroup[]): SyncScope {
  const fileTypes: Record<string, boolean> = { ...NO_FILE_TYPES };
  for (const type of types) fileTypes[type] = true;
  return normalizeScope({ fileTypes, configDir: THE_CONFIG_DIR });
}

/** The config folder the fixtures describe; the app owns the real one. */
const THE_CONFIG_DIR = ".obsidian";

const OFF = scopeWith();
const OBSIDIAN_DEFAULT = normalizeScope({
  settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
  fileTypes: DEFAULT_FILE_TYPES,
});
const EVERYTHING = normalizeScope({
  settingsGroups: Object.fromEntries(SETTINGS_GROUPS.map((group) => [group, true])),
  fileTypes: Object.fromEntries(FILE_TYPE_GROUPS.map((type) => [type, true])),
});
const OTHER_FILES_ONLY = scopeWith("otherFiles");
const MEDIA_ONLY = scopeWithFileTypes("images", "video", "audio", "pdf");

describe("normalizeScope", () => {
  it("defaults to Obsidian's file types, no config group and the 50 MB cap", () => {
    expect(normalizeScope()).toEqual(DEFAULT_SYNC_SCOPE);
    expect(normalizeScope().fileTypes).toEqual(DEFAULT_FILE_TYPES);
    expect(normalizeScope().maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(normalizeScope({ configDir: ".obsidian" }).settingsGroups).toEqual(NO_SETTINGS_GROUPS);
    expect(normalizeScope().excludedFolders).toEqual([]);
  });

  it("fills in a partially specified file-type record from the defaults, not from false", () => {
    // A host that only knows about one type must not silently turn the others off.
    const scope = normalizeScope({ fileTypes: { video: false } });
    expect(scope.fileTypes.video).toBe(false);
    expect(scope.fileTypes.images).toBe(true);
    expect(scope.fileTypes.pdf).toBe(true);
    expect(scope.fileTypes.otherTypes).toBe(false);
    // Junk in the record is ignored the same way.
    const junk = normalizeScope({ fileTypes: { images: "yes" } as never });
    expect(junk.fileTypes.images).toBe(true);
    expect(sortedCopy(Object.keys(junk.fileTypes))).toEqual(sortedCopy(FILE_TYPE_GROUPS));
  });

  it("normalizes the size cap: 0 and positive integers pass, junk falls back", () => {
    expect(normalizeScope({ maxFileBytes: 0 }).maxFileBytes).toBe(0);
    expect(normalizeScope({ maxFileBytes: 1024 }).maxFileBytes).toBe(1024);
    expect(normalizeScope({ maxFileBytes: -1 }).maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(normalizeScope({ maxFileBytes: 1.5 }).maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(normalizeScope({ maxFileBytes: Number.NaN }).maxFileBytes).toBe(DEFAULT_MAX_FILE_BYTES);
    expect(normalizeScope({ maxFileBytes: Number.MAX_SAFE_INTEGER + 2 }).maxFileBytes).toBe(
      DEFAULT_MAX_FILE_BYTES,
    );
  });

  it("fills in a partially specified group record", () => {
    const scope = normalizeScope({ settingsGroups: { app: true } as never });
    expect(scope.settingsGroups.app).toBe(true);
    expect(scope.settingsGroups.appearance).toBe(false);
    expect(sortedCopy(Object.keys(scope.settingsGroups))).toEqual(sortedCopy(SETTINGS_GROUPS));
  });

  it("only honors an explicit true", () => {
    const scope = normalizeScope({ settingsGroups: { app: 1, appearance: "yes" } as never });
    expect(scope.settingsGroups.app).toBe(false);
    expect(scope.settingsGroups.appearance).toBe(false);
  });

  it("trims stray slashes off the config folder, and reads a blank one as absent", () => {
    expect(normalizeScope({ configDir: "/.config/" }).configDir).toBe(".config");
    // The engine has no default of its own: the name is the app's, and a host without an
    // Obsidian (the CLI) syncs no config folder at all.
    expect(normalizeScope({ configDir: "" }).configDir).toBe("");
    expect(normalizeScope({ configDir: "/" }).configDir).toBe("");
    expect(normalizeScope().configDir).toBe("");
  });

  it("never shares one normalized group record with another scope", () => {
    const first = normalizeScope({ settingsGroups: { app: true } });
    first.settingsGroups.app = false;
    expect(normalizeScope().settingsGroups.app).toBe(false);
    expect(NO_SETTINGS_GROUPS.app).toBe(false);
  });

  it("normalizes the excluded-folder list into a fresh, de-duplicated array", () => {
    const scope = normalizeScope({
      excludedFolders: [" /private/ ", "private\\sub", "private", "", ".", "..", "a//b"],
    });
    expect(scope.excludedFolders).toEqual(["private", "private/sub", "a/b"]);
    // A list from a hand-edited file can be anything at all.
    expect(normalizeScope({ excludedFolders: "private" as never }).excludedFolders).toEqual([]);
    expect(normalizeExcludedFolders([42, null, "ok"] as never)).toEqual(["ok"]);
    // Not the module-level default array: mutating one scope must not leak into another.
    scope.excludedFolders.push("late");
    expect(normalizeScope().excludedFolders).toEqual([]);
    expect(DEFAULT_SYNC_SCOPE.excludedFolders).toEqual([]);
  });
});

describe("excluded folders", () => {
  const scope = normalizeScope({
    fileTypes: Object.fromEntries(FILE_TYPE_GROUPS.map((type) => [type, true])),
    excludedFolders: ["private", "notes/archive"],
  });

  it("excludes the folder itself and everything under it, but not a same-prefix sibling", () => {
    expect(isExcludedPath("private", scope)).toBe(true);
    expect(isExcludedPath("private/a.md", scope)).toBe(true);
    expect(isExcludedPath("private/deep/a.md", scope)).toBe(true);
    expect(isExcludedPath("private2/a.md", scope)).toBe(false);
    expect(isExcludedPath("notes/archive-v2/a.md", scope)).toBe(false);
    expect(isExcludedPath("notes/archive", scope)).toBe(true);
  });

  it("removes excluded paths from the syncable set, whatever their file type", () => {
    expect(isSyncablePath("private/a.md", scope)).toBe(false);
    // Images are on in this scope; exclusion still wins.
    expect(isSyncablePath("private/photo.png", scope)).toBe(false);
    expect(isSyncablePath("notes/archive/plan.md", scope)).toBe(false);
    expect(isSyncablePath("public.md", scope)).toBe(true);
  });

  it("does not apply to the config folder, whose paths the groups own", () => {
    const withSettings = normalizeScope({
      configDir: THE_CONFIG_DIR,
      settingsGroups: { app: true },
      excludedFolders: [".obsidian"],
    });
    expect(isSyncablePath(".obsidian/app.json", withSettings)).toBe(true);
    expect(isExcludedPath(".obsidian/app.json", withSettings)).toBe(true);
  });

  it("prunes an excluded directory without descending into it", () => {
    expect(isSyncableDir("private", scope)).toBe(false);
    expect(isSyncableDir("private/deep", scope)).toBe(false);
    expect(isSyncableDir("private2", scope)).toBe(true);
    // The config folder is not a vault folder for the exclusion list.
    expect(
      isSyncableDir(
        ".obsidian",
        normalizeScope({ configDir: THE_CONFIG_DIR, excludedFolders: [".obsidian"] }),
      ),
    ).toBe(true);
  });

  it("keeps markdown outside the excluded folder untouched", () => {
    expect(isSyncablePath("notes/plan.md", scope)).toBe(true);
    expect(isSyncablePath("notes/deep/plan.md", scope)).toBe(true);
  });
});

describe("syncsAnySettings", () => {
  it("is false only when every group is off", () => {
    expect(syncsAnySettings(OFF)).toBe(false);
    expect(syncsAnySettings(scopeWith("otherFiles"))).toBe(true);
    expect(syncsAnySettings(EVERYTHING)).toBe(true);
  });
});

describe("isSyncablePath — markdown and canvas", () => {
  it("syncs markdown anywhere outside a dot-folder", () => {
    expect(isSyncablePath("note.md", OFF)).toBe(true);
    expect(isSyncablePath("notes/deep/plan.md", OFF)).toBe(true);
  });

  it("syncs canvas on the same terms: always, and not switchable", () => {
    for (const scope of [OFF, MEDIA_ONLY, EVERYTHING]) {
      expect(isSyncablePath("drawing.canvas", scope)).toBe(true);
      expect(isSyncablePath("boards/deep/plan.canvas", scope)).toBe(true);
    }
    // `.markdown` is not in Obsidian's documented list: it is an "other type".
    expect(isSyncablePath("note.markdown", OFF)).toBe(false);
    expect(isSyncablePath("note.markdown", scopeWithFileTypes("otherTypes"))).toBe(true);
  });

  it("keeps dot-folders out, whatever the switches say", () => {
    for (const scope of [OFF, OBSIDIAN_DEFAULT, EVERYTHING, OTHER_FILES_ONLY, MEDIA_ONLY]) {
      expect(isSyncablePath(".hidden/secret.md", scope)).toBe(false);
      expect(isSyncablePath(".courier/sync_state.json", scope)).toBe(false);
      expect(isSyncablePath(".git/notes.md", scope)).toBe(false);
      // Obsidian's trash is a dot-folder: a deleted attachment must not travel.
      expect(isSyncablePath(".trash/photo.png", scope)).toBe(false);
      // A hidden file inside an ordinary folder is still hidden.
      expect(isSyncablePath("notes/.hidden.md", scope)).toBe(false);
      expect(isSyncablePath("", scope)).toBe(false);
    }
  });

  it("never syncs a parked conflict file, config folder included", () => {
    expect(isSyncablePath("notes/plan-2026-02-14-101530.conflict.md", OFF)).toBe(false);
    expect(isSyncablePath(".obsidian/app-2026-02-14-101530.conflict.md", EVERYTHING)).toBe(false);
    // A parked binary copy keeps its extension — and still must not sync, even with its
    // own category on (the conflict check runs before the file-type rules).
    expect(isSyncablePath("photos/raw-2026-02-14-101530.conflict.png", EVERYTHING)).toBe(false);
  });
});

describe("isSyncablePath — vault file types", () => {
  const BY_TYPE: Array<[FileTypeGroup, string[]]> = [
    ["images", ["a.png", "photos/deep/b.JPG", "icon.svg", "shot.webp"]],
    ["audio", ["song.mp3", "voice.wav", "clip.ogg", "take.3gp"]],
    ["video", ["movie.mp4", "clip.webm", "scene.mkv", "reel.mov"]],
    ["pdf", ["paper.pdf", "docs/deep/book.PDF"]],
    ["otherTypes", ["notes.base", "board.excalidraw", "bundle.zip", "LICENSE"]],
  ];

  it("keeps a file type out until its own switch is on", () => {
    for (const [type, paths] of BY_TYPE) {
      for (const path of paths) {
        expect(isSyncablePath(path, OFF), `${path} with OFF`).toBe(false);
        expect(isSyncablePath(path, scopeWithFileTypes(type)), `${path} with ${type}`).toBe(true);
      }
    }
  });

  it("gives every extension exactly one owner", () => {
    // `.webm` is Obsidian's only double listing (audio and video); video owns it.
    expect(fileTypeOf("clip.webm")).toBe("video");
    expect(isSyncablePath("clip.webm", scopeWithFileTypes("audio"))).toBe(false);
    for (const [type, paths] of BY_TYPE) {
      for (const path of paths) {
        expect(fileTypeOf(path), path).toBe(type);
      }
    }
  });

  it("is independent per type: one switch does not carry another's files", () => {
    const images = scopeWithFileTypes("images");
    expect(isSyncablePath("a.png", images)).toBe(true);
    expect(isSyncablePath("a.mp3", images)).toBe(false);
    expect(isSyncablePath("a.pdf", images)).toBe(false);
    expect(isSyncablePath("a.zip", images)).toBe(false);
  });

  it("still owns config-folder paths by their settings group, not by file type", () => {
    // A PNG under a plugin folder needs `communityPlugins`; turning images on must not
    // reach into the config folder.
    const images = scopeWithFileTypes("images");
    expect(isSyncablePath(".obsidian/plugins/x/icon.png", images)).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/x/icon.png", scopeWith("communityPlugins"))).toBe(
      true,
    );
    // …and a theme's image belongs to `themes`, not to `images`.
    expect(isSyncablePath(".obsidian/themes/Minimal/cover.png", images)).toBe(false);
    expect(isSyncablePath(".obsidian/themes/Minimal/cover.png", scopeWith("themes"))).toBe(true);
  });

  it("matches extensions case-insensitively", () => {
    expect(isSyncablePath("PHOTO.PNG", scopeWithFileTypes("images"))).toBe(true);
    expect(isSyncablePath("Movie.MP4", scopeWithFileTypes("video"))).toBe(true);
  });
});

describe("withinFileSizeCap", () => {
  it("treats 0 as no limit and compares the rest inclusively", () => {
    expect(withinFileSizeCap(normalizeScope({ maxFileBytes: 0 }), 10 ** 12)).toBe(true);
    expect(withinFileSizeCap(normalizeScope({ maxFileBytes: 100 }), 100)).toBe(true);
    expect(withinFileSizeCap(normalizeScope({ maxFileBytes: 100 }), 101)).toBe(false);
  });
});

describe("isSyncablePath — one group at a time", () => {
  /** The paths each group owns. */
  const OWNED: Array<[SettingsGroup, string[]]> = [
    ["app", [".obsidian/app.json"]],
    ["appearance", [".obsidian/appearance.json"]],
    ["themes", [".obsidian/themes/Minimal/theme.css", ".obsidian/themes/Minimal/manifest.json"]],
    ["snippets", [".obsidian/snippets/wide.css", ".obsidian/snippets/nested/deep.css"]],
    ["hotkeys", [".obsidian/hotkeys.json"]],
    ["corePlugins", [".obsidian/core-plugins.json"]],
    [
      "corePluginSettings",
      [
        ".obsidian/graph.json",
        ".obsidian/templates.json",
        ".obsidian/daily-notes.json",
        ".obsidian/bookmarks.json",
        ".obsidian/types.json",
        // A core plugin added later writes its settings at the same level.
        ".obsidian/a-core-plugin-we-never-heard-of.json",
      ],
    ],
    ["communityPluginList", [".obsidian/community-plugins.json"]],
    [
      "communityPlugins",
      [
        ".obsidian/plugins/dataview/main.js",
        ".obsidian/plugins/dataview/manifest.json",
        ".obsidian/plugins/dataview/data.json",
        ".obsidian/plugins/dataview/styles.css",
        ".obsidian/plugins/dataview/assets/icon.svg",
      ],
    ],
    [
      "otherFiles",
      [
        ".obsidian/notes.txt",
        ".obsidian/icons/star.svg",
        ".obsidian/my-tool/state.json",
        ".obsidian/my-tool/nested/blob.bin",
      ],
    ],
  ];

  it("syncs exactly the paths of the groups that are on", () => {
    for (const [group, paths] of OWNED) {
      const scope = scopeWith(group);
      for (const path of paths) {
        expect(isSyncablePath(path, scope), `${group} should sync ${path}`).toBe(true);
        expect(isSyncablePath(path, OFF), `${path} should not sync with every group off`).toBe(
          false,
        );
      }
    }
  });

  it("keeps the groups independent of each other", () => {
    expect(isSyncablePath(".obsidian/appearance.json", scopeWith("app"))).toBe(false);
    expect(isSyncablePath(".obsidian/app.json", scopeWith("appearance"))).toBe(false);
    expect(isSyncablePath(".obsidian/hotkeys.json", scopeWith("themes"))).toBe(false);
    expect(isSyncablePath(".obsidian/graph.json", scopeWith("corePlugins"))).toBe(false);
    expect(isSyncablePath(".obsidian/core-plugins.json", scopeWith("corePluginSettings"))).toBe(
      false,
    );
    expect(isSyncablePath(".obsidian/themes/Minimal/theme.css", scopeWith("snippets"))).toBe(false);
  });

  it("separates the enabled-plugin list from the installed plugin files", () => {
    // Obsidian's two switches: the state list and the plugin bodies are unrelated.
    const listOnly = scopeWith("communityPluginList");
    expect(isSyncablePath(".obsidian/community-plugins.json", listOnly)).toBe(true);
    expect(isSyncablePath(".obsidian/plugins/dataview/main.js", listOnly)).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/dataview/data.json", listOnly)).toBe(false);

    const filesOnly = scopeWith("communityPlugins");
    expect(isSyncablePath(".obsidian/plugins/dataview/main.js", filesOnly)).toBe(true);
    expect(isSyncablePath(".obsidian/plugins/dataview/data.json", filesOnly)).toBe(true);
    expect(isSyncablePath(".obsidian/community-plugins.json", filesOnly)).toBe(false);
  });

  it("gives every path exactly one owner, so a catch-all cannot re-open a closed group", () => {
    // `otherFiles` is the catch-all for *unclaimed* paths only: turning it on must
    // not smuggle back files whose own group the user switched off.
    for (const path of [
      ".obsidian/themes/Minimal/theme.css",
      ".obsidian/snippets/wide.css",
      ".obsidian/plugins/dataview/main.js",
      ".obsidian/community-plugins.json",
      ".obsidian/graph.json",
      ".obsidian/app.json",
    ]) {
      expect(isSyncablePath(path, OTHER_FILES_ONLY), `${path} leaked into otherFiles`).toBe(false);
    }
  });
});

describe("isSyncablePath — never synced, whatever the groups say", () => {
  it("keeps the config files that describe one installation", () => {
    for (const path of [
      ".obsidian/workspace.json",
      ".obsidian/workspaces.json",
      ".obsidian/workspace-mobile.json",
      ".obsidian/sync.json",
      ".obsidian/ui-state.json",
      ".obsidian/core-plugins-migration.json",
    ]) {
      expect(isSyncablePath(path, OBSIDIAN_DEFAULT)).toBe(false);
      expect(isSyncablePath(path, EVERYTHING)).toBe(false);
    }
  });

  it("never syncs this plugin's own folder — it holds the device identity", () => {
    for (const path of [
      ".obsidian/plugins/courier/data.json",
      ".obsidian/plugins/courier/main.js",
      ".obsidian/plugins/courier/sync_state.json",
    ]) {
      expect(isSyncablePath(path, EVERYTHING)).toBe(false);
      expect(isSyncablePath(path, scopeWith("communityPlugins"))).toBe(false);
    }
  });

  it("keeps the cache folder and hidden names out", () => {
    expect(isSyncablePath(".obsidian/cache/hashes.json", EVERYTHING)).toBe(false);
    expect(isSyncablePath(".obsidian/.hidden.json", EVERYTHING)).toBe(false);
    expect(isSyncablePath(".obsidian/snippets/.hidden.css", EVERYTHING)).toBe(false);
    expect(isSyncablePath(".obsidian/plugins/courier/notes.md", EVERYTHING)).toBe(false);
  });
});

describe("settingsGroupOf", () => {
  it("names the owning group", () => {
    expect(settingsGroupOf(".obsidian/app.json", OFF)).toBe("app");
    expect(settingsGroupOf(".obsidian/appearance.json", OFF)).toBe("appearance");
    expect(settingsGroupOf(".obsidian/themes/Minimal/theme.css", OFF)).toBe("themes");
    expect(settingsGroupOf(".obsidian/snippets/wide.css", OFF)).toBe("snippets");
    expect(settingsGroupOf(".obsidian/hotkeys.json", OFF)).toBe("hotkeys");
    expect(settingsGroupOf(".obsidian/core-plugins.json", OFF)).toBe("corePlugins");
    expect(settingsGroupOf(".obsidian/templates.json", OFF)).toBe("corePluginSettings");
    expect(settingsGroupOf(".obsidian/community-plugins.json", OFF)).toBe("communityPluginList");
    expect(settingsGroupOf(".obsidian/plugins/dataview/main.js", OFF)).toBe("communityPlugins");
    expect(settingsGroupOf(".obsidian/my-tool/state.json", OFF)).toBe("otherFiles");
  });

  it("is the scope-independent owner, so it answers even with everything off", () => {
    expect(settingsGroupOf("note.md", OFF)).toBeNull();
    expect(settingsGroupOf(".obsidian", OFF)).toBeNull();
    expect(settingsGroupOf(".obsidian/workspace.json", OFF)).toBeNull();
    expect(settingsGroupOf(".obsidian/plugins/courier/data.json", OFF)).toBeNull();
  });
});

describe("isSyncablePath — a vault with a custom config folder", () => {
  it("uses that folder as the settings root and nothing else", () => {
    const custom: SyncScope = { ...EVERYTHING, configDir: ".obsidian-vault" };
    expect(isSyncablePath(".obsidian-vault/app.json", custom)).toBe(true);
    expect(isSyncablePath(".obsidian-vault/plugins/x/main.js", custom)).toBe(true);
    // The default folder of a *different* device is an ordinary dot-folder here.
    expect(isSyncablePath(".obsidian/app.json", custom)).toBe(false);
  });
});

describe("isConfigPath", () => {
  it("matches the folder itself and its contents, not a name prefix", () => {
    expect(isConfigPath(".obsidian", OFF)).toBe(true);
    expect(isConfigPath(".obsidian/app.json", OFF)).toBe(true);
    expect(isConfigPath(".obsidian-notes/app.json", OFF)).toBe(false);
    expect(isConfigPath("notes.md", OFF)).toBe(false);
  });
});

describe("isSyncableDir", () => {
  it("descends into ordinary folders and the root", () => {
    expect(isSyncableDir("", OFF)).toBe(true);
    expect(isSyncableDir("notes", OFF)).toBe(true);
    expect(isSyncableDir("notes/deep", OFF)).toBe(true);
  });

  it("stays out of dot-folders other than the config folder", () => {
    expect(isSyncableDir(".git", EVERYTHING)).toBe(false);
    expect(isSyncableDir(".hidden/deep", EVERYTHING)).toBe(false);
    expect(isSyncableDir(".courier", EVERYTHING)).toBe(false);
  });

  it("enters the config folder and only the subfolders a group covers", () => {
    expect(isSyncableDir(".obsidian", OFF)).toBe(true);
    expect(isSyncableDir(".obsidian/snippets", scopeWith("snippets"))).toBe(true);
    expect(isSyncableDir(".obsidian/snippets", scopeWith("app"))).toBe(false);
    expect(isSyncableDir(".obsidian/snippets/deep", scopeWith("snippets"))).toBe(true);
    expect(isSyncableDir(".obsidian/themes/Minimal", scopeWith("themes"))).toBe(true);
    expect(isSyncableDir(".obsidian/plugins", scopeWith("communityPlugins"))).toBe(true);
    // The enabled-plugin list does not make the plugin folders worth walking.
    expect(isSyncableDir(".obsidian/plugins", scopeWith("communityPluginList"))).toBe(false);
    expect(isSyncableDir(".obsidian/plugins", scopeWith("otherFiles"))).toBe(false);
    expect(isSyncableDir(".obsidian/plugins/courier", EVERYTHING)).toBe(false);
    expect(isSyncableDir(".obsidian/plugins/courier/nested", EVERYTHING)).toBe(false);
    expect(isSyncableDir(".obsidian/cache", EVERYTHING)).toBe(false);
  });

  it("walks an unknown folder only when otherFiles is on", () => {
    expect(isSyncableDir(".obsidian/my-tool", scopeWith("otherFiles"))).toBe(true);
    expect(isSyncableDir(".obsidian/my-tool/nested", scopeWith("otherFiles"))).toBe(true);
    expect(isSyncableDir(".obsidian/my-tool", OBSIDIAN_DEFAULT)).toBe(false);
  });

  it("follows a custom config folder", () => {
    const custom: SyncScope = { ...EVERYTHING, configDir: ".obsidian-vault" };
    expect(isSyncableDir(".obsidian-vault", custom)).toBe(true);
    expect(isSyncableDir(".obsidian-vault/themes", custom)).toBe(true);
    expect(isSyncableDir(".obsidian", custom)).toBe(false);
  });
});

/**
 * Which switch keeps a path off this device, as the sync activity log records it.
 *
 * The reason has to name the *right* setting: a file under an excluded folder and a
 * `.obsidian` group left off are two different pages of the settings, a `.zip` is neither,
 * and a video over the size cap is a fourth rule. The engine reports this at the moment it
 * skips the path, and the history row freezes that answer.
 */
describe("outOfScopeReason", () => {
  /** A device that syncs markdown only, with `private/` excluded and no config groups. */
  const scope = normalizeScope({
    configDir: THE_CONFIG_DIR,
    fileTypes: { images: false, video: false, audio: false, pdf: false, otherTypes: false },
    excludedFolders: ["private"],
  });

  it("says nothing for a file this device does sync", () => {
    expect(outOfScopeReason("notes/hero.md", scope)).toBeNull();
    expect(outOfScopeReason("boards/plan.canvas", scope)).toBeNull();
  });

  it("names the excluded folder, and the folder rule beats the file-type rule", () => {
    expect(outOfScopeReason("private/hero.md", scope)).toBe("folder");
    // An image inside the excluded folder is excluded *because of the folder*: both
    // switches are off here, and naming the file type would send the user to the wrong
    // page — turning images on would still not sync this file.
    expect(outOfScopeReason("private/photo.png", scope)).toBe("folder");
    expect(outOfScopeReason("private/deep/photo.png", scope)).toBe("folder");
  });

  it("names the file type for a category this device switched off", () => {
    expect(outOfScopeReason("assets/photo.png", scope)).toBe("fileType");
    expect(outOfScopeReason("archive.zip", scope)).toBe("fileType");
  });

  it("names the settings group for a config-folder path, never the folder or the type", () => {
    // `.obsidian/plugins/x/icon.png` is a PNG, but inside the config folder the file-type
    // rules do not apply at all — its owner is `communityPlugins`.
    expect(outOfScopeReason(".obsidian/plugins/x/icon.png", scope)).toBe("settingsGroup");
    expect(outOfScopeReason(".obsidian/app.json", scope)).toBe("settingsGroup");
    expect(outOfScopeReason(".obsidian/themes/My/theme.css", scope)).toBe("settingsGroup");
  });

  it("reports a config-folder path as synced once its group is on", () => {
    const withCore = normalizeScope({ ...scope, settingsGroups: { corePlugins: true } });
    expect(outOfScopeReason(".obsidian/core-plugins.json", withCore)).toBeNull();
    // …and only that group: the catch-all group is a different switch.
    expect(outOfScopeReason(".obsidian/app.json", withCore)).toBe("settingsGroup");
  });

  it("never labels a path the engine would also refuse for being hidden", () => {
    // A dot-folder outside the config folder never syncs; the history cannot show one
    // either (it is not a chain), so this only pins that the answer stays a reason
    // rather than throwing on an odd path.
    expect(outOfScopeReason(".git/config", scope)).not.toBeNull();
  });

  it("names the size cap for a version this device skips in both directions", () => {
    const capped = normalizeScope({ ...scope, maxFileBytes: 10 });
    // At the cap is inside it; one byte over is skipped before it is ever read.
    expect(outOfScopeReason("notes/hero.md", capped, 10)).toBeNull();
    expect(outOfScopeReason("notes/hero.md", capped, 11)).toBe("size");
    // `0` bytes is a delete (and any version without content): never a size problem.
    expect(outOfScopeReason("notes/hero.md", capped, 0)).toBeNull();
    // A switch reason wins: raising the cap would still not sync an excluded path.
    expect(outOfScopeReason("private/hero.md", capped, 11)).toBe("folder");
    expect(outOfScopeReason(".obsidian/app.json", capped, 11)).toBe("settingsGroup");
    // The unlimited spelling is `0`, not a tiny cap.
    expect(
      outOfScopeReason("notes/hero.md", normalizeScope({ ...scope, maxFileBytes: 0 }), 1e9),
    ).toBe(null);
  });
});

describe("the Obsidian default set", () => {
  it("covers the documented categories and leaves community plugins opt-in", () => {
    expect(OBSIDIAN_DEFAULT_GROUPS).toEqual({
      app: true,
      appearance: true,
      themes: true,
      snippets: true,
      hotkeys: true,
      corePlugins: true,
      corePluginSettings: true,
      communityPluginList: false,
      communityPlugins: false,
      otherFiles: false,
    });
  });
});
