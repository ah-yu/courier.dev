import { CONTRACT_GENERATION, CONTRACT_HEADER, MIN_CLIENT_CONTRACT } from "@courier/shared";
import { ContractMismatchError } from "../lib/errors";
import { logger as processLogger } from "../lib/log";
import type { Logger } from "../lib/logger";
import { VERSION } from "../version";

/**
 * The server's half of the contract check: refuse a client it cannot serve.
 *
 * The client's own `/api/health` check is the one that produces a readable message before
 * anything is written; this is the backstop for a caller that skipped it (a script, or a
 * build from another tree). Both halves compare the same window, so they agree on who is
 * refused.
 *
 * The comparison is one-sided in each direction, and that is the point:
 *
 * - a client **below** `MIN_CLIENT_CONTRACT` is not served — that floor is where the last
 *   breaking change put it, and serving such a client would be misreading its bytes;
 * - a client **above** this server's generation is not served either — this build cannot
 *   know what that client is saying. (A purely additive release leaves the floor alone, so
 *   older clients keep being served; only a break moves it.)
 *
 * An absent header reads as generation 1, which is what every build before the header
 * existed was. That is what lets the field arrive without a flag day.
 */
export function requireContract(request: Request, log: Logger = processLogger): void {
  const clientContract = contractGenerationOf(request.headers.get(CONTRACT_HEADER));

  if (clientContract < MIN_CLIENT_CONTRACT) {
    log.info(
      `refused a client of contract ${clientContract}: this server serves >= ${MIN_CLIENT_CONTRACT}`,
    );
    throw new ContractMismatchError(
      `This client speaks contract ${clientContract}, but this server serves contract ` +
        `${MIN_CLIENT_CONTRACT} and newer. Update the plugin or CLI.`,
      {
        serverContract: CONTRACT_GENERATION,
        minClient: MIN_CLIENT_CONTRACT,
        clientContract,
        serverVersion: VERSION,
      },
    );
  }

  if (clientContract > CONTRACT_GENERATION) {
    log.info(
      `refused a client of contract ${clientContract}: this server speaks ${CONTRACT_GENERATION}`,
    );
    throw new ContractMismatchError(
      `This client speaks contract ${clientContract}, but this server speaks ` +
        `${CONTRACT_GENERATION}. Update the server.`,
      {
        serverContract: CONTRACT_GENERATION,
        minClient: MIN_CLIENT_CONTRACT,
        clientContract,
        serverVersion: VERSION,
      },
    );
  }
}

/** The header as a generation number; absent or unreadable reads as the first generation. */
export function contractGenerationOf(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 1;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : 1;
}
