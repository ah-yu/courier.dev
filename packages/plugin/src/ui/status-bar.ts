import { Menu, setIcon } from "obsidian";
import type { UserSummary } from "@courier/shared";
import { t } from "../i18n";
import { keyExpiryText } from "../shared/account-status";
import { SYNC_STATUSES, statusIcon, statusTooltip, type SyncStatus } from "../shared/sync-status";
import { storageUsageTitle } from "./storage-usage";

/**
 * One line of text in the menu's upper block.
 *
 * The fragment exists to carry `courier-status-menu-row`: Obsidian renders a
 * `setIsLabel(true)` item at `--font-ui-medium` in the muted colour, while the actionable
 * rows below are `--font-ui-small` in the normal colour. A wrapper span lets the plugin
 * make the read-only rows match the actions without changing Obsidian's menu styles
 * globally. The fallback string is for a host without a DOM (the e2e harness), where
 * `document` does not exist; the real app always takes the fragment path.
 */
function menuTextTitle(text: string): string | DocumentFragment {
  if (typeof document === "undefined") return text;
  const fragment = createFragment();
  fragment.createSpan({ cls: "courier-status-menu-row", text });
  return fragment;
}

/**
 * The plugin surface the status bar needs.
 *
 * Narrow on purpose: the status bar is a small view over the plugin's state, so it takes
 * the few readings and actions it uses instead of the whole `CourierPlugin` class. That
 * keeps the element and menu code driveable from the e2e harness, which constructs the
 * real plugin.
 */
export interface StatusBarHost {
  addStatusBarItem(): HTMLElement;
  getStatus(): SyncStatus;
  getVaultName(): string | null;
  hasUserKey(): boolean;
  /**
   * How far the current **first** pass has got, or null when none is running.
   *
   * Only a vault this device has never synced reports here: a five-minute pass over two
   * changed notes is not progress a person needs to see, and calling a startup scan of an
   * already-bound vault "first sync" would be wrong.
   */
  getProgress(): { done: number; total: number } | null;
  /** The account behind the current key, or null when it cannot be read. */
  readAccount(): Promise<UserSummary | null>;
  pauseSync(): Promise<void>;
  resumeSync(): Promise<void>;
  openSettings(): void;
}

export interface StatusBarHandle {
  /** Re-read the plugin state and repaint the icon in place. */
  refresh(): void;
  /** Remove the element and close a menu it opened. */
  destroy(): void;
}

/**
 * The always-visible sync state: one status-bar icon and its native context menu.
 *
 * The icon carries no text — a status bar is shared with other plugins — so the whole
 * state has to be legible from the icon, its colour and the `aria-label` (which Obsidian
 * also shows as a tooltip). The menu is Obsidian's own `Menu`, not a custom popover: it
 * gets keyboard handling, theming and placement for free, and it is the same surface the
 * rest of the app uses for this kind of action list.
 *
 * The menu reads the account once per opening. The read is already timeout-bounded by
 * the caller, so an unreachable server delays the menu by at most that bound and then
 * shows the cached account or the inline "could not read" row. It never opens a `Notice`:
 * the click belongs to this menu, so the answer belongs here too.
 */
export function createStatusBar(host: StatusBarHost): StatusBarHandle {
  const element = host.addStatusBarItem();
  element.addClass("status-bar-item");
  element.addClass("courier-status-bar");
  element.setAttribute("role", "button");
  element.setAttribute("tabindex", "0");
  element.setAttribute("aria-haspopup", "menu");
  element.setAttribute("aria-expanded", "false");
  element.setAttribute("data-tooltip-position", "top");

  const iconElement = element.createSpan({ cls: "courier-status-bar-icon" });
  let currentMenu: Menu | null = null;
  let opening = false;
  let destroyed = false;

  function refresh(): void {
    const status = host.getStatus();
    for (const candidate of SYNC_STATUSES) {
      element.removeClass(`is-${candidate}`);
    }
    element.addClass(`is-${status}`);
    element.setAttribute("data-courier-status", status);
    element.setAttribute("data-courier-icon", statusIcon(status));

    const vaultName = host.getVaultName();
    // The first pass is the one moment the icon has no socket to report: the tooltip is
    // where the counter belongs, because the element itself is icon-only by design.
    element.setAttribute(
      "aria-label",
      statusTooltip(status, vaultName, status === "syncing" ? host.getProgress() : null),
    );

    setIcon(iconElement, statusIcon(status));
  }

  /** Close the menu an earlier click opened, if any. */
  function closeMenu(): void {
    currentMenu?.close();
    currentMenu = null;
    element.setAttribute("aria-expanded", "false");
  }

  /**
   * Show `menu` against the item's own box rather than the pointer.
   *
   * `overlap` + `width` is Obsidian's anchor form: the menu's right edge is pulled to
   * the item's right edge when it would overflow, and its top flips above the item when
   * it would not fit below. A status bar sits at the bottom of the window, so the flip
   * is the normal case — anchoring to the pointer left the menu hanging over the
   * window's corner on macOS.
   */
  function showAnchored(menu: Menu): void {
    const rect = element.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.top, width: rect.width, overlap: true });
  }

  async function openMenu(): Promise<void> {
    if (opening || destroyed) return;
    opening = true;
    closeMenu();
    try {
      let account: UserSummary | null = null;
      if (host.hasUserKey()) {
        try {
          account = await host.readAccount();
        } catch (err) {
          // `readAccount` normally answers null on failure; this is the last line before a
          // menu that never appears.
          console.error("Courier: reading the account for the status menu failed:", err);
        }
      }
      // The plugin may have been unloaded while the account read was in flight.
      if (destroyed) return;

      const status = host.getStatus();
      const vaultName = host.getVaultName();
      const menu = new Menu();
      // Obsidian uses **native** menus on macOS by default, and a native menu is the
      // wrong surface for this one: it draws no storage bar (the row is a fragment with
      // an element in it), ignores the row typography `styles.css` gives the read-only
      // rows, and macOS places it at the pointer — which, from a status bar at the very
      // bottom of the window, hangs the menu over the window's corner instead of above
      // the icon. The DOM menu flips above the anchor and is the surface both the styles
      // and the L3 suite read, so this menu asks for it explicitly on every platform.
      menu.setUseNativeMenu(false);

      // The icon already says which state this is; the text has one job, naming the
      // vault. Without a vault there is nothing to name, so the row is omitted.
      let hasReadOnlyRows = false;
      if (vaultName !== null) {
        menu.addItem((item) =>
          item.setTitle(menuTextTitle(vaultName)).setIcon(statusIcon(status)).setIsLabel(true),
        );
        hasReadOnlyRows = true;
      }

      if (host.hasUserKey()) {
        if (account === null) {
          menu.addItem((item) =>
            item
              .setTitle(menuTextTitle(t("status.menu.accountUnavailable")))
              .setIcon("circle-slash")
              .setIsLabel(true),
          );
        } else {
          menu.addItem((item) =>
            item
              .setTitle(menuTextTitle(keyExpiryText(account.expiresAt)))
              .setIcon("key")
              .setIsLabel(true),
          );
          menu.addItem((item) =>
            item
              .setTitle(
                storageUsageTitle(account, "courier-storage-usage courier-status-menu-storage"),
              )
              .setIcon("hard-drive")
              .setIsLabel(true),
          );
        }
        hasReadOnlyRows = true;
      }

      // A menu with nothing above the actions (no vault, no key) is just 设置: a leading
      // separator there would draw a line under no rows.
      if (hasReadOnlyRows) menu.addSeparator();

      if (status === "syncing" || status === "waiting" || status === "paused") {
        const paused = status === "paused";
        menu.addItem((item) =>
          item
            .setTitle(paused ? t("settings.pause.resume") : t("settings.pause.pause"))
            .setIcon(paused ? "play" : "pause")
            .onClick(() => {
              void (paused ? host.resumeSync() : host.pauseSync());
            }),
        );
      }

      menu.addItem((item) =>
        item
          .setTitle(t("status.menu.settings"))
          .setIcon("settings")
          .onClick(() => host.openSettings()),
      );

      menu.onHide(() => {
        if (currentMenu === menu) {
          currentMenu = null;
          element.setAttribute("aria-expanded", "false");
        }
      });
      currentMenu = menu;
      element.setAttribute("aria-expanded", "true");
      showAnchored(menu);
    } finally {
      opening = false;
    }
  }

  element.addEventListener("click", () => {
    void openMenu();
  });
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void openMenu();
  });

  refresh();

  return {
    refresh,
    destroy() {
      destroyed = true;
      closeMenu();
      element.detach();
    },
  };
}
