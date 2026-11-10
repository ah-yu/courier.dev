import { CONTRACT_GENERATION, MIN_CLIENT_CONTRACT } from "@courier/shared";
import { json, withAccessLog, type RouteTable } from "../http/router";
import { config } from "../config";
import type { Logger } from "../lib/logger";
import { VERSION } from "../version";

/**
 * Liveness, as `docs/api.md` documents it: a constant answer, no auth, no data.
 *
 * It also carries what a peer needs in order to know whether it can talk to this server at
 * all — the interface generation, the oldest client generation still served, and the
 * release version for the sentence a user reads. **This endpoint never refuses.** A server
 * that would not answer the handshake could not tell anyone why, and an installer probing
 * `status` would read a healthy server as down.
 *
 * The first module on the Bun route table — it is the one endpoint with no
 * middleware, no database and no dependency, so it proves the wiring without
 * putting anything at risk. It carries the access log itself: a Bun route
 * handler never passes through Hono's middleware chain.
 */
export function healthRoutes(logger: Logger): RouteTable {
  return {
    "/api/health": {
      GET: withAccessLog(
        logger,
        () =>
          json({
            status: "ok",
            timestamp: new Date().toISOString(),
            generation: CONTRACT_GENERATION,
            minClient: MIN_CLIENT_CONTRACT,
            version: VERSION,
          }),
        config.LOG_SLOW_MS,
      ),
    },
  };
}
