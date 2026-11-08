import { describe, expect, it } from "vitest";
import { expectEventually } from "./wait";

describe("expectEventually", () => {
  it("returns as soon as the assertion holds, and retries until it does", async () => {
    let reads = 0;
    await expectEventually(() => {
      reads += 1;
      expect(reads).toBeGreaterThanOrEqual(3);
    }, "the reading never settled");
    expect(reads).toBe(3);
  });

  it("retries an async assertion, not only a synchronous throw", async () => {
    // The L3 caller reads the DOM over the CLI, so its assertion is a promise. Catching
    // only synchronous throws would stop the poll from retrying a rejected read, and the
    // failure would arrive as the generic timeout instead of the assertion.
    let reads = 0;
    await expectEventually(async () => {
      reads += 1;
      if (reads < 3) throw new Error(`read ${reads} was too early`);
    }, "the async reading never settled");
    expect(reads).toBe(3);
  });

  it("keeps the assertion's own error and names the wait that gave up", async () => {
    // The assertion never holds: the failure must be the assertion's message (the diff a
    // reader needs) with the wait named on top of it, not a bare timeout.
    const error = (await expectEventually(
      () => expect("").toContain("third"),
      "the version pane never showed the head's content",
      50,
    ).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toContain("to contain 'third'");
    expect(error.message).toContain("the version pane never showed the head's content");
  });
});
