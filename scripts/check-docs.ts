#!/usr/bin/env bun
/**
 * Guard the agent-facing docs.
 *
 * `AGENTS.md` is injected into every agent session, so it has a hard size cap: anything longer
 * belongs in a document under `docs/`. This check fails when the cap is exceeded, when a
 * document under `docs/` is missing from the index, or when a relative Markdown link — or the
 * `#fragment` inside one — points at something that does not exist.
 *
 * Fragments are checked because they are the routing layer `AGENTS.md` uses: it sends a reader
 * to a named section of a document, so a renamed heading has to fail here rather than produce a
 * link that silently lands at the top of the page. The link scan covers `AGENTS.md`, the
 * repository-root `README.md` and its `README.zh-CN.md` translation, and every document under
 * `docs/`, not only the index.
 *
 * Run directly with `bun run check:docs`; it is also a default `bun run verify` gate.
 */
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AGENTS_MAX_BYTES = 32 * 1024;
const failures = [];

const agentsPath = join(root, "AGENTS.md");
const docsDir = join(root, "docs");
const indexPath = join(docsDir, "README.md");
const readmePath = join(root, "README.md");
const readmeZhPath = join(root, "README.zh-CN.md");
const anchorCache = new Map();

/** A repo-relative path with forward slashes, for messages. */
function display(path) {
  return relative(root, path).split("\\").join("/");
}

/** Read a file, recording a failure instead of throwing when it is missing. */
function readOrFail(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    failures.push(`${display(path)} is missing or unreadable.`);
    return null;
  }
}

/** Every file with one of `extensions` under `dir`, recursively. */
function listMarkdown(dir, extensions = [".md"], found = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    failures.push(`${display(dir)} is missing or unreadable.`);
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listMarkdown(path, extensions, found);
    else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) found.push(path);
  }
  return found;
}

/** Drop fenced blocks, where a heading or a bracket is an example rather than content. */
function stripFences(text) {
  const kept = [];
  let fence = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(```|~~~)/.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1];
      else if (marker[1] === fence) fence = null;
      continue;
    }
    if (fence === null) kept.push(line);
  }
  return kept.join("\n");
}

/** Fenced blocks plus inline code, where a bracket is an example, not a link. */
function stripCode(text) {
  return stripFences(text).replace(/`[^`\n]*`/g, "");
}

/** The GitHub-style anchor a heading produces (duplicates get `-1`, `-2`, …). */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/ /g, "-");
}

/** The set of anchors a document defines, as a browser would resolve its fragment. */
function anchors(path) {
  const cached = anchorCache.get(path);
  if (cached) return cached;
  const text = readOrFail(path);
  const found = new Set();
  if (text !== null) {
    const seen = new Map();
    for (const line of stripFences(text).split(/\r?\n/)) {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (!heading) continue;
      const base = slug(heading[1]);
      const count = seen.get(base) ?? 0;
      seen.set(base, count + 1);
      found.add(count === 0 ? base : `${base}-${count}`);
    }
  }
  anchorCache.set(path, found);
  return found;
}

/**
 * Report every relative link (or fragment) in `text` that does not resolve. External URLs and
 * bare fragments are skipped; a fragment on a `.md` target is checked against that file's
 * headings.
 */
function checkLinks(file, text) {
  const dir = dirname(file);
  for (const match of stripCode(text).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|tel:|data:|\/\/)/i.test(target) || target.startsWith("#")) continue;
    const [rawPath, fragment] = target.split("#");
    const path = rawPath.split("?")[0];
    if (!path) continue;
    const resolved = resolve(dir, path);
    if (!existsSync(resolved)) {
      failures.push(`${display(file)} links to missing ${target}.`);
      continue;
    }
    if (fragment && /\.mdx?$/.test(resolved) && !anchors(resolved).has(fragment)) {
      failures.push(`${display(file)} links to ${target}: no heading makes that anchor.`);
    }
  }
}

// --- AGENTS.md stays small -------------------------------------------------

const agents = readOrFail(agentsPath);
if (agents !== null && Buffer.byteLength(agents) > AGENTS_MAX_BYTES) {
  failures.push(
    `AGENTS.md is ${Buffer.byteLength(agents)} bytes; the cap is ${AGENTS_MAX_BYTES}. Move detail into docs/.`,
  );
}

// --- every document is registered in the index -----------------------------

const docs = listMarkdown(docsDir)
  .filter((path) => path !== indexPath)
  .toSorted();
const index = readOrFail(indexPath);
if (index !== null) {
  /*
   * A document is registered when `docs/README.md` links it, directly or through an
   * index README it links (a subtree with its own routing table, such as the published
   * user guide's `README.md`, is then read the same way).
   */
  const indexed = new Set();
  const queue = [[indexPath, index]];
  const seen = new Set();
  while (queue.length > 0) {
    const [file, text] = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^(https?:|mailto:|tel:|data:|\/\/)/i.test(target) || target.startsWith("#")) continue;
      const path = target.split("#")[0].split("?")[0];
      if (!path) continue;
      const resolved = resolve(dirname(file), path);
      indexed.add(resolved);
      if (resolved.endsWith("README.md") && existsSync(resolved)) {
        queue.push([resolved, readFileSync(resolved, "utf8")]);
      }
    }
  }
  for (const path of docs) {
    if (!indexed.has(path)) {
      failures.push(`docs/README.md does not index ${display(path)}.`);
    }
  }
}

// --- links and fragments resolve -------------------------------------------

/*
 * `AGENTS.md` routes a reader into `docs/`, and the repository-root `README.md` is the project
 * page, so both are scanned beside every document's own links, together with its
 * `README.zh-CN.md` translation; a renamed file or heading fails here rather than in a reader's
 * browser.
 */
const readme = readOrFail(readmePath);
const readmeZh = readOrFail(readmeZhPath);
for (const [path, text] of [
  [agentsPath, agents],
  [readmePath, readme],
  [readmeZhPath, readmeZh],
]) {
  if (text !== null) checkLinks(path, text);
}
for (const path of docs) {
  const text = readOrFail(path);
  if (text !== null) checkLinks(path, text);
}
if (index !== null) checkLinks(indexPath, index);

if (failures.length > 0) {
  console.error("[docs] FAILED");
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `[docs] ok — AGENTS.md ${Buffer.byteLength(agents)}/${AGENTS_MAX_BYTES} bytes, ` +
    `${docs.length} documents indexed, links and anchors resolve`,
);
