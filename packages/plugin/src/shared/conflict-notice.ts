import type { ConflictResolvedEvent, FileTooLargeEvent } from "@courier/engine";
import { t } from "../i18n";

/**
 * How long conflicts are collected before the user is told about them (ms).
 *
 * A conflict is resolved by the engine the moment it is detected, so the notice is
 * only a trail — and a rebind can meet a handful of divergent notes at once. One
 * line per burst keeps the plugin quiet without hiding that something happened.
 */
export const CONFLICT_NOTICE_WINDOW_MS = 1500;

/**
 * The one-line notice for a burst of conflicts.
 *
 * The engine has already settled every conflict by the time this runs, but the head
 * says "detected": the user still has a parked copy to look at, and "resolved" reads
 * as if there were nothing left to do. The rest of the line states the settlement and
 * names the copy.
 *
 * A vault-file conflict resolves the same way every time — the remote version wins and
 * the local one is parked beside the note — so the message only has to say where the
 * local copy went. Events without a conflict path are the ones where this device had
 * nothing local to preserve (the file was already deleted here, or the peer deleted it
 * while this device had made no edits).
 *
 * A config-folder conflict never reaches this module: it is settled silently by last
 * modification time, with no copy to name.
 */
export function conflictNoticeText(events: ConflictResolvedEvent[]): string {
  if (events.length === 0) return "";
  const parked = events.filter((event) => event.conflictPath !== null);
  const head =
    events.length > 1
      ? t("conflict.notice.many", { count: events.length })
      : t("conflict.notice.one");
  if (parked.length === 0) {
    return t("conflict.notice.noLocal", { head });
  }
  // The parked copies keep the original extension (`photo.conflict.png`), so the notice
  // names the files it actually wrote instead of promising a Markdown suffix.
  if (parked.length === 1) {
    return t("conflict.notice.parkedOne", { head, path: parked[0].conflictPath ?? "" });
  }
  return t("conflict.notice.parkedMany", {
    head,
    count: parked.length,
    path: parked[0].conflictPath ?? "",
  });
}

/** How many skipped files are named in the notice before it is summarised. */
const TOO_LARGE_NAMES_SHOWN = 3;

/**
 * The one-line notice for a burst of size-cap skips.
 *
 * A file over the cap is not **sent** from this device (the cap bounds uploads; a version
 * a peer stored is still received), so nothing else would tell the user why their video
 * never reached the other device — and the fix is a setting, so the message has to point
 * at it.
 */
export function tooLargeNoticeText(events: FileTooLargeEvent[]): string {
  if (events.length === 0) return "";
  const head =
    events.length > 1
      ? t("conflict.notice.tooLargeMany", { count: events.length })
      : t("conflict.notice.tooLargeOne");
  const names = events
    .slice(0, TOO_LARGE_NAMES_SHOWN)
    .map((event) =>
      t("conflict.notice.fileName", {
        path: event.plainPath,
        size: formatSize(event.sizeBytes),
      }),
    )
    .join(t("common.listSeparator"));
  const more = events.length > TOO_LARGE_NAMES_SHOWN ? t("conflict.notice.tooLargeMore") : "";
  return t("conflict.notice.tooLargeNames", { head, names, more });
}

/** A byte count in the unit a person reads (KB/MB/GB), one decimal. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
