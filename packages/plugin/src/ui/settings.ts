import { App, PluginSettingTab, Setting } from "obsidian";
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
    this.display();
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

  override display(): void {
    const { containerEl } = this;
    // A full render replaces every row; the old connection row must not stay reachable
    // by a state change that arrives before the new one exists.
    this.connectionRow = null;
    containerEl.empty();

    switch (this.stage()) {
      case "login":
        this.renderLoginStage(containerEl);
        break;
      case "choose":
        this.renderChooseStage(containerEl);
        break;
      case "locked":
        this.renderLockedStage(containerEl);
        break;
      case "unverified":
        this.renderUnverifiedStage(containerEl);
        break;
      case "ready":
        this.renderReadyStage(containerEl);
        break;
    }
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
   * A section header: the title, plus an info icon whose tooltip carries what a
   * paragraph used to say (`Setting.setHeading()` is Obsidian's own section-heading
   * row, and the extra button is where the explanation lives).
   */
  private renderSection(containerEl: HTMLElement, title: string, tooltip: string): void {
    const heading = new Setting(containerEl).setName(title).setHeading();
    heading.addExtraButton((button) => button.setIcon("help-circle").setTooltip(tooltip));
  }

  /** The one line a failed action leaves behind, where the user just looked. */
  private renderStageError(containerEl: HTMLElement): void {
    if (!this.stageError) return;
    const error = containerEl.createDiv({ cls: "courier-settings-error" });
    error.setCssStyles({ color: "var(--text-error)", margin: "4px 0" });
    error.setText(`⚠ ${this.stageError}`);
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

    this.renderStageError(card);
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
      this.display();
      return;
    }
    this.showLogin = false;
    this.display();
  }

  // ── Step 2: the account, and choosing a remote vault ──

  /**
   * Two rows: who is signed in, and the way into the vault picker.
   *
   * The account row carries the two things the key stands for — the server it belongs
   * to and the name the server knows it by — and signing out is its only action:
   * changing either one means signing in again, which is what the first step is for.
   * The vault row is one row no matter how many vaults exist, because the list,
   * connecting, renaming, deleting and creating all live in the dialog behind it
   * ({@link VaultPickerModal}).
   */
  private renderChooseStage(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;

    const account = new Setting(containerEl)
      .setName(settings.userName ?? t("settings.account.reading"))
      .setDesc(t("settings.account.server", { url: getServerUrl(settings) }))
      .addButton((button) =>
        button
          .setButtonText(t("settings.account.signOut"))
          .setWarning()
          .onClick(async () => {
            await this.plugin.logout();
            this.resetStages();
            this.display();
          }),
      );
    // The name belongs to the server, not to this device: a vault that was signed in
    // before the name was ever read (or whose account was renamed since) would
    // otherwise show nothing. One small read, painted into the row that needs it.
    void this.refreshAccount(account);

    new Setting(containerEl)
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
  }

  /** Open the vault picker; connecting inside it moves the page to the settings. */
  private async pickVault(): Promise<void> {
    const modal = new VaultPickerModal(this.app, this.plugin);
    modal.open();
    const connected = await modal.getResult();
    if (!connected) return;
    this.resetStages();
    this.display();
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
          this.display();
        }),
      )
      .addButton((button) =>
        button.setButtonText(t("settings.account.signOut")).onClick(async () => {
          await this.plugin.logout();
          this.resetStages();
          this.display();
        }),
      );
  }

  /**
   * Step 3a, locked: the vault is bound and this device holds no key for it.
   *
   * The password dialog is the one thing that can move the step on (`unlock`).
   */
  private renderLockedStage(containerEl: HTMLElement): void {
    const row = new Setting(containerEl)
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
    this.addBoundStepEscapes(row);
    this.renderStageError(containerEl);
  }

  /**
   * Step 3b, unverified: the vault is bound, the key is saved on this device, but this run
   * could not get it into memory — the server was unreachable when it tried to prove it.
   *
   * This used to render as `locked`, which offers the password dialog: the page then said
   * the vault needed its password although the key was already here, and the dialog could
   * not succeed either (a password cannot be proved without the same server). The action
   * that fits is the retry, which runs the cold-start path: it unlocks silently when the
   * server answers, and falls back to the password dialog when the server reports the
   * stored key as dead.
   */
  private renderUnverifiedStage(containerEl: HTMLElement): void {
    const row = new Setting(containerEl)
      .setClass("courier-step-card")
      .setName(t("settings.locked.bound", { vault: this.boundVaultName() }))
      .setDesc(t("settings.unverified.desc"))
      .addButton((button) => {
        button.setButtonText(t("settings.unverified.retry")).setCta();
        button.onClick(async () => {
          button.setDisabled(true).setButtonText(t("settings.unverified.retrying"));
          this.stageError = null;
          const started = await this.plugin.autoUnlockOrPrompt();
          // The unlock re-renders the page on every completion, so this button is gone by
          // now. What the user sees instead is the ready step, the locked step (a credential
          // that vanished and a dialog they cancelled) or this step with the failure line.
          if (!started && this.stage() === "unverified") {
            this.stageError = t("settings.unverified.failed");
          }
          this.display();
        });
      });
    this.addBoundStepEscapes(row);
    this.renderStageError(containerEl);
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
    this.display();
  }

  // ── Step 3: the settings themselves ──

  /**
   * The settings, in sections: the connection, what this device syncs, and the
   * account it syncs with.
   *
   * Disconnecting and logging out are deliberately **not** on one row: they are two
   * different decisions (stop syncing this vault vs. forget this account here), and
   * the account — with its one destructive button — is the last section of the page.
   */
  private renderReadyStage(containerEl: HTMLElement): void {
    const settings = this.plugin.settings;
    // A paused load deliberately does not unlock (see `settingsStage`), so this page can be
    // on screen without the vault key. The recycle bin decrypts stored paths and says so;
    // the sync history is this run's in-memory log, so it needs no key and stays available
    // while paused.
    const unlocked = this.plugin.encryptionKey !== null;

    this.renderDeviceSection(containerEl);

    this.renderSection(
      containerEl,
      t("settings.section.vault"),
      t("settings.section.vault.tooltip"),
    );
    const connection = new Setting(containerEl)
      .setName(t("settings.ready.connected", { vault: settings.connectedVaultName ?? "" }))
      .setDesc(this.syncStateLabel())
      .addButton((button) =>
        button.setButtonText(t("settings.ready.disconnect")).onClick(async () => {
          await this.plugin.disconnectVault();
          this.resetStages();
          this.display();
        }),
      );
    this.connectionRow = connection;

    this.renderPauseRow(containerEl);
    this.renderRememberedPassword(containerEl);
    this.renderFileTypesSection(containerEl);
    this.renderExcludedFoldersSection(containerEl);
    this.renderSettingsSyncSection(containerEl);
    this.renderHistoryRow(containerEl);
    this.renderRecycleBinRow(containerEl, unlocked);
    this.renderAccountSection(containerEl);
  }

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

  /**
   * The one pause/resume control: pausing stops the host and keeps everything else
   * (binding, key, stored credential, sync state), so resuming is this layout's `继续同步`
   * and no password on a device that remembers one. Deliberately a row of its own rather
   * than another button on the connection row: "stop syncing for now" and "let go of this
   * vault" are different decisions, and the connection row's one action stays the one
   * that forgets the credential.
   */
  private renderPauseRow(containerEl: HTMLElement): void {
    const paused = this.plugin.settings.syncPaused;
    new Setting(containerEl)
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

  /**
   * What this client calls itself.
   *
   * Near the top, and not part of the account: it is the label every push from this
   * machine carries, and the one place it shows up is the history.
   */
  private renderDeviceSection(containerEl: HTMLElement): void {
    this.renderSection(
      containerEl,
      t("settings.section.device"),
      t("settings.section.device.tooltip"),
    );
    new Setting(containerEl)
      .setName(t("settings.device.name"))
      .setDesc(t("settings.device.desc"))
      .addText((text) => {
        text.inputEl.maxLength = MAX_DEVICE_NAME_LENGTH;
        text
          .setPlaceholder(t("settings.device.placeholder"))
          .setValue(this.plugin.settings.deviceName);
        text.onChange((value) => this.queueDeviceName(value));
        // Leaving the field commits immediately instead of waiting out the debounce.
        text.inputEl.addEventListener("blur", () => this.flushDeviceName());
      });
  }

  /**
   * The way into the sync history.
   *
   * A row, not a section: the log itself is a dialog (`SyncHistoryModal`), the way
   * Obsidian's own Sync settings offers its activity log. The page stays a page of
   * settings instead of growing a 200-line log inside it.
   */
  private renderHistoryRow(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName(t("settings.history.name"))
      .setDesc(t("settings.history.desc"))
      .addButton((button) =>
        button.setButtonText(t("settings.history.view")).onClick(() => {
          this.openHistory();
        }),
      );
  }

  private openHistory(): void {
    // The log is in memory and needs neither the vault key nor the network; the only
    // thing the dialog cannot read for itself is whether a vault is bound.
    new SyncHistoryModal(this.app, {
      connected: this.plugin.settings.connectedVaultId !== null,
    }).open();
  }

  /**
   * The way into the recycle bin.
   *
   * The same shape as the sync-history row above, and for the same reason: the list is a
   * dialog ({@link RecycleBinModal}), so the page stays a page of settings. This used to
   * be a ribbon icon and a sidebar view, which is two pieces of chrome for something a
   * user reaches for about as often as their own sync history.
   */
  private renderRecycleBinRow(containerEl: HTMLElement, unlocked: boolean): void {
    new Setting(containerEl)
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
   * The account this device is signed in as: one row with the name the key belongs to,
   * the server, the two read-only facts a mobile user cannot see anywhere else — the
   * key's expiry and the storage quota — and the one destructive action, signing out.
   *
   * Everything but the name lives in the row's description as a small stack of lines, so
   * the section stays one row instead of growing a settings list. One `GET /api/me` read
   * fills both the name and the usage, so opening the page costs no extra request.
   */
  private renderAccountSection(containerEl: HTMLElement): void {
    this.renderSection(
      containerEl,
      t("settings.section.account"),
      t("settings.section.account.tooltip"),
    );

    const account = new Setting(containerEl)
      .setName(this.plugin.settings.userName ?? t("settings.account.reading"))
      .setDesc(t("settings.account.server", { url: getServerUrl(this.plugin.settings) }))
      .addButton((button) =>
        button
          .setButtonText(t("settings.account.signOut"))
          .setWarning()
          .onClick(async () => {
            await this.plugin.logout();
            this.resetStages();
            this.display();
          }),
      );
    // The name belongs to the server, not to this device: a vault that was signed in
    // before the name was ever read (or whose account was renamed since) would
    // otherwise show nothing. One small read fills the name and the usage lines.
    void this.refreshAccount(account);
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

  /**
   * What this device remembers about the vault key.
   *
   * The key is kept in Obsidian's App-level localStorage (see
   * `shared/credential-store.ts`): it never enters the vault folder, so it is not
   * carried off by vault syncing — but it does mean the connection resumes without
   * asking for the password again.
   */
  private renderRememberedPassword(containerEl: HTMLElement): void {
    const vaultId = this.plugin.settings.connectedVaultId;
    if (!vaultId) return;
    const stored = loadVaultCredential(this.app, vaultId);
    const paused = this.plugin.settings.syncPaused;

    if (!stored) {
      new Setting(containerEl)
        .setName(t("settings.vaultPassword.name"))
        .setDesc(
          paused
            ? t("settings.vaultPassword.notStoredPaused")
            : t("settings.vaultPassword.notStored"),
        );
      return;
    }

    new Setting(containerEl)
      .setName(t("settings.vaultPassword.name"))
      .setDesc(
        paused ? t("settings.vaultPassword.storedPaused") : t("settings.vaultPassword.stored"),
      )
      .addButton((button) =>
        button.setButtonText(t("settings.vaultPassword.clear")).onClick(() => {
          clearVaultCredential(this.app);
          // `refresh()` re-renders this row as 未保存, which is the confirmation.
          this.refresh();
        }),
      );
  }

  // ── Vault file types ──

  /**
   * One switch per vault-wide file type.
   *
   * Markdown and `.canvas` are not offered: they are the vault's content, and a
   * device that cannot see them is looking at a different vault. Everything else is
   * device-local — a type switched off is neither pushed nor pulled, and switching
   * one off deletes nothing on either side. Any change restarts the host, because
   * the engine and the adapter read the scope when they are built.
   *
   * The maximum sync file size is deliberately absent: it belongs to the account's
   * key and is set by the administrator, so it has no device-local control here.
   */
  private renderFileTypesSection(containerEl: HTMLElement): void {
    this.renderSection(
      containerEl,
      t("settings.section.fileTypes"),
      t("settings.section.fileTypes.tooltip"),
    );

    for (const group of FILE_TYPE_GROUPS) {
      new Setting(containerEl)
        .setName(t(FILE_TYPE_LABEL_KEYS[group]))
        .setDesc(t(FILE_TYPE_DESCRIPTION_KEYS[group]))
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.fileTypes[group]).onChange(async (value) => {
            await this.plugin.setFileTypeEnabled(group, value);
          }),
        );
    }
  }

  // ── Excluded folders ──

  /**
   * The way into the excluded-folder tree.
   *
   * One row, like Obsidian Sync's own "Excluded folders → Manage": the tree is a dialog
   * (`ExcludedFoldersModal`), so a vault with a hundred folders does not turn this page
   * into a hundred rows. The selection is written once, when the dialog's 完成 is
   * pressed, because every scope write restarts the sync host.
   */
  private renderExcludedFoldersSection(containerEl: HTMLElement): void {
    this.renderSection(
      containerEl,
      t("settings.section.excludedFolders"),
      t("settings.section.excludedFolders.tooltip"),
    );

    const count = this.plugin.settings.excludedFolders.length;
    new Setting(containerEl)
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

  // ── Obsidian settings sync ──

  /**
   * One switch per config-folder group.
   *
   * The groups mirror Obsidian's own "vault configuration sync" categories, so a
   * user can keep appearance on one device and hotkeys on another instead of
   * choosing all settings or none. All of them are device-local and default off:
   * turning one on changes what the *other* devices' Obsidian looks like, which is
   * not a decision to make for the user. Any change restarts the host, because the
   * engine and the vault adapter read the scope when they are built.
   */
  private renderSettingsSyncSection(containerEl: HTMLElement): void {
    this.renderSection(
      containerEl,
      t("settings.section.settingsSync"),
      t("settings.section.settingsSync.tooltip"),
    );

    for (const group of SETTINGS_GROUPS) {
      new Setting(containerEl)
        .setName(t(SETTINGS_GROUP_LABEL_KEYS[group]))
        .setDesc(describeSettingsGroup(group))
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.settingsGroups[group]).onChange(async (value) => {
            await this.plugin.setSettingsGroupEnabled(group, value);
          }),
        );
    }
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

  // ── Helpers ──

  /** Drop the per-step state when the flow moves on (bind, unbind, log out). */
  private resetStages(): void {
    this.stageError = null;
    this.showLogin = false;
  }
}
