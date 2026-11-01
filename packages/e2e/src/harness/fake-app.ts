import type { TFile } from "obsidian";
import { FakeVault } from "./fake-vault";
import {
  createFakeEl,
  loadLocalStorage,
  openLeaves,
  saveLocalStorage,
  WorkspaceLeaf,
  type FakeEl,
} from "./obsidian-stub";

/**
 * The slice of Obsidian's `App` the plugin touches: `app.vault` (file events +
 * adapter), `app.workspace`, and the App-level `localStorage` (`@since 1.8.7`)
 * the plugin stores its device-local vault key in. The latter forwards to the
 * stub's module-scoped store, so it survives a plugin reload the way the real
 * one survives an Obsidian restart.
 */
export interface FakeWorkspace {
  /**
   * The workspace root — real Obsidian always has one, and it is where a plugin attaches an
   * overlay that is not a `Notice` (the reload card lives here, bottom-right).
   */
  containerEl: FakeEl;
  on(event: string, cb: (...args: unknown[]) => void): { event: string; cb: unknown };
  /** Unregister a handler `on` recorded — real `Workspace.offref`, which a disposer calls. */
  offref(ref: unknown): void;
  /**
   * Test driver: dispatch a workspace event to the handlers `on` recorded — how a
   * real right-click reaches the plugin's `file-menu` registration.
   */
  emit(event: string, ...args: unknown[]): void;
  getLeavesOfType(type: string): WorkspaceLeaf[];
  /**
   * The note in the active leaf, the way the real workspace answers it.
   *
   * A view the fake hosts has no `file` field (nothing here is a markdown view), so the
   * path is read from the markdown leaf state a real layout would hold — which is also
   * where a deferred tab keeps it.
   */
  getActiveFile(): { path: string } | null;
  /** The files Obsidian remembers as recently opened, newest first. */
  getLastOpenFiles(): string[];
  /**
   * Test driver: the recently opened list the plugin's priority provider reads.
   *
   * Empty is the honest default (a test that does not care about priority), and the
   * engine still ranks by the stamps it has.
   */
  setLastOpenFiles(paths: string[]): void;
  /** Activate a leaf (recorded; a test reads `isActive`). */
  revealLeaf(leaf: WorkspaceLeaf): Promise<void>;
  getRightLeaf(split: boolean): unknown;
  /**
   * A new leaf — the comparison opens one as a `'tab'`. The fake has no layout to split, so
   * it ignores the pane argument and returns a fresh leaf. The leaf constructs its view
   * through the plugin's `registerView` factories, exactly like the app.
   */
  getLeaf(pane?: "tab" | "split" | "window" | false): WorkspaceLeaf;
  /**
   * Run `cb` once the layout is ready. The fake has no layout, so it is ready by the time a
   * test drives the plugin and the callback runs at registration — the same branch the app
   * takes when a plugin is enabled into an already-open workspace.
   */
  onLayoutReady(cb: () => void): void;
  /**
   * Bind the plugin whose `registerView` factories build the leaves' views.
   *
   * Real Obsidian knows the registrations because a plugin registers into the app; the fake
   * keeps them on the plugin instance, so a leaf needs to be told where to look.
   */
  useViewFactoriesFrom(plugin: unknown): void;
}

/**
 * Obsidian's settings modal, as the status menu reaches it.
 *
 * `app.setting` is not in Obsidian's public typings, but opening a specific plugin's tab
 * is the only way the settings row can land where it promises. Recording the calls is
 * what lets an L2 test assert the navigation instead of only the menu row.
 */
export interface FakeSettingsSurface {
  opened: number;
  tabIds: string[];
  open(): void;
  openTabById(id: string): void;
}

export interface FakeApp {
  vault: FakeVault;
  workspace: FakeWorkspace;
  setting: FakeSettingsSurface;
  /**
   * Obsidian's file manager, as far as the plugin uses it: every deletion the sync engine
   * performs goes through `trashFile`, so a fake that skipped it would let a deletion
   * silently do nothing (the app's "deleted files" preference is the point of the call).
   */
  fileManager: { trashFile(file: TFile): Promise<void> };
  loadLocalStorage(key: string): unknown;
  saveLocalStorage(key: string, data: unknown | null): void;
}

/** The path a leaf's saved layout (or its view) names, or null. */
function filePathOf(leaf: WorkspaceLeaf): string | null {
  const view = leaf.view as { file?: { path?: string } } | null;
  if (view?.file?.path) return view.file.path;
  const state = leaf.state?.state as { file?: unknown } | undefined;
  return typeof state?.file === "string" ? state.file : null;
}

/** Build the fake `App` bound to `vault`. */
export function createFakeApp(vault: FakeVault): FakeApp {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  /** The plugin's view registrations, bound by {@link useViewFactoriesFrom}. */
  let registeredViews: Map<string, (leaf: unknown) => unknown> = new Map();
  /** The recently opened list a real workspace persists in `workspace.json`. */
  let lastOpenFiles: string[] = [];
  /** Filled in before `createFakeApp` returns; a leaf hands it to the view it builds. */
  let app: FakeApp;
  const workspace: FakeWorkspace = {
    containerEl: createFakeEl(),
    on: (event, cb) => {
      const registered = handlers.get(event) ?? [];
      registered.push(cb);
      handlers.set(event, registered);
      return { event, cb };
    },
    offref: (ref) => {
      const { event, cb } = ref as { event: string; cb: (...args: unknown[]) => void };
      const registered = handlers.get(event);
      if (!registered) return;
      const index = registered.indexOf(cb);
      if (index >= 0) registered.splice(index, 1);
    },
    emit: (event, ...args) => {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    getLeavesOfType: (type) =>
      openLeaves.filter((leaf) => leaf.state?.type === type && leaf.view !== null),
    getActiveFile: () => {
      const active = openLeaves.find((leaf) => leaf.isActive);
      const path = active ? filePathOf(active) : null;
      return path === null ? null : { path };
    },
    getLastOpenFiles: () => [...lastOpenFiles],
    setLastOpenFiles: (paths) => {
      lastOpenFiles = [...paths];
    },
    revealLeaf: async (leaf) => {
      for (const other of openLeaves) other.isActive = false;
      leaf.isActive = true;
    },
    getRightLeaf: () => null,
    getLeaf: () => new WorkspaceLeaf(app, (type) => registeredViews.get(type)),
    onLayoutReady: (cb) => cb(),
    useViewFactoriesFrom: (plugin) => {
      const recorded = (plugin as { registeredViews?: Map<string, (leaf: unknown) => unknown> })
        .registeredViews;
      registeredViews = recorded ?? new Map();
    },
  };
  const setting: FakeSettingsSurface = {
    opened: 0,
    tabIds: [],
    open() {
      setting.opened++;
    },
    openTabById(id) {
      setting.tabIds.push(id);
    },
  };
  return (app = {
    vault,
    workspace,
    setting,
    // The vault is the trash in this harness: there is no system recycle bin to move to,
    // and a deletion has to reach the file map for the suite to observe it.
    fileManager: { trashFile: (file: TFile) => vault.delete(file) },
    loadLocalStorage,
    saveLocalStorage,
  });
}
