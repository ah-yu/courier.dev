import { Modal, Setting, setIcon, type App } from "obsidian";
import { MAX_DEVICE_NAME_LENGTH, normalizeDeviceName } from "@courier/shared";
import { t, plural } from "../../i18n";
import { describeActionError, type ActionOutcome } from "../../shared/action-error";
import { keyboardInset, revealScrollDelta } from "../../shared/visual-viewport";
import { ExcludedFoldersModal } from "./excluded-folders-modal";

/** What the setup dialog sends to the picker when Start syncing is pressed. */
export interface SetupConnectionValues {
  password: string;
  remember: boolean;
  deviceName: string;
  excludedFolders: string[];
}

export interface SetupConnectionOptions {
  /** The remote vault this connection is for — shown in the lead card. */
  vaultName: string;
  /** Where the device-name field starts (the current label for a new vault). */
  deviceName: string;
  /** Where the folder selection starts (empty for a new vault). */
  excludedFolders: readonly string[];
  /**
   * True when this vault already has a record. The same form then opens as a
   * confirmation of the saved values instead of a first-time setup.
   */
  configured: boolean;
  /**
   * Perform the connection. The dialog stays open on failure so the password,
   * device name and folder selection survive a retry.
   */
  onSubmit(values: SetupConnectionValues): Promise<ActionOutcome>;
  /** Run after a successful connection; the picker closes itself here. */
  onConnected(): void;
}

/**
 * The connect dialog for a remote vault: first-time setup, or — when the vault already
 * has a record — a confirmation of the values saved for it.
 *
 * It is deliberately not a `PromiseModal`: it owns the connect action, so a wrong
 * password or a transport failure keeps everything the user typed on screen and shows the
 * error in place. A `PromiseModal` would close first and turn a typo into a reset.
 *
 * The two configuration fields are per remote vault (see `shared/settings.ts`): the label
 * only appears in *this* vault's history, and the excluded folders are vault-relative.
 * The folder tree itself stays in `ExcludedFoldersModal`; this dialog only edits a draft.
 */
export class SetupConnectionModal extends Modal {
  private readonly options: SetupConnectionOptions;
  private password = "";
  private remember = true;
  private deviceName: string;
  private excludedFolders: string[];
  private error: string | null = null;
  /** A refusal of the password, drawn under its own input instead of in {@link errorEl}. */
  private passwordError: string | null = null;
  private submitting = false;

  private summaryEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private errorEl!: HTMLElement;
  private passwordErrorEl!: HTMLElement;
  private passwordRowEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private startButton!: HTMLButtonElement;
  private cancelButton!: HTMLButtonElement;
  private manageButton!: HTMLButtonElement;
  private passwordInput!: HTMLInputElement;
  /** Stops the visual-viewport listeners, or null on a window without one. */
  private stopViewportWatch: (() => void) | null = null;
  private revealTimer: number | null = null;

  constructor(app: App, options: SetupConnectionOptions) {
    super(app);
    this.options = options;
    this.deviceName = options.deviceName;
    this.excludedFolders = [...options.excludedFolders];
  }

  override onOpen(): void {
    this.setTitle(t("dialog.setup.title"));
    this.modalEl.addClass("courier-setup-connection-modal");
    this.contentEl.empty();
    this.contentEl.addClass("courier-setup-connection");

    // The body is the scrolling region; the footer inside it is sticky, so Start syncing
    // stays visible without the user discovering a scrollbar.
    this.bodyEl = this.contentEl.createDiv({ cls: "courier-setup-body" });
    const body = this.bodyEl;
    this.renderLead(body);
    const form = body.createDiv({ cls: "courier-setup-form" });
    this.renderConnectionSection(form);
    this.renderDeviceSection(form);
    this.renderFoldersSection(form);

    this.errorEl = body.createDiv({ cls: "courier-setup-error" });
    this.errorEl.setAttribute("role", "alert");
    this.renderError();
    this.renderFooter(body);
    this.watchKeyboard();
  }

  override onClose(): void {
    this.stopViewportWatch?.();
    this.stopViewportWatch = null;
    this.revealTimer = null;
    this.contentEl.empty();
  }

  // ── Layout ──

  /** The vault this dialog is about, with a quiet cloud mark instead of a paragraph. */
  private renderLead(parent: HTMLElement): void {
    const lead = parent.createDiv({ cls: "courier-setup-lead" });
    const icon = lead.createDiv({ cls: "courier-setup-lead-icon" });
    setIcon(icon, "cloud");
    const text = lead.createDiv({ cls: "courier-setup-lead-text" });
    text.createDiv({ cls: "courier-setup-lead-title", text: t("dialog.setup.leadTitle") });
    const vault = text.createDiv({ cls: "courier-setup-lead-vault" });
    const vaultIcon = vault.createSpan({ cls: "courier-setup-lead-vault-icon" });
    setIcon(vaultIcon, "vault");
    vault.createSpan({ text: this.options.vaultName });
    text.createDiv({
      cls: "courier-setup-lead-subtitle",
      text: this.options.configured
        ? t("dialog.setup.subtitleConfigured")
        : t("dialog.setup.subtitleNew"),
    });
  }

  /** Password and the remember toggle — the only fields that are not vault settings. */
  private renderConnectionSection(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "courier-setup-card" });

    const passwordRow = new Setting(card)
      .setName(t("dialog.setup.password"))
      .setDesc(t("dialog.setup.passwordDesc"))
      .addText((text) => {
        text.setPlaceholder(t("dialog.setup.passwordPlaceholder"));
        text.inputEl.type = "password";
        text.onChange((value) => {
          this.password = value;
          // The sentence describes the value that was refused; once the user edits the
          // field it no longer does, so it goes as soon as they type.
          this.clearPasswordError();
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") void this.start();
        });
        this.attachRevealOnFocus(text.inputEl);
        this.passwordInput = text.inputEl;
      });
    this.asField(passwordRow);

    // The password's own error slot, inside its row and directly under the input. The
    // form-level slot before the footer is the wrong place for a refusal: on a phone this
    // form is taller than the sheet, so that slot is below the fold and the sticky footer
    // covers it exactly when it appears.
    this.passwordRowEl = passwordRow.settingEl;
    this.passwordErrorEl = passwordRow.settingEl.createDiv({
      cls: "courier-setup-field-error",
    });
    this.passwordErrorEl.setAttribute("role", "alert");
    this.renderPasswordError();

    const rememberRow = new Setting(card)
      .setName(t("dialog.setup.remember"))
      .setDesc(t("dialog.setup.rememberDesc"))
      .addToggle((toggle) => {
        toggle.setValue(this.remember).onChange((value) => {
          this.remember = value;
        });
      });
    rememberRow.settingEl.addClass("courier-setup-toggle");
  }

  /** The label this device states in *this* vault's history. */
  private renderDeviceSection(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "courier-setup-card" });

    const deviceRow = new Setting(card)
      .setName(t("dialog.setup.device"))
      .setDesc(t("dialog.setup.deviceDesc"))
      .addText((text) => {
        text.inputEl.maxLength = MAX_DEVICE_NAME_LENGTH;
        text.setPlaceholder(t("dialog.setup.devicePlaceholder")).setValue(this.deviceName);
        text.onChange((value) => {
          this.deviceName = value;
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") void this.start();
        });
        this.attachRevealOnFocus(text.inputEl);
      });
    this.asField(deviceRow);
  }

  /** A compact summary of the folder draft, with the tree one button away. */
  private renderFoldersSection(parent: HTMLElement): void {
    const card = parent.createDiv({ cls: "courier-setup-folders" });
    const header = card.createDiv({ cls: "courier-setup-folders-header" });
    const icon = header.createDiv({ cls: "courier-setup-folders-icon" });
    setIcon(icon, "folder-minus");

    const info = header.createDiv({ cls: "courier-setup-folders-info" });
    info.createDiv({ cls: "courier-setup-folders-title", text: t("dialog.setup.folders") });
    this.summaryEl = info.createDiv({ cls: "courier-setup-folders-summary" });

    this.manageButton = header.createEl("button", {
      cls: "courier-setup-manage",
      text: t("dialog.setup.manage"),
    });
    this.manageButton.addEventListener("click", () => this.manageFolders());

    this.chipsEl = card.createDiv({ cls: "courier-setup-chips" });
    this.renderFolderDraft();
  }

  private renderFooter(parent: HTMLElement): void {
    const footer = parent.createDiv({ cls: "courier-setup-footer" });
    const hint = footer.createDiv({ cls: "courier-setup-footer-hint" });
    const lock = hint.createSpan({ cls: "courier-setup-footer-icon" });
    setIcon(lock, "lock");
    hint.createSpan({ text: t("dialog.setup.footerHint") });

    const actions = footer.createDiv({ cls: "courier-setup-actions" });
    this.cancelButton = actions.createEl("button", {
      cls: "courier-setup-cancel",
      text: t("dialog.setup.cancel"),
    });
    this.cancelButton.addEventListener("click", () => this.close());

    this.startButton = actions.createEl("button", {
      cls: "mod-cta courier-setup-start",
      text: t("dialog.setup.start"),
    });
    this.startButton.addEventListener("click", () => void this.start());
  }

  /**
   * Stack a setting row's label above a full-width control.
   *
   * Obsidian's rows put the label left and the control right, which is right for a switch
   * and wrong for a form; the dialog is a form.
   */
  private asField(row: Setting): void {
    row.settingEl.addClass("courier-setup-field");
  }

  // ── Keyboard ──

  /**
   * Keep the sheet above the on-screen keyboard and the focused field inside it.
   *
   * A phone's WebView reports the keyboard as a shrunken **visual** viewport while
   * `innerHeight` and `100vh` keep the layout viewport: `styles.css` anchors the sheet to
   * the bottom and lifts it by `--courier-keyboard-height` (and Obsidian's own
   * `--keyboard-height`, whichever is larger). The inset is written here rather than in CSS
   * because only a runtime can compare the two viewports; a desktop window and a phone
   * without a keyboard both leave it at zero.
   *
   * Lifting the sheet is not enough on its own: the field the user tapped can still end up
   * under the keyboard when the form was taller than the remaining space, so every resize
   * also scrolls the body to reveal it. The method is a no-op when no visual viewport
   * exists (the L2 stub's window), which keeps the dialog's structure tests independent of
   * a browser layout engine.
   */
  private watchKeyboard(): void {
    const win = typeof window === "undefined" ? null : window;
    const viewport = win?.visualViewport;
    if (!win || !viewport) return;

    const update = (): void => {
      const inset = keyboardInset(win.innerHeight, viewport.height, viewport.offsetTop);
      this.modalEl.style.setProperty("--courier-keyboard-height", `${inset}px`);
      this.scheduleReveal(win);
    };
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    win.addEventListener("orientationchange", update);

    this.stopViewportWatch = () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      win.removeEventListener("orientationchange", update);
      if (this.revealTimer !== null) win.clearTimeout(this.revealTimer);
    };
    update();
  }

  /** Reveal the tapped field once the keyboard has finished its opening animation. */
  private attachRevealOnFocus(input: HTMLInputElement): void {
    input.addEventListener("focus", () => {
      const win = typeof window === "undefined" ? null : window;
      if (win?.visualViewport) this.scheduleReveal(win);
    });
  }

  private scheduleReveal(win: Window): void {
    if (this.revealTimer !== null) win.clearTimeout(this.revealTimer);
    this.revealTimer = win.setTimeout(() => {
      this.revealTimer = null;
      this.revealFocusedField();
    }, 120);
  }

  private revealFocusedField(): void {
    const field = this.bodyEl.ownerDocument.activeElement as HTMLElement | null;
    if (!field || typeof field.getBoundingClientRect !== "function") return;
    if (field.tagName !== "INPUT" && field.tagName !== "TEXTAREA") return;
    if (!this.bodyEl.contains(field)) return;

    // Reveal the whole row, not just the control: its label and explanation are what tell
    // the user which field the keyboard is typing into, and a row that is only half on
    // screen reads as a clipped form. The sticky footer is part of the body, so the row's
    // visible band ends at the footer's top edge, not at the body's.
    const row = field.closest<HTMLElement>(".setting-item") ?? field;
    this.revealElement(row);
  }

  /**
   * Scroll the body so `element` clears the sticky footer.
   *
   * The footer overlays the scrolling body, so the band a field may occupy ends at the
   * footer's top edge rather than at the body's bottom. Without this an error that appears
   * below the fold stays under the footer — the red sliver this dialog used to show — even
   * though its element is in the document.
   */
  private revealElement(element: HTMLElement): void {
    const bodyRect = this.bodyEl.getBoundingClientRect();
    // An open dialog has a laid-out body. A window without layout (the L2 stub) reports
    // a zero box, and there is no scroll band to compute.
    if (bodyRect.height <= 0) return;
    const footer = this.bodyEl.querySelector<HTMLElement>(".courier-setup-footer");
    const footerTop = footer ? footer.getBoundingClientRect().top : bodyRect.bottom;
    const visibleBody = {
      top: bodyRect.top,
      bottom: Math.min(bodyRect.bottom, footerTop),
    };
    const delta = revealScrollDelta(visibleBody, element.getBoundingClientRect(), 14);
    if (delta !== 0) this.bodyEl.scrollTop += delta;
  }

  // ── Folder draft ──

  private manageFolders(): void {
    if (this.submitting) return;
    new ExcludedFoldersModal(this.app, {
      excludedFolders: this.excludedFolders,
      apply: async (folders) => {
        this.excludedFolders = folders;
        this.renderFolderDraft();
      },
    }).open();
  }

  /** Redraw the summary and the chips from the current draft. */
  private renderFolderDraft(): void {
    const count = this.excludedFolders.length;
    this.summaryEl.setText(
      count === 0
        ? t("dialog.setup.foldersNone")
        : plural("dialog.setup.foldersCount.one", "dialog.setup.foldersCount.other", count),
    );

    this.chipsEl.empty();
    if (count === 0) {
      // Do not leave an empty row behind: the card's gap would still add height.
      this.chipsEl.setCssStyles({ display: "none" });
      return;
    }
    this.chipsEl.setCssStyles({ display: "" });

    const shown = this.excludedFolders.slice(0, 3);
    for (const folder of shown) {
      const chip = this.chipsEl.createDiv({ cls: "courier-setup-chip" });
      const chipIcon = chip.createSpan({ cls: "courier-setup-chip-icon" });
      setIcon(chipIcon, "folder");
      chip.createSpan({ text: folder });
    }
    if (count > shown.length) {
      this.chipsEl.createDiv({
        cls: "courier-setup-chip is-more",
        text: `+${count - shown.length}`,
      });
    }
  }

  // ── Connect ──

  private renderError(): void {
    // Show first, then write: a live region that is `display: none` while its text changes
    // is out of the accessibility tree, and its arrival would go unannounced.
    if (this.error === null) {
      this.errorEl.removeClass("is-visible");
      this.errorEl.setText("");
      return;
    }
    this.errorEl.addClass("is-visible");
    this.errorEl.setText(`⚠ ${this.error}`);
  }

  private renderPasswordError(): void {
    if (this.passwordError === null) {
      this.passwordErrorEl.removeClass("is-visible");
      this.passwordErrorEl.setText("");
      return;
    }
    this.passwordErrorEl.addClass("is-visible");
    this.passwordErrorEl.setText(`⚠ ${this.passwordError}`);
  }

  /** Drop a password refusal as soon as the user edits the field it describes. */
  private clearPasswordError(): void {
    if (this.passwordError === null) return;
    this.passwordError = null;
    this.renderPasswordError();
  }

  private clearErrors(): void {
    this.error = null;
    this.passwordError = null;
    this.renderError();
    this.renderPasswordError();
  }

  /** Show a form-level failure and bring it clear of the sticky footer. */
  private showFormError(message: string): void {
    this.passwordError = null;
    this.error = message;
    this.renderPasswordError();
    this.renderError();
    this.revealElement(this.errorEl);
  }

  /**
   * Show a password refusal directly under the password input.
   *
   * This dialog is taller than a phone's sheet, and its form-level slot sits below the fold
   * under the sticky footer — so a wrong password reported there was far away from the field
   * and mostly invisible. The message belongs to the input it is about; revealing the row
   * also brings it back into the scroll band when the user had scrolled to the footer.
   */
  private showPasswordError(message: string): void {
    this.error = null;
    this.passwordError = message;
    this.renderError();
    this.renderPasswordError();
    this.revealElement(this.passwordRowEl);
  }

  private setSubmitting(submitting: boolean): void {
    this.submitting = submitting;
    this.startButton.disabled = submitting;
    this.cancelButton.disabled = submitting;
    this.manageButton.disabled = submitting;
    this.startButton.textContent = submitting
      ? t("dialog.setup.connecting")
      : t("dialog.setup.start");
    if (submitting) this.startButton.addClass("is-loading");
    else this.startButton.removeClass("is-loading");
  }

  private async start(): Promise<void> {
    if (this.submitting) return;
    if (!this.password) {
      this.showPasswordError(t("dialog.setup.passwordRequired"));
      this.passwordInput?.focus?.();
      return;
    }

    this.clearErrors();
    this.setSubmitting(true);

    try {
      // What the check answers about. The user can type a new password while it is in
      // flight, and a refusal of the old one must not be attached to the new value.
      const submittedPassword = this.password;
      const outcome = await this.options.onSubmit({
        password: submittedPassword,
        remember: this.remember,
        deviceName: normalizeDeviceName(this.deviceName),
        excludedFolders: this.excludedFolders,
      });
      if (!outcome.ok) {
        this.setSubmitting(false);
        if (outcome.field === "password") {
          if (this.password !== submittedPassword) return;
          this.showPasswordError(outcome.error);
          this.passwordInput?.focus?.();
        } else {
          this.showFormError(outcome.error);
        }
        return;
      }

      this.close();
      this.options.onConnected();
    } catch (err) {
      // The picker's action path normally returns an outcome; a thrown transport or
      // persistence error still belongs in the dialog, not in an unhandled rejection.
      this.setSubmitting(false);
      this.showFormError(describeActionError(err, t("dialog.setup.connectFailed")));
    }
  }
}
