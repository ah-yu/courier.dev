/**
 * Which **kinds of file** a device syncs, and the extension table that decides it.
 *
 * Markdown (`.md`) and JSON Canvas (`.canvas`) are synced on every device and have
 * no switch: they are the vault's content, and a device that cannot see them is
 * looking at a different vault. Everything else is grouped the way Obsidian's own
 * documentation groups its supported file types, so a user can turn off exactly the
 * category they do not want on another device (a phone that should not pull 4K video,
 * say) instead of all of them at once:
 *
 * - `images` / `audio` / `video` / `pdf` — on by default.
 * - `otherTypes` — everything the tables below do not claim (`.base`, `.excalidraw`,
 *   archives, an extensionless tool file, …), off by default because its provenance
 *   cannot be reasoned about.
 *
 * The table is the one reason this module is separate from `sync-scope.ts`: the scope
 * decides *which paths* sync (config-folder groups, hidden names, the size cap), this
 * decides *what kind of thing* a vault path is.
 */

import type { HistoryKind } from "@courier/shared";

/** A vault-wide file category the user can switch, besides the always-synced ones. */
export type FileTypeGroup = "images" | "video" | "audio" | "pdf" | "otherTypes";

/** Every category, in the order the settings UI shows them. */
export const FILE_TYPE_GROUPS: readonly FileTypeGroup[] = [
  "images",
  "video",
  "audio",
  "pdf",
  "otherTypes",
];

/** Which vault-wide file categories a device syncs. */
export type FileTypeSync = Record<FileTypeGroup, boolean>;

/**
 * The default: Obsidian's own supported file types travel unless a device opts out,
 * and the catch-all stays off.
 */
export const DEFAULT_FILE_TYPES: FileTypeSync = {
  images: true,
  video: true,
  audio: true,
  pdf: true,
  otherTypes: false,
};

/** Every category off — markdown and canvas only. */
export const NO_FILE_TYPES: FileTypeSync = {
  images: false,
  video: false,
  audio: false,
  pdf: false,
  otherTypes: false,
};

/**
 * Extensions synced on every device, whatever the switches say: the note (`.md`) and
 * Obsidian's JSON Canvas (`.canvas`).
 *
 * `.markdown` is deliberately **not** here — Obsidian's documented list names `.md`,
 * and the engine only ever synced `.md`; a `.markdown` file is left to `otherTypes`.
 */
export const ALWAYS_SYNCED_EXTENSIONS: readonly string[] = ["md", "canvas"];

/**
 * The extension table, ordered. An extension claimed by an earlier entry keeps that
 * owner, which is what gives every extension **exactly one** category — `.webm` is
 * Obsidian's only double listing (audio *and* video) and video wins.
 */
const CATEGORY_EXTENSIONS: ReadonlyArray<readonly [FileTypeGroup, readonly string[]]> = [
  ["video", ["mkv", "mov", "mp4", "ogv", "webm"]],
  ["audio", ["flac", "m4a", "mp3", "ogg", "wav", "3gp"]],
  ["images", ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]],
  ["pdf", ["pdf"]],
];

/** Lookup table built from {@link CATEGORY_EXTENSIONS}, first entry wins. */
const EXTENSION_OWNER: ReadonlyMap<string, FileTypeGroup> = (() => {
  const owners = new Map<string, FileTypeGroup>();
  for (const [group, extensions] of CATEGORY_EXTENSIONS) {
    for (const extension of extensions) {
      if (!owners.has(extension)) owners.set(extension, group);
    }
  }
  return owners;
})();

/**
 * A path's extension, lower-cased, without the dot. `""` for a name with no extension
 * and for a dotfile (`.gitignore` is a name, not an extension).
 */
export function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  // dot === 0 is a leading dot, not an extension separator.
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

/**
 * The category a vault path belongs to. `"always"` means markdown or canvas — synced
 * unconditionally; anything the table does not claim is `otherTypes`, so a new
 * Obsidian file type is opt-in rather than silently synced.
 *
 * Ownership is total and exclusive: this never returns null, and no path can belong to
 * two categories. Callers handle hidden names and conflict copies *before* asking (see
 * `isSyncablePath`).
 */
export function fileTypeOf(path: string): FileTypeGroup | "always" {
  const extension = extensionOf(path);
  if (ALWAYS_SYNCED_EXTENSIONS.includes(extension)) return "always";
  return EXTENSION_OWNER.get(extension) ?? "otherTypes";
}

/**
 * Which side of the vault's retention split `path` falls on.
 *
 * Markdown and canvas are the vault's own content and get the deep history; every other
 * synced path (an image, a PDF, a config-folder JSON) is an attachment and gets the
 * shallow one. The number itself is the **vault's** (`VaultHistorySettings`, read by the
 * server when it trims); the client only states this kind on each push, because the
 * category is visible in the plaintext path and nowhere else. The rule is stated here,
 * beside the table that already decides what kind of thing a path is, so both hosts
 * classify a file the same way.
 */
export function historyKindFor(path: string): HistoryKind {
  return fileTypeOf(path) === "always" ? "documents" : "attachments";
}

/**
 * Extensions whose decrypted content is text a UI may render as-is.
 *
 * The fallback half of "how do I show this version": a PNG decoded into a `<pre>` is
 * mojibake, so the plugin's preview rule (`shared/file-preview.ts`) asks the category
 * first and lands here for everything that is not markdown or media — canvas, JSON, CSS,
 * YAML. `svg` is XML text *and* an image, and the category wins there: it is shown as the
 * image it is rather than as source.
 */
const TEXT_PREVIEW_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "canvas",
  "base",
  "json",
  "css",
  "txt",
  "csv",
  "html",
  "xml",
  "yml",
  "yaml",
  "js",
  "ts",
  "svg",
]);

/** Whether a version's content can be shown as text rather than as a binary blob. */
export function isTextPreviewPath(path: string): boolean {
  return TEXT_PREVIEW_EXTENSIONS.has(extensionOf(path));
}
