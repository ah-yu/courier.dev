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
export const CONTRACT_GENERATION = 1;

/**
 * The oldest client generation this server still serves, published on `/api/health`.
 *
 * It follows the last breaking change: after one, only clients of the new generation are
 * served. Between breaking changes it stays put, which is what lets one server serve the
 * several plugin versions a group of users will inevitably be running.
 */
export const MIN_CLIENT_CONTRACT = 1;

/**
 * The oldest server generation this client can work with.
 *
 * It moves only when the client starts depending on something a server did not have
 * before, so an additive release does not tell every user to upgrade a server that is
 * already fine.
 */
export const MIN_SERVER_CONTRACT = 1;
