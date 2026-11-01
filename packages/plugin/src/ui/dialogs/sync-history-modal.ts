import { App, Modal, setIcon } from "obsidian";
import { reversedCopy } from "@courier/shared";
import { t } from "../../i18n";
import {
  directionTooltip,
  entryDeviceLabel,
  formatClockTime,
  formatCount,
  formatHistoryDay,
  groupSyncHistoryByDay,
  skipLine,
  syncActionLabel,
  syncHistorySummary,
} from "../../shared/sync-history";
import { getSyncLog, onSyncLogChange, type SyncLogEntry } from "../../shared/sync-log";

/** What the history dialog needs from the plugin. */
export interface SyncHistoryHost {
  /**
   * Whether a remote vault is bound. The log itself needs no vault key and no network —
   * it is this run's memory — so this only chooses the disconnected placeholder.
   */
  connected: boolean;
}

/**
 * How long a burst of activity waits before the list repaints.
 *
 * Every event notifies the dialog, and a first bind reports one per file: repainting
 * after the burst rather than per row keeps the dialog responsive and the scroll
 * position stable.
 */
const REPAINT_DEBOUNCE_MS = 250;

/** Add or drop one class, so a repaint lands in a state rather than flipping it. */
function setOptionalClass(element: HTMLElement, cls: string, present: boolean): void {
  if (present) element.addClass(cls);
  else element.removeClass(cls);
}

/**
 * The vault's sync history, as a log of **this plugin run**.
 *
 * The rows are the engine's activity events, recorded in memory as they happen
 * (`shared/sync-log.ts`): a push this device sent, a remote change it applied, or a path
 * it deliberately left out because a switch, the size cap or the API's path bound said
 * so. Nothing here is fetched from the server and nothing is recomputed at paint time, so
 * a scope switch or a device rename afterwards cannot rewrite a row. That is the
 * difference from the old dialog, which reconstructed "what happened" from the server's
 * full version chains and the current settings — a past row changed appearance when a
 * switch moved, and its arrow compared device names.
 *
 * Direction comes from the operation: up is something this device sent, down is something
 * that arrived from another one. The device label is display only. A skipped row adds one
 * line naming the switch that fired, frozen with the event.
 *
 * The view follows the newest line while it is parked at the end (and stays where the
 * user put it once they scroll back to read), grouped by local day with the newest day at
 * the bottom — a log is read down a column.
 */
export class SyncHistoryModal extends Modal {
  private readonly host: SyncHistoryHost;
  private countEl!: HTMLElement;
  private countLabelEl!: HTMLElement;
  private noteEl!: HTMLElement;
  private listEl!: HTMLElement;
  private entries: readonly SyncLogEntry[] = [];
  private total = 0;
  /** Stops the store subscription; `null` until the dialog has opened. */
  private unsubscribe: (() => void) | null = null;
  /** The pending debounced repaint a new event asked for. */
  private repaintTimer: number | null = null;
  /**
   * True while the view sits at the newest end of the log, so a repaint scrolls to the
   * bottom instead of pulling the user away from a line they scrolled back to.
   */
  private following = true;

  constructor(app: App, host: SyncHistoryHost) {
    super(app);
    this.host = host;
  }

  override onOpen(): void {
    this.setTitle(t("dialog.syncHistory.title"));
    this.modalEl.addClass("courier-history-modal");

    const root = this.contentEl.createDiv({ cls: "courier-history" });

    const header = root.createDiv({ cls: "courier-history-header" });
    const stat = header.createDiv({ cls: "courier-history-stat" });
    this.countEl = stat.createSpan({ cls: "courier-history-count" });
    this.countLabelEl = stat.createSpan({ cls: "courier-history-count-label" });
    this.noteEl = header.createDiv({ cls: "courier-history-note" });

    this.listEl = root.createDiv({ cls: "courier-history-list" });
    // Reading a line further up must not be undone by the next event.
    this.listEl.addEventListener("scroll", () => {
      this.following = this.atNewest();
    });

    this.render();
    this.unsubscribe = onSyncLogChange(() => this.scheduleRepaint());
  }

  override onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.repaintTimer !== null) {
      window.clearTimeout(this.repaintTimer);
      this.repaintTimer = null;
    }
    this.contentEl.empty();
  }

  /**
   * Repaint soon after an event lands, once a burst stops.
   *
   * Every event pushes the deadline back: a first bind reports one event per file, and
   * painting between them would scroll and re-render hundreds of times for one visible
   * result.
   */
  private scheduleRepaint(): void {
    if (this.repaintTimer !== null) window.clearTimeout(this.repaintTimer);
    this.repaintTimer = window.setTimeout(() => {
      this.repaintTimer = null;
      this.render();
    }, REPAINT_DEBOUNCE_MS);
  }

  /** True while the view is at the newest line, or has no layout to measure yet. */
  private atNewest(): boolean {
    const { scrollTop, scrollHeight, clientHeight } = this.listEl;
    if (typeof scrollHeight !== "number" || typeof clientHeight !== "number") return true;
    return scrollTop + clientHeight >= scrollHeight - 4;
  }

  /** Paint the header and the log — the only parts that change. */
  private render(): void {
    const { entries, total } = getSyncLog();
    this.entries = entries;
    this.total = total;
    this.renderHeader();
    // The list is rebuilt on every repaint, so where the reader was has to be carried
    // across by hand. The flag is read before the rebuild, so a scroll that happened
    // while the repaint was pending decides.
    const follow = this.following;
    const previousScroll = this.listEl.scrollTop;
    this.listEl.empty();

    if (!this.host.connected) {
      this.renderPlaceholder({
        icon: "unplug",
        title: t("dialog.syncHistory.disconnectedTitle"),
        description: t("dialog.syncHistory.disconnectedDesc"),
      });
      return;
    }
    if (this.entries.length === 0) {
      this.renderPlaceholder({
        icon: "history",
        title: t("dialog.syncHistory.emptyTitle"),
        description: t("dialog.syncHistory.emptyDesc"),
      });
      return;
    }

    // `getSyncLog` answers newest first (that is the order the header and the day
    // groups are computed from); a log reads the other way round, so the newest day is
    // the one at the bottom — the one the view follows. The day headers stay in the DOM
    // in that order; CSS turns them into `sticky` headings.
    for (const day of reversedCopy(groupSyncHistoryByDay(this.entries))) {
      const section = this.listEl.createDiv({ cls: "courier-history-day" });
      section.createDiv({ cls: "courier-history-day-title", text: formatHistoryDay(day.at) });
      for (const entry of reversedCopy(day.entries)) {
        this.renderRow(section, entry);
      }
    }

    // The list was emptied, so the browser reset its scroll to the top: put the reader
    // back where they were, or follow the newest line when they were already there.
    if (follow) this.listEl.scrollTop = this.listEl.scrollHeight;
    else this.listEl.scrollTop = previousScroll;
  }

  private renderHeader(): void {
    const summary = syncHistorySummary(this.total, this.entries.length);
    const visible = this.host.connected && this.entries.length > 0;

    this.countEl.setText(visible ? formatCount(summary.count) : "");
    this.countLabelEl.setText(visible ? summary.label : "");
    // `addClass`/`removeClass` rather than `toggleClass(cls, on)`: the class has to end up
    // in one state, not flip.
    setOptionalClass(this.countLabelEl, "is-hidden", !visible);

    this.noteEl.setText(visible ? summary.note : "");
    setOptionalClass(this.noteEl, "is-hidden", !visible);
  }

  /** The empty and disconnected states: one icon, one explanation. */
  private renderPlaceholder(options: { icon: string; title: string; description: string }): void {
    const box = this.listEl.createDiv({ cls: "courier-history-placeholder" });
    const icon = box.createDiv({ cls: "courier-history-placeholder-icon" });
    setIcon(icon, options.icon);
    box.createDiv({ cls: "courier-history-placeholder-title", text: options.title });
    box.createDiv({ cls: "courier-history-placeholder-desc", text: options.description });
  }

  private renderRow(parent: HTMLElement, entry: SyncLogEntry): void {
    const skipped = entry.outcome === "skipped";
    const row = parent.createDiv({
      cls: `courier-history-row is-${entry.direction}${skipped ? " is-skipped" : ""}`,
    });

    // The arrow is the row's first mark and the only colour in it: up (green) means the
    // change left this device, down (blue) means it arrived from another one. Direction
    // is the operation, not a comparison of device labels, so an unnamed device's own
    // push is still an upload. A skipped row mutes the arrow; the line underneath says
    // what the switch was.
    const arrow = row.createDiv({ cls: `courier-history-arrow is-${entry.direction}` });
    setIcon(arrow, entry.direction === "out" ? "arrow-up" : "arrow-down");
    arrow.setAttribute("title", directionTooltip(entry.direction));

    const body = row.createDiv({ cls: "courier-history-body" });
    body.createDiv({ cls: "courier-history-path", text: entry.plainPath });
    body.createDiv({
      cls: "courier-history-meta",
      text: t("dialog.syncHistory.meta", {
        time: formatClockTime(entry.at),
        device: entryDeviceLabel(entry),
      }),
    });

    // The reason is the engine's decision at the time, not a question asked of today's
    // settings: toggling the switch later must not change what this row says.
    if (entry.outcome === "skipped") {
      body.createDiv({ cls: "courier-history-outcome", text: skipLine(entry) });
    }

    if (entry.action !== null) {
      row.createSpan({ cls: "courier-history-action", text: syncActionLabel(entry.action) });
    }
  }
}
