import { describe, expect, it } from "vitest";
import { integer, list, queryInteger, text } from "./schema";

/**
 * The helpers are tiny, but every `if` in them is a constraint the surface records. The
 * cases below execute both sides of each branch: no options, one option, and both.
 */
describe("the wire schema helpers", () => {
  it("applies only the string bounds it was given", () => {
    expect(text().safeParse("anything").success).toBe(true);
    expect(text({ min: 2 }).safeParse("x").success).toBe(false);
    expect(text({ max: 1 }).safeParse("xx").success).toBe(false);
    expect(text({ pattern: /^a+$/ }).safeParse("aa").success).toBe(true);
    expect(text({ pattern: /^a+$/ }).safeParse("b").success).toBe(false);
    expect(text({ min: 1, max: 3, pattern: /^a+$/ }).safeParse("aa").success).toBe(true);
  });

  it("applies only the integer bounds it was given", () => {
    expect(integer().safeParse(1.5).success).toBe(false);
    expect(integer().safeParse(2).success).toBe(true);
    expect(integer({ min: 2 }).safeParse(1).success).toBe(false);
    expect(integer({ max: 1 }).safeParse(2).success).toBe(false);
    expect(integer({ min: 1, max: 3 }).safeParse(2).success).toBe(true);
  });

  it("applies only the list bounds it was given", () => {
    expect(list(text()).safeParse([]).success).toBe(true);
    expect(list(text(), { min: 1 }).safeParse([]).success).toBe(false);
    expect(list(text(), { max: 1 }).safeParse(["a", "b"]).success).toBe(false);
    expect(list(text(), { min: 1, max: 2 }).safeParse(["a"]).success).toBe(true);
  });

  it("coerces a query integer and applies its bounds", () => {
    expect(queryInteger().safeParse("3").success).toBe(true);
    expect(queryInteger({ min: 2 }).safeParse("1").success).toBe(false);
    expect(queryInteger({ max: 2 }).safeParse("3").success).toBe(false);
    expect(queryInteger({ min: 1, max: 3 }).safeParse("2").success).toBe(true);
    expect(queryInteger().safeParse("2.5").success).toBe(false);
  });
});
