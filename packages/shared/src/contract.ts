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
 * Two numbers, and two questions:
 *
 * - `CONTRACT_GENERATION` — the interface generation this build speaks. A client states it
 *   on every request (`X-Courier-Contract`), a server publishes it on `/api/health`. A
 *   **client needs a server at its own generation or newer**: an older server cannot read a
 *   newer client's requests, and the server refuses one above its own generation, so a
 *   client that accepted an older server would only collect `426`s.
 * - `MIN_CLIENT_CONTRACT` — the server's floor: the oldest client generation it still
 *   serves. This is the number that keeps one server serving the several plugin versions
 *   its users are running, because an additive release leaves it where it was.
 *
 * The rules for moving them, in full:
 *
 * | The release changes...                                                              | CONTRACT_GENERATION | MIN_CLIENT_CONTRACT |
 * | ----------------------------------------------------------------------------------- | ------------------- | ------------------- |
 * | something an older peer misreads (removed field, changed meaning, new required field) | +1                  | new generation      |
 * | something additive only (new optional field, new route, new error code)              | +1                  | unchanged           |
 * | the server stops reading older clients (fields dropped, framing changed)             | +1                  | new generation      |
 *
 * The single judgement behind every row: **would the old side misread this byte?** `bun run
 * contract` decides the row for everything the types can show (a field added, removed, made
 * required, retyped; a route removed; a member of an `as const` set added or removed) and
 * prints the values to write. What it cannot see is a field whose *name and type stayed the
 * same but whose meaning changed* — that one is answered by the same question, by hand.
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
export const CONTRACT_GENERATION = 3;

/**
 * The oldest client generation this server still serves, published on `/api/health`.
 *
 * It follows the last change that made an **older client misread** something — not the
 * newest generation. A changed or renamed notification type is *not* that: a client that
 * predates it ignores the frame (its dispatcher has no case for it) and its periodic
 * reconcile covers the missed push, which is a degradation, not a corruption. Adding a
 * field, a route or an error code is the same. Only a change that would corrupt an old
 * client's reading moves this floor, and moving it is what refuses those clients.
 */
export const MIN_CLIENT_CONTRACT = 1;

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
 * Whether a response body is the health document, before any number is read from it.
 *
 * A transport can answer a 200 with something else — a captive portal, a proxy's JSON
 * error, an empty object — and `contractVerdict` would then read "generation 1" out of it
 * and report a version mismatch for what is really a broken connection. The two fields
 * every build has ever sent are the test.
 */
export function isHealthResponse(value: unknown): value is HealthResponse {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Partial<HealthResponse>;
  return typeof body.status === "string" && typeof body.timestamp === "string";
}

/**
 * Whether *this* client build can work with the server that answered.
 *
 * Both directions, because both are refusals:
 *
 * - the server's floor is above this build — it no longer serves this client;
 * - the server's own generation is below this build's — this client cannot be read there,
 *   and the server would answer `426` to every request. Refusing here is what turns that
 *   silent loop into one sentence.
 *
 * A server that is *newer* is fine: its floor is what decides whether it still serves this
 * client, and that is exactly what keeps one server serving several plugin versions.
 */
export function contractVerdict(
  health: Pick<HealthResponse, "generation" | "minClient">,
): ContractVerdict {
  if ((health.minClient ?? 1) > CONTRACT_GENERATION) return "client-too-old";
  if ((health.generation ?? 1) < CONTRACT_GENERATION) return "server-too-old";
  return "ok";
}
