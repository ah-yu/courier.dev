/**
 * Whether the server validates a response or a WebSocket frame against its wire schema.
 *
 * On in development and tests; off in a production build (`COURIER_ENV=production`) so a
 * deployment does not pay a second parse of every JSON response and every broadcast frame.
 * `COURIER_STRICT_CONTRACT=1` forces it on (a canary), `=0` forces it off (a benchmark).
 * This is operational, not wire: it changes what the server checks, not what it sends.
 */
const isProduction = process.env.COURIER_ENV === "production";
const override = process.env.COURIER_STRICT_CONTRACT;

export const STRICT_CONTRACT = override === undefined ? !isProduction : override !== "0";
