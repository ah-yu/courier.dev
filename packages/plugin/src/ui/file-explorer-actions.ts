import { type App } from "obsidian";
import { t } from "../i18n";
import {
  conflictActionFor,
  conflictActionLabel,
  conflictActionTitle,
} from "../shared/conflict-actions";
import { fileActionFor } from "../shared/file-actions";

/**
 * The two actions a file-explorer row can carry, next to its name.
 *
 * **Desktop only** — `main.ts` installs this only when `Platform.isDesktop`, because hover is
 * a pointer gesture and the surfaces behind the chips are wide. Obsidian has no public
 * per-file hook for its file explorer, so the rows are decorated by watching the explorer's
 * DOM: a chip is added to every `.nav-file-title[data-path]`, and a `MutationObserver` keeps
 * up with the explorer rebuilding its rows (a new file, a folder expanded, another window
 * opened). The failure mode is deliberately "no button": if the selector ever stops matching,
 * nothing is injected and nothing throws — the version history stays reachable from the
 * file's own context menu, which is public API (`main.ts` registers it on `file-menu`).
 *
 * Two chips, one per kind of row:
 *
 * - a **parked conflict copy** gets its own action (`对比` / `替换`), because a copy has no
 *   chain at all — offering history for it would open a view that could only say "no
 *   versions";
 * - every **other file** gets `版本历史`. That is the desktop entry point: the app's own
 *   "Version history" context-menu item sits on the same file, and a hover chip on the row
 *   is the one that is not mistaken for it.
 *
 * Neither chip is offered on a file under an **excluded folder**: the folder is outside this
 * device's scope, so the chips follow the scope rather than the file. A chain this device had
 * before the folder was excluded is kept (the engine parks the file there and says so in
 * `docs/sync-scope.md`) and a copy parked before the exclusion is still on disk — neither is
 * offered from here, deliberately. {@link fileActionFor} is the rule, shared with the file
 * menu.
 */

/** The class the conflict chip carries (styling, cleanup and tests all find it by it). */
export const CONFLICT_ACTION_CLASS = "courier-conflict-action";

/** The class the version-history chip carries, with the same role. */
export const VERSION_HISTORY_ACTION_CLASS = "courier-version-history-action";

/** What the chips do, by action kind. */
export interface FileExplorerActionHandlers {
  openDiff(conflictPath: string): void;
  openReplace(conflictPath: string): void;
  openVersionHistory(path: string): void;
}

/** The install's inputs: what a chip does, plus what this device keeps out of sync. */
export interface FileExplorerActionsOptions extends FileExplorerActionHandlers {
  /** Read the current excluded-folder list; a row under one gets no chip. */
  excludedFolders: () => readonly string[];
}

/** The handle the plugin keeps so it can re-decorate or dispose the chips. */
export interface FileExplorerActions {
  /** Re-evaluate every known row, after the excluded list changed. */
  refresh(): void;
  dispose(): void;
}

/** The explorer row a mutation happened inside, if any (the row may itself be the target). */
function nearestRow(node: Node | null): HTMLElement | null {
  let current: Node | null = node;
  while (current !== null && current.nodeType === 1) {
    const element = current as HTMLElement;
    if (element.matches?.(".nav-file-title[data-path]")) return element;
    current = element.parentElement;
  }
  return null;
}

/**
 * Inject the action chips into a file explorer and follow it as it rebuilds.
 *
 * Answers a handle that re-decorates the rows on demand (the excluded list changed, so a
 * file that stops being excluded gets its chip back — and one that starts being excluded
 * loses it), and that disposes the observers, removes the chips it created and unregisters
 * its workspace events.
 */
export function installFileExplorerActions(
  app: App,
  options: FileExplorerActionsOptions,
): FileExplorerActions {
  const observers: MutationObserver[] = [];
  const buttons = new Set<HTMLElement>();
  /** Every explorer container this install follows, main window and popouts alike. */
  const containers = new Set<HTMLElement>();
  let disposed = false;

  /**
   * Decorate one explorer row, by what its path is.
   *
   * What says "done" is the **chip being present**, not a flag on the row: Obsidian rebuilds
   * a row's children on its own schedule (an active-file change, a re-render of the tree),
   * which removes the chip while leaving the row element the flag was set on.
   *
   * The same row element is also reused when its file is **renamed** or excluded: Obsidian
   * updates `data-path` in place, so the row can stop being a conflict copy — or start
   * being under an excluded folder — while keeping the chip the old path was given. A chip
   * whose path no longer matches what the row is would act on a file that is gone, so it is
   * removed here — the row is the single source of truth for which path its chips act on.
   */
  const decorateRow = (title: HTMLElement): void => {
    const path = title.getAttribute("data-path");
    if (!path) return;
    const excluded = options.excludedFolders();
    const conflict = decorateConflictTitle(title, path, options, excluded);
    const version = decorateVersionHistoryTitle(title, path, options, excluded);
    if (conflict !== null) buttons.add(conflict);
    if (version !== null) buttons.add(version);
    // Drop the ones Obsidian has thrown away, so a re-rendered tree does not grow the set.
    for (const stale of buttons) {
      if (stale.isConnected === false) buttons.delete(stale);
    }
  };

  const sweep = (root: ParentNode): void => {
    for (const title of root.querySelectorAll<HTMLElement>(".nav-file-title[data-path]")) {
      decorateRow(title);
    }
  };

  /**
   * Follow one explorer as it rebuilds.
   *
   * A mutation inside a row re-decorates that row — that is what catches a row whose children
   * were replaced — and the added subtrees are inspected for rows that arrived whole.
   * `data-path` is watched as an attribute because a rename updates it in place (see
   * {@link decorateRow}). Re-querying the entire container per mutation would make scrolling a
   * large vault do quadratic DOM work.
   */
  const observe = (container: HTMLElement): void => {
    containers.add(container);
    sweep(container);
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const row = nearestRow(mutation.target);
        if (row !== null) decorateRow(row);
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          const element = node as HTMLElement;
          if (element.matches?.(".nav-file-title[data-path]")) decorateRow(element);
          for (const title of element.querySelectorAll?.<HTMLElement>(
            ".nav-file-title[data-path]",
          ) ?? []) {
            decorateRow(title);
          }
        }
      }
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-path"],
    });
    observers.push(observer);
  };

  /**
   * (Re)attach to every explorer that is open right now.
   *
   * A layout change can move or rebuild an explorer leaf, so the observers are rebuilt from
   * the containers collected so far rather than accumulated: a popout window's explorer is
   * collected once, when its window opens.
   */
  const attach = (): void => {
    for (const observer of observers.splice(0)) observer.disconnect();
    for (const leaf of app.workspace.getLeavesOfType("file-explorer")) {
      const container = (leaf.view as { containerEl?: HTMLElement } | undefined)?.containerEl;
      if (container) containers.add(container);
    }
    for (const container of containers) observe(container);
  };

  attach();
  // A plugin loads before the workspace is ready, and the explorer may not exist yet; the
  // ready pass is the one that catches a layout restored after load.
  app.workspace.onLayoutReady(() => {
    if (!disposed) attach();
  });
  const layoutRef = app.workspace.on("layout-change", () => attach());
  // A popout window has its own document; its explorer is found by the file tree's own
  // container, which is what the rows live in.
  const windowRef = app.workspace.on("window-open", (_workspaceWindow, window) => {
    if (!window?.document) return;
    for (const container of window.document.querySelectorAll<HTMLElement>(".nav-files-container")) {
      observe(container);
    }
  });

  return {
    refresh: () => {
      if (disposed) return;
      for (const container of containers) sweep(container);
    },
    dispose: () => {
      disposed = true;
      for (const observer of observers.splice(0)) observer.disconnect();
      for (const button of buttons) button.detach();
      buttons.clear();
      app.workspace.offref(layoutRef);
      app.workspace.offref(windowRef);
    },
  };
}

/**
 * Add the conflict action to one explorer title, when that path is a parked copy.
 *
 * The chip is inserted **before** the extension tag (`.nav-file-tag`), so the row reads
 * `name … [对比] PNG`: the action sits at the row's end and the tag stays the rightmost item,
 * instead of the action trailing the tag on rows that have one and following the name on rows
 * that do not. Its own `margin-left: auto` (in `styles.css`) is what pushes it there when
 * there is no tag.
 *
 * Answers the chip, or `null` when nothing was added (the path is not a parked copy, it is
 * under an excluded folder, or a chip is already there). Exported so the decoration can be
 * driven against a plain element — the explorer itself only exists in a real app.
 */
export function decorateConflictTitle(
  titleEl: HTMLElement,
  path: string,
  handlers: Pick<FileExplorerActionHandlers, "openDiff" | "openReplace">,
  excludedFolders: readonly string[] = [],
): HTMLElement | null {
  if (fileActionFor(path, excludedFolders) !== "conflict") {
    titleEl.querySelector<HTMLElement>(`.${CONFLICT_ACTION_CLASS}`)?.detach();
    return null;
  }
  const existing = existingChip(titleEl, CONFLICT_ACTION_CLASS, path);
  if (existing !== null) {
    ensureBeforeTag(titleEl, existing);
    return null;
  }

  const kind = conflictActionFor(path);
  const button = chip(titleEl, CONFLICT_ACTION_CLASS, path, conflictActionLabel(kind));
  button.setAttribute("aria-label", conflictActionTitle(kind));
  // The path is read from the row at click time, never from the closure: Obsidian reuses the
  // row element across a rename and only updates `data-path`, so a captured path would make
  // the chip act on the file that used to be there.
  attachActivation(button, () => {
    const current = titleEl.getAttribute("data-path") ?? path;
    if (conflictActionFor(current) === "diff") handlers.openDiff(current);
    else handlers.openReplace(current);
  });
  return button;
}

/**
 * Add the version-history chip to one explorer title, for every file that is not a parked
 * copy and not under an excluded folder.
 *
 * A chain is keyed by fileId, which the plugin resolves from the path on click — so this
 * decorates every row the scope keeps and lets a click say "no versions" for a file this
 * device has not synced yet. Asking the engine here instead would tie the chip's presence to
 * a host that binds asynchronously, and a row rendered before the bind would keep its
 * missing chip until the explorer happened to rebuild. A path this device excludes is
 * different: it is outside the scope, so it is not offered an action at all — even when a
 * chain from before the exclusion (or a copy parked before it) still exists on disk.
 *
 * An attachment row carries the app's extension tag (`PNG`) at the row's right end; the chip
 * is inserted before it, in the row's flow, so while it is shown the file name truncates with
 * an ellipsis in front of it instead of running underneath — see `chip` and `styles.css`.
 */
export function decorateVersionHistoryTitle(
  titleEl: HTMLElement,
  path: string,
  handlers: Pick<FileExplorerActionHandlers, "openVersionHistory">,
  excludedFolders: readonly string[] = [],
): HTMLElement | null {
  if (fileActionFor(path, excludedFolders) !== "history") {
    titleEl.querySelector<HTMLElement>(`.${VERSION_HISTORY_ACTION_CLASS}`)?.detach();
    return null;
  }
  const existing = existingChip(titleEl, VERSION_HISTORY_ACTION_CLASS, path);
  if (existing !== null) {
    ensureBeforeTag(titleEl, existing);
    return null;
  }

  const button = chip(titleEl, VERSION_HISTORY_ACTION_CLASS, path, t("explorer.versionHistory"));
  button.setAttribute("aria-label", t("explorer.versionHistory"));
  attachActivation(button, () => {
    const current = titleEl.getAttribute("data-path") ?? path;
    handlers.openVersionHistory(current);
  });
  return button;
}

/**
 * The chip this row already has for `path`, or `null` when one has to be created.
 *
 * A chip that was made for a **different** path is removed first: the row element outlives a
 * rename, so the chip has to be rebuilt with the new path rather than keep acting on the old
 * one. A chip on the same path is left alone — the decorator runs on every mutation of the
 * explorer — and its place is re-checked by {@link ensureBeforeTag}.
 */
function existingChip(titleEl: HTMLElement, className: string, path: string): HTMLElement | null {
  const existing = titleEl.querySelector<HTMLElement>(`.${className}`);
  if (existing === null) return null;
  if (existing.getAttribute("data-path") === path) return existing;
  existing.detach();
  return null;
}

/**
 * Keep the chip immediately before the row's extension tag.
 *
 * The row reads `name … [版本历史] PNG` only while the chip is the tag's previous sibling, and
 * the file name's truncation (`styles.css`) is about that place. Obsidian's own `updateTitle`
 * can rebuild the tag, which appends it after the chip; re-inserting is idempotent, so every
 * decoration pass repairs the order instead of trusting the one it established at creation.
 */
function ensureBeforeTag(titleEl: HTMLElement, button: HTMLElement): void {
  const tag = titleEl.querySelector(".nav-file-tag");
  if (tag !== null && button.nextElementSibling !== tag) titleEl.insertBefore(button, tag);
}

/**
 * One row-end chip: in the row's flow before the extension tag, when the row has one.
 *
 * Every chip in this explorer is the same shape: a `role="button"` div that stops the row's
 * own click (which would open the file), reachable from the keyboard, and drawn only on the
 * hovered/focused row (see `styles.css`). It records the path it was made for in `data-path`,
 * so {@link existingChip} can tell "already decorated" from "decorated before a rename".
 *
 * "Before the tag" is the whole point: while the chip is shown it takes layout space, so the
 * file name truncates with an ellipsis in front of it instead of running under it, and the
 * extension tag stays the row's rightmost item (`name … [版本历史] PNG`). The chip is
 * collapsed to zero width on an idle row (`styles.css`), so that truncation costs the name
 * nothing until the pointer is on the row.
 */
function chip(titleEl: HTMLElement, className: string, path: string, label: string): HTMLElement {
  const button = titleEl.createDiv({ cls: className });
  button.setText(label);
  button.setAttribute("role", "button");
  button.setAttribute("data-path", path);
  // The row itself is not a focus stop for the chip; the chip has to be one, or the focus
  // rule in `styles.css` could never match and a keyboard user could not reach the action.
  button.setAttribute("tabindex", "0");
  button.setAttribute("data-tooltip-position", "top");
  ensureBeforeTag(titleEl, button);
  return button;
}

/** Make a chip activate on click and on Enter/Space (a `role="button"` div gets neither). */
function attachActivation(button: HTMLElement, activate: () => void): void {
  button.addEventListener("click", (event) => {
    // The row's own click opens the file; the action must not do that on the way past.
    event.preventDefault();
    event.stopPropagation();
    activate();
  });
  // Space would also scroll the explorer, hence the default is cancelled for it.
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    activate();
  });
}
