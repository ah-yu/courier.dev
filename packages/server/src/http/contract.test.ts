import { describe, expect, it } from "vitest";
import { CONTRACT_GENERATION, CONTRACT_HEADER, MIN_CLIENT_CONTRACT } from "@courier/shared";
import { ContractMismatchError } from "../lib/errors";
import { contractGenerationOf, requireContract } from "./contract";

/**
 * The server's half of the window, at a floor this release does not have.
 *
 * The build's own floor is 1, so the refusal it exists to produce — "your client is older
 * than I serve" — never runs against the shipped constants. Injecting a window is what keeps
 * that branch alive instead of untested until the first breaking change.
 */
const silent = {
  level: "error",
  enabled: () => false,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as const;

function request(generation?: number): Request {
  const headers: Record<string, string> = {};
  if (generation !== undefined) headers[CONTRACT_HEADER] = String(generation);
  return new Request("http://localhost/api/vaults", { headers });
}

function refusal(generation: number, window: { generation: number; minClient: number }) {
  try {
    requireContract(request(generation), { window, log: silent as never });
  } catch (err) {
    return err as ContractMismatchError;
  }
  return null;
}

describe("requireContract", () => {
  it("serves a client inside the window", () => {
    expect(refusal(3, { generation: 4, minClient: 2 })).toBeNull();
    expect(refusal(4, { generation: 4, minClient: 2 })).toBeNull();
    expect(refusal(2, { generation: 4, minClient: 2 })).toBeNull();
  });

  it("refuses a client below the floor, with both numbers on the error", () => {
    const error = refusal(1, { generation: 4, minClient: 2 });
    expect(error).toBeInstanceOf(ContractMismatchError);
    expect(error?.statusCode).toBe(426);
    expect(error?.code).toBe("CONTRACT_MISMATCH");
    expect(error?.extra).toMatchObject({
      serverContract: 4,
      minClient: 2,
      clientContract: 1,
    });
    expect(error?.message).toContain("Update the plugin or CLI");
  });

  it("refuses a client above the server's generation", () => {
    const error = refusal(5, { generation: 4, minClient: 2 });
    expect(error?.code).toBe("CONTRACT_MISMATCH");
    expect(error?.extra).toMatchObject({ serverContract: 4, clientContract: 5 });
    expect(error?.message).toContain("Update the server");
  });

  it("serves the window this build actually ships", () => {
    expect(
      refusal(CONTRACT_GENERATION, {
        generation: CONTRACT_GENERATION,
        minClient: MIN_CLIENT_CONTRACT,
      }),
    ).toBeNull();
  });
});

describe("contractGenerationOf", () => {
  it("reads the header, and treats absent or unreadable as generation 1", () => {
    expect(contractGenerationOf("3")).toBe(3);
    expect(contractGenerationOf(null)).toBe(1);
    expect(contractGenerationOf("")).toBe(1);
    expect(contractGenerationOf("seven")).toBe(1);
    expect(contractGenerationOf("0")).toBe(1);
    expect(contractGenerationOf("-2")).toBe(1);
  });
});
