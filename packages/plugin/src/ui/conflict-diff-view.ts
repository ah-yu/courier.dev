import { ItemView, Platform, Setting, TFile, setIcon, type EventRef } from "obsidian";
import { t } from "../i18n";
import type { ReplaceTarget } from "../shared/conflict-replace";
import { diffTextLines, unifiedLines, type DiffRow } from "../shared/text-diff";
import { runConflictReplace } from "./dialogs/conflict-replace-modal";

/**
 * The view type both the plugin and the e2e driver open the comparison by.
 *
 * A leaf's `data-type` (and therefore a `.workspace-leaf-content[data-type=…]` query) is
 * this string, which is what makes the comparison findable in a real Obsidian window.
 */
export const CONFLICT_DIFF_VIEW_TYPE = "courier-conflict-diff";

/**
 * How long a vault event waits before the view re-reads what it is showing.
 *
 * A conflict copy is an ordinary vault file, so a typed edit reaches this view through
 * `vault.on("modify")` — and Obsidian can deliver several events for one save. Debouncing
 * turns them into one re-read, which is also what keeps a large diff from being recomputed
 * per keystroke.
 */
export const CONFLICT_DIFF_REFRESH_MS = 200;

/** The two presentations of the same row model. */
export type ConflictDiffMode = "split" | "unified";

/**
 * Which presentation a comparison opens in on a given platform.
 *
 * A phone's page is one column wide: two half-width panes leave about twenty characters a
 * side, so the **unified** stream — one line, one `−`/`+`, the shared width for the text — is
 * the honest default there. A desktop keeps the side-by-side reading, which is the only way
 * to see "same line, two versions" without scanning a marker. The user can always switch;
 * this only decides where the first view of a parked copy starts.
 */
export function defaultConflictDiffMode(phone: boolean): ConflictDiffMode {
  return phone ? "unified" : "split";
}

/**
 * What a leaf has to remember to reopen this comparison (the view's persisted state).
 *
 * `Record<string, unknown>` rather than a bare interface: Obsidian's `ViewState.state` is
 * that type, and a `setViewState` call site should not have to cast the value it hands in.
 */
export interface ConflictDiffState extends Record<string, unknown> {
  target: ReplaceTarget;
  mode: ConflictDiffMode;
}

/** One side of the comparison as it currently is on disk. */
interface LoadedText {
  path: string;
  exists: boolean;
  /** `null` when the file could not be read (it is still `exists`). */
  text: string | null;
}

/**
 * The comparison of a parked conflict copy with the file it was parked beside.
 *
 * This is a **workspace view**, not a dialog: it is opened in a tab of the main area
 * (`CourierPlugin.openConflictDiff`) and fills it the way a file view does, so a comparison
 * is something the user keeps beside the note instead of a floating panel that hides it —
 * the shape VS Code gives a read-only diff tab. One tab per parked copy: the plugin asks
 * for the copy's path and activates the leaf that already compares it.
 *
 * Both sides are **local plaintext**: the copy is a vault file the engine parked and the
 * original is the version that won — so this view needs no vault key, no engine and no
 * network, and it keeps working while sync is stopped. In the split presentation the left
 * column is the copy (this device's losing version) and the right one is the file as it
 * stands now; the unified presentation marks the copy's lines with `−` and the file's with
 * `+`. The header names both files, and a phone gets a legend under it naming the two
 * sides, because a narrow page cannot afford two column headers.
 *
 * The surface is **one responsive page**, not a desktop view with a phone copy beside it:
 * `styles.css` gives a phone the unified presentation by default (`defaultConflictDiffMode`),
 * a compact header with a full-width write, and one column of rows. The markup here is what
 * both shapes share.
 *
 * There is no merge: the row model is read-only, and the one action that writes is
 * "用冲突副本替换当前文件" — a whole-file choice whose result nobody has to guess.
 */
export class ConflictDiffView extends ItemView {
  private target: ReplaceTarget | null = null;
  private mode: ConflictDiffMode = "split";
  private readonly refs: EventRef[] = [];
  private refreshTimer: number | null = null;
  private sides: { original: LoadedText; copy: LoadedText } | null = null;
  private rowsEl: HTMLElement | null = null;
  /**
   * Which read the view is showing.
   *
   * Vault events arrive while a read is still in flight (a save can fire several, and a
   * large pair takes a while to read and align), so the answers are numbered: only the
   * newest one renders, and a read that lands after `onClose` renders nothing. Without
   * this, a slow earlier read could repaint the view with content newer events had
   * already replaced — and could repaint a closed view's detached content.
   */
  private generation = 0;
  /**
   * Whether Obsidian has opened this view (`onOpen` without a `onClose` since).
   *
   * It orders the two entry points: `setState` and `onOpen` can arrive in either order, and
   * only the one that finds the view open does the work.
   */
  private opened = false;

  /** What this tab compares, or `null` while its leaf holds no usable state. */
  get comparedTarget(): ReplaceTarget | null {
    return this.target;
  }

  getViewType(): string {
    return CONFLICT_DIFF_VIEW_TYPE;
  }

  /** The tab's title: the parked copy, which is what tells two comparisons apart. */
  getDisplayText(): string {
    return this.target ? fileNameOf(this.target.conflictPath) : t("dialog.conflictDiff.title");
  }

  /** The same icon the file explorer's action carries. */
  getIcon(): string {
    return "diff";
  }

  override getState(): Record<string, unknown> {
    if (!this.target) return {};
    const state: ConflictDiffState = { target: this.target, mode: this.mode };
    return state;
  }

  /**
   * Take the pair to compare from the leaf's state.
   *
   * Obsidian calls this before `onOpen` when the leaf is created, and again when a restored
   * layout is loaded — but the order is the app's, not this view's: `setViewState` can also
   * land **after** `onOpen` (that is what happens in Obsidian 1.14 when a tab is opened
   * programmatically), so the two entry points are written to be order-independent. Whichever
   * of them arrives second does the reading and the rendering.
   *
   * A state without a usable target (an older layout file, a hand-edited JSON) keeps the view
   * empty rather than throwing during a workspace restore: the view then says what is
   * missing, exactly like a half-missing comparison.
   */
  override async setState(state: unknown, _result: unknown): Promise<void> {
    const parsed = parseConflictDiffState(state);
    this.target = parsed?.target ?? null;
    this.mode = parsed?.mode ?? defaultConflictDiffMode(Platform.isPhone);
    this.sides = null;
    this.rowsEl = null;
    if (!this.opened) return;
    // An open leaf can be given a new state; it then re-reads the pair it now compares.
    this.unwatch();
    this.watch();
    if (this.target) await this.refresh();
    else this.render();
  }

  async onOpen(): Promise<void> {
    this.opened = true;
    // A stable marker on the view's own content element: the styles and the e2e driver
    // both find the comparison by it, and it names the surface rather than the target.
    this.contentEl.addClass("courier-conflict-diff");
    this.unwatch();
    this.watch();
    // `setState` may not have arrived yet; it renders instead when it does.
    if (this.target) await this.refresh();
    else this.render();
  }

  async onClose(): Promise<void> {
    this.opened = false;
    // A read still in flight is recognised as stale when it lands: the leaf can be
    // detached and the very same view instance reopened (Obsidian reuses a leaf), and a
    // late answer for the closed state must not paint over the new one.
    this.generation++;
    if (this.refreshTimer !== null) {
      window.clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.unwatch();
    this.sides = null;
    this.rowsEl = null;
    this.contentEl.empty();
  }

  /** Re-read both files and re-render, keeping the reader's scroll position. */
  private async refresh(): Promise<void> {
    const target = this.target;
    if (!target) return;
    const generation = ++this.generation;
    const scrollTop = this.rowsEl?.scrollTop ?? 0;
    const [original, copy] = await Promise.all([
      this.readSide(target.originalPath),
      this.readSide(target.conflictPath),
    ]);
    // A newer read started while this one was waiting, or the view was closed. The
    // `opened` flag is deliberately not consulted here: a reopen sets it again, and the
    // generation counter is what orders the reads across a close/open pair.
    if (generation !== this.generation) return;
    this.sides = { original, copy };
    this.render();
    if (this.rowsEl) this.rowsEl.scrollTop = scrollTop;
  }

  /**
   * Follow the two files while the comparison is open.
   *
   * `create` is watched as well as `modify`: a peer can restore the original (or the user
   * can undelete it) while the comparison is up, and the view has to notice that there is
   * something to compare against now.
   */
  private watch(): void {
    const target = this.target;
    if (!target) return;
    const onVaultEvent = (file: { path?: string }, oldPath?: string): void => {
      const path = file?.path;
      if (
        path === target.originalPath ||
        path === target.conflictPath ||
        oldPath === target.originalPath ||
        oldPath === target.conflictPath
      ) {
        this.scheduleRefresh();
      }
    };
    // Registered one by one: `Vault.on` has an overload per event name, and the union of
    // them is not callable as one signature.
    this.refs.push(this.app.vault.on("create", onVaultEvent));
    this.refs.push(this.app.vault.on("modify", onVaultEvent));
    this.refs.push(this.app.vault.on("delete", onVaultEvent));
    this.refs.push(this.app.vault.on("rename", onVaultEvent));
  }

  /** Drop the vault listeners this view registered. Safe to call twice. */
  private unwatch(): void {
    for (const ref of this.refs) {
      this.app.vault.offref(ref);
    }
    this.refs.length = 0;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, CONFLICT_DIFF_REFRESH_MS);
  }

  private async readSide(path: string): Promise<LoadedText> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return { path, exists: false, text: null };
    try {
      return { path, exists: true, text: await this.app.vault.cachedRead(file) };
    } catch {
      return { path, exists: true, text: null };
    }
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.rowsEl = null;

    const target = this.target;
    // A leaf restored with a state this view cannot read still has to say why it is empty.
    if (!target) {
      this.renderShell();
      this.renderStatus(t("dialog.conflictDiff.empty"));
      return;
    }

    const { original, copy } = this.sides ?? {
      original: { path: target.originalPath, exists: false, text: null },
      copy: { path: target.conflictPath, exists: false, text: null },
    };

    // A comparison needs both files. When one is missing the view names it and stops
    // there: the column names and the picker describe a table that cannot be drawn, and
    // one side's text on its own is a comparison nobody can make. The missing-original
    // case keeps its one write (恢复为原文件) in the header, because that is the only useful
    // thing left to do.
    if (!copy.exists || copy.text === null) {
      this.renderShell();
      this.renderStatus(this.missingSentence(copy, "copy"));
      return;
    }

    if (!original.exists || original.text === null) {
      this.renderShell({
        label: t("dialog.conflictDiff.restoreOriginal"),
        onClick: () => void this.replace(),
      });
      this.renderStatus(this.missingSentence(original, "original"));
      return;
    }

    const diff = diffTextLines(copy.text, original.text);
    if ("tooLarge" in diff) {
      // There is no table to draw, but the copy is still the losing version and the one write
      // is still the decision the user came for: keep it reachable from the header.
      this.renderShell({
        label: t("dialog.conflictDiff.replace"),
        onClick: () => void this.replace(),
      });
      this.renderStatus(t("dialog.conflictDiff.tooLarge"));
      return;
    }

    this.renderHeader(copy, original, diff.rows);
    // Which side is which, for the phone's one-column page. It is built on every platform and
    // hidden by CSS on the desktop: `preview:ui --mobile` drives a desktop app with
    // `body.is-phone`, so gating this on `Platform.isPhone` would make the phone layout
    // impossible to preview.
    this.renderLegend();
    // The body is the box the divider belongs to: the two columns' gutter is one line drawn
    // over it, so it runs the box's full height even when the note is three lines long. The
    // rows inside it are what actually scroll.
    const body = contentEl.createDiv({ cls: `courier-diff-body is-${this.mode}` });
    this.rowsEl = body.createDiv({
      cls: `courier-diff-rows is-${this.mode}`,
      attr: { role: "table" },
    });
    if (this.mode === "split") this.renderSplit(diff.rows);
    else this.renderUnified(diff.rows);
  }

  /**
   * The page's own frame, for the states that have nothing to compare: the title, and —
   * when there is still something to do — its one action.
   *
   * It keeps the empty and half-missing views looking like the same page rather than a bare
   * sentence in a tab.
   */
  private renderShell(action?: { label: string; onClick: () => void }): void {
    const target = this.target;
    if (!target) return;
    const header = this.contentEl.createDiv({ cls: "courier-conflict-diff-header" });
    this.renderNames(header, target.originalPath, target.conflictPath);
    if (!action) return;
    const setting = new Setting(header);
    setting.settingEl.addClass("courier-conflict-diff-header-actions");
    setting.addButton((button) =>
      button.setButtonText(action.label).setCta().onClick(action.onClick),
    );
  }

  /**
   * The two file names, and — on a phone — the diff icon beside them.
   *
   * The first line is the **original** file, because that is the note the user knows; the
   * parked copy sits under it in the monospace face that marks a generated name. The icon is
   * part of the title block, so `styles.css` can lay a phone out as "tile, then two lines"
   * without a second wrapper; on the desktop it is `display: none` and the block stays the
   * two text lines the header was built around.
   */
  private renderNames(header: HTMLElement, originalPath: string, copyPath: string): void {
    const title = header.createDiv({ cls: "courier-conflict-diff-title" });
    const icon = title.createDiv({ cls: "courier-conflict-diff-icon" });
    setIcon(icon, "diff");
    const name = title.createDiv({
      cls: "courier-conflict-diff-title-text",
      text: fileNameOf(originalPath),
    });
    name.setAttribute("aria-label", originalPath);
    name.setAttribute("data-tooltip-position", "top");
    const subtitle = title.createDiv({
      cls: "courier-conflict-diff-subtitle",
      text: fileNameOf(copyPath),
    });
    subtitle.setAttribute("aria-label", copyPath);
    subtitle.setAttribute("data-tooltip-position", "top");
  }

  /**
   * Which side is which, for the presentations that need saying.
   *
   * The split view leaves this to the header, whose first line is the *right* column — a
   * mapping the page never stated. That ambiguity is tolerable on a wide desktop page, where
   * the two columns are read side by side, but not on a phone: the unified stream has no
   * columns at all, and two half-width ones have no room for their own header. The legend
   * therefore names the copy and the current file once, with the colours their rows use. It is
   * a phone affordance: the desktop keeps the header-and-two-columns page it had before phones
   * were supported, and `styles.css` hides the legend there.
   */
  private renderLegend(): void {
    const legend = this.contentEl.createDiv({
      cls: `courier-conflict-diff-legend is-${this.mode}`,
    });
    const copy = legend.createDiv({ cls: "courier-conflict-diff-legend-part is-copy" });
    copy.createSpan({ cls: "courier-conflict-diff-legend-sigil", text: "−" });
    copy.createSpan({ text: t("dialog.conflictDiff.copyLegend") });
    const current = legend.createDiv({ cls: "courier-conflict-diff-legend-part is-current" });
    current.createSpan({ cls: "courier-conflict-diff-legend-sigil", text: "+" });
    current.createSpan({ text: t("dialog.conflictDiff.currentLegend") });
  }

  /**
   * The page header: one row holding what is compared, how much differs, the layout choice,
   * and the one write — the note's name on the left, the replace button on the right.
   *
   * - The title is the **original** file's name — that is the note the user knows — with
   *   the parked copy's name under it, because "which two files" is the first question a
   *   comparison answers.
   * - The counts are the summary VS Code shows above a diff: how many lines were added and
   *   removed, in that order, each in its own colour.
   * - 并排 / 统一 is the shared **segmented control**: one track, the chosen state raised, the
   *   same shape the version history's 完整内容 / 差异 uses — it takes one control's width and
   *   leaves the row for the title.
   * - 用冲突副本替换当前文件 sits at the row's right end, **on the same line** as the rest of
   *   the header, so the page's one write is where the eye already is and not a footer to
   *   scroll to. On a phone the header wraps into three bands instead (see `styles.css`):
   *   the names, the counts and the layout control, then the write across the page.
   */
  private renderHeader(copy: LoadedText, original: LoadedText, rows: DiffRow[]): void {
    const header = this.contentEl.createDiv({ cls: "courier-conflict-diff-header" });
    this.renderNames(header, original.path, copy.path);

    const summary = countChanges(rows);
    const stats = header.createDiv({ cls: "courier-conflict-diff-stats" });
    stats.createSpan({
      cls: "courier-conflict-diff-stat is-added",
      text: t("dialog.conflictDiff.added", { count: summary.added }),
    });
    stats.createSpan({
      cls: "courier-conflict-diff-stat is-removed",
      text: t("dialog.conflictDiff.removed", { count: summary.removed }),
    });

    // The layout control and the write share one group at the header's right end: 8 px apart,
    // while the header's other groups keep their wider gap. Keeping them together is what makes
    // the pair wrap to the right at narrow container widths; on a phone the group becomes
    // `display: contents`, so the write can take a full-width band of its own.
    //
    // The row's own label is not drawn (`styles.css`): the two option words say what the
    // control is, and the header has one line to keep. The control carries the name for
    // assistive technology instead.
    const actions = header.createDiv({ cls: "courier-conflict-diff-actions" });
    this.renderLayoutToggle(actions);
    const setting = new Setting(actions);
    setting.settingEl.addClass("courier-conflict-diff-header-actions");
    setting.addButton((button) => {
      button
        .setButtonText(
          this.sides?.original.exists
            ? t("dialog.conflictDiff.replace")
            : t("dialog.conflictDiff.restoreOriginal"),
        )
        .setCta()
        .onClick(() => void this.replace());
      // Named so the e2e reader can tell the one write from the two layout options, which are
      // buttons too (`packages/e2e/src/obsidian/plugin-control.ts`).
      button.buttonEl.addClass("courier-conflict-diff-replace");
    });
  }

  /**
   * 并排 / 统一, as the shared segmented control (`styles.css`).
   *
   * It used to be a dropdown; the version history's 完整内容 / 差异 is the same choice in the
   * same place on the page, and two shapes for it read as two different kinds of control.
   * Both states stay visible, which is also what makes the pair one click instead of two.
   *
   * The group carries "布局" as its name for assistive technology (the row's own label is
   * not drawn, because the header has one line to keep).
   */
  private renderLayoutToggle(parent: HTMLElement): void {
    const group = parent.createDiv({ cls: "courier-segmented" });
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", t("dialog.conflictDiff.layout"));
    for (const mode of ["split", "unified"] as const) {
      const active = this.mode === mode;
      const button = group.createEl("button", {
        cls: `courier-segmented-option${active ? " is-active" : ""}`,
        text: t(mode === "split" ? "dialog.conflictDiff.split" : "dialog.conflictDiff.unified"),
      });
      button.setAttribute("aria-pressed", String(active));
      button.addEventListener("click", () => {
        if (this.mode === mode) return;
        this.mode = mode;
        this.render();
      });
    }
  }

  /**
   * The one sentence a half-missing comparison says.
   *
   * It names the file it could not find and why it may be gone, because that is the whole
   * question the user has when the view opens: the copy was parked beside *that* file, and
   * with it gone there is nothing to compare against.
   */
  private missingSentence(side: LoadedText, role: "copy" | "original"): string {
    const name = fileNameOf(side.path);
    if (side.exists) return t("dialog.conflictDiff.unreadable", { name });
    return role === "copy"
      ? t("dialog.conflictDiff.missingCopy", { name })
      : t("dialog.conflictDiff.missingOriginal", { name });
  }

  private renderStatus(text: string): void {
    this.contentEl.createEl("p", { cls: "courier-conflict-diff-status", text });
  }

  private renderSplit(rows: DiffRow[]): void {
    if (!this.rowsEl) return;
    for (const row of rows) {
      const rowEl = this.rowsEl.createDiv({ cls: `courier-diff-row courier-diff-row-${row.kind}` });
      // The sign a text diff would print: only a **changed** row carries one, on the side
      // that actually changed — the same rule the unified view follows with its markers.
      const leftGone = row.kind === "remove" || row.kind === "change";
      const rightNew = row.kind === "add" || row.kind === "change";
      this.renderCell(rowEl, "left", row.left, row.leftNo, leftGone);
      this.renderCell(rowEl, "right", row.right, row.rightNo, rightNew);
    }
  }

  private renderCell(
    parent: HTMLElement,
    side: "left" | "right",
    text: string | null,
    lineNo: number | null,
    changed: boolean,
  ): void {
    const cell = parent.createDiv({ cls: `courier-diff-cell courier-diff-${side}` });
    cell.createSpan({ cls: "courier-diff-no", text: lineNo === null ? "" : String(lineNo) });
    const sigil = changed && text !== null ? (side === "left" ? "−" : "+") : "";
    cell.createSpan({ cls: "courier-diff-sigil", text: sigil });
    cell.createSpan({ cls: "courier-diff-text", text: text ?? "" });
  }

  private renderUnified(rows: DiffRow[]): void {
    if (!this.rowsEl) return;
    for (const line of unifiedLines(rows)) {
      const kind = line.marker === "-" ? "remove" : line.marker === "+" ? "add" : "same";
      const lineEl = this.rowsEl.createDiv({ cls: `courier-diff-line courier-diff-line-${kind}` });
      // The same typographic minus the split view prints (U+2212), so a line reads the same in
      // both presentations; `+` is the same character either way.
      const sigil = line.marker === " " ? "" : line.marker === "-" ? "−" : "+";
      lineEl.createSpan({ cls: "courier-diff-sigil", text: sigil });
      // The text is its own element, so the marker is never part of what gets copied out.
      lineEl.createSpan({ cls: "courier-diff-text", text: line.text });
    }
  }

  private async replace(): Promise<void> {
    if (!this.target) return;
    const result = await runConflictReplace(this.app, this.target);
    if (result !== null && result.outcome !== "failed") this.leaf.detach();
  }
}

/**
 * Read what a leaf's `state` holds, or **null** when it holds no usable target.
 *
 * The state crosses a boundary (Obsidian writes it to the layout file and reads it back),
 * so it is checked field by field rather than trusted: a state that is not an object, or a
 * target without two non-empty string paths, is a view with nothing to compare.
 */
export function parseConflictDiffState(state: unknown): ConflictDiffState | null {
  if (typeof state !== "object" || state === null) return null;
  const record = state as Record<string, unknown>;
  const target = record.target;
  if (typeof target !== "object" || target === null) return null;
  const { conflictPath, originalPath } = target as Record<string, unknown>;
  if (typeof conflictPath !== "string" || conflictPath === "") return null;
  if (typeof originalPath !== "string" || originalPath === "") return null;
  return {
    target: { conflictPath, originalPath },
    // A state written before the mode was remembered (or hand-edited) opens in the platform's
    // default, not in two columns on a phone: `defaultConflictDiffMode` is the stated default,
    // and a missing field is not evidence that the reader chose split.
    mode:
      record.mode === "unified"
        ? "unified"
        : record.mode === "split"
          ? "split"
          : defaultConflictDiffMode(Platform.isPhone),
  };
}

/**
 * How many lines each side contributes to the difference, for the header's summary.
 *
 * A `change` row is one removed line and one added one; a `remove`/`add` row is only its
 * own side. This is the count every diff viewer shows above the content — "what am I in
 * for" before reading a single line.
 */
export function countChanges(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.left !== null && row.kind !== "same") removed++;
    if (row.right !== null && row.kind !== "same") added++;
  }
  return { added, removed };
}

/** A path's file name, which is what the view names a file by (the full path is the tooltip). */
function fileNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}
