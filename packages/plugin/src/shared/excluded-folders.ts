import { isPathInExcludedFolders, normalizeExcludedFolders } from "@courier/engine";
import { sortedCopy } from "@courier/shared";

/**
 * The folder tree behind the settings page's "manage excluded folders" dialog.
 *
 * Kept pure (no `obsidian` import) so the decisions the dialog makes — what a checkbox
 * means when an ancestor is excluded, what "Done" should save, and how a flat list of
 * folder paths becomes a tree — are unit-tested instead of being asserted through a
 * fake modal.
 *
 * The engine's excluded-folder rule is a path prefix (`path === folder ||
 * path.startsWith(folder + "/")`), so an exclusion of `projects` already covers
 * `projects/create NFT's`. The dialog makes that hierarchy visible: a child of an
 * excluded folder is shown checked and disabled, because unchecking it alone could not
 * bring it back — the parent has to be unchecked first.
 */

/** One folder in the dialog's tree. */
export interface ExcludedFolderNode {
  /** Vault-relative path, e.g. `projects/create NFT's`. */
  path: string;
  /** Last path segment — what the row shows. */
  name: string;
  /** 0 for a top-level folder; used as the row's indentation. */
  depth: number;
  children: ExcludedFolderNode[];
}

/**
 * Drop every exclusion already covered by another one, and put the rest in a stable
 * parent-first order.
 *
 * The stored list can contain `projects` and `projects/create NFT's` (the CLI accepts
 * both), but only the parent has an effect. Saving a compacted list keeps the dialog's
 * rows unambiguous: a folder is either checked because it is in the list, or checked and
 * disabled because an ancestor is.
 */
export function compactExcludedFolders(folders: readonly string[]): string[] {
  const normalized = normalizeExcludedFolders(folders);
  const sorted = sortedCopy(normalized, (left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? left.localeCompare(right) : depth;
  });
  const kept: string[] = [];
  for (const folder of sorted) {
    if (kept.some((parent) => folder.startsWith(`${parent}/`))) continue;
    kept.push(folder);
  }
  return kept;
}

/** Whether `path` is itself excluded, or lives under an excluded folder. */
export function isFolderCoveredByExclusion(path: string, folders: readonly string[]): boolean {
  // The engine's own rule, not a copy of it: the dialog's checkboxes, the explorer's
  // dimming and `isSyncablePath` have to answer the same thing for the same list.
  return isPathInExcludedFolders(path, folders);
}

/**
 * Whether an **ancestor** of `path` is excluded, which is why its own checkbox is
 * checked and disabled: removing the child entry would not bring it back.
 */
export function hasExcludedAncestor(path: string, folders: readonly string[]): boolean {
  return folders.some((folder) => folder !== path && path.startsWith(`${folder}/`));
}

/**
 * The list after a folder's checkbox changes.
 *
 * Checking a folder replaces any exclusion inside it — `projects` covers
 * `projects/create NFT's`, so keeping both would leave a row that looks checked but
 * cannot be unchecked. Unchecking removes exactly that folder; an individually excluded
 * child (a state the dialog itself never produces) is left alone.
 */
export function toggleExcludedFolder(
  folders: readonly string[],
  path: string,
  checked: boolean,
): string[] {
  const compact = compactExcludedFolders(folders);
  if (!checked) return compact.filter((folder) => folder !== path);
  return compactExcludedFolders([
    ...compact.filter((folder) => folder !== path && !folder.startsWith(`${path}/`)),
    path,
  ]);
}

/**
 * Build the tree the dialog renders from every folder path it should show.
 *
 * Missing parents are created (`a` and `a/b/c` produce `a` → `b` → `c`), so a path the
 * user excluded before it existed still appears under the parent it will live in. The
 * result is sorted by name at every level, which is also what makes the dialog stable
 * across re-renders.
 */
export function buildExcludedFolderTree(paths: readonly string[]): ExcludedFolderNode[] {
  const nodes = new Map<string, ExcludedFolderNode>();
  const roots: ExcludedFolderNode[] = [];

  const ensure = (segments: string[]): ExcludedFolderNode | null => {
    if (segments.length === 0) return null;
    const path = segments.join("/");
    const existing = nodes.get(path);
    if (existing) return existing;
    const node: ExcludedFolderNode = {
      path,
      name: segments[segments.length - 1],
      depth: segments.length - 1,
      children: [],
    };
    nodes.set(path, node);
    if (segments.length === 1) {
      roots.push(node);
    } else {
      ensure(segments.slice(0, -1))?.children.push(node);
    }
    return node;
  };

  for (const raw of paths) {
    // The same normalizer the engine and the settings use, so a path that would be
    // dropped there (a traversal segment, an empty name) cannot appear here as some
    // other folder — a `..` is rejected as a whole entry rather than silently removed.
    const normalized = normalizeExcludedFolders([raw])[0];
    if (!normalized) continue;
    ensure(normalized.split("/"));
  }

  sortFolderTree(roots);
  return roots;
}

/** Sort every level of the tree by name, so the dialog renders one stable order. */
function sortFolderTree(list: ExcludedFolderNode[]): void {
  list.sort((left, right) => left.name.localeCompare(right.name));
  for (const node of list) sortFolderTree(node.children);
}
