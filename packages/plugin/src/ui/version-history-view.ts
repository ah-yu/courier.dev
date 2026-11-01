import {
  ButtonComponent,
  Component,
  ExtraButtonComponent,
  ItemView,
  Setting,
  setIcon,
  type App,
  type EventRef,
  type WorkspaceLeaf,
} from "obsidian";
import { reversedCopy } from "@courier/shared";
import type { FileVersionInfo } from "@courier/shared";
import { t, plural } from "../i18n";
import type { CourierUiHost } from "../shared/ui-host";
import { decryptPathOrNull } from "../shared/encrypted-path";
import { previewIconOf, previewKindOf } from "../shared/file-preview";
import { runRestoreFlow } from "../shared/restore-flow";
import { showNotice } from "../shared/show-notice";
import {
  deviceLabel,
  formatClockTime,
  formatHistoryDay,
  formatHistoryTime,
  syncActionLabel,
} from "../shared/sync-history";
import {
  formatVersionSize,
  groupVersionsByDay,
  versionActionIcon,
} from "../shared/version-history";
import { readVersionContent } from "../shared/version-content";
import { diffTextLines, unifiedLines, type UnifiedLine } from "../shared/text-diff";
import { renderFileContent } from "./file-content-render";
import { PromiseModal } from "./dialogs/promise-modal";

/**
 * The view type both the plugin and the e2e driver open the version history by.
 *
 * It is the leaf's `data-type`, so `.workspace-leaf-content[data-type=...]` finds the surface
 * in a real window — the same contract the conflict comparison uses.
 */
export const VERSION_HISTORY_VIEW_TYPE = "courier-version-history";

/** The two presentations of one version: its content, or its difference from the last one. */
export type VersionHistoryMode = "content" | "diff";

/**
 * How long a vault event waits before the tab re-reads its chain.
 *
 * Obsidian can deliver several events for one save, and each re-read costs a request: the
 * debounce turns a burst into one read and keeps the list from repainting per keystroke.
 */
export const VERSION_HISTORY_REFRESH_MS = 400;

/**
 * What chain a leaf shows: the fileId is the identity, the path is the tab's title.
 *
 * The **vault** is part of the target, not read from the settings when a page is fetched: a
 * tab outlives a disconnect (and a reconnect to another vault), and asking the newly bound
 * vault for the old vault's fileId would name one vault's chain in a page about another. The
 * view says "not connected" instead.
 */
export interface VersionHistoryTarget {
  vaultId: string;
  fileId: string;
  path: string;
}

/** A leaf's persisted state: which chain, which version, which presentation. */
export interface VersionHistoryViewState extends Record<string, unknown> {
  target: VersionHistoryTarget;
  /** The selected version id; absent means the chain's head (the newest version). */
  selected?: string;
  mode: VersionHistoryMode;
}

/**
 * A file's version history, as a main-area tab.
 *
 * This replaced a modal that listed versions and opened a second dialog per version: one
 * click opened it from the file explorer's hover action (or, on a phone, from the file
 * menu), and from then on the list and the content sit side by side, so reading a version
 * is a click rather than a dialog stack. The chain is shown **newest first**, because the
 * question the surface opens with is "what did this look like a moment ago".
 *
 * The right pane shows the selected version either as its content — rendered by the same
 * `renderFileContent` the content dialog uses, so a note looks like a note and an image
 * plays — or as a **diff against the version before it**, which is what makes "what
 * changed" answerable without reading two documents side by side. The comparison is
 * unified: one stream of `−`/`+` lines, which is what fits a pane whose width belongs to
 * the window rather than to the plugin.
 *
 * Reading is the point; the one write is "restore this version", and it goes through the
 * engine's own restore flow (`shared/restore-flow.ts`) with the confirmation the old dialog
 * had. A row for a `delete` version has no content on the server, so it cannot be selected
 * and says why in the list.
 */
export class VersionHistoryView extends ItemView {
  private target: VersionHistoryTarget | null = null;
  /** The chain, newest first — the order both the list and the diff baseline are read in. */
  private versions: FileVersionInfo[] = [];
  private selectedId: string | null = null;
  private mode: VersionHistoryMode = "content";
  private loading = false;
  private loadError: string | null = null;
  private listEl: HTMLElement | null = null;
  /**
   * The reading pane's two parts, kept across a selection.
   *
   * The head is rebuilt on every paint (its facts name the selected version) and the body is
   * **replaced only when the new content is ready** — see {@link paintPane}. Clearing the
   * body first made every click blink through an empty box while the bytes were fetched.
   */
  private headEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  /** The row element of each version, so a selection moves its highlight without a repaint. */
  private readonly rowEls = new Map<string, HTMLElement>();
  /** The lifecycle owner of the content on screen (a markdown embed, a blob URL). */
  private contentOwner: Component | null = null;
  /** Number of the newest history read, so a slow answer cannot repaint a newer one. */
  private loadGeneration = 0;
  /** Number of the newest pane read, for the same reason. */
  private paneGeneration = 0;
  /** The vault listeners that keep the chain current while the tab is open. */
  private readonly vaultRefs: EventRef[] = [];
  /** The pending silent re-read a vault event asked for. */
  private refreshTimer: number | null = null;
  /**
   * Whether Obsidian has opened this view (`onOpen` without an `onClose` since).
   *
   * `setState` and `onOpen` can arrive in either order, and only the one that finds the
   * view open does the work — the same rule the conflict comparison follows.
   */
  private opened = false;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly host: CourierUiHost,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VERSION_HISTORY_VIEW_TYPE;
  }

  /** The chain this tab shows, or `null` while its leaf holds no usable state. */
  get trackedFileId(): string | null {
    return this.target?.fileId ?? null;
  }

  /** The vault this tab's chain lives in — the other half of its identity. */
  get trackedVaultId(): string | null {
    return this.target?.vaultId ?? null;
  }

  /** The tab's title: the file's name (the full path is in the page header below it). */
  getDisplayText(): string {
    const path = this.currentPath();
    return path ? fileNameOf(path) : t("versionHistory.viewTitle");
  }

  getIcon(): string {
    return "history";
  }

  override getState(): Record<string, unknown> {
    if (!this.target) return {};
    const state: VersionHistoryViewState = {
      target: { ...this.target, path: this.currentPath() ?? this.target.path },
      mode: this.mode,
    };
    if (this.selectedId) state.selected = this.selectedId;
    return state;
  }

  override async setState(state: unknown, _result: unknown): Promise<void> {
    const parsed = parseVersionHistoryState(state);
    this.target = parsed?.target ?? null;
    this.mode = parsed?.mode ?? "content";
    this.selectedId = parsed?.selected ?? null;
    if (!this.opened) return;
    // An open leaf can be given a new state; it then re-reads the chain it now shows.
    await this.reload();
  }

  async onOpen(): Promise<void> {
    this.opened = true;
    this.contentEl.addClass("courier-version-history-view");
    this.watch();
    // `setState` may not have arrived yet; it loads instead when it does.
    if (this.target) await this.reload();
    else await this.render();
  }

  async onClose(): Promise<void> {
    this.opened = false;
    this.loadGeneration++;
    this.paneGeneration++;
    this.unwatch();
    this.disposeContent();
    this.versions = [];
    this.listEl = null;
    this.headEl = null;
    this.bodyEl = null;
    this.rowEls.clear();
    this.contentEl.empty();
  }

  /**
   * Follow the chain's file while the tab is open.
   *
   * A save in another pane pushes a version, and a rename moves the chain: without this the
   * newest row would keep saying "current" for a version that is no longer the head, and the
   * header would keep naming the old path. The re-read is **silent** (no loading page) and
   * debounced, because Obsidian delivers several events for one save.
   */
  private watch(): void {
    const onVaultEvent = (file: { path?: string }, oldPath?: string): void => {
      const path = this.currentPath();
      const stored = this.target?.path;
      const touched = file?.path;
      const hit =
        (touched !== undefined && (touched === path || touched === stored)) ||
        (oldPath !== undefined && (oldPath === path || oldPath === stored));
      if (hit) this.scheduleRefresh();
    };
    // Registered one by one: `Vault.on` has an overload per event name, and the union of them
    // is not callable as one signature.
    this.vaultRefs.push(this.app.vault.on("create", onVaultEvent));
    this.vaultRefs.push(this.app.vault.on("modify", onVaultEvent));
    this.vaultRefs.push(this.app.vault.on("delete", onVaultEvent));
    this.vaultRefs.push(this.app.vault.on("rename", onVaultEvent));
  }

  /** Drop the vault listeners and the pending silent re-read. Safe to call twice. */
  private unwatch(): void {
    for (const ref of this.vaultRefs) this.app.vault.offref(ref);
    this.vaultRefs.length = 0;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      if (this.opened) void this.reload(true);
    }, VERSION_HISTORY_REFRESH_MS);
  }

  /** The chain's live path: a rename may have moved it since the tab was opened. */
  private currentPath(): string | null {
    const target = this.target;
    if (!target) return null;
    // The engine only knows the chains of the vault it is bound to; for any other vault the
    // recorded path is the truth (the tab is showing a history it cannot re-read).
    if (this.host.settings.connectedVaultId !== target.vaultId) return target.path;
    return this.host.engine?.pathForFileId(target.fileId) ?? target.path;
  }

  /** The vault this tab belongs to, when it is still the bound one. */
  private vaultId(): string | null {
    const target = this.target;
    if (!target) return null;
    return this.host.settings.connectedVaultId === target.vaultId ? target.vaultId : null;
  }

  private selectedVersion(): FileVersionInfo | null {
    if (!this.selectedId) return this.versions[0] ?? null;
    return this.versions.find((version) => version.versionId === this.selectedId) ?? null;
  }

  /** The version a diff is taken against: the one before it in the chain, if any. */
  private previousVersion(version: FileVersionInfo): FileVersionInfo | null {
    const index = this.versions.findIndex((candidate) => candidate.versionId === version.versionId);
    if (index < 0) return null;
    return this.versions[index + 1] ?? null;
  }

  /**
   * Read the chain and repaint.
   *
   * The server lists a chain oldest first; it is reversed **once**, here, and everything
   * below reads that order — the list, the head selection and the diff baseline.
   *
   * `silent` is the background re-read a vault event asks for: it repaints in place instead
   * of putting the page back through its loading state, so a save in another pane does not
   * blank the version the reader is looking at.
   */
  private async reload(silent = false): Promise<void> {
    const generation = ++this.loadGeneration;
    const target = this.target;
    if (!target) {
      await this.render();
      return;
    }

    const vaultId = this.vaultId();
    if (!vaultId) {
      this.versions = [];
      this.loadError = t("versionHistory.notConnected");
      this.loading = false;
      await this.render();
      return;
    }

    this.loading = !silent;
    this.loadError = null;
    if (!silent) await this.render();

    try {
      const { versions } = await this.host.actions.getFileVersionHistory(vaultId, target.fileId);
      if (generation !== this.loadGeneration) return;
      this.versions = reversedCopy(versions);
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.versions = [];
      this.loadError = err instanceof Error ? err.message : String(err);
    }
    if (generation !== this.loadGeneration) return;

    this.loading = false;
    // The reader keeps the version they had picked while it still exists; otherwise the
    // head is the row the view opens on.
    this.selectedId = this.versions.some((version) => version.versionId === this.selectedId)
      ? this.selectedId
      : (this.versions[0]?.versionId ?? null);
    await this.render();
  }

  /** Paint the header, the list and the pane frame. */
  private async render(): Promise<void> {
    const { contentEl } = this;
    // The read this paint belongs to: a newer read makes this one stop halfway (its rows
    // would otherwise be written into a list nobody is looking at).
    const generation = this.loadGeneration;
    contentEl.empty();
    // Whatever was on screen owns a blob URL and a markdown tree; both go with it.
    this.disposeContent();
    this.listEl = null;
    this.headEl = null;
    this.bodyEl = null;
    this.rowEls.clear();

    if (!this.target) {
      this.renderStatus(t("versionHistory.noTarget"));
      return;
    }

    this.renderHeader();

    if (this.loadError !== null) {
      this.renderStatus(t("dialog.versionHistory.loadError", { error: this.loadError }));
      return;
    }
    if (this.loading) {
      this.renderStatus(t("versionHistory.loading"));
      return;
    }
    if (this.versions.length === 0) {
      this.renderStatus(t("dialog.versionHistory.empty"));
      return;
    }

    const body = contentEl.createDiv({ cls: "courier-vh-body" });
    this.listEl = body.createDiv({ cls: "courier-vh-list" });
    const pane = body.createDiv({ cls: "courier-vh-pane" });
    this.headEl = pane.createDiv({ cls: "courier-vh-pane-head" });
    this.bodyEl = pane.createDiv({ cls: "courier-vh-pane-body" });
    // Nothing already in flight may paint into this frame's elements.
    this.paneGeneration++;
    await this.renderList(generation);
    void this.paintPane().catch((error: unknown) => {
      console.error("Courier: rendering the version pane failed:", error);
      if (this.bodyEl) this.renderNote(this.bodyEl, t("dialog.versionHistory.contentError"));
    });
  }

  /**
   * The page header: what file this is, how many versions it has, and a way to re-read.
   *
   * The count is the one number the dialog below needs that the rows cannot summarise, and
   * it sits beside the refresh button because both answer "how much is there, and is it
   * current".
   */
  private renderHeader(): void {
    const path = this.currentPath();
    const header = this.contentEl.createDiv({ cls: "courier-vh-header" });

    const icon = header.createDiv({ cls: "courier-vh-icon" });
    setIcon(icon, previewIconOf(path));

    const title = header.createDiv({ cls: "courier-vh-title" });
    const name = title.createDiv({
      cls: "courier-vh-title-text",
      text: path ? fileNameOf(path) : t("versionHistory.viewTitle"),
    });
    if (path) {
      name.setAttribute("aria-label", path);
      name.setAttribute("data-tooltip-position", "top");
      // The path is a second line only when it adds something: a note at the vault's root
      // would otherwise print its own name twice.
      if (path !== fileNameOf(path)) {
        title.createDiv({ cls: "courier-vh-subtitle", text: path });
      }
    }

    const actions = header.createDiv({ cls: "courier-vh-actions" });
    if (this.versions.length > 0) {
      actions.createSpan({
        cls: "courier-vh-count",
        text: plural(
          "dialog.versionHistory.countLabel.one",
          "dialog.versionHistory.countLabel.other",
          this.versions.length,
        ),
      });
    }
    new ExtraButtonComponent(actions)
      .setIcon("refresh-cw")
      .setTooltip(t("versionHistory.refresh"))
      .onClick(() => {
        void this.reload();
      });
  }

  /** The chain, newest first, cut into days; the selected row is the pane's subject. */
  private async renderList(generation: number): Promise<void> {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    this.rowEls.clear();

    const key = this.host.encryptionKey;
    for (const day of groupVersionsByDay(this.versions)) {
      const section = list.createDiv({ cls: "courier-vh-day" });
      section.createDiv({
        cls: "courier-vh-day-title",
        text: formatHistoryDay(day.at),
      });
      for (const version of day.versions) {
        const versionPath = key ? await decryptPathOrNull(key, version.encryptedPath) : null;
        // Each row costs a decrypt, so a newer read can start while this one is still going;
        // stopping here keeps the older pass from writing rows into the newer list.
        if (generation !== this.loadGeneration) return;
        this.renderRow(section, version, versionPath);
      }
    }
  }

  private renderRow(
    parent: HTMLElement,
    version: FileVersionInfo,
    versionPath: string | null,
  ): void {
    const selected = version.versionId === this.selectedId;
    const deleted = version.action === "delete";
    const row = parent.createDiv({
      cls: `courier-vh-version is-${version.action}${selected ? " is-selected" : ""}`,
    });
    this.rowEls.set(version.versionId, row);
    if (!deleted) {
      row.addClass("is-selectable");
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      row.addEventListener("click", () => {
        void this.select(version.versionId);
      });
      row.addEventListener("keydown", (event) => {
        const keyboard = event;
        if (keyboard.key !== "Enter" && keyboard.key !== " ") return;
        keyboard.preventDefault();
        void this.select(version.versionId);
      });
    }

    const marker = row.createDiv({ cls: `courier-vh-marker is-${version.action}` });
    setIcon(marker, versionActionIcon(version.action));

    const info = row.createDiv({ cls: "courier-vh-info" });
    const top = info.createDiv({ cls: "courier-vh-row-top" });
    top.createSpan({ cls: "courier-vh-time", text: formatClockTime(version.createdAt) });
    top.createSpan({ cls: "courier-vh-action", text: syncActionLabel(version.action) });
    if (version.versionId === this.versions[0]?.versionId) {
      top.createSpan({
        cls: "courier-vh-current",
        text: t("dialog.versionHistory.current"),
      });
    }

    const meta = info.createDiv({ cls: "courier-vh-row-meta" });
    meta.createSpan({ cls: "courier-vh-device", text: deviceLabel(version.deviceName) });
    if (!deleted) {
      meta.createSpan({ cls: "courier-vh-size", text: formatVersionSize(version.sizeBytes) });
    }

    // The path only earns a line when it differs from where the chain lives now: on a
    // rename the row is the only place its old name still exists, and repeating the
    // current path under every other row would be noise.
    if (versionPath && versionPath !== this.currentPath()) {
      info.createDiv({ cls: "courier-vh-path", text: versionPath });
    }
    if (deleted) {
      info.createDiv({ cls: "courier-vh-warning", text: t("dialog.versionHistory.deleteWarning") });
    }
  }

  /**
   * Select a version: move the highlight, then repaint the pane.
   *
   * Deliberately **not** a full page render. Rebuilding the header and the list on every
   * click made the pane blink through an empty box — the old content was gone before the new
   * version's bytes had been fetched — and it threw away the list's scroll position and the
   * keyboard focus for nothing.
   */
  private select(versionId: string): void {
    if (this.selectedId !== versionId) {
      this.selectedId = versionId;
      for (const [id, row] of this.rowEls) {
        if (id === versionId) row.addClass("is-selected");
        else row.removeClass("is-selected");
      }
    }
    // Clicking the row that is already selected still repaints: that is the retry after a
    // version whose bytes failed to arrive, and it costs one read.
    void this.paintPane();
  }

  /**
   * The reading pane: the selected version's facts over its content or its diff.
   *
   * The mode switch lives here rather than in the page header because it only applies to
   * some versions: a PNG has no text to compare, and a delete row has nothing at all. A
   * control that disappears when it cannot work beats one that explains itself after a
   * click.
   *
   * The head is rebuilt in place (text only). The **body is emptied only once the new
   * version is in hand** — {@link renderContent} fetches first and clears second — because
   * clearing it up front left an empty box on screen for the length of a fetch and a
   * decrypt, which is what made clicking through a chain flicker.
   */
  private async paintPane(): Promise<void> {
    const head = this.headEl;
    const body = this.bodyEl;
    const version = this.selectedVersion();
    if (!head || !body || !version) return;

    const generation = ++this.paneGeneration;
    const deleted = version.action === "delete";
    const versionPath = this.currentPath() ?? this.target?.path ?? "";
    const kind = previewKindOf(versionPath);
    const diffable = !deleted && (kind === "markdown" || kind === "text");

    // A mode click rebuilds the head, so the control that had the focus has to get it back.
    // The guard is for the test harness's DOM-free leaf: `document` does not exist there.
    const hadFocus =
      typeof document !== "undefined" &&
      typeof head.contains === "function" &&
      document.activeElement !== null &&
      head.contains(document.activeElement);
    head.empty();

    const facts = head.createDiv({ cls: "courier-vh-pane-facts" });
    facts.createSpan({ cls: "courier-vh-pane-time", text: formatHistoryTime(version.createdAt) });
    facts.createSpan({ cls: "courier-vh-pane-action", text: syncActionLabel(version.action) });
    facts.createSpan({ cls: "courier-vh-pane-device", text: deviceLabel(version.deviceName) });
    if (!deleted) {
      facts.createSpan({
        cls: "courier-vh-pane-size",
        text: formatVersionSize(version.sizeBytes),
      });
    }

    const headActions = head.createDiv({ cls: "courier-vh-pane-actions" });
    if (diffable) this.renderModeToggle(headActions);
    if (!deleted) {
      new ButtonComponent(headActions)
        .setButtonText(t("versionHistory.restore"))
        .setCta()
        .onClick(() => {
          void this.restore(version);
        });
    }
    if (hadFocus) head.querySelector<HTMLElement>(".courier-segmented-option.is-active")?.focus();

    if (deleted) {
      this.clearBody(body, generation);
      if (generation === this.paneGeneration) {
        this.renderNote(body, t("dialog.versionHistory.deleteWarning"));
      }
      return;
    }
    if (!this.host.encryptionKey) {
      this.clearBody(body, generation);
      if (generation === this.paneGeneration) {
        this.renderNote(body, t("dialog.versionHistory.noKey"));
      }
      return;
    }
    if (diffable && this.mode === "diff") {
      await this.renderDiff(body, version, generation);
      return;
    }
    await this.renderContent(body, version, generation);
  }

  /** Empty the pane for a state that has no fetch: the selection already moved on or not. */
  private clearBody(body: HTMLElement, generation: number): void {
    if (generation !== this.paneGeneration) return;
    body.empty();
    body.removeClass("is-media");
    body.removeClass("is-diff");
    // The element that held the previous version's embeds and blob URLs is gone.
    this.disposeContent();
  }

  private renderModeToggle(parent: HTMLElement): void {
    // The shared segmented control (`styles.css`), the same one the comparison's 并排 / 统一
    // uses: both answer "how do I read this page", so they are the same control.
    const group = parent.createDiv({ cls: "courier-segmented" });
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", t("versionHistory.modeLabel"));
    for (const mode of ["content", "diff"] as const) {
      const active = this.mode === mode;
      const button = group.createEl("button", {
        cls: `courier-segmented-option${active ? " is-active" : ""}`,
        text: t(mode === "content" ? "versionHistory.mode.content" : "versionHistory.mode.diff"),
      });
      button.setAttribute("aria-pressed", String(active));
      button.addEventListener("click", () => {
        if (this.mode === mode) return;
        this.mode = mode;
        void this.paintPane();
      });
    }
  }

  /**
   * Draw the version into `body` and answer the lifecycle owner of what was drawn.
   *
   * The caller unloads that owner when the content is replaced (revoking its blob URLs) or
   * when a newer selection makes this drawing stale.
   */
  private async renderContent(
    body: HTMLElement,
    version: FileVersionInfo,
    generation: number,
  ): Promise<void> {
    // Fetch before touching the DOM: the version on screen stays there until these bytes are
    // in hand, which is what keeps a click from flashing an empty pane.
    const bytes = await this.readVersion(version);
    if (generation !== this.paneGeneration) return;

    const owner = new Component();
    owner.load();
    body.empty();
    body.removeClass("is-diff");
    // A media version puts this class on the body; the next text version must not inherit
    // its centred, quiet surface.
    body.removeClass("is-media");

    if (bytes === null) {
      owner.unload();
      // The old version's DOM is gone, so whatever it registered dies here rather than at the
      // next successful paint.
      this.disposeContent();
      this.renderNote(body, t("dialog.versionHistory.contentError"));
      return;
    }

    const previous = this.contentOwner;
    this.contentOwner = owner;
    previous?.unload();
    await renderFileContent({
      app: this.app,
      container: body,
      path: this.currentPath() ?? this.target?.path ?? "",
      bytes,
      owner,
    });
  }

  /**
   * The selected version against the one before it, as a unified diff.
   *
   * A create version has no version before it, and a peer's tombstone carries no bytes —
   * both are answered with an empty baseline, which is the truthful comparison: everything
   * on screen is new. Identical content (a rename, a restore of the same bytes) says so
   * instead of printing an unchanged page, because "nothing changed" is the answer.
   */
  private async renderDiff(
    body: HTMLElement,
    version: FileVersionInfo,
    generation: number,
  ): Promise<void> {
    const previous = this.previousVersion(version);
    const [selectedBytes, previousBytes] = await Promise.all([
      this.readVersion(version),
      previous && previous.action !== "delete" ? this.readVersion(previous) : Promise.resolve(null),
    ]);
    // Nothing is drawn until both sides are here, so the pane never blinks through an empty
    // box on the way to a comparison.
    if (generation !== this.paneGeneration) return;

    body.empty();
    body.removeClass("is-media");
    // A diff replaces the rendered version, so whatever that version owned dies here.
    this.disposeContent();

    if (selectedBytes === null) {
      this.renderNote(body, t("dialog.versionHistory.contentError"));
      return;
    }

    body.addClass("is-diff");
    body.createDiv({
      cls: "courier-vh-diff-caption",
      text: previous
        ? t("versionHistory.diffCaption", { time: formatHistoryTime(previous.createdAt) })
        : t("versionHistory.diffFirst"),
    });

    const rows = diffTextLines(
      previousBytes === null ? "" : new TextDecoder().decode(previousBytes),
      new TextDecoder().decode(selectedBytes),
    );
    if ("tooLarge" in rows) {
      this.renderNote(body, t("versionHistory.diffTooLarge"));
      return;
    }
    if (!rows.rows.some((row) => row.kind !== "same")) {
      this.renderNote(body, t("versionHistory.diffSame"));
      return;
    }

    // The comparison reuses the conflict view's row model and styles: one stream of lines
    // with a `−`/`+` sigil, which is the presentation a narrow pane can carry.
    const list = body.createDiv({ cls: "courier-diff-rows is-unified" });
    for (const line of unifiedLines(rows.rows)) this.renderDiffLine(list, line);
  }

  private renderDiffLine(parent: HTMLElement, line: UnifiedLine): void {
    const kind = line.marker === "-" ? "remove" : line.marker === "+" ? "add" : "same";
    const row = parent.createDiv({ cls: `courier-diff-line courier-diff-line-${kind}` });
    // The same typographic minus the conflict view prints (U+2212), so a line reads the
    // same in both surfaces; `+` is the same character either way.
    const sigil = line.marker === " " ? "" : line.marker === "-" ? "−" : "+";
    row.createSpan({ cls: "courier-diff-sigil", text: sigil });
    row.createSpan({ cls: "courier-diff-text", text: line.text });
  }

  /** A version's decrypted bytes, or `null` when they cannot be read or decrypted. */
  private async readVersion(version: FileVersionInfo): Promise<Uint8Array | null> {
    const vaultId = this.vaultId();
    const key = this.host.encryptionKey;
    if (!vaultId || !key) return null;
    try {
      return await readVersionContent(
        this.host.actions,
        vaultId,
        version.contentHash,
        version.sizeBytes,
        key,
      );
    } catch {
      return null;
    }
  }

  /** Restore the selected version through the engine's own restore flow. */
  private async restore(version: FileVersionInfo): Promise<void> {
    const engine = this.host.engine;
    const target = this.target;
    if (!engine || !target) {
      showNotice(
        this.host.settings.syncPaused ? t("notice.needsResume") : t("notice.notConnected"),
      );
      return;
    }

    const outcome = await runRestoreFlow({
      app: this.app,
      engine,
      fileId: target.fileId,
      sourcePath: this.currentPath() ?? target.path,
      contentHash: version.contentHash,
      // An in-place restore replaces content the user can still see; the writing side is
      // the engine's, so this only asks before it does.
      confirmOverwrite: async (targetPath) => {
        const confirm = new RestoreVersionConfirmModal(
          this.app,
          targetPath,
          formatHistoryTime(version.createdAt),
        );
        confirm.open();
        return (await confirm.getResult()) === true;
      },
    });

    if (outcome !== "restored") return;
    // The restore is one more version on this chain: re-read it, and land on the new head
    // rather than on the version that was restored from.
    this.selectedId = null;
    await this.reload();
    showNotice(t("dialog.versionHistory.restored", { id: version.versionId.substring(0, 12) }));
  }

  private disposeContent(): void {
    this.contentOwner?.unload();
    this.contentOwner = null;
  }

  /** A centred sentence, for the states that have no list or pane to show. */
  private renderStatus(text: string): void {
    this.contentEl.createDiv({ cls: "courier-vh-status", text });
  }

  /** An explanatory line inside the pane, where the content would be. */
  private renderNote(parent: HTMLElement, text: string): void {
    parent.createDiv({ cls: "courier-vh-note", text });
  }
}

/** Confirmation for a restore that replaces the note's current content. */
class RestoreVersionConfirmModal extends PromiseModal<boolean> {
  constructor(
    app: App,
    private readonly targetPath: string,
    private readonly versionTime: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t("dialog.versionHistory.confirmTitle"));
    this.contentEl.createEl("p", {
      text: t("dialog.versionHistory.confirmText", {
        path: this.targetPath,
        time: this.versionTime,
      }),
    });
    this.contentEl.createEl("p", {
      text: t("dialog.versionHistory.confirmBody"),
    });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t("common.cancel")).onClick(() => this.cancel()))
      .addButton((button) =>
        button
          .setButtonText(t("dialog.versionHistory.restore"))
          .setCta()
          .onClick(() => this.resolve(true)),
      );
  }
}

/**
 * Read what a leaf's `state` holds, or **null** when it holds no usable target.
 *
 * The state crosses a boundary (Obsidian writes it to the layout file and reads it back), so
 * it is checked field by field rather than trusted: a state without a vault, a fileId and a
 * path is a view with nothing to show, and it must not throw during a workspace restore.
 */
export function parseVersionHistoryState(state: unknown): VersionHistoryViewState | null {
  if (typeof state !== "object" || state === null) return null;
  const record = state as Record<string, unknown>;
  const target = record.target;
  if (typeof target !== "object" || target === null) return null;
  const { vaultId, fileId, path } = target as Record<string, unknown>;
  if (typeof vaultId !== "string" || vaultId === "") return null;
  if (typeof fileId !== "string" || fileId === "") return null;
  if (typeof path !== "string" || path === "") return null;
  const selected = typeof record.selected === "string" ? record.selected : undefined;
  return {
    target: { vaultId, fileId, path },
    selected,
    mode: record.mode === "diff" ? "diff" : "content",
  };
}

/** A path's file name, which is what the tab and the header name a file by. */
function fileNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}
