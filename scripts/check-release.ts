#!/usr/bin/env bun
/**
 * Guard the release version before CI and before anything is built.
 *
 * One `X.Y.Z` tag drives the release, and it carries the bare version — no leading `v`.
 * That tag publishes the server and CLI binaries and the plugin assets here, and the
 * plugin alone from its publishing mirror (`scripts/mirror-plugin.ts`), so the version
 * has to agree everywhere it is written: the three package files, plus the
 * repository-root `manifest.json` that mirrors the plugin manifest for the Obsidian
 * community directory (the directory reads the manifest at the HEAD of the default
 * branch). Without an argument the script only checks that they agree with each other;
 * with a tag it also checks they equal that tag. This is the release preflight and a
 * plain CI step, so a version bump cannot land on one file alone.
 *
 * The root mirror is also held to the plugin manifest byte for byte (line endings
 * aside), and the plugin manifest is checked against the fields the community
 * directory reviews, so a manual edit of one manifest cannot reach a release.
 *
 * Usage:
 *   bun scripts/check-release.ts            # the versions agree and the mirror matches
 *   bun scripts/check-release.ts 0.1.0      # ... and they equal the tag (v0.1.0 works too)
 *
 * On success stdout carries only the version, so a workflow can capture it with
 * command substitution: `version=$(bun scripts/check-release.ts 0.1.0)`. Every
 * other line goes to stderr.
 */
import { readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { CONTRACT_GENERATION, MIN_CLIENT_CONTRACT } from "../packages/shared/src/contract.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FAILED_HEADER = "[release] FAILED";
const PLUGIN_MANIFEST = "packages/plugin/manifest.json";
const ROOT_MANIFEST = "manifest.json";
/** The community directory's limit for the listing excerpt. */
const MAX_DESCRIPTION_LENGTH = 250;
const REQUIRED_PLUGIN_FIELDS = [
  "id",
  "name",
  "version",
  "minAppVersion",
  "description",
  "author",
  "authorUrl",
  "isDesktopOnly",
];

const failures = [];

/** Read a file, recording a failure instead of throwing. */
function readText(relativePath) {
  try {
    return readFileSync(join(root, relativePath), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${relativePath}: ${message}`);
    return null;
  }
}

/** Parse a JSON file that was already read, recording a failure instead of throwing. */
function parseJson(relativePath, text) {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`${relativePath}: ${message}`);
    return null;
  }
}

/** Read and parse a JSON file, recording a failure instead of throwing. */
function readJson(relativePath) {
  return parseJson(relativePath, readText(relativePath));
}

/**
 * The root manifest is a verbatim copy of the plugin manifest, so a checkout on
 * any platform compares equal: only the line endings may differ (`text=auto`).
 */
function sameManifest(left, right) {
  return left.replace(/\r\n/g, "\n") === right.replace(/\r\n/g, "\n");
}

const tag = process.argv[2];
if (process.argv.length > 3) {
  failures.push("expected at most one argument: an optional X.Y.Z tag");
}
if (tag !== undefined && !/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  failures.push(`"${tag}" is not a release tag in the form X.Y.Z`);
}

const server = readJson("packages/server/package.json");
const cli = readJson("packages/cli/package.json");
const pluginText = readText(PLUGIN_MANIFEST);
const rootText = readText(ROOT_MANIFEST);
const plugin = parseJson(PLUGIN_MANIFEST, pluginText);
const rootManifest = parseJson(ROOT_MANIFEST, rootText);

const versions = [
  ["packages/server/package.json", server?.version],
  ["packages/cli/package.json", cli?.version],
  [PLUGIN_MANIFEST, plugin?.version],
  [ROOT_MANIFEST, rootManifest?.version],
];

/** Report a version that is missing or not semver, once per source. */
function checkVersion(source, version) {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    failures.push(`${source}: version ${JSON.stringify(version)} is not semver`);
    return false;
  }
  return true;
}

const usable = versions.filter(([source, version]) => checkVersion(source, version));

if (pluginText !== null && rootText !== null && !sameManifest(pluginText, rootText)) {
  failures.push(
    `${ROOT_MANIFEST} is not identical to ${PLUGIN_MANIFEST}: the Obsidian community directory ` +
      `reads the manifest at the repository root, so the two must stay in step. Copy the plugin ` +
      `manifest over it (or run \`bun run version:snapshot\`) and re-run this check.`,
  );
}

if (plugin !== null) {
  const source = PLUGIN_MANIFEST;
  for (const field of REQUIRED_PLUGIN_FIELDS) {
    if (!(field in plugin)) failures.push(`${source}: missing "${field}"`);
  }
  if (typeof plugin.id === "string") {
    if (!/^[a-z0-9-]+$/.test(plugin.id)) {
      failures.push(
        `${source}: id ${JSON.stringify(plugin.id)} is not lowercase letters, digits and hyphens`,
      );
    }
    if (plugin.id.endsWith("plugin")) {
      failures.push(`${source}: id ${JSON.stringify(plugin.id)} must not end with "plugin"`);
    }
    if (plugin.id.includes("obsidian")) {
      failures.push(`${source}: id ${JSON.stringify(plugin.id)} must not contain "obsidian"`);
    }
  }
  if (typeof plugin.description === "string") {
    if (plugin.description.length > MAX_DESCRIPTION_LENGTH) {
      failures.push(
        `${source}: description is ${plugin.description.length} characters; the community ` +
          `directory allows ${MAX_DESCRIPTION_LENGTH}`,
      );
    }
    if (!plugin.description.endsWith(".")) {
      failures.push(`${source}: description must end with a period`);
    }
    // The directory rejects the word in the listing: "Obsidian" is implied by the context.
    if (/obsidian/i.test(plugin.description)) {
      failures.push(`${source}: description must not contain "Obsidian"`);
    }
  }
  if (typeof plugin.isDesktopOnly !== "boolean") {
    failures.push(`${source}: isDesktopOnly must be a boolean`);
  }
}

if (tag !== undefined) {
  const tagVersion = tag.replace(/^v/, "");
  for (const [source, version] of usable) {
    if (version !== tagVersion) {
      failures.push(`${source}: version ${version} does not match tag ${tag} (${tagVersion})`);
    }
  }
} else if (usable.length > 0) {
  const [referenceSource, reference] = usable[0];
  for (const [source, version] of usable.slice(1)) {
    if (version !== reference) {
      failures.push(
        `${source}: version ${version} does not match ${referenceSource} (${reference})`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(FAILED_HEADER);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

// The compatibility promise this release carries, on stderr so the version stays the only
// thing on stdout: a release whose notes have to name the side that upgrades is the one whose
// generation moved, and the release log is where that is first visible.
console.error(
  `[release] contract generation ${CONTRACT_GENERATION} ` +
    `(serves clients >= ${MIN_CLIENT_CONTRACT}; clients need servers >= ${CONTRACT_GENERATION})`,
);

console.log(server.version);
