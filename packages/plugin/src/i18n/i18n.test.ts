import { describe, expect, it } from "vitest";
import { sortedCopy } from "@courier/shared";
import {
  getLocale,
  isChineseLocale,
  messagesFor,
  plural,
  resolveObsidianLocale,
  setLocale,
  t,
} from "./index";
import { en } from "./en";
import { zh, type PluginMessageKey } from "./zh";

/**
 * The catalog is the product's entire user-facing copy, so these tests pin the parts a
 * type cannot: both catalogs have the same keys, the English one has no untranslated
 * Chinese, every template renders without a leftover placeholder, and the locale rule is
 * binary (Chinese locales answer Chinese, everything else English).
 */
describe("resolveObsidianLocale", () => {
  it("treats every Chinese locale as Chinese", () => {
    for (const tag of ["zh", "zh-CN", "zh-TW", "zh_Hans", "ZH-cn", " zh "]) {
      expect(isChineseLocale(tag), tag).toBe(true);
      expect(resolveObsidianLocale(tag), tag).toBe("zh");
    }
  });

  it("answers English for every other language and for missing input", () => {
    for (const tag of ["en", "en-US", "fr", "ja", "", "   ", null, undefined]) {
      expect(resolveObsidianLocale(tag), String(tag)).toBe("en");
    }
  });
});

describe("t", () => {
  it("replaces named placeholders in one pass", () => {
    setLocale("zh");
    expect(t("dialog.versionHistory.confirmText", { path: "notes/hero.md", time: "13:58" })).toBe(
      "将把「notes/hero.md」的内容替换为该版本（13:58）。",
    );
    // A `$` in an inserted value is data, not a replacement pattern.
    expect(t("dialog.versionHistory.confirmText", { path: "$&.md", time: "13:58" })).toBe(
      "将把「$&.md」的内容替换为该版本（13:58）。",
    );
    // A missing parameter stays visible rather than silently becoming empty.
    expect(t("dialog.versionHistory.confirmText", {})).toContain("{path}");
  });

  it("switches catalogs with the locale", () => {
    setLocale("en");
    expect(t("common.cancel")).toBe("Cancel");
    expect(t("dialog.versionHistory.confirmText", { path: "notes/hero.md", time: "13:58" })).toBe(
      'Replace the contents of "notes/hero.md" with this version (13:58)?',
    );
    setLocale("zh");
    expect(t("common.cancel")).toBe("取消");
    expect(getLocale()).toBe("zh");
  });

  it("picks singular and plural forms with plural()", () => {
    setLocale("en");
    expect(plural("history.relative.minutes.one", "history.relative.minutes.other", 1)).toBe(
      "1 minute ago",
    );
    expect(plural("history.relative.minutes.one", "history.relative.minutes.other", 2)).toBe(
      "2 minutes ago",
    );
    expect(plural("history.relative.minutes.one", "history.relative.minutes.other", 0)).toBe(
      "0 minutes ago",
    );
    // The count passed to plural() decides the form and the text, even when a caller
    // happens to carry its own `count` in the extra parameters.
    expect(
      plural("history.relative.minutes.one", "history.relative.minutes.other", 2, { count: 9 }),
    ).toBe("2 minutes ago");
  });
});

/**
 * A template whose only text is placeholders/punctuation (e.g. `{id}… — {time}`).
 */
function isFormatOnly(value: string): boolean {
  return value.replace(/\{\w+\}/g, "").replace(/[\s\p{P}\p{S}]/gu, "") === "";
}

describe("catalogs", () => {
  const keys = Object.keys(zh) as PluginMessageKey[];
  /** Values that are legitimately identical in both languages. */
  const SHARED_VALUES = new Set(["PDF", "Markdown", "https://your-server.com"]);

  it("has exactly the same keys in both catalogs", () => {
    expect(sortedCopy(Object.keys(en))).toEqual(sortedCopy(keys));
  });

  it("has a non-empty string for every key in both languages", () => {
    for (const key of keys) {
      expect(zh[key], `zh ${key}`).toBeTypeOf("string");
      expect(en[key], `en ${key}`).toBeTypeOf("string");
      expect(zh[key].trim(), `zh ${key}`).not.toBe("");
      expect(en[key].trim(), `en ${key}`).not.toBe("");
    }
  });

  it("does not leave Chinese in the English catalog", () => {
    for (const key of keys) {
      expect(en[key], `en ${key}`).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("does not silently copy Chinese text into English", () => {
    for (const key of keys) {
      if (zh[key] === en[key] && !isFormatOnly(zh[key])) {
        expect(SHARED_VALUES.has(zh[key]), `untranslated ${key}: ${zh[key]}`).toBe(true);
      }
    }
  });

  it("renders every key without leaving a placeholder behind", () => {
    const names = new Set<string>();
    for (const key of keys) {
      for (const match of zh[key].matchAll(/\{(\w+)\}/g)) names.add(match[1]!);
    }
    const params = Object.fromEntries([...names].map((name) => [name, "x"]));
    for (const locale of ["zh", "en"] as const) {
      setLocale(locale);
      for (const key of keys) {
        expect(t(key, params), `${locale} ${key}`).not.toContain("{");
      }
    }
  });

  it("exposes both complete catalogs", () => {
    expect(messagesFor("zh")).toBe(zh);
    expect(messagesFor("en")).toBe(en);
  });
});
