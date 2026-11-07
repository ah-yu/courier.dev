import { App, Setting } from "obsidian";
import type { SyncLeaseInfo } from "@courier/engine";
import { t } from "../../i18n";
import { PromiseModal } from "./promise-modal";

/**
 * Confirm taking the vault from the writer that holds it.
 *
 * The lease is first come, first served, and the party holding it is never ended from
 * here. This dialog is the one deliberate exception: a writer the user cannot stop (a CLI
 * started by something they cannot find) must not lock their own vault for good. It is
 * not a harmless click — the other writer keeps running for up to one renewal period and
 * may finish a pass over the same files — so the confirmation names that writer and says
 * so before anything is taken.
 */
export class TakeOverLeaseModal extends PromiseModal<true> {
  constructor(
    app: App,
    private readonly holder: SyncLeaseInfo | null,
    private readonly vaultName: string | null,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("courier-take-over");
    this.setTitle(t("dialog.takeOver.title"));

    contentEl.createEl("p", {
      text:
        this.vaultName === null || this.vaultName === ""
          ? t("dialog.takeOver.bodyNoVault", { owner: this.ownerLabel() })
          : t("dialog.takeOver.body", { vault: this.vaultName, owner: this.ownerLabel() }),
    });

    const detail = this.detailText();
    if (detail !== null) {
      contentEl.createEl("p", { cls: "courier-take-over-detail", text: detail });
    }

    contentEl.createEl("p", {
      cls: "courier-take-over-warning",
      text: t("dialog.takeOver.warning"),
    });

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText(t("common.cancel")).onClick(() => this.cancel()))
      .addButton((btn) =>
        btn
          .setButtonText(t("dialog.takeOver.confirm"))
          .setDestructive()
          .setCta()
          .onClick(() => this.resolve(true)),
      );
  }

  private ownerLabel(): string {
    if (this.holder === null) return t("dialog.takeOver.ownerUnknown");
    return this.holder.owner === "cli"
      ? t("dialog.takeOver.ownerCli")
      : t("dialog.takeOver.ownerPlugin");
  }

  /** Who holds it, when the record could name them: a pid and the machine it runs on. */
  private detailText(): string | null {
    const holder = this.holder;
    if (holder === null) return null;
    const parts: string[] = [];
    if (holder.pid > 0) parts.push(t("dialog.takeOver.pid", { pid: String(holder.pid) }));
    if (holder.host) parts.push(t("dialog.takeOver.host", { host: holder.host }));
    return parts.length === 0 ? null : parts.join(" · ");
  }
}
