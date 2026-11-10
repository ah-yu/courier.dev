import { describe, expect, it } from "vitest";
import { CONTRACT_GENERATION, MIN_CLIENT_CONTRACT, contractVerdict } from "./contract";

/**
 * The verdict is the one piece of judgement every host shares, so its outcomes are pinned
 * here rather than re-derived in the plugin, the CLI and the server's gate.
 *
 * The cases are written **against the constants**, not against fixed numbers: the
 * generations move at every interface change, and a test that hard-codes them would fail on
 * the release that legitimately moved them — which is exactly when this test must still
 * describe the rule. What it pins is the shape: the window is two-sided, a peer inside it is
 * served, and a missing field reads as generation 1.
 */
describe("contractVerdict", () => {
  it("serves a server at this build's generation", () => {
    expect(
      contractVerdict({ generation: CONTRACT_GENERATION, minClient: MIN_CLIENT_CONTRACT }),
    ).toBe("ok");
  });

  it("serves a newer server that still has this client in its window", () => {
    expect(
      contractVerdict({ generation: CONTRACT_GENERATION + 1, minClient: MIN_CLIENT_CONTRACT }),
    ).toBe("ok");
  });

  it("refuses a client below the server's floor", () => {
    expect(
      contractVerdict({ generation: CONTRACT_GENERATION, minClient: CONTRACT_GENERATION + 1 }),
    ).toBe("client-too-old");
  });

  it("refuses a server older than this build's own generation", () => {
    // The server refuses a client above its generation, so a client that accepted an older
    // server would only collect 426s. Refusing here is what turns that into one sentence.
    expect(contractVerdict({ generation: CONTRACT_GENERATION - 1, minClient: 1 })).toBe(
      CONTRACT_GENERATION > 1 ? "server-too-old" : "ok",
    );
  });

  it("reads a server that predates the fields as generation 1", () => {
    // Every build before the mechanism was generation 1, so an absent field answers for
    // that build: accepted while this generation is 1, refused once it is 2.
    expect(contractVerdict({})).toBe(CONTRACT_GENERATION > 1 ? "server-too-old" : "ok");
  });

  it("treats an absent floor as 1, not as 'no client is served'", () => {
    expect(contractVerdict({ generation: CONTRACT_GENERATION })).toBe("ok");
  });
});
