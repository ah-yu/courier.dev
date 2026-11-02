import { describe, expect, it } from "vitest";
import { keyboardInset, revealScrollDelta } from "./visual-viewport";

describe("keyboardInset", () => {
  it("measures the gap between the layout and the visual viewport", () => {
    expect(keyboardInset(844, 460)).toBe(384);
  });

  it("subtracts the visual viewport's scroll offset", () => {
    expect(keyboardInset(844, 460, 40)).toBe(344);
  });

  it("is zero when the platform resized the page instead of overlaying it", () => {
    expect(keyboardInset(460, 460)).toBe(0);
    expect(keyboardInset(460, 500)).toBe(0);
  });

  it("rounds a fractional visual viewport and ignores a non-finite offset", () => {
    expect(keyboardInset(844.4, 459.6)).toBe(385);
    expect(keyboardInset(844, 460, Number.NaN)).toBe(384);
  });

  it("returns zero when either viewport is not a finite number", () => {
    expect(keyboardInset(Number.NaN, 460)).toBe(0);
    expect(keyboardInset(844, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("revealScrollDelta", () => {
  const body = { top: 100, bottom: 500 };

  it("leaves a field that is already visible alone", () => {
    expect(revealScrollDelta(body, { top: 200, bottom: 260 })).toBe(0);
  });

  it("scrolls down when the field runs past the bottom edge", () => {
    expect(revealScrollDelta(body, { top: 440, bottom: 520 })).toBe(32);
  });

  it("keeps the requested margin below the field", () => {
    expect(revealScrollDelta(body, { top: 480, bottom: 500 }, 16)).toBe(16);
  });

  it("scrolls up when the field starts above the top edge", () => {
    expect(revealScrollDelta(body, { top: 60, bottom: 120 })).toBe(-52);
  });

  it("prefers the bottom edge when the body is shorter than the field", () => {
    expect(revealScrollDelta({ top: 100, bottom: 200 }, { top: 80, bottom: 260 })).toBe(72);
  });
});
