import { describe, expect, it } from "vitest";
import { CONTRACT_GENERATION, MIN_CLIENT_CONTRACT, MIN_SERVER_CONTRACT } from "./contract";

/**
 * The three numbers are hand-edited (`bun run contract bump --write` writes them), so the
 * one thing a test can hold is that they stay within the only range that makes sense: a
 * floor cannot be newer than the generation it sits under, and the generation cannot be a
 * number the protocol cannot carry.
 *
 * The rest — that the surface file matches, that a bump happened when the API moved — is
 * `bun run contract`, which reads the same three constants.
 */
describe("contract generations", () => {
  it("are positive whole numbers", () => {
    for (const value of [CONTRACT_GENERATION, MIN_CLIENT_CONTRACT, MIN_SERVER_CONTRACT]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(1);
    }
  });

  it("keep both floors at or below the generation they describe", () => {
    expect(MIN_CLIENT_CONTRACT).toBeLessThanOrEqual(CONTRACT_GENERATION);
    expect(MIN_SERVER_CONTRACT).toBeLessThanOrEqual(CONTRACT_GENERATION);
  });
});
