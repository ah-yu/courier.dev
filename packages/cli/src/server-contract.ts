import { contractVerdict } from "@courier/shared";
import { createCliClient } from "./api";
import { t } from "./i18n";

/**
 * The CLI's own contract check, made **before** the vault lease is taken.
 *
 * The host checks too (`SyncHost.start()` probes `/api/health` before it builds anything),
 * but by then this process already holds the vault's lease — and a mismatch is not a state
 * the daemon can wait in. Asking first means a mismatched server is a startup refusal: one
 * line, a distinct exit code, and no lease to release.
 *
 * The exit code is `78` (`EX_CONFIG` from `sysexits.h`) rather than `1`: a supervisor that
 * restarts on failure would loop forever on a mismatch, so the documented systemd unit
 * carries `RestartPreventExitStatus=78` and the process stops until a person fixes it.
 */
export const EXIT_CONTRACT_MISMATCH = 78;

/** This CLI and the server cannot work together. The message says which side to upgrade. */
export class ServerContractError extends Error {}

/**
 * Ask the server what it speaks and refuse to go on when this build cannot use it.
 *
 * An unreachable server is **not** this error: the caller's existing "cannot reach" path
 * reports it, and a network failure must stay retryable.
 */
export async function ensureCompatibleServer(config: {
  serverUrl: string;
  userKey: string;
}): Promise<void> {
  const client = createCliClient({ serverUrl: config.serverUrl, userKey: config.userKey });
  const health = await client.getServerInfo();
  const verdict = contractVerdict(health);
  if (verdict === "ok") return;

  throw new ServerContractError(
    t(
      verdict === "client-too-old"
        ? "cli.error.contractClientOutdated"
        : "cli.error.contractServerOutdated",
    ),
  );
}
