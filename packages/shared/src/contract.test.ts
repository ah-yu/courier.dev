import { describe, expect, it } from "vitest";
import {
  CONTRACT_GENERATION,
  MIN_CLIENT_CONTRACT,
  MIN_SERVER_CONTRACT,
  contractVerdict,
} from "./contract";

/**
 * The verdict is the one piece of judgement every host shares, so its four outcomes are
 * pinned here rather than re-derived in the plugin, the CLI and the server's gate.
 *
 * The cases are written **against the constants**, not against fixed numbers: the
 * generations move at every breaking change, and a test that hard-codes them would fail on
 * the release that legitimately moved them — which is exactly when this test must still
 * describe the rule. What it pins is the shape: the window is two-sided, a peer inside it
 * is served, and a missing field reads as generation 1.
 */
describe("contractVerdict", () => {
  it("serves a client at the server's own generation", () => {
    expect(
      contractVerdict({ generation: CONTRACT_GENERATION, minClient: CONTRACT_GENERATION }),
    ).toBe("ok");
  });

  it("serves a client above the floor but below the server's generation", () => {
    expect(
      contractVerdict({ generation: CONTRACT_GENERATION, minClient: MIN_CLIENT_CONTRACT }),
    ).toBe("ok");
  });

  it("refuses a client below the server's floor", () => {
    expect(
      contractVerdict({ generation: CONTRACT_GENERATION, minClient: CONTRACT_GENERATION + 1 }),
    ).toBe("client-too-old");
  });

  it("refuses a server older than this build needs", () => {
    // Only meaningful while this client needs generation 2 or later; the constants test
    // above keeps the floors from drifting below 1.
    const older = MIN_SERVER_CONTRACT - 1;
    expect(contractVerdict({ generation: older, minClient: 1 })).toBe(
      older < MIN_SERVER_CONTRACT ? "server-too-old" : "ok",
    );
  });

  it("reads a server that predates the fields as generation 1", () => {
    // Every build before the mechanism was generation 1, so an absent field answers for
    // that build: accepted once this client can work with 1, refused once it cannot.
    expect(contractVerdict({})).toBe(MIN_SERVER_CONTRACT > 1 ? "server-too-old" : "ok");
  });

  it("treats an absent floor as 1, not as 'no client is served'", () => {
    expect(contractVerdict({ generation: CONTRACT_GENERATION })).toBe(
      MIN_CLIENT_CONTRACT > CONTRACT_GENERATION ? "client-too-old" : "ok",
    );
  });
});
