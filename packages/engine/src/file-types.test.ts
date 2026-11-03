import { describe, expect, it } from "vitest";
import { DEFAULT_HISTORY_LIMITS, sortedCopy } from "@courier/shared";
import {
  ALWAYS_SYNCED_EXTENSIONS,
  DEFAULT_FILE_TYPES,
  FILE_TYPE_GROUPS,
  NO_FILE_TYPES,
  extensionOf,
  fileTypeOf,
  historyKindFor,
  isTextPreviewPath,
} from "./file-types";

/**
 * The extension table decides what kind of thing a vault path is, and the whole switch
 * model rests on it: one extension, one category. The lists are the ones Obsidian
 * documents for its own supported file types, so a file the app can display travels
 * unless the user switches that category off, while anything unrecognised needs the
 * explicit "other types" opt-in.
 */

describe("fileTypeOf", () => {
  it("always syncs markdown and canvas", () => {
    expect(fileTypeOf("note.md")).toBe("always");
    expect(fileTypeOf("notes/deep/plan.md")).toBe("always");
    expect(fileTypeOf("board.canvas")).toBe("always");
    expect(ALWAYS_SYNCED_EXTENSIONS).toEqual(["md", "canvas"]);
  });

  it("covers Obsidian's documented images", () => {
    for (const extension of ["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]) {
      expect(fileTypeOf(`photo.${extension}`), extension).toBe("images");
    }
  });

  it("covers Obsidian's documented audio, minus what video claims", () => {
    for (const extension of ["flac", "m4a", "mp3", "ogg", "wav", "3gp"]) {
      expect(fileTypeOf(`sound.${extension}`), extension).toBe("audio");
    }
  });

  it("covers Obsidian's documented video", () => {
    for (const extension of ["mkv", "mov", "mp4", "ogv", "webm"]) {
      expect(fileTypeOf(`clip.${extension}`), extension).toBe("video");
    }
  });

  it("covers PDF", () => {
    expect(fileTypeOf("paper.pdf")).toBe("pdf");
  });

  it("puts everything unlisted into the opt-in catch-all", () => {
    // `.base` is Obsidian's database format and `.markdown` is not in its documented
    // list — both are note-adjacent, and both stay opt-in with the rest.
    for (const path of [
      "vault.base",
      "note.markdown",
      "board.excalidraw",
      "archive.zip",
      "data.json",
      "style.css",
      "LICENSE",
      "notes/README",
      ".gitignore",
      "photo.heic",
      "clip.wmv",
    ]) {
      expect(fileTypeOf(path), path).toBe("otherTypes");
    }
  });

  it("owns `.webm` exactly once: video, the first table entry that claims it", () => {
    expect(fileTypeOf("clip.webm")).toBe("video");
  });

  it("matches case-insensitively and handles dotted paths", () => {
    expect(fileTypeOf("PHOTO.PNG")).toBe("images");
    expect(fileTypeOf("Docs/Deep/Paper.PDF")).toBe("pdf");
    expect(fileTypeOf("folder.v2/note.md")).toBe("always");
    expect(fileTypeOf("folder.v2/photo.png")).toBe("images");
  });

  it("returns a category for every path, so ownership is total", () => {
    for (const path of ["a.md", "a.png", "a.zip", "a", "a/b/c.mp3"]) {
      const kind = fileTypeOf(path);
      expect(kind === "always" || FILE_TYPE_GROUPS.includes(kind), path).toBe(true);
    }
  });
});

describe("extensionOf", () => {
  it("takes the extension from the file name, lower-cased", () => {
    expect(extensionOf("notes/Plan.MD")).toBe("md");
    expect(extensionOf("a.b/c.png")).toBe("png");
  });

  it("treats a leading dot as part of the name, not as an extension", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("folder/.env")).toBe("");
    expect(extensionOf("no-extension")).toBe("");
  });
});

describe("the default record", () => {
  it("syncs Obsidian's own media types and leaves the catch-all off", () => {
    expect(DEFAULT_FILE_TYPES).toEqual({
      images: true,
      video: true,
      audio: true,
      pdf: true,
      otherTypes: false,
    });
    expect(NO_FILE_TYPES).toEqual({
      images: false,
      video: false,
      audio: false,
      pdf: false,
      otherTypes: false,
    });
  });

  it("lists every group, in the order the UI shows them", () => {
    expect(FILE_TYPE_GROUPS).toEqual(["images", "video", "audio", "pdf", "otherTypes"]);
    expect(sortedCopy(Object.keys(DEFAULT_FILE_TYPES))).toEqual(sortedCopy(FILE_TYPE_GROUPS));
  });
});

describe("historyKindFor", () => {
  it("classifies markdown and canvas as documents", () => {
    for (const path of ["note.md", "notes/deep/plan.md", "board.canvas", "Board.CANVAS"]) {
      expect(historyKindFor(path), path).toBe("documents");
    }
  });

  it("classifies every other synced path as an attachment", () => {
    for (const path of [
      "photo.png",
      "paper.pdf",
      "clip.mp4",
      "archive.zip",
      ".obsidian/app.json",
      "LICENSE",
    ]) {
      expect(historyKindFor(path), path).toBe("attachments");
    }
  });

  it("is total: every path is one of the two kinds", () => {
    // The push frame requires a kind, so a path the table has never seen still gets one
    // instead of an empty field the server would refuse.
    for (const path of ["a.md", "a.png", "a.zip", "a", "a/b/c.mp3"]) {
      expect(["documents", "attachments"]).toContain(historyKindFor(path));
    }
  });

  it("matches the two defaults the vault starts with", () => {
    expect(DEFAULT_HISTORY_LIMITS).toEqual({ documents: 200, attachments: 10 });
  });
});

describe("isTextPreviewPath", () => {
  it("is true for the text formats a version can be shown as", () => {
    for (const path of ["note.md", "board.canvas", "vault.base", "data.json", "style.css"]) {
      expect(isTextPreviewPath(path), path).toBe(true);
    }
    // SVG is XML text even though its category is `images`, so it previews as source.
    expect(isTextPreviewPath("icon.svg")).toBe(true);
  });

  it("is false for binary content, which would render as replacement characters", () => {
    for (const path of ["photo.png", "clip.mp4", "sound.mp3", "paper.pdf", "archive.zip"]) {
      expect(isTextPreviewPath(path), path).toBe(false);
    }
  });
});
