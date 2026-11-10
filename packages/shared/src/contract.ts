/**
 * The contract generation: the one number a client and a server must agree on.
 *
 * Three packages ship from one tag, but they are upgraded at different times: the plugin
 * follows the Obsidian directory (a user may keep an old build for months), the CLI is a
 * binary someone installed once, and the server is whatever an administrator has deployed.
 * A release being atomic therefore says nothing about a **deployment**. These constants are
 * how a client and a server that meet by chance decide whether they can work together, and
 * which side is the one that has to move.
 *
 * There are two questions, not one, and each needs its own number:
 *
 * - *Can we read each other's bytes at all?* — `CONTRACT_GENERATION`. A client states its
 *   value on every request; a server publishes its own.
 * - *Has this server got what I need?* — `MIN_SERVER_CONTRACT` (client side) and
 *   `MIN_CLIENT_CONTRACT` (server side). Without these, every purely additive release would
 *   tell every user to upgrade a server that did not have to move.
 *
 * The rules for moving them, in full:
 *
 * | The release changes...                                                | CONTRACT_GENERATION | MIN_CLIENT_CONTRACT | MIN_SERVER_CONTRACT |
 * | --------------------------------------------------------------------- | ------------------- | ------------------- | ------------------- |
 * | something an older peer misreads (removed field, changed meaning, new required field) | +1 | new generation | new generation |
 * | something additive only (new optional field, new route)               | +1                  | unchanged           | unchanged           |
 * | a client now depends on a new server capability                       | +1                  | unchanged           | new generation      |
 * | the server stops reading older clients (fields dropped, framing changed) | +1               | new generation      | unchanged           |
 *
 * The single judgement behind all four rows: **would the old side misread this byte?**
 * `bun run contract` decides the row for everything the types can show (a field added,
 * removed, made required, retyped; a route or an error code removed) and prints the values
 * to write. What it cannot see is a field whose *name and type stayed the same but whose
 * meaning changed* — that one is answered by the same question, by hand.
 *
 * `bun run verify` fails while the code's observable surface differs from
 * `packages/shared/contract/<CONTRACT_GENERATION>.surface.json`, so a change cannot land
 * without this file being considered.
 *
 * See `docs/api.md` → "Contract generation".
 */

/**
 * The interface generation this build speaks.
 *
 * A client states it on every request (`X-Courier-Contract`), a server publishes it on
 * `/api/health`. Mismatched peers are refused, and the refusal names the side to upgrade.
 */
export const CONTRACT_GENERATION = 2;

/**
 * The oldest client generation this server still serves, published on `/api/health`.
 *
 * It follows the last change that made an **older client misread** something — not the
 * newest generation. Adding a field, a route or an error code leaves it alone, because a
 * client that predates them simply ignores what it does not know (and never sends the
 * header, which reads as generation 1). Only a change that would corrupt an old client's
 * reading moves this floor, and moving it is what refuses those clients.
 */
export const MIN_CLIENT_CONTRACT = 1;

/**
 * The oldest server generation this client can work with.
 *
 * It moves only when the client starts depending on something a server did not have
 * before, so an additive release does not tell every user to upgrade a server that is
 * already fine.
 */
export const MIN_SERVER_CONTRACT = 2;

/**
 * The request header that states a client's generation.
 *
 * One spelling, in one place: the client's header builder and the server's gate both read
 * this, so a typo cannot make the whole check silently pass.
 */
export const CONTRACT_HEADER = "X-Courier-Contract";

/**
 * Whether a reported version is a real release version (`0.6.0`), not a build's placeholder.
 *
 * A server built without the release job's `--define` reports `dev`, and a message that
 * says "server dev is too old" tells a user nothing. The generation is always meaningful,
 * so it is what a message names; the version is added only when it is this.
 */
export function isReleaseVersion(version: string | null | undefined): version is string {
  return typeof version === "string" && /^\d+\.\d+\.\d+/.test(version);
}

/**
 * What a server publishes about itself on its health endpoint.
 *
 * Every field past `timestamp` is optional on purpose: a server built before the fields
 * existed answers without them, and "absent" is defined as **generation 1** — the first
 * generation, which is what every build before the mechanism was. That is what lets the
 * field be introduced without a flag day, and it is why `contractVerdict` is the only place
 * that reads these numbers: the defaulting lives here, once.
 */
export interface HealthResponse {
  status: string;
  timestamp: string;
  /** The contract generation the server speaks; absent means 1. */
  generation?: number;
  /** The oldest client generation the server still serves; absent means 1. */
  minClient?: number;
  /** The server's release version, for the message a user reads. Absent on an old build. */
  version?: string;
}

/** Which side has to move, from the client's point of view (`/api/health`). */
export type ContractVerdict = "ok" | "client-too-old" | "server-too-old";

/**
 * Whether *this* client build can work with the server that answered.
 *
 * Two questions, and both are needed: a client below the server's floor is not served, and
 * a client that needs more than the server provides cannot work either. Everything else is
 * fine — the generations do not have to be equal, which is what lets one server serve the
 * several plugin versions its users are running.
 */
export function contractVerdict(
  health: Pick<HealthResponse, "generation" | "minClient">,
): ContractVerdict {
  if ((health.minClient ?? 1) > CONTRACT_GENERATION) return "client-too-old";
  if ((health.generation ?? 1) < MIN_SERVER_CONTRACT) return "server-too-old";
  return "ok";
}
