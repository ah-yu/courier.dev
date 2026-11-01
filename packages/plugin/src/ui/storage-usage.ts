import type { UserSummary } from "@courier/shared";
import { storageMenuValue } from "../shared/account-status";

/**
 * A storage row's content: a quota bar followed by `used/limit`.
 *
 * Shared by the status menu and the settings page, so both show the same reading. A
 * `DocumentFragment` lets either host carry the bar without replacing its own row; the
 * fallback string is for a host without a DOM (the e2e harness), where `document` does
 * not exist. The real app always takes the fragment path — including for an unlimited
 * account or a failed read, which have no bar to draw but still need the row wrapper the
 * menu styles: a bare string would fall back to Obsidian's larger, muted `is-label`
 * typography instead of matching the rows around it.
 */
export function storageUsageTitle(
  account: Pick<UserSummary, "usedBytes" | "storageBytesLimit">,
  className = "courier-storage-usage",
): string | DocumentFragment {
  const usage = storageMenuValue(account.usedBytes, account.storageBytesLimit);
  if (typeof document === "undefined") return usage.text;

  const fragment = createFragment();
  const row = fragment.createDiv({ cls: className });
  // Only a finite quota has a track to fill. `percent` is null for an unlimited account
  // and for a failed read, both of which still show their text in the wrapper.
  if (usage.percent !== null) {
    const bar = row.createDiv({ cls: "courier-storage-usage-bar" });
    bar.setAttribute("aria-hidden", "true");
    const fill = bar.createDiv({ cls: "courier-storage-usage-fill" });
    const fillStyles: Partial<CSSStyleDeclaration> = { width: `${usage.percent}%` };
    // A tiny but non-zero usage would otherwise round to an invisible bar.
    if (usage.percent > 0) fillStyles.minWidth = "2px";
    fill.setCssStyles(fillStyles);
  }
  row.createSpan({ cls: "courier-storage-usage-value", text: usage.text });
  return fragment;
}
