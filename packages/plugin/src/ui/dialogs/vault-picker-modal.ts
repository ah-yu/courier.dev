import { App, Setting, setIcon } from "obsidian";
import type { ListVaultsResponse } from "@courier/shared";
import { t } from "../../i18n";
import { PromiseModal } from "./promise-modal";
import { PasswordPromptModal } from "./password-prompt-modal";
import { SetupConnectionModal } from "./setup-connection-modal";
import { CreateVaultModal } from "./create-vault-modal";
import { describeActionError, type ActionOutcome } from "../../shared/action-error";
import { createdAgoLabel } from "../../shared/relative-time";
import type { ListVaultsAction } from "../../shared/api";
import type { VaultConnectionSetup } from "../../shared/settings";
import type { VaultCredentialCheck } from "../../shared/vault-credentials";

type VaultSummary = ListVaultsResponse["vaults"][number];

/**
 * What the picker needs from the plugin.
 *
 * Declared here rather than importing the plugin class, so this module stays a leaf
 * (the settings page owns the plugin and passes itself in, which type-checks
 * structurally). Every mutating call answers an `ActionOutcome` — the picker shows
 * the sentence under the list and keeps the dialog open, so nothing the user did is
 * lost to a closed window.
 */
export interface VaultPickerHost {
  actions: { listVaults: ListVaultsAction };
  connectToVault(
    vaultId: string,
    vaultName: string,
    password: string,
    remember?: boolean,
    setup?: VaultConnectionSetup,
  ): Promise<ActionOutcome>;
  /**
   * What the connection dialog starts from for this vault, and whether this device has
   * already completed its setup. A vault configured with **no** excluded folders is still
   * `configured`; the same dialog opens either way, with a different lead line.
   */
  getConnectionSetup(vaultId: string): {
    configured: boolean;
    deviceName: string;
    excludedFolders: string[];
  };
  deleteVault(vaultId: string): Promise<ActionOutcome>;
  /**
   * Check a password against the vault's canary, answering **why** it was refused.
   *
   * A boolean could not tell a wrong password from an unreachable server, so the row
   * said "密码不正确" for both and a toast had to correct it.
   */
  fetchVaultCredentials(vaultId: string, password: string): Promise<VaultCredentialCheck>;
  createVault(name: string, password: string): Promise<ActionOutcome<{ id: string; name: string }>>;
}

/**
 * "Choose a remote vault" — the dialog behind the settings page's vault row.
 *
 * The list is the account's vaults, one row each, with how old each one is, the one
 * thing that can be done to it besides connecting (delete, as an icon) and connecting
 * as the row's action — plus an entry to create a new vault. The
 * page itself stays two rows long no matter how many vaults exist, which is why the
 * management lives here.
 *
 * Resolves `true` when a vault was connected (the caller re-renders: the page moves
 * on to the settings), and `null` when it was dismissed.
 */
export class VaultPickerModal extends PromiseModal<boolean> {
  private readonly host: VaultPickerHost;
  private listEl!: HTMLElement;
  private vaults: VaultSummary[] | null = null;
  private loading = false;
  /** The list could not be read at all — offered a retry. */
  private listError: string | null = null;
  /** The last connect/delete failed — shown above the list, which stays. */
  private actionError: string | null = null;

  constructor(app: App, host: VaultPickerHost) {
    super(app);
    this.host = host;
  }

  override onOpen(): void {
    this.setTitle(t("dialog.vaultPicker.title"));
    this.modalEl.addClass("courier-vault-picker-modal");
    this.contentEl.addClass("courier-vault-picker");
    this.contentEl.createDiv({
      cls: "courier-vault-subtitle",
      text: t("dialog.vaultPicker.subtitle"),
    });

    this.listEl = this.contentEl.createDiv({ cls: "courier-vault-list" });

    // The create entry is the list's "add" row, not a second primary button: the row
    // action is connecting, and two purple buttons on one dialog made neither read as
    // the main one. A dashed row keeps it discoverable without competing for attention.
    const create = new Setting(this.contentEl);
    create.settingEl.addClass("courier-vault-create");
    create.settingEl.setCssStyles({
      display: "block",
      border: "none",
      padding: "0",
      // The list is one block; the create row is its footer and gets a wider gap than
      // the cards have between themselves.
      margin: "18px 0 0",
    });
    create.addButton((button) => {
      button.setButtonText(t("dialog.vaultPicker.create")).onClick(() => void this.create());
      button.buttonEl.addClass("courier-vault-create-button");
      button.buttonEl.setCssStyles({ flex: "0 0 auto" });
      const icon = button.buttonEl.createSpan({ cls: "courier-vault-create-icon" });
      setIcon(icon, "plus");
      // `setButtonText` writes the label as a text node; put the glyph before it. The
      // guard keeps the stub (whose label is a property, not a node) from appending twice.
      if (button.buttonEl.firstChild) {
        button.buttonEl.insertBefore(icon, button.buttonEl.firstChild);
      }
    });
    const createControl = create.settingEl.querySelector<HTMLElement>(".setting-item-control");
    if (createControl) {
      createControl.setCssStyles({ width: "100%", justifyContent: "stretch" });
    }

    void this.load();
  }

  /**
   * One vault card: the cloud tile, its name and age, delete as a quiet icon and
   * connect as the row's action.
   *
   * The row is a `Setting` so its name/description stay the same semantic text the
   * settings page and the e2e harness read; everything visual lives in `styles.css`.
   * The inline layout is the one platform fact: Obsidian's phone layout stacks a
   * settings row and stretches its control, while a picker row has to stay one line.
   */
  private renderVaultRow(vault: VaultSummary): void {
    const row = new Setting(this.listEl)
      .setName(vault.name)
      .setDesc(createdAgoLabel(vault.createdAt));
    row.settingEl.addClass("courier-vault-row");

    const icon = row.settingEl.createDiv({ cls: "courier-vault-icon" });
    // The app's `.setting-item > *:first-child` rule gives the first child an inline-end
    // margin that outranks a class; clear it inline so the row's own gap is the spacing.
    icon.setCssStyles({ marginInlineEnd: "0" });
    setIcon(icon, "cloud");
    const infoEl = row.settingEl.querySelector<HTMLElement>(".setting-item-info");
    if (infoEl) row.settingEl.insertBefore(icon, infoEl);

    row.addExtraButton((button) =>
      button
        .setIcon("trash-2")
        .setTooltip(t("dialog.vaultPicker.deleteTooltip"))
        .onClick(async () => {
          await this.remove(vault);
        }),
    );

    row.addButton((button) => {
      button.setButtonText(t("dialog.vaultPicker.connect")).onClick(() => this.connect(vault));
      button.setCta();
      button.buttonEl.addClass("courier-vault-connect");
      // `width` as well as `flex`: the phone layout gives a row's control the whole row
      // width, which wins over a flex shorthand alone.
      button.buttonEl.setCssStyles({ flex: "0 0 auto", width: "auto" });
    });

    row.settingEl.setCssStyles({
      display: "flex",
      flexDirection: "row",
      flexWrap: "nowrap",
      alignItems: "center",
      gap: "12px",
      margin: "0",
    });
    const info = row.settingEl.querySelector<HTMLElement>(".setting-item-info");
    if (info) {
      info.setCssStyles({
        display: "flex",
        flexDirection: "column",
        gap: "1px",
        flex: "1 1 auto",
        minWidth: "0",
      });
    }
    const control = row.settingEl.querySelector<HTMLElement>(".setting-item-control");
    if (control) {
      control.setCssStyles({
        flex: "0 0 auto",
        width: "auto",
        justifyContent: "flex-end",
        gap: "6px",
      });
    }
  }

  /** Read the vault list and paint it. */
  private async load(): Promise<void> {
    this.loading = true;
    this.listError = null;
    this.paint();
    try {
      const response = await this.host.actions.listVaults();
      this.vaults = response.vaults;
    } catch (err) {
      console.error("Listing remote vaults failed:", err);
      this.listError = describeActionError(err, t("action.loadVaults"));
      this.vaults = null;
    } finally {
      this.loading = false;
      this.paint();
    }
  }

  /** Repaint the list region — the only part of the dialog that changes. */
  private paint(): void {
    this.listEl.empty();

    if (this.actionError) this.renderError(this.actionError);

    if (this.loading) {
      const state = this.listEl.createDiv({ cls: "courier-vault-state" });
      const icon = state.createSpan({ cls: "courier-vault-state-icon" });
      setIcon(icon, "loader");
      state.createSpan({ text: t("dialog.vaultPicker.loading") });
      return;
    }
    if (this.listError) {
      this.renderError(this.listError);
      const retry = new Setting(this.listEl);
      retry.settingEl.addClass("courier-vault-retry");
      retry.settingEl.setCssStyles({ padding: "0", border: "none", margin: "0" });
      retry.addButton((button) =>
        button.setButtonText(t("common.retry")).onClick(() => void this.load()),
      );
      return;
    }

    const vaults = this.vaults ?? [];
    if (vaults.length === 0) {
      const empty = this.listEl.createDiv({ cls: "courier-vault-empty" });
      const icon = empty.createDiv({ cls: "courier-vault-empty-icon" });
      setIcon(icon, "cloud");
      empty.createDiv({
        cls: "courier-vault-empty-title",
        text: t("dialog.vaultPicker.emptyTitle"),
      });
      empty.createDiv({
        cls: "courier-vault-empty-hint",
        text: t("dialog.vaultPicker.emptyHint"),
      });
      return;
    }

    for (const vault of vaults) this.renderVaultRow(vault);
  }

  /** One inline banner for a failed read or a failed action. */
  private renderError(message: string): void {
    const error = this.listEl.createDiv({ cls: "courier-vault-error" });
    const icon = error.createSpan({ cls: "courier-vault-error-icon" });
    setIcon(icon, "alert-triangle");
    error.createSpan({ cls: "courier-vault-error-text", text: message });
  }

  /**
   * Connect one vault.
   *
   * Every connect opens the `Setup connection` dialog. A first connection starts from the
   * current label and no exclusions; a returning vault starts from its saved record, so the
   * same form doubles as the confirmation of those values. The dialog owns the connect
   * action, so a failure keeps everything the user typed.
   */
  private connect(vault: VaultSummary): void {
    const setup = this.host.getConnectionSetup(vault.id);
    this.actionError = null;
    new SetupConnectionModal(this.app, {
      vaultName: vault.name,
      deviceName: setup.deviceName,
      excludedFolders: setup.excludedFolders,
      configured: setup.configured,
      onSubmit: (values) =>
        this.host.connectToVault(vault.id, vault.name, values.password, values.remember, {
          deviceName: values.deviceName,
          excludedFolders: values.excludedFolders,
        }),
      onConnected: () => this.resolve(true),
    }).open();
  }

  /**
   * Create a remote vault. Creating is not connecting: the dialog stays open and
   * re-reads the list, so the new vault appears among the others and the user decides
   * when to connect to it.
   */
  private async create(): Promise<void> {
    const modal = new CreateVaultModal(this.app);
    modal.open();
    const result = await modal.getResult();
    if (!result) return;

    this.actionError = null;
    const outcome = await this.host.createVault(result.name, result.password);
    if (!outcome.ok) {
      this.actionError = outcome.error;
      this.paint();
      return;
    }
    await this.load();
  }

  private async remove(vault: VaultSummary): Promise<void> {
    // Verify the vault password locally before deleting (防误删). No "remember"
    // toggle here: this dialog only confirms the password, it does not unlock.
    const pwModal = new PasswordPromptModal(this.app, {
      askToRemember: false,
      title: t("dialog.vaultPicker.deleteTitle", { vault: vault.name }),
      confirmLabel: t("dialog.vaultPicker.confirmOk"),
    });
    pwModal.open();
    const pw = await pwModal.getResult();
    if (!pw) return;

    const check = await this.host.fetchVaultCredentials(vault.id, pw.password);
    if (check.kind === "error") {
      // Not a wrong password: the check never got an answer, and saying "密码不正确"
      // here would send the user hunting for a typo that is not there.
      this.actionError = describeActionError(check.error, t("action.verifyVaultPassword"));
      this.paint();
      return;
    }
    if (check.kind === "invalid-password") {
      this.actionError = t("dialog.vaultPicker.wrongPassword");
      this.paint();
      return;
    }

    const confirm = await this.confirm(
      t("dialog.vaultPicker.deleteConfirm", { vault: vault.name }),
    );
    if (!confirm) return;

    this.actionError = null;
    const outcome = await this.host.deleteVault(vault.id);
    if (!outcome.ok) {
      this.actionError = outcome.error;
      this.paint();
      return;
    }
    // No confirmation toast: the picker reloads and the deleted row is simply gone.
    await this.load();
  }

  private async confirm(message: string): Promise<boolean> {
    const modal = new ConfirmModal(this.app, message);
    modal.open();
    const result = await modal.getResult();
    return result === true;
  }
}

/** Simple yes/no confirmation modal. */
class ConfirmModal extends PromiseModal<boolean> {
  constructor(
    app: App,
    private message: string,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    this.setTitle(t("dialog.vaultPicker.confirmTitle"));
    contentEl.createEl("p", { text: this.message });
    new Setting(contentEl)
      .addButton((btn) =>
        btn.setButtonText(t("dialog.vaultPicker.confirmCancel")).onClick(() => this.resolve(false)),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("dialog.vaultPicker.confirmOk"))
          .setCta()
          .onClick(() => this.resolve(true)),
      );
  }
}
