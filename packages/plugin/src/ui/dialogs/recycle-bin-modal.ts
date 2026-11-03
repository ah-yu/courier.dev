import { ButtonComponent, ExtraButtonComponent, Modal, Setting, setIcon, type App } from "obsidian";
import type { DeletedFileInfo } from "@courier/shared";
import { sortedCopy } from "@courier/shared";
import { t, plural } from "../../i18n";
import type { CourierUiHost } from "../../shared/ui-host";
import { describeActionError } from "../../shared/action-error";
import { decryptPathOrNull } from "../../shared/encrypted-path";
import { previewIconOf } from "../../shared/file-preview";
import { deletedFileRowState } from "../../shared/recycle-bin-row";
import { runRestoreFlow } from "../../shared/restore-flow";
import { showNotice } from "../../shared/show-notice";
import { deviceLabel, formatHistoryTime } from "../../shared/sync-history";
import { MessageModal } from "../message-modal";
import { FileContentModal } from "./file-content-modal";
import { PromiseModal } from "./promise-modal";
import { readVersionContent } from "../../shared/version-content";

/** One deleted chain and the plaintext path its row shows (`null` when it will not decrypt). */
interface RecycleBinRow {
  file: DeletedFileInfo;
  plainPath: string | null;
}

/**
 * The recycle bin, as a dialog the settings page opens.
 *
 * It lists deleted files read-only from the server (`/sync/deleted`), decrypting
 * their paths with the vault key. Any row opens the content of the version the delete
 * removed, and "恢复" delegates to the engine's `restoreFile` so the file is written
 * locally and re-pushed as `action:"restore"`.
 *
 * A restore brings the file back at the path it was deleted from, and that path may
 * have been taken since. The engine refuses to overwrite it, so the click asks for
 * another file name (see `shared/restore-flow.ts`, which the version-history modal
 * shares). The row deliberately does **not** predict that: a warning under every row
 * that might collide was noise next to the dialog that already answers the question.
 *
 * A chain can also end up with nothing restorable at all: retention pruning removes
 * every version but the chain's latest one, which for a deleted file is the tombstone
 * itself. Those rows say so, are not clickable, and offer no restore — the one case
 * that still needs an explanation before the click.
 *
 * The rules behind a row's warning line, its click and its disabled button are
 * `shared/recycle-bin-row.ts`; this dialog only renders them.
 *
 * A re-read **repaints in place**. Only the first read puts the list through its skeleton;
 * a refresh (or the read after a restore or a clear) keeps the rows on screen until the
 * new list is in hand and then replaces them in one synchronous paint. Blanking the list
 * for a refresh is what made the dialog flash — on the desktop and on a phone alike — and
 * the spinner on the header's control is what says a silent read is running.
 */
export class RecycleBinModal extends Modal {
  private files: DeletedFileInfo[] = [];
  /** A deleted chain with its decrypted path, worked out before anything is painted. */
  private rows: RecycleBinRow[] = [];
  /** A read is in flight; only the first one is painted as a skeleton (see {@link paint}). */
  private loading = false;
  /**
   * Whether a read has already painted its result. From then on a re-read repaints in
   * place instead of going back through the loading state.
   */
  private painted = false;
  private error: string | null = null;
  /** Number of the newest read, so a slow answer cannot repaint a newer one. */
  private loadGeneration = 0;
  private headingEl!: HTMLElement;
  private listEl!: HTMLElement;
  /**
   * The line for a write the dialog performed (clearing the bin), as opposed to
   * {@link error}, which is a failed read. Kept in the dialog: the user is still looking
   * at the list the write was about, and a toast would be the only explanation.
   */
  private actionErrorEl!: HTMLElement;
  private footerEl!: HTMLElement;

  constructor(
    app: App,
    private readonly host: CourierUiHost,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t("dialog.recycleBin.title"));
    this.modalEl.addClass("courier-recycle-bin-modal");
    this.contentEl.addClass("courier-recycle-bin");
    // A modal instance can be reopened: the read of the previous open is discarded and the
    // dialog starts from the skeleton again.
    this.files = [];
    this.rows = [];
    this.loading = false;
    this.painted = false;
    this.error = null;
    this.loadGeneration += 1;

    const header = this.contentEl.createDiv({ cls: "courier-recycle-bin-header" });
    this.headingEl = header.createDiv({ cls: "courier-recycle-bin-heading" });

    // An extra button, not a raw `<button class="clickable-icon">`: a real button keeps
    // Obsidian's button chrome (border, surface, shadow), which draws a boxed control
    // around an icon that is meant to read as a quiet toolbar action.
    new ExtraButtonComponent(header)
      .setIcon("refresh-cw")
      .setTooltip(t("dialog.recycleBin.refresh"))
      .onClick(() => {
        void this.load();
      });

    this.listEl = this.contentEl.createDiv({ cls: "courier-recycle-bin-list" });

    // Between the list and the footer, so a failed write is explained where the button
    // that failed is, instead of in a toast that outlives the dialog.
    this.actionErrorEl = this.contentEl.createDiv({ cls: "courier-setup-error" });

    this.footerEl = this.contentEl.createDiv({ cls: "courier-recycle-bin-footer" });
    this.footerEl.createSpan({
      cls: "courier-recycle-bin-footer-hint",
      text: t("dialog.recycleBin.footerHint"),
    });
    const clearButton = new ButtonComponent(this.footerEl)
      .setButtonText(t("dialog.recycleBin.clear"))
      .setDestructive()
      .onClick(() => {
        void this.clear();
      });
    clearButton.buttonEl.addClass("courier-recycle-bin-clear");

    void this.load();
  }

  override onClose(): void {
    // Whatever read is still in flight belongs to a dialog nobody is looking at any more.
    this.loadGeneration += 1;
    this.contentEl.removeClass("is-refreshing");
    this.contentEl.empty();
  }

  private vaultId(): string | null {
    return this.host.settings.connectedVaultId;
  }

  /**
   * Read the recycle bin and repaint — on open, on refresh, and after every write.
   *
   * The server's chain order is not the order a person expects in a recycle bin, so the
   * list is sorted newest deletion first here rather than relying on the query.
   *
   * The paths are decrypted and the order is settled **before** the paint, so a re-read is
   * one synchronous replacement of the rows rather than a list that empties and refills
   * row by row. A read that a newer one replaced drops its answer instead of painting it.
   */
  private async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    const vaultId = this.vaultId();
    // The first read has nothing to keep, so it is the one that shows the skeleton.
    const silent = this.painted;

    this.loading = true;
    this.setRefreshing(true);
    if (!silent) this.paint();

    let files: DeletedFileInfo[] = [];
    let error: string | null = null;
    if (vaultId) {
      try {
        const response = await this.host.actions.listDeleted(vaultId);
        files = sortedCopy(response.files, (a, b) => {
          if (a.deletedAt === b.deletedAt) return 0;
          return a.deletedAt < b.deletedAt ? 1 : -1;
        });
      } catch (err) {
        console.error("Loading the recycle bin failed:", err);
        files = [];
        error = describeActionError(err, t("action.loadRecycleBin"));
      }
    }

    const key = this.host.encryptionKey;
    const rows: RecycleBinRow[] = [];
    for (const file of files) {
      rows.push({
        file,
        plainPath: file.lastEncryptedPath
          ? await decryptPathOrNull(key, file.lastEncryptedPath)
          : null,
      });
    }
    if (generation !== this.loadGeneration) return;

    this.files = files;
    this.rows = rows;
    this.error = error;
    this.loading = false;
    this.painted = true;
    this.setRefreshing(false);
    this.paint();
  }

  /**
   * Mark the header while a read is in flight. A silent re-read keeps the rows on screen,
   * so the control that started it is the only thing that can say the read is running.
   */
  private setRefreshing(refreshing: boolean): void {
    if (refreshing) this.contentEl.addClass("is-refreshing");
    else this.contentEl.removeClass("is-refreshing");
  }

  /** The count (or the state, when there is no count yet) over the list. */
  private renderHeading(): void {
    this.headingEl.empty();

    if (!this.vaultId()) {
      this.headingEl.createSpan({
        cls: "courier-recycle-bin-status",
        text: t("dialog.recycleBin.disconnected"),
      });
      return;
    }
    // Only the first read has no count to show yet; a re-read keeps the one on screen.
    if (this.loading && !this.painted) {
      this.headingEl.createSpan({
        cls: "courier-recycle-bin-status",
        text: t("dialog.recycleBin.loading"),
      });
      return;
    }
    if (this.error) {
      this.headingEl.createSpan({
        cls: "courier-recycle-bin-status",
        text: t("dialog.recycleBin.loadFailed"),
      });
      return;
    }

    this.headingEl.createSpan({
      cls: "courier-recycle-bin-count",
      text: String(this.files.length),
    });
    this.headingEl.createSpan({
      cls: "courier-recycle-bin-count-label",
      text: plural(
        "dialog.recycleBin.countLabel.one",
        "dialog.recycleBin.countLabel.other",
        this.files.length,
      ),
    });
  }

  /**
   * Paint the header, the list and the footer — the only parts that change.
   *
   * Synchronous on purpose: every `await` in here used to split the paint, so a refresh
   * emptied the list and then filled it row by row while the browser was free to draw the
   * gap. The rows are already decrypted (see {@link load}), so this cannot yield.
   */
  private paint(): void {
    // A re-read replaces the rows in place, so it must not scroll the reader back to the top.
    const scrollTop = this.painted ? this.listEl.scrollTop : 0;
    this.renderHeading();
    this.listEl.empty();

    const hasRows =
      this.painted && this.error === null && this.vaultId() !== null && this.files.length > 0;
    this.footerEl.setCssStyles({ display: hasRows ? "flex" : "none" });

    if (this.loading) {
      this.renderSkeleton();
      return;
    }
    if (!this.vaultId()) {
      this.renderPlaceholder({
        icon: "unplug",
        description: t("dialog.recycleBin.connectHint"),
      });
      return;
    }
    if (this.error) {
      this.renderPlaceholder({
        icon: "alert-circle",
        description: this.error,
        isError: true,
      });
      return;
    }
    if (this.rows.length === 0) {
      this.renderPlaceholder({
        icon: "trash-2",
        title: t("dialog.recycleBin.emptyTitle"),
        description: t("dialog.recycleBin.emptyDesc"),
      });
      return;
    }

    for (const row of this.rows) this.renderRow(row.file, row.plainPath);
    this.listEl.scrollTop = scrollTop;
  }

  /** A list-shaped placeholder while the first read is in flight. */
  private renderSkeleton(): void {
    for (let index = 0; index < 3; index += 1) {
      const card = this.listEl.createDiv({ cls: "courier-recycle-bin-skeleton" });
      card.createDiv({ cls: "courier-recycle-bin-skeleton-icon" });
      const lines = card.createDiv({ cls: "courier-recycle-bin-skeleton-lines" });
      lines.createDiv({ cls: "courier-recycle-bin-skeleton-line is-title" });
      lines.createDiv({ cls: "courier-recycle-bin-skeleton-line is-meta" });
    }
  }

  /** The empty, disconnected and error states: one icon, one explanation. */
  private renderPlaceholder(options: {
    icon: string;
    title?: string;
    description: string;
    isError?: boolean;
  }): void {
    const box = this.listEl.createDiv({
      cls: `courier-recycle-bin-placeholder${options.isError ? " is-error" : ""}`,
    });
    const icon = box.createDiv({ cls: "courier-recycle-bin-placeholder-icon" });
    setIcon(icon, options.icon);
    if (options.title) {
      box.createDiv({ cls: "courier-recycle-bin-placeholder-title", text: options.title });
    }
    box.createDiv({ cls: "courier-recycle-bin-placeholder-desc", text: options.description });
  }

  private renderRow(file: DeletedFileInfo, plainPath: string | null): void {
    // The two facts are kept apart on purpose: a chain whose path will not decrypt is
    // not a chain retention pruning emptied, and saying so is the whole point of the row.
    const state = deletedFileRowState({
      restorable: Boolean(file.previousContentHash),
      pathKnown: plainPath !== null,
    });

    const row = this.listEl.createDiv({ cls: "courier-deleted-file-item" });
    if (!state.canRestore) row.addClass("is-unavailable");

    const rowIcon = row.createDiv({ cls: "courier-deleted-icon" });
    setIcon(rowIcon, previewIconOf(plainPath));

    const info = row.createDiv({ cls: "courier-deleted-info" });
    // One expression for both the affordance and the handler, so a row cannot look
    // clickable and do nothing.
    if (state.canPreview) {
      info.addClass("is-clickable");
      info.setAttribute("role", "button");
      info.setAttribute("tabindex", "0");
      info.setAttribute("title", t("dialog.recycleBin.viewContent"));
      info.addEventListener("click", () => {
        void this.viewContent(file, plainPath);
      });
      info.addEventListener("keydown", (event) => {
        const keyboard = event;
        if (keyboard.key !== "Enter" && keyboard.key !== " ") return;
        keyboard.preventDefault();
        void this.viewContent(file, plainPath);
      });
    }

    info.createDiv({
      text: plainPath ?? t("dialog.recycleBin.unknownPath", { id: file.fileId.substring(0, 12) }),
      cls: "courier-deleted-path",
    });
    info.createDiv({
      text: t("dialog.recycleBin.meta", {
        time: formatHistoryTime(file.deletedAt),
        device: deviceLabel(file.deletedByDeviceName),
      }),
      cls: "courier-deleted-meta",
    });
    if (state.warning) {
      info.createDiv({ text: state.warning, cls: "courier-deleted-warning" });
    }

    const actions = row.createDiv({ cls: "courier-deleted-actions" });
    const restoreButton = new ButtonComponent(actions)
      .setButtonText(t("dialog.recycleBin.restore"))
      .onClick(() => {
        void this.restore(file, plainPath);
      });
    restoreButton.buttonEl.addClass("courier-deleted-restore");
    if (!state.canRestore) restoreButton.setDisabled(true);
  }

  /**
   * Show the version the delete removed, decrypted, in the shared content dialog.
   *
   * The row only offers the click when the path decrypted (`canPreview`), so the guard
   * below is for the type system and for a caller that got here another way.
   */
  private async viewContent(file: DeletedFileInfo, plainPath: string | null): Promise<void> {
    const vaultId = this.vaultId();
    const key = this.host.encryptionKey;
    if (
      !vaultId ||
      !key ||
      !file.previousContentHash ||
      file.previousSizeBytes === null ||
      !plainPath
    ) {
      return;
    }

    try {
      // The deleted row carries the restorable version's size, which is what tells a
      // whole-file payload from a chunked one.
      const decrypted = await readVersionContent(
        this.host.actions,
        vaultId,
        file.previousContentHash,
        file.previousSizeBytes,
        key,
      );
      new FileContentModal(this.app, {
        // The path is the subject, not the title: a modal title is one ellipsised line.
        title: t("dialog.recycleBin.contentTitle"),
        subject: plainPath,
        facts: [
          t("dialog.recycleBin.deletedAt", { time: formatHistoryTime(file.deletedAt) }),
          t("dialog.recycleBin.byDevice", {
            device: deviceLabel(file.deletedByDeviceName),
          }),
        ],
        path: plainPath,
        bytes: decrypted,
      }).open();
    } catch (err) {
      console.error("Loading the deleted version's content failed:", err);
      new MessageModal(this.app, t("dialog.recycleBin.contentError")).open();
    }
  }

  private async restore(file: DeletedFileInfo, plainPath: string | null): Promise<void> {
    const engine = this.host.engine;
    const key = this.host.encryptionKey;
    if (!engine || !key) {
      // A paused vault is still connected — it just has no engine to write and push the
      // restored version — so "not connected" would name the wrong state.
      showNotice(
        this.host.settings.syncPaused ? t("notice.needsResume") : t("notice.notConnected"),
      );
      return;
    }
    // The row only offers 恢复 when both of these are present (`deletedFileRowState`
    // disables the button otherwise), so this is a defensive branch, not a message.
    const contentHash = file.previousContentHash;
    if (contentHash === null) {
      console.error("Courier: restore requested for a chain with no restorable version.");
      return;
    }
    const targetPath = plainPath;
    if (targetPath === null) {
      console.error("Courier: restore requested for a chain whose path did not decrypt.");
      return;
    }

    await runRestoreFlow({
      app: this.app,
      engine,
      fileId: file.fileId,
      sourcePath: targetPath,
      contentHash,
      // A restore writes a file that is not there, so there is nothing to confirm;
      // an occupied path is answered by the name dialog itself.
      onRestored: () => {
        void this.load();
      },
    });
  }

  /** Permanently drop every deleted chain — the server's `/sync/deleted/clear`. */
  private async clear(): Promise<void> {
    const vaultId = this.vaultId();
    if (!vaultId) {
      // Unreachable: the footer (and therefore this button) is hidden without a vault.
      console.error("Courier: clear requested with no remote vault bound.");
      return;
    }

    const confirm = new ClearRecycleBinConfirmModal(this.app, this.files.length);
    confirm.open();
    if ((await confirm.getResult()) !== true) return;

    this.setActionError(null);
    try {
      await this.host.actions.clearDeleted(vaultId);
      await this.load();
    } catch (err) {
      this.setActionError(
        t("dialog.recycleBin.clearFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /** Show, replace or clear the line under the list (null = nothing to say). */
  private setActionError(message: string | null): void {
    this.actionErrorEl.setText(message ?? "");
    if (message === null) this.actionErrorEl.removeClass("is-visible");
    else this.actionErrorEl.addClass("is-visible");
  }
}

/** Confirmation for the one irreversible action in this dialog. */
export class ClearRecycleBinConfirmModal extends PromiseModal<boolean> {
  constructor(
    app: App,
    private readonly fileCount: number,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t("dialog.recycleBin.clearConfirmTitle"));
    this.contentEl.createEl("p", {
      text: plural(
        "dialog.recycleBin.clearConfirmText.one",
        "dialog.recycleBin.clearConfirmText.other",
        this.fileCount,
      ),
    });
    this.contentEl.createEl("p", { text: t("dialog.recycleBin.irreversible") });

    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText(t("common.cancel")).onClick(() => this.cancel()))
      .addButton((button) =>
        button
          .setButtonText(t("dialog.recycleBin.deletePermanently"))
          .setDestructive()
          .onClick(() => this.resolve(true)),
      );
  }
}
