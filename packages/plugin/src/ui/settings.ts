import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import {
  FILE_TYPE_GROUPS,
  SETTINGS_GROUPS,
  type FileTypeGroup,
  type SettingsGroup,
} from "@courier/engine";
import { MAX_DEVICE_NAME_LENGTH, type UserSummary } from "@courier/shared";
import { plural, t, type PluginMessageKey } from "../i18n";
import type CourierPlugin from "../main";
import { VaultPickerModal } from "./dialogs/vault-picker-modal";
import { SyncHistoryModal } from "./dialogs/sync-history-modal";
import { RecycleBinModal } from "./dialogs/recycle-bin-modal";
import { ExcludedFoldersModal } from "./dialogs/excluded-folders-modal";
import { getServerUrl } from "../shared/api";
import { ACCOUNT_READ_TIMEOUT_MS, keyExpiryDate, keyExpiryText } from "../shared/account-status";
import { withTimeout } from "../shared/with-timeout";
import { clearVaultCredential, loadVaultCredential } from "../shared/credential-store";
import { settingsGroupNeedsReload } from "../shared/settings-reload";
import { settingsStage, type SettingsStage } from "../shared/settings-stage";
import { storageUsageTitle } from "./storage-usage";

/** How long the device-name field waits after the last keystroke before saving. */
const DEVICE_NAME_DEBOUNCE_MS = 600;

/**
 * `visible` for an item that belongs to the step being rendered: the step switch already
 * selected it, so a second predicate would only repeat that. Module scope because the
 * page re-renders on every state change and the predicate captures nothing.
 */
const alwaysVisible = (): boolean => true;

/** The catalog key of each file-type switch's label and description. */
const FILE_TYPE_LABEL_KEYS: Record<FileTypeGroup, PluginMessageKey> = {
  images: "settings.fileType.images.label",
  audio: "settings.fileType.audio.label",
  video: "settings.fileType.video.label",
  pdf: "settings.fileType.pdf.label",
  otherTypes: "settings.fileType.otherTypes.label",
};

const FILE_TYPE_DESCRIPTION_KEYS: Record<FileTypeGroup, PluginMessageKey> = {
  images: "settings.fileType.images.desc",
  audio: "settings.fileType.audio.desc",
  video: "settings.fileType.video.desc",
  pdf: "settings.fileType.pdf.desc",
  otherTypes: "settings.fileType.otherTypes.desc",
};

/** The catalog key of each config-folder group's label and description. */
const SETTINGS_GROUP_LABEL_KEYS: Record<SettingsGroup, PluginMessageKey> = {
  app: "settings.group.app.label",
  appearance: "settings.group.appearance.label",
  themes: "settings.group.themes.label",
  snippets: "settings.group.snippets.label",
  hotkeys: "settings.group.hotkeys.label",
  corePlugins: "settings.group.corePlugins.label",
  corePluginSettings: "settings.group.corePluginSettings.label",
  communityPluginList: "settings.group.communityPluginList.label",
  communityPlugins: "settings.group.communityPlugins.label",
  otherFiles: "settings.group.otherFiles.label",
};

const SETTINGS_GROUP_DESCRIPTION_KEYS: Record<SettingsGroup, PluginMessageKey> = {
  app: "settings.group.app.desc",
  appearance: "settings.group.appearance.desc",
  themes: "settings.group.themes.desc",
  snippets: "settings.group.snippets.desc",
  hotkeys: "settings.group.hotkeys.desc",
  corePlugins: "settings.group.corePlugins.desc",
  corePluginSettings: "settings.group.corePluginSettings.desc",
  communityPluginList: "settings.group.communityPluginList.desc",
  communityPlugins: "settings.group.communityPlugins.desc",
  otherFiles: "settings.group.otherFiles.desc",
};

/**
 * The line under one settings switch: what it covers, plus a reload note when it needs one.
 *
 * The note comes from the shared list rather than a table of its own, so the switch that
 * warns about a reload and the popup that asks for one can never disagree.
 */
function describeSettingsGroup(group: SettingsGroup): string {
  const base = t(SETTINGS_GROUP_DESCRIPTION_KEYS[group]);
  return settingsGroupNeedsReload(group)
    ? t("settings.groupDescriptionWithReload", { base })
    : base;
}

/**
 * The settings tab, in three steps.
 *
 * The page shows only what the current step needs: signing in is two fields and
 * one button, and the switches appear once a vault is bound. Failures are reported
 * where they happened (an inline line under the step that failed) instead of as
 * notices, and the step never changes on a failure, so nothing the user typed is
 * lost.
 *
 * There is no page title and no step counter: the controls say what they are, and a
 * settings page that opens with a heading repeating the plugin's name is one line of
 * chrome the user has to read past every time.
 */
export class CourierSettingTab extends PluginSettingTab {
  private plugin: CourierPlugin;
  /**
   * Set when a sign-in attempt fails: the key was saved before it was proved, so the
   * derived stage would already be the vault step — this keeps the page on the field
   * the user has to fix instead.
   */
  private showLogin = false;
  /** The message under the current step's controls; survives a re-render. */
  private stageError: string | null = null;
  /** Set while a device-name keystroke is pending, so saving happens once. */
  private deviceNameTimer: number | null = null;
  private pendingDeviceName: string | null = null;
  /**
   * The connection row of the `ready` stage, kept so a host state change can update its
   * one live line without rebuilding the page.
   */
  private connectionRow: Setting | null = null;

  constructor(app: App, plugin: CourierPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Re-render the settings tab (called after a user action that changes its rows or step). */
  refresh(): void {
    this.update();
  }

  /**
   * Repaint only the connection row's live state.
   *
   * Host state changes arrive while a scope switch restarts the host. Rebuilding the page
   * there would throw away the user's scroll position and replace the switch they just
   * flipped, so the one row that follows the socket is updated in place instead.
   */
  refreshConnectionState(): void {
    this.connectionRow?.setDesc(this.syncStateLabel());
  }

  /**
   * The page, as the definitions Obsidian renders (1.13).
   *
   * Every row is an item, so the settings are indexable by Obsidian's settings search — the
   * reason the API exists — and the step the page is on is a `visible` predicate rather than
   * a `switch` over renderers. The switches are `control` items: their value is read and
   * written through the key, and `setControlValue` below turns a write into the same call
   * the row used to make.
   *
   * What stays imperative is what a definition cannot describe: the sign-in form (a form,
   * not a row of settings), the step cards, and the rows whose wording is computed at render
   * time. Those are `render` items and draw into the row they are given.
   *
   * **Only the current step is returned.** The framework keys an item by its name, and two
   * steps can legitimately carry the same one (both the locked and the unverified step say
   * `已绑定「…」`); returning every step and hiding the others by `visible` makes the app
   * report duplicate keys and render the page inconsistently. The step is a property of the
   * render, so the switch happens here — `refresh()` re-asks, which is what `update()` is for.
   */
  override getSettingDefinitions(): SettingDefinitionItem[] {
    // A full render replaces every row; the old connection row must not stay reachable by a
    // state change that arrives before the new one exists.
    this.connectionRow = null;
    switch (this.stage()) {
      case "login":
        return this.loginDefinitions(alwaysVisible);
      case "choose":
        return this.chooseDefinitions(alwaysVisible);
      case "locked":
        return this.lockedDefinitions(alwaysVisible);
      case "unverified":
        return this.unverifiedDefinitions(alwaysVisible);
      case "ready":
        return this.readyDefinitions(alwaysVisible);
    }
  }

  /**
   * A control's value, read the way the base class reads it: out of `plugin.settings`, by
   * the key's dotted path. Overridden only to keep the read explicit for the two maps.
   */
  override getControlValue(key: string): unknown {
    if (key.startsWith("fileTypes.")) {
      return this.plugin.settings.fileTypes[key.slice("fileTypes.".length) as FileTypeGroup];
    }
    if (key.startsWith("settingsGroups.")) {
      return this.plugin.settings.settingsGroups[
        key.slice("settingsGroups.".length) as SettingsGroup
      ];
    }
    return super.getControlValue(key);
  }

  /**
   * A control's write.
   *
   * The two switch families cannot be a plain property write: flipping one restarts the sync
   * host (the engine and the adapter read the scope when they are built), which is what
   * `setFileTypeEnabled` / `setSettingsGroupEnabled` do. (The device name is a `render` item,
   * not a control: its own row owns the debounce and the blur.)
   */
  override setControlValue(key: string, value: unknown): void | Promise<void> {
    if (key.startsWith("fileTypes.")) {
      void this.plugin.setFileTypeEnabled(
        key.slice("fileTypes.".length) as FileTypeGroup,
        value === true,
      );
      return;
    }
    if (key.startsWith("settingsGroups.")) {
      void this.plugin.setSettingsGroupEnabled(
        key.slice("settingsGroups.".length) as SettingsGroup,
        value === true,
      );
      return;
    }
    return super.setControlValue(key, value);
  }

  override hide(): void {
    // A pending device-name save must not be lost when the tab closes.
    this.flushDeviceName();
  }

  // ── Stage ──

  /**
   * Which step to render — the rule itself is `shared/settings-stage.ts`, so the
   * navigation model is unit-tested rather than living inside this render file.
   */
  private stage(): SettingsStage {
    const vaultId = this.plugin.settings.connectedVaultId;
    return settingsStage({
      userKey: this.plugin.settings.userKey,
      connectedVaultId: vaultId,
      paused: this.plugin.settings.syncPaused,
      unlocked: this.plugin.encryptionKey !== null,
      showLogin: this.showLogin,
      // Read, not remembered: the store is the one fact that tells "the key is on this
      // device, only the server check is missing" (retry) from "type the password". The
      // read also drops a record that belongs to another vault, exactly as the load path
      // would, so a page opened after a vault switch cannot inherit the old one.
      hasStoredCredential: vaultId !== null && loadVaultCredential(this.app, vaultId) !== null,
    });
  }

  // ── Section chrome ──

  /**
   * A section header: the title, plus an info icon whose tooltip carries what a paragraph
   * used to say (`setHeading()` is Obsidian's own section-heading row, and the extra button
   * is where the explanation lives).
   */
  private heading(name: string, tooltip: string, visible: () => boolean): SettingDefinitionItem {
    return {
      name,
      visible,
      render: (setting) => {
        setting.setName(name).setHeading();
        setting.addExtraButton((button) => button.setIcon("help-circle").setTooltip(tooltip));
      },
    };
  }

  /**
   * The one line a failed action leaves behind, where the user just looked.
   *
   * It is not a settings row: the row it is given loses its chrome and holds the line.
   */
  private stageErrorItem(visible: () => boolean): SettingDefinitionItem {
    return {
      name: "",
      visible: () => visible() && this.stageError !== null,
      render: (setting) => {
        setting.settingEl.empty();
        setting.settingEl.addClass("courier-settings-error-row");
        const error = setting.settingEl.createDiv({ cls: "courier-settings-error" });
        error.setCssStyles({ color: "var(--text-error)", margin: "4px 0" });
        error.setText(`⚠ ${this.stageError}`);
      },
    };
  }

  // ── The steps, as definitions ──

  /**
   * Step 1: the sign-in form. A form is not a row, so it stays one imperative item — and its
   * own error line is drawn inside the card rather than as a second item, because two items
   * would carry the same (empty) name, and the app keys an item by that name.
   */
  private loginDefinitions(visible: () => boolean): SettingDefinitionItem[] {
    return [
      {
        name: "",
        visible,
        render: (setting) => {
          // A form is not a settings row: the row it is given loses its chrome and holds the
          // card, which keeps the centred form the step has always been.
          setting.settingEl.empty();
          setting.settingEl.addClass("courier-login-row");
          this.renderLoginStage(setting.settingEl);
        },
      },
    ];
  }

  /** Step 2: who is signed in, and the way into the vault picker. */
  private chooseDefinitions(visible: () => boolean): SettingDefinitionItem[] {
    const settings = this.plugin.settings;
    return [
      {
        name: settings.userName ?? t("settings.account.reading"),
        desc: t("settings.account.server", { url: getServerUrl(settings) }),
        visible,
        render: (setting) => {
          setting.setName(settings.userName ?? t("settings.account.reading"));
          setting.setDesc(t("settings.account.server", { url: getServerUrl(settings) }));
          setting.addButton((button) =>
            button
              .setButtonText(t("settings.account.signOut"))
              .setDestructive()
              .onClick(async () => {
                await this.plugin.logout();
                this.resetStages();
                this.refresh();
              }),
          );
          // The name belongs to the server, not to this device: a vault signed in before
          // the name was ever read (or renamed since) would otherwise show nothing.
          void this.refreshAccount(setting);
        },
      },
      {
        name: t("settings.choose.selectVault"),
        desc: t("settings.choose.noVault"),
        visible,
        render: (setting) => {
          setting
            .setName(t("settings.choose.selectVault"))
            .setDesc(t("settings.choose.noVault"))
            .addButton((button) =>
              button
                .setButtonText(t("settings.choose.button"))
                .setCta()
                .onClick(async () => {
                  await this.pickVault();
                }),
            );
        },
      },
      this.stageErrorItem(visible),
    ];
  }

  /** Step 3a, locked: the vault is bound and this device holds no key for it. */
  private lockedDefinitions(visible: () => boolean): SettingDefinitionItem[] {
    return [
      {
        name: t("settings.locked.bound", { vault: this.boundVaultName() }),
        desc: t("settings.locked.desc"),
        visible,
        render: (setting) => {
          setting
            .setClass("courier-step-card")
            .setName(t("settings.locked.bound", { vault: this.boundVaultName() }))
            .setDesc(t("settings.locked.desc"))
            .addButton((button) =>
              button
                .setButtonText(t("settings.locked.unlock"))
                .setCta()
                .onClick(async () => {
                  await this.unlock();
                }),
            );
          this.addBoundStepEscapes(setting);
        },
      },
      this.stageErrorItem(visible),
    ];
  }

  /** Step 3b, unverified: the key is on this device, only the server check is missing. */
  private unverifiedDefinitions(visible: () => boolean): SettingDefinitionItem[] {
    return [
      {
        name: t("settings.locked.bound", { vault: this.boundVaultName() }),
        desc: t("settings.unverified.desc"),
        visible,
        render: (setting) => {
          setting
            .setClass("courier-step-card")
            .setName(t("settings.locked.bound", { vault: this.boundVaultName() }))
            .setDesc(t("settings.unverified.desc"))
            .addButton((button) => {
              button.setButtonText(t("settings.unverified.retry")).setCta();
              button.onClick(async () => {
                button.setDisabled(true).setButtonText(t("settings.unverified.retrying"));
                this.stageError = null;
                const started = await this.plugin.autoUnlockOrPrompt();
                if (!started && this.stage() === "unverified") {
                  this.stageError = t("settings.unverified.failed");
                }
                this.refresh();
              });
            });
          this.addBoundStepEscapes(setting);
        },
      },
      this.stageErrorItem(visible),
    ];
  }

  /**
   * Step 4, the settings themselves: the connection, what this device syncs, and the
   * account it syncs with.
   *
   * Disconnecting and logging out are deliberately not one row: they are two different
   * decisions, and the account — with its one destructive button — is the last section.
   */
  private readyDefinitions(visible: () => boolean): SettingDefinitionItem[] {
    const unlocked = this.plugin.encryptionKey !== null;
    return [
      this.heading(t("settings.section.device"), t("settings.section.device.tooltip"), visible),
      {
        name: t("settings.device.name"),
        desc: t("settings.device.desc"),
        visible,
        // A `render` item, not a `text` control: the field caps what can be typed
        // (`maxLength`, rather than a validation message after the fact) and commits when it
        // loses focus, and a control has nowhere to hang either of those.
        render: (setting) => this.buildDeviceNameRow(setting),
      },

      this.heading(t("settings.section.vault"), t("settings.section.vault.tooltip"), visible),
      {
        name: t("settings.ready.connected", {
          vault: this.plugin.settings.connectedVaultName ?? "",
        }),
        desc: this.syncStateLabel(),
        visible,
        render: (setting) => this.buildConnectionRow(setting),
      },
      {
        name: t("settings.pause.name"),
        visible,
        render: (setting) => this.buildPauseRow(setting),
      },
      {
        name: t("settings.vaultPassword.name"),
        visible: () => visible() && this.hasRememberedPasswordRow(),
        render: (setting) => this.buildRememberedPasswordRow(setting),
      },

      this.heading(
        t("settings.section.fileTypes"),
        t("settings.section.fileTypes.tooltip"),
        visible,
      ),
      ...FILE_TYPE_GROUPS.map((group): SettingDefinitionItem => ({
        name: t(FILE_TYPE_LABEL_KEYS[group]),
        desc: t(FILE_TYPE_DESCRIPTION_KEYS[group]),
        visible,
        control: { type: "toggle", key: `fileTypes.${group}` },
      })),

      this.heading(
        t("settings.section.excludedFolders"),
        t("settings.section.excludedFolders.tooltip"),
        visible,
      ),
      {
        name: t("settings.excludedFolders.list.name"),
        visible,
        render: (setting) => this.buildExcludedFoldersRow(setting),
      },

      this.heading(
        t("settings.section.settingsSync"),
        t("settings.section.settingsSync.tooltip"),
        visible,
      ),
      ...SETTINGS_GROUPS.map((group): SettingDefinitionItem => ({
        name: t(SETTINGS_GROUP_LABEL_KEYS[group]),
        desc: describeSettingsGroup(group),
        visible,
        control: { type: "toggle", key: `settingsGroups.${group}` },
      })),

      {
        name: t("settings.history.name"),
        desc: t("settings.history.desc"),
        visible,
        render: (setting) => this.buildHistoryRow(setting),
      },
      {
        name: t("settings.recycleBin.name"),
        visible,
        render: (setting) => this.buildRecycleBinRow(setting, unlocked),
      },

      this.heading(t("settings.section.account"), t("settings.section.account.tooltip"), visible),
      {
        name: this.plugin.settings.userName ?? t("settings.account.reading"),
        visible,
        render: (setting) => this.buildAccountRow(setting),
      },
      this.stageErrorItem(visible),
    ];
  }

  // ── Step 1: sign in ──

  /**
   * The whole login step: two labelled fields and one button, centred.
   *
   * No heading and no description — the fields say what they are, and the step is
   * the first thing a fresh install shows, so there is nothing to explain. It is
   * deliberately **not** a set of Obsidian settings rows either: those put the label
   * on the left and the control on the right, which is right for a switch and wrong
   * for a form.
   *
   * The fields persist as they are typed but never re-render the page (a rebuild on
   * every keystroke would take the caret with it), so validation and the request
   * happen on the button, and its outcome decides the next step. Enter submits, as on
   * any web login.
   */
  private renderLoginStage(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: "courier-login" });
    // A narrow column in the middle of the pane, with nothing above it: the page has
    // no title, so the form is the whole step.
    card.setCssStyles({ maxWidth: "360px", margin: "48px auto 0" });

    const serverInput = this.renderLoginField(card, t("settings.login.serverAddress"), {
      type: "text",
      placeholder: "http://localhost:3002",
      value: this.plugin.settings.serverUrl ?? "",
      onChange: (value) => {
        this.plugin.settings.serverUrl = value.trim() || null;
        void this.plugin.saveSettings();
      },
    });
    const keyInput = this.renderLoginField(card, t("settings.login.userKey"), {
      type: "password",
      placeholder: "ck_...",
      value: this.plugin.settings.userKey ?? "",
      onChange: (value) => {
        this.plugin.settings.userKey = value.trim() || null;
        void this.plugin.saveSettings();
      },
    });

    const submit = card.createEl("button", {
      text: t("settings.login.submit"),
      cls: "courier-login-submit",
    });
    submit.type = "button";
    submit.addClass("mod-cta");
    submit.setCssStyles({ width: "100%", marginTop: "8px", padding: "10px" });
    const signIn = async () => {
      submit.disabled = true;
      submit.setText(t("settings.login.submitting"));
      await this.signIn();
    };
    submit.addEventListener("click", () => void signIn());
    for (const input of [serverInput, keyInput]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void signIn();
      });
    }

    // The failure lands under the button that produced it. It is part of this item rather than
    // an item of its own: a second item would carry the same (empty) name, and the app keys an
    // item by its name.
    if (this.stageError) {
      const error = card.createDiv({ cls: "courier-settings-error" });
      error.setCssStyles({ color: "var(--text-error)", margin: "4px 0" });
      error.setText(`⚠ ${this.stageError}`);
    }
  }

  /** One labelled, full-width field of the login form. */
  private renderLoginField(
    parent: HTMLElement,
    label: string,
    options: {
      type: string;
      placeholder: string;
      value: string;
      onChange: (value: string) => void;
    },
  ): HTMLInputElement {
    const field = parent.createDiv({ cls: "courier-login-field" });
    field.setCssStyles({ marginBottom: "14px" });
    const labelEl = field.createEl("label", { text: label, cls: "courier-login-label" });
    labelEl.setCssStyles({
      display: "block",
      marginBottom: "6px",
      fontWeight: "600",
      fontSize: "var(--font-ui-small)",
    });

    const input = field.createEl("input", { cls: "courier-login-input" });
    input.type = options.type;
    input.placeholder = options.placeholder;
    input.value = options.value;
    input.setCssStyles({
      boxSizing: "border-box",
      width: "100%",
      padding: "8px 10px",
      border: "1px solid var(--background-modifier-border)",
      borderRadius: "var(--radius-m)",
      background: "var(--background-modifier-form-field)",
      color: "var(--text-normal)",
    });
    input.addEventListener("input", () => options.onChange(input.value));
    return input;
  }

  /** Keep the credentials, prove the key works, and show the vault list. */
  private async signIn(): Promise<void> {
    this.stageError = null;
    const outcome = await this.plugin.signIn();
    if (!outcome.ok) {
      // A rejected key is still a saved key, so the derived stage would be "choose
      // the vault"; the override keeps the page on the field the user has to fix.
      this.showLogin = true;
      this.stageError = outcome.error;
      this.refresh();
      return;
    }
    this.showLogin = false;
    this.refresh();
  }

  // ── Step 2: the account, and choosing a remote vault ──

  /** Open the vault picker; connecting inside it moves the page to the settings. */
  private async pickVault(): Promise<void> {
    const modal = new VaultPickerModal(this.app, this.plugin);
    modal.open();
    const connected = await modal.getResult();
    if (!connected) return;
    this.resetStages();
    this.refresh();
  }

  // ── Step 3, bound: the vault has no key in memory ──

  /**
   * The two ways out of a bound-but-not-syncing step: unbind this vault, or forget the
   * account. Shared so the `locked` and `unverified` steps cannot drift apart.
   */
  private addBoundStepEscapes(setting: Setting): void {
    setting
      .addButton((button) =>
        button.setButtonText(t("settings.locked.disconnect")).onClick(async () => {
          await this.plugin.disconnectVault();
          this.resetStages();
          this.refresh();
        }),
      )
      .addButton((button) =>
        button.setButtonText(t("settings.account.signOut")).onClick(async () => {
          await this.plugin.logout();
          this.resetStages();
          this.refresh();
        }),
      );
  }

  /** The name of the bound vault, as the page's step rows read it. */
  private boundVaultName(): string {
    return this.plugin.settings.connectedVaultName ?? "";
  }

  private async unlock(): Promise<void> {
    // A stored-key unlock that is already running owns the question (it is the dialog this
    // click would join); it derives the key and starts the host from the one answer. A
    // second unlock here would race two host starts over the same vault.
    if (this.plugin.autoUnlockInFlight) {
      await this.plugin.autoUnlockOrPrompt();
      return;
    }
    const result = await this.plugin.askForVaultPassword({
      title: t("settings.locked.unlockTitle", { vault: this.boundVaultName() }),
    });
    if (!result) return;

    this.stageError = null;
    const outcome = await this.plugin.unlockWithPassword(result.password, result.remember);
    if (!outcome.ok) this.stageError = outcome.error;
    this.refresh();
  }

  // ── Step 3: the settings themselves ──

  /**
   * The connection row's state line: paused wins over the socket, because a paused host is
   * stopped on purpose rather than disconnected.
   */
  private syncStateLabel(): string {
    if (this.plugin.settings.syncPaused) return t("settings.state.paused");
    const wsState = this.plugin.wsState;
    return wsState === "connected"
      ? t("settings.state.connected")
      : wsState === "connecting"
        ? t("settings.state.connecting")
        : wsState === "error"
          ? t("settings.state.error")
          : t("settings.state.disconnected");
  }

  private openHistory(): void {
    // The log is in memory and needs neither the vault key nor the network; the only
    // thing the dialog cannot read for itself is whether a vault is bound.
    new SyncHistoryModal(this.app, {
      connected: this.plugin.settings.connectedVaultId !== null,
    }).open();
  }

  /** Read which account the user key belongs to and fill the account row. */
  private async refreshAccount(row: Setting): Promise<void> {
    const serverUrl = getServerUrl(this.plugin.settings);
    // The row is painted from this key's answer only. A sign-out or an account switch
    // during the read would otherwise save the previous account's name under the new
    // key; the next render is already painting the state the user moved to.
    const userKey = this.plugin.settings.userKey;
    try {
      const me = await withTimeout(this.plugin.actions.getMe(), ACCOUNT_READ_TIMEOUT_MS);
      if (this.plugin.settings.userKey !== userKey) return;
      this.plugin.settings.userName = me.name;
      await this.plugin.saveSettings();
      row.setName(me.name);
      row.setDesc(this.accountDescription(serverUrl, me));
    } catch (err) {
      // The page is still usable (everything else works on the same key), so this
      // stays a fallback to whatever was known last rather than an error line.
      console.error("Reading the account name failed:", err);
      if (this.plugin.settings.userKey !== userKey) return;
      row.setName(this.plugin.settings.userName ?? t("settings.account.unknown"));
      row.setDesc(this.accountDescription(serverUrl, null));
    }
  }

  /**
   * The account row's description: server, expiry and storage as a small stack.
   *
   * The values are one logical row, not three settings rows: the section's only action
   * stays the sign-out button on that row. The fallback string (no DOM, in the e2e
   * harness) joins the same parts so a test reads the same facts.
   */
  private accountDescription(serverUrl: string, me: UserSummary | null): string | DocumentFragment {
    const serverLine = t("settings.account.server", { url: serverUrl });
    const separator = t("settings.account.detailSeparator");
    const keyValue = me === null ? null : this.expiryValue(me.expiresAt);
    const storageValue = me === null ? null : storageUsageTitle(me);

    if (typeof document === "undefined") {
      const lines = [serverLine];
      if (keyValue === null || storageValue === null) {
        lines.push(t("settings.account.usageUnavailable"));
      } else {
        const storageText =
          typeof storageValue === "string" ? storageValue : t("settings.account.storage");
        lines.push(`${t("settings.account.keyExpiry")}${separator}${keyValue}`);
        lines.push(`${t("settings.account.storage")}${separator}${storageText}`);
      }
      return lines.join(" · ");
    }

    const fragment = createFragment();
    const details = fragment.createDiv({ cls: "courier-account-details" });
    details.createDiv({ cls: "courier-account-detail", text: serverLine });

    if (keyValue === null || storageValue === null) {
      details.createDiv({
        cls: "courier-account-detail",
        text: t("settings.account.usageUnavailable"),
      });
      return fragment;
    }

    // Label/value grid: the two readings line up instead of each label floating above
    // its own value, and the row keeps its breathing room on a phone.
    const usage = details.createDiv({ cls: "courier-account-usage" });
    usage.createSpan({ cls: "courier-account-label", text: t("settings.account.keyExpiry") });
    usage.createDiv({
      cls: "courier-account-value courier-account-key-expiry",
      text: keyValue,
    });

    usage.createSpan({ cls: "courier-account-label", text: t("settings.account.storage") });
    const storage = usage.createDiv({
      cls: "courier-account-value courier-account-storage",
    });
    if (typeof storageValue === "string") storage.setText(storageValue);
    else storage.appendChild(storageValue);
    return fragment;
  }

  /** The expiry's value: the date plus the same countdown the status menu shows. */
  private expiryValue(expiresAt: string | null): string {
    if (expiresAt === null) return t("status.value.expiry.never");
    const date = keyExpiryDate(expiresAt);
    if (date === null) return t("status.value.expiry.unknown");
    return t("settings.account.expiryValue", {
      date,
      remaining: keyExpiryText(expiresAt),
    });
  }

  // ── Device label + sync history ──

  /** Debounced device-name save — one write per pause, not per keystroke. */
  private queueDeviceName(value: string): void {
    this.pendingDeviceName = value;
    if (this.deviceNameTimer !== null) window.clearTimeout(this.deviceNameTimer);
    this.deviceNameTimer = window.setTimeout(() => {
      this.deviceNameTimer = null;
      void this.commitDeviceName();
    }, DEVICE_NAME_DEBOUNCE_MS);
  }

  /** Save a pending device name now (blur, or the tab closing). */
  private flushDeviceName(): void {
    if (this.deviceNameTimer !== null) {
      window.clearTimeout(this.deviceNameTimer);
      this.deviceNameTimer = null;
    }
    void this.commitDeviceName();
  }

  private async commitDeviceName(): Promise<void> {
    const value = this.pendingDeviceName;
    this.pendingDeviceName = null;
    if (value === null) return;
    // No `refresh`: re-rendering the tab would take the caret out of the field the
    // user may still be typing in.
    await this.plugin.setDeviceName(value, { refresh: false });
  }

  // ── The rows of the settings step ──

  /**
   * What this client calls itself.
   *
   * The field is built here rather than declared as a `control`, because it caps what can be
   * typed (`maxLength`) and commits when it loses focus — a `control` has no hook for either.
   * Leaving the field flushes the debounce, so a value the user typed and immediately left is
   * written before any other action rebuilds the page from the stored one.
   */
  private buildDeviceNameRow(setting: Setting): void {
    setting
      .setName(t("settings.device.name"))
      .setDesc(t("settings.device.desc"))
      .addText((text) => {
        text.inputEl.maxLength = MAX_DEVICE_NAME_LENGTH;
        text
          .setPlaceholder(t("settings.device.placeholder"))
          .setValue(this.plugin.settings.deviceName ?? "");
        text.onChange((value) => this.queueDeviceName(value));
        text.inputEl.addEventListener("blur", () => this.flushDeviceName());
      });
  }

  /** The bound vault, its live state, and the way out of it. */
  private buildConnectionRow(setting: Setting): void {
    setting
      .setName(
        t("settings.ready.connected", { vault: this.plugin.settings.connectedVaultName ?? "" }),
      )
      .setDesc(this.syncStateLabel())
      .addButton((button) =>
        button.setButtonText(t("settings.ready.disconnect")).onClick(async () => {
          await this.plugin.disconnectVault();
          this.resetStages();
          this.refresh();
        }),
      );
    this.connectionRow = setting;
  }

  /**
   * The one pause/resume control. Pausing stops the host and keeps everything else, so
   * resuming is this layout's `继续同步` and no password on a device that remembers one.
   */
  private buildPauseRow(setting: Setting): void {
    const paused = this.plugin.settings.syncPaused;
    setting
      .setName(t("settings.pause.name"))
      .setDesc(paused ? t("settings.pause.descPaused") : t("settings.pause.descRunning"))
      .addButton((button) => {
        button.setButtonText(paused ? t("settings.pause.resume") : t("settings.pause.pause"));
        if (paused) button.setCta();
        button.onClick(() => {
          void (paused ? this.plugin.resumeSync() : this.plugin.pauseSync());
        });
      });
  }

  /** Whether this run has anything to say about the remembered vault key. */
  private hasRememberedPasswordRow(): boolean {
    return this.plugin.settings.connectedVaultId !== null;
  }

  /**
   * What this device remembers about the vault key: kept in Obsidian's App-level
   * localStorage, so it never enters the vault folder and is not carried off by vault
   * syncing — and the connection resumes without asking for the password again.
   */
  private buildRememberedPasswordRow(setting: Setting): void {
    const vaultId = this.plugin.settings.connectedVaultId;
    if (!vaultId) return;
    const stored = loadVaultCredential(this.app, vaultId);
    const paused = this.plugin.settings.syncPaused;

    setting.setName(t("settings.vaultPassword.name"));
    if (!stored) {
      setting.setDesc(
        paused
          ? t("settings.vaultPassword.notStoredPaused")
          : t("settings.vaultPassword.notStored"),
      );
      return;
    }

    setting.setDesc(
      paused ? t("settings.vaultPassword.storedPaused") : t("settings.vaultPassword.stored"),
    );
    setting.addButton((button) =>
      button.setButtonText(t("settings.vaultPassword.clear")).onClick(() => {
        clearVaultCredential(this.app);
        // Re-rendering this row as 未保存 is the confirmation.
        this.refresh();
      }),
    );
  }

  /**
   * The way into the excluded-folder tree: one row, like Obsidian Sync's "Excluded folders →
   * Manage", because the tree is a dialog and a vault with a hundred folders should not turn
   * this page into a hundred rows.
   */
  private buildExcludedFoldersRow(setting: Setting): void {
    const count = this.plugin.settings.excludedFolders.length;
    setting
      .setName(t("settings.excludedFolders.list.name"))
      .setDesc(
        count === 0
          ? t("settings.excludedFolders.list.descNone")
          : plural(
              "settings.excludedFolders.list.descCount.one",
              "settings.excludedFolders.list.descCount.other",
              count,
            ),
      )
      .addButton((button) =>
        button.setButtonText(t("settings.excludedFolders.manage")).onClick(() => {
          new ExcludedFoldersModal(this.app, {
            excludedFolders: this.plugin.settings.excludedFolders,
            apply: (folders) => this.plugin.setExcludedFolders(folders),
          }).open();
        }),
      );
  }

  /**
   * The way into the sync history: a row, not a section, because the log itself is a dialog
   * ({@link SyncHistoryModal}) and the page stays a page of settings.
   */
  private buildHistoryRow(setting: Setting): void {
    setting
      .setName(t("settings.history.name"))
      .setDesc(t("settings.history.desc"))
      .addButton((button) =>
        button.setButtonText(t("settings.history.view")).onClick(() => {
          this.openHistory();
        }),
      );
  }

  /** The way into the recycle bin, disabled while this device holds no vault key. */
  private buildRecycleBinRow(setting: Setting, unlocked: boolean): void {
    setting
      .setName(t("settings.recycleBin.name"))
      .setDesc(unlocked ? t("settings.recycleBin.desc") : t("settings.recycleBin.descLocked"))
      .addButton((button) =>
        button
          .setButtonText(t("settings.recycleBin.view"))
          .setDisabled(!unlocked)
          .onClick(() => {
            new RecycleBinModal(this.app, this.plugin).open();
          }),
      );
  }

  /**
   * The account this device is signed in as: one row with the name the key belongs to, the
   * server, the two read-only facts a mobile user cannot see anywhere else — the key's
   * expiry and the storage quota — and the one destructive action, signing out.
   */
  private buildAccountRow(setting: Setting): void {
    setting
      .setName(this.plugin.settings.userName ?? t("settings.account.reading"))
      .setDesc(t("settings.account.server", { url: getServerUrl(this.plugin.settings) }))
      .addButton((button) =>
        button
          .setButtonText(t("settings.account.signOut"))
          .setDestructive()
          .onClick(async () => {
            await this.plugin.logout();
            this.resetStages();
            this.refresh();
          }),
      );
    // The name belongs to the server: one small read fills the name and the usage lines.
    void this.refreshAccount(setting);
  }

  // ── Helpers ──

  /** Drop the per-step state when the flow moves on (bind, unbind, log out). */
  private resetStages(): void {
    this.stageError = null;
    this.showLogin = false;
  }
}
