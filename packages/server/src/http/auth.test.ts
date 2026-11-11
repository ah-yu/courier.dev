import { describe, expect, it } from "vitest";
import { AppError, ContractMismatchError } from "../lib/errors";
import type { Logger } from "../lib/logger";
import { toErrorResponse } from "./auth";

/**
 * The 426 body is the one error body with a dedicated schema: the base `ApiError` accepts
 * it too, so only a test that removes the generation fields proves the dedicated branch
 * is still there.
 */

const logger = {
  level: "error",
  enabled: () => false,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

describe("toErrorResponse", () => {
  it("rejects a 426 body without the generation fields under STRICT_CONTRACT", () => {
    expect(() =>
      toErrorResponse(new AppError(426, "CONTRACT_MISMATCH", "upgrade"), logger),
    ).toThrow(/ContractMismatchErrorSchema/);
  });

  it("serializes a well-formed 426", async () => {
    const response = toErrorResponse(
      new ContractMismatchError("upgrade", {
        serverContract: 5,
        minClient: 1,
        clientContract: 6,
        serverVersion: "0.1.0",
      }),
      logger,
    );

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      error: "CONTRACT_MISMATCH",
      serverContract: 5,
      minClient: 1,
      clientContract: 6,
      serverVersion: "0.1.0",
    });
  });
});
