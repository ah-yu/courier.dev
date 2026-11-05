import { ApiClientError } from "@courier/shared";
import { t } from "../i18n";

/**
 * The form field a failed action's sentence belongs to, when the producer can name one.
 *
 * A dialog owns the placement, but only the producer knows which input the refusal is
 * about. The setup dialog is the case that needs it: it is taller than a phone's sheet, so
 * its form-level slot sits below the fold, and a wrong password reported there is both far
 * from the field that has to change and hidden under the sticky footer.
 */
export type ActionErrorField = "password";

/**
 * The outcome of an action the settings page renders.
 *
 * Every failure that a user can act on comes back as a message rather than an
 * exception or a Notice: the page decides *where* to show it (inline, under the
 * step that failed) and the user keeps whatever they had typed. Notices are
 * still used for events nobody asked for — a conflict the engine resolved, a
 * vault deleted from another device.
 */
export type ActionOutcome<T = void> =
  | { ok: true; value: T }
  | { ok: false; error: string; field?: ActionErrorField };

/**
 * Turn a server URL into the value stored in settings.
 *
 * The WebSocket URL is derived from it by `http`→`ws` rewriting, so the scheme
 * has to be there; a trailing slash is dropped because every caller appends its
 * own path.
 */
export function normalizeServerUrl(
  value: string,
): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, message: t("error.serverUrlRequired") };
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, message: t("error.serverUrlScheme") };
  }
  // Parsed whole first: stripping the trailing slashes of `http://` would leave
  // `http:`, which is what a naive trim would hand the scheme check above. `URL.canParse`
  // would say the same thing and needs Safari 17 / Chrome 120, above this plugin's floor.
  try {
    void new URL(trimmed);
  } catch {
    return { ok: false, message: t("error.serverUrlInvalid") };
  }
  // Every caller appends its own path, so the trailing slash is dropped here.
  return { ok: true, url: trimmed.replace(/\/+$/, "") };
}

/**
 * Whether this looks like a user key.
 *
 * The check is deliberately shallow — the server is the authority — but a key
 * without the `ck_` prefix is rejected by both auth middlewares, so catching it
 * here turns a round trip into an immediate, specific message.
 */
export function looksLikeUserKey(value: string): boolean {
  return value.trim().startsWith("ck_");
}

/**
 * How a failed action reads on the settings page.
 *
 * `fallback` names the action (`t("action.createVault")`), and the cases worth
 * distinguishing — an invalid or expired key, a vault that is gone, a rejected
 * field, an unreachable server — answer with what the user has to change instead
 * of the raw server text.
 */
export function describeActionError(err: unknown, fallback: string): string {
  if (err instanceof ApiClientError) {
    // Status 0 is the shared client's "nothing answered" — a transport failure, not
    // an answer from the server (see `ApiClientError` in `@courier/shared`).
    if (err.status === 0 || err.code === "NETWORK_ERROR") {
      return t("error.unreachable");
    }
    if (err.code === "KEY_EXPIRED") {
      return t("error.keyExpired");
    }
    if (err.code === "KEY_DISABLED") {
      return t("error.keyDisabled");
    }
    if (err.code === "VAULT_LIMIT_REACHED") {
      return t("error.vaultLimitReached");
    }
    if (err.status === 401) {
      return t("error.keyInvalid");
    }
    if (err.status === 404) {
      return t("error.vaultNotFound");
    }
    if (err.status === 422) {
      const details = (err.details ?? [])
        .map((detail) => detail.message)
        .filter(Boolean)
        .join(t("common.detailSeparator"));
      return t("error.withDetails", { fallback, details: details || err.message });
    }
    return t("error.withMessage", { fallback, message: err.message });
  }
  // Anything that is not an API error never reached the server — `requestUrl`
  // rejects with a transport error, and the plugin's own failures land here too.
  return t("error.unreachable");
}
