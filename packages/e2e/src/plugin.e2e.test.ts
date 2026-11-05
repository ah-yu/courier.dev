import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, PluginManifest } from "obsidian";
import CourierPlugin, { buildActions } from "../../plugin/src/main";
import { DEFAULT_SETTINGS, type CourierSettings } from "../../plugin/src/shared/settings";
import {
  DEFAULT_FILE_TYPES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_OP_QUEUE_LIMITS,
  deriveEncryptionKey,
  FILE_TYPE_GROUPS,
  isConflictFile,
  NO_SETTINGS_GROUPS,
  OBSIDIAN_DEFAULT_GROUPS,
  SETTINGS_GROUPS,
  sha256Hex,
} from "../../engine/src/index";
import type { FileTypeGroup, FileTypeSync, SettingsGroup } from "../../engine/src/index";
import {
  Menu,
  Platform,
  Setting,
  TFile,
  buttonsIn,
  clickModalButton,
  createFakeEl,
  elementsWithClass,
  ExtraButtonComponent,
  lastOpenedMenu,
  lastOpenedModal,
  loadLocalStorage,
  markdownRenders,
  modalTexts,
  modalToggles,
  notices,
  openedMenus,
  openedModals,
  recordedSurface,
  resetStubState,
  setLocalStorage,
  setStubLanguage,
  type MenuItem,
  type Modal,
  type FakeEl,
  type SettingDefinitionItem,
} from "./harness/obsidian-stub";
import { VAULT_CREDENTIAL_KEY } from "../../plugin/src/shared/credential-store";
import { RELOAD_POPUP_CLASS } from "../../plugin/src/shared/settings-reload-popup";
import { keyExpiryText } from "../../plugin/src/shared/account-status";
import { getSyncLog } from "../../plugin/src/shared/sync-log";
import { t } from "../../plugin/src/i18n";
import { MAX_HISTORY_LIMIT } from "../../shared/src/index";
import { PasswordPromptModal } from "../../plugin/src/ui/dialogs/password-prompt-modal";
import { SetupConnectionModal } from "../../plugin/src/ui/dialogs/setup-connection-modal";
import {
  VaultPickerModal,
  type VaultPickerHost,
} from "../../plugin/src/ui/dialogs/vault-picker-modal";
import { FakeVault } from "./harness/fake-vault";
import { createFakeApp, type FakeApp } from "./harness/fake-app";
import {
  installFetchTransport,
  requestsMatching,
  resetRecordedRequests,
} from "./harness/plugin-transport";
import {
  startTestServer,
  patchTestUser,
  setUserMaxFileBytes,
  type TestServer,
} from "./harness/server";
import {
  createTestVault,
  makeVaultMaterial,
  type TestVault,
  type VaultMaterial,
} from "./harness/vault";
import { createTestClient, type CreateClientOptions, type TestClient } from "./harness/client";
import { conflictCopyOf } from "./harness/conflict";
import {
  CONFLICT_DIFF_VIEW_TYPE,
  parseConflictDiffState,
  type ConflictDiffView,
} from "../../plugin/src/ui/conflict-diff-view";
import {
  VERSION_HISTORY_VIEW_TYPE,
  type VersionHistoryView,
} from "../../plugin/src/ui/version-history-view";
import {
  deletedFiles,
  fileVersions,
  filesAtPath,
  pushVersion,
  updateVaultSettings,
  vaultHistory,
  vaultSettings,
} from "./harness/api";
import { waitFor, waitForAsync } from "./harness/wait";
import {
  CONFLICT_ACTION_CLASS,
  VERSION_HISTORY_ACTION_CLASS,
  decorateConflictTitle,
  decorateVersionHistoryTitle,
} from "../../plugin/src/ui/file-explorer-actions";

/**
 * Plugin-level end-to-end: the **real** `CourierPlugin` class, driven through
 * its real lifecycle against the real server.
 *
 * `obsidian` is aliased to a runtime stub (the npm package ships types only),
 * which makes the two previously manual-only surfaces testable:
 *   - the `requestUrl` wiring in `main.ts`, and
 *   - the plugin → engine → server path, including the notice a resolved conflict
 *     produces and the recycle bin's restore-as behaviour.
 *
 * Conflict *behaviour* is covered end-to-end in `sync.e2e.test.ts`; here it is the
 * plugin's own wiring around it that is asserted.
 *
 * Still manual by design: anything needing Obsidian's real UI or a real mobile
 * runtime (see `docs/testing.md`).
 */

/**
 * The engine a bound plugin is running with — the host (and its engine) exist once
 * a bind has succeeded, so a failure here is the test's own setup being wrong.
 */
function engineOf(plugin: CourierPlugin) {
  expect(plugin.host).not.toBeNull();
  return plugin.host!.engine!;
}

// ── Version-history readers (its tab lists one row per version, newest first) ──

/** The version rows of an open history tab, in render order (newest first). */
function versionRows(view: VersionHistoryView): FakeEl[] {
  return elementsWithClass(viewContent(view), "courier-vh-version");
}

/** The action each row names (`修改`), in render order. */
function versionActions(view: VersionHistoryView): string[] {
  return elementsWithClass(viewContent(view), "courier-vh-action").map((element) => element.text);
}

/** The clock reading each row leads with, in render order. */
function versionTimes(view: VersionHistoryView): string[] {
  return elementsWithClass(viewContent(view), "courier-vh-time").map((element) => element.text);
}

/**
 * The old-path lines the list shows.
 *
 * A row prints a path only when that version was written somewhere other than where the
 * chain lives now (the live path is the tab's own title), so this answers "which rows are
 * renames", not "what does every row say".
 */
function versionOldPaths(view: VersionHistoryView): string[] {
  return elementsWithClass(viewContent(view), "courier-vh-path").map((element) => element.text);
}

/** The row the reading pane is showing, as the one carrying the selection class. */
function selectedVersionRow(view: VersionHistoryView): FakeEl | undefined {
  return versionRows(view).find((row) => row.classes.includes("is-selected"));
}

/** The reading pane's text, whichever presentation is showing. */
function paneText(view: VersionHistoryView): string {
  const body = elementsWithClass(viewContent(view), "courier-vh-pane-body")[0];
  return body ? allText(body).join(" ") : "";
}

/** Every piece of text in a fake DOM tree, for the "what did it render" assertions. */
function allText(root: FakeEl): string[] {
  const out: string[] = [];
  const walk = (element: FakeEl): void => {
    if (element.text) out.push(element.text);
    for (const child of element.children) walk(child);
  };
  walk(root);
  return out;
}

// ── Sync-history readers (its dialog lists one row per event) ──

/** The log's rows, newest day last, each row in the order it renders. */
function historyRows(modal: Modal): FakeEl[] {
  return elementsWithClass(modal.contentEl, "courier-history-row");
}

/** The direction arrow each row leads with: the icon id, and the class carrying the colour. */
function historyArrows(modal: Modal): Array<{ icon?: string; direction: string }> {
  return elementsWithClass(modal.contentEl, "courier-history-arrow").map((element) => ({
    icon: element.icon,
    direction: element.classes.includes("is-out") ? "out" : "in",
  }));
}

/** The rows that name `path`, in render order (oldest first: the newest day is at the end). */
function historyRowsFor(modal: Modal, path: string): FakeEl[] {
  return historyRows(modal).filter(
    (row) => elementsWithClass(row, "courier-history-path")[0]?.text === path,
  );
}

/** The first row that names `path`, or undefined. */
function historyRowFor(modal: Modal, path: string): FakeEl | undefined {
  return historyRowsFor(modal, path)[0];
}

/** The "not applied / not sent" line a skipped row carries, or undefined for an applied one. */
function historyOutcomeOf(modal: Modal, path: string): string | undefined {
  const row = historyRowFor(modal, path);
  return row ? elementsWithClass(row, "courier-history-outcome")[0]?.text : undefined;
}

/** The path each row shows, in render order. */
function historyPaths(modal: Modal): string[] {
  return elementsWithClass(modal.contentEl, "courier-history-path").map((element) => element.text);
}

/**
 * The header's count as a number.
 *
 * `formatCount` follows the UI language, so the rendered text is `1,024` rather than
 * `1024` once a vault passes four digits — a test that called `Number()` on the raw text
 * would read `NaN` there.
 */
function historyCount(modal: Modal): number {
  const text = elementsWithClass(modal.contentEl, "courier-history-count")[0]?.text ?? "";
  return Number(text.replace(/,/g, ""));
}

/**
 * The reload cards on screen, read from the workspace container the plugin attaches them to.
 *
 * The card is not a `Notice`: it is an element of the plugin's own, styled as a bottom-right
 * card on desktop and a bottom sheet on a phone (Obsidian's notice container is anchored
 * top-right), so the way to find it is its class, and the way to read it is the text inside it.
 */
function reloadCards(plugin: { app: unknown }): FakeEl[] {
  const workspace = (plugin.app as { workspace: { containerEl: FakeEl } }).workspace;
  return elementsWithClass(workspace.containerEl, RELOAD_POPUP_CLASS);
}

/** Press the button labelled `label` anywhere in the tree (the card's actions). */
function clickLabelled(root: FakeEl, label: string): void {
  const find = (element: FakeEl): FakeEl | undefined => {
    if (element.tagName === "button" && element.text === label) return element;
    for (const child of element.children) {
      const found = find(child);
      if (found) return found;
    }
    return undefined;
  };
  const button = find(root);
  if (!button) {
    throw new Error(`no "${label}" button in ${JSON.stringify(allText(root))}`);
  }
  button.click();
}

/** Every info/refresh icon in the subtree, whether it came from a `Setting` row or not. */
function extraButtonsIn(root: FakeEl): ExtraButtonComponent[] {
  const found: ExtraButtonComponent[] = [];
  const walk = (element: FakeEl): void => {
    for (const item of element.attached) {
      if (item instanceof Setting) found.push(...item.extraButtons);
      else if (item instanceof ExtraButtonComponent) found.push(item);
    }
    for (const child of element.children) walk(child);
  };
  walk(root);
  return found;
}

/** Every settings row in the current subtree, with the name/desc it was given. */
function settingsIn(root: FakeEl): Setting[] {
  const found: Setting[] = [];
  const walk = (element: FakeEl): void => {
    for (const item of element.attached) {
      if (item instanceof Setting) found.push(item);
    }
    for (const child of element.children) walk(child);
  };
  walk(root);
  return found;
}

/** The settings tab the plugin registered on load, with the container it renders into. */
function settingsTabOf(plugin: CourierPlugin): {
  containerEl: FakeEl;
  display(): void;
  getSettingDefinitions(): SettingDefinitionItem[];
} {
  const tab = recordedSurface(plugin).settingTabs[0] as unknown as {
    containerEl: FakeEl;
    display(): void;
    getSettingDefinitions(): SettingDefinitionItem[];
  };
  if (!tab?.containerEl) throw new Error("the plugin registered no settings tab");
  return tab;
}

/** The names the settings tab declares for the step it is on (the app keys items by them). */
function definitionNames(tab: { getSettingDefinitions(): Array<{ name?: string }> }): string[] {
  return tab.getSettingDefinitions().map((item) => item.name ?? "");
}

/** The plugin's single status-bar item (it is created once, in `onload`). */
function statusBarItem(plugin: CourierPlugin): FakeEl {
  const items = recordedSurface(plugin).statusBarItems;
  expect(items).toHaveLength(1);
  return items[0]!;
}

/** Open the status menu the way a click does, and return the menu it constructed. */
async function openStatusMenu(item: FakeEl): Promise<Menu> {
  const before = openedMenus.length;
  item.click();
  await waitFor(() => openedMenus.length > before, "the status-bar click never opened a menu");
  const menu = lastOpenedMenu();
  if (!menu) throw new Error("the status menu was recorded without a menu");
  return menu;
}

/** Open the status menu the way the keyboard does (Enter/Space on the item). */
async function openStatusMenuWithKeyboard(item: FakeEl): Promise<Menu> {
  const before = openedMenus.length;
  for (const listener of item.listeners.keydown ?? []) {
    listener({ key: "Enter", preventDefault() {} });
  }
  await waitFor(() => openedMenus.length > before, "Enter on the status bar opened no menu");
  const menu = lastOpenedMenu();
  if (!menu) throw new Error("the status menu was recorded without a menu");
  return menu;
}

/** The labels a menu carries, in order. */
function menuTitles(menu: Menu): string[] {
  return menu.items.map((item) => item.title);
}

/** Press the button with this label on the settings page. */
function clickSettingsButton(plugin: CourierPlugin, label: string): void {
  const tab = settingsTabOf(plugin);
  const button = buttonsIn(tab.containerEl).find((candidate) => candidate.text === label);
  if (!button) {
    const available = buttonsIn(tab.containerEl)
      .map((candidate) => candidate.text)
      .join(", ");
    throw new Error(`No settings button labelled "${label}" (have: ${available})`);
  }
  button.click();
}

/**
 * Open the settings page's vault picker — the vault row's 选择 button — and return
 * the dialog. Every vault-management step starts here: the page itself is one row.
 */
function openVaultPicker(plugin: CourierPlugin): Modal {
  clickSettingsButton(plugin, "选择");
  const modal = lastOpenedModal();
  if (!modal || modal.title !== "选择远程库") {
    throw new Error(`the vault picker never opened (got "${modal?.title ?? "nothing"}")`);
  }
  return modal;
}

/** The picker's row for one vault (the list is read asynchronously). */
function vaultRowIn(picker: Modal, vaultName: string): Setting {
  const row = settingsIn(picker.contentEl).find((setting) => setting.name === vaultName);
  if (!row) {
    const listed = settingsIn(picker.contentEl)
      .map((setting) => setting.name)
      .filter(Boolean)
      .join(", ");
    throw new Error(`no row for "${vaultName}" in the vault picker (have: ${listed})`);
  }
  return row;
}

/** Open the picker and wait until it lists `vaultName`. */
async function openVaultPickerWith(plugin: CourierPlugin, vaultName: string): Promise<Modal> {
  const picker = openVaultPicker(plugin);
  await waitFor(
    () => settingsIn(picker.contentEl).some((setting) => setting.name === vaultName),
    `the vault picker never listed "${vaultName}"`,
  );
  return picker;
}

/** A picker host whose list read is the one a state test supplies. */
function pickerHostWith(listVaults: VaultPickerHost["actions"]["listVaults"]): VaultPickerHost {
  return {
    actions: { listVaults },
    connectToVault: async () => ({ ok: false, error: "not used" }),
    getConnectionSetup: () => ({
      configured: false,
      deviceName: "My Device",
      excludedFolders: [],
    }),
    deleteVault: async () => ({ ok: false, error: "not used" }),
    fetchVaultCredentials: async () => ({ kind: "invalid-password" }),
    createVault: async () => ({ ok: false, error: "not used" }),
  };
}

/** Open a picker over a fake host, for the states that need no real account. */
function openPickerWithHost(host: VaultPickerHost): VaultPickerModal {
  const picker = new VaultPickerModal(createFakeApp(new FakeVault()) as unknown as App, host);
  picker.open();
  return picker;
}

/**
 * Press a control on one vault's row inside the picker, by its label: a text button
 * (`连接`) or an icon button's tooltip (`重命名` / `删除`).
 */
function clickVaultRowButton(picker: Modal, vaultName: string, label: string): void {
  const row = vaultRowIn(picker, vaultName);
  const button = row.buttons.find((candidate) => candidate.text === label);
  if (button) {
    button.click();
    return;
  }
  const icon = row.extraButtons.find((candidate) => candidate.tooltip === label);
  if (icon) {
    icon.click();
    return;
  }
  const available = [
    ...row.buttons.map((candidate) => candidate.text),
    ...row.extraButtons.map((candidate) => candidate.tooltip),
  ].join(", ");
  throw new Error(`the "${vaultName}" row has no "${label}" control (have: ${available})`);
}

/**
 * Press a raw button the setup dialog built (its actions are plain `<button>`s, not
 * `ButtonComponent`s, so `buttonsIn` cannot reach them).
 */
function clickSetupButton(modal: Modal, cls: string, label: string): void {
  const button = elementsWithClass(modal.contentEl, cls)[0];
  if (!button) {
    throw new Error(
      `the setup dialog has no "${label}" button (${JSON.stringify(allText(modal.contentEl))})`,
    );
  }
  button.click();
}

/** The setup dialog's primary action. */
function clickStartSyncing(modal: Modal): void {
  clickSetupButton(modal, "courier-setup-start", "开始同步");
}

/** The setup dialog's way into the folder tree. */
function clickManageFolders(modal: Modal): void {
  clickSetupButton(modal, "courier-setup-manage", "管理");
}

/** Anything a row says cannot be viewed. */
function versionWarnings(view: VersionHistoryView): string[] {
  return elementsWithClass(viewContent(view), "courier-vh-warning").map((element) => element.text);
}

/** The row whose action is `action` (the first one, when several share it). */
function versionRowFor(view: VersionHistoryView, action: string): FakeEl {
  const row = versionRows(view).find(
    (element) => elementsWithClass(element, "courier-vh-action")[0]?.text === action,
  );
  if (!row) {
    throw new Error(`no version row for ${action} (have: ${versionActions(view).join(", ")})`);
  }
  return row;
}

// ── Plugin-state, dialog and fixture readers shared across describes ──

/** The fileId the engine tracks for a path, once it tracks it. */
async function trackedFileId(plugin: CourierPlugin, path: string): Promise<string> {
  await waitFor(
    () => plugin.engine?.fileIdForPath(path) != null,
    `the engine never tracked ${path}`,
  );
  return plugin.engine!.fileIdForPath(path)!;
}

/**
 * The paths the plugin's *persisted* sync state records — what a restart reads
 * back. Written by the engine at the end of an operation, so it can trail the
 * vault bytes it was derived from.
 */
function persistedPaths(plugin: CourierPlugin): string[] {
  return Object.values(plugin.settings.syncState?.localVersions ?? {}).map(
    (entry) => entry.plainPath,
  );
}

/** The setup dialog's two text fields: password first, device label second. */
function setupFields(modal: Modal): {
  password: ReturnType<typeof modalTexts>[number];
  deviceName: ReturnType<typeof modalTexts>[number];
} {
  const texts = modalTexts(modal);
  expect(texts.length, "the setup dialog should offer a password and a device name").toBe(2);
  return { password: texts[0]!, deviceName: texts[1]! };
}

/**
 * The error slot under the setup dialog's password input.
 *
 * It lives inside the row rather than on the dialog's content element, and the stub keeps a
 * `Setting`'s own `settingEl` out of the content tree (the real app appends it) — so this
 * reads through the row, the way the input itself is reached.
 */
function setupPasswordError(modal: Modal): FakeEl | undefined {
  const row = settingsIn(modal.contentEl).find((setting) => setting.name === "库密码");
  return row ? elementsWithClass(row.settingEl, "courier-setup-field-error")[0] : undefined;
}

/** Press the tree's 完成. */
function pressTreeDone(tree: Modal): void {
  const done = elementsWithClass(tree.contentEl, "courier-excluded-folders-done")[0];
  if (!done) throw new Error("the folder tree has no Done button");
  done.click();
}

/** Read the stored record for a vault, failing loudly when there is none. */
function recordOf(plugin: CourierPlugin, vaultId: string) {
  const record = plugin.settings.vaultConnections[vaultId];
  if (!record) throw new Error(`no connection record for ${vaultId}`);
  return record;
}

// ── Recycle-bin dialog readers ──

/** The deleted paths the dialog renders (it decrypts them with the vault key). */
function listedDeletedPaths(modal: Modal): string[] {
  return elementsWithClass(modal.contentEl, "courier-deleted-path").map((element) => element.text);
}

/** The per-row warnings the dialog renders for rows it cannot restore as-is. */
function listedWarnings(modal: Modal): string[] {
  return elementsWithClass(modal.contentEl, "courier-deleted-warning").map(
    (element) => element.text,
  );
}

/** The dialog's 恢复 button for one listed file, or a loud failure. */
function restoreButton(modal: Modal, path: string) {
  const row = elementsWithClass(modal.contentEl, "courier-deleted-file-item").find((element) =>
    elementsWithClass(element, "courier-deleted-path").some((el) => el.text === path),
  );
  if (!row) throw new Error(`no recycle-bin row for ${path}`);
  const button = buttonsIn(row).find((candidate) => candidate.text === "恢复");
  if (!button) {
    const labels = buttonsIn(row)
      .map((candidate) => candidate.text)
      .join(", ");
    throw new Error(`no 恢复 button in the recycle-bin row for ${path} (have: ${labels})`);
  }
  return button;
}

/** The deleted version's row content: the whole line a click opens the preview from. */
function clickDeletedFile(modal: Modal, path: string): void {
  const row = elementsWithClass(modal.contentEl, "courier-deleted-file-item").find((element) =>
    elementsWithClass(element, "courier-deleted-path").some((el) => el.text === path),
  );
  if (!row) throw new Error(`no recycle-bin row for ${path}`);
  const info = elementsWithClass(row, "courier-deleted-info")[0];
  if (!info) throw new Error(`the recycle-bin row for ${path} has no clickable info area`);
  info.click();
}

/** The prose an opened modal shows (the stub records `text` on its child elements). */
function modalParagraphs(modal: Modal): string[] {
  return modal.contentEl.children.map((child) => child.text).filter(Boolean);
}

/**
 * Run an action that opens a modal and return **that** modal. `lastOpenedModal`
 * is not enough here: a bound plugin leaves the load-time password prompt in the
 * stub's list, since the harness starts the host directly instead of answering it.
 */
async function modalOpenedBy(action: () => void, message: string): Promise<Modal> {
  const before = openedModals.length;
  action();
  await waitFor(() => openedModals.length > before, message);
  return openedModals.at(-1)!;
}

// ── Conflict-copy readers ──

/** The text one side of a diff row shows. */
function sideText(row: FakeEl, side: "left" | "right"): string {
  const cell = elementsWithClass(row, `courier-diff-${side}`)[0];
  return cell ? (elementsWithClass(cell, "courier-diff-text")[0]?.text ?? "") : "";
}

/** The comparison tabs currently in the fake workspace, in tab order. */
function diffLeaves(app: FakeApp) {
  return app.workspace.getLeavesOfType(CONFLICT_DIFF_VIEW_TYPE);
}

/** A view's content element as the fixture DOM the stub records (real type: `HTMLElement`). */
function viewContent(view: ConflictDiffView | VersionHistoryView): FakeEl {
  return view.contentEl as unknown as FakeEl;
}

/**
 * The bytes of a vault path, read through the data adapter — the path-based accessor,
 * so the assertion compares raw bytes rather than a UTF-8 decoding.
 */
async function bytesAt(vault: FakeVault, path: string): Promise<Uint8Array> {
  if (!vault.has(path)) throw new Error(`no vault file at ${path}`);
  return new Uint8Array(await vault.adapter.readBinary(path));
}

/** The plugin's file-menu entry for one path, exactly as a right-click builds it. */
function menuEntryFor(app: FakeApp, path: string, title: string): MenuItem {
  const menu = new Menu();
  const file = new TFile();
  file.path = path;
  file.name = path.split("/").pop() ?? path;
  app.workspace.emit("file-menu", menu, file);

  const entry = menu.items.find((item) => item.title === title);
  if (!entry) {
    const titles = menu.items.map((item) => item.title).join(", ");
    throw new Error(`no "${title}" entry in the file menu (have: ${titles})`);
  }
  return entry;
}

/** A fresh title element for the conflict-decorating cases. */
const makeTitle = () => createFakeEl("div") as unknown as HTMLElement;

/** The fixture DOM behind an `HTMLElement` the decorator returns. */
const asFake = (element: HTMLElement) => element as unknown as FakeEl;

// ── Payload, settings and tree readers ──

/** A PNG-shaped payload: bytes a text round-trip would not survive. */
function png(seed: number): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, seed, 0xff, 0xfe, 0x80]);
}

/**
 * A payload no text round-trip would survive, `length` bytes long.
 *
 * The same shape the attachment cases use: a byte asserted on both ends is the only
 * way to tell "the file travelled" from "something decodable arrived".
 */
function attachmentBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) bytes[index] = (seed * 31 + index) % 251;
  return bytes;
}

/** The settings the plugin persisted — what a restart would read back. */
async function persistedSettings(plugin: CourierPlugin): Promise<CourierSettings> {
  return (await plugin.loadData()) as CourierSettings;
}

/** The conflict copies parked in the plugin's vault — the trace a conflict leaves. */
function parkedConflictCopies(vault: FakeVault): string[] {
  return vault.paths().filter((path) => isConflictFile(path));
}

/** The live tree's rows (not the separate deleted-folders section). */
const treeRows = (modal: Modal): FakeEl[] =>
  elementsWithClass(
    elementsWithClass(modal.contentEl, "courier-excluded-folders-tree")[0]!,
    "courier-excluded-folder-row",
  );

// ── Settings-tab login helpers ──

/** The login form's two plain inputs (server URL, user key), in render order. */
function loginInputs(tab: { containerEl: FakeEl }): { server: FakeEl; key: FakeEl } {
  const inputs = elementsWithClass(tab.containerEl, "courier-login-input");
  if (inputs.length < 2) {
    throw new Error(`the login form rendered ${inputs.length} input(s), expected 2`);
  }
  return { server: inputs[0]!, key: inputs[1]! };
}

/** Type into a plain DOM input: set the value, then fire what the page listens for. */
function typeInto(input: FakeEl, value: string): void {
  (input as unknown as { value: string }).value = value;
  for (const listener of input.listeners["input"] ?? []) listener({});
}

/** Press a plain DOM control by class (the form's submit is not a `ButtonComponent`). */
function clickControl(root: FakeEl, cls: string): void {
  const control = elementsWithClass(root, cls)[0];
  if (!control) throw new Error(`no element with class "${cls}"`);
  control.click();
}

/** The action label one sync-history row carries (`修改`, `创建`, …), or undefined. */
const actionOf = (row: FakeEl): string | undefined =>
  elementsWithClass(row, "courier-history-action")[0]?.text;

// ── Status-bar fixtures ──

/**
 * Make the vault's lease look like a live CLI process owns it, so this host may only
 * wait. The record names no machine: a pid proves nothing across machines, so the
 * engine falls back to the expiry alone when the record does not name one.
 */
async function holdCliLease(vault: FakeVault): Promise<void> {
  const now = Date.now();
  await vault.adapter.write(
    ".courier/sync-lease/owner.json",
    JSON.stringify({
      version: 1,
      owner: "cli",
      token: "cli-token",
      pid: (globalThis as { process?: { pid?: number } }).process?.pid ?? 0,
      acquiredAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      expiresAt: now + 60_000,
    }),
  );
}

const MANIFEST = {
  id: "courier",
  name: "Courier",
  version: "0.0.0",
  minAppVersion: "1.0.0",
  author: "Courier",
  description: "e2e manifest",
} satisfies PluginManifest;

interface HostedPlugin {
  plugin: CourierPlugin;
  vault: FakeVault;
  remote: TestVault;
  app: FakeApp;
}

describe("plugin e2e — the real plugin against a real server", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let plugins: CourierPlugin[] = [];
  let peers: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer("plugin e2e user");
    material = await makeVaultMaterial();
  }, 120_000);

  beforeEach(() => {
    resetRecordedRequests();
    resetStubState();
    installFetchTransport();
    Platform.isDesktop = true;
    Platform.isMobile = false;
    Platform.isPhone = false;
    Platform.isTablet = false;
  });

  afterEach(() => {
    for (const plugin of plugins) plugin.onunload();
    plugins = [];
    for (const peer of peers) peer.cleanup();
    peers = [];
  });

  afterAll(async () => {
    await server.close();
  });

  /** Build the plugin against a fake app, seed settings **before** onload, then load it. */
  async function loadPlugin(options: {
    vault: FakeVault;
    settings?: Partial<CourierSettings>;
  }): Promise<{ plugin: CourierPlugin; app: FakeApp }> {
    const app = createFakeApp(options.vault);
    const plugin = new CourierPlugin(app as unknown as App, MANIFEST);
    await plugin.saveData({
      ...DEFAULT_SETTINGS,
      serverUrl: server.serverUrl,
      userKey: server.userKey,
      ...options.settings,
    });
    await plugin.onload();
    // The real app learns a plugin's view factories when the plugin registers them; the fake
    // keeps them on the plugin instance, so its leaves have to be told where to look.
    app.workspace.useViewFactoriesFrom(plugin);
    plugins.push(plugin);
    return { plugin, app };
  }

  /** Load the plugin bound to a fresh vault and start its sync host. */
  async function startHostedPlugin(
    vaultName: string,
    seed?: (vault: FakeVault) => Promise<void>,
    settings?: Partial<CourierSettings>,
  ): Promise<HostedPlugin> {
    const vault = new FakeVault();
    if (seed) await seed(vault);
    const remote = await createTestVault(server, vaultName, material);
    const { plugin, app } = await loadPlugin({
      vault,
      settings: {
        connectedVaultId: remote.id,
        connectedVaultName: remote.name,
        ...settings,
      },
    });
    plugin.encryptionKey = material.key;
    await plugin.startHost();
    return { plugin, vault, remote, app };
  }

  /**
   * Every config-folder group on — the "sync all settings" peer these cases use
   * when the plugin's own scope is not what is under test.
   */
  const ALL_SETTINGS_GROUPS = {
    ...OBSIDIAN_DEFAULT_GROUPS,
    communityPluginList: true,
    communityPlugins: true,
    otherFiles: true,
  };

  /**
   * A headless peer syncing the same remote vault.
   *
   * The options are `createTestClient`'s own, minus the four this helper supplies — a case
   * that needs a peer with a wider scope (the "everything peer" the out-of-scope history
   * case uses) states it here rather than building the client by hand.
   */
  async function newPeer(
    vaultId: string,
    deviceName = "peer",
    options: Omit<CreateClientOptions, "server" | "vaultId" | "key" | "deviceName"> = {},
  ): Promise<TestClient> {
    const peer = await createTestClient({
      server,
      vaultId,
      key: material.key,
      deviceName,
      ...options,
    });
    peers.push(peer);
    return peer;
  }

  /**
   * Open the plugin's recycle bin the way a user does: the settings page's 回收站 row,
   * whose 「查看」 button opens the dialog.
   *
   * The page is rendered through the real settings tab the plugin registered, so the row,
   * its button and the dialog it opens are all the wiring under test — the recycle bin has
   * no ribbon icon, no sidebar view and no command left to reach it by.
   */
  async function openRecycleBin(plugin: CourierPlugin): Promise<Modal> {
    const tab = settingsTabOf(plugin);
    tab.display();
    const row = settingsIn(tab.containerEl).find((candidate) => candidate.name === "回收站");
    if (!row) throw new Error("the settings page has no 回收站 row");
    const button = row.buttons.find((candidate) => candidate.text === "查看");
    if (!button) {
      const labels = row.buttons.map((candidate) => candidate.text).join(", ");
      throw new Error(`the 回收站 row has no 查看 button (have: ${labels})`);
    }

    const before = openedModals.length;
    button.click();
    await waitFor(
      () => openedModals.length > before,
      "the recycle-bin dialog never opened from the settings page",
    );
    return lastOpenedModal()!;
  }

  /** Press the dialog's 恢复 button for one listed file, the way a user does. */
  function clickRestore(modal: Modal, path: string): void {
    restoreButton(modal, path).click();
  }

  /**
   * Open the plugin's version history for a path, the way the file explorer's chip and the
   * phone's context-menu item both do — `openVersionHistory` is the one entry point they call.
   *
   * The list renders asynchronously: it awaits each version's decrypted path while building
   * the rows, so a row exists before the next one does. Wait for the render to settle — at
   * least one row, and the row count unchanged across a poll — rather than for *a* row.
   */
  async function openVersionHistory(
    plugin: CourierPlugin,
    path: string,
  ): Promise<VersionHistoryView> {
    const leaf = await plugin.openVersionHistoryPath(path);
    if (!leaf) throw new Error(`the version history for ${path} never opened`);
    const view = leaf.view as unknown as VersionHistoryView;

    let lastRows = -1;
    await waitFor(() => {
      const rows = versionRows(view).length;
      const settled = rows > 0 && rows === lastRows && selectedVersionRow(view) !== undefined;
      lastRows = rows;
      return settled;
    }, "the version-history view never finished rendering its versions");
    return view;
  }

  it("registers its settings tab and its comparison view on load, and nothing else", async () => {
    const { plugin } = await loadPlugin({ vault: new FakeVault() });
    const surface = recordedSurface(plugin);

    // One settings tab, and that is the whole entry point: the recycle bin used to be a
    // ribbon icon with its own sidebar view and command, and the settings page is where a
    // user looks for it instead. The views are the conflict comparison and the version history, both main-area tabs
    // — registered unconditionally so a layout saved with one on disk restores it.
    expect(surface.settingTabs).toHaveLength(1);
    expect([...surface.registeredViews.keys()]).toEqual([
      CONFLICT_DIFF_VIEW_TYPE,
      VERSION_HISTORY_VIEW_TYPE,
    ]);
    expect(surface.registeredCommands).toEqual([]);
    expect(surface.ribbonIcons).toEqual([]);
    // Not bound to a vault yet, so no engine should be running.
    expect(plugin.host).toBeNull();
    expect(plugin.wsState).toBe("disconnected");
  });

  it("renders English when Obsidian's UI language is not Chinese", async () => {
    setStubLanguage("en");
    const { plugin } = await loadPlugin({
      vault: new FakeVault(),
      settings: { userKey: null },
    });
    const tab = settingsTabOf(plugin);
    tab.display();

    const texts = allText(tab.containerEl);
    expect(texts).toEqual(expect.arrayContaining(["Server address", "User key", "Sign in"]));
    // The catalog is not mixed: no Chinese label leaked into the English page.
    expect(texts.join(" ")).not.toMatch(/[\u4e00-\u9fff]/);
  });

  it("wires every requestUrl action to the real REST contract", async () => {
    const settings: CourierSettings = {
      ...DEFAULT_SETTINGS,
      serverUrl: server.serverUrl,
      userKey: server.userKey,
    };
    const actions = buildActions({
      getSettings: () => settings,
      getUserKey: () => settings.userKey,
    });

    // ── Vaults ──
    const created = await actions.createVault("Action Vault", material.salt, material.keyCheck);
    expect(created.id).toBeTruthy();

    const createRequest = requestsMatching(/\/api\/vaults$/).find(
      (request) => request.method === "POST",
    )!;
    expect(createRequest.method).toBe("POST");
    expect(createRequest.headers.Authorization).toBe(`Bearer ${server.userKey}`);
    expect(JSON.parse(createRequest.body as string)).toEqual({
      name: "Action Vault",
      encryptionSalt: material.salt,
      keyCheck: material.keyCheck,
    });

    expect((await actions.listVaults()).vaults.map((vault) => vault.id)).toContain(created.id);

    // Public crypto material is fetched without an auth header.
    await expect(actions.getEncryptionSalt(created.id)).resolves.toEqual({
      encryptionSalt: material.salt,
    });
    await expect(actions.getKeyCheck(created.id)).resolves.toEqual({
      keyCheck: material.keyCheck,
    });

    // ── The SyncApi the engine actually uses ──
    // The push contract wants a 64-hex SHA-256 — it is also the blob store's path
    // component — so this fixture states a real one.
    const pushedHash = "a".repeat(64);
    const api = actions.buildSyncApi(server.userKey);
    const pushResult = await api.push(created.id, [
      {
        fileId: "file-from-action",
        encryptedPath: "encrypted-path",
        // `iv(12) ‖ plaintext(4) ‖ tag(16)`, so the row's plaintext size is 4.
        content: new Uint8Array(32),
        action: "create",
        versionId: "version-from-action",
        contentHash: pushedHash,
        sizeBytes: 4,
        mtimeMs: 0,
        // A brand-new fileId: the push is decided from "no chain yet".
        baseVersionId: null,
        historyKind: "documents",
      },
    ]);
    expect(pushResult.results[0].status).toBe("ok");
    // The label the plugin states for itself rides in the push frame, not in a header.
    const pushBody = new Uint8Array(requestsMatching(/\/sync\/push$/)[0].body as ArrayBuffer);
    const headerLength = new DataView(pushBody.buffer).getUint32(0, true);
    const frameHeader = JSON.parse(
      new TextDecoder().decode(pushBody.subarray(4, 4 + headerLength)),
    ) as { deviceName?: string };
    expect(frameHeader.deviceName).toBe(settings.deviceName);

    const index = await api.getVaultSyncIndex(created.id);
    expect(index.files.map((file) => file.fileId)).toContain("file-from-action");

    const pulled = await api.pull(created.id, ["file-from-action"]);
    expect(pulled.files[0].versions).toHaveLength(1);

    // The content route answers the stored ciphertext itself, as bytes.
    await expect(api.getVersionContent(created.id, pushedHash)).resolves.toEqual(
      new Uint8Array(32),
    );

    // The history helpers the panels use. The vault-wide history endpoint is no longer
    // one of them: the sync-history dialog is the run's in-memory log.
    expect(
      (await actions.getFileVersionHistory(created.id, "file-from-action")).versions,
    ).toHaveLength(1);
    await expect(actions.listDeleted(created.id)).resolves.toEqual({ files: [] });

    // ── Cleanup paths ──
    await actions.deleteVault(created.id);
    expect((await actions.listVaults()).vaults.map((vault) => vault.id)).not.toContain(created.id);
  });

  it("verifies the vault password locally against the real canary", async () => {
    const vault = await createTestVault(server, "Password Check", material);
    const { plugin } = await loadPlugin({ vault: new FakeVault() });

    // fetchVaultCredentials is the pure check: it reports the outcome and hands
    // back the salt, leaving it to the caller whether that salt is remembered.
    await expect(plugin.fetchVaultCredentials(vault.id, material.password)).resolves.toEqual({
      kind: "ok",
      encryptionSalt: material.salt,
    });
    await expect(plugin.fetchVaultCredentials(vault.id, "definitely wrong")).resolves.toEqual({
      kind: "invalid-password",
    });
    // The picker reads this same answer, so an unreachable server is not reported as a
    // wrong password; there is no separate boolean variant left to test.
  });

  it("keeps the delete confirmation's password entry free of a remember toggle", async () => {
    // Deleting a vault only confirms the password — there is nothing to remember — so the
    // delete-path variant of the shared prompt must not offer the choice.
    const { plugin } = await loadPlugin({ vault: new FakeVault() });
    const modal = new PasswordPromptModal(plugin.app, { askToRemember: false });
    modal.open();

    // The plugin's `Modal` and the stub's are separate declarations (the npm
    // package ships types only), so the harness helpers need the test double's
    // shape even though `open()` recorded this very instance.
    const recorded = modal as unknown as Modal;
    expect(modalToggles(recorded)).toHaveLength(0);
    modalTexts(recorded).at(0)!.simulateChange(material.password);
    clickModalButton(recorded, "解锁");
    await expect(modal.getResult()).resolves.toEqual({
      password: material.password,
      remember: false,
    });
  });

  it("asks the vault password once when two callers race", async () => {
    const { plugin } = await loadPlugin({ vault: new FakeVault() });

    // The load-time unlock is not awaited by `onload`, so a settings click can arrive
    // while its dialog is still open: one question, one dialog, one answer.
    const first = plugin.askForVaultPassword();
    const second = plugin.askForVaultPassword();
    expect(openedModals).toHaveLength(1);

    modalTexts(lastOpenedModal()!).at(0)!.simulateChange(material.password);
    clickModalButton(lastOpenedModal()!, "解锁");
    const expected = { password: material.password, remember: true };
    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(expected);

    // The guard is per dialog, not a latch: a later caller gets a fresh one.
    const third = plugin.askForVaultPassword({ askToRemember: false });
    expect(openedModals).toHaveLength(2);
    clickModalButton(lastOpenedModal()!, "取消");
    await expect(third).resolves.toBeNull();

    // The unlock slot is one promise too: a retry during the load's unlock joins it rather
    // than starting a second host.
    const unlock = plugin.autoUnlockOrPrompt();
    expect(plugin.autoUnlockOrPrompt()).toBe(unlock);
    await unlock;
  });

  it("creates a vault from the picker and leaves it in the list to connect to", async () => {
    const { plugin } = await loadPlugin({
      vault: new FakeVault(),
      settings: { serverUrl: server.serverUrl, userKey: server.userKey },
    });
    const tab = settingsTabOf(plugin);
    tab.display();

    // The vault row is the way in; creating lives inside the picker, next to the list.
    const picker = openVaultPicker(plugin);
    clickModalButton(picker, "创建远程库");
    const modal = lastOpenedModal();
    expect(modal?.title).toBe("创建远程库");
    const fields = modalTexts(modal!);
    fields[0].simulateChange("My Remote Vault");
    fields[1].simulateChange(material.password);
    clickModalButton(modal!, "创建");

    // Creating is not connecting: the vault exists, the dialog is still open, and the
    // page behind it is still the account + vault rows. The picker's own reload is the
    // confirmation — there is no toast to wait for.
    expect(plugin.settings.connectedVaultId).toBeNull();
    expect(plugin.host).toBeNull();
    expect(picker.isOpen).toBe(true);
    expect(settingsIn(tab.containerEl).some((row) => row.name === "同步的文件类型")).toBe(false);

    // ...and the new vault is now one of the rows, ready to be connected to.
    await waitFor(
      () => settingsIn(picker.contentEl).some((row) => row.name === "My Remote Vault"),
      "the picker never listed the vault it just created",
    );
    const vaults = await plugin.actions.listVaults();
    expect(vaults.vaults.map((vault) => vault.name)).toContain("My Remote Vault");

    // Connecting is the next decision: a vault this device has never configured opens
    // the setup dialog, which collects the password and the per-vault settings together.
    clickVaultRowButton(picker, "My Remote Vault", "连接");
    const setup = lastOpenedModal();
    expect(setup?.title).toBe("连接设置");
    modalTexts(setup!).at(0)!.simulateChange(material.password);
    clickStartSyncing(setup!);

    await waitFor(
      () => plugin.settings.connectedVaultName === "My Remote Vault",
      "the created vault was never bound",
    );
    await waitFor(
      () => settingsIn(tab.containerEl).some((row) => row.name === "同步的文件类型"),
      "the page never moved to the settings step",
    );
    // Connecting closes the dialog; the page behind it is the settings now.
    expect(picker.isOpen).toBe(false);
  });

  it("connects to the vault picked in the list, through the real setup dialog", async () => {
    const remote = await createTestVault(server, "Connect Me", material);
    const vault = new FakeVault();
    await vault.create("local.md", "already here");
    const { plugin } = await loadPlugin({
      vault,
      settings: { serverUrl: server.serverUrl, userKey: server.userKey },
    });
    const tab = settingsTabOf(plugin);
    tab.display();

    const picker = await openVaultPickerWith(plugin, remote.name);
    clickVaultRowButton(picker, remote.name, "连接");

    const modal = lastOpenedModal();
    expect(modal?.title).toBe("连接设置");
    modalTexts(modal!).at(0)!.simulateChange(material.password);
    clickStartSyncing(modal!);

    await waitFor(
      () => plugin.settings.connectedVaultId === remote.id,
      "the vault was never bound",
    );
    expect(plugin.settings.encryptionSalt).toBe(material.salt);
    // Binding writes the connection before it starts the host, and `startHost()` now
    // reads the account (the file-size cap) before it builds one — so the host is not
    // part of the binding, and the test has to wait for it like the page does.
    await waitFor(() => plugin.host !== null, "the host never started after connecting");

    await waitForAsync(
      async () => (await vaultHistory(server, remote.id)).some((file) => file.versions.length > 0),
      "the local note never reached the server after connecting",
    );
  });

  it("keeps the vault password out of the flow that fails", async () => {
    const remote = await createTestVault(server, "Wrong Password", material);
    const { plugin } = await loadPlugin({
      vault: new FakeVault(),
      settings: { serverUrl: server.serverUrl, userKey: server.userKey },
    });
    const tab = settingsTabOf(plugin);
    tab.display();

    const picker = await openVaultPickerWith(plugin, remote.name);
    clickVaultRowButton(picker, remote.name, "连接");
    const modal = lastOpenedModal();
    expect(modal?.title).toBe("连接设置");
    modalTexts(modal!).at(0)!.simulateChange("not the vault password");
    clickStartSyncing(modal!);

    await waitFor(
      () => setupPasswordError(modal!)?.text.includes("库密码不正确") === true,
      "the wrong password was never reported under its field",
    );
    // The refusal belongs to the password input, not to the form-level slot above the
    // footer: on a phone that slot is below the fold and the sticky footer covers it.
    const passwordError = setupPasswordError(modal!)!;
    expect(passwordError.classes).toContain("is-visible");
    const formError = elementsWithClass(modal!.contentEl, "courier-setup-error")[0]!;
    expect(
      formError.classes,
      "the form-level slot should stay empty when one field explains the failure",
    ).not.toContain("is-visible");

    // Typing a new value drops the sentence: it described the password that was refused.
    modalTexts(modal!).at(0)!.simulateChange("a second try");
    expect(setupPasswordError(modal!)?.classes ?? []).not.toContain("is-visible");

    // The failure is reported where it happened: the setup dialog stays open with the
    // fields intact, the picker stays behind it, nothing was bound, no key was kept on
    // this device, and the vault was not marked as configured.
    expect(modal!.isOpen).toBe(true);
    expect(picker.isOpen).toBe(true);
    expect(settingsIn(tab.containerEl).map((row) => row.name)).toContain("选择远程库");
    expect(plugin.settings.connectedVaultId).toBeNull();
    expect(plugin.settings.vaultConnections).toEqual({});
    expect(plugin.host).toBeNull();
    expect(loadLocalStorage(VAULT_CREDENTIAL_KEY)).toBeNull();
  });

  it("scrolls a form-level setup failure clear of the sticky footer", async () => {
    // The setup dialog is taller than a phone's sheet, so its slot above the footer can
    // land under that footer. The dialog measures the visible band and scrolls itself;
    // the stub's fake rects make that branch observable without a browser layout.
    new SetupConnectionModal(createFakeApp(new FakeVault()) as unknown as App, {
      vaultName: "daily",
      deviceName: "phone",
      excludedFolders: [],
      configured: true,
      onSubmit: async () => ({ ok: false, error: "无法连接服务器。" }),
      onConnected: () => {},
    }).open();
    // Through `lastOpenedModal`, like every other dialog test: that is the stub's `Modal`
    // (the class above is typed against the app's own `Modal`).
    const modal = lastOpenedModal()!;

    const body = elementsWithClass(modal.contentEl, "courier-setup-body")[0]!;
    const footer = elementsWithClass(modal.contentEl, "courier-setup-footer")[0]!;
    const error = elementsWithClass(modal.contentEl, "courier-setup-error")[0]!;
    // A body scrolled to a position where the footer (sticky at 480) covers the error.
    body.rect = { left: 0, top: 100, width: 300, height: 500 };
    footer.rect = { left: 0, top: 480, width: 300, height: 80 };
    error.rect = { left: 10, top: 500, width: 280, height: 40 };

    setupFields(modal).password.simulateChange("wrong");
    clickStartSyncing(modal);

    await waitFor(
      () => error.classes.includes("is-visible"),
      "the form-level failure never appeared",
    );
    // 540 (error bottom) + 14 (margin) − 480 (footer top) = 74.
    expect(body.scrollTop).toBe(74);
    expect(setupPasswordError(modal)?.classes ?? []).not.toContain("is-visible");
    modal.close();
  });

  it("drops a refusal for a password typed while the check was in flight", async () => {
    // The answer is about the value that was submitted. If the user has already typed a
    // new one, the sentence must not attach itself to that new value.
    let finish!: (outcome: { ok: false; error: string; field: "password" }) => void;
    new SetupConnectionModal(createFakeApp(new FakeVault()) as unknown as App, {
      vaultName: "daily",
      deviceName: "phone",
      excludedFolders: [],
      configured: true,
      onSubmit: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      onConnected: () => {},
    }).open();
    const modal = lastOpenedModal()!;
    const password = setupFields(modal).password;

    password.simulateChange("first try");
    clickStartSyncing(modal);
    // The check is parked on the promise above; a new value arrives before it answers.
    password.simulateChange("second try");
    finish({ ok: false, error: "库密码不正确。", field: "password" });

    const start = () =>
      elementsWithClass(modal.contentEl, "courier-setup-start")[0] as unknown as {
        disabled: boolean;
      };
    await waitFor(() => !start().disabled, "the dialog never finished the connect attempt");

    expect(setupPasswordError(modal)?.classes ?? []).not.toContain("is-visible");
    expect(modal.isOpen, "the dialog stays open after a failed attempt").toBe(true);
    modal.close();
  });

  /**
   * The first-connection dialog and the per-vault record behind it.
   *
   * The rule these cases exist for is that the record — not the length of the exclusion
   * list — is what says "this vault is configured": a first setup that excludes nothing
   * must not ask again, and clearing the list later must not either.
   */
  describe("connection setup", () => {
    /** Open the picker, press 连接, and return the dialog it opened. */
    async function openSetup(
      plugin: CourierPlugin,
      vaultName: string,
    ): Promise<{ picker: Modal; setup: Modal }> {
      const tab = settingsTabOf(plugin);
      tab.display();
      const picker = await openVaultPickerWith(plugin, vaultName);
      clickVaultRowButton(picker, vaultName, "连接");
      const setup = lastOpenedModal();
      expect(setup?.title).toBe("连接设置");
      return { picker, setup: setup! };
    }

    /** Check or uncheck one folder in a tree dialog (the row's own change event). */
    function setFolderChecked(tree: Modal, name: string, checked: boolean): void {
      const row = elementsWithClass(tree.contentEl, "courier-excluded-folder-row").find((entry) =>
        allText(entry).includes(name),
      );
      if (!row) throw new Error(`the folder tree has no "${name}" row`);
      const checkbox = elementsWithClass(row, "courier-excluded-folder-checkbox")[0] as unknown as {
        checked: boolean;
        listeners: Record<string, Array<(event: unknown) => void>>;
      };
      checkbox.checked = checked;
      for (const listener of checkbox.listeners.change ?? []) listener({});
    }

    it("asks for the password under the password field", async () => {
      const remote = await createTestVault(server, "Setup No Password", material);
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });

      const { setup } = await openSetup(plugin, remote.name);
      clickStartSyncing(setup);

      expect(setupPasswordError(setup)?.text).toContain("请输入库密码");
      expect(setupPasswordError(setup)?.classes).toContain("is-visible");
      expect(
        elementsWithClass(setup.contentEl, "courier-setup-error")[0]!.classes,
        "the form-level slot stays out of a field failure",
      ).not.toContain("is-visible");
      expect(setup.isOpen, "an empty password is not a reason to close the dialog").toBe(true);
    });

    it("configures the first connection and applies its folder exclusions to the bind", async () => {
      const remote = await createTestVault(server, "Setup First", material);
      const vault = new FakeVault();
      await vault.create("public.md", "public");
      await vault.create("private/local.md", "local");
      const { plugin } = await loadPlugin({
        vault,
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });

      const { picker, setup } = await openSetup(plugin, remote.name);
      const fields = setupFields(setup);
      // A new vault starts from the device's current label and no exclusions.
      expect(fields.deviceName.getValue()).toBe("My Device");
      expect(allText(setup.contentEl).join(" ")).toContain("不排除任何文件夹");

      fields.password.simulateChange(material.password);
      fields.deviceName.simulateChange("Vault A Laptop");

      clickManageFolders(setup);
      const tree = lastOpenedModal()!;
      expect(tree.title).toBe("管理排除的文件夹");
      setFolderChecked(tree, "private", true);
      pressTreeDone(tree);
      await waitFor(() => !tree.isOpen, "the folder tree never closed after Done");
      await waitFor(
        () => allText(setup.contentEl).join(" ").includes("已排除 1 个文件夹"),
        "the setup dialog never picked up the folder selection",
      );
      expect(allText(setup.contentEl).join(" ")).toContain("private");

      clickStartSyncing(setup);
      await waitFor(
        () => plugin.settings.connectedVaultId === remote.id,
        "the vault was never bound",
      );

      expect(plugin.settings.deviceName).toBe("Vault A Laptop");
      expect(plugin.settings.excludedFolders).toEqual(["private"]);
      expect(recordOf(plugin, remote.id)).toEqual({
        deviceName: "Vault A Laptop",
        excludedFolders: ["private"],
      });
      // The connect promise resolves after the bind pass; the dialog closes on the same
      // turn, so wait for that rather than racing it.
      await waitFor(
        () => !setup.isOpen && !picker.isOpen,
        "the setup dialog or the picker stayed open after connecting",
      );

      // The selected folder is outside the bind pass; the public note is inside it.
      await waitForAsync(
        async () => (await filesAtPath(server, remote.id, material.key, "public.md")).length > 0,
        "the public note never reached the server",
      );
      expect(await filesAtPath(server, remote.id, material.key, "private/local.md")).toEqual([]);
      const fileId = plugin.engine!.fileIdForPath("public.md")!;
      expect((await fileVersions(server, remote.id, fileId))[0]!.deviceName).toBe("Vault A Laptop");
    });

    it("treats a first setup with no folders selected as configured, and reopens the form with it next time", async () => {
      const remote = await createTestVault(server, "Setup Empty", material);
      const vault = new FakeVault();
      await vault.create("note.md", "body");
      const { plugin } = await loadPlugin({
        vault,
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });

      const { setup } = await openSetup(plugin, remote.name);
      // Password only: no Manage visit, no device rename. An empty list is still a
      // completed configuration.
      setupFields(setup).password.simulateChange(material.password);
      clickStartSyncing(setup);
      await waitFor(
        () => plugin.settings.connectedVaultId === remote.id,
        "the vault was never bound",
      );
      expect(recordOf(plugin, remote.id)).toEqual({
        deviceName: "My Device",
        excludedFolders: [],
      });

      await plugin.disconnectVault();
      const picker = await openVaultPickerWith(plugin, remote.name);
      clickVaultRowButton(picker, remote.name, "连接");
      const returning = lastOpenedModal();
      // The same form comes back, now as a confirmation of the stored record.
      expect(returning?.title).toBe("连接设置");
      const fields = setupFields(returning!);
      expect(fields.deviceName.getValue()).toBe("My Device");
      expect(allText(returning!.contentEl).join(" ")).toContain("检查并确认这个远程库的连接设置。");
      expect(allText(returning!.contentEl).join(" ")).toContain("不排除任何文件夹");

      fields.password.simulateChange(material.password);
      clickStartSyncing(returning!);
      await waitFor(
        () => plugin.settings.connectedVaultId === remote.id,
        "the configured vault never reconnected",
      );
      expect(plugin.settings.deviceName).toBe("My Device");
      expect(plugin.settings.excludedFolders).toEqual([]);
    });

    it("keeps the vault configured after the last exclusion is cleared", async () => {
      const remote = await createTestVault(server, "Setup Clear", material);
      const vault = new FakeVault();
      await vault.create("private/local.md", "local");
      const { plugin } = await loadPlugin({
        vault,
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });

      const { setup } = await openSetup(plugin, remote.name);
      setupFields(setup).password.simulateChange(material.password);
      clickManageFolders(setup);
      const tree = lastOpenedModal()!;
      setFolderChecked(tree, "private", true);
      pressTreeDone(tree);
      clickStartSyncing(setup);
      await waitFor(
        () => plugin.settings.connectedVaultId === remote.id,
        "the vault was never bound",
      );

      // Clear the list from the settings page's own Manage dialog; the record must stay.
      const tab = settingsTabOf(plugin);
      tab.display();
      const manageRow = settingsIn(tab.containerEl).find((row) => row.name === "排除列表")!;
      manageRow.buttons[0]!.click();
      const manage = lastOpenedModal()!;
      setFolderChecked(manage, "private", false);
      pressTreeDone(manage);
      await waitFor(
        () => plugin.settings.excludedFolders.length === 0,
        "the settings page never cleared the list",
      );
      expect(recordOf(plugin, remote.id)).toEqual({
        deviceName: "My Device",
        excludedFolders: [],
      });

      await plugin.disconnectVault();
      const picker = await openVaultPickerWith(plugin, remote.name);
      clickVaultRowButton(picker, remote.name, "连接");
      const returning = lastOpenedModal();
      expect(returning?.title).toBe("连接设置");
      expect(allText(returning!.contentEl).join(" ")).toContain("不排除任何文件夹");
    });

    it("creates the record when Manage is closed without changing anything, without restarting the host", async () => {
      const hosted = await startHostedPlugin("Setup Legacy Bound", async (vault) => {
        await vault.create("daily/note.md", "daily");
      });
      // This models a vault that was bound before the per-vault record existed.
      expect(hosted.plugin.settings.vaultConnections).toEqual({});
      const host = hosted.plugin.host;

      const tab = settingsTabOf(hosted.plugin);
      tab.display();
      const manageRow = settingsIn(tab.containerEl).find((row) => row.name === "排除列表")!;
      manageRow.buttons[0]!.click();
      const manage = lastOpenedModal()!;
      pressTreeDone(manage);

      await waitFor(
        () => hosted.plugin.settings.vaultConnections[hosted.remote.id] !== undefined,
        "the vault's record was never created",
      );
      expect(recordOf(hosted.plugin, hosted.remote.id)).toEqual({
        deviceName: "My Device",
        excludedFolders: [],
      });
      // The list normalizes to what it was, so nothing needed a host restart.
      expect(hosted.plugin.host).toBe(host);
    });

    it("keeps each vault's label and folder list separate when switching", async () => {
      const remoteA = await createTestVault(server, "Setup Switch A", material);
      const remoteB = await createTestVault(server, "Setup Switch B", material);
      const vault = new FakeVault();
      await vault.create("private/local.md", "a-private");
      await vault.create("archive/local.md", "b-archive");
      const { plugin } = await loadPlugin({
        vault,
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });

      // A: its own label and its own exclusion.
      let { setup } = await openSetup(plugin, remoteA.name);
      let fields = setupFields(setup);
      fields.password.simulateChange(material.password);
      fields.deviceName.simulateChange("A Laptop");
      clickManageFolders(setup);
      let tree = lastOpenedModal()!;
      setFolderChecked(tree, "private", true);
      pressTreeDone(tree);
      clickStartSyncing(setup);
      await waitFor(
        () => plugin.settings.connectedVaultId === remoteA.id,
        "vault A was never bound",
      );

      await plugin.disconnectVault();

      // B: the label is prefilled from the current value (a convenience), the folder list
      // starts empty, and whatever is saved here is B's own record.
      ({ setup } = await openSetup(plugin, remoteB.name));
      fields = setupFields(setup);
      expect(fields.deviceName.getValue()).toBe("A Laptop");
      expect(allText(setup.contentEl).join(" ")).toContain("不排除任何文件夹");
      fields.password.simulateChange(material.password);
      fields.deviceName.simulateChange("B Laptop");
      clickManageFolders(setup);
      tree = lastOpenedModal()!;
      setFolderChecked(tree, "archive", true);
      pressTreeDone(tree);
      clickStartSyncing(setup);
      await waitFor(
        () => plugin.settings.connectedVaultId === remoteB.id,
        "vault B was never bound",
      );

      await plugin.disconnectVault();

      // Back to A: the same form, prefilled with A's own label and folder list.
      const picker = await openVaultPickerWith(plugin, remoteA.name);
      clickVaultRowButton(picker, remoteA.name, "连接");
      const returning = lastOpenedModal();
      expect(returning?.title).toBe("连接设置");
      fields = setupFields(returning!);
      expect(fields.deviceName.getValue()).toBe("A Laptop");
      expect(allText(returning!.contentEl).join(" ")).toContain("已排除 1 个文件夹");
      expect(allText(returning!.contentEl).join(" ")).toContain("private");
      fields.password.simulateChange(material.password);
      clickStartSyncing(returning!);
      await waitFor(
        () => plugin.settings.connectedVaultId === remoteA.id,
        "vault A was never reconnected",
      );
      expect(plugin.settings.deviceName).toBe("A Laptop");
      expect(plugin.settings.excludedFolders).toEqual(["private"]);
      expect(recordOf(plugin, remoteB.id)).toEqual({
        deviceName: "B Laptop",
        excludedFolders: ["archive"],
      });
    });

    it("binds nothing when setup is cancelled", async () => {
      const remote = await createTestVault(server, "Setup Cancel", material);
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });

      const { picker, setup } = await openSetup(plugin, remote.name);
      clickSetupButton(setup, "courier-setup-cancel", "取消");

      expect(setup.isOpen).toBe(false);
      expect(picker.isOpen).toBe(true);
      expect(plugin.settings.connectedVaultId).toBeNull();
      expect(plugin.settings.vaultConnections).toEqual({});
      expect(plugin.host).toBeNull();
    });

    it("forgets a vault's connection record when the vault is deleted on the server", async () => {
      const remote = await createTestVault(server, "Setup Deleted", material);
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });

      const { setup } = await openSetup(plugin, remote.name);
      setupFields(setup).password.simulateChange(material.password);
      clickStartSyncing(setup);
      await waitFor(
        () => plugin.settings.connectedVaultId === remote.id,
        "the vault was never bound",
      );
      expect(recordOf(plugin, remote.id)).toBeDefined();

      // The deletion reaches the client as a websocket event; wait for the subscription
      // the bind started before deleting, or the event has nobody to arrive at.
      await waitFor(() => plugin.wsState === "connected", "the host never subscribed");

      await plugin.actions.deleteVault(remote.id);
      await waitFor(
        () => plugin.settings.connectedVaultId === null,
        "the plugin never disconnected after the vault was deleted",
      );
      expect(plugin.settings.vaultConnections[remote.id]).toBeUndefined();
    });

    it("forgets a disconnected vault's record when the vault is deleted from the picker", async () => {
      const remote = await createTestVault(server, "Setup Picker Deleted", material);
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });

      // Configure the vault, then leave it: the record is what a later reconnect
      // would restore, and it has to survive a disconnect but not a deletion.
      const { setup } = await openSetup(plugin, remote.name);
      setupFields(setup).password.simulateChange(material.password);
      clickStartSyncing(setup);
      await waitFor(
        () => plugin.settings.connectedVaultId === remote.id,
        "the vault was never bound",
      );
      await plugin.disconnectVault();
      expect(recordOf(plugin, remote.id)).toBeDefined();

      // The picker's delete action calls exactly this method after its password and
      // confirmation dialogs; the deletion itself is what the record follows.
      const outcome = await plugin.deleteVault(remote.id);
      expect(outcome).toEqual({ ok: true, value: undefined });
      expect(plugin.settings.vaultConnections[remote.id]).toBeUndefined();
      // Persisted, not only forgotten in memory.
      const persisted = (await plugin.loadData()) as CourierSettings;
      expect(persisted.vaultConnections[remote.id]).toBeUndefined();
    });
  });

  /**
   * The shape a note edited twice leaves behind.
   *
   * Two operations run on one path: an edit's push lands on the chain while a second
   * decision on that path has already fetched the chain but has not yet seen this device's
   * state adopt the version — the head then holds exactly the bytes on disk while the sync
   * point is one version behind. That window is hard to open on purpose, so the same state
   * is produced deterministically: stop this device's host, let the peer push the new
   * content, make the *same* edit here, then bring the host back.
   *
   * It used to resolve as a conflict: a copy of the note parked over itself and the same
   * bytes written back, which is the `probe-empty-….conflict.md` pair a real vault showed.
   */
  it("converges when the head already holds this device's bytes, with no conflict copy", async () => {
    const hosted = await startHostedPlugin("Same Bytes");
    const path = "same.md";
    await hosted.vault.create(path, "base");
    await hosted.vault.settle();
    await waitForAsync(
      async () => (await filesAtPath(server, hosted.remote.id, material.key, path)).length === 1,
      "the base note never reached the server",
    );
    const fileId = await trackedFileId(hosted.plugin, path);

    // The peer joins the chain, then edits it while this device is stopped, so this
    // device's sync point cannot move past the first version.
    const peer = await newPeer(hosted.remote.id, "same-bytes-peer");
    await peer.sync();
    await hosted.plugin.pauseSync();
    expect(hosted.plugin.host).toBeNull();
    peer.write(path, "same edit");
    await peer.sync();
    await waitForAsync(
      async () => (await fileVersions(server, hosted.remote.id, fileId)).length === 2,
      "the peer's edit never reached the server",
    );

    // The very same edit here, made while nothing was listening.
    await hosted.vault.modify(path, "same edit");
    await hosted.vault.settle();
    await hosted.plugin.resumeSync();
    await waitForAsync(async () => hosted.plugin.host !== null, "resuming never started the host");

    // The bind pass finds identical bytes on both sides: nothing to park, nothing to push.
    expect(conflictCopyOf(hosted.vault.paths(), path)).toBeNull();
    expect(hosted.vault.read(path)).toBe("same edit");
    expect((await fileVersions(server, hosted.remote.id, fileId)).map((v) => v.action)).toEqual([
      "create",
      "modify",
    ]);
    expect(notices.some((message) => message.includes("冲突"))).toBe(false);

    // The head became this device's sync point, so the next edit is an ordinary modify.
    await hosted.vault.modify(path, "after");
    await hosted.vault.settle();
    await waitForAsync(
      async () => (await fileVersions(server, hosted.remote.id, fileId)).length === 3,
      "the edit after the convergence never reached the server",
    );
    expect(conflictCopyOf(hosted.vault.paths(), path)).toBeNull();
  });

  /**
   * The merge matrix through the **real connect dialog**: what a vault that
   * already has notes does when it is bound to a remote that already has content.
   * Each case asserts on the server chains, the local vault and the conflict list,
   * because "who wins" is the whole question.
   */
  describe("connecting a vault that already has content on both sides", () => {
    /**
     * Bind with local notes already in the vault.
     *
     * The password is handed to the real binding call directly: what the matrix is
     * about is the merge, and the dialog that collects the password is covered by
     * the tests above.
     */
    async function connectWithLocalNotes(
      vaultName: string,
      remoteFiles: Record<string, string>,
      localFiles: Record<string, string>,
    ) {
      const remote = await createTestVault(server, vaultName, material);
      const peer = await newPeer(remote.id, "seed-peer");
      for (const [path, content] of Object.entries(remoteFiles)) peer.write(path, content);
      await peer.sync();
      for (const path of Object.keys(remoteFiles)) await peer.change(path);

      const vault = new FakeVault();
      for (const [path, content] of Object.entries(localFiles)) await vault.create(path, content);

      const { plugin } = await loadPlugin({
        vault,
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });
      const outcome = await plugin.connectToVault(remote.id, remote.name, material.password);
      expect(outcome.ok, "the vault could not be bound").toBe(true);

      return { plugin, engine: engineOf(plugin), vault, remote };
    }

    it("1. local only — the local notes are created on the server", async () => {
      const { engine, vault, remote } = await connectWithLocalNotes(
        "Matrix Local Only",
        { "remote-seed.md": "seed" },
        { "local-only.md": "only here", "folder/nested-local.md": "nested only here" },
      );

      expect(parkedConflictCopies(vault)).toEqual([]);
      expect(vault.paths()).toContain("local-only.md");
      expect(vault.read("folder/nested-local.md")).toBe("nested only here");
      const localOnlyId = engine.fileIdForPath("local-only.md")!;
      await waitForAsync(
        async () => (await fileVersions(server, remote.id, localOnlyId)).length === 1,
        "the local notes never reached the server after connecting",
      );
    });

    it("2. remote only — the remote notes arrive in the vault", async () => {
      const { vault, remote } = await connectWithLocalNotes(
        "Matrix Remote Only",
        { "remote-only.md": "from the server" },
        {},
      );

      await waitForAsync(
        async () => vault.read("remote-only.md") === "from the server",
        "the remote note never arrived after connecting",
      );
      expect(parkedConflictCopies(vault)).toEqual([]);
      expect(await vaultHistory(server, remote.id)).toHaveLength(1);
    });

    it("3. same name, different content — the remote note wins, the local one is parked", async () => {
      const { vault, remote } = await connectWithLocalNotes(
        "Matrix Same Name Different",
        { "shared.md": "remote version" },
        { "shared.md": "local version" },
      );

      // The remote head is the truth on this path and the local note is beside it:
      // binding pushes nothing, so the chain does not grow.
      expect(vault.read("shared.md")).toBe("remote version");
      // The copy carries the second it was parked at, so it is found in the vault rather
      // than rebuilt from the test's clock (see `conflictCopyOf`).
      const parked = parkedConflictCopies(vault);
      expect(parked).toEqual([conflictCopyOf(vault.paths(), "shared.md")!]);
      expect(vault.read(parked[0]!)).toBe("local version");
      const history = await vaultHistory(server, remote.id);
      expect(history).toHaveLength(1);
      expect(history[0].versions).toHaveLength(1);

      // And the user is told where their note went — once, as a plain notice.
      await waitFor(
        () => notices.some((message) => message.includes(parked[0]!)),
        "the plugin never reported the parked conflict",
      );
    });

    it("4. same name, same content — converges without a second chain", async () => {
      const { vault, remote } = await connectWithLocalNotes(
        "Matrix Same Name Same",
        { "shared.md": "identical" },
        { "shared.md": "identical" },
      );

      expect(parkedConflictCopies(vault)).toEqual([]);
      expect(vault.read("shared.md")).toBe("identical");
      const history = await vaultHistory(server, remote.id);
      expect(history).toHaveLength(1);
      expect(history[0].versions).toHaveLength(1);
    });

    it("5a. remote tombstone + local note — the note is pushed as a new file", async () => {
      const remote = await createTestVault(server, "Matrix Tombstone Bind", material);
      const peer = await newPeer(remote.id, "seed-peer");
      peer.write("phoenix.md", "first life");
      await peer.sync();
      await peer.change("phoenix.md");
      const deletedFileId = peer.engine.fileIdForPath("phoenix.md")!;
      peer.remove("phoenix.md");
      await peer.removeAndSync("phoenix.md");

      const vault = new FakeVault();
      await vault.create("phoenix.md", "second life");
      const { plugin } = await loadPlugin({
        vault,
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });
      const outcome = await plugin.connectToVault(remote.id, remote.name, material.password);
      expect(outcome.ok, "the vault could not be bound").toBe(true);
      const engine = engineOf(plugin);

      // Bound: the local note is the user's own file, with its own new identity.
      expect(parkedConflictCopies(vault)).toEqual([]);
      const rebornFileId = engine.fileIdForPath("phoenix.md")!;
      expect(rebornFileId).not.toBe(deletedFileId);
      expect(vault.read("phoenix.md")).toBe("second life");
      expect((await fileVersions(server, remote.id, rebornFileId)).map((v) => v.action)).toEqual([
        "create",
      ]);
      expect((await deletedFiles(server, remote.id)).map((f) => f.fileId)).toContain(deletedFileId);

      // A later reconcile does not push it a second time.
      await engine.initialSync();
      expect(engine.fileIdForPath("phoenix.md")).toBe(rebornFileId);
      expect(await vaultHistory(server, remote.id)).toHaveLength(2);
    });

    it("5b. remote tombstone + local note on a plain reconcile — the deletion is applied", async () => {
      const remote = await createTestVault(server, "Matrix Tombstone Reconcile", material);

      // The plugin starts on a vault that already holds the note: the host's bind
      // pass creates it on the server and tracks it.
      const vault = new FakeVault();
      await vault.create("phoenix.md", "first life");
      const { plugin } = await loadPlugin({
        vault,
        settings: { connectedVaultId: remote.id, connectedVaultName: remote.name },
      });
      plugin.encryptionKey = material.key;
      await plugin.startHost();
      const engine = engineOf(plugin);
      expect(engine.fileIdForPath("phoenix.md")).toBeTruthy();

      // A peer deletes it; this device reconciles — a scheduled pass, not a bind,
      // so the deletion is applied instead of revived.
      const peer = await newPeer(remote.id, "deleting-peer");
      peer.write("phoenix.md", "first life");
      await peer.sync();
      await peer.change("phoenix.md");
      peer.remove("phoenix.md");
      await peer.removeAndSync("phoenix.md");

      await engine.initialSync();
      // The delete fires the vault's own delete event; let the host's handler
      // finish, then check nothing resurrects the note.
      await waitForAsync(
        async () => vault.read("phoenix.md") === null,
        "the peer's deletion never reached the vault",
      );
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(parkedConflictCopies(vault)).toEqual([]);
      expect(vault.read("phoenix.md")).toBeNull();
      expect(engine.fileIdForPath("phoenix.md")).toBeNull();
    });
  });

  it("prompts for the vault password on load and resumes syncing", async () => {
    const remote = await createTestVault(server, "Resume On Load", material);
    const vault = new FakeVault();
    await vault.create("note.md", "written while Obsidian was closed");
    const app = createFakeApp(vault);
    const plugin = new CourierPlugin(app as unknown as App, MANIFEST);
    await plugin.saveData({
      ...DEFAULT_SETTINGS,
      serverUrl: server.serverUrl,
      userKey: server.userKey,
      connectedVaultId: remote.id,
      connectedVaultName: remote.name,
      encryptionSalt: material.salt,
    });

    // This is the real "reopen Obsidian" path; nothing is stored yet, so onload
    // has to ask.
    await plugin.onload();
    plugins.push(plugin);

    const modal = lastOpenedModal();
    expect(modal?.title).toBe("需要库密码");
    // Remembering the key is the default, on desktop and mobile alike.
    expect(modalToggles(modal!).at(0)?.getValue()).toBe(true);
    modalTexts(modal!).at(0)!.simulateChange(material.password);
    clickModalButton(modal!, "解锁");

    await waitForAsync(async () => plugin.host !== null, "the host never started after unlocking");
    await waitForAsync(
      async () => (await vaultHistory(server, remote.id)).some((file) => file.versions.length > 0),
      "the note was never pushed after unlocking",
    );
    expect(vault.read("note.md")).toBe("written while Obsidian was closed");

    // The derived key is kept **on this device**: App-level localStorage, not
    // the vault's data.json (which vault syncing would carry off the machine).
    expect(loadLocalStorage(VAULT_CREDENTIAL_KEY)).toEqual({
      vaultId: remote.id,
      encryptionKeyB64: expect.any(String),
    });
    const persisted = (await plugin.loadData()) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("encryptionKeyB64");
    expect(persisted).not.toHaveProperty("vaultPassword");
    expect(persisted).not.toHaveProperty("encryptionKey");
  });

  it("reopens Obsidian without asking for the password again", async () => {
    const remote = await createTestVault(server, "Silent Resume", material);
    const vault = new FakeVault();
    await vault.create("kept.md", "still here");
    const settings = {
      ...DEFAULT_SETTINGS,
      serverUrl: server.serverUrl,
      userKey: server.userKey,
      connectedVaultId: remote.id,
      connectedVaultName: remote.name,
      encryptionSalt: material.salt,
    };

    // First session: the user unlocks once and keeps the key on this device.
    const first = new CourierPlugin(createFakeApp(vault) as unknown as App, MANIFEST);
    await first.saveData(settings);
    await first.onload();
    const modal = lastOpenedModal();
    modalTexts(modal!).at(0)!.simulateChange(material.password);
    clickModalButton(modal!, "解锁");
    await waitForAsync(async () => first.host !== null, "the first session never started");
    first.onunload();

    // Second session — a fresh plugin instance over the same device-local store,
    // which is what "close and reopen Obsidian" means. Only the observed modals
    // reset; the stored credential must survive, that is the whole point.
    openedModals.length = 0;
    const noticesBeforeSecondLoad = notices.length;
    const second = new CourierPlugin(createFakeApp(vault) as unknown as App, MANIFEST);
    await second.saveData(settings);
    await second.onload();
    plugins.push(second);

    await waitForAsync(async () => second.host !== null, "the stored key did not resume the host");
    expect(openedModals).toHaveLength(0);
    // A start with a usable stored credential is completely silent: no dialog, no toast.
    // The settings page is where "已连接" is read.
    expect(notices).toHaveLength(noticesBeforeSecondLoad);
    expect(notices.some((message) => message.includes("请重新输入密码"))).toBe(false);
    // The credential is untouched, so the next start is silent too.
    expect(loadLocalStorage(VAULT_CREDENTIAL_KEY)).toEqual({
      vaultId: remote.id,
      encryptionKeyB64: expect.any(String),
    });
  });

  it("falls back to the password dialog when the stored credential is dead", async () => {
    const remote = await createTestVault(server, "Stale Credential", material);
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    // A well-formed but wrong key: exactly the "stale record" case.
    const bogus = new Uint8Array(32);
    crypto.getRandomValues(bogus);
    setLocalStorage(VAULT_CREDENTIAL_KEY, {
      vaultId: remote.id,
      encryptionKeyB64: btoa(String.fromCharCode(...bogus)),
    });
    const plugin = new CourierPlugin(app as unknown as App, MANIFEST);
    await plugin.saveData({
      ...DEFAULT_SETTINGS,
      serverUrl: server.serverUrl,
      userKey: server.userKey,
      connectedVaultId: remote.id,
      connectedVaultName: remote.name,
      encryptionSalt: material.salt,
    });
    await plugin.onload();
    plugins.push(plugin);

    await waitFor(
      () => lastOpenedModal() !== undefined,
      "the plugin never fell back to the dialog",
    );
    expect(lastOpenedModal()?.title).toBe("需要库密码");
    expect(plugin.host).toBeNull();
    // The dead record is dropped, so the next start does not retry it.
    expect(loadLocalStorage(VAULT_CREDENTIAL_KEY)).toBeNull();
    expect(notices.some((message) => message.includes("请重新输入密码"))).toBe(true);
  });

  it("keeps the stored credential when the server cannot be reached", async () => {
    const remote = await createTestVault(server, "Unreachable Server", material);
    const vault = new FakeVault();
    const app = createFakeApp(vault);
    // The record a bound device holds. With the server unreachable the key cannot be
    // checked at all, so the point is that it is neither deleted nor read as a wrong key
    // — asking for the password would be unanswerable for exactly the same reason.
    const stored = new Uint8Array(32);
    crypto.getRandomValues(stored);
    setLocalStorage(VAULT_CREDENTIAL_KEY, {
      vaultId: remote.id,
      encryptionKeyB64: btoa(String.fromCharCode(...stored)),
    });
    const plugin = new CourierPlugin(app as unknown as App, MANIFEST);
    await plugin.saveData({
      ...DEFAULT_SETTINGS,
      // Nothing listens on port 1, so reading the canary fails as a transport error —
      // which is the whole case.
      serverUrl: "http://127.0.0.1:1",
      userKey: server.userKey,
      connectedVaultId: remote.id,
      connectedVaultName: remote.name,
      encryptionSalt: material.salt,
    });
    await plugin.onload();
    plugins.push(plugin);

    await waitFor(
      () => notices.some((message) => message.includes("无法连接同步服务器")),
      "the plugin never reported the unreachable server",
    );

    // Nothing was deleted and nothing was asked for: the next load tries again.
    expect(loadLocalStorage(VAULT_CREDENTIAL_KEY)).toEqual({
      vaultId: remote.id,
      encryptionKeyB64: expect.any(String),
    });
    expect(openedModals).toHaveLength(0);
    expect(notices.some((message) => message.includes("请重新输入密码"))).toBe(false);
    expect(plugin.host).toBeNull();
  });

  it("asks for nothing when the user key is missing, since the password is useless without it", async () => {
    const remote = await createTestVault(server, "No User Key", material);
    const app = createFakeApp(new FakeVault());
    setLocalStorage(VAULT_CREDENTIAL_KEY, {
      vaultId: remote.id,
      encryptionKeyB64: "a2V5",
    });
    const plugin = new CourierPlugin(app as unknown as App, MANIFEST);
    await plugin.saveData({
      ...DEFAULT_SETTINGS,
      serverUrl: server.serverUrl,
      connectedVaultId: remote.id,
      connectedVaultName: remote.name,
      encryptionSalt: material.salt,
    });
    await plugin.onload();
    plugins.push(plugin);

    expect(notices.some((message) => message.includes("同步需要用户密钥"))).toBe(true);
    // A dialog collecting a secret `startHost()` cannot use would be busywork.
    expect(openedModals).toHaveLength(0);
    expect(plugin.host).toBeNull();
    // And it is not treated as a dead credential.
    expect(loadLocalStorage(VAULT_CREDENTIAL_KEY)).not.toBeNull();
  });

  it("starts the host and pushes the vault's existing notes, stating its label on each version", async () => {
    const { plugin, remote } = await startHostedPlugin("Host Start", async (vault) => {
      await vault.create("existing.md", "written before the plugin loaded");
    });

    expect(plugin.host).not.toBeNull();

    await waitForAsync(
      async () =>
        (await vaultHistory(server, remote.id)).some(
          (file) => file.versions.at(-1)?.action === "create",
        ),
      "the vault's existing note was never pushed",
    );

    // Nothing is registered anywhere: the name this client states is what its version
    // rows carry.
    const [file] = (await vaultHistory(server, remote.id)).filter((candidate) =>
      candidate.versions.some((version) => version.action === "create"),
    );
    expect(file!.versions[0]!.deviceName).toBe(plugin.settings.deviceName);
    // The engine knows the file by path, so version history can find it.
    expect(plugin.engine!.fileIdForPath("existing.md")).toBeTruthy();
  });

  /**
   * The mobile cold start this work exists for: the app restores the note the user was
   * reading, and that note is updated before the rest of a multi-file backlog. The host
   * reads the workspace's recently opened list and passes it to the pass; the first
   * version-content request is therefore the one for the note on screen.
   */
  it("pulls the note the app was last reading first, on mobile", async () => {
    Platform.isDesktop = false;
    Platform.isMobile = true;

    const names = Array.from({ length: 9 }, (_, index) => `n-${index}.md`);
    const opened = "n-4.md";
    const { plugin, vault, remote, app } = await startHostedPlugin(
      "Mobile Priority",
      async (seed) => {
        for (const name of names) await seed.create(name, `${name} v1`);
      },
    );
    await vault.settle();
    await waitForAsync(
      async () => (await vaultHistory(server, remote.id)).length === names.length,
      "the initial notes never reached the server",
    );

    // Model a phone whose Obsidian is not open: stop the host before the peer edits,
    // so the changes are only discovered by the cold-start bind below.
    plugin.stopHost();

    const peer = await newPeer(remote.id, "priority-peer");
    await peer.sync();
    for (const name of names) {
      peer.write(name, `${name} v2`);
      await peer.change(name);
    }

    // Obsidian persists the ten most recently opened files; on a phone the last note is
    // at the head of it, which is what the plugin's priority provider reads.
    app.workspace.setLastOpenFiles([opened]);
    resetRecordedRequests();
    await plugin.startHost();

    await waitForAsync(
      async () => names.every((name) => vault.read(name) === `${name} v2`),
      "the mobile host never pulled the peer's edits",
    );

    // Up to four files are pulled at once, so the note on screen has to be in the first
    // wave rather than at the end of the nine.
    const contentRequests = requestsMatching(/\/sync\/versions\/[^/]+\/content$/);
    expect(contentRequests).toHaveLength(names.length);
    const openedHash = await sha256Hex(new TextEncoder().encode(`${opened} v2`));
    const index = contentRequests.findIndex((request) => request.url.includes(openedHash));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(DEFAULT_OP_QUEUE_LIMITS.maxConcurrent);
  });

  /**
   * The name is a label, not an identity: renaming this client stamps the new name
   * on later versions while the ones already on the server keep the name they were
   * written with — which is exactly what the sync history is meant to show.
   */
  it("stamps the name in force at the time, so a rename shows up in the history", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Device Rename");
    await vault.create("renamed.md", "first");
    await vault.settle();
    await waitForAsync(
      async () => (await vaultHistory(server, remote.id)).some((file) => file.versions.length > 0),
      "the first version never reached the server",
    );
    const fileId = plugin.engine!.fileIdForPath("renamed.md")!;

    await plugin.setDeviceName("Study Laptop");
    await vault.modify("renamed.md", "second");
    await vault.settle();
    await waitForAsync(
      async () => (await fileVersions(server, remote.id, fileId)).length >= 2,
      "the edit after the rename never reached the server",
    );

    const names = (await fileVersions(server, remote.id, fileId)).map((v) => v.deviceName);
    expect(names[0]).toBe("My Device");
    expect(names.at(-1)).toBe("Study Laptop");
    // Local-only, so it survives a reload without any server round trip — and it is stored
    // under this remote vault's own record.
    expect(plugin.settings.deviceName).toBe("Study Laptop");
    expect(plugin.settings.vaultConnections[remote.id]).toEqual({
      deviceName: "Study Laptop",
      excludedFolders: [],
    });
    expect(((await plugin.loadData()) as { deviceName?: string }).deviceName).toBe("Study Laptop");
  });

  it("pushes local vault events (create, modify, delete) while the host runs", async () => {
    const { vault, remote } = await startHostedPlugin("Vault Events");

    await vault.create("live.md", "first");
    await vault.settle();
    await waitForAsync(
      async () =>
        (await vaultHistory(server, remote.id)).some((file) =>
          file.versions.some((version) => version.action === "create"),
        ),
      "the created note was never pushed",
    );

    await vault.modify("live.md", "second");
    await vault.settle();
    await waitForAsync(
      async () =>
        (await vaultHistory(server, remote.id)).some((file) =>
          file.versions.some((version) => version.action === "modify"),
        ),
      "the edit was never pushed",
    );

    await vault.remove("live.md");
    await vault.settle();
    await waitForAsync(
      async () => (await deletedFiles(server, remote.id)).length === 1,
      "the delete never reached the recycle bin",
    );
  });

  describe("version history", () => {
    /**
     * A note with a rename behind it: its chain holds the version written at the
     * old path, then the move, then an edit — the three rows the modal lists.
     */
    async function startRenamedNote() {
      const hosted = await startHostedPlugin("Version History", async (v) => {
        await v.create("note.md", "v1");
      });
      const fileId = await trackedFileId(hosted.plugin, "note.md");

      await hosted.vault.move("note.md", "moved.md");
      await hosted.vault.settle();
      await waitForAsync(
        async () =>
          (await fileVersions(server, hosted.remote.id, fileId)).at(-1)?.action === "rename",
        "the rename never reached the server",
      );

      await hosted.vault.modify("moved.md", "v2");
      await hosted.vault.settle();
      await waitForAsync(
        async () =>
          (await fileVersions(server, hosted.remote.id, fileId)).at(-1)?.action === "modify",
        "the edit never reached the server",
      );

      return { ...hosted, fileId };
    }

    it("lists every version newest first, with the path a renamed version was written at", async () => {
      const { plugin, vault } = await startRenamedNote();
      const view = await openVersionHistory(plugin, "moved.md");

      // The order is the whole point of the surface: the edit, then the move, then the
      // create — the reader opens it to see what the note looked like a moment ago.
      expect(versionActions(view)).toEqual(["修改", "重命名", "创建"]);
      expect(versionTimes(view)).toHaveLength(3);
      // A row prints the path its version was written at only when that differs from where
      // the chain lives now: that is what makes a rename visible in the history at all.
      expect(versionOldPaths(view)).toEqual(["note.md"]);
      // Opening the history writes nothing.
      expect(vault.read("moved.md")).toBe("v2");
      // The device that pushed every version is this plugin's registered device.
      const devices = elementsWithClass(viewContent(view), "courier-vh-device");
      expect(devices.every((element) => element.text.includes(plugin.settings.deviceName))).toBe(
        true,
      );
    });

    it("shows a version's decrypted content when its row is clicked", async () => {
      const { plugin } = await startRenamedNote();
      const view = await openVersionHistory(plugin, "moved.md");

      // The head is the row the tab opens on, so its content is already on screen.
      await waitFor(
        () => markdownRenders.length > 0,
        "the version's content was never handed to the markdown renderer",
      );
      expect(markdownRenders.at(-1)!.markdown).toBe("v2");

      // Clicking the create row re-renders the pane with *that* version's bytes, for the
      // chain's live path — so relative links in an old version resolve where the note
      // lives now.
      versionRowFor(view, "创建").click();
      await waitFor(
        () => markdownRenders.at(-1)!.markdown === "v1",
        "the older version was never rendered in the pane",
      );
      expect(markdownRenders.at(-1)!.sourcePath).toBe("moved.md");
      expect(selectedVersionRow(view)?.classes).toContain("is-selected");
    });

    it("restores an older version after a confirmation, and cancels without writing", async () => {
      const { plugin, vault, remote, fileId } = await startRenamedNote();
      const view = await openVersionHistory(plugin, "moved.md");

      versionRowFor(view, "创建").click();
      await waitFor(() => {
        const selected = selectedVersionRow(view);
        return (
          selected !== undefined &&
          elementsWithClass(selected, "courier-vh-action")[0]?.text === "创建"
        );
      }, "the create row never became the selected version");
      const button = buttonsIn(viewContent(view)).find(
        (candidate) => candidate.text === "恢复此版本",
      );
      expect(button, "the reading pane offered no restore button").toBeDefined();

      // Cancelling leaves the note exactly as it was.
      const cancelled = await modalOpenedBy(
        () => button!.click(),
        "no restore confirmation appeared",
      );
      expect(cancelled.title).toBe("恢复版本");
      expect(modalParagraphs(cancelled).join(" ")).toContain("moved.md");
      clickModalButton(cancelled, "取消");
      await vault.settle();

      expect(vault.read("moved.md")).toBe("v2");
      expect((await fileVersions(server, remote.id, fileId)).at(-1)?.action).toBe("modify");

      // Confirming writes the version back — over the chain's own file, so the restore is
      // one more version on the same chain, not a second file.
      const confirmed = await modalOpenedBy(
        () => button!.click(),
        "no restore confirmation appeared",
      );
      clickModalButton(confirmed, "恢复");

      await waitFor(() => vault.read("moved.md") === "v1", "the restore never wrote the note");
      await waitForAsync(
        async () => (await fileVersions(server, remote.id, fileId)).at(-1)?.action === "restore",
        "the restore never reached the server",
      );
      expect(await filesAtPath(server, remote.id, material.key, "moved.md")).toEqual([fileId]);
      // The tab re-reads its own chain afterwards, and lands on the new head.
      await waitFor(
        () => versionActions(view)[0] === "恢复",
        "the view never re-read the chain after the restore",
      );
    });

    it("updates the pane in place when a version is selected", async () => {
      const { plugin } = await startRenamedNote();
      const view = await openVersionHistory(plugin, "moved.md");
      await waitFor(
        () => markdownRenders.length > 0,
        "the head version's content was never rendered",
      );

      const list = elementsWithClass(viewContent(view), "courier-vh-list")[0];
      const head = elementsWithClass(viewContent(view), "courier-vh-pane-head")[0];
      const paneBody = elementsWithClass(viewContent(view), "courier-vh-pane-body")[0];

      versionRowFor(view, "创建").click();
      await waitFor(
        () => markdownRenders.at(-1)!.markdown === "v1",
        "the selected version was never rendered in the pane",
      );

      // Selection repaints the pane, not the page: a full re-render blanks the content for
      // the length of a fetch (the flicker this shape exists to avoid) and throws away the
      // list's scroll position and the reader's focus for nothing.
      expect(elementsWithClass(viewContent(view), "courier-vh-list")[0]).toBe(list);
      expect(elementsWithClass(viewContent(view), "courier-vh-pane-head")[0]).toBe(head);
      expect(elementsWithClass(viewContent(view), "courier-vh-pane-body")[0]).toBe(paneBody);
      // Exactly one row is the selection: adding the class without moving it would leave two.
      expect(versionRows(view).filter((row) => row.classes.includes("is-selected"))).toHaveLength(
        1,
      );
    });

    it("keeps the version on screen until its replacement is drawn", async () => {
      const { plugin } = await startRenamedNote();
      const view = await openVersionHistory(plugin, "moved.md");
      await waitFor(
        () => markdownRenders.length > 0,
        "the head version's content was never rendered",
      );
      expect(paneText(view)).toContain("v2");

      // The click starts an async read. Until it lands the head's content must still be on
      // screen — an implementation that empties the body before fetching would fail here,
      // even though the node identity check above would pass.
      versionRowFor(view, "创建").click();
      expect(paneText(view)).toContain("v2");

      await waitFor(() => paneText(view).includes("v1"), "the older version was never drawn");
      expect(paneText(view)).not.toContain("v2");
    });

    it("drops a slow read when a newer version was selected", async () => {
      const { plugin, remote, fileId } = await startRenamedNote();
      const versions = await fileVersions(server, remote.id, fileId);
      const oldest = versions[0]!;
      const newest = versions.at(-1)!;
      const view = await openVersionHistory(plugin, "moved.md");
      await waitFor(() => paneText(view).includes("v2"), "the head version never rendered");

      // Hold the create version's content, then select the head on top of it: the head's
      // read lands first and the late one must be dropped rather than painted over it.
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const real = plugin.actions.getVersionContent.bind(plugin.actions);
      plugin.actions.getVersionContent = async (vaultId, contentHash) => {
        if (contentHash === oldest.contentHash) await gate;
        return await real(vaultId, contentHash);
      };
      try {
        versionRowFor(view, "创建").click();
        versionRowFor(view, "修改").click();
        await waitFor(() => paneText(view).includes("v2"), "the newer selection never rendered");
        release!();
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(paneText(view), "a stale read repainted the pane").toContain("v2");
      } finally {
        plugin.actions.getVersionContent = real;
      }
      expect(newest.action).toBe("modify");
    });

    it("reopens from a saved state, and says so when its state names no chain", async () => {
      const { plugin, app } = await startRenamedNote();
      const fileId = await trackedFileId(plugin, "moved.md");
      const vaultId = plugin.settings.connectedVaultId!;

      // A restored layout carries the target and the presentation the reader left behind.
      const leaf = app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: VERSION_HISTORY_VIEW_TYPE,
        state: {
          target: { vaultId, fileId, path: "moved.md" },
          mode: "diff",
          selected: (await fileVersions(server, plugin.settings.connectedVaultId!, fileId))[0]!
            .versionId,
        },
      });
      const restored = leaf.view as unknown as VersionHistoryView;
      await waitFor(
        () => elementsWithClass(viewContent(restored), "courier-vh-version").length === 3,
        "the saved history never rendered its versions",
      );
      await waitFor(
        () => elementsWithClass(viewContent(restored), "courier-diff-line-add").length > 0,
        "the saved presentation was not the diff",
      );

      // A state that names no chain (hand-edited, or written by an older layout) is a page
      // that explains itself instead of a throw during a workspace restore.
      const broken = app.workspace.getLeaf("tab");
      await broken.setViewState({
        type: VERSION_HISTORY_VIEW_TYPE,
        state: { target: { fileId, path: "moved.md" }, mode: "content" },
      });
      const empty = broken.view as unknown as VersionHistoryView;
      await waitFor(
        () => allText(viewContent(empty)).join(" ").length > 0,
        "the empty history never explained itself",
      );
      expect(allText(viewContent(empty)).join(" ")).toContain("没有记录");
    });

    it("explains a diff with no baseline, and one that changed nothing", async () => {
      const { plugin } = await startRenamedNote();
      const view = await openVersionHistory(plugin, "moved.md");
      const diffButton = () => elementsWithClass(viewContent(view), "courier-segmented-option")[1]!;

      // The create version has nothing before it: every line is new, and the caption says so.
      versionRowFor(view, "创建").click();
      await waitFor(
        () => selectedVersionRow(view) !== undefined && paneText(view).includes("v1"),
        "the create version never rendered",
      );
      diffButton().click();
      await waitFor(
        () => allText(viewContent(view)).join(" ").includes("最早的版本"),
        "the first version's diff never explained its empty baseline",
      );
      expect(elementsWithClass(viewContent(view), "courier-diff-line-add").length).toBeGreaterThan(
        0,
      );

      // The rename carries the same bytes as the version before it: "nothing changed" rather
      // than a page of unchanged lines that reads like a missing diff.
      versionRowFor(view, "重命名").click();
      await waitFor(
        () => allText(viewContent(view)).join(" ").includes("内容相同"),
        "an unchanged version never said so",
      );
    });

    it("compares a version with the one before it", async () => {
      const { plugin } = await startRenamedNote();
      const view = await openVersionHistory(plugin, "moved.md");

      // The head is the edit that turned `v1` into `v2`, so its diff is one removed line
      // and one added one — the "what changed" the read-only pane cannot answer.
      const modes = elementsWithClass(viewContent(view), "courier-segmented-option");
      expect(modes.map((button) => button.text)).toEqual(["完整内容", "差异"]);
      modes[1]!.click();

      await waitFor(
        () => elementsWithClass(viewContent(view), "courier-diff-line-add").length > 0,
        "the diff never rendered the added line",
      );
      const added = elementsWithClass(viewContent(view), "courier-diff-line-add")[0]!;
      expect(elementsWithClass(added, "courier-diff-text")[0]?.text).toBe("v2");
      const removed = elementsWithClass(viewContent(view), "courier-diff-line-remove")[0]!;
      expect(elementsWithClass(removed, "courier-diff-sigil")[0]?.text).toBe("−");
      expect(elementsWithClass(removed, "courier-diff-text")[0]?.text).toBe("v1");
      // The pane names what it is comparing against, so a diff is never read as "the file".
      expect(allText(viewContent(view)).join(" ")).toContain("与上一个版本");
    });

    it("offers the history from the file menu under Courier's own name", async () => {
      // The phone's entry point: a menu item that names Courier, because the app ships its
      // own "Version history" item on the same file and two identical labels are a coin toss.
      const { plugin, app } = await startRenamedNote();
      const menu = new Menu();
      const file = new TFile();
      file.path = "moved.md";
      file.name = "moved.md";
      app.workspace.emit("file-menu", menu, file);

      const entry = menu.items.find((item) => item.title === "Courier 版本历史");
      expect(entry, "the file menu has no Courier version-history item").toBeDefined();
      entry!.click();
      await waitFor(
        () => app.workspace.getLeavesOfType(VERSION_HISTORY_VIEW_TYPE).length === 1,
        "the menu item never opened the history tab",
      );
      // The tab is the file's own, so a second click activates it instead of opening another.
      entry!.click();
      await waitFor(
        () => app.workspace.getLeavesOfType(VERSION_HISTORY_VIEW_TYPE).length === 1,
        "the menu item opened a second tab for the same chain",
      );
      // `plugin` is unused by the assertions above, but its presence is what made the item
      // appear at all (a menu without a bound vault offers no history).
      expect(plugin.settings.connectedVaultId).not.toBeNull();
    });

    it("offers no history in the phone's file menu for a parked copy", async () => {
      // The phone has no hover, so its menu is the only entry point — and a parked copy has
      // no chain at all, so the item must not be there in either state. The platform is set
      // before the plugin loads, because onload is what registers the menu handler.
      Platform.isDesktop = false;
      Platform.isMobile = true;
      try {
        const { plugin, app, vault } = await startHostedPlugin(
          "Version History Phone Menu",
          async (v) => {
            await v.create("phone.md", "v1");
          },
        );
        await vault.settle();
        expect(plugin.settings.connectedVaultId).not.toBeNull();

        const conflict = new TFile();
        conflict.path = "phone-2026-02-14-101530.conflict.md";
        conflict.name = "phone-2026-02-14-101530.conflict.md";
        const conflictMenu = new Menu();
        app.workspace.emit("file-menu", conflictMenu, conflict);
        expect(conflictMenu.items.map((item) => item.title)).not.toContain("Courier 版本历史");

        // An ordinary note on the same phone menu still opens the tab.
        await trackedFileId(plugin, "phone.md");
        const note = new TFile();
        note.path = "phone.md";
        note.name = "phone.md";
        const noteMenu = new Menu();
        app.workspace.emit("file-menu", noteMenu, note);
        const entry = noteMenu.items.find((item) => item.title === "Courier 版本历史");
        expect(entry, "the phone menu lost its version-history item").toBeDefined();
        entry!.click();
        await waitFor(
          () => app.workspace.getLeavesOfType(VERSION_HISTORY_VIEW_TYPE).length === 1,
          "the phone's menu item never opened the history tab",
        );
      } finally {
        Platform.isDesktop = true;
        Platform.isMobile = false;
      }
    });

    it("offers no Courier action in the file menu for a file under an excluded folder", async () => {
      // The rule is the device's scope, not the platform: with the folder excluded the menu
      // must be empty for a note in it — including a name that looks like a parked copy the
      // engine would never park there. The **mobile** menu (the long-press, which a phone
      // has instead of the hover chips) is the L3 case that reloads a real Obsidian into
      // mobile mode; this one pins the shared handler.
      const { plugin, app, vault } = await startHostedPlugin(
        "Excluded Folder Menu",
        async (v) => {
          await v.create("private/local.md", "local");
          await v.create("public.md", "public");
        },
        { excludedFolders: ["private"] },
      );
      await vault.settle();
      expect(plugin.settings.connectedVaultId).not.toBeNull();

      for (const path of ["private/local.md", "private/local-2026-02-14-101530.conflict.md"]) {
        const menu = new Menu();
        const file = new TFile();
        file.path = path;
        file.name = path.split("/").pop() ?? path;
        app.workspace.emit("file-menu", menu, file);
        expect(
          menu.items.map((item) => item.title),
          `the file menu offered an action for ${path}`,
        ).toEqual([]);
      }

      // A note this device does sync keeps its item, so the absence above is the exclusion
      // and not a plugin whose menu handler stopped registering.
      await trackedFileId(plugin, "public.md");
      expect(menuEntryFor(app, "public.md", "Courier 版本历史")).toBeDefined();
    });

    it("marks the chain's delete row as a version with nothing to show", async () => {
      const { plugin, vault, remote } = await startHostedPlugin(
        "Version History Delete",
        async (v) => {
          await v.create("phoenix.md", "rises again");
        },
      );
      const fileId = await trackedFileId(plugin, "phoenix.md");
      const created = (await fileVersions(server, remote.id, fileId))[0];

      await vault.remove("phoenix.md");
      await vault.settle();
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).some((f) => f.fileId === fileId),
        "the delete never reached the recycle bin",
      );

      // Bring it back the way the recycle bin does, so the chain keeps a `delete` row while
      // the note exists again to open a history from.
      await engineOf(plugin).restoreFile(fileId, "phoenix.md", created.contentHash);
      await vault.settle();
      await waitFor(() => vault.read("phoenix.md") === "rises again", "the restore never landed");

      const view = await openVersionHistory(plugin, "phoenix.md");
      expect(versionActions(view)).toEqual(["恢复", "删除", "创建"]);

      // A delete version has no content on the server, so its row is a marker: it says why
      // and it is not a way into the pane.
      const deleteRow = versionRows(view).find(
        (row) => elementsWithClass(row, "courier-vh-warning").length > 0,
      );
      expect(deleteRow, "no row was marked as unrestorable").toBeDefined();
      expect(versionWarnings(view).join(" ")).toContain("删除记录，无法恢复");
      expect(deleteRow!.classes).not.toContain("is-selectable");
      // Every other row is.
      expect(versionRowFor(view, "创建").classes).toContain("is-selectable");
    });
  });

  describe("recycle bin", () => {
    /** A tiny PNG header: real bytes for the media preview to show. */
    const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

    it("lists a deleted note in the settings page's dialog and restores it from there", async () => {
      const { plugin, vault, remote } = await startHostedPlugin("Recycle Bin", async (v) => {
        await v.create("phoenix.md", "rises again");
      });
      const fileId = await trackedFileId(plugin, "phoenix.md");

      // 1. Delete it — the file must be in the recycle bin.
      await vault.remove("phoenix.md");
      await vault.settle();
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
        "the delete never reached the recycle bin",
      );
      expect(vault.read("phoenix.md")).toBeNull();

      // 2. The settings page's row opens the dialog, which lists it with the path
      //    decrypted by the vault key.
      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () => listedDeletedPaths(dialog).includes("phoenix.md"),
        "the recycle bin dialog never listed the deleted note",
      );

      // 3. Restore it through the dialog's button.
      clickRestore(dialog, "phoenix.md");

      await waitFor(
        () => vault.read("phoenix.md") === "rises again",
        "the restored note was never written back to the vault",
      );
      await waitForAsync(
        async () => (await fileVersions(server, remote.id, fileId)).at(-1)?.action === "restore",
        "the restore never reached the server",
      );
      await waitForAsync(
        async () => !(await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
        "the restored note is still in the recycle bin",
      );

      expect((await fileVersions(server, remote.id, fileId)).map((v) => v.action)).toEqual([
        "create",
        "delete",
        "restore",
      ]);
      // The engine's own write must not have left a second chain for this path.
      expect(await filesAtPath(server, remote.id, material.key, "phoenix.md")).toEqual([fileId]);
      expect(vault.paths().filter((path) => isConflictFile(path))).toEqual([]);
      expect(notices.filter((message) => message.includes("恢复失败"))).toHaveLength(0);

      // A device that never saw the restore converges.
      const peer = await newPeer(remote.id);
      await peer.sync();
      expect(peer.read("phoenix.md")).toBe("rises again");
    });

    it("renders a deleted note's content through Obsidian's own markdown renderer", async () => {
      const { plugin, vault, remote } = await startHostedPlugin(
        "Recycle Bin Preview",
        async (v) => {
          await v.create("phoenix.md", "# 标题\n\n正文");
        },
      );
      const fileId = await trackedFileId(plugin, "phoenix.md");
      await vault.remove("phoenix.md");
      await vault.settle();
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
        "the delete never reached the recycle bin",
      );

      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () => listedDeletedPaths(dialog).includes("phoenix.md"),
        "the recycle bin dialog never listed the deleted note",
      );

      // Clicking the row (not the button) shows what the delete removed.
      const preview = await modalOpenedBy(
        () => clickDeletedFile(dialog, "phoenix.md"),
        "the content dialog never opened",
      );
      await waitFor(
        () => elementsWithClass(preview.contentEl, "courier-file-preview-markdown").length > 0,
        "the deleted note was never rendered as markdown",
      );

      // The renderer was handed the note's own bytes, for the path the version records —
      // not a `<pre>` of text the plugin decoded itself.
      const rendered = markdownRenders.at(-1)!;
      expect(rendered.markdown).toBe("# 标题\n\n正文");
      expect(rendered.sourcePath).toBe("phoenix.md");

      // The header keeps the title short and puts the path in the body, where a long path
      // wraps instead of being ellipsised away in the title bar.
      expect(preview.title).toBe("文件内容");
      expect(elementsWithClass(preview.contentEl, "courier-file-preview-subject")[0]?.text).toBe(
        "phoenix.md",
      );
      expect(allText(preview.contentEl).join(" ")).toContain("删除于");

      // Looking at the content restores nothing.
      expect(await deletedFiles(server, remote.id)).toHaveLength(1);
    });

    it("plays a deleted image inline, and says what a deleted PDF is", async () => {
      const { plugin, vault, remote } = await startHostedPlugin("Recycle Bin Media", async (v) => {
        await v.createAttachment("photos/raw.png", PNG_BYTES);
        await v.createAttachment("docs/paper.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 1]));
      });
      const imageId = await trackedFileId(plugin, "photos/raw.png");
      const pdfId = await trackedFileId(plugin, "docs/paper.pdf");

      for (const path of ["photos/raw.png", "docs/paper.pdf"]) await vault.remove(path);
      await vault.settle();
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).length === 2,
        "the deletes never reached the recycle bin",
      );
      expect([imageId, pdfId].filter(Boolean)).toHaveLength(2);

      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () => listedDeletedPaths(dialog).includes("photos/raw.png"),
        "the recycle bin dialog never listed the deleted attachment",
      );

      // The image is shown as an image: a decoded PNG would be replacement characters.
      const imagePreview = await modalOpenedBy(
        () => clickDeletedFile(dialog, "photos/raw.png"),
        "the image preview never opened",
      );
      await waitFor(
        () => elementsWithClass(imagePreview.contentEl, "courier-file-preview-image").length > 0,
        "the deleted image was never rendered as an image",
      );
      const image = elementsWithClass(
        imagePreview.contentEl,
        "courier-file-preview-image",
      )[0] as unknown as { src?: string };
      // A blob URL over the decrypted bytes — revoked when the dialog closes.
      expect(image.src).toMatch(/^blob:/);
      expect(allText(imagePreview.contentEl).join(" ")).not.toContain("\uFFFD");
      imagePreview.close();

      // A PDF has no preview here (Obsidian renders PDFs with its own viewer, which needs
      // a file in the vault), so the dialog says what it is instead.
      const pdfPreview = await modalOpenedBy(
        () => clickDeletedFile(dialog, "docs/paper.pdf"),
        "the PDF's content dialog never opened",
      );
      const rendered = allText(pdfPreview.contentEl).join(" ");
      expect(rendered).toContain("二进制文件");
      expect(rendered).not.toContain("\uFFFD");
    });

    it("restores a note a peer deleted, without creating a second fileId", async () => {
      const { plugin, vault, remote } = await startHostedPlugin(
        "Peer Delete Restore",
        async (v) => {
          await v.create("gone.md", "deleted by the peer");
        },
      );
      const fileId = await trackedFileId(plugin, "gone.md");

      const peer = await newPeer(remote.id);
      await peer.sync();
      peer.remove("gone.md");
      await peer.removeAndSync("gone.md");

      // The peer's delete arrives over the websocket and is applied here, so the
      // engine has no local delete to match the file against.
      await waitFor(
        () => vault.read("gone.md") === null,
        "the plugin never applied the peer's delete",
      );
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
        "the peer's delete never reached the recycle bin",
      );

      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () => listedDeletedPaths(dialog).includes("gone.md"),
        "the recycle bin dialog never listed the peer-deleted note",
      );
      clickRestore(dialog, "gone.md");

      await waitFor(
        () => vault.read("gone.md") === "deleted by the peer",
        "the restored note was never written back to the vault",
      );
      await waitForAsync(
        async () => (await fileVersions(server, remote.id, fileId)).at(-1)?.action === "restore",
        "the restore never reached the server",
      );

      // One path, one fileId — the event the restore write fired must not have
      // been pushed as a brand new file.
      expect(await filesAtPath(server, remote.id, material.key, "gone.md")).toEqual([fileId]);
      expect(plugin.engine!.fileIdForPath("gone.md")).toBe(fileId);
      expect(vault.paths().filter((path) => isConflictFile(path))).toEqual([]);

      await peer.sync();
      expect(peer.read("gone.md")).toBe("deleted by the peer");
    });

    it("asks for a new file name when another note holds the deleted file's path", async () => {
      const { plugin, vault, remote } = await startHostedPlugin(
        "Recycle Bin Occupied",
        async (v) => {
          await v.create("hero.md", "old content");
        },
      );
      const oldFileId = await trackedFileId(plugin, "hero.md");

      // 1. Delete it — the file is in the recycle bin.
      await vault.remove("hero.md");
      await vault.settle();
      await waitForAsync(
        async () =>
          (await deletedFiles(server, remote.id)).some((file) => file.fileId === oldFileId),
        "the delete never reached the recycle bin",
      );

      // 2. Reopen the vault's host and then write a new note at the old path. A
      //    bind leaves the tombstone out of the comparison, so the new note is its
      //    own file — the state where a restore used to overwrite it and leave two
      //    chains claiming one path.
      plugin.host!.stop();
      plugin.host = null;
      await vault.create("hero.md", "new content");
      await vault.settle();
      await plugin.startHost();
      const occupantFileId = await trackedFileId(plugin, "hero.md");
      expect(occupantFileId).not.toBe(oldFileId);

      // 3. The row does not predict the collision: the click is what asks for a name.
      //    A taken path changes the name, not whether a restore is possible, so there is
      //    no warning line here and the button stays enabled.
      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () => listedDeletedPaths(dialog).includes("hero.md"),
        "the recycle bin dialog never listed the deleted note",
      );
      expect(listedWarnings(dialog)).toEqual([]);
      expect(
        restoreButton(dialog, "hero.md").disabled,
        "an occupied path disabled the restore button",
      ).toBe(false);

      // 4. The click asks for a name, pre-filled with the original plus `-1`. A name that
      //    is taken too, and one that would drop the copy out of this device's sync scope,
      //    are both answered in the dialog rather than by closing it.
      const prompt = await modalOpenedBy(
        () => clickRestore(dialog, "hero.md"),
        "no name dialog appeared",
      );
      expect(modalParagraphs(prompt).join(" ")).toContain("已经被其他文件占用");
      const field = modalTexts(prompt).at(0)!;
      expect(field.getValue()).toBe("hero-1.md");

      // An empty name and one carrying a path separator are refused in place, before the
      // vault is touched. Both are the dialog's own job: the engine would reject the path
      // only after a write was attempted.
      field.simulateChange("   ");
      clickModalButton(prompt, "恢复");
      await waitFor(
        () => allText(prompt.contentEl).join(" ").includes(t("restore.nameRequired")),
        "an empty name was accepted",
      );
      expect(prompt.isOpen, "the dialog closed instead of asking again").toBe(true);

      field.simulateChange("notes/hero.md");
      clickModalButton(prompt, "恢复");
      await waitFor(
        () => allText(prompt.contentEl).join(" ").includes(t("restore.nameSlash")),
        "a name with a separator was accepted",
      );
      expect(prompt.isOpen, "the dialog closed instead of asking again").toBe(true);

      // Dropping the extension would make the restored copy `otherTypes` (off by default):
      // it would sit in this vault while no peer ever materialised it.
      field.simulateChange("hero-1");
      clickModalButton(prompt, "恢复");
      await waitFor(
        () => allText(prompt.contentEl).join(" ").includes("不在这台设备的同步范围内"),
        "a name outside the sync scope was accepted",
      );
      expect(prompt.isOpen, "the dialog closed instead of asking again").toBe(true);

      field.simulateChange("hero.md");
      clickModalButton(prompt, "恢复");
      await waitFor(
        () => allText(prompt.contentEl).join(" ").includes("也已经被占用"),
        "a name that is taken too was not answered in the dialog",
      );
      expect(prompt.isOpen, "the dialog closed instead of asking again").toBe(true);

      field.simulateChange("hero-1.md");
      clickModalButton(prompt, "恢复");

      // 5. The content is back under the new name; the occupying note keeps both
      //    its content and its identity.
      await waitFor(
        () => plugin.engine!.fileIdForPath("hero-1.md") === oldFileId,
        "the restored copy was never tracked under its new name",
      );
      await waitForAsync(
        async () => (await fileVersions(server, remote.id, oldFileId)).at(-1)?.action === "restore",
        "the restore never reached the server",
      );
      expect(vault.read("hero-1.md")).toBe("old content");
      expect(vault.read("hero.md")).toBe("new content");
      expect(plugin.engine!.fileIdForPath("hero.md")).toBe(occupantFileId);

      // One chain per path on the server, and nothing was left in the bin.
      expect(await filesAtPath(server, remote.id, material.key, "hero.md")).toEqual([
        occupantFileId,
      ]);
      expect(await filesAtPath(server, remote.id, material.key, "hero-1.md")).toEqual([oldFileId]);
      expect(notices.filter((message) => message.includes("恢复失败"))).toHaveLength(0);
    });

    it("pushes a note recreated at a deleted path as a restore, not a conflict", async () => {
      const { plugin, vault, remote } = await startHostedPlugin(
        "Recycle Bin Recreated",
        async (v) => {
          await v.create("hero.md", "old content");
        },
      );
      const fileId = await trackedFileId(plugin, "hero.md");

      // Delete it, then write a new note at the same path while the host runs. The
      // tombstone is this device's own sync point, so a file under it can only be one
      // the user just made: a recreate, pushed as a `restore` on the same chain.
      await vault.remove("hero.md");
      await vault.settle();
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
        "the delete never reached the recycle bin",
      );
      await vault.create("hero.md", "new content");
      await vault.settle();

      await waitForAsync(
        async () => (await fileVersions(server, remote.id, fileId)).at(-1)?.action === "restore",
        "the recreated note never became a restore",
      );
      expect(vault.read("hero.md")).toBe("new content");
      expect(plugin.engine!.fileIdForPath("hero.md")).toBe(fileId);
      expect(vault.paths().filter((path) => isConflictFile(path))).toEqual([]);
      // The chain is a restore now, so the note is no longer a deletion.
      await waitForAsync(
        async () => !(await deletedFiles(server, remote.id)).some((file) => file.fileId === fileId),
        "the recreated note is still listed as deleted",
      );
    });

    it("marks a deleted chain with nothing restorable left, and disables its button", async () => {
      const { plugin, remote } = await startHostedPlugin("Recycle Bin Pruned");
      // Retention pruning removes every version but a chain's latest one, so a
      // deleted file can end up with nothing but its tombstone. Build that shape
      // directly: no client produces it on its own.
      const orphanFileId = "orphan-pruned-file";
      await pushVersion(server, remote.id, {
        fileId: orphanFileId,
        path: "orphan.md",
        key: material.key,
        action: "delete",
        versionId: "orphan-delete-only",
      });

      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () =>
          listedDeletedPaths(dialog).some((path) => path.includes(orphanFileId.substring(0, 12))),
        "the pruned chain never appeared in the recycle bin",
      );

      expect(listedWarnings(dialog).join(" ")).toContain("可恢复的版本已被清理");
      const button = buttonsIn(dialog.contentEl).find((candidate) => candidate.text === "恢复");
      expect(button, "the pruned row rendered no restore button at all").toBeDefined();
      // Disabled rather than hidden, so the row still says what it is — and a real
      // Obsidian button does not fire, which is the part the stub cannot model.
      expect(button!.disabled, "an unrestorable row was left clickable").toBe(true);
    });

    it("clears the recycle bin after a confirmation", async () => {
      const { plugin, vault, remote } = await startHostedPlugin("Recycle Bin Clear", async (v) => {
        await v.create("keeper.md", "still here");
        await v.create("gone-a.md", "a");
        await v.create("gone-b.md", "b");
      });
      const keeperId = await trackedFileId(plugin, "keeper.md");
      await waitForAsync(
        async () => (await vaultHistory(server, remote.id)).length === 3,
        "not all notes were pushed",
      );

      await vault.remove("gone-a.md");
      await vault.remove("gone-b.md");
      await vault.settle();
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).length === 2,
        "the deletes never reached the recycle bin",
      );

      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () => listedDeletedPaths(dialog).length === 2,
        "the recycle bin dialog never listed both deleted notes",
      );

      // The warning belongs to the footer that owns the clear button: the phone layout
      // stacks the two, so the hint must be rendered with the rows, not dropped.
      const footer = elementsWithClass(dialog.contentEl, "courier-recycle-bin-footer")[0];
      expect(footer, "the dialog rendered no footer").toBeDefined();
      expect(footer.style.display).toBe("flex");
      const footerHint = elementsWithClass(footer, "courier-recycle-bin-footer-hint")[0];
      expect(footerHint?.text).toBe(t("dialog.recycleBin.footerHint"));

      const clearButton = buttonsIn(dialog.contentEl).find(
        (candidate) => candidate.text === "清空回收站",
      );
      expect(clearButton, "the dialog offered no way to clear the bin").toBeDefined();

      const confirm = await modalOpenedBy(
        () => clearButton!.click(),
        "no clear confirmation appeared",
      );
      expect(confirm.title).toBe("清空回收站");
      expect(modalParagraphs(confirm).join(" ")).toContain("2 个文件");
      clickModalButton(confirm, "永久删除");

      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).length === 0,
        "the cleared chains are still in the recycle bin",
      );
      await waitFor(
        () => listedDeletedPaths(dialog).length === 0,
        "the dialog still lists the cleared notes",
      );
      // The one note that was never deleted keeps its chain.
      expect((await fileVersions(server, remote.id, keeperId)).length).toBeGreaterThan(0);
      expect(vault.read("keeper.md")).toBe("still here");
      // The emptied list is the confirmation; there is no "已清空回收站" toast.
    });

    it("lists the newest deletion first, and re-reads the bin from the header's control", async () => {
      const { plugin, vault, remote } = await startHostedPlugin(
        "Recycle Bin Refresh",
        async (v) => {
          await v.create("first.md", "first");
          await v.create("second.md", "second");
        },
      );
      await waitForAsync(
        async () => (await vaultHistory(server, remote.id)).length === 2,
        "not all notes were pushed",
      );

      // One deletion at a time, each acknowledged by the server before the next: the
      // order the dialog sorts by must be the order the server recorded, not a race
      // between two pushes fired in the same tick.
      await vault.remove("first.md");
      await vault.settle();
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).length === 1,
        "the first delete never reached the recycle bin",
      );
      await vault.remove("second.md");
      await vault.settle();
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).length === 2,
        "the second delete never reached the recycle bin",
      );

      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () => listedDeletedPaths(dialog).length === 2,
        "the recycle bin dialog never listed both deleted notes",
      );
      expect(listedDeletedPaths(dialog)).toEqual(["second.md", "first.md"]);

      // The header's icon-only control is the only way to re-read the bin, and the
      // request log is what proves the click went to the server rather than to a cache.
      const before = requestsMatching(/\/sync\/deleted$/).length;
      const refresh = extraButtonsIn(dialog.contentEl).find(
        (button) => button.tooltip === "刷新回收站",
      );
      expect(refresh, "the header offered no refresh control").toBeDefined();

      // A re-read repaints in place: the rows on screen stay there until the new list is in
      // hand. Emptying the list for the skeleton (or for an empty frame that fills in row by
      // row) is the flash this pins — the desktop and the phone share this dialog.
      const list = elementsWithClass(dialog.contentEl, "courier-recycle-bin-list")[0];
      expect(list, "the dialog rendered no list").toBeDefined();
      const footer = elementsWithClass(dialog.contentEl, "courier-recycle-bin-footer")[0];
      expect(footer, "the dialog rendered no footer").toBeDefined();
      list.scrollTop = 90;
      refresh!.click();

      // Nothing was torn down, from the count over the list to the footer that owns 清空回收站.
      expect(listedDeletedPaths(dialog)).toEqual(["second.md", "first.md"]);
      expect(elementsWithClass(dialog.contentEl, "courier-recycle-bin-skeleton")).toEqual([]);
      expect(elementsWithClass(dialog.contentEl, "courier-recycle-bin-status")).toEqual([]);
      expect(elementsWithClass(dialog.contentEl, "courier-recycle-bin-count")[0]?.text).toBe("2");
      expect(footer.style.display).toBe("flex");
      // …and the header's control is what says the read is running, for the eye and for a
      // screen reader (which cannot see the icon turn).
      expect(dialog.contentEl.classes).toContain("is-refreshing");
      expect(list.getAttribute("aria-busy")).toBe("true");

      await waitForAsync(
        async () => requestsMatching(/\/sync\/deleted$/).length > before,
        "the refresh control never re-read the recycle bin",
      );
      await waitFor(
        () => !dialog.contentEl.classes.includes("is-refreshing"),
        "the refresh never settled",
      );
      expect(listedDeletedPaths(dialog)).toEqual(["second.md", "first.md"]);
      // The list was replaced under the reader, not scrolled back to the top.
      expect(list.scrollTop).toBe(90);
      expect(list.getAttribute("aria-busy")).toBe("false");
    });

    it("shows the skeleton only while the first read runs", async () => {
      const { plugin, vault, remote } = await startHostedPlugin(
        "Recycle Bin Skeleton",
        async (v) => {
          await v.create("gone.md", "gone");
        },
      );
      await vault.remove("gone.md");
      await vault.settle();
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).length === 1,
        "the delete never reached the recycle bin",
      );

      // Hold the first read, so the state the dialog is in while it runs is observable
      // without racing the answer: the skeleton and the loading line are what a first read
      // looks like, and they must not come back for a re-read.
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const real = plugin.actions.listDeleted.bind(plugin.actions);
      plugin.actions.listDeleted = async (vaultId: string) => {
        await gate;
        return await real(vaultId);
      };
      try {
        const dialog = await openRecycleBin(plugin);
        // The rule is "a skeleton while the first read runs", not its row count.
        expect(
          elementsWithClass(dialog.contentEl, "courier-recycle-bin-skeleton").length,
        ).toBeGreaterThan(0);
        expect(listedDeletedPaths(dialog)).toEqual([]);
        expect(elementsWithClass(dialog.contentEl, "courier-recycle-bin-status")[0]?.text).toBe(
          t("dialog.recycleBin.loading"),
        );
        const footer = elementsWithClass(dialog.contentEl, "courier-recycle-bin-footer")[0];
        expect(footer, "the dialog rendered no footer").toBeDefined();
        expect(footer.style.display).toBe("none");

        release!();
        await waitFor(
          () => listedDeletedPaths(dialog).includes("gone.md"),
          "the first read never landed",
        );
        expect(elementsWithClass(dialog.contentEl, "courier-recycle-bin-skeleton")).toEqual([]);
        expect(footer.style.display).toBe("flex");
      } finally {
        plugin.actions.listDeleted = real;
      }
    });

    it("drops a slow re-read when a newer one replaced it", async () => {
      const { plugin, vault, remote } = await startHostedPlugin(
        "Recycle Bin Stale Read",
        async (v) => {
          await v.create("first.md", "first");
          await v.create("second.md", "second");
        },
      );
      await waitForAsync(
        async () => (await vaultHistory(server, remote.id)).length === 2,
        "not all notes were pushed",
      );
      for (const path of ["first.md", "second.md"]) {
        await vault.remove(path);
        await vault.settle();
      }
      await waitForAsync(
        async () => (await deletedFiles(server, remote.id)).length === 2,
        "the deletes never reached the recycle bin",
      );

      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () => listedDeletedPaths(dialog).length === 2,
        "the recycle bin dialog never listed both deleted notes",
      );
      // What the reader is looking at, whatever order the two deletes were recorded in:
      // this case is about the stale paint, not about the sort.
      const listed = listedDeletedPaths(dialog);
      const refresh = extraButtonsIn(dialog.contentEl).find(
        (button) => button.tooltip === "刷新回收站",
      );
      expect(refresh, "the header offered no refresh control").toBeDefined();

      // Hold the first re-read, then let a second one land on top of it. The held answer
      // comes back with an empty bin, so a stale paint would be unmistakable.
      let release: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const real = plugin.actions.listDeleted.bind(plugin.actions);
      let calls = 0;
      plugin.actions.listDeleted = async (vaultId: string) => {
        calls += 1;
        if (calls === 1) {
          await gate;
          return { files: [] };
        }
        return await real(vaultId);
      };
      try {
        refresh!.click();
        refresh!.click();
        await waitFor(
          () => !dialog.contentEl.classes.includes("is-refreshing"),
          "the newer read never settled",
        );
        release!();
        // The stale answer runs on a microtask after the release; nothing is awaited on the
        // other side of it, so this only has to outlast that continuation.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(listedDeletedPaths(dialog), "a stale read repainted the bin").toEqual(listed);
      } finally {
        plugin.actions.listDeleted = real;
      }
    });

    it("shows the empty state, with the footer gone, when nothing was deleted", async () => {
      const { plugin } = await startHostedPlugin("Recycle Bin Empty", async () => {});
      const dialog = await openRecycleBin(plugin);
      await waitFor(
        () => elementsWithClass(dialog.contentEl, "courier-recycle-bin-placeholder").length === 1,
        "the empty recycle bin never rendered its placeholder",
      );
      expect(listedDeletedPaths(dialog)).toEqual([]);
      const footer = elementsWithClass(dialog.contentEl, "courier-recycle-bin-footer")[0];
      expect(footer, "the dialog rendered no footer element").toBeDefined();
      expect(footer.style.display).toBe("none");

      // Refreshing an empty bin goes through the placeholder, not back through the skeleton.
      const refresh = extraButtonsIn(dialog.contentEl).find(
        (button) => button.tooltip === "刷新回收站",
      );
      expect(refresh, "the header offered no refresh control").toBeDefined();
      const before = requestsMatching(/\/sync\/deleted$/).length;
      refresh!.click();
      expect(elementsWithClass(dialog.contentEl, "courier-recycle-bin-skeleton")).toEqual([]);
      expect(elementsWithClass(dialog.contentEl, "courier-recycle-bin-placeholder")).toHaveLength(
        1,
      );

      await waitForAsync(
        async () => requestsMatching(/\/sync\/deleted$/).length > before,
        "the refresh control never re-read an empty recycle bin",
      );
      await waitFor(
        () => !dialog.contentEl.classes.includes("is-refreshing"),
        "the refresh never settled",
      );
      expect(elementsWithClass(dialog.contentEl, "courier-recycle-bin-placeholder")).toHaveLength(
        1,
      );
    });
  });

  it("pulls a peer's edit of a known file over the websocket", async () => {
    const { vault, remote } = await startHostedPlugin("Live Pull", async (v) => {
      await v.create("shared.md", "base");
    });
    const peer = await newPeer(remote.id);

    await peer.sync();
    peer.write("shared.md", "edited on the peer");
    await peer.change("shared.md");

    // No reconcile call: the push notification alone drives the pull.
    await waitFor(
      () => vault.read("shared.md") === "edited on the peer",
      "the websocket notification never pulled the peer's edit",
    );
  });

  it("unwires vault events and stops the engine on unload", async () => {
    const { plugin, vault } = await startHostedPlugin("Unload");

    expect(vault.listenerCount).toBeGreaterThanOrEqual(4);

    plugin.onunload();

    expect(vault.listenerCount).toBe(0);
    expect(plugin.host).toBeNull();
    expect(plugin.engine).toBeNull();
  });

  it("clears the binding and persists when the user disconnects", async () => {
    const { plugin } = await startHostedPlugin("Disconnect");
    // A connected vault normally has a credential on this device.
    setLocalStorage(VAULT_CREDENTIAL_KEY, {
      vaultId: plugin.settings.connectedVaultId,
      encryptionKeyB64: "a2V5",
    });
    // A pause belongs to the binding, so it must go with it.
    plugin.settings.syncPaused = true;

    await plugin.disconnectVault();

    expect(plugin.host).toBeNull();
    expect(plugin.settings.connectedVaultId).toBeNull();
    expect(plugin.settings.encryptionSalt).toBeNull();
    expect(plugin.settings.syncPaused).toBe(false);
    expect(plugin.settings.syncState).toBeUndefined();
    // Disconnecting must also forget the key on this device.
    expect(loadLocalStorage(VAULT_CREDENTIAL_KEY)).toBeNull();
    const persisted = (await plugin.loadData()) as CourierSettings;
    expect(persisted.connectedVaultId).toBeNull();
    // The page returning to 选择远程库 is the confirmation; no toast accompanies it.
    expect(notices).toEqual([]);
  });

  it("persists a device rename locally, with no server round trip", async () => {
    const { plugin, remote } = await startHostedPlugin("Device Rename");

    await plugin.setDeviceName("  Study Laptop  ");

    expect(plugin.settings.deviceName).toBe("Study Laptop");
    expect(((await plugin.loadData()) as { deviceName?: string }).deviceName).toBe("Study Laptop");
    // The per-vault record is the value a later reconnect restores.
    expect(plugin.settings.vaultConnections[remote.id]).toEqual({
      deviceName: "Study Laptop",
      excludedFolders: [],
    });
    // An empty or blank name falls back to the default label rather than shipping "".
    await plugin.setDeviceName("   ");
    expect(plugin.settings.deviceName).toBe("My Device");
    expect(plugin.settings.vaultConnections[remote.id]).toEqual({
      deviceName: "My Device",
      excludedFolders: [],
    });
  });

  /**
   * The conflict behaviour itself lives in the engine, and the platform no longer
   * changes it: desktop and mobile both take the remote version and park the local
   * one. What the plugin contributes is the notice — one line per burst, never a
   * dialog waiting for a decision.
   */
  it("resolves a conflict the same way on mobile, and says so once", async () => {
    Platform.isDesktop = false;
    Platform.isMobile = true;

    const remote = await createTestVault(server, "Mobile Conflict", material);
    const peer = await newPeer(remote.id);
    peer.write("shared.md", "remote version");
    await peer.sync();
    await peer.change("shared.md");

    const vault = new FakeVault();
    await vault.create("shared.md", "local version");
    const { plugin } = await loadPlugin({
      vault,
      settings: { connectedVaultId: remote.id, connectedVaultName: remote.name },
    });
    plugin.encryptionKey = material.key;
    await plugin.startHost();

    // The remote head wins, the phone's own note is beside it, and the bind pushed
    // nothing — no dialog, no pending decision.
    expect(vault.read("shared.md")).toBe("remote version");
    const parked = conflictCopyOf(vault.paths(), "shared.md")!;
    expect(vault.read(parked)).toBe("local version");
    await waitFor(
      () => notices.some((message) => message.includes(parked)),
      "the plugin never reported the parked conflict",
    );
  });

  /**
   * The parked copy is not a dead end: its own file offers the comparison a note can be
   * read with, and the whole-file action a binary needs. Both are local surfaces — no
   * vault key, no engine — and the one write goes through Obsidian's vault API, so the
   * engine sees an ordinary user edit and pushes it under its own rules.
   */
  describe("conflict copies: compare and replace", () => {
    /** The prose a comparison tab shows (the stub records `text` on its child elements). */
    function viewParagraphs(view: ConflictDiffView): string[] {
      return viewContent(view)
        .children.map((child) => child.text)
        .filter(Boolean);
    }

    /**
     * Open the comparison for `conflictPath` through the file menu and return its view —
     * whether this created the tab or activated the one that already compares that copy.
     *
     * The view is found by the copy it compares, not by "the newest tab": reopening a copy
     * must land on its own tab, and that is exactly what this lookup pins.
     */
    async function openDiff(
      app: FakeApp,
      conflictPath: string,
      message = "the comparison tab never opened",
    ): Promise<ConflictDiffView> {
      const before = diffLeaves(app).length;
      menuEntryFor(app, conflictPath, "对比冲突副本与原文件").click();
      await waitFor(
        () => diffLeaves(app).length > before || diffLeaves(app).some((leaf) => leaf.isActive),
        message,
      );
      const leaf = diffLeaves(app).find(
        (candidate) =>
          (candidate.view as unknown as ConflictDiffView | null)?.comparedTarget?.conflictPath ===
          conflictPath,
      );
      if (!leaf?.view) throw new Error(message);
      return leaf.view as unknown as ConflictDiffView;
    }

    /** Every line of text the fake DOM holds, for "does it say this anywhere" assertions. */
    function renderedText(root: FakeEl): string {
      return allText(root).join("\n");
    }

    /**
     * A bound plugin whose vault already diverged from the peer's note, so the bind parks
     * the local version beside it. This is the shape a user finds on disk: the peer's
     * content at the note's path, this device's own copy under a timestamp.
     */
    async function parkedMarkdownConflict(
      vaultName: string,
      local: string,
      remote: string,
    ): Promise<{
      plugin: CourierPlugin;
      vault: FakeVault;
      app: FakeApp;
      remote: TestVault;
      peer: TestClient;
      parked: string;
    }> {
      const remoteVault = await createTestVault(server, vaultName, material);
      const peer = await newPeer(remoteVault.id);
      peer.write("shared.md", remote);
      await peer.sync();
      await peer.change("shared.md");

      const vault = new FakeVault();
      await vault.create("shared.md", local);
      const { plugin, app } = await loadPlugin({
        vault,
        settings: { connectedVaultId: remoteVault.id, connectedVaultName: remoteVault.name },
      });
      plugin.encryptionKey = material.key;
      await plugin.startHost();

      await waitFor(
        () => vault.paths().some((path) => isConflictFile(path)),
        "the bind never parked a conflict copy",
      );
      const parked = conflictCopyOf(vault.paths(), "shared.md");
      if (!parked) throw new Error("no parked copy for shared.md");
      return { plugin, vault, app, remote: remoteVault, peer, parked };
    }

    it("diffs a markdown copy against the file it was parked beside", async () => {
      const { vault, app, parked } = await parkedMarkdownConflict(
        "Conflict Diff",
        "# Title\nold line\nshared\n",
        "# Title\nnew line\nshared\n",
      );

      const entry = menuEntryFor(app, parked, "对比冲突副本与原文件");
      expect(entry.icon).toBe("diff");

      const view = await openDiff(app, parked);
      await waitFor(
        () => elementsWithClass(viewContent(view), "courier-diff-row-change").length > 0,
        "the diff never rendered a changed row",
      );

      // The comparison is a main-area tab, not a dialog: it carries the leaf's state so a
      // saved layout can restore it, and its title/tooltip name the copy it compares.
      const leaves = diffLeaves(app);
      expect(leaves).toHaveLength(1);
      expect(leaves[0].state).toMatchObject({
        type: CONFLICT_DIFF_VIEW_TYPE,
        state: { target: { conflictPath: parked, originalPath: "shared.md" }, mode: "split" },
      });
      expect(leaves[0].isActive, "the comparison tab was not activated").toBe(true);
      expect(view.getViewType()).toBe(CONFLICT_DIFF_VIEW_TYPE);
      expect(view.getDisplayText()).toBe(parked);
      expect(view.getIcon()).toBe("diff");

      // Each file is named above the content it belongs to, and nothing else is shown.
      expect(renderedText(viewContent(view))).toContain(parked);
      expect(renderedText(viewContent(view))).toContain("shared.md");

      const changes = elementsWithClass(viewContent(view), "courier-diff-row-change");
      expect(changes).toHaveLength(1);
      // Left is the parked copy, right is what the note says now.
      expect(sideText(changes[0], "left")).toBe("old line");
      expect(sideText(changes[0], "right")).toBe("new line");

      // The header: the note's name, the copy under it, and how much differs.
      expect(
        elementsWithClass(viewContent(view), "courier-conflict-diff-title-text")[0]?.text,
      ).toBe("shared.md");
      expect(elementsWithClass(viewContent(view), "courier-conflict-diff-subtitle")[0]?.text).toBe(
        parked,
      );
      expect(
        elementsWithClass(viewContent(view), "courier-conflict-diff-stat").map((s) => s.text),
      ).toEqual(["+1", "−1"]);

      // No merge and no "open the files" actions: the layout picker and the one write, both in
      // the header. A tab is closed by its own tab header, not by a button in the page.
      const header = elementsWithClass(viewContent(view), "courier-conflict-diff-header")[0]!;
      const headerButtons = buttonsIn(header);
      expect(headerButtons.map((button) => button.text)).toEqual(["用冲突副本替换当前文件"]);
      // The header is the whole surface that holds controls: the rows below it, and nothing else.
      expect(buttonsIn(viewContent(view)).map((button) => button.text)).toEqual([
        "用冲突副本替换当前文件",
      ]);

      // 并排 / 统一 is the shared segmented control: one track, both states in it, the chosen
      // one raised. The same shape the version history's 完整内容 / 差异 uses.
      const segments = elementsWithClass(header, "courier-segmented-option");
      expect(segments.map((segment) => segment.text)).toEqual(["并排", "统一"]);
      expect(segments[0]!.classes).toContain("is-active");
      // The row's own label is not drawn (the header has one line to keep), so the control has
      // to carry it: two words alone do not say what they choose.
      expect(elementsWithClass(header, "courier-segmented")[0]?.getAttribute("aria-label")).toBe(
        "布局",
      );

      // The unified presentation of the same row model: a removal then an addition, each line
      // carrying its own `−`/`+` in its own element, exactly like the split view's cells.
      segments[1]!.click();
      const unifiedLine = (cls: string) => {
        const line = elementsWithClass(viewContent(view), cls)[0];
        if (!line) return null;
        return {
          sigil: elementsWithClass(line, "courier-diff-sigil")[0]?.text,
          text: elementsWithClass(line, "courier-diff-text")[0]?.text,
        };
      };
      expect(unifiedLine("courier-diff-line-remove")).toEqual({ sigil: "−", text: "old line" });
      expect(unifiedLine("courier-diff-line-add")).toEqual({ sigil: "+", text: "new line" });

      // Reading the comparison changes nothing.
      expect(vault.read("shared.md")).toBe("# Title\nnew line\nshared\n");
    });

    it("offers the conflict actions in the phone's file menu", async () => {
      // A phone has no hover, so it has no file-explorer chips: the long-press file menu is
      // the only entry point a parked copy has, and it must offer the same two actions the
      // desktop's menu does — each with the icon the menu draws.
      Platform.isDesktop = false;
      Platform.isMobile = true;
      Platform.isPhone = true;
      try {
        const { app } = await loadPlugin({ vault: new FakeVault() });

        const textCopy = menuEntryFor(
          app,
          "notes/plan-2026-02-14-101530.conflict.md",
          "对比冲突副本与原文件",
        );
        expect(textCopy.icon).toBe("diff");

        const binaryCopy = menuEntryFor(
          app,
          "photos/raw-2026-02-14-101530.conflict.png",
          "用冲突副本替换当前文件",
        );
        expect(binaryCopy.icon).toBe("replace");
      } finally {
        Platform.isDesktop = true;
        Platform.isMobile = false;
        Platform.isPhone = false;
      }
    });

    it("opens a phone comparison in one column, with the two sides named", async () => {
      // The phone's page is one column: the unified stream is the default, the header becomes
      // a card with the icon tile, and a legend names the two sides the columns used to name.
      Platform.isDesktop = false;
      Platform.isMobile = true;
      Platform.isPhone = true;
      try {
        const { app, parked } = await parkedMarkdownConflict(
          "Conflict Diff Phone",
          "# Title\nold line\nshared\n",
          "# Title\nnew line\nshared\n",
        );

        const view = await openDiff(app, parked);
        await waitFor(
          () => elementsWithClass(viewContent(view), "courier-diff-line-remove").length > 0,
          "the phone comparison never rendered the unified stream",
        );

        // The tab's own state chooses the unified presentation, so a restored layout comes
        // back the way the phone showed it.
        expect(diffLeaves(app)[0].state).toMatchObject({
          type: CONFLICT_DIFF_VIEW_TYPE,
          state: { target: { conflictPath: parked, originalPath: "shared.md" }, mode: "unified" },
        });
        expect(elementsWithClass(viewContent(view), "courier-diff-row-change")).toEqual([]);
        const removed = elementsWithClass(viewContent(view), "courier-diff-line-remove")[0]!;
        expect(elementsWithClass(removed, "courier-diff-text")[0]?.text).toBe("old line");
        const added = elementsWithClass(viewContent(view), "courier-diff-line-add")[0]!;
        expect(elementsWithClass(added, "courier-diff-text")[0]?.text).toBe("new line");

        // The tile and legend are shared markup (the CSS shows them on a phone); what this
        // pins is that the platform default reaches the tab's state and that the phone's page
        // is built around them. The visual half is preview/L4 territory.
        expect(
          parseConflictDiffState({
            target: { conflictPath: parked, originalPath: "shared.md" },
          })?.mode,
        ).toBe("unified");

        // The title block carries the diff tile the phone lays out beside the two names.
        expect(elementsWithClass(viewContent(view), "courier-conflict-diff-icon")[0]?.icon).toBe(
          "diff",
        );

        // The legend says which side is which in the colours the lines use.
        const legend = elementsWithClass(viewContent(view), "courier-conflict-diff-legend")[0]!;
        expect(legend.classes).toContain("is-unified");
        expect(allText(legend)).toEqual(["−", "冲突副本", "+", "当前文件"]);

        // The write is still the page's one action, now in the header's full-width band.
        expect(buttonsIn(viewContent(view)).map((button) => button.text)).toEqual([
          "用冲突副本替换当前文件",
        ]);

        // The presentation is the tab's own state: switching it is what a restored layout must
        // come back with, rather than the platform default being re-applied on every open.
        elementsWithClass(viewContent(view), "courier-segmented-option")[0]!.click();
        expect(view.getState()).toMatchObject({ mode: "split" });
        expect(
          await openDiff(app, parked, "reopening the phone comparison opened a second tab"),
        ).toBe(view);
        expect(
          elementsWithClass(viewContent(view), "courier-segmented-option")[0]!.classes,
          "reopening reset the phone comparison's layout choice",
        ).toContain("is-active");
      } finally {
        Platform.isDesktop = true;
        Platform.isMobile = false;
        Platform.isPhone = false;
      }
    });

    it("names the missing original on a phone, with only the restore action", async () => {
      // An orphan copy — the file it was parked beside is gone — is a first-class state: the
      // phone shows the same one-sentence page, its one restore action, and no table or legend.
      Platform.isDesktop = false;
      Platform.isMobile = true;
      Platform.isPhone = true;
      try {
        const vault = new FakeVault();
        await vault.create("orphan-2026-10-28-004000.conflict.md", "still here\n");
        const { app } = await loadPlugin({ vault });

        const view = await openDiff(app, "orphan-2026-10-28-004000.conflict.md");
        await waitFor(
          () => renderedText(viewContent(view)).includes("找不到原文件「orphan.md」"),
          "the phone comparison did not report the missing original",
        );
        expect(viewParagraphs(view)).toEqual([
          "找不到原文件「orphan.md」：它可能已被改名或删除，无法对比。",
        ]);
        expect(elementsWithClass(viewContent(view), "courier-diff-row")).toEqual([]);
        expect(elementsWithClass(viewContent(view), "courier-conflict-diff-legend")).toEqual([]);
        expect(buttonsIn(viewContent(view)).map((button) => button.text)).toEqual(["恢复为原文件"]);
      } finally {
        Platform.isDesktop = true;
        Platform.isMobile = false;
        Platform.isPhone = false;
      }
    });

    it("replaces a binary copy from the phone's file menu", async () => {
      // The phone's replace entry has to reach the same write, not just exist: the confirmation
      // and the vault write are one shared path, so this pins the two that meet on a phone.
      Platform.isDesktop = false;
      Platform.isMobile = true;
      Platform.isPhone = true;
      try {
        const remoteVault = await createTestVault(server, "Conflict Replace Phone", material);
        const peer = await newPeer(remoteVault.id);
        peer.writeBinary("photo.png", new Uint8Array([1, 2, 3, 4]));
        await peer.sync();
        await peer.change("photo.png");

        const vault = new FakeVault();
        const localBytes = new Uint8Array([9, 8, 7, 6]);
        await vault.createAttachment("photo.png", localBytes);
        const { plugin, app } = await loadPlugin({
          vault,
          settings: { connectedVaultId: remoteVault.id, connectedVaultName: remoteVault.name },
        });
        plugin.encryptionKey = material.key;
        await plugin.startHost();
        await waitFor(
          () => vault.paths().some((path) => isConflictFile(path)),
          "the bind never parked a binary conflict copy",
        );
        const parked = conflictCopyOf(vault.paths(), "photo.png")!;

        const modal = await modalOpenedBy(
          () => menuEntryFor(app, parked, "用冲突副本替换当前文件").click(),
          "the phone's replace dialog never opened",
        );
        expect(modalToggles(modal)[0]?.getValue()).toBe(false);
        clickModalButton(modal, "替换");

        await waitForAsync(
          async () =>
            Array.from(await bytesAt(vault, "photo.png")).join(",") ===
            Array.from(localBytes).join(","),
          "the phone's replace never wrote the copy's bytes over the original",
        );
      } finally {
        Platform.isDesktop = true;
        Platform.isMobile = false;
        Platform.isPhone = false;
      }
    });

    it("says why a comparison tab it cannot restore is empty", async () => {
      // A layout can be saved, hand-edited or restored by an older version: the state is a
      // boundary, so the view has to render something that says what is missing instead of
      // throwing during a workspace restore.
      const { app } = await loadPlugin({ vault: new FakeVault() });
      const leaf = app.workspace.getLeaf("tab");
      await leaf.setViewState({
        type: CONFLICT_DIFF_VIEW_TYPE,
        state: { target: { conflictPath: "", originalPath: "" }, mode: "sideways" },
      });
      const view = leaf.view as unknown as ConflictDiffView;

      await waitFor(
        () => viewParagraphs(view).length === 1,
        "the empty comparison did not explain itself",
      );
      expect(viewParagraphs(view)).toEqual([
        "这个对比没有记录要比较的文件，请从冲突副本重新打开。",
      ]);
      // Nothing to compare means no table, no layout picker and no write — just the reason.
      expect(elementsWithClass(viewContent(view), "courier-segmented")).toEqual([]);
      expect(buttonsIn(viewContent(view))).toEqual([]);
      expect(view.getDisplayText()).toBe("对比冲突副本");

      (leaf as unknown as { detach(): void }).detach();
    });

    it("follows a file edited while the comparison is open", async () => {
      const { vault, app, parked } = await parkedMarkdownConflict(
        "Conflict Diff Live",
        "one\n",
        "two\n",
      );

      const view = await openDiff(app, parked);
      await waitFor(
        () => elementsWithClass(viewContent(view), "courier-diff-row-change").length > 0,
        "the diff never rendered",
      );

      // The note is edited in another pane: the tab re-reads on the vault event.
      await vault.modify("shared.md", "three\n");
      await waitFor(
        () =>
          elementsWithClass(viewContent(view), "courier-diff-row-change").some(
            (row) => sideText(row, "right") === "three",
          ),
        "the diff did not follow the edit",
      );

      // Asking for the same copy again activates the tab it already has instead of stacking
      // a second one, and leaves the reader's presentation choice alone.
      elementsWithClass(viewContent(view), "courier-segmented-option")[1]!.click();
      expect(diffLeaves(app)).toHaveLength(1);
      expect(await openDiff(app, parked, "the second click did not reuse the tab")).toBe(view);
      expect(diffLeaves(app)).toHaveLength(1);
      expect(
        elementsWithClass(viewContent(view), "courier-segmented-option")[1]?.classes,
        "reopening reset the presentation choice",
      ).toContain("is-active");

      // The copy goes while the comparison is up: it says which file is gone and stops,
      // instead of leaving half a comparison table behind.
      await vault.remove(parked);
      await waitFor(
        () =>
          viewParagraphs(view).length === 1 &&
          viewParagraphs(view)[0]!.includes("找不到这个冲突副本"),
        "the comparison did not report the missing copy",
      );
      expect(elementsWithClass(viewContent(view), "courier-diff-row")).toEqual([]);

      // A comparison tab closes like any other tab. Closing it is the app's own tab header, so
      // the view only has to take its vault listeners with it.
      (diffLeaves(app)[0] as unknown as { detach(): void }).detach();
      await waitFor(() => diffLeaves(app).length === 0, "the comparison tab did not close");
    });

    it("gives each parked copy its own comparison tab", async () => {
      const remoteVault = await createTestVault(server, "Conflict Diff Two Tabs", material);
      const peer = await newPeer(remoteVault.id);
      peer.write("first.md", "peer one\n");
      peer.write("second.md", "peer two\n");
      await peer.sync();
      await peer.change("first.md");
      await peer.change("second.md");

      const vault = new FakeVault();
      await vault.create("first.md", "local one\n");
      await vault.create("second.md", "local two\n");
      const { plugin, app } = await loadPlugin({
        vault,
        settings: { connectedVaultId: remoteVault.id, connectedVaultName: remoteVault.name },
      });
      plugin.encryptionKey = material.key;
      await plugin.startHost();
      await waitFor(
        () => vault.paths().filter((path) => isConflictFile(path)).length === 2,
        "the bind never parked both conflict copies",
      );
      const first = conflictCopyOf(vault.paths(), "first.md");
      const second = conflictCopyOf(vault.paths(), "second.md");
      if (!first || !second) throw new Error("the bind did not park both copies");

      // Two different copies are two different comparisons: one tab each, named by the copy.
      expect(await openDiff(app, first)).not.toBe(await openDiff(app, second));
      const leaves = diffLeaves(app);
      expect(leaves).toHaveLength(2);
      expect(leaves.map((leaf) => leaf.view?.getDisplayText())).toEqual([first, second]);

      // Reopening the first activates its tab and leaves the second alone. The leaf
      // types its view as `View`; the diff view is the object that leaf holds.
      const firstView = leaves[0]!.view as unknown as ConflictDiffView;
      expect(firstView).toBe(await openDiff(app, first));
      expect(diffLeaves(app)).toHaveLength(2);
      expect(diffLeaves(app)[1].view?.isOpen).toBe(true);
    });

    it("replaces the original with a binary copy, keeping the copy", async () => {
      const remoteVault = await createTestVault(server, "Conflict Replace", material);
      const peer = await newPeer(remoteVault.id);
      const peerBytes = new Uint8Array([1, 2, 3, 4]);
      peer.writeBinary("photo.png", peerBytes);
      await peer.sync();
      await peer.change("photo.png");

      const vault = new FakeVault();
      const localBytes = new Uint8Array([9, 8, 7, 6]);
      await vault.createAttachment("photo.png", localBytes);
      const { plugin, app } = await loadPlugin({
        vault,
        settings: { connectedVaultId: remoteVault.id, connectedVaultName: remoteVault.name },
      });
      plugin.encryptionKey = material.key;
      await plugin.startHost();
      await waitFor(
        () => vault.paths().some((path) => isConflictFile(path)),
        "the bind never parked a binary conflict copy",
      );

      const parked = conflictCopyOf(vault.paths(), "photo.png")!;
      expect(parked.endsWith(".conflict.png")).toBe(true);
      const fileId = await trackedFileId(plugin, "photo.png");
      const before = (await fileVersions(server, remoteVault.id, fileId)).length;

      // A binary copy offers the whole-file action, not a diff.
      const entry = menuEntryFor(app, parked, "用冲突副本替换当前文件");
      expect(entry.icon).toBe("replace");
      const modal = await modalOpenedBy(() => entry.click(), "the replace dialog never opened");
      // One sentence and one choice — no paths-and-sizes block to read through.
      expect(modalParagraphs(modal)).toEqual(["将用冲突副本覆盖「photo.png」。"]);
      const deleteToggles = modalToggles(modal);
      expect(deleteToggles, "the dialog offered no 替换后删除冲突副本 choice").toHaveLength(1);
      expect(deleteToggles[0]!.getValue()).toBe(false);

      // Cancelling writes nothing.
      clickModalButton(modal, "取消");
      expect(await bytesAt(vault, "photo.png")).toEqual(peerBytes);

      const confirming = await modalOpenedBy(
        () => entry.click(),
        "the replace dialog never opened again",
      );
      clickModalButton(confirming, "替换");

      await waitForAsync(
        async () =>
          Array.from(await bytesAt(vault, "photo.png")).join(",") ===
          Array.from(localBytes).join(","),
        "the replace never wrote the copy's bytes over the original",
      );
      // The copy is the record of the version that lost, so the default keeps it.
      expect(await bytesAt(vault, parked)).toEqual(localBytes);
      // The write is the visible result: a success notice would only repeat the file
      // changing under the user.
      expect(notices.some((message) => message.includes("已用冲突副本替换"))).toBe(false);
      // The write is an ordinary local edit: the engine pushes it to the server.
      await waitForAsync(
        async () => (await fileVersions(server, remoteVault.id, fileId)).length > before,
        "the replace never reached the server",
      );
    });

    it("deletes the copy when the replace dialog's choice is turned on", async () => {
      const remoteVault = await createTestVault(server, "Conflict Replace Delete", material);
      const peer = await newPeer(remoteVault.id);
      const peerBytes = new Uint8Array([5, 5, 5, 5]);
      peer.writeBinary("photo.png", peerBytes);
      await peer.sync();
      await peer.change("photo.png");

      const vault = new FakeVault();
      const localBytes = new Uint8Array([6, 6, 6, 6]);
      await vault.createAttachment("photo.png", localBytes);
      const { plugin, app } = await loadPlugin({
        vault,
        settings: { connectedVaultId: remoteVault.id, connectedVaultName: remoteVault.name },
      });
      plugin.encryptionKey = material.key;
      await plugin.startHost();
      await waitFor(
        () => vault.paths().some((path) => isConflictFile(path)),
        "the bind never parked a binary conflict copy",
      );
      const parked = conflictCopyOf(vault.paths(), "photo.png")!;

      const modal = await modalOpenedBy(
        () => menuEntryFor(app, parked, "用冲突副本替换当前文件").click(),
        "the replace dialog never opened",
      );
      // The one choice, turned on: the copy goes once the write has landed.
      modalToggles(modal)[0]!.simulateChange(true);
      clickModalButton(modal, "替换");

      await waitForAsync(
        async () =>
          Array.from(await bytesAt(vault, "photo.png")).join(",") ===
          Array.from(localBytes).join(","),
        "the replace never wrote the copy's bytes over the original",
      );
      await waitFor(() => !vault.has(parked), "the copy was not deleted after the replace");
      // Both halves of the request were carried out, so there is nothing left to report.
      expect(notices.some((message) => message.includes("冲突副本"))).toBe(false);
    });

    it("offers to restore the copy when the original is gone", async () => {
      const { plugin, vault, app, remote, parked } = await parkedMarkdownConflict(
        "Conflict Missing",
        "local body\n",
        "remote body\n",
      );

      // The file moves away, so the path the copy belongs at is free again.
      await vault.move("shared.md", "moved.md");
      await vault.settle();
      // The move has to be on the server before the restore is attempted, or the create
      // would race the chain that still claims the old path.
      const movedFileId = await trackedFileId(plugin, "moved.md");
      await waitForAsync(
        async () =>
          (await fileVersions(server, remote.id, movedFileId)).at(-1)?.action === "rename",
        "the move never reached the server",
      );
      expect(vault.getAbstractFileByPath("shared.md")).toBeNull();

      const view = await openDiff(app, parked);
      await waitFor(
        () => renderedText(viewContent(view)).includes("找不到原文件「shared.md」"),
        "the comparison did not report the missing original",
      );
      // One sentence and nothing else: no columns for a table that cannot be drawn, no layout
      // picker for it, and no dump of the copy's text on its own. The header still names the
      // two files, and keeps the one action that is still useful.
      expect(viewParagraphs(view)).toEqual([
        "找不到原文件「shared.md」：它可能已被改名或删除，无法对比。",
      ]);
      expect(elementsWithClass(viewContent(view), "courier-segmented")).toEqual([]);
      expect(elementsWithClass(viewContent(view), "courier-conflict-diff-stat")).toEqual([]);
      expect(elementsWithClass(viewContent(view), "courier-diff-row")).toEqual([]);
      expect(buttonsIn(viewContent(view)).map((button) => button.text)).toEqual(["恢复为原文件"]);

      const restore = buttonsIn(viewContent(view)).find(
        (button) => button.text === "恢复为原文件",
      )!;
      const confirm = await modalOpenedBy(() => restore.click(), "the restore dialog never opened");
      expect(modalParagraphs(confirm)).toEqual(["原文件不存在，将按冲突副本创建「shared.md」。"]);
      clickModalButton(confirm, "恢复");

      await waitFor(
        () => vault.read("shared.md") === "local body\n",
        "the copy never came back at the path it belonged to",
      );
      // The restore is the user's own choice, so the tab that offered it closes with it.
      await waitFor(() => diffLeaves(app).length === 0, "the comparison tab stayed open");
      // The copy stays behind, and the server holds a live chain at the path again.
      expect(vault.read(parked)).toBe("local body\n");
      await waitForAsync(
        async () => (await filesAtPath(server, remote.id, material.key, "shared.md")).length === 1,
        "the restored file never reached the server",
      );
    });

    it("restores the copy onto a new chain after a peer deleted the original", async () => {
      const { plugin, vault, app, remote, peer, parked } = await parkedMarkdownConflict(
        "Conflict Peer Delete",
        "local body\n",
        "remote body\n",
      );
      // The chain the note lives on is the peer's, adopted when the conflict was resolved;
      // the tombstone below ends it.
      const oldFileId = await trackedFileId(plugin, "shared.md");
      // A notification sent before the socket subscribes is lost for good (the server keeps
      // no backlog), so the delete below has to wait for the subscription to be up.
      await waitFor(() => plugin.wsState === "connected", "the plugin's socket never connected");

      // The peer deletes the note. The host applies the tombstone (which leaves the copy
      // alone and drops this device's state entry), so the path is free again and the next
      // local file there is a **new** file, not a version of the dead chain.
      peer.remove("shared.md");
      await peer.removeAndSync("shared.md");
      await waitFor(
        () => vault.getAbstractFileByPath("shared.md") === null,
        "the peer's deletion never reached the vault",
      );
      expect(vault.read(parked)).toBe("local body\n");

      const view = await openDiff(app, parked);
      await waitFor(
        () => renderedText(viewContent(view)).includes("找不到原文件「shared.md」"),
        "the comparison did not report the missing original",
      );
      const restore = buttonsIn(viewContent(view)).find(
        (button) => button.text === "恢复为原文件",
      )!;
      const confirm = await modalOpenedBy(() => restore.click(), "the restore dialog never opened");
      clickModalButton(confirm, "恢复");

      await waitFor(
        () => vault.read("shared.md") === "local body\n",
        "the copy never came back after a peer's deletion",
      );
      await waitFor(() => diffLeaves(app).length === 0, "the comparison tab stayed open");
      // The copy is the only record of the losing version, so it stays.
      expect(vault.read(parked)).toBe("local body\n");

      // A new chain at the path — the dead chain keeps its tombstone — which is what the
      // "a peer's tombstone + a local file" rule says, and what makes the path live again.
      let newFileId: string | undefined;
      await waitForAsync(async () => {
        const ids = await filesAtPath(server, remote.id, material.key, "shared.md");
        newFileId = ids.find((fileId) => fileId !== oldFileId);
        return newFileId !== undefined;
      }, "the restored file never reached the server as a new chain");
      expect((await fileVersions(server, remote.id, newFileId!)).map((v) => v.action)).toEqual([
        "create",
      ]);
      expect((await deletedFiles(server, remote.id)).some((f) => f.fileId === oldFileId)).toBe(
        true,
      );
    });

    it("decorates only parked copies, with the action their kind gets", () => {
      const opened: string[] = [];
      const handlers = {
        openDiff: (path: string) => opened.push(`diff:${path}`),
        openReplace: (path: string) => opened.push(`replace:${path}`),
      };
      // A markdown copy gets the comparison button; the label is the word the user reads.
      const diffButton = decorateConflictTitle(
        makeTitle(),
        "notes/plan-2026-02-14-101530.conflict.md",
        handlers,
      )!;
      expect(asFake(diffButton).classes).toContain(CONFLICT_ACTION_CLASS);
      expect(asFake(diffButton).text).toBe("对比");
      diffButton.click();
      expect(opened).toEqual(["diff:notes/plan-2026-02-14-101530.conflict.md"]);

      // A binary copy gets the replace action instead.
      const replaceButton = decorateConflictTitle(
        makeTitle(),
        "photos/raw-2026-02-14-101530.conflict.png",
        handlers,
      )!;
      expect(asFake(replaceButton).text).toBe("替换");
      replaceButton.click();
      expect(opened[1]).toBe("replace:photos/raw-2026-02-14-101530.conflict.png");

      // The button goes in **before** the extension tag, so the tag stays rightmost.
      const tagged = createFakeEl("div");
      const tag = tagged.createDiv({ cls: "nav-file-tag", text: "PNG" });
      const onTagged = decorateConflictTitle(
        tagged as unknown as HTMLElement,
        "photos/raw-2026-02-14-101530.conflict.png",
        handlers,
      )!;
      expect(tagged.children.indexOf(onTagged as unknown as FakeEl)).toBeLessThan(
        tagged.children.indexOf(tag),
      );

      // The same repair as the history chip: a tag in front of an existing chip is moved back
      // behind it, so the extension tag stays rightmost.
      const rebuilt = createFakeEl("div");
      const rebuiltTag = rebuilt.createDiv({ cls: "nav-file-tag", text: "PNG" });
      const rebuiltPath = "photos/raw-2026-02-14-101530.conflict.png";
      const repaired = decorateConflictTitle(
        rebuilt as unknown as HTMLElement,
        rebuiltPath,
        handlers,
      )!;
      rebuilt.insertBefore(rebuiltTag as unknown as FakeEl, repaired as unknown as FakeEl);
      expect(
        decorateConflictTitle(rebuilt as unknown as HTMLElement, rebuiltPath, handlers),
        "a decorated row was decorated again",
      ).toBeNull();
      expect(
        rebuilt.children.indexOf(repaired as unknown as FakeEl),
        "the conflict chip stayed behind the rebuilt tag",
      ).toBeLessThan(rebuilt.children.indexOf(rebuiltTag as unknown as FakeEl));

      // An ordinary file is left alone.
      expect(decorateConflictTitle(makeTitle(), "plan.md", handlers)).toBeNull();
    });

    it("offers the version-history chip on every row but a parked copy", () => {
      const opened: string[] = [];
      const handlers = { openVersionHistory: (path: string) => opened.push(path) };

      const chip = decorateVersionHistoryTitle(makeTitle(), "notes/plan.md", handlers)!;
      expect(asFake(chip).classes).toContain(VERSION_HISTORY_ACTION_CLASS);
      // The label comes from the catalog, so it follows the app's language; the test asserts
      // the chip uses that key rather than a hard-coded string.
      expect(asFake(chip).text).toBe(t("explorer.versionHistory"));
      chip.click();
      expect(opened).toEqual(["notes/plan.md"]);

      // An attachment row keeps the app's extension tag rightmost: the chip goes **before**
      // it, in the row's flow, so the file name truncates in front of the chip.
      const tagged = createFakeEl("div");
      const tag = tagged.createDiv({ cls: "nav-file-tag", text: "PNG" });
      const beforeTag = decorateVersionHistoryTitle(
        tagged as unknown as HTMLElement,
        "photos/raw.png",
        handlers,
      )!;
      expect(
        tagged.children.indexOf(beforeTag as unknown as FakeEl),
        "the chip did not take its place before the extension tag",
      ).toBeLessThan(tagged.children.indexOf(tag));

      // A tag that ends up in front of an existing chip (the row's children can be rebuilt
      // under the decorator) must not stay there: the next pass puts the chip back in front
      // of it instead of leaving the two to split the row's free space.
      const rebuilt = createFakeEl("div");
      const rebuiltTag = rebuilt.createDiv({ cls: "nav-file-tag", text: "PNG" });
      const repairedChip = decorateVersionHistoryTitle(
        rebuilt as unknown as HTMLElement,
        "photos/raw.png",
        handlers,
      )!;
      rebuilt.insertBefore(rebuiltTag as unknown as FakeEl, repairedChip as unknown as FakeEl);
      expect(
        rebuilt.children.indexOf(repairedChip as unknown as FakeEl),
        "the test did not put the tag in front of the chip",
      ).toBeGreaterThan(rebuilt.children.indexOf(rebuiltTag as unknown as FakeEl));
      expect(
        decorateVersionHistoryTitle(rebuilt as unknown as HTMLElement, "photos/raw.png", handlers),
        "a decorated row was decorated again",
      ).toBeNull();
      expect(
        rebuilt.children.indexOf(repairedChip as unknown as FakeEl),
        "the chip stayed behind the rebuilt tag",
      ).toBeLessThan(rebuilt.children.indexOf(rebuiltTag as unknown as FakeEl));

      // A parked copy has no chain at all, so it gets no chip — and a chip a previous path
      // gave the same row is removed: Obsidian reuses the row element across a rename, and a
      // chip that still acts on the old path would open a history for a file that is gone.
      const row = makeTitle();
      expect(
        decorateVersionHistoryTitle(row, "notes/plan.md", handlers),
        "an ordinary file got no chip",
      ).not.toBeNull();
      expect(
        decorateVersionHistoryTitle(row, "notes/plan-2026-02-14-101530.conflict.md", handlers),
        "a parked copy was offered a version history",
      ).toBeNull();
      expect(elementsWithClass(asFake(row), VERSION_HISTORY_ACTION_CLASS)).toEqual([]);
    });

    it("keeps both chips off a file under an excluded folder", () => {
      const handlers = {
        openDiff: () => {},
        openReplace: () => {},
        openVersionHistory: () => {},
      };

      // The folder is this device's local scope, so neither an ordinary note nor a name
      // that looks like a parked copy gets an entry point inside it.
      expect(
        decorateVersionHistoryTitle(makeTitle(), "private/plan.md", handlers, ["private"]),
        "an excluded file was offered a version history",
      ).toBeNull();
      expect(
        decorateVersionHistoryTitle(makeTitle(), "private/deep/plan.md", handlers, ["private"]),
        "a file in a nested excluded folder was offered a version history",
      ).toBeNull();
      expect(
        decorateConflictTitle(makeTitle(), "private/plan-2026-02-14-101530.conflict.md", handlers, [
          "private",
        ]),
        "a conflict-named file under an excluded folder was offered the conflict action",
      ).toBeNull();

      // A folder that only shares the prefix is a different folder and keeps its chip: the
      // rule is the path, not the string.
      expect(
        decorateVersionHistoryTitle(makeTitle(), "private-notes/plan.md", handlers, ["private"]),
      ).not.toBeNull();

      // A row decorated before the exclusion loses its chip in the pass that dims it:
      // Obsidian reuses the row element, so the action has to be taken away, not just
      // skipped for new rows.
      const historyRow = makeTitle();
      expect(decorateVersionHistoryTitle(historyRow, "private/plan.md", handlers)).not.toBeNull();
      expect(
        decorateVersionHistoryTitle(historyRow, "private/plan.md", handlers, ["private"]),
        "the version-history chip survived the exclusion",
      ).toBeNull();
      expect(elementsWithClass(asFake(historyRow), VERSION_HISTORY_ACTION_CLASS)).toEqual([]);

      const parked = "private/plan-2026-02-14-101530.conflict.md";
      const conflictRow = makeTitle();
      expect(decorateConflictTitle(conflictRow, parked, handlers)).not.toBeNull();
      expect(
        decorateConflictTitle(conflictRow, parked, handlers, ["private"]),
        "the conflict chip survived the exclusion",
      ).toBeNull();
      expect(elementsWithClass(asFake(conflictRow), CONFLICT_ACTION_CLASS)).toEqual([]);
    });

    it("follows the row's path when the file is renamed under a chip", () => {
      const opened: string[] = [];
      const handlers = {
        openDiff: () => {},
        openReplace: () => {},
        openVersionHistory: (path: string) => opened.push(path),
      };

      // A click without a re-decoration reads the row's **current** `data-path`: Obsidian
      // updates that attribute in place, so a chip that captured the path it was made with
      // would open the file that used to be there.
      const row = makeTitle();
      row.setAttribute("data-path", "notes/old.md");
      const chip = decorateVersionHistoryTitle(row, "notes/old.md", handlers)!;
      row.setAttribute("data-path", "notes/new.md");
      chip.click();

      // The decorator's next pass rebuilds the chip for the new path instead of keeping the
      // stale one (and does not stack a second chip on the row).
      expect(asFake(chip).getAttribute("data-path")).toBe("notes/old.md");
      const rebuilt = decorateVersionHistoryTitle(row, "notes/new.md", handlers);
      expect(rebuilt, "the chip was not rebuilt for the new path").not.toBeNull();
      expect(asFake(rebuilt!).getAttribute("data-path")).toBe("notes/new.md");
      expect(elementsWithClass(asFake(row), VERSION_HISTORY_ACTION_CLASS)).toHaveLength(1);
      rebuilt!.click();
      expect(opened).toEqual(["notes/new.md", "notes/new.md"]);
    });
  });

  it("picks up a note created on another device without restarting Obsidian", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Remote New File");
    const peer = await newPeer(remote.id);

    peer.write("from-the-peer.md", "hello from the other device");
    await peer.sync();
    await peer.change("from-the-peer.md");

    // The peer's push reaches this plugin over the websocket; a fileId the
    // engine has never seen is materialised at the path recorded in the pushed
    // version, so the note arrives live.
    await waitFor(
      () => vault.read("from-the-peer.md") === "hello from the other device",
      "the note created on the peer never appeared in the plugin's vault",
    );
    expect(plugin.engine!.fileIdForPath("from-the-peer.md")).toBeTruthy();
  });

  it("streams a large peer attachment into the vault through one visible write", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Large Streamed Pull");
    const peer = await newPeer(remote.id);
    const bytes = new Uint8Array(9 * 1024 * 1024).map((_, index) => (index * 17) % 251);

    peer.writeBinary("media/big.mp4", bytes);
    await peer.sync();

    await waitFor(
      () => vault.has("media/big.mp4"),
      "the peer's large attachment never appeared in the plugin's vault",
    );
    await vault.settle();

    // The whole file is there, byte for byte. A loop, not `toEqual` on a 9 MiB typed
    // array: the diff renderer is the slowest thing in this test by far.
    const pulled = await bytesAt(vault, "media/big.mp4");
    expect(pulled.byteLength).toBe(bytes.byteLength);
    let mismatch = -1;
    for (let index = 0; index < bytes.byteLength; index++) {
      if (pulled[index] !== bytes[index]) {
        mismatch = index;
        break;
      }
    }
    expect(mismatch).toBe(-1);
    expect(plugin.engine!.fileIdForPath("media/big.mp4")).toBeTruthy();
    // …and the temporary file the adapter streams into is gone: only the target path
    // remains, so a later reconcile cannot list a half-written remnant.
    expect(vault.paths().filter((path) => path.startsWith(".courier/tmp/"))).toEqual([]);
  }, 30_000);

  it("catches up on what happened while the connection was down", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Reconnect Catch Up");
    const peer = await newPeer(remote.id);

    await waitFor(() => plugin.wsState === "connected", "the plugin's socket never connected");

    // The connection goes away. The server keeps no backlog for a subscriber, so
    // the notification for the peer's push below is lost for good — only the
    // reconcile a reconnect triggers can bring the note in (the periodic safety
    // net runs every five minutes, long after this test would time out).
    server.dropSockets();
    await waitFor(() => plugin.wsState !== "connected", "the plugin's socket never dropped");

    peer.write("while-down.md", "written while the plugin was disconnected");
    await peer.sync();
    await peer.change("while-down.md");

    await waitFor(
      () => vault.read("while-down.md") === "written while the plugin was disconnected",
      "the plugin never reconciled after its socket came back",
    );
    expect(plugin.wsState).toBe("connected");
  });

  it("follows a peer's rename, leaving only the new path", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Peer Rename", async (v) => {
      await v.create("old-name.md", "shared content");
    });
    const fileId = await trackedFileId(plugin, "old-name.md");
    const peer = await newPeer(remote.id);
    await peer.sync();
    peer.move("old-name.md", "new-name.md");
    await peer.rename("old-name.md", "new-name.md");

    // The rename notification drives the move: the peer's push is delivered over
    // the websocket (no reconcile), and the vault's own rename event must not be
    // mistaken for a brand new file.
    //
    // The wait covers the engine's own record, not just the bytes: a pull renames
    // the file *before* it fetches the remote content and rewrites its state, so
    // polling the vault alone can win that race — which it did, rarely and only
    // under the load of a full parallel run — and assert on a state entry that
    // still pointed at the old path.
    await waitFor(
      () =>
        vault.read("new-name.md") === "shared content" &&
        plugin.engine!.fileIdForPath("new-name.md") === fileId &&
        persistedPaths(plugin).includes("new-name.md"),
      "the plugin never materialised the renamed note in the vault and its own records",
    );
    await vault.settle();

    expect(vault.read("old-name.md")).toBeNull();
    expect(vault.paths().filter((path) => !path.startsWith(".courier/"))).toEqual(["new-name.md"]);
    expect(plugin.engine!.fileIdForPath("new-name.md")).toBe(fileId);
    expect(plugin.engine!.fileIdForPath("old-name.md")).toBeNull();
    expect(vault.paths().filter((path) => isConflictFile(path))).toEqual([]);
    // The engine's own record must have moved with the file: a state entry still
    // pointing at the old path is what makes the next reconcile fork a second
    // chain for the new one.
    expect(persistedPaths(plugin)).toEqual(["new-name.md"]);
    // One path, one chain — a second chain here is what left both files behind.
    expect(await filesAtPath(server, remote.id, material.key, "new-name.md")).toEqual([fileId]);
    expect(await filesAtPath(server, remote.id, material.key, "old-name.md")).toEqual([]);
  });

  it("renames its own note as one version on the same chain", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Own Rename", async (v) => {
      await v.create("draft.md", "content that survives a rename");
    });
    const fileId = await trackedFileId(plugin, "draft.md");

    await vault.move("draft.md", "final.md");
    await vault.settle();

    await waitForAsync(
      async () => (await fileVersions(server, remote.id, fileId)).at(-1)?.action === "rename",
      "the rename never reached the server",
    );
    expect(await filesAtPath(server, remote.id, material.key, "final.md")).toEqual([fileId]);
    expect(await filesAtPath(server, remote.id, material.key, "draft.md")).toEqual([]);
    expect(vault.paths().filter((path) => isConflictFile(path))).toEqual([]);

    // A device that never saw the rename converges on the new path only.
    const peer = await newPeer(remote.id);
    await peer.sync();
    expect(peer.read("final.md")).toBe("content that survives a rename");
    expect(peer.read("draft.md")).toBeNull();
  });

  it("adopts the remote chain when the vault reports a path the engine has not claimed", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Path Adoption", async (v) => {
      await v.create("old-name.md", "shared content");
    });
    const fileId = await trackedFileId(plugin, "old-name.md");

    // No peer push at all: the vault reports a local file at the new path while
    // the engine still holds the old identity — a rename notification that never
    // arrived, or arrived too late, leaves exactly this state. Treating it as a
    // new file is what creates a second chain for a path the server already has
    // and leaves both files on disk.
    await vault.move("old-name.md", "new-name.md");
    await plugin.engine!.handleLocalChange("new-name.md");
    await vault.settle();
    // The rename this drove is pushed from an event handler, so the server state
    // is reached asynchronously — assert on it only once the version is there.
    await waitForAsync(
      async () => (await fileVersions(server, remote.id, fileId)).at(-1)?.action === "rename",
      "the adopted rename never reached the server",
    );

    expect(plugin.engine!.fileIdForPath("new-name.md")).toBe(fileId);
    expect(plugin.engine!.fileIdForPath("old-name.md")).toBeNull();
    expect(vault.paths().filter((path) => isConflictFile(path))).toEqual([]);
    // The whole point: the path still has exactly one chain, the original one.
    expect(await filesAtPath(server, remote.id, material.key, "new-name.md")).toEqual([fileId]);
    expect(await filesAtPath(server, remote.id, material.key, "old-name.md")).toEqual([]);
    expect(await vaultHistory(server, remote.id)).toHaveLength(1);
    expect((await fileVersions(server, remote.id, fileId)).map((v) => v.action)).toEqual([
      "create",
      "rename",
    ]);
    expect(vault.read("new-name.md")).toBe("shared content");
    expect(vault.read("old-name.md")).toBeNull();
  });

  it("brings the note back when a delete raced the peer's edit", async () => {
    const { plugin, vault, remote } = await startHostedPlugin("Delete Race Conflict", async (v) => {
      await v.create("contested.md", "base");
    });
    const fileId = await trackedFileId(plugin, "contested.md");
    const peer = await newPeer(remote.id);
    await peer.sync();

    // The plugin's tombstone cannot reach the server, and the peer edits the note in
    // the meantime: the note is gone here, the chain holds an edit this device never
    // saw, and neither intent has reached the other side.
    plugin.settings.serverUrl = "http://127.0.0.1:1";
    await vault.remove("contested.md");
    await vault.settle();
    peer.write("contested.md", "edited on the peer");
    await peer.change("contested.md");
    plugin.settings.serverUrl = server.serverUrl;

    // The next pass is where the two meet, and the remote side wins it: the peer's
    // note comes back through the plugin's own vault.
    await plugin.host!.engine!.initialSync();

    await waitFor(
      () => vault.read("contested.md") === "edited on the peer",
      "the remote version never came back",
    );
    // The deletion had no content of its own, so there is nothing parked beside it.
    expect(vault.paths().filter((path) => isConflictFile(path))).toEqual([]);
    // A pull, not another version: the chain keeps the peer's edit as its head.
    expect((await fileVersions(server, remote.id, fileId)).map((v) => v.action)).toEqual([
      "create",
      "modify",
    ]);
  });

  it("hands an unreachable server back as an error the page can render", async () => {
    const { plugin } = await loadPlugin({
      vault: new FakeVault(),
      settings: { serverUrl: "http://127.0.0.1:1", userKey: server.userKey },
    });

    const outcome = await plugin.signIn();

    // No throw and no Notice: the settings page shows this line under the field the
    // user has to fix, and stays on the first step.
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toContain("无法连接服务器");
  });

  it("survives a push that fails while the server is unreachable", async () => {
    const { plugin, vault } = await startHostedPlugin("Failed Push");

    // Vault events are synchronous, so nothing can await the push they trigger.
    // With no rejection handler on that path every failed push becomes an
    // unhandled rejection in Obsidian's renderer — which the test runner reports as
    // an error for this file, so triggering the failure *is* the assertion. The
    // explicit expectations below only pin that the host stays usable.
    plugin.settings.serverUrl = "http://127.0.0.1:1";

    await vault.create("unreachable.md", "this push cannot succeed");
    await vault.settle();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(plugin.host).not.toBeNull();
    // The local state still records the file, so the next reconcile retries it.
    expect(plugin.settings.syncState?.localVersions).toBeTruthy();
  });

  /**
   * Obsidian's config folder is outside the vault index, so a settings file
   * behaves unlike anything else the plugin syncs: it is listed and read through
   * `vault.adapter`, it fires **no vault event**, and the host has to poll for a
   * local change. These cases pin that wiring through the real plugin class.
   */
  describe("Obsidian settings sync", () => {
    it("pushes a settings change that fires no vault event", async () => {
      const hosted = await startHostedPlugin("Settings Push", undefined, {
        settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
      });
      const peer = await newPeer(hosted.remote.id, "settings-peer", {
        settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
      });

      // Written the way Obsidian writes it: through the data adapter, no event.
      await hosted.vault.writeConfig(".obsidian/app.json", '{"theme":"moonstone"}');
      // The settings pass is what the host's 30s timer runs.
      await engineOf(hosted.plugin).syncLocalSettings();

      await peer.sync();
      expect(peer.read(".obsidian/app.json")).toBe('{"theme":"moonstone"}');
      expect(hosted.vault.paths()).toContain(".obsidian/app.json");
    });

    it("lands a peer's settings file in the config folder", async () => {
      const hosted = await startHostedPlugin("Settings Pull", undefined, {
        settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
      });
      const peer = await newPeer(hosted.remote.id, "settings-peer", {
        settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
      });

      peer.write(".obsidian/appearance.json", '{"theme":"obsidian"}');
      await peer.sync();
      await peer.change(".obsidian/appearance.json");

      await waitFor(
        () => hosted.vault.read(".obsidian/appearance.json") === '{"theme":"obsidian"}',
        "the peer's settings file never arrived",
      );
    });

    /**
     * The reload popup: one per dismissal, never one per change.
     *
     * A peer's core-plugin state is one of the settings a running Obsidian does not apply by
     * itself (`SETTINGS_GROUPS_NEEDING_RELOAD`, measured in the real-app suite), so it is the
     * case this popup exists for. What the user asked for is the shape: the message stays
     * until it is dismissed, further changes of the same kind add nothing while it is up, and
     * closing it without reloading means the next such change asks again.
     */
    it("asks for a reload once, and asks again only after the popup is dismissed", async () => {
      const hosted = await startHostedPlugin("Settings Reload Popup", undefined, {
        settingsGroups: { ...NO_SETTINGS_GROUPS, corePlugins: true },
      });
      const peer = await newPeer(hosted.remote.id, "reload-peer", {
        settingsGroups: { ...NO_SETTINGS_GROUPS, corePlugins: true },
      });
      const corePlugins = ".obsidian/core-plugins.json";

      peer.write(corePlugins, '{"word-count":false}');
      // A settings file fires no vault event, so the peer's own pass is what puts it on the
      // server; `change` is the notification the hosted device reacts to (the pattern the
      // cases above use).
      await peer.sync();
      await peer.change(corePlugins);
      await waitFor(
        () => hosted.vault.read(corePlugins) === '{"word-count":false}',
        "the peer's core plugin state never arrived",
      );

      const cards = () => reloadCards(hosted.plugin);
      expect(cards()).toHaveLength(1);
      const card = cards()[0]!;
      // It waits for the user, and it does not name the file it is about.
      expect(allText(card).join(" ")).toContain("设置已同步");
      expect(allText(card).join(" ")).not.toContain("core-plugins.json");

      // A second change of the same kind, while the card is up, adds nothing.
      peer.write(corePlugins, '{"word-count":true}');
      await peer.change(corePlugins);
      await waitFor(
        () => hosted.vault.read(corePlugins) === '{"word-count":true}',
        "the second core plugin change never arrived",
      );
      expect(cards()).toHaveLength(1);

      // Closing it without reloading is not a decision to stop being told: the next change
      // that needs a reload brings it back.
      clickLabelled(card, "稍后");
      expect(cards()).toHaveLength(0);
      peer.write(corePlugins, '{"word-count":false}');
      await peer.change(corePlugins);
      await waitFor(
        () => cards().length === 1,
        "the popup did not come back after it was dismissed",
      );
    });

    it("keeps quiet about the settings a running app applies on its own", async () => {
      const hosted = await startHostedPlugin("Settings Reload Quiet", undefined, {
        settingsGroups: { ...NO_SETTINGS_GROUPS, app: true },
      });
      const peer = await newPeer(hosted.remote.id, "quiet-peer", {
        settingsGroups: { ...NO_SETTINGS_GROUPS, app: true },
      });

      peer.write(".obsidian/app.json", '{"theme":"moonstone"}');
      await peer.sync();
      await peer.change(".obsidian/app.json");
      await waitFor(
        () => hosted.vault.read(".obsidian/app.json") === '{"theme":"moonstone"}',
        "the peer's app.json never arrived",
      );

      // `app.json` is applied live by Obsidian (measured), so a card would be a lie the
      // user learns to dismiss unread.
      expect(reloadCards(hosted.plugin)).toHaveLength(0);
    });

    it("ignores a peer's settings chain while the switch is off", async () => {
      const hosted = await startHostedPlugin("Settings Ignored");
      const peer = await newPeer(hosted.remote.id, "settings-peer", {
        settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
      });

      peer.write(".obsidian/app.json", '{"theme":"moonstone"}');
      peer.write("note.md", "# note");
      await peer.sync();
      await peer.change(".obsidian/app.json");

      await waitFor(() => hosted.vault.read("note.md") === "# note", "the note never arrived");
      // A pass over the whole vault must not pull it, park a conflict copy for it
      // or push anything on its behalf.
      await engineOf(hosted.plugin).initialSync();

      expect(hosted.vault.read(".obsidian/app.json")).toBeNull();
      expect(hosted.vault.paths().filter((path) => isConflictFile(path))).toEqual([]);
      expect(engineOf(hosted.plugin).fileIdForPath(".obsidian/app.json")).toBeNull();
    });

    it("never syncs this plugin's own config, even with every group on", async () => {
      const hosted = await startHostedPlugin(
        "Settings Courier Excluded",
        async (vault) => {
          await vault.writeConfig(
            ".obsidian/plugins/courier/data.json",
            '{"deviceName":"leak","userKey":"ck_leak"}',
          );
          await vault.writeConfig(".obsidian/workspace.json", "{}");
          await vault.writeConfig(".obsidian/app.json", "{}");
        },
        { settingsGroups: ALL_SETTINGS_GROUPS },
      );
      const peer = await newPeer(hosted.remote.id, "plugins-peer", {
        settingsGroups: ALL_SETTINGS_GROUPS,
      });

      await peer.sync();

      // One chain — app.json. The device identity and the workspace layout stay on
      // the device that owns them.
      expect(await vaultHistory(server, hosted.remote.id)).toHaveLength(1);
      expect(peer.read(".obsidian/plugins/courier/data.json")).toBeNull();
      expect(peer.read(".obsidian/workspace.json")).toBeNull();
      expect(peer.read(".obsidian/app.json")).toBe("{}");
    });

    it("starts syncing a group when it is turned on, and stops when it is turned off", async () => {
      const hosted = await startHostedPlugin("Settings Toggle");
      const peer = await newPeer(hosted.remote.id, "settings-peer", {
        settingsGroups: ALL_SETTINGS_GROUPS,
      });

      await hosted.vault.writeConfig(".obsidian/app.json", '{"theme":"moonstone"}');
      await engineOf(hosted.plugin).syncLocalSettings();
      expect(await vaultHistory(server, hosted.remote.id)).toHaveLength(0);

      // What the settings tab's toggle does: save, then rebuild the host, whose
      // bind pass pushes this device's settings files.
      hosted.plugin.settings.settingsGroups.app = true;
      await hosted.plugin.restartHostForScope();

      await peer.sync();
      expect(peer.read(".obsidian/app.json")).toBe('{"theme":"moonstone"}');

      // Turning that one group back off stops it without deleting anything.
      hosted.plugin.settings.settingsGroups.app = false;
      await hosted.plugin.restartHostForScope();
      await hosted.vault.writeConfig(".obsidian/app.json", '{"theme":"obsidian"}');
      await engineOf(hosted.plugin).syncLocalSettings();
      await peer.sync();
      expect(peer.read(".obsidian/app.json")).toBe('{"theme":"moonstone"}');
    });

    /**
     * A conflict inside `.obsidian/` is settled by last modification time and **never**
     * parks a copy: the config folder is outside Obsidian's file index, so a copy there
     * would be invisible — the plugin could not offer its compare/replace actions on it
     * even if the engine wrote one.
     */
    it("settles a settings conflict by modification time, without a conflict copy", async () => {
      const hosted = await startHostedPlugin("Settings Conflict LWW", undefined, {
        settingsGroups: { ...NO_SETTINGS_GROUPS, app: true },
      });
      const peer = await newPeer(hosted.remote.id, "settings-conflict-peer", {
        settingsGroups: { ...NO_SETTINGS_GROUPS, app: true },
      });
      const path = ".obsidian/app.json";
      const conflictPaths = () => hosted.vault.paths().filter((p) => p.includes(".conflict."));

      await hosted.vault.writeConfig(path, '{"theme":"moonstone"}');
      hosted.vault.setMtime(path, 1_000);
      await engineOf(hosted.plugin).syncLocalSettings();
      await peer.sync();
      expect(peer.read(path)).toBe('{"theme":"moonstone"}');

      // Both edit; the plugin's copy is the later modification, so it has to win even
      // though the peer's push is the one already on the chain.
      await hosted.vault.writeConfig(path, '{"theme":"hosted-newer"}');
      hosted.vault.setMtime(path, 3_000);
      peer.write(path, '{"theme":"peer-older"}');
      peer.setMtime(path, 2_000);
      await peer.sync();
      await engineOf(hosted.plugin).syncLocalSettings();
      await hosted.vault.settle();
      await peer.sync();

      expect(hosted.vault.read(path)).toBe('{"theme":"hosted-newer"}');
      expect(peer.read(path)).toBe('{"theme":"hosted-newer"}');
      expect(conflictPaths()).toEqual([]);
      // Silent by design: nothing was parked, so there is no copy for a notice to name.
      expect(notices.some((message) => message.includes("冲突"))).toBe(false);
    });

    it("applies a peer's newer settings edit even with a divergent local copy, without a copy", async () => {
      const hosted = await startHostedPlugin("Settings Conflict Remote", undefined, {
        settingsGroups: { ...NO_SETTINGS_GROUPS, corePlugins: true },
      });
      const peer = await newPeer(hosted.remote.id, "settings-conflict-peer", {
        settingsGroups: { ...NO_SETTINGS_GROUPS, corePlugins: true },
      });
      const path = ".obsidian/core-plugins.json";
      const conflictPaths = () => hosted.vault.paths().filter((p) => p.includes(".conflict."));

      await hosted.vault.writeConfig(path, '{"word-count":true}');
      hosted.vault.setMtime(path, 1_000);
      await engineOf(hosted.plugin).syncLocalSettings();
      await peer.sync();
      expect(peer.read(path)).toBe('{"word-count":true}');

      // The peer's edit is the later one, so it replaces the divergent local copy — and
      // because a running app does not re-read this file, the reload card still appears.
      await hosted.vault.writeConfig(path, '{"word-count":false}');
      hosted.vault.setMtime(path, 2_000);
      peer.write(path, '{"word-count":true,"new":true}');
      peer.setMtime(path, 3_000);
      await peer.sync();
      await engineOf(hosted.plugin).syncLocalSettings();
      await hosted.vault.settle();

      expect(hosted.vault.read(path)).toBe('{"word-count":true,"new":true}');
      expect(conflictPaths()).toEqual([]);
      expect(notices.some((message) => message.includes("冲突"))).toBe(false);
      expect(reloadCards(hosted.plugin)).toHaveLength(1);
    });
  });

  describe("vault file types", () => {
    async function newPeerWithTypes(
      vaultId: string,
      deviceName: string,
      fileTypes?: Partial<FileTypeSync>,
    ): Promise<TestClient> {
      const peer = await createTestClient({
        server,
        vaultId,
        key: material.key,
        deviceName,
        fileTypes,
      });
      peers.push(peer);
      return peer;
    }

    /** Wait until the server holds a version for the file — the push is in flight when
     * the engine starts tracking it, so a pull, a history call or this check before that
     * sees nothing (the endpoint answers 404 until the first version exists). */
    async function waitForChain(vaultId: string, path: string, plugin: CourierPlugin) {
      await waitForAsync(async () => {
        const fileId = plugin.engine?.fileIdForPath(path);
        if (!fileId) return false;
        const versions = await fileVersions(server, vaultId, fileId).catch(() => []);
        return versions.length > 0;
      }, `${path} never reached the server`);
      return plugin.engine!.fileIdForPath(path)!;
    }

    it("pushes an attachment created through the vault's own file layer", async () => {
      // The gap L1 cannot see: a file created through `createBinary` fires a vault event,
      // and this is the wiring that turns that event into a push.
      const hosted = await startHostedPlugin("File Types Attachment");
      const peer = await newPeerWithTypes(hosted.remote.id, "attachment-peer");

      await hosted.vault.createAttachment("photos/raw.png", png(1));
      await hosted.vault.settle();

      await waitForChain(hosted.remote.id, "photos/raw.png", hosted.plugin);
      await peer.sync();
      expect(Array.from(peer.readBytes("photos/raw.png") ?? [])).toEqual(Array.from(png(1)));
    });

    it("stops carrying a file type when its switch is turned off, and resumes when it is on", async () => {
      const hosted = await startHostedPlugin("File Types Toggle");
      const peer = await newPeerWithTypes(hosted.remote.id, "types-peer");

      await hosted.vault.createAttachment("photos/raw.png", png(2));
      await hosted.vault.settle();
      await waitForChain(hosted.remote.id, "photos/raw.png", hosted.plugin);
      await peer.sync();
      expect(Array.from(peer.readBytes("photos/raw.png") ?? [])).toEqual(Array.from(png(2)));

      // What the settings tab's toggle does: save, then rebuild the host with the new
      // scope. The file stays exactly where it is on both sides.
      hosted.plugin.settings.fileTypes.images = false;
      await hosted.plugin.restartHostForScope();
      await hosted.vault.modify("photos/raw.png", "changed while images are off");
      await hosted.vault.settle();
      await engineOf(hosted.plugin).syncLocalSettings();
      await peer.sync();
      expect(Array.from(peer.readBytes("photos/raw.png") ?? [])).toEqual(Array.from(png(2)));

      hosted.plugin.settings.fileTypes.images = true;
      await hosted.plugin.restartHostForScope();
      await peer.sync();
      // Still one file, and the note beside it is unaffected throughout.
      expect(hosted.vault.has("photos/raw.png")).toBe(true);
    });

    it("persists the account's size cap, and reports the files it keeps out", async () => {
      // The cap belongs to the account key and the administrator sets it; the plugin
      // reads it from `GET /api/me` when its host starts.
      await setUserMaxFileBytes(server, 4);
      try {
        const hosted = await startHostedPlugin("File Types Cap");
        const peer = await newPeerWithTypes(hosted.remote.id, "cap-peer", undefined);

        // Over the 4-byte cap: not pushed, and the host survives it.
        await hosted.vault.createAttachment("photos/big.png", png(3));
        await hosted.vault.settle();
        await engineOf(hosted.plugin).initialSync();

        expect(hosted.plugin.settings.accountMaxFileBytes).toBe(4);
        expect(engineOf(hosted.plugin).fileIdForPath("photos/big.png")).toBeNull();
        await peer.sync();
        expect(peer.readBytes("photos/big.png")).toBeNull();
      } finally {
        await setUserMaxFileBytes(server, DEFAULT_MAX_FILE_BYTES);
      }
    });

    it("renders a version's content in the pane, media included", async () => {
      const hosted = await startHostedPlugin("File Types Preview");
      await hosted.vault.createAttachment("photos/raw.png", png(4));
      await hosted.vault.createAttachment(
        "docs/paper.pdf",
        new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      );
      await hosted.vault.settle();
      const fileId = await waitForChain(hosted.remote.id, "photos/raw.png", hosted.plugin);
      expect(fileId).toBeTruthy();
      await waitForChain(hosted.remote.id, "docs/paper.pdf", hosted.plugin);

      /**
       * One chain's history tab, opened the way a user does, with its reading pane given a
       * moment to draw the version it selects on open (the newest one).
       */
      async function openVersionContent(path: string): Promise<FakeEl> {
        const view = await openVersionHistory(hosted.plugin, path);
        await waitFor(
          () => allText(viewContent(view)).join(" ").length > 0,
          `the reading pane for ${path} never drew its version`,
        );
        return viewContent(view);
      }

      // An image plays inline: a PNG through `TextDecoder` would be full of U+FFFD.
      const image = await openVersionContent("photos/raw.png");
      await waitFor(
        () => elementsWithClass(image, "courier-file-preview-image").length > 0,
        "the image version was never rendered as an image",
      );
      const element = elementsWithClass(image, "courier-file-preview-image")[0] as unknown as {
        src?: string;
      };
      expect(element.src).toMatch(/^blob:/);
      expect(allText(image).join(" ")).not.toContain("\uFFFD");

      // A PDF has nothing to show here, so the pane says what it is.
      const pdf = await openVersionContent("docs/paper.pdf");
      const rendered = allText(pdf).join(" ");
      expect(rendered).toContain("二进制文件");
      expect(rendered).not.toContain("\uFFFD");
    });
  });

  /**
   * The switch matrix: every option the settings page offers, in both states, through
   * the write paths its controls call.
   *
   * The page's switches are the engine's own option lists — ten config-folder groups
   * (`SETTINGS_GROUPS`) and five vault file types (`FILE_TYPE_GROUPS`) — and each one is
   * a *device-local* decision the engine and the vault adapter read when they are built.
   * That is why every case goes through `setSettingsGroupEnabled` / `setFileTypeEnabled`,
   * which save and rebuild the host: a case that mutated `plugin.settings` and asserted on
   * it would pass with a host still running the old scope, and the whole point of the
   * switch is what leaves and enters the vault afterwards.
   *
   * The size cap is no longer one of these switches: it belongs to the account's key and
   * the administrator sets it, so its case below uses the admin API and a host restart.
   *
   * One hosted plugin plus one headless peer per case, and every arrangement is chosen so
   * that nothing here is a conflict: the two directions use different paths where the
   * option owns more than one (the file types), and the same path in an order where each
   * side's write builds on what the other already has (the groups, several of which own a
   * single file — `app.json` and friends). A conflict copy appearing anywhere is therefore
   * evidence of a defect, and the cases assert that none does.
   */
  describe("the switch matrix — every option on the settings page", () => {
    /**
     * One representative config-folder file per settings group.
     *
     * A complete `Record<SettingsGroup, string>` on purpose: a group added to the engine
     * fails `typecheck` here until the file it owns is named, so the matrix cannot lose a
     * case silently — the same reason the cases are generated from `SETTINGS_GROUPS`
     * rather than listed by hand.
     */
    const GROUP_FILES: Record<SettingsGroup, string> = {
      app: ".obsidian/app.json",
      appearance: ".obsidian/appearance.json",
      themes: ".obsidian/themes/Minimal/theme.css",
      snippets: ".obsidian/snippets/wide.css",
      hotkeys: ".obsidian/hotkeys.json",
      corePlugins: ".obsidian/core-plugins.json",
      corePluginSettings: ".obsidian/graph.json",
      communityPluginList: ".obsidian/community-plugins.json",
      communityPlugins: ".obsidian/plugins/dataview/main.js",
      otherFiles: ".obsidian/my-tool/state.json",
    };

    /** Every group, with the file it owns — one case each. */
    const GROUP_CASES = SETTINGS_GROUPS.map((group) => ({ group, path: GROUP_FILES[group] }));

    /**
     * A file per vault file type, one for each direction.
     *
     * Two paths rather than one: a file type owns a category, so a local attachment and a
     * peer's attachment are two ordinary files that must both travel — using one path for
     * both would make "the peer's version arrived" and "the peer's version overwrote mine"
     * indistinguishable, which is a conflict, not the switch.
     */
    const TYPE_FILES: Record<FileTypeGroup, { localPath: string; peerPath: string }> = {
      images: { localPath: "photos/local.png", peerPath: "photos/peer.png" },
      video: { localPath: "media/local.mp4", peerPath: "media/peer.mp4" },
      audio: { localPath: "media/local.mp3", peerPath: "media/peer.mp3" },
      pdf: { localPath: "docs/local.pdf", peerPath: "docs/peer.pdf" },
      otherTypes: { localPath: "data/local.base", peerPath: "data/peer.base" },
    };

    /** Every file type, with its two files — one case each. */
    const TYPE_CASES = FILE_TYPE_GROUPS.map((group) => ({ group, ...TYPE_FILES[group] }));

    /** Every type on: the peer has to be able to push any of the five payloads. */
    const ALL_FILE_TYPES: FileTypeSync = { ...DEFAULT_FILE_TYPES, otherTypes: true };

    /** A headless peer for the file-type cases: it syncs every type, locally and remotely. */
    async function newTypedPeer(vaultId: string, deviceName: string): Promise<TestClient> {
      const peer = await createTestClient({
        server,
        vaultId,
        key: material.key,
        deviceName,
        fileTypes: ALL_FILE_TYPES,
      });
      peers.push(peer);
      return peer;
    }

    /**
     * Wait until the server holds a chain for `path`.
     *
     * A file created through the vault fires an event, and the push that event starts is
     * asynchronous: `settle()` drains the events, not the requests they began, so the
     * chain can trail the bytes on disk by a moment. Asserting on the absence of a chain
     * needs no wait; asserting on its presence does.
     */
    async function waitForServerChain(
      vaultId: string,
      path: string,
      message: string,
    ): Promise<void> {
      await waitForAsync(
        async () => (await filesAtPath(server, vaultId, material.key, path)).length > 0,
        message,
      );
    }

    /**
     * Every config-folder group, both states, through the switch the page's toggle calls.
     *
     * The off state is exercised **twice**, because "this device ignores that group" has
     * to mean the same thing in both situations the engine meets: with no chain on the
     * server (the file on this device must not be uploaded) and with a chain the two
     * devices already share (a peer's edit must not arrive, and a local edit must not
     * overwrite it). The second half is the one that used to turn "the peer has settings
     * on" into work every pass, so it is asserted on the bytes rather than on a counter.
     */
    it.each(GROUP_CASES)("carries $group only while its switch is on", async ({ group, path }) => {
      const local = `${group}-local`;
      const fromPeer = `${group}-from-peer`;
      const later = `${group}-later`;

      // Bound with every group off (the engine's default) and the file already there: the
      // state a user is in before they touch the switch.
      const hosted = await startHostedPlugin(`Switch ${group}`, async (vault) => {
        await vault.writeConfig(path, local);
      });
      const peer = await newPeer(hosted.remote.id, `switch-peer-${group}`, {
        settingsGroups: ALL_SETTINGS_GROUPS,
      });

      // Off, with no chain anywhere: the settings pass sees nothing to do, and the peer
      // neither receives the file nor a chain it could later pull. Every pass below reads
      // the engine off the host *again*, because each switch rebuilds it: a reference
      // taken before the toggle is the old scope, which is the defect this matrix exists
      // to catch rather than to reproduce.
      await engineOf(hosted.plugin).syncLocalSettings();
      await peer.sync();
      expect(peer.read(path)).toBeNull();
      expect(await filesAtPath(server, hosted.remote.id, material.key, path)).toEqual([]);

      // On: what the toggle does — save, rebuild the host — and the bind pass that follows
      // is what puts this device's own file on the server.
      await hosted.plugin.setSettingsGroupEnabled(group, true);
      expect(hosted.plugin.settings.settingsGroups[group]).toBe(true);
      expect((await persistedSettings(hosted.plugin)).settingsGroups[group]).toBe(true);
      expect(await filesAtPath(server, hosted.remote.id, material.key, path)).toHaveLength(1);
      await peer.sync();
      expect(peer.read(path)).toBe(local);

      // On, arriving: the peer's edit is a normal modify on the chain the two now share,
      // so it lands here and parks nothing.
      peer.write(path, fromPeer);
      await peer.sync();
      await engineOf(hosted.plugin).initialSync();
      await waitFor(
        () => hosted.vault.read(path) === fromPeer,
        `the peer's ${group} file never arrived while the switch was on`,
      );
      expect(parkedConflictCopies(hosted.vault)).toEqual([]);

      // Off again, now that a chain exists: the peer's next edit stops arriving…
      await hosted.plugin.setSettingsGroupEnabled(group, false);
      expect(hosted.plugin.settings.settingsGroups[group]).toBe(false);
      expect((await persistedSettings(hosted.plugin)).settingsGroups[group]).toBe(false);
      peer.write(path, later);
      await peer.sync();
      await engineOf(hosted.plugin).syncLocalSettings();
      await engineOf(hosted.plugin).initialSync();
      expect(hosted.vault.read(path)).toBe(fromPeer);

      // …and this device's own edit stops leaving — without a tombstone or a second chain
      // for the path the two devices no longer share.
      await hosted.vault.writeConfig(path, local);
      await engineOf(hosted.plugin).syncLocalSettings();
      await peer.sync();
      expect(peer.read(path)).toBe(later);
      expect(await filesAtPath(server, hosted.remote.id, material.key, path)).toHaveLength(1);
      expect(parkedConflictCopies(hosted.vault)).toEqual([]);
    });

    /**
     * Every vault file type, both states, through the file-type switch.
     *
     * Attachments travel through vault events rather than the settings poll, so the switch
     * has to hold on the other door too: with it off, a file created through the vault's
     * own `createBinary` produces no chain, and a peer's chain produces no file — while the
     * bytes of both, once the switch is on, arrive intact. A file created while the type
     * was off is deliberately the one the on state pushes: that is the "turning it on
     * resumes where it stopped" half of the scope rule.
     */
    it.each(TYPE_CASES)(
      "carries $group attachments only while its switch is on",
      async ({ group, localPath, peerPath }) => {
        const hosted = await startHostedPlugin(`Switch ${group}`);
        const peer = await newTypedPeer(hosted.remote.id, `switch-peer-${group}`);
        const localBytes = attachmentBytes(24, 1);
        const peerBytes = attachmentBytes(24, 2);

        // Off: the file this device makes stays here, and the peer's stays there. The
        // engine is read off the host after the switch, not before it: the toggle rebuilds
        // the host, and a stale reference would still be running the on scope.
        await hosted.plugin.setFileTypeEnabled(group, false);
        expect(hosted.plugin.settings.fileTypes[group]).toBe(false);
        expect((await persistedSettings(hosted.plugin)).fileTypes[group]).toBe(false);

        await hosted.vault.createAttachment(localPath, localBytes);
        await hosted.vault.settle();
        await engineOf(hosted.plugin).initialSync();
        expect(engineOf(hosted.plugin).fileIdForPath(localPath)).toBeNull();
        expect(await filesAtPath(server, hosted.remote.id, material.key, localPath)).toEqual([]);

        peer.writeBinary(peerPath, peerBytes);
        await peer.sync();
        await engineOf(hosted.plugin).initialSync();
        expect(hosted.vault.has(peerPath)).toBe(false);
        expect(parkedConflictCopies(hosted.vault)).toEqual([]);

        // On: the rebuild's bind pass picks both up — the local attachment the scope had
        // been dropping, and the peer's chain it had been ignoring.
        await hosted.plugin.setFileTypeEnabled(group, true);
        expect(hosted.plugin.settings.fileTypes[group]).toBe(true);
        expect((await persistedSettings(hosted.plugin)).fileTypes[group]).toBe(true);
        expect(await filesAtPath(server, hosted.remote.id, material.key, localPath)).toHaveLength(
          1,
        );
        await waitFor(
          () => hosted.vault.has(peerPath),
          `the peer's ${group} attachment never arrived while the switch was on`,
        );
        expect(Array.from(new Uint8Array(await hosted.vault.adapter.readBinary(peerPath)))).toEqual(
          Array.from(peerBytes),
        );
        await peer.sync();
        expect(Array.from(peer.readBytes(localPath) ?? [])).toEqual(Array.from(localBytes));
      },
    );

    /**
     * The size cap, now an administrator decision on the account's key.
     *
     * `0` is not "nothing" but "no limit": the case has to show a file over the cap
     * staying home *and* the same file travelling once the cap is lifted, with the skip
     * reported. A file that silently never leaves is exactly what the cap looks like when
     * the report is missing, so the notice is asserted on both halves of its wording — the
     * file, and the administrator-set limit.
     */
    it("keeps a file over the size cap at home, reports it, and carries it once the cap is lifted", async () => {
      const small = attachmentBytes(40, 3);
      const large = attachmentBytes(400, 4);
      // The administrator's decision, on the account's key.
      await setUserMaxFileBytes(server, 64);
      try {
        const hosted = await startHostedPlugin("Switch Size Cap");
        const peer = await newPeer(hosted.remote.id, "cap-peer");

        // The host read the account's cap at start.
        expect(hosted.plugin.settings.accountMaxFileBytes).toBe(64);
        expect((await persistedSettings(hosted.plugin)).accountMaxFileBytes).toBe(64);

        await hosted.vault.createAttachment("photos/small.png", small);
        await hosted.vault.createAttachment("photos/large.png", large);
        await hosted.vault.settle();
        await engineOf(hosted.plugin).initialSync();

        // Under the cap: on the server and at the peer. Over it: no chain here, nothing
        // there — and the user is told which file was skipped and who sets the limit.
        await waitForServerChain(
          hosted.remote.id,
          "photos/small.png",
          "the file under the cap never reached the server",
        );
        expect(
          await filesAtPath(server, hosted.remote.id, material.key, "photos/small.png"),
        ).toHaveLength(1);
        expect(engineOf(hosted.plugin).fileIdForPath("photos/large.png")).toBeNull();
        expect(
          await filesAtPath(server, hosted.remote.id, material.key, "photos/large.png"),
        ).toEqual([]);
        await peer.sync();
        expect(Array.from(peer.readBytes("photos/small.png") ?? [])).toEqual(Array.from(small));
        expect(peer.readBytes("photos/large.png")).toBeNull();
        await waitFor(
          () =>
            notices.some(
              (message) =>
                message.includes("photos/large.png") && message.includes("由管理员按密钥设置"),
            ),
          "the file the cap skipped was never reported",
        );

        // Every pass meets the file again (the engine reports per pass), so the plugin's
        // per-session dedupe is what stops this becoming a reminder every five minutes.
        const capNotices = notices.filter((message) =>
          message.includes("由管理员按密钥设置"),
        ).length;
        await engineOf(hosted.plugin).initialSync();
        // Past the burst window, so a second line would have been emitted by now.
        await new Promise((resolve) => setTimeout(resolve, 1700));
        expect(notices.filter((message) => message.includes("由管理员按密钥设置"))).toHaveLength(
          capNotices,
        );

        // 0 is "no limit", not "nothing": the administrator lifts it and the next host
        // start applies the new value — the same file then travels on the next bind.
        await setUserMaxFileBytes(server, 0);
        await hosted.plugin.startHost();
        expect(hosted.plugin.settings.accountMaxFileBytes).toBe(0);
        expect((await persistedSettings(hosted.plugin)).accountMaxFileBytes).toBe(0);
        expect(
          await filesAtPath(server, hosted.remote.id, material.key, "photos/large.png"),
        ).toHaveLength(1);
        await peer.sync();
        expect(Array.from(peer.readBytes("photos/large.png") ?? [])).toEqual(Array.from(large));
      } finally {
        await setUserMaxFileBytes(server, DEFAULT_MAX_FILE_BYTES);
      }
    });

    /**
     * The page's own switch list, checked against the engine's option lists.
     *
     * The matrix above drives the three write paths; this is the other half of "the option
     * list is covered where the user touches it": the page renders exactly one switch per
     * group and per file type, in the engine's order, showing the engine's default. A group
     * added to the engine fails here until the page offers it, and the assertion does not
     * depend on the labels the page happens to use. It ends by flipping one rendered toggle
     * — the control a user actually presses — because the link from a switch on the page to
     * the host that reads the scope is the one thing calling the plugin's methods directly
     * cannot cover.
     */
    it("offers one switch per option, and the switch it renders reaches the host", async () => {
      const hosted = await startHostedPlugin("Switch Page");
      const tab = settingsTabOf(hosted.plugin);
      tab.display();
      await waitFor(
        () => settingsIn(tab.containerEl).some((row) => row.name === "同步的文件类型"),
        "the settings step never rendered",
      );

      const rows = settingsIn(tab.containerEl);
      /** One section's rows: everything between its heading and the next heading. */
      const sectionRows = (title: string): Setting[] => {
        const start = rows.findIndex((row) => row.name === title);
        const rest = rows.slice(start + 1);
        const end = rest.findIndex(
          (row) =>
            row.name !== "" &&
            row.desc === "" &&
            !row.toggles.length &&
            !row.texts.length &&
            !row.buttons.length,
        );
        return end === -1 ? rest : rest.slice(0, end);
      };

      const typeRows = sectionRows("同步的文件类型");
      expect(typeRows.flatMap((row) => row.toggles).map((toggle) => toggle.getValue())).toEqual(
        FILE_TYPE_GROUPS.map((group) => DEFAULT_FILE_TYPES[group]),
      );
      // The size cap is the administrator's and has no field on this page.
      expect(typeRows.flatMap((row) => row.texts)).toEqual([]);

      // The rows follow the engine's order, so the first one is the first group — the row
      // this case flips, without needing to know how the page labels it.
      const groupRows = sectionRows("Obsidian 设置同步");
      expect(groupRows.flatMap((row) => row.toggles).map((toggle) => toggle.getValue())).toEqual(
        SETTINGS_GROUPS.map((group) => NO_SETTINGS_GROUPS[group]),
      );

      const firstGroup = SETTINGS_GROUPS[0]!;
      const path = GROUP_FILES[firstGroup];
      const content = `${firstGroup}-from-the-page`;
      await hosted.vault.writeConfig(path, content);
      groupRows[0]!.toggles[0]!.simulateChange(true);

      // Pressing it saves, rebuilds the host, and the bind pass that follows is what puts
      // the file on the server — the same journey the matrix asserts through the method.
      await waitForServerChain(
        hosted.remote.id,
        path,
        "the switch rendered on the page never reached the host",
      );
      expect(hosted.plugin.settings.settingsGroups[firstGroup]).toBe(true);
      expect((await persistedSettings(hosted.plugin)).settingsGroups[firstGroup]).toBe(true);

      const peer = await newPeer(hosted.remote.id, "page-peer", {
        settingsGroups: ALL_SETTINGS_GROUPS,
      });
      await peer.sync();
      expect(peer.read(path)).toBe(content);
    });
  });

  /**
   * The excluded-folder switch, through the real plugin and the real settings page.
   *
   * The scope is device-local like the file types, so every case goes through the
   * plugin's own write paths (which save and rebuild the host) instead of mutating
   * `plugin.settings` under a host still running the old scope. The move case is the
   * one the feature would be dangerous without: a note moved into an excluded folder
   * must not be read as a deletion of the note every peer still has.
   */
  describe("excluded folders", () => {
    it("keeps an excluded folder on this device, and resumes it when the exclusion is removed", async () => {
      const hosted = await startHostedPlugin(
        "Excluded Folders",
        async (vault) => {
          await vault.create("private/local.md", "local");
          await vault.create("public.md", "public");
        },
        { excludedFolders: ["private"] },
      );
      const peer = await newPeer(hosted.remote.id, "excluded-peer");

      // The bind pass pushed the public note and left the excluded one alone.
      await waitForAsync(
        async () =>
          (await filesAtPath(server, hosted.remote.id, material.key, "public.md")).length > 0,
        "the public note never reached the server",
      );
      expect(await filesAtPath(server, hosted.remote.id, material.key, "private/local.md")).toEqual(
        [],
      );

      // The peer has no exclusion, so it pushes its own note; this device ignores it.
      peer.write("private/peer.md", "peer");
      await peer.sync();
      await engineOf(hosted.plugin).initialSync();
      expect(hosted.vault.has("private/peer.md")).toBe(false);
      expect(parkedConflictCopies(hosted.vault)).toEqual([]);

      // Removing the exclusion rebuilds the host: the bind pass that follows pushes the
      // local note and pulls the peer's, with no conflict copy either way.
      await hosted.plugin.setExcludedFolders(
        hosted.plugin.settings.excludedFolders.filter((folder) => folder !== "private"),
      );
      await waitForAsync(
        async () =>
          (await filesAtPath(server, hosted.remote.id, material.key, "private/local.md")).length >
          0,
        "the un-excluded local note never reached the server",
      );
      await waitFor(
        () => hosted.vault.read("private/peer.md") === "peer",
        "the un-excluded peer note never arrived",
      );
      expect(parkedConflictCopies(hosted.vault)).toEqual([]);
    });

    it("re-decorates the explorer when a connect brings its own excluded folders", async () => {
      // The chips are DOM, so what this layer can pin is the wiring: a connect from the
      // picker (or the setup dialog) replaces the active list, and the rows decorated under
      // the previous one have to be re-done — otherwise an excluded file keeps its entry
      // point until its row happens to rebuild.
      const remote = await createTestVault(server, "Connect Exclusions", material);
      const vault = new FakeVault();
      await vault.create("private/local.md", "local");
      const { plugin } = await loadPlugin({
        vault,
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });
      const refresh = vi.spyOn(plugin, "refreshExcludedFolderRows");

      const outcome = await plugin.connectToVault(remote.id, remote.name, material.password, true, {
        deviceName: "My Device",
        excludedFolders: ["private"],
      });

      expect(outcome.ok, "the vault could not be bound").toBe(true);
      expect(plugin.settings.excludedFolders).toEqual(["private"]);
      expect(refresh, "the connect never re-decorated the file explorer").toHaveBeenCalled();
    });

    it("does not tombstone a note moved into an excluded folder", async () => {
      const hosted = await startHostedPlugin(
        "Excluded Move",
        async (vault) => {
          await vault.create("note.md", "body");
        },
        { excludedFolders: ["private"] },
      );
      const peer = await newPeer(hosted.remote.id, "excluded-move-peer");
      await waitForAsync(
        async () =>
          (await filesAtPath(server, hosted.remote.id, material.key, "note.md")).length > 0,
        "the note never reached the server",
      );
      const fileId = hosted.plugin.engine!.fileIdForPath("note.md")!;
      await peer.sync();
      expect(peer.read("note.md")).toBe("body");

      // Obsidian reports a rename with both paths: the engine records the new path and
      // pushes nothing, because the destination is outside this device's scope.
      await hosted.vault.createFolder("private");
      const note = hosted.vault.getAbstractFileByPath("note.md");
      if (!note || !("extension" in note)) throw new Error("the note is not a TFile");
      await hosted.vault.rename(
        note as Parameters<typeof hosted.vault.rename>[0],
        "private/note.md",
      );
      await hosted.vault.settle();
      await waitFor(
        () => engineOf(hosted.plugin).fileIdForPath("private/note.md") === fileId,
        "the engine never recorded the move into the excluded folder",
      );
      await engineOf(hosted.plugin).initialSync();

      expect((await fileVersions(server, hosted.remote.id, fileId)).map((v) => v.action)).toEqual([
        "create",
      ]);
      await peer.sync();
      expect(peer.read("note.md")).toBe("body");
      expect(peer.read("private/note.md")).toBeNull();

      // The folder comes back into scope: the same chain is renamed to the new path,
      // and the peer follows it instead of ending up with two files.
      await hosted.plugin.setExcludedFolders(
        hosted.plugin.settings.excludedFolders.filter((folder) => folder !== "private"),
      );
      await waitForAsync(async () => {
        const versions = await fileVersions(server, hosted.remote.id, fileId);
        return versions.at(-1)?.action === "rename";
      }, "the move was never pushed once the folder was back in scope");
      await peer.sync();
      expect(peer.read("note.md")).toBeNull();
      expect(peer.read("private/note.md")).toBe("body");
    });

    /**
     * The same move, delivered the way an external tool does it: the disks and the vault
     * index changed, but no rename event was raised, so the host only hears the old path
     * disappear. The engine has to find the file under the excluded folder and record the
     * move; a tombstone here would delete, on the peer, a note the user still owns.
     */
    it("does not tombstone a move into an excluded folder that raised no vault event", async () => {
      const hosted = await startHostedPlugin(
        "Excluded Eventless",
        async (vault) => {
          await vault.create("note.md", "body");
          await vault.createFolder("private");
        },
        { excludedFolders: ["private"] },
      );
      const peer = await newPeer(hosted.remote.id, "excluded-eventless-peer");
      await waitForAsync(
        async () =>
          (await filesAtPath(server, hosted.remote.id, material.key, "note.md")).length > 0,
        "the note never reached the server",
      );
      const fileId = hosted.plugin.engine!.fileIdForPath("note.md")!;
      await peer.sync();
      expect(peer.read("note.md")).toBe("body");

      // `adapter.rename` is the plain filesystem layer: it moves the bytes into the
      // excluded folder and fires no vault event (Obsidian's data adapter fires none).
      // Feeding only the delete half is what the host sees for such a move.
      await hosted.vault.adapter.rename("note.md", "private/note.md");
      await engineOf(hosted.plugin).handleLocalDelete("note.md");
      await engineOf(hosted.plugin).initialSync();

      expect((await fileVersions(server, hosted.remote.id, fileId)).map((v) => v.action)).toEqual([
        "create",
      ]);
      expect(engineOf(hosted.plugin).fileIdForPath("private/note.md")).toBe(fileId);
      await peer.sync();
      expect(peer.read("note.md")).toBe("body");
      expect(peer.read("private/note.md")).toBeNull();
    });

    it("manages the folder tree through the page's Manage dialog", async () => {
      const hosted = await startHostedPlugin("Excluded Settings", async (vault) => {
        await vault.create("private/note.md", "private");
        await vault.create("daily/note.md", "daily");
        await vault.create("projects/create NFT's/note.md", "nft");
      });
      const tab = settingsTabOf(hosted.plugin);
      tab.display();
      await waitFor(
        () => settingsIn(tab.containerEl).some((row) => row.name === "排除列表"),
        "the excluded-folder row never rendered",
      );

      // The page keeps one row; the tree is a dialog, like Obsidian Sync's own.
      const manageRow = settingsIn(tab.containerEl).find((row) => row.name === "排除列表")!;
      expect(manageRow.buttons.map((button) => button.text)).toEqual(["管理"]);
      manageRow.buttons[0]!.click();
      const modal = lastOpenedModal()!;
      expect(modal.title).toBe("管理排除的文件夹");
      expect(modal.isOpen).toBe(true);

      /** The dialog's row for a folder, by the name it renders. */
      const rowFor = (name: string): FakeEl => {
        const row = elementsWithClass(modal.contentEl, "courier-excluded-folder-row").find(
          (entry) => allText(entry).includes(name),
        );
        if (!row) throw new Error(`the dialog has no "${name}" row`);
        return row;
      };
      /** The checkbox a row renders, as the DOM element the dialog listens to. */
      const checkboxFor = (name: string) =>
        elementsWithClass(rowFor(name), "courier-excluded-folder-checkbox")[0] as unknown as {
          checked: boolean;
          disabled: boolean;
          listeners: Record<string, Array<(event: unknown) => void>>;
        };
      /** Change a checkbox the way a user would: toggle it, then fire `change`. */
      const setChecked = (name: string, checked: boolean): void => {
        const checkbox = checkboxFor(name);
        checkbox.checked = checked;
        for (const listener of checkbox.listeners["change"] ?? []) listener({});
      };

      // The tree comes from the vault's own folders, including the nested one, and every
      // row carries the folder icon before its name.
      expect(allText(modal.contentEl).join(" ")).toContain("projects");
      expect(allText(modal.contentEl).join(" ")).toContain("daily");
      expect(allText(modal.contentEl).join(" ")).toContain("create NFT's");
      expect(elementsWithClass(rowFor("projects"), "courier-excluded-folder-icon")[0]!.icon).toBe(
        "folder",
      );

      // The disclosure arrow collapses the children without changing the selection.
      const projectsNode = rowFor("projects").parent!;
      const childrenEl = elementsWithClass(projectsNode, "courier-excluded-folder-children")[0]!;
      elementsWithClass(rowFor("projects"), "courier-excluded-folder-toggle")[0]!.click();
      expect(childrenEl.style.display).toBe("none");
      elementsWithClass(rowFor("projects"), "courier-excluded-folder-toggle")[0]!.click();
      expect(childrenEl.style.display).toBe("");

      // Checking a parent covers its children: they are checked and disabled (the CSS
      // greys them), and the summary counts the one explicit exclusion.
      setChecked("projects", true);
      expect(checkboxFor("projects").checked).toBe(true);
      expect(checkboxFor("create NFT's").checked).toBe(true);
      expect(checkboxFor("create NFT's").disabled).toBe(true);
      expect(allText(modal.contentEl).join(" ")).toContain("已排除 1 个文件夹");

      elementsWithClass(modal.contentEl, "courier-excluded-folders-done")[0]!.click();
      await waitFor(
        () => hosted.plugin.settings.excludedFolders.includes("projects"),
        "the dialog's Done never reached the settings",
      );
      await waitFor(() => !modal.isOpen, "the dialog never closed after Done");
      expect(((await hosted.plugin.loadData()) as CourierSettings).excludedFolders).toEqual([
        "projects",
      ]);

      // Reopening shows the saved state; unchecking the parent clears it.
      tab.display();
      const reopenedRow = settingsIn(tab.containerEl).find((row) => row.name === "排除列表")!;
      expect(reopenedRow.desc).toContain("1 个文件夹");
      reopenedRow.buttons[0]!.click();
      const reopened = lastOpenedModal()!;
      const reopenedCheckbox = elementsWithClass(
        elementsWithClass(reopened.contentEl, "courier-excluded-folder-row").find((entry) =>
          allText(entry).includes("projects"),
        )!,
        "courier-excluded-folder-checkbox",
      )[0] as unknown as {
        checked: boolean;
        listeners: Record<string, Array<(event: unknown) => void>>;
      };
      expect(reopenedCheckbox.checked).toBe(true);
      reopenedCheckbox.checked = false;
      for (const listener of reopenedCheckbox.listeners["change"] ?? []) listener({});
      elementsWithClass(reopened.contentEl, "courier-excluded-folders-done")[0]!.click();

      await waitFor(
        () => hosted.plugin.settings.excludedFolders.length === 0,
        "the dialog's Done never cleared the settings",
      );
      expect(((await hosted.plugin.loadData()) as CourierSettings).excludedFolders).toEqual([]);
    });

    it("toggles from the row and saves only when Done is pressed", async () => {
      const hosted = await startHostedPlugin("Excluded Row Click", async (vault) => {
        await vault.create("daily/note.md", "daily");
        await vault.create("archive/note.md", "archive");
      });
      const tab = settingsTabOf(hosted.plugin);
      tab.display();
      const open = (): Modal => {
        tab.display();
        const row = settingsIn(tab.containerEl).find((entry) => entry.name === "排除列表")!;
        row.buttons[0]!.click();
        return lastOpenedModal()!;
      };

      let modal = open();
      const dailyRow = elementsWithClass(modal.contentEl, "courier-excluded-folder-row").find(
        (row) => allText(row).includes("daily"),
      )!;
      dailyRow.click();
      const checkbox = elementsWithClass(
        dailyRow,
        "courier-excluded-folder-checkbox",
      )[0] as unknown as { checked: boolean };
      expect(checkbox.checked).toBe(true);

      // Closing is still a cancel: the pending selection is not written.
      modal.close();
      expect(hosted.plugin.settings.excludedFolders).toEqual([]);
      expect(((await hosted.plugin.loadData()) as CourierSettings).excludedFolders).toEqual([]);

      // Reopening starts from the saved list again; this time 完成 writes it.
      modal = open();
      elementsWithClass(modal.contentEl, "courier-excluded-folder-row")
        .find((row) => allText(row).includes("daily"))!
        .click();
      elementsWithClass(modal.contentEl, "courier-excluded-folders-done")[0]!.click();
      await waitFor(
        () => hosted.plugin.settings.excludedFolders.includes("daily"),
        "the dialog's Done did not save the row selection",
      );
      expect(((await hosted.plugin.loadData()) as CourierSettings).excludedFolders).toEqual([
        "daily",
      ]);

      await hosted.plugin.setExcludedFolders([]);
    });

    it("keeps a deleted folder's exclusion aside, and applies it again when the path returns", async () => {
      const hosted = await startHostedPlugin(
        "Excluded Missing",
        async (vault) => {
          await vault.create("ghost/note.md", "ghost");
        },
        { excludedFolders: ["ghost"] },
      );
      const tab = settingsTabOf(hosted.plugin);

      /** Open the manage dialog from the settings page, the way a user does. */
      const open = (): Modal => {
        tab.display();
        const row = settingsIn(tab.containerEl).find((entry) => entry.name === "排除列表")!;
        row.buttons[0]!.click();
        return lastOpenedModal()!;
      };
      // The folder exists: it is a checked row in the live tree.
      let modal = open();
      expect(ghostRowIn(modal)).toBeDefined();
      expect(ghostCheckboxIn(modal).checked).toBe(true);
      modal.close();

      // Delete it. The rule stays, but it is no longer a live folder: the tree has no row
      // for it, and the dialog shows it in the deleted-folders section instead.
      await hosted.vault.deleteFolder("ghost");
      await hosted.vault.settle();
      modal = open();
      expect(ghostRowIn(modal)).toBeUndefined();
      expect(treeRows(modal)).toEqual([]);
      const missing = elementsWithClass(modal.contentEl, "courier-excluded-folders-missing")[0];
      if (!missing) throw new Error("the dialog has no deleted-folders section");
      expect(allText(missing).join(" ")).toContain("ghost");
      expect(allText(modal.contentEl).join(" ")).toContain("已删除的文件夹");
      expect(allText(modal.contentEl).join(" ")).toContain("已排除 1 个文件夹");
      modal.close();

      // Recreating the same path reuses the rule: the folder is excluded again, exactly
      // because the stored list is a path rule and the delete did not silently drop it.
      await hosted.vault.createFolder("ghost");
      await hosted.vault.settle();
      modal = open();
      expect(ghostRowIn(modal)).toBeDefined();
      expect(ghostCheckboxIn(modal).checked).toBe(true);
      ghostCheckboxIn(modal).checked = false;
      for (const listener of ghostCheckboxIn(modal).listeners["change"] ?? []) listener({});
      elementsWithClass(modal.contentEl, "courier-excluded-folders-done")[0]!.click();
      await waitFor(
        () => hosted.plugin.settings.excludedFolders.length === 0,
        "the dialog's Done never cleared the recreated folder's exclusion",
      );
      expect(((await hosted.plugin.loadData()) as CourierSettings).excludedFolders).toEqual([]);

      function ghostRowIn(current: Modal): FakeEl | undefined {
        return treeRows(current).find((entry) => allText(entry).includes("ghost"));
      }

      function ghostCheckboxIn(current: Modal): {
        checked: boolean;
        listeners: Record<string, Array<(event: unknown) => void>>;
      } {
        const row = ghostRowIn(current);
        if (!row) throw new Error("the dialog has no ghost row");
        return elementsWithClass(row, "courier-excluded-folder-checkbox")[0] as unknown as {
          checked: boolean;
          listeners: Record<string, Array<(event: unknown) => void>>;
        };
      }
    });

    it("keeps an exclusion the folder tree cannot show when Done is pressed", async () => {
      // `.obsidian` is not in the vault index, so the tree has no row for it — but it is
      // still a stored exclusion (a CLI may have written it). 完成 must write it back
      // instead of dropping it because this dialog cannot render it.
      const hosted = await startHostedPlugin(
        "Excluded Untouched",
        async (vault) => {
          await vault.create("daily/note.md", "daily");
        },
        { excludedFolders: [".obsidian", "daily"] },
      );
      const tab = settingsTabOf(hosted.plugin);
      tab.display();
      const manageRow = settingsIn(tab.containerEl).find((row) => row.name === "排除列表")!;
      manageRow.buttons[0]!.click();
      const modal = lastOpenedModal()!;
      expect(allText(modal.contentEl).join(" ")).not.toContain(".obsidian");

      elementsWithClass(modal.contentEl, "courier-excluded-folders-done")[0]!.click();
      await waitFor(() => !modal.isOpen, "the dialog never closed after Done");

      // No change means no host restart, so the order the list was stored in survives.
      expect(hosted.plugin.settings.excludedFolders).toEqual([".obsidian", "daily"]);
      expect(((await hosted.plugin.loadData()) as CourierSettings).excludedFolders).toEqual([
        ".obsidian",
        "daily",
      ]);
    });
  });

  /**
   * The settings page itself.
   *
   * Driven through the real tab the plugin registered on load, whose DOM the stub
   * records: which step is shown, where an explanation lives (tooltip, not a
   * paragraph), where a failure is reported, how little a switch says, and the
   * sync-history region all come from real code reading the real server. What the
   * stub cannot answer — whether it *looks* right on a phone — stays manual (L4).
   */
  describe("the settings tab", () => {
    /**
     * A plugin with no user key: the page has to start at the login step.
     *
     * `loadPlugin` seeds the server's own key to model "already signed in", so the
     * signed-out state has to say `userKey: null` explicitly.
     */
    async function loadSignedOutPlugin(): Promise<CourierPlugin> {
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { serverUrl: server.serverUrl, userKey: null },
      });
      return plugin;
    }

    /** Fill the login step's two fields. */
    function fillLogin(tab: { containerEl: FakeEl }, serverUrl: string, userKey: string): void {
      const inputs = loginInputs(tab);
      typeInto(inputs.server, serverUrl);
      typeInto(inputs.key, userKey);
    }

    /** The section headings the current step rendered. */
    function sectionNames(tab: { containerEl: FakeEl }): string[] {
      return settingsIn(tab.containerEl).map((row) => row.name);
    }

    it("shows the centred sign-in form before signing in", async () => {
      const plugin = await loadSignedOutPlugin();
      const tab = settingsTabOf(plugin);
      tab.display();

      // The form's title and subtitle, two field labels and the button. No brand block,
      // no privacy line, no step counter and no section heading.
      expect(allText(tab.containerEl)).toEqual([
        "登录 Courier",
        "使用服务器地址与用户密钥登录。",
        "服务器地址",
        "用户密钥",
        "登录",
      ]);

      // A form, not Obsidian's settings rows (label left, control right).
      const inputs = elementsWithClass(tab.containerEl, "courier-login-input");
      expect(inputs).toHaveLength(2);
      expect(inputs[0]!.classes).toContain("courier-login-input");
      expect((inputs[0] as unknown as { placeholder: string }).placeholder).toBe(
        "https://your-server.com",
      );
      expect(elementsWithClass(tab.containerEl, "courier-login-submit")[0]!.text).toBe("登录");
      // The step is an item in the definitions, so the app creates a row to host it; the
      // page strips that row's chrome (`courier-login-row`) and the form is the content, so
      // what the user sees is the form and not a settings row.
      const hostRows = settingsIn(tab.containerEl);
      expect(hostRows).toHaveLength(1);
      expect(hostRows[0]!.settingEl.classes).toContain("courier-login-row");
      expect(buttonsIn(tab.containerEl)).toEqual([]);
      expect(extraButtonsIn(tab.containerEl)).toEqual([]);

      // The form carries its own heading, but it is not a page-level `h2` that repeats the
      // plugin's name above the pane: the role is the one piece of semantics the title needs.
      const title = elementsWithClass(tab.containerEl, "courier-login-title")[0]!;
      expect(title.text).toBe("登录 Courier");
      expect(title.getAttribute("role")).toBe("heading");
      expect(tab.containerEl.children.some((child) => child.tagName === "h2")).toBe(false);

      // One form in the middle of the pane: no brand panel, no card, no background shell
      // and no privacy line.
      const page = elementsWithClass(tab.containerEl, "courier-login")[0]!;
      expect(page.classes).toContain("courier-login");
      expect(elementsWithClass(tab.containerEl, "courier-login-panel")).toHaveLength(1);
      expect(elementsWithClass(tab.containerEl, "courier-login-card")).toHaveLength(0);
      expect(elementsWithClass(tab.containerEl, "courier-login-intro")).toHaveLength(0);
      expect(elementsWithClass(tab.containerEl, "courier-login-device-note")).toHaveLength(0);
      const fieldIcons = elementsWithClass(tab.containerEl, "courier-login-field-icon");
      expect(fieldIcons).toHaveLength(2);
      expect(fieldIcons.every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);

      // The key can be read back before it is submitted, and the toggle stays on the field
      // it reveals.
      const reveal = elementsWithClass(tab.containerEl, "courier-login-reveal")[0]!;
      expect(reveal.icon).toBe("eye");
      expect(reveal.getAttribute("aria-pressed")).toBe("false");
      reveal.click();
      expect((loginInputs(tab).key as unknown as { type: string }).type).toBe("text");
      expect(reveal.icon).toBe("eye-off");
      expect(reveal.getAttribute("aria-pressed")).toBe("true");
      reveal.click();
      expect((loginInputs(tab).key as unknown as { type: string }).type).toBe("password");
      expect(reveal.getAttribute("aria-pressed")).toBe("false");
    });

    it("signs in once when Enter is pressed while the request is in flight", async () => {
      const plugin = await loadSignedOutPlugin();
      const tab = settingsTabOf(plugin);
      tab.display();

      const signIn = vi.spyOn(plugin, "signIn").mockReturnValue(new Promise<never>(() => {}));
      const pressEnter = (): void => {
        for (const listener of loginInputs(tab).server.listeners.keydown ?? []) {
          listener({ key: "Enter" });
        }
      };
      pressEnter();
      pressEnter();

      expect(signIn).toHaveBeenCalledTimes(1);
      signIn.mockRestore();
    });

    it("repeats a server address that is wider than its field", async () => {
      const plugin = await loadSignedOutPlugin();
      const tab = settingsTabOf(plugin);
      tab.display();

      const addressInput = loginInputs(tab).server as FakeEl & {
        scrollWidth: number;
        clientWidth: number;
      };
      addressInput.scrollWidth = 720;
      addressInput.clientWidth = 420;
      const address = "https://sync.example.com/courier";
      typeInto(loginInputs(tab).server, address);

      const full = elementsWithClass(tab.containerEl, "courier-login-url-full")[0]!;
      expect(full.classes).toContain("is-visible");
      expect(full.text).toBe(`完整地址：${address}`);

      // A value that fits stays in the field alone: the line is a repair for a clipped
      // value, not a second copy of every address.
      addressInput.scrollWidth = 300;
      typeInto(loginInputs(tab).server, address);
      expect(full.classes).not.toContain("is-visible");
      expect(full.text).toBe("");
    });

    it("reports a rejected user key in place and stays on the first step", async () => {
      const plugin = await loadSignedOutPlugin();
      const tab = settingsTabOf(plugin);
      tab.display();

      fillLogin(tab, server.serverUrl, "ck_this_key_does_not_exist");
      clickControl(tab.containerEl, "courier-login-submit");

      await waitFor(
        () => allText(tab.containerEl).some((text) => text.includes("用户密钥无效或已过期")),
        "the rejected key was never reported",
      );
      // Still the form: no vault step appeared, the error has its own block inside the form,
      // and the fields are there to fix.
      expect(loginInputs(tab).server).toBeTruthy();
      const error = elementsWithClass(tab.containerEl, "courier-login-error")[0]!;
      expect(error.getAttribute("role")).toBe("alert");
      expect(error.getAttribute("id")).toBe("courier-login-error");
      expect(loginInputs(tab).server.getAttribute("aria-describedby")).toBe("courier-login-error");
      expect(loginInputs(tab).key.getAttribute("aria-describedby")).toBe("courier-login-error");
      expect(sectionNames(tab)).not.toContain("选择远程库");
      // What the user typed is kept, so the fix is one field away.
      expect(plugin.settings.userKey).toBe("ck_this_key_does_not_exist");
      expect(plugin.settings.serverUrl).toBe(server.serverUrl);

      // The app keys a setting item by its name, so two items may never share one: the error
      // line is part of the form's row for exactly this reason.
      const names = definitionNames(tab);
      expect(new Set(names).size).toBe(names.length);
    });

    it("moves to the account row once the key is accepted, and keeps the list behind one button", async () => {
      // The shared account accumulates vaults across the file, but this assertion has
      // to hold when the test runs alone too.
      const remote = await createTestVault(server, "Stage Choose", material);
      const plugin = await loadSignedOutPlugin();
      const tab = settingsTabOf(plugin);
      tab.display();
      // The login step flattens the app's grouping panel so the form is the surface.
      expect(tab.containerEl.classes).toContain("courier-login-group");
      const loginRow = settingsIn(tab.containerEl)[0]!.settingEl;

      fillLogin(tab, server.serverUrl, server.userKey);
      clickControl(tab.containerEl, "courier-login-submit");

      await waitFor(
        () => sectionNames(tab).includes("选择远程库"),
        "the vault step never appeared",
      );
      // Leaving the login step gives the app's grouping panel and the login row their
      // chrome back, even if the app reuses those elements.
      expect(tab.containerEl.classes).not.toContain("courier-login-group");
      expect(loginRow.classes).not.toContain("courier-login-row");

      // The account row: the name the key belongs to and the server it belongs to,
      // with signing out as its only action — the destructive one, so it is red.
      expect(plugin.settings.userName).toBe("plugin e2e user");
      const account = settingsIn(tab.containerEl).find((row) => row.name === "plugin e2e user")!;
      expect(account.desc).toContain(`服务器：${server.serverUrl}`);
      expect(account.buttons.map((button) => button.text)).toEqual(["退出登录"]);
      expect(account.buttons[0]!.isWarning).toBe(true);

      // No step counter and no title: the page is rows.
      const body = allText(tab.containerEl).join(" ");
      expect(body).not.toContain("步");
      expect(body).not.toContain("Courier");
      // The switches are still hidden: a vault has not been chosen yet.
      expect(sectionNames(tab)).not.toContain("同步的文件类型");

      // The vault row is one row whatever the account holds; the list is behind it.
      const picker = await openVaultPickerWith(plugin, remote.name);
      // The row's action is connecting; deleting is an icon button, so a list of
      // vaults stays readable instead of being a wall of text buttons.
      const row = vaultRowIn(picker, remote.name);
      expect(row.buttons.map((button) => button.text)).toEqual(["连接"]);
      expect(row.extraButtons.map((button) => button.tooltip)).toEqual(["删除远程库"]);
      expect(row.extraButtons[0]!.icon).toBe("trash-2");
      expect(row.desc).toMatch(/^创建于 /);
      // The picker is a card list, not a settings page: the modal carries its own class,
      // each vault has a cloud tile, and the create entry is the dashed row under the list.
      expect(picker.modalEl.classes).toContain("courier-vault-picker-modal");
      expect(allText(picker.contentEl).join(" ")).toContain(t("dialog.vaultPicker.subtitle"));
      expect(row.settingEl.classes).toContain("courier-vault-row");
      expect(row.settingEl.children[0]?.classes).toContain("courier-vault-icon");
      expect(row.settingEl.querySelector(".courier-vault-icon")?.icon).toBe("cloud");
      expect(row.buttons[0]!.buttonEl.classes).toContain("courier-vault-connect");
      // Both of the dialog's buttons keep their content width: Obsidian's phone layout
      // otherwise stretches every control in a settings row across the whole row.
      expect(row.buttons[0]!.buttonEl.style.flex).toBe("0 0 auto");
      const createButton = buttonsIn(picker.contentEl).find(
        (button) => button.text === "创建远程库",
      )!;
      expect(createButton, "no 创建 Vault button").toBeDefined();
      expect(createButton.buttonEl.style.flex).toBe("0 0 auto");
      expect(createButton.buttonEl.classes).toContain("courier-vault-create-button");
      expect(createButton.buttonEl.querySelector(".courier-vault-create-icon")?.icon).toBe("plus");
    });

    describe("vault picker states", () => {
      it("shows the empty state when the account has no vaults", async () => {
        const picker = openPickerWithHost(pickerHostWith(async () => ({ vaults: [] })));
        const content = picker.contentEl as unknown as FakeEl;
        await waitFor(
          () => allText(content).join(" ").includes(t("dialog.vaultPicker.emptyTitle")),
          "the picker never rendered its empty state",
        );
        expect(elementsWithClass(content, "courier-vault-empty")).toHaveLength(1);
        expect(allText(content).join(" ")).toContain(t("dialog.vaultPicker.emptyHint"));
      });

      it("shows a failed list and retries it", async () => {
        let calls = 0;
        const picker = openPickerWithHost(
          pickerHostWith(async () => {
            calls += 1;
            if (calls === 1) throw new Error("listing failed");
            return { vaults: [] };
          }),
        );
        const content = picker.contentEl as unknown as FakeEl;
        await waitFor(
          () => elementsWithClass(content, "courier-vault-error").length === 1,
          "the picker never rendered the list error",
        );
        const retry = buttonsIn(content).find((button) => button.text === t("common.retry"));
        expect(retry, "no retry button").toBeDefined();
        retry!.click();
        await waitFor(
          () => allText(content).join(" ").includes(t("dialog.vaultPicker.emptyTitle")),
          "the retry never re-read the list",
        );
        expect(calls).toBe(2);
      });
    });

    it("names the account from the server when nothing was stored on this device", async () => {
      // The state a vault is in after upgrading, or after the account was renamed on
      // the server: a key but no name. The row must not read "未知账号" at it.
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { serverUrl: server.serverUrl, userKey: server.userKey, userName: null },
      });
      const tab = settingsTabOf(plugin);
      tab.display();

      await waitFor(
        () => settingsIn(tab.containerEl).some((row) => row.name === "plugin e2e user"),
        "the account row never showed the name the server answered with",
      );
      expect(plugin.settings.userName).toBe("plugin e2e user");
      // Persisted, so the next render has it before the read comes back.
      const persisted = (await plugin.loadData()) as { userName?: string };
      expect(persisted.userName).toBe("plugin e2e user");
    });

    it("aborts a sign-in whose key changed while the account read was in flight", async () => {
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { serverUrl: server.serverUrl, userKey: server.userKey, userName: null },
      });
      const me = await plugin.actions.getMe();
      // Loading the plugin may already have read the account; the guard has to leave
      // whatever it knew untouched, not restore it to a default.
      const userNameBefore = plugin.settings.userName;
      const maxFileBytesBefore = plugin.settings.accountMaxFileBytes;
      const originalGetMe = plugin.actions.getMe;
      let release!: (value: typeof me) => void;
      let started!: () => void;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = new Promise<typeof me>((resolve) => {
        release = resolve;
      });
      plugin.actions.getMe = () => {
        started();
        return pending;
      };
      try {
        const signing = plugin.signIn();
        // `signIn` saves the key before it reads the account; wait for the read to be in
        // flight, then model a keystroke that replaced the key, then answer the old one.
        await reading;
        plugin.settings.userKey = "ck_changed_during_sign_in";
        release(me);
        const outcome = await signing;
        expect(outcome).toEqual({ ok: false, error: t("error.signInKeyChanged") });
        // The old account's answer was not stamped onto the key now in the field.
        expect(plugin.settings.userName).toBe(userNameBefore);
        expect(plugin.settings.accountMaxFileBytes).toBe(maxFileBytesBefore);
      } finally {
        plugin.actions.getMe = originalGetMe;
      }
    });

    it("shows the rest of the settings only after a vault is bound", async () => {
      const remote = await createTestVault(server, "Stage Three", material);
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { serverUrl: server.serverUrl, userKey: server.userKey },
      });
      const tab = settingsTabOf(plugin);
      tab.display();

      const picker = await openVaultPickerWith(plugin, remote.name);
      expect(sectionNames(tab)).not.toContain("同步的文件类型");

      clickVaultRowButton(picker, remote.name, "连接");
      const modal = lastOpenedModal();
      expect(modal?.title).toBe("连接设置");
      modalTexts(modal!).at(0)!.simulateChange(material.password);
      clickStartSyncing(modal!);

      await waitFor(
        () => sectionNames(tab).includes("同步的文件类型"),
        "the page never moved to the settings step",
      );
      const names = sectionNames(tab);
      expect(names).toEqual(
        expect.arrayContaining(["远程库", "同步的文件类型", "Obsidian 设置同步", "账号"]),
      );
      // The picker closed on the connection, and the page has no vault list of its own.
      expect(picker.isOpen).toBe(false);
      expect(names).not.toContain("选择远程库");
    });

    it("lays the settings step out in sections, and explains each one in a tooltip", async () => {
      const { plugin } = await startHostedPlugin("Settings Sections");
      const tab = settingsTabOf(plugin);
      tab.display();

      // A section is one of the app's groups: its title is the group's `heading`, which the
      // stub draws as a heading row before the section's rows (the real app draws it above
      // the group's card, which this stub has no layout for).
      const rows = settingsIn(tab.containerEl);
      const sections = [
        "这台设备",
        "远程库",
        "同步的文件类型",
        "历史版本数量",
        "排除的文件夹",
        "Obsidian 设置同步",
        "账号",
      ];
      for (const title of sections) {
        const heading = rows.find((row) => row.name === title);
        expect(heading, `the page has no "${title}" section`).toBeDefined();
        // The explanation is a tooltip, never a paragraph under the heading.
        expect(heading!.desc).toBe("");
      }
      // In that order, with the device label at the top: it is a label, not a setting
      // of the account it happens to be signed in with. The titles are unique, so the row
      // order is also the section order.
      const headings = rows
        .map((row) => row.name)
        .filter((name): name is string => name !== "" && sections.includes(name));
      expect(headings).toEqual(sections);

      // Every section is one of the app's own groups, not a heading row drawn inside the
      // page: the app renders `heading` above the group's rows, which is what gives the
      // title its spacing, and the group carries the information button. A page-level row
      // here would be laid out as a settings row, against its card's edge.
      const groups = tab
        .getSettingDefinitions()
        .map((item) => ({ type: item.type, heading: item.heading, items: item.items ?? [] }));
      expect(groups.map((group) => group.type)).toEqual(sections.map(() => "group"));
      expect(groups.map((group) => group.heading)).toEqual(sections);
      expect(groups.every((group) => group.items.length > 0)).toBe(true);

      // The account row also carries the two facts a mobile user cannot see in a
      // status-bar menu. The account read fills them into its description.
      await waitFor(
        () =>
          settingsIn(tab.containerEl).some(
            (row) => row.desc.includes("密钥有效期：") && row.desc.includes("存储空间："),
          ),
        "the account usage lines never finished reading",
      );
      const accountRow = settingsIn(tab.containerEl).find((row) => row.desc.includes("服务器："));
      expect(accountRow?.desc).toContain("永不过期");
      // The storage segment itself, not the "/" in the server URL above it.
      expect(accountRow?.desc).toMatch(/存储空间：\d[^·]*\//);
      expect(accountRow?.desc).toContain("无上限");

      const tooltips = extraButtonsIn(tab.containerEl)
        .map((button) => button.tooltip)
        .join("\n");
      expect(tooltips).toContain("配置文件夹");
      expect(tooltips).toContain("Markdown");
      expect(tooltips).toContain("本机与远程库的连接");
      // The history limits are explained where they are changed: the two fields show
      // what the server keeps, and deleting the oldest versions is the user-facing cost.
      expect(tooltips).toContain("历史版本数量");

      // The retired device section is gone, and nothing replaced it with a list.
      const texts = allText(tab.containerEl);
      expect(texts).not.toContain("重新注册这台设备");
      expect(texts).not.toContain("上次看到");
      expect(rows.some((row) => row.name === "设备")).toBe(false);
    });

    it("keeps disconnecting and logging out in separate sections, with the red one last", async () => {
      const { plugin } = await startHostedPlugin("Settings Account");
      const tab = settingsTabOf(plugin);
      tab.display();
      await waitFor(
        () => settingsIn(tab.containerEl).some((row) => row.name === "设备名称"),
        "the settings step never rendered",
      );

      const rows = settingsIn(tab.containerEl);
      const connect = rows.find((row) => row.buttons.some((b) => b.text === "断开连接"))!;
      const logout = rows.find((row) => row.buttons.some((b) => b.text === "退出登录"))!;
      expect(connect, "no 断开连接 action").toBeDefined();
      expect(logout, "no 退出登录 action").toBeDefined();
      // Two decisions, two rows — and they are not the same row.
      expect(connect).not.toBe(logout);
      expect(connect.buttons.map((button) => button.text)).toEqual(["断开连接"]);
      expect(logout.buttons.map((button) => button.text)).toEqual(["退出登录"]);
      // Destructive, so it is red...
      expect(logout.buttons[0]!.isWarning).toBe(true);
      // ...and the last thing on the page.
      expect(rows.at(-1)).toBe(logout);

      // The account is one row — name, server and the action together — like the
      // account row of the vault step. The name arrives from the server a moment
      // after the render, so the row is read once it has.
      await waitFor(
        () => rows.at(-1)!.name === "plugin e2e user",
        "the account row never showed the name the server answered with",
      );
      expect(logout.name).toBe("plugin e2e user");
      // The description also carries the key-expiry and storage readings; the server line
      // still has to be there and still has to be first.
      expect(logout.desc).toContain(`服务器：${server.serverUrl}`);
      expect(logout.desc.indexOf(`服务器：${server.serverUrl}`)).toBe(0);

      // The device label is at the top of the page, in its own section.
      const device = rows.find((row) => row.name === "设备名称")!;
      expect(device.texts).toHaveLength(1);
      const deviceHeading = rows.findIndex((row) => row.name === "这台设备");
      expect(deviceHeading).toBe(0);
      expect(rows.indexOf(device)).toBe(deviceHeading + 1);
    });

    it("renders the same page when Obsidian reports itself as mobile", async () => {
      // The plugin has no platform split left (one engine, one settings page), so the
      // way to cover "mobile" on a desktop run is to make the runtime say it is one:
      // the stub's `Platform` is what the plugin would read.
      Platform.isDesktop = false;
      Platform.isMobile = true;

      const remote = await createTestVault(server, "Mobile Vault", material);
      const { plugin } = await startHostedPlugin("Settings Mobile");
      const tab = settingsTabOf(plugin);
      tab.display();
      await waitFor(
        () => settingsIn(tab.containerEl).some((row) => row.name === "设备名称"),
        "the settings step never rendered",
      );

      const rows = settingsIn(tab.containerEl);
      expect(rows.findIndex((row) => row.name === "这台设备")).toBe(0);
      expect(rows.some((row) => row.name === "设备名称")).toBe(true);
      expect(rows.at(-1)!.buttons.map((button) => button.text)).toEqual(["退出登录"]);
      expect(rows.at(-1)!.buttons[0]!.isWarning).toBe(true);

      // ...and the dialogs are the same dialogs. Disconnecting first is what puts the
      // page back on the step that has the vault row (this is the only page whose
      // buttons the mobile case needs to differ on, and it does not).
      clickSettingsButton(plugin, "断开连接");
      await waitFor(
        () => settingsIn(tab.containerEl).some((row) => row.name === "选择远程库"),
        "the page never went back to the vault step",
      );
      const picker = await openVaultPickerWith(plugin, remote.name);
      const row = vaultRowIn(picker, remote.name);
      expect(row.buttons.map((button) => button.text)).toEqual(["连接"]);
      expect(row.extraButtons.map((button) => button.tooltip)).toEqual(["删除远程库"]);
    });

    it("gives every switch one line of explanation, without listing extensions", async () => {
      const { plugin } = await startHostedPlugin("Settings Simple");
      const tab = settingsTabOf(plugin);
      tab.display();
      await waitFor(
        () => settingsIn(tab.containerEl).some((row) => row.name === "图片"),
        "the file-type switches never rendered",
      );

      const rows = settingsIn(tab.containerEl);
      for (const name of ["图片", "音频", "视频", "PDF", "其他类型文件"]) {
        const row = rows.find((candidate) => candidate.name === name);
        expect(row, `no "${name}" switch`).toBeDefined();
        // One short line, not a paragraph.
        expect(row!.desc, `"${name}" has no explanation`).not.toBe("");
        expect(row!.desc.length).toBeLessThan(30);
        expect(row!.desc).not.toContain("\n");
        expect(row!.toggles).toHaveLength(1);
      }
      // The settings groups explain themselves the same way.
      for (const name of ["外观", "快捷键", "已安装的社区插件"]) {
        const row = rows.find((candidate) => candidate.name === name);
        expect(row!.desc, `"${name}" has no explanation`).not.toBe("");
      }

      // No extension anywhere in the body text, and no "Save" button: the device name
      // is persisted as it is typed.
      const body = allText(tab.containerEl).join("\n");
      expect(body).not.toMatch(/\.(avif|bmp|gif|mp3|mp4|ogg|pdf|webm)\b/);
      expect(buttonsIn(tab.containerEl).map((button) => button.text)).not.toContain("Save");
    });

    it("flips a scope switch without rebuilding the page or moving it", async () => {
      // The phone report: the switches sit far down a long page, and flipping one used to
      // restart the host, rebuild every row and put the pane back at the top.
      const { plugin } = await startHostedPlugin("Settings Switch Scroll");
      const tab = settingsTabOf(plugin);
      tab.display();

      const connectionRow = settingsIn(tab.containerEl).find((candidate) =>
        candidate.buttons.some((button) => button.text === t("settings.ready.disconnect")),
      )!;
      const switchRow = settingsIn(tab.containerEl).find(
        (candidate) => candidate.name === t("settings.group.corePlugins.label"),
      )!;
      const oldHost = plugin.host;
      tab.containerEl.scrollTop = 420;
      // A full render would leave this old row detached with the sentinel, and `empty()`
      // would take the pane back to 0 — both assertions below then fail.
      connectionRow.desc = "stale";

      switchRow.toggles[0]!.simulateChange(true);

      await waitFor(
        () => plugin.host !== null && plugin.host !== oldHost && plugin.wsState === "connected",
        "the switch never restarted the host",
      );
      await waitFor(
        () => connectionRow.desc === t("settings.state.connected"),
        "the connection row's state line never followed the restarted host",
      );

      expect(plugin.settings.settingsGroups.corePlugins).toBe(true);
      expect(tab.containerEl.scrollTop).toBe(420);
      expect(settingsIn(tab.containerEl)).toContain(connectionRow);
      expect(switchRow.toggles[0]!.value).toBe(true);
      // The other half of `refreshLiveState`: the always-visible icon followed the same
      // restart, so the split did not trade a stale page for a stale status bar.
      expect(statusBarItem(plugin).getAttribute("data-courier-status")).toBe("syncing");
    });

    it("saves the device name as it is typed, and on leaving the field", async () => {
      const { plugin, remote } = await startHostedPlugin("Settings Device Name");
      const tab = settingsTabOf(plugin);
      tab.display();

      const row = settingsIn(tab.containerEl).find((candidate) => candidate.name === "设备名称");
      expect(row, "the device-name field is missing").toBeDefined();
      const field = row!.texts[0]!;

      field.simulateChange("书房笔记本");
      // Debounced: a keystroke must not write (or re-render, which would drop the caret).
      expect(plugin.settings.deviceName).toBe("My Device");

      // Leaving the field commits what is pending.
      for (const listener of field.inputEl.listeners["blur"] ?? []) listener({});
      await waitFor(
        () => plugin.settings.deviceName === "书房笔记本",
        "the device name was never saved",
      );
      const persisted = (await plugin.loadData()) as { deviceName?: string };
      expect(persisted.deviceName).toBe("书房笔记本");
      expect(plugin.settings.vaultConnections[remote.id]).toEqual({
        deviceName: "书房笔记本",
        excludedFolders: [],
      });
    });

    it("edits a vault-level history limit with the pencil icon and Save, and refuses a nonsense value", async () => {
      const { plugin, remote } = await startHostedPlugin("Settings History Limit");
      const tab = settingsTabOf(plugin);
      tab.display();

      const row = settingsIn(tab.containerEl).find(
        (candidate) => candidate.name === t("settings.historyLimit.documents.label"),
      );
      expect(row, "the notes/canvas history-limit row is missing").toBeDefined();
      const button = row!.buttons[0]!;
      const field = row!.texts[0]!;
      const value = row!.controlEl.querySelector(".courier-history-limit-value");
      expect(value, "the row has no value display").not.toBeNull();

      // The row is a view of the **server's** vault value: the number is text, and the
      // only control is the pencil icon that opens the field — no always-live input.
      await waitFor(() => value!.text === "200", "the server's limit never reached the row");
      expect(button.icon).toBe("pencil");
      expect(button.text).toBe("");
      expect(button.tooltip).toBe(t("settings.historyLimit.edit"));
      // The borderless icon chrome, so the control reads as an icon rather than a button.
      expect(button.buttonEl.classes).toContain("clickable-icon");

      // The pencil turns the number into an input and itself into a check (the commit).
      button.click();
      expect(button.icon).toBe("check");
      expect(button.text).toBe("");
      expect(button.tooltip).toBe(t("settings.historyLimit.confirm"));
      expect(field.getValue()).toBe("200");

      // The check writes the vault; the row returns to text with the stored number and the
      // pencil, and the description is the row's own explanation again — the press was the
      // confirmation, so no extra "saved" line is added.
      field.simulateChange("500");
      button.click();
      await waitForAsync(
        async () => (await vaultSettings(server, remote.id)).historyLimitDocuments === 500,
        "the history limit was never written to the vault",
      );
      await waitFor(() => value!.text === "500", "the row never showed the saved number");
      expect(button.icon).toBe("pencil");
      expect(button.text).toBe("");
      expect(button.buttonEl.classes).toContain("clickable-icon");
      expect(row!.desc).toBe(t("settings.historyLimit.documents.desc"));
      // It is vault state, not device state: nothing lands in this device's data.json.
      const persisted = (await plugin.loadData()) as { historyLimits?: unknown };
      expect(persisted.historyLimits).toBeUndefined();

      // `0` would read as "keep only the newest version": it is refused inline, no request
      // is sent, and the row stays in the field so the user can correct it.
      button.click();
      field.simulateChange("0");
      button.click();
      expect(row!.desc).toBe(t("settings.historyLimit.invalid", { max: MAX_HISTORY_LIMIT }));
      expect(button.icon).toBe("check");
      expect((await vaultSettings(server, remote.id)).historyLimitDocuments).toBe(500);
    });

    it("follows a vault-settings change made on another device, without reopening the page", async () => {
      const { plugin, remote } = await startHostedPlugin("Settings History Live");
      const tab = settingsTabOf(plugin);
      tab.display();

      const row = settingsIn(tab.containerEl).find(
        (candidate) => candidate.name === t("settings.historyLimit.documents.label"),
      );
      expect(row, "the notes/canvas history-limit row is missing").toBeDefined();
      const value = row!.controlEl.querySelector(".courier-history-limit-value");
      await waitFor(() => value!.text === "200", "the server's limit never reached the row");
      // The update travels over the socket, so the subscription has to exist before the
      // other device's change is made.
      await waitFor(() => plugin.wsState === "connected", "the plugin's socket never connected");

      // Another device changes the vault's limit — this client never reloads the page and
      // never calls its own write path; the socket's `vault_settings` has to repaint it.
      await updateVaultSettings(server, remote.id, { historyLimitDocuments: 40 });

      await waitFor(
        () => value!.text === "40",
        "the open settings row never followed the change made elsewhere",
      );
      expect(plugin.vaultHistoryLimits?.documents).toBe(40);
    });

    it("re-reads an open version-history page when the vault's limit is lowered", async () => {
      const { plugin, vault, remote } = await startHostedPlugin("Settings History Page");

      // Three versions of one note, all on the server. Each wait names the version it adds,
      // so two writes cannot coalesce into one push and leave the chain at two.
      await vault.create("refresh.md", "v1");
      await vault.settle();
      const fileId = await trackedFileId(plugin, "refresh.md");
      const chainLength = async (): Promise<number> =>
        (await vaultHistory(server, remote.id)).find((chain) => chain.fileId === fileId)?.versions
          .length ?? 0;
      await waitForAsync(
        async () => (await chainLength()) === 1,
        "the first version never reached the server",
      );
      for (const [index, content] of ["v2", "v3"].entries()) {
        await vault.modify("refresh.md", content);
        await vault.settle();
        await waitForAsync(
          async () => (await chainLength()) === index + 2,
          `version ${index + 2} never reached the server`,
        );
      }

      // The page is open on the whole chain while the limit changes under it.
      const view = await openVersionHistory(plugin, "refresh.md");
      expect(versionRows(view)).toHaveLength(3);

      const tab = settingsTabOf(plugin);
      tab.display();
      const row = settingsIn(tab.containerEl).find(
        (candidate) => candidate.name === t("settings.historyLimit.documents.label"),
      );
      expect(row, "the notes/canvas history-limit row is missing").toBeDefined();
      row!.buttons[0]!.click();
      row!.texts[0]!.simulateChange("2");
      row!.buttons[0]!.click();
      await waitForAsync(
        async () => (await vaultSettings(server, remote.id)).historyLimitDocuments === 2,
        "the lowered limit never reached the vault",
      );

      // The open page follows on its own: the trimmed row is gone, the rest is the newest
      // two, and the selection has moved to the head instead of naming a version the server
      // has already reclaimed (which is what showed "cannot fetch or decrypt").
      await waitFor(
        () => versionRows(view).length === 2,
        "the open history page never dropped the trimmed version",
      );
      expect(versionActions(view)).toEqual(["修改", "修改"]);
      expect(selectedVersionRow(view)?.classes).toContain("is-selected");
    });

    it("opens this run's sync events in a scrollable, read-only dialog", async () => {
      const { plugin, vault, remote } = await startHostedPlugin("Settings History", undefined, {
        deviceName: "history-laptop",
      });
      await vault.create("history-note.md", "first");
      await vault.settle();
      await waitForAsync(
        async () =>
          (await filesAtPath(server, remote.id, material.key, "history-note.md")).length === 1,
        "the note never reached the server",
      );

      // Opening the dialog must not read the vault's remote history: its rows are the
      // run's own events, kept in memory.
      const historyReadsBefore = requestsMatching(/\/sync\/history$/).length;

      const tab = settingsTabOf(plugin);
      tab.display();

      // The page keeps one row; the log itself is a dialog, so a long history cannot
      // grow the settings page.
      const historyRow = settingsIn(tab.containerEl).find((row) => row.name === "同步历史")!;
      expect(historyRow, "the page has no sync-history row").toBeDefined();
      expect(historyRow.desc).not.toBe("");
      expect(historyRow.buttons.map((button) => button.text)).toEqual(["查看"]);
      expect(elementsWithClass(tab.containerEl, "courier-history")).toEqual([]);

      historyRow.buttons[0]!.click();
      const modal = lastOpenedModal();
      expect(modal?.title).toBe("同步历史");
      await waitFor(
        () => historyRowFor(modal!, "history-note.md") !== undefined,
        "the sync history never rendered the note's row",
      );

      const row = historyRowFor(modal!, "history-note.md")!;
      // One row per event, in three parts: the arrow, the path with its clock reading and
      // device under it, and the action word on the right.
      expect(historyRowsFor(modal!, "history-note.md")).toHaveLength(1);
      expect(elementsWithClass(row, "courier-history-action")[0]!.text).toBe("创建");
      const meta = elementsWithClass(row, "courier-history-meta")[0]!.text;
      expect(meta).toMatch(/^\d{2}:\d{2}:\d{2} · /);
      expect(meta).toContain("history-laptop");
      // Read-only: no per-line control at all.
      expect(buttonsIn(row)).toEqual([]);

      // This device pushed the note, so the row leads with the "out" arrow — the icon
      // itself, not just the colour, says which way it travelled.
      expect(historyArrows(modal!)).toEqual([{ icon: "arrow-up", direction: "out" }]);
      expect(row.classes).not.toContain("is-skipped");

      // The day header above it, and a count with a real number in it — the header used
      // to render the literal `共 {total} 次同步事件。`. The note says the log is this
      // run's, because a reload starts it empty.
      expect(elementsWithClass(modal!.contentEl, "courier-history-day-title")[0]!.text).toBe(
        "今天",
      );
      const count = elementsWithClass(modal!.contentEl, "courier-history-count")[0]!.text;
      expect(count).toMatch(/^[\d,]+$/);
      expect(historyCount(modal!)).toBeGreaterThan(0);
      const body = allText(modal!.contentEl).join(" ");
      expect(body).toContain("条同步记录");
      expect(body).toContain(t("dialog.syncHistory.sessionNote"));
      expect(body).not.toContain("{");

      // The log is one framed region that scrolls on its own (the CSS gives it the
      // max-height; the inline style is deliberately gone).
      const list = elementsWithClass(modal!.contentEl, "courier-history-list")[0]!;
      expect(list.classes).toContain("courier-history-list");

      // No toolbar: there is no request to repeat, so no refresh control.
      expect(extraButtonsIn(modal!.contentEl)).toEqual([]);
      expect(requestsMatching(/\/sync\/history$/).length).toBe(historyReadsBefore);

      modal!.close();
      expect(modal!.isOpen).toBe(false);
    });

    it("points the arrow the way the change travelled: up for ours, down for a peer's", async () => {
      const { plugin, vault, remote } = await startHostedPlugin(
        "Settings History Directions",
        undefined,
        { deviceName: "directions-laptop" },
      );
      const peer = await newPeer(remote.id, "other-laptop");

      // One upload from this device…
      await vault.create("mine.md", "written here");
      await vault.settle();
      await waitForAsync(
        async () => (await filesAtPath(server, remote.id, material.key, "mine.md")).length === 1,
        "this device's note never reached the server",
      );
      // …and one download from another one.
      peer.write("theirs.md", "written elsewhere");
      await peer.sync();
      await peer.change("theirs.md");
      await waitFor(
        () => vault.read("theirs.md") === "written elsewhere",
        "the peer's note never arrived",
      );

      const tab = settingsTabOf(plugin);
      tab.display();
      settingsIn(tab.containerEl)
        .find((row) => row.name === "同步历史")!
        .buttons[0]!.click();
      const modal = lastOpenedModal();
      await waitFor(
        () => historyPaths(modal!).length >= 2,
        "the sync history never listed both notes",
      );

      const arrowOf = (path: string): { icon?: string; direction: string } => {
        const row = historyRowFor(modal!, path)!;
        const arrow = elementsWithClass(row, "courier-history-arrow")[0]!;
        return {
          icon: arrow.icon,
          direction: arrow.classes.includes("is-out") ? "out" : "in",
        };
      };
      // The two arrows differ in both ways the design asks for: the glyph points the way
      // the change went, and the class that colours it names the direction.
      expect(arrowOf("mine.md")).toEqual({ icon: "arrow-up", direction: "out" });
      expect(arrowOf("theirs.md")).toEqual({ icon: "arrow-down", direction: "in" });
      // The label is display only: this device's row carries the name it pushed under,
      // and the peer's row carries the one the notification named.
      expect(
        elementsWithClass(historyRowFor(modal!, "mine.md")!, "courier-history-meta")[0]!.text,
      ).toContain("directions-laptop");
      expect(
        elementsWithClass(historyRowFor(modal!, "theirs.md")!, "courier-history-meta")[0]!.text,
      ).toContain("other-laptop");

      modal!.close();
    });

    it("lists a change that syncs while the dialog is open", async () => {
      const { plugin, remote } = await startHostedPlugin("Settings History Live", async (v) => {
        await v.create("already-here.md", "the note the log opens on");
      });
      const peer = await newPeer(remote.id, "other-laptop");
      await waitForAsync(
        async () =>
          (await filesAtPath(server, remote.id, material.key, "already-here.md")).length === 1,
        "the seed note never reached the server",
      );

      const tab = settingsTabOf(plugin);
      tab.display();
      settingsIn(tab.containerEl)
        .find((row) => row.name === "同步历史")!
        .buttons[0]!.click();
      const modal = lastOpenedModal();
      await waitFor(
        () => historyRowFor(modal!, "already-here.md") !== undefined,
        "the sync history never opened on the seed note",
      );

      // The dialog is open and idle now. A peer's note arrives over the websocket — the
      // one moment the user is watching the log precisely because they want to see the
      // sync — so the row has to appear on its own. There is no poll to fall back on.
      const beforeCount = historyCount(modal!);
      const startedAt = Date.now();
      peer.write("arrives-live.md", "pushed while the dialog is open");
      await peer.sync();
      await peer.change("arrives-live.md");

      await waitFor(
        () => historyRowFor(modal!, "arrives-live.md") !== undefined,
        "the open sync history never showed the peer's push",
        5_000,
      );
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(historyArrows(modal!).at(-1)).toEqual({ icon: "arrow-down", direction: "in" });

      // The count in the header moved with it — the header is not a stale total.
      expect(historyCount(modal!)).toBeGreaterThan(beforeCount);
      expect(historyCount(modal!)).toBeGreaterThanOrEqual(historyRows(modal!).length);

      modal!.close();
    });

    it("tells the direction apart even when both devices carry the default name", async () => {
      // Two fresh installs both push as "My Device". The old dialog refused to point
      // either way because it compared labels; the session log takes the direction from
      // the operation, so each row is still unambiguous.
      const { plugin, vault, remote } = await startHostedPlugin("Settings History Default Name");
      expect(plugin.settings.deviceName).toBe("My Device");
      const peer = await newPeer(remote.id, "My Device");
      peer.write("default-name.md", "written on the other default device");
      await peer.sync();
      await peer.change("default-name.md");
      await waitFor(
        () => vault.read("default-name.md") === "written on the other default device",
        "the peer's note never arrived",
      );

      await vault.create("mine-default.md", "written here");
      await vault.settle();
      await waitForAsync(
        async () =>
          (await filesAtPath(server, remote.id, material.key, "mine-default.md")).length === 1,
        "this device's note never reached the server",
      );

      const tab = settingsTabOf(plugin);
      tab.display();
      settingsIn(tab.containerEl)
        .find((row) => row.name === "同步历史")!
        .buttons[0]!.click();
      const modal = lastOpenedModal();
      await waitFor(
        () =>
          historyRowFor(modal!, "default-name.md") !== undefined &&
          historyRowFor(modal!, "mine-default.md") !== undefined,
        "the sync history never listed both default-named devices' notes",
      );

      const arrowOf = (path: string): string => {
        const arrow = elementsWithClass(historyRowFor(modal!, path)!, "courier-history-arrow")[0]!;
        return arrow.classes.includes("is-out") ? "out" : "in";
      };
      expect(arrowOf("default-name.md")).toBe("in");
      expect(arrowOf("mine-default.md")).toBe("out");
      // The label is still shown, it just does not decide anything.
      expect(
        elementsWithClass(historyRowFor(modal!, "default-name.md")!, "courier-history-meta")[0]!
          .text,
      ).toContain("My Device");

      modal!.close();
    });

    it("records a peer's skipped files once, and never rewrites the row when the switch moves", async () => {
      // This device syncs markdown only, excludes `private/`, and has no config-folder
      // group on. The peer syncs everything, so three versions arrive that this device
      // never materialises — each is recorded with the switch that fired, at the time it
      // fired.
      const { plugin, vault, remote } = await startHostedPlugin(
        "Settings History Out Of Scope",
        async (v) => {
          await v.create("synced-here.md", "this device does sync it");
        },
        {
          fileTypes: {
            images: false,
            video: false,
            audio: false,
            pdf: false,
            otherTypes: false,
          },
          excludedFolders: ["private"],
        },
      );
      const peer = await newPeer(remote.id, "everything-peer", {
        fileTypes: {
          images: true,
          video: true,
          audio: true,
          pdf: true,
          otherTypes: true,
        },
        settingsGroups: ALL_SETTINGS_GROUPS,
      });

      // The skip rows come from live notifications, not from a bind scan: the plugin's
      // socket has to be up before the peer pushes.
      await waitFor(() => plugin.wsState === "connected", "the plugin's socket never connected");

      await peer.sync();
      // A folder this device excludes…
      peer.write("private/hidden.md", "excluded folder");
      // …a type this device switched off…
      peer.writeBinary("assets/photo.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
      // …and a config-folder file whose group is off here.
      peer.write(".obsidian/core-plugins.json", '{"file-explorer":true}');
      await peer.sync();

      // None of the three may land on this device.
      await waitForAsync(
        async () =>
          (await filesAtPath(server, remote.id, material.key, "private/hidden.md")).length === 1,
        "the peer's excluded-folder note never reached the server",
      );
      expect(vault.has("private/hidden.md")).toBe(false);
      expect(vault.has("assets/photo.png")).toBe(false);
      expect(vault.has(".obsidian/core-plugins.json")).toBe(false);

      const tab = settingsTabOf(plugin);
      tab.display();
      settingsIn(tab.containerEl)
        .find((row) => row.name === "同步历史")!
        .buttons[0]!.click();
      const modal = lastOpenedModal();
      await waitFor(
        () => historyRowFor(modal!, "private/hidden.md") !== undefined,
        "the out-of-scope note never appeared in the sync history",
      );

      // All three are in the log, next to the one this device does sync: the log is not
      // filtered by the scope, and a skipped row still names the change it carried.
      expect(historyPaths(modal!)).toEqual(
        expect.arrayContaining([
          "synced-here.md",
          "private/hidden.md",
          "assets/photo.png",
          ".obsidian/core-plugins.json",
        ]),
      );

      expect(historyOutcomeOf(modal!, "private/hidden.md")).toBe(
        t("dialog.syncHistory.notApplied", {
          reason: t("dialog.syncHistory.skipReason.folder"),
        }),
      );
      expect(historyOutcomeOf(modal!, "assets/photo.png")).toBe(
        t("dialog.syncHistory.notApplied", {
          reason: t("dialog.syncHistory.skipReason.fileType"),
        }),
      );
      expect(historyOutcomeOf(modal!, ".obsidian/core-plugins.json")).toBe(
        t("dialog.syncHistory.notApplied", {
          reason: t("dialog.syncHistory.skipReason.settingsGroup"),
        }),
      );
      // The one this device syncs is outgoing and applied, with no such line at all.
      expect(historyOutcomeOf(modal!, "synced-here.md")).toBeUndefined();
      expect(historyRowFor(modal!, "synced-here.md")!.classes).toContain("is-out");

      const marked = historyRows(modal!).filter((row) => row.classes.includes("is-skipped"));
      expect(marked).toHaveLength(3);

      // The regression: the settings-group row recorded the switch as it was. Enabling
      // the group afterwards must not turn that row into an applied one.
      const before = historyRowFor(modal!, ".obsidian/core-plugins.json")!;
      const beforeText = allText(before).join("|");
      await plugin.setSettingsGroupEnabled("corePlugins", true);
      peer.write(".obsidian/core-plugins.json", '{"file-explorer":false}');
      await peer.sync();
      await plugin.host?.engine?.initialSync();

      // Wait for the row this case is about rather than for a count: two rows arrive here —
      // the skipped `create` and the applied `modify` — and a slower run can show its first
      // pair before the second one is written, which is how this case used to fail on timing.
      await waitFor(
        () =>
          historyRowsFor(modal!, ".obsidian/core-plugins.json").some(
            (row) => !row.classes.includes("is-skipped") && actionOf(row) === "修改",
          ),
        "the applied version never reached the log",
      );
      const rows = historyRowsFor(modal!, ".obsidian/core-plugins.json");
      // The peer's second write is a `modify`, and it is applied now: the bind pass after
      // the switch applied the old `create`, so an applied `修改` row can only come from
      // the later version. This is what the old dialog could not distinguish.
      expect(
        rows.some((row) => !row.classes.includes("is-skipped") && actionOf(row) === "修改"),
      ).toBe(true);
      // …and the row that was already there is unchanged, class and words alike.
      const old = rows.find((row) => allText(row).join("|") === beforeText);
      expect(old, "the existing row changed when the switch was enabled").toBeDefined();
      expect(old!.classes).toContain("is-skipped");

      // And turning it off again does not add a "not applied" row for the version this
      // device already applied: the same guard, from the other direction. The store's
      // total is the run's count, so it also covers a row below the fold.
      const appliedRows = rows.length;
      const totalBefore = getSyncLog().total;
      await plugin.setSettingsGroupEnabled("corePlugins", false);
      await plugin.host?.engine?.initialSync();
      expect(getSyncLog().total).toBe(totalBefore);
      expect(historyRowsFor(modal!, ".obsidian/core-plugins.json")).toHaveLength(appliedRows);

      modal!.close();
    });

    it("goes back to the vault step on disconnect, and to login on log out", async () => {
      const hosted = await startHostedPlugin("Settings Exit");
      const tab = settingsTabOf(hosted.plugin);
      tab.display();

      clickSettingsButton(hosted.plugin, "断开连接");
      // The settings change before the page re-renders, so wait for the *render*.
      await waitFor(
        () => settingsIn(tab.containerEl).some((row) => row.name === "选择远程库"),
        "the page never went back to the vault step",
      );
      expect(hosted.plugin.settings.connectedVaultId).toBeNull();
      // Still signed in: the key survives, so the vault list is one click away.
      expect(hosted.plugin.settings.userKey).toBe(server.userKey);

      clickSettingsButton(hosted.plugin, "退出登录");
      // The login step is the bare form, so its return is "there are two inputs again".
      await waitFor(
        () => elementsWithClass(tab.containerEl, "courier-login-input").length === 2,
        "the page never went back to the login step",
      );
      expect(hosted.plugin.settings.userKey).toBeNull();
      // The server URL is not a credential: keeping it makes signing back in one field.
      expect(hosted.plugin.settings.serverUrl).toBe(server.serverUrl);
    });

    it("starts a step change at the top of the pane, even after the old page was scrolled", async () => {
      const hosted = await startHostedPlugin("Settings Scroll");
      const tab = settingsTabOf(hosted.plugin);
      tab.display();

      // Signing out means scrolling down to the account section first. Obsidian restores
      // that offset across the re-render, and on a phone it survives even when the new page
      // is shorter — the sign-in form sits above the viewport and the pane reads as empty
      // until it is swiped. A phone can scroll the pane's containers as well as the tab
      // itself, so all three carry an offset here.
      const pane = createFakeEl("div");
      const modal = createFakeEl("div").addClass("modal");
      modal.appendChild(pane);
      pane.appendChild(tab.containerEl);
      tab.containerEl.scrollTop = 1200;
      pane.scrollTop = 800;
      modal.scrollTop = 400;

      clickSettingsButton(hosted.plugin, "退出登录");
      await waitFor(
        () => elementsWithClass(tab.containerEl, "courier-login-input").length === 2,
        "the page never went back to the login step",
      );

      expect(tab.containerEl.scrollTop).toBe(0);
      expect(pane.scrollTop).toBe(0);
      expect(modal.scrollTop).toBe(0);
    });

    it("pauses from its own row without unbinding, and resumes from the same row", async () => {
      const { plugin, vault, remote } = await startHostedPlugin("Pause Sync");
      const tab = settingsTabOf(plugin);
      tab.display();
      await waitFor(
        () => settingsIn(tab.containerEl).some((row) => row.name === "同步"),
        "the settings page has no 同步 row",
      );

      // `startHostedPlugin` seeds a bound vault without a stored credential, so onload has
      // already raised (and is awaiting) the unlock dialog. The pause assertions start after
      // it, where a user would be.
      openedModals.length = 0;

      const runningRow = settingsIn(tab.containerEl).find((row) => row.name === "同步")!;
      expect(runningRow.buttons.map((button) => button.text)).toEqual(["暂停同步"]);

      // An action that stays on the same step keeps the pane where the user was: only a
      // step change starts at the top (see the log out case above).
      tab.containerEl.scrollTop = 600;
      clickSettingsButton(plugin, "暂停同步");
      // Persisted *and* applied: the page re-renders after the host is stopped, so the state
      // and the row below have to be read after both.
      await waitFor(
        () => plugin.settings.syncPaused && plugin.host === null,
        "the pause was never applied",
      );
      await waitFor(
        () =>
          settingsIn(tab.containerEl).some(
            (row) => row.name === "同步" && row.desc.includes("已暂停"),
          ),
        "the page never showed the paused state",
      );
      expect(tab.containerEl.scrollTop).toBe(600);

      // Everything a pause stops, and everything it keeps.
      expect(plugin.host).toBeNull();
      expect(plugin.engine).toBeNull();
      expect(plugin.wsState).toBe("disconnected");
      expect(plugin.settings.connectedVaultId).toBe(remote.id);
      expect(plugin.encryptionKey).not.toBeNull();
      expect(plugin.settings.userKey).toBe(server.userKey);
      expect(((await plugin.loadData()) as { syncPaused?: boolean }).syncPaused).toBe(true);
      // Pausing never asks for the vault password: that is what disconnecting does.
      expect(openedModals).toHaveLength(0);

      const pausedRow = settingsIn(tab.containerEl).find((row) => row.name === "同步")!;
      expect(pausedRow.desc).toContain("已暂停");
      expect(pausedRow.buttons.map((button) => button.text)).toEqual(["继续同步"]);
      expect(pausedRow.buttons[0]!.isCta).toBe(true);
      // The connection row is still a connection, and keeps its one destructive action.
      const connection = settingsIn(tab.containerEl).find(
        (row) => row.name === `已连接「${remote.name}」`,
      )!;
      expect(connection.desc).toBe("⏸ 同步已暂停");
      expect(connection.buttons.map((button) => button.text)).toEqual(["断开连接"]);

      // Nothing leaves while paused: the host that pushed is gone.
      await vault.create("paused-local.md", "written while paused");
      await vault.settle();
      expect(await filesAtPath(server, remote.id, material.key, "paused-local.md")).toEqual([]);

      // ...and nothing arrives: no socket, no timers, no reconcile.
      const peer = await newPeer(remote.id, "pausing-peer");
      peer.write("peer-while-paused.md", "written by the peer");
      await peer.sync();
      expect(vault.read("peer-while-paused.md")).toBeNull();

      // Resume from the same row, with the key that never left memory.
      openedModals.length = 0;
      clickSettingsButton(plugin, "继续同步");
      await waitForAsync(async () => plugin.host !== null, "resuming never restarted the host");
      expect(plugin.settings.syncPaused).toBe(false);
      expect(openedModals).toHaveLength(0);
      await waitForAsync(
        async () =>
          (await filesAtPath(server, remote.id, material.key, "paused-local.md")).length === 1,
        "the file written while paused never reached the server after resuming",
      );
      await waitForAsync(
        async () => vault.read("peer-while-paused.md") === "written by the peer",
        "the peer's file never arrived after resuming",
      );
    });

    it("reopens paused without asking for a password, and resumes from the row", async () => {
      const remote = await createTestVault(server, "Paused Reload", material);
      const vault = new FakeVault();
      const settings = {
        ...DEFAULT_SETTINGS,
        serverUrl: server.serverUrl,
        userKey: server.userKey,
        connectedVaultId: remote.id,
        connectedVaultName: remote.name,
        encryptionSalt: material.salt,
      };

      // First session: unlock once with "remember", so the pause leaves a credential on
      // this device — the state a user pausing from a running vault is actually in.
      const first = new CourierPlugin(createFakeApp(vault) as unknown as App, MANIFEST);
      await first.saveData(settings);
      await first.onload();
      const modal = lastOpenedModal();
      modalTexts(modal!).at(0)!.simulateChange(material.password);
      clickModalButton(modal!, "解锁");
      await waitForAsync(async () => first.host !== null, "the first session never started");
      await first.pauseSync();
      expect(first.settings.syncPaused).toBe(true);
      const pausedData = (await first.loadData()) as CourierSettings;
      first.onunload();

      // Second session — a fresh plugin instance over the same device-local store, which is
      // what "close and reopen Obsidian" means.
      openedModals.length = 0;
      const second = new CourierPlugin(createFakeApp(vault) as unknown as App, MANIFEST);
      await second.saveData(pausedData);
      await second.onload();
      plugins.push(second);

      // The two things a paused load must not do: start a host, or ask for the password.
      expect(openedModals).toHaveLength(0);
      expect(second.host).toBeNull();
      expect(second.encryptionKey).toBeNull();
      expect(second.settings.syncPaused).toBe(true);

      const tab = settingsTabOf(second);
      tab.display();
      const row = settingsIn(tab.containerEl).find((candidate) => candidate.name === "同步")!;
      expect(row.desc).toContain("已暂停");
      expect(row.buttons.map((button) => button.text)).toEqual(["继续同步"]);

      // The recycle bin decrypts stored paths, so it says why it cannot open rather than
      // rendering a dialog full of [未知路径]. The sync history is this run's in-memory
      // log: it needs no key, so it stays available while paused.
      const historyRow = settingsIn(tab.containerEl).find(
        (candidate) => candidate.name === "同步历史",
      )!;
      expect(historyRow.desc).toBe(t("settings.history.desc"));
      expect(historyRow.buttons[0]!.disabled).toBe(false);
      const binRow = settingsIn(tab.containerEl).find((candidate) => candidate.name === "回收站")!;
      expect(binRow.desc).toContain("继续同步");
      expect(binRow.buttons[0]!.disabled).toBe(true);

      // Work done while paused stays on this device until the row is pressed.
      await vault.create("while-paused.md", "queued on this device");
      await vault.settle();
      expect(await filesAtPath(server, remote.id, material.key, "while-paused.md")).toEqual([]);

      // Resume: the stored credential unlocks it (canary checked), still with no dialog.
      openedModals.length = 0;
      clickSettingsButton(second, "继续同步");
      await waitForAsync(async () => second.host !== null, "resuming never started the host");
      expect(openedModals).toHaveLength(0);
      expect(second.encryptionKey).not.toBeNull();
      expect(second.settings.syncPaused).toBe(false);

      // With the key back, the key-dependent row is readable again (the history never
      // needed the key and was already enabled while paused).
      tab.display();
      const unlockedBinRow = settingsIn(tab.containerEl).find(
        (candidate) => candidate.name === "回收站",
      )!;
      expect(unlockedBinRow.buttons[0]!.disabled).toBe(false);
      await waitForAsync(
        async () =>
          (await filesAtPath(server, remote.id, material.key, "while-paused.md")).length === 1,
        "the paused vault's local note never reached the server",
      );
    });

    it("stays paused when resuming cannot get a key, and starts only after the password is proved", async () => {
      const remote = await createTestVault(server, "Paused No Credential", material);
      const vault = new FakeVault();
      const settings = {
        ...DEFAULT_SETTINGS,
        serverUrl: server.serverUrl,
        userKey: server.userKey,
        connectedVaultId: remote.id,
        connectedVaultName: remote.name,
        encryptionSalt: material.salt,
      };

      // First session: unlock **without** remembering, so the pause leaves no credential
      // on this device — the state after a user who unchecked the toggle pauses.
      const first = new CourierPlugin(createFakeApp(vault) as unknown as App, MANIFEST);
      await first.saveData(settings);
      await first.onload();
      const modal = lastOpenedModal();
      modalToggles(modal!)[0]!.simulateChange(false);
      modalTexts(modal!).at(0)!.simulateChange(material.password);
      clickModalButton(modal!, "解锁");
      await waitForAsync(async () => first.host !== null, "the first session never started");
      await waitForAsync(
        async () => first.settings.connectedVaultId === remote.id && first.encryptionKey !== null,
        "the first session never kept the derived key",
      );
      expect(loadLocalStorage(VAULT_CREDENTIAL_KEY)).toBeNull();
      await first.pauseSync();
      const pausedData = (await first.loadData()) as CourierSettings;
      first.onunload();

      openedModals.length = 0;
      const second = new CourierPlugin(createFakeApp(vault) as unknown as App, MANIFEST);
      await second.saveData(pausedData);
      await second.onload();
      plugins.push(second);
      expect(second.settings.syncPaused).toBe(true);
      expect(second.host).toBeNull();
      expect(second.encryptionKey).toBeNull();

      // Resume cannot work without a key. Cancelling the dialog must leave the vault
      // paused and start nothing — a lost/no key is not "sync is on again".
      const beforeFirstPrompt = openedModals.length;
      clickSettingsButton(second, "继续同步");
      await waitFor(
        () => openedModals.length > beforeFirstPrompt,
        "resuming never asked for the vault password",
      );
      const prompt = lastOpenedModal()!;
      expect(prompt.title).toBe("需要库密码");
      const noticesBeforeCancel = notices.length;
      clickModalButton(prompt, "取消");
      // A cancelled dialog is not an error: the row still says 继续同步 and the page still
      // says 同步已暂停, so nothing is announced.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(notices.length).toBe(noticesBeforeCancel);
      expect(second.settings.syncPaused).toBe(true);
      expect(second.host).toBeNull();

      // The same row, now with the password: the canary-checked unlock a cold start takes,
      // and the flag comes off only after the key is in hand.
      const beforeSecondPrompt = openedModals.length;
      clickSettingsButton(second, "继续同步");
      await waitFor(
        () => openedModals.length > beforeSecondPrompt,
        "the resume prompt never reopened",
      );
      const retry = lastOpenedModal()!;
      modalTexts(retry).at(0)!.simulateChange(material.password);
      clickModalButton(retry, "解锁");
      await waitForAsync(async () => second.host !== null, "resuming never started the host");
      expect(second.settings.syncPaused).toBe(false);
      expect(second.encryptionKey).not.toBeNull();
    });

    it("shows only the unlock entry while the bound vault has no key in memory", async () => {
      const remote = await createTestVault(server, "Settings Locked", material);
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: {
          serverUrl: server.serverUrl,
          userKey: server.userKey,
          connectedVaultId: remote.id,
          connectedVaultName: remote.name,
          encryptionSalt: material.salt,
        },
      });
      // Loading a bound vault with no stored credential asks for the password; the
      // page behind that dialog is the locked step.
      await waitFor(() => lastOpenedModal() !== undefined, "the unlock dialog never opened");
      const tab = settingsTabOf(plugin);
      tab.display();

      expect(settingsIn(tab.containerEl).map((row) => row.name)).toEqual(
        expect.arrayContaining([`已绑定「${remote.name}」`]),
      );
      expect(buttonsIn(tab.containerEl).map((button) => button.text)).toContain("输入密码解锁");
      const names = sectionNames(tab);
      expect(names).not.toContain("同步的文件类型");
      expect(names).not.toContain("账号");

      // A typo must not start a host: a key the vault was never created with would
      // encrypt (and push) content the real password can never decrypt.
      modalTexts(lastOpenedModal()!).at(0)!.simulateChange("not the vault password");
      clickModalButton(lastOpenedModal()!, "解锁");
      await waitFor(
        () => notices.some((message) => message.includes("库密码不正确")),
        "the wrong password was never reported",
      );
      expect(plugin.host).toBeNull();
      expect(plugin.encryptionKey).toBeNull();

      // The right one unlocks, and the page becomes the settings step. A double click is
      // one question: the second press joins the dialog the first opened, and the answer
      // unlocks once (two host starts interleaved would leak one).
      tab.display();
      const openedBefore = openedModals.length;
      const starts = vi.spyOn(plugin, "startHost");
      clickSettingsButton(plugin, "输入密码解锁");
      clickSettingsButton(plugin, "输入密码解锁");
      expect(openedModals).toHaveLength(openedBefore + 1);
      modalTexts(lastOpenedModal()!).at(0)!.simulateChange(material.password);
      clickModalButton(lastOpenedModal()!, "解锁");
      await waitFor(() => plugin.host !== null, "the host never started after unlocking");
      expect(starts).toHaveBeenCalledTimes(1);
      await waitFor(
        () => sectionNames(tab).includes("同步的文件类型"),
        "the page never moved out of the locked step",
      );
    });
    it("joins the load's unlock when the page's button is clicked behind its dialog", async () => {
      const remote = await createTestVault(server, "Joined Unlock", material);
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: {
          connectedVaultId: remote.id,
          connectedVaultName: remote.name,
          encryptionSalt: material.salt,
        },
      });
      await waitFor(
        () => lastOpenedModal()?.title === "需要库密码",
        "the load dialog never opened",
      );
      const tab = settingsTabOf(plugin);
      tab.display();
      const starts = vi.spyOn(plugin, "startHost");

      // The page's button is the same question as the load's dialog: no second dialog, and
      // one unlock — not a second derive and start racing the first over the same vault.
      const opened = openedModals.length;
      clickSettingsButton(plugin, "输入密码解锁");
      expect(openedModals).toHaveLength(opened);

      modalTexts(lastOpenedModal()!).at(0)!.simulateChange(material.password);
      clickModalButton(lastOpenedModal()!, "解锁");
      await waitFor(() => plugin.host !== null, "the joined unlock never started the host");
      expect(starts).toHaveBeenCalledTimes(1);
    });

    it("offers a retry, not the password, when the stored key could not be checked", async () => {
      const remote = await createTestVault(server, "Retry Stored Key", material);
      const vault = new FakeVault();
      const app = createFakeApp(vault);
      // A real key for this vault: once the server answers again, the retry must unlock
      // with it and never ask the user for anything. Derived extractable so the record can
      // be written the way the plugin's own unlock writes it.
      const extractable = await deriveEncryptionKey(material.password, material.salt, true);
      const raw = new Uint8Array(await crypto.subtle.exportKey("raw", extractable));
      setLocalStorage(VAULT_CREDENTIAL_KEY, {
        vaultId: remote.id,
        encryptionKeyB64: btoa(String.fromCharCode(...raw)),
      });
      const plugin = new CourierPlugin(app as unknown as App, MANIFEST);
      await plugin.saveData({
        ...DEFAULT_SETTINGS,
        // Nothing listens here: an offline start, the state that used to render as
        // "enter the password" although the key was already on this device.
        serverUrl: "http://127.0.0.1:1",
        userKey: server.userKey,
        connectedVaultId: remote.id,
        connectedVaultName: remote.name,
        encryptionSalt: material.salt,
      });
      await plugin.onload();
      plugins.push(plugin);
      await waitFor(
        () => notices.some((message) => message.includes("无法连接同步服务器")),
        "the plugin never reported the unreachable server",
      );
      expect(openedModals).toHaveLength(0);

      const tab = settingsTabOf(plugin);
      tab.display();
      expect(settingsIn(tab.containerEl).map((row) => row.name)).toEqual(
        expect.arrayContaining([`已绑定「${remote.name}」`]),
      );
      const labels = buttonsIn(tab.containerEl).map((button) => button.text);
      expect(labels).toContain("重试");
      // The password is not what is missing, so its dialog is not offered: a password
      // could not be proved without the same server that is down.
      expect(labels).not.toContain("输入密码解锁");

      // A retry that fails again says so on the page, not only in a toast.
      clickSettingsButton(plugin, "重试");
      await waitFor(
        () =>
          (elementsWithClass(tab.containerEl, "courier-settings-error")[0]?.text ?? "").includes(
            "仍然无法连接",
          ),
        "the failed retry was never reported inline",
      );
      expect(plugin.host).toBeNull();
      expect(sectionNames(tab)).not.toContain("同步的文件类型");

      // The server is back. The retry takes the stored-key path, silently.
      plugin.settings.serverUrl = server.serverUrl;
      clickSettingsButton(plugin, "重试");
      await waitForAsync(async () => plugin.host !== null, "the retry never started the host");
      // The page re-renders only after that start finishes; `plugin.host` is assigned
      // before the first pass, so reading the page before it settles can catch the old
      // "still unreachable" state under a loaded machine.
      await waitFor(
        () => sectionNames(tab).includes("同步的文件类型"),
        "the page never moved out of the retry step",
      );
      expect(openedModals).toHaveLength(0);
      expect(plugin.encryptionKey).not.toBeNull();
      expect(elementsWithClass(tab.containerEl, "courier-settings-error")).toHaveLength(0);
    });
  });

  describe("status bar", () => {
    it("shows 未连接 and no account or pause rows without a user key", async () => {
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { userKey: null },
      });
      const item = statusBarItem(plugin);
      expect(item.getAttribute("data-courier-status")).toBe("not-connected");
      expect(item.getAttribute("data-courier-icon")).toBe("cloud-off");
      expect(item.getAttribute("aria-label")).toContain("未连接");

      const menu = await openStatusMenu(item);
      // No vault means no header; no key means nothing to read and nothing to pause.
      expect(menuTitles(menu)).toEqual(["设置"]);
      // With nothing above the actions, a separator would draw a line under no rows.
      expect(menu.separators).toBe(0);
    });

    /**
     * The menu is Obsidian's own `Menu`, but it has to be the **DOM** one on every
     * platform. Obsidian switches to native menus on macOS by default, and a native menu
     * draws none of this menu's own rows (the storage bar is an element, not a label),
     * ignores the typography `styles.css` gives them, and is positioned at the pointer —
     * which, from a status bar at the very bottom of the window, hangs it over the
     * window's corner instead of above the icon. Anchoring it to the item's own box is
     * what makes it open above the item, right-aligned, on every platform.
     */
    it("opens the DOM menu anchored to the item", async () => {
      const { plugin } = await loadPlugin({
        vault: new FakeVault(),
        settings: { userKey: null },
      });
      const item = statusBarItem(plugin);
      item.rect = { left: 1000, top: 780, width: 24, height: 16 };

      const menu = await openStatusMenu(item);
      expect(menu.useNativeMenu).toBe(false);
      expect(menu.shown).toBe(true);
      expect(menu.shownAt).toEqual({ x: 1000, y: 780, width: 24, overlap: true });

      // The keyboard opens the same menu, in the same place: a keyboard user must not get
      // a menu at the pointer, which is where the click form would have put it.
      const fromKeyboard = await openStatusMenuWithKeyboard(item);
      expect(fromKeyboard.useNativeMenu).toBe(false);
      expect(fromKeyboard.shownAt).toEqual({ x: 1000, y: 780, width: 24, overlap: true });
    });

    /**
     * Another writer owns the vault (the CLI is syncing it), so this host may not build
     * an engine. The retry loop used to repaint the item between `waiting` and
     * `not-synced` on every attempt — the lock icon flashing twice a second. The item
     * must stay untouched, not merely end on the right value.
     */
    it("keeps the lock state, with no repaint, while another writer owns the lease", async () => {
      const { plugin, vault } = await startHostedPlugin("Status Lease", holdCliLease);
      const item = statusBarItem(plugin);
      expect(item.getAttribute("data-courier-status")).toBe("waiting");
      expect(item.getAttribute("data-courier-icon")).toBe("lock");
      expect(plugin.host?.leaseWaiting).toBe(true);

      // Two retries land inside this window. Watching the icon's own writes is what
      // catches the flash: sampling the value could miss the short not-synced state,
      // while any status write at all means the wait was reported again. The adapter
      // attempts are counted too, so a retry timer that stopped firing cannot make the
      // "no repaint" assertion pass on its own.
      const attempts = vi.spyOn(vault.adapter, "exists");
      const repaints = vi.spyOn(item, "setAttribute");
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const leaseAttempts = attempts.mock.calls.filter(([path]) => path === ".courier/sync-lease");
      const statusWrites = repaints.mock.calls.filter(([name]) => name === "data-courier-status");
      repaints.mockRestore();

      expect(leaseAttempts.length).toBeGreaterThanOrEqual(2);
      expect(statusWrites).toHaveLength(0);
      expect(item.getAttribute("data-courier-status")).toBe("waiting");
      expect(plugin.host?.leaseWaiting).toBe(true);
    });

    it("moves through not-synced, syncing and paused, and pauses/resumes from its menu", async () => {
      const { plugin } = await startHostedPlugin("Status Bar");
      await waitForAsync(
        async () => plugin.wsState === "connected",
        "the plugin never subscribed its socket",
      );
      const item = statusBarItem(plugin);
      expect(item.getAttribute("data-courier-status")).toBe("syncing");
      expect(item.getAttribute("data-courier-icon")).toBe("refresh-cw");

      // A bound vault whose host was stopped is not connected any more, but it is not
      // "not connected" either: the binding and the key are still there.
      plugin.stopHost();
      expect(item.getAttribute("data-courier-status")).toBe("not-synced");
      let menu = await openStatusMenu(item);
      // The icon carries the state; the row names the vault instead.
      expect(menuTitles(menu)).toContain("Status Bar");
      expect(menuTitles(menu).some((title) => title.includes("未同步"))).toBe(false);
      expect(menuTitles(menu)).not.toContain("暂停同步");
      // The read-only rows above it are separated from the actions below.
      expect(menu.separators).toBe(1);

      await plugin.startHost();
      await waitForAsync(
        async () => plugin.wsState === "connected",
        "the restarted host never subscribed",
      );
      expect(item.getAttribute("data-courier-status")).toBe("syncing");

      // Pause from the menu, not from the settings page: this is the new control.
      menu = await openStatusMenu(item);
      const pause = menu.items.find((entry) => entry.title === "暂停同步");
      expect(pause).toBeDefined();
      pause!.click();
      await waitFor(
        () => plugin.settings.syncPaused && plugin.host === null,
        "the menu's pause never stopped the host",
      );
      expect(item.getAttribute("data-courier-status")).toBe("paused");

      menu = await openStatusMenu(item);
      const resume = menu.items.find((entry) => entry.title === "继续同步");
      expect(resume).toBeDefined();
      resume!.click();
      await waitForAsync(async () => plugin.host !== null, "the menu's resume never started");
      await waitForAsync(
        async () => plugin.wsState === "connected",
        "the resumed host never subscribed",
      );
      expect(item.getAttribute("data-courier-status")).toBe("syncing");
    });

    /**
     * The icon is icon-only by design, so the first pass's counter lives in its
     * `aria-label` (which Obsidian also shows on hover). The bind here is real — a few
     * hundred files over the real engine and server — and the element is the one the app
     * built, not a helper's model of it. The counter has to be gone once the pass reports
     * `done === total`, and `firstSync` with it.
     */
    it("puts a first pass's counter in the status-bar aria-label, and clears it", async () => {
      const vault = new FakeVault();
      for (let index = 0; index < 400; index++) {
        await vault.create(`notes/note-${index}.md`, `note ${index}`);
      }
      const remote = await createTestVault(server, "Status Progress", material);
      const { plugin } = await loadPlugin({
        vault,
        settings: { connectedVaultId: remote.id, connectedVaultName: remote.name },
      });
      plugin.encryptionKey = material.key;

      // Deliberately not `startHostedPlugin`: the bind is what this case observes, so the
      // start must not be awaited before the element is read.
      const started = plugin.startHost();
      const item = statusBarItem(plugin);
      await waitFor(
        () => /首次同步.*\d+ \/ \d+ 个文件/.test(item.getAttribute("aria-label") ?? ""),
        "the first pass never put its counter in the status bar's aria-label",
      );
      expect(item.getAttribute("aria-label")).toContain("首次同步");

      await started;
      expect(plugin.host?.firstSync).toBe(false);
      expect(item.getAttribute("aria-label")).not.toContain("首次同步");
    });

    it("shows the key expiry, the storage row and opens the settings tab", async () => {
      const expiresAt = new Date(Date.now() + 3 * 86_400_000).toISOString();
      await patchTestUser(server, { expiresAt });
      const { plugin, app } = await startHostedPlugin("Status Account");
      await waitForAsync(
        async () => plugin.wsState === "connected",
        "the account's vault never subscribed",
      );

      const menu = await openStatusMenu(statusBarItem(plugin));
      const expiry = menu.items.find((entry) => entry.icon === "key");
      expect(expiry?.title).toBe(keyExpiryText(expiresAt));
      const storage = menu.items.find((entry) => entry.icon === "hard-drive");
      // The label is the value itself; the icon names the row. The test account has no
      // storage limit, so the row reads `used / unlimited` and draws no bar.
      expect(storage?.title).toContain("/");
      expect(storage?.title).toContain("无上限");
      expect(storage?.title).not.toContain("存储空间");

      const settings = menu.items.find((entry) => entry.title === "设置");
      expect(settings).toBeDefined();
      settings!.click();
      expect(app.setting.opened).toBe(1);
      expect(app.setting.tabIds).toEqual(["courier"]);

      await patchTestUser(server, { expiresAt: null });
    });

    /**
     * Disabling is the reversible stop: the host stops (the server cut its subscription
     * off in-band), the user is told, and the binding stays — so re-enabling is one
     * click, not a password prompt. Deleting the account is the other half, and it does
     * the opposite (unbind and forget the key), which is why the two messages differ.
     */
    it("pauses and keeps the binding when the account is disabled", async () => {
      const { plugin, remote } = await startHostedPlugin("Disabled Account");
      await waitForAsync(
        async () => plugin.wsState === "connected",
        "the account's vault never subscribed",
      );

      await patchTestUser(server, { disabled: true });

      await waitForAsync(
        async () => plugin.settings.syncPaused === true,
        "a disabled key did not pause syncing",
      );
      // Everything needed to resume is still here: the binding, the key and the vault.
      expect(plugin.settings.connectedVaultId).toBe(remote.id);
      expect(plugin.settings.userKey).toBe(server.userKey);
      expect(plugin.host).toBeNull();
      await waitFor(
        () => notices.some((message) => message.includes("已被停用")),
        "nothing explained why syncing stopped",
      );

      // Enabling it again is a resume from the same state.
      await patchTestUser(server, { disabled: false });
      await plugin.resumeSync();
      await waitForAsync(
        async () => plugin.wsState === "connected",
        "resuming after re-enabling never reconnected",
      );
    });
  });
});
