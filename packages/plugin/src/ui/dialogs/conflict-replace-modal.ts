import { App, ButtonComponent, TFile, ToggleComponent, type TAbstractFile } from "obsidian";
import { t } from "../../i18n";
import { PromiseModal } from "./promise-modal";
import { ensureParentFolder } from "../../unified/adapter";
import { showNotice } from "../../shared/show-notice";
import {
  replaceConfirmButton,
  replaceConfirmText,
  replaceConfirmTitle,
  replaceDeleteCopyLabel,
  replaceNoticeText,
  replaceShapeOf,
  type ReplaceOutcome,
  type ReplaceShape,
  type ReplaceTarget,
} from "../../shared/conflict-replace";

/**
 * The one "用冲突副本替换当前文件" interaction.
 *
 * The write is deliberately a plain Obsidian vault write, not an engine call: it is a
 * user edit, and the vault event it fires is the same one a typed edit fires, which is
 * how the engine learns about it and pushes it under its own rules (a tracked path
 * becomes a `modify`, a path whose chain is a peer's tombstone becomes a new file). See
 * `shared/conflict-replace.ts` for why that is the right door.
 *
 * The dialog asks one question and offers one choice: the sentence says which file the
 * copy's content is about to become, and the toggle says whether the parked copy should
 * be deleted with it (off by default — it is the only local record of the losing version).
 */

/** What a replace did: the outcome, and whether the parked copy survived it. */
export interface ReplaceResult {
  outcome: ReplaceOutcome;
  copyDeleted: boolean;
}

/**
 * Write the parked copy's bytes over the original path, creating it when it is gone.
 *
 * Reads **before** it writes, so a copy that cannot be read changes nothing; a path
 * occupied by a folder is refused rather than replaced.
 */
export async function replaceWithConflictCopy(
  app: App,
  target: ReplaceTarget,
): Promise<ReplaceOutcome> {
  const copy = app.vault.getAbstractFileByPath(target.conflictPath);
  if (!(copy instanceof TFile)) return "failed";

  let bytes: ArrayBuffer;
  try {
    bytes = await app.vault.readBinary(copy);
  } catch {
    return "failed";
  }

  const existing: TAbstractFile | null = app.vault.getAbstractFileByPath(target.originalPath);
  if (existing !== null && !(existing instanceof TFile)) return "failed";

  try {
    if (existing instanceof TFile) {
      await app.vault.modifyBinary(existing, bytes);
      return "replaced";
    }
    await ensureParentFolder(app.vault, target.originalPath);
    await app.vault.createBinary(target.originalPath, bytes);
    return "created";
  } catch {
    return "failed";
  }
}

/**
 * Discard the parked copy — only ever after a write that landed.
 *
 * It goes to the trash the user configured (`FileManager.trashFile`), the same way a note the
 * engine removes does: "the copy is gone from the folder" is the promise, and a user who
 * asked for deleted files to be kept should get the parked content back if they want it.
 *
 * Best-effort by design: the replaced content is at the original path by then, so a copy that
 * refuses to disappear is a leftover, not a failure of the replace.
 */
export async function deleteConflictCopy(app: App, target: ReplaceTarget): Promise<boolean> {
  const copy = app.vault.getAbstractFileByPath(target.conflictPath);
  if (!(copy instanceof TFile)) return false;
  try {
    await app.fileManager.trashFile(copy);
    return true;
  } catch {
    return false;
  }
}

/**
 * Confirm, then write, then say what happened.
 *
 * `null` means the user cancelled. The confirmation is not decoration: the write replaces
 * content the user can see right now and travels to every other device.
 */
export async function runConflictReplace(
  app: App,
  target: ReplaceTarget,
): Promise<ReplaceResult | null> {
  const existing = app.vault.getAbstractFileByPath(target.originalPath);
  if (existing !== null && !(existing instanceof TFile)) {
    showNotice(t("dialog.conflictReplace.folderOccupied", { path: target.originalPath }));
    return { outcome: "failed", copyDeleted: false };
  }

  const modal = new ConflictReplaceModal(app, target, replaceShapeOf(existing !== null));
  modal.open();
  const confirmed = await modal.getResult();
  if (confirmed === null) return null;

  const outcome = await replaceWithConflictCopy(app, target);
  const copyDeleted =
    confirmed.deleteCopy && outcome !== "failed" ? await deleteConflictCopy(app, target) : false;
  // Silence when the write is all there was to say; a failed write, or a copy the user
  // asked to delete that is still there, is the part they cannot see for themselves.
  const text = replaceNoticeText({
    outcome,
    target,
    copyDeleted,
    deleteRequested: confirmed.deleteCopy,
  });
  if (text !== null) showNotice(text);
  return { outcome, copyDeleted };
}

/** What the confirmation returns: nothing on cancel, otherwise the user's one choice. */
export interface ReplaceConfirmation {
  deleteCopy: boolean;
}

/** The confirmation dialog: one sentence, and whether the copy goes with the write. */
export class ConflictReplaceModal extends PromiseModal<ReplaceConfirmation> {
  private deleteCopy = false;

  constructor(
    app: App,
    private readonly target: ReplaceTarget,
    private readonly shape: ReplaceShape,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(replaceConfirmTitle(this.shape));
    // The dialog's own marker, so a caller can tell it from any other modal on screen.
    this.contentEl.addClass("courier-conflict-replace");

    this.contentEl.createEl("p", {
      cls: "courier-conflict-replace-question",
      text: replaceConfirmText(this.shape, this.target),
    });

    // One row, built from the components directly rather than from a `Setting`: a settings
    // row puts its words on the left and everything it controls on the right, while this
    // row reads "switch, then the words it is about" on the left and the buttons on the
    // right. It also draws no divider line, so the sentence is not underlined by one.
    const footer = this.contentEl.createDiv({ cls: "courier-conflict-replace-footer" });
    const choice = footer.createDiv({ cls: "courier-conflict-replace-choice" });
    new ToggleComponent(choice).setValue(false).onChange((value) => {
      this.deleteCopy = value;
    });
    choice.createSpan({ text: replaceDeleteCopyLabel() });

    const actions = footer.createDiv({ cls: "courier-conflict-replace-actions" });
    new ButtonComponent(actions).setButtonText(t("common.cancel")).onClick(() => this.cancel());
    new ButtonComponent(actions)
      .setButtonText(replaceConfirmButton(this.shape))
      .setCta()
      .onClick(() => this.resolve({ deleteCopy: this.deleteCopy }));
  }
}
