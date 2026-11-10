import { contractVerdict, isHealthResponse } from "@courier/shared";
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

/**
 * How long the pre-flight waits for `/api/health`.
 *
 * A server that hangs instead of refusing would otherwise block `run`, `vault connect` and
 * `vault create` before any retry loop exists. A timeout is not a mismatch: it is the
 * ordinary "cannot reach" path, which already knows how to report and retry.
 */
const PROBE_TIMEOUT_MS = 5_000;

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
  const health = await withTimeout(client.getServerInfo(), PROBE_TIMEOUT_MS);
  // A 200 whose body is not the health document (a proxy's error page, a captive portal)
  // is not an answer about the contract: let the caller's own "cannot reach" path report it
  // rather than telling the user to upgrade a server that is merely behind a proxy.
  if (!isHealthResponse(health)) return;
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

/** Settle with `work`, or reject once `ms` has passed. A timeout reads as "unreachable". */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms}ms`)), ms);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}
