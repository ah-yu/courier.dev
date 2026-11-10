import { CONTRACT_GENERATION, MIN_CLIENT_CONTRACT, type HealthResponse } from "@courier/shared";
import { VERSION } from "../version";
import type { RouteHandlers } from "../http/contract-routes";

/**
 * Liveness, as `docs/api.md` documents it: a constant answer, no auth, no data.
 *
 * It also carries what a peer needs in order to know whether it can talk to this server
 * at all — the interface generation, the oldest client generation still served, and the
 * release version for the sentence a user reads. **This endpoint never refuses.** A
 * server that would not answer the handshake could not tell anyone why, and an installer
 * probing `status` would read a healthy server as down.
 *
 * The contract registry marks it `auth: "none"`, `contract: "exempt"`: the adapter adds
 * the access log and error mapping every route carries, and nothing else.
 */
export const healthHandlers: Pick<RouteHandlers, "health.get"> = {
  "health.get": () => {
    // Typed against the shared interface: this payload is the handshake, and a rename
    // on one side (or the other) has to fail here rather than at a user's screen.
    const body: HealthResponse = {
      status: "ok",
      timestamp: new Date().toISOString(),
      generation: CONTRACT_GENERATION,
      minClient: MIN_CLIENT_CONTRACT,
      version: VERSION,
    };
    return { body };
  },
};
