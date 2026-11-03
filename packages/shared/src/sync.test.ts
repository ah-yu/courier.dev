import { describe, expect, it } from "vitest";
import { DEFAULT_HISTORY_LIMITS, MAX_HISTORY_LIMIT, normalizeHistoryLimit } from "./sync";

/**
 * The two history limits, and the one rule every producer goes through.
 *
 * The value decides what the server **deletes**, so a missing or nonsense number must
 * never reach the wire and never read as "keep one version": `0`, a negative, a fraction
 * and a hand-edited string all fall back to a usable value, and a value past the bound is
 * clamped rather than refused (a settings file that somehow holds 50 000 means "keep
 * everything", which the bound expresses).
 */
describe("history limits", () => {
  it("defaults to 200 versions of a note or canvas and 10 of an attachment", () => {
    expect(DEFAULT_HISTORY_LIMITS).toEqual({ documents: 200, attachments: 10 });
    expect(MAX_HISTORY_LIMIT).toBe(10_000);
  });

  it("reads a usable value as it is, and clamps one past the bound", () => {
    expect(normalizeHistoryLimit(1, 200)).toBe(1);
    expect(normalizeHistoryLimit(200, 10)).toBe(200);
    expect(normalizeHistoryLimit(MAX_HISTORY_LIMIT, 10)).toBe(MAX_HISTORY_LIMIT);
    expect(normalizeHistoryLimit(MAX_HISTORY_LIMIT + 1, 10)).toBe(MAX_HISTORY_LIMIT);
  });

  it("falls back for every value that cannot be a version count", () => {
    // The fallback is the caller's current value, never 1: a typo must not wipe history.
    for (const value of [undefined, null, 0, -3, 1.5, "200", Number.NaN, Infinity, true]) {
      expect(normalizeHistoryLimit(value, 77), String(value)).toBe(77);
    }
  });
});
