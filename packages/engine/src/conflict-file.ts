/**
 * Conflict files — where the losing side of an auto-resolved conflict is parked.
 *
 * A vault-file conflict resolves the same way on every host: the **remote head becomes
 * the truth** and whatever this device had locally is written beside the file as
 * `{stem}-{YYYY-MM-DD-HHmmss}.conflict{ext}` — `note-2026-02-14-101530.conflict.md`
 * for a note, `photo-2026-02-14-101530.conflict.png` for an image, so the parked copy
 * keeps the extension Obsidian needs to open it at all.
 *
 * A path inside Obsidian's config folder is the exception: a copy parked there is
 * outside the vault index, so nobody could see or act on it. Those conflicts are
 * settled by last modification time and park nothing (`ConflictResolver`).
 *
 * Those files are never synced. They are the local audit trail of a conflict —
 * letting them travel would let one conflict produce another on the peer.
 */

/** Zero-pad a date or time field to two digits — the shape of the conflict stamp. */
function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Build the conflict-file path for a plain path:
 * `{stem}-{YYYY-MM-DD-HHmmss}.conflict{ext}`, in the same folder as the original.
 *
 * The extension is preserved (`photo.png` → `photo-2026-02-14-101530.conflict.png`); a path
 * with no extension falls back to `.md`. `now` is read in local time and names the second the
 * copy was parked at, so two conflicts on one file are told apart by their names alone.
 * `index` remains for the case a timestamp cannot cover — two copies parked inside the same
 * second (`{stem}-{YYYY-MM-DD-HHmmss}-2.conflict.md`): a parked copy must never overwrite an
 * earlier one, or the content this rule exists to preserve would be lost.
 */
export function conflictFilePath(plainPath: string, now = new Date(), index = 1): string {
  // Split the directory off first: a folder whose name contains a dot (`notes.v2/plan`)
  // must keep its folder, so only the file name is examined for an extension.
  const slash = plainPath.lastIndexOf("/");
  const dir = slash >= 0 ? plainPath.slice(0, slash + 1) : "";
  const name = slash >= 0 ? plainPath.slice(slash + 1) : plainPath;
  const dot = name.lastIndexOf(".");
  // dot === 0 is a leading dot (a dotfile), not an extension separator.
  const hasExtension = dot > 0;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : ".md";
  const d = now;
  const stamp =
    `${d.getFullYear()}-${padTwo(d.getMonth() + 1)}-${padTwo(d.getDate())}` +
    `-${padTwo(d.getHours())}${padTwo(d.getMinutes())}${padTwo(d.getSeconds())}`;
  const suffix = index > 1 ? `-${index}` : "";
  return `${dir}${stem}-${stamp}${suffix}.conflict${extension}`;
}

/**
 * The path a conflict copy was parked beside — the inverse of {@link conflictFilePath}.
 *
 * The trailing `-YYYY-MM-DD-HHMMSS[-n].conflict` and the kept extension are stripped from
 * the file name, so `notes/plan-2026-02-14-101530.conflict.md` answers `notes/plan.md`.
 * `null` means the name is not one this project parks, and is the same test as
 * {@link isConflictFile}.
 *
 * A path that had **no** extension was parked with the `.md` fallback, and the copy's name
 * cannot say whether the original ended in `.md` or in nothing at all — `README` and
 * `README.md` both park as `README-….conflict.md`. The answer is therefore the name the
 * copy kept (`README.md`); a caller that acts on the file has to allow for the other
 * reading (a vault may hold the extension-less form), which is a decision about the
 * vault, not about the name.
 */
export function originalPathOfConflictFile(path: string): string | null {
  // The extension is part of the name, so the folder is split off first — the same rule
  // `conflictFilePath` follows, and what keeps a folder called `notes.v2` intact.
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  // Greedy `.*` takes the **last** stamp-shaped run that still leaves the suffix intact,
  // so a stem that itself looks like a timestamp (`plan-2026-…`) round-trips.
  const match = /^(.*)-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.conflict(\.[^/]+)?$/.exec(name);
  if (!match) return null;
  return `${dir}${match[1]}${match[2] ?? ".md"}`;
}

/**
 * `*.conflict.*` files are excluded from sync, on every path that lists or watches.
 *
 * The pattern is exactly the name `conflictFilePath` builds: the date, the time, then an
 * optional counter (what a second conflict inside the same second adds) and the extension
 * the parked copy kept. The extension is part of it because a copy of a binary file keeps
 * its own — and this check runs before the file-type rules, so a `photo-….conflict.png`
 * never syncs even while images do.
 */
export function isConflictFile(path: string): boolean {
  return /-\d{4}-\d{2}-\d{2}-\d{6}(-\d+)?\.conflict(\.[^/]+)?$/.test(path);
}
