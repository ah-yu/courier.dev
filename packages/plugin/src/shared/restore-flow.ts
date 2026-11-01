import { ButtonComponent, Setting, type App } from "obsidian";
import { RestoreBlockedError, type SyncEngine } from "@courier/engine";
import { t } from "../i18n";
import { PromiseModal } from "../ui/dialogs/promise-modal";
import { showNotice } from "./show-notice";
import { freeRestorePath, splitVaultPath } from "./restore-name";

/**
 * The one restore interaction both surfaces share — the version-history modal
 * (restoring an older version of a live note) and the recycle bin (resurrecting a
 * deleted one).
 *
 * The part that has to be identical is what happens when the path a restore
 * would write to is *not* free: the engine refuses to overwrite it
 * (`RestoreBlockedError`), and the answer is a dialog that asks for another file
 * name — pre-filled with the original name plus `-1`, the way a person would name a
 * second copy — so the content comes back beside the file that took the path.
 * Restoring onto the chain's own file, by contrast, is a plain write — optionally
 * gated by a confirmation, because it replaces content the user can still see.
 */

/** What {@link RestorePathModal} needs to offer a restore under a different name. */
export interface RestorePathOptions {
  /** The path a plain restore would have written to — the one that is taken. */
  occupiedPath: string;
  /** The folder the restored file lands in: the original file's own folder. */
  dir: string;
  /** The name the field starts with, e.g. `hero-1.md`. */
  suggestedName: string;
  /**
   * Asked when the user confirms. `false` keeps the dialog open, because a name that is
   * taken too is answered by another name — not by a closed dialog and a Notice.
   */
  isNameFree: (targetPath: string) => Promise<boolean>;
  /**
   * Whether that name stays inside this device's sync scope.
   *
   * Only enforced when the file being restored is itself in scope: restoring a chain this
   * device does not sync at all (a `.pdf` with that type switched off) is legitimate, and
   * must not be blocked by a name that is equally out of scope.
   */
  isNameSynced: (targetPath: string) => boolean;
}

/**
 * Where to put a restore whose original path is taken.
 *
 * A text field rather than a fixed "save as" suggestion: the user is the one who knows
 * what the second copy should be called, and the default (`原名-1.ext`) is what the path
 * itself suggests. Only the file name is edited — the folder stays the original one, so
 * the restored note lands where it was, and `restoreFile` records exactly that path for
 * the chain. What the field may *not* do is drop the copy out of this device's sync
 * scope (see {@link RestorePathOptions.isNameSynced}).
 */
export class RestorePathModal extends PromiseModal<{ targetPath: string }> {
  private name: string;
  private errorEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly options: RestorePathOptions,
  ) {
    super(app);
    this.name = options.suggestedName;
  }

  override onOpen(): void {
    this.setTitle(t("restore.title"));
    this.modalEl.addClass("courier-restore-path-modal");
    this.contentEl.addClass("courier-restore-path");

    // The occupied path gets a callout of its own instead of a sentence that has to
    // carry a long path inline: the path is the reason this dialog exists.
    const lead = this.contentEl.createDiv({ cls: "courier-restore-lead" });
    lead.setText(t("restore.occupied", { path: this.options.occupiedPath }));
    this.contentEl.createDiv({
      cls: "courier-restore-hint",
      text: t("restore.hint"),
    });
    this.contentEl.createDiv({
      cls: "courier-restore-folder",
      text: this.options.dir ? t("restore.folder", { dir: this.options.dir }) : t("restore.root"),
    });

    // The text field stays a `Setting` row on purpose: `modalTexts` in the e2e harness
    // reads the field through the row, and the real-Obsidian helper looks up the one
    // `input[type="text"]` in the dialog. The row is restyled into a stacked field by
    // `courier-restore-name`; only its chrome changes.
    const nameSetting = new Setting(this.contentEl).setName(t("restore.nameLabel"));
    nameSetting.settingEl.addClass("courier-restore-name");
    nameSetting.addText((text) => {
      text.setValue(this.name).onChange((value) => {
        this.name = value;
        // A new name retires the previous complaint instead of leaving a stale line
        // under a field the user has already corrected.
        this.errorEl?.setText("");
      });
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void this.confirm();
      });
      // The only field in the dialog: put the cursor there with the suggestion
      // selected, so typing replaces it. The e2e harness's fake input has no
      // focus/select, hence the guards.
      const input = text.inputEl;
      if (typeof input.focus === "function") {
        input.focus();
        if (typeof input.select === "function") input.select();
      }
    });

    // Always present, and given a minimum height in CSS: an inline error must not push
    // the footer down when a second name turns out to be taken too.
    this.errorEl = this.contentEl.createDiv({ cls: "courier-restore-path-error" });

    const footer = this.contentEl.createDiv({ cls: "courier-restore-path-footer" });
    new ButtonComponent(footer).setButtonText(t("common.cancel")).onClick(() => this.cancel());
    new ButtonComponent(footer)
      .setButtonText(t("common.restore"))
      .setCta()
      .onClick(() => void this.confirm());
  }

  /** What the field currently says, as a vault path. */
  private targetPath(): string {
    const name = this.name.trim();
    return this.options.dir ? `${this.options.dir}/${name}` : name;
  }

  private async confirm(): Promise<void> {
    const name = this.name.trim();
    if (!name) {
      this.showError(t("restore.nameRequired"));
      return;
    }
    if (name.includes("/")) {
      this.showError(t("restore.nameSlash"));
      return;
    }
    if (!this.options.isNameSynced(this.targetPath())) {
      this.showError(t("restore.nameOutOfScope"));
      return;
    }
    // Re-read the vault: the name may have been taken since the dialog opened, and the
    // engine would refuse the write (leaving a Notice and no file) if it were.
    if (!(await this.options.isNameFree(this.targetPath()))) {
      this.showError(t("restore.nameTaken"));
      return;
    }
    this.resolve({ targetPath: this.targetPath() });
  }

  private showError(message: string): void {
    this.errorEl?.setText(message);
  }
}

export type RestoreOutcome = "restored" | "cancelled" | "failed";

export interface RestoreFlowOptions {
  app: App;
  engine: SyncEngine;
  fileId: string;
  /** The path the caller believes this content belongs at. */
  sourcePath: string;
  contentHash: string;
  /**
   * Asked before an in-place restore — the target path already holds this
   * chain's file, so the write replaces live content. Returning false cancels.
   */
  confirmOverwrite?: (targetPath: string) => Promise<boolean>;
  /** Run after a successful write (the recycle bin re-reads its list). */
  onRestored?: () => void;
}

/**
 * Resolve where the restore can write, ask the user whatever that answer
 * requires, and run it. A refusal from the engine is turned into an instruction
 * rather than a crash; nothing is ever written over another file.
 */
export async function runRestoreFlow(options: RestoreFlowOptions): Promise<RestoreOutcome> {
  const { app, engine, fileId, sourcePath, contentHash, confirmOverwrite, onRestored } = options;

  // The chain's own live path is where the engine will write, so that — not the
  // caller's possibly stale path — is what the interaction has to be decided on.
  const source = engine.pathForFileId(fileId) ?? sourcePath;
  const status = await engine.inspectRestoreTarget(fileId, source);

  let targetPath: string | undefined;
  if (status.kind === "other-file" || status.kind === "unattributed") {
    // The path is taken — by another synced file, or by a note this device has
    // not indexed yet. Never overwrite it: offer the content back under a new name.
    const { dir } = splitVaultPath(source);
    // The engine is the one that answers "is this path free": its check reads the file
    // at that path, which is exactly what a restore must not write over.
    const isFree = async (candidate: string): Promise<boolean> =>
      (await engine.inspectRestoreTarget(fileId, candidate)).kind === "free";
    // A free-text field is the one place a restore can be talked out of the sync scope —
    // typing `hero-1` for `hero.md` drops the copy into `otherTypes`, which is off by
    // default, and the file then sits on this device while no peer ever materialises it.
    // Holding the name to the source's own scope is what closes that, without refusing a
    // chain this device does not sync in the first place.
    const sourceSynced = engine.isSyncablePath(source);
    const suggestedPath = await freeRestorePath(source, isFree);
    const modal = new RestorePathModal(app, {
      occupiedPath: source,
      dir,
      suggestedName: splitVaultPath(suggestedPath).name,
      isNameSynced: (candidate) => !sourceSynced || engine.isSyncablePath(candidate),
      isNameFree: isFree,
    });
    modal.open();
    const choice = await modal.getResult();
    if (!choice) return "cancelled";
    targetPath = choice.targetPath;
  } else if (confirmOverwrite && !(await confirmOverwrite(source))) {
    return "cancelled";
  }

  try {
    await engine.restoreFile(fileId, source, contentHash, { targetPath });
  } catch (err) {
    if (err instanceof RestoreBlockedError) {
      // The dialog checked this path, and it was taken in between — the only way left is
      // to say so rather than to write over whatever arrived.
      if (err.reason === "occupied-by-other-file") {
        showNotice(t("restore.failedOccupied", { path: targetPath ?? source }));
      } else {
        showNotice(t("restore.failedUnsynced", { path: targetPath ?? source }));
      }
      return "failed";
    }
    showNotice(t("restore.failed", { error: err instanceof Error ? err.message : String(err) }));
    return "failed";
  }

  onRestored?.();
  return "restored";
}
