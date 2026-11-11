#!/usr/bin/env bun
/**
 * `bun run contract` — the API contract, as a gate an agent cannot skip.
 *
 * `check` (the default, and the mode `bun run verify` runs) compares the registry's
 * surface with `packages/shared/contract/<CONTRACT_GENERATION>.surface.json`. Any change
 * fails and prints what changed, what it means, and the numbers to write — so the
 * decision is in front of whoever made the change, not in a document they did not read.
 *
 * `bump --write --reason "..."` applies that decision: it moves `CONTRACT_GENERATION`
 * (and, for a breaking change, the floor) in `packages/shared/src/contract.ts`, and
 * writes the next generation's surface file. `write` exists only to create the first
 * file for a generation.
 *
 * See `docs/api.md` → "Contract generation" for the rules.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addedNames, classify, type Classification, type Change } from "./classify";
import {
  readGenerations,
  readSurface,
  readSurfaceFile,
  type Generations,
  type Surface,
} from "./surface";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const contractDirectory = join(repoRoot, "packages", "shared", "contract");
const contractSource = join(repoRoot, "packages", "shared", "src", "contract.ts");

const command = process.argv[2] ?? "check";
const apply = process.argv.includes("--write");
const assumeClientUsage = process.argv.includes("--server");
const denyClientUsage = process.argv.includes("--no-server");
const keepFloor = process.argv.includes("--keep-floor");
const reason = argument("--reason");
const fileVerdict = argument("--verdict") ?? "initial";

const generations = readGenerations();
const surface = readSurface();
const generationFile = join(contractDirectory, `${generations.contract}.surface.json`);

switch (command) {
  case "check":
    check();
    break;
  case "bump":
    bump();
    break;
  case "review":
    review();
    break;
  case "write":
    createFirstSurface();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error(
      "Usage: bun run contract [check | review --since <tag> | bump [--write] [--reason <text>] [--keep-floor] | write --reason <text> [--verdict initial|format-change]]",
    );
    process.exit(2);
}

/** The gate: the code must match the surface committed for its own generation. */
function check(): void {
  if (!existsSync(generationFile)) {
    console.error(
      `contract: generation ${generations.contract} has no surface file.\n` +
        `  Expected: ${relative(generationFile)}\n` +
        '  Create it with `bun run contract write --reason "..."` (first import).',
    );
    process.exit(1);
  }

  const classification = classify(readSurfaceFile(generationFile), surface);
  if (classification.verdict === "unchanged") {
    console.log(`contract generation ${generations.contract}: the code matches its surface file`);
    return;
  }

  const recommendation = plan(classification);
  printClassification(classification);
  printRecommendation(classification, recommendation);
  console.error(
    "\ncontract: the API surface changed without a generation bump.\n" +
      '  Run `bun run contract bump --write --reason "..."` to apply the numbers above.\n' +
      "  If the change is meant to be invisible to peers, put it back.\n",
  );
  process.exit(1);
}

/**
 * The release-stage review: what moved since the previous release tag.
 *
 * `check` is per change; this is per release. It names every generation's decision, the
 * generation/floor window and the contract-sensitive code that moved, so the human
 * approving the protected `release` environment has the surface history in front of them.
 * It is a report, not a gate: the environment approval is the gate.
 */
function review(): void {
  const since = argument("--since") ?? latestTag();
  if (since === undefined) {
    console.error("contract: review needs --since <tag>, or a repository with at least one tag.");
    process.exit(2);
  }

  const head = git(["rev-parse", "HEAD"]);
  const changed = git(["diff", "--name-only", `${since}..${head}`])
    .split("\n")
    .filter((file) => file !== "");
  const generationFiles = changed.filter((file) =>
    /^packages\/shared\/contract\/\d+\.surface\.json$/.test(file),
  );
  const sensitive = changed.filter(
    (file) =>
      file === "packages/shared/src/contract.ts" ||
      file.startsWith("packages/shared/src/wire/") ||
      file.startsWith("packages/server/src/") ||
      file.startsWith("scripts/contract/") ||
      file === "packages/engine/src/websocket.ts",
  );
  const previous = previousGenerations(since);

  console.log(`Contract review: ${since}..${head.slice(0, 7)}`);
  console.log(`  generation: ${previous?.contract ?? "?"} → ${generations.contract}`);
  console.log(`  floor:      ${previous?.minClient ?? "?"} → ${generations.minClient}`);
  console.log("");

  if (generationFiles.length === 0) {
    console.log("  No generation file changed since the tag.");
  } else {
    console.log("  Generation files since the tag:");
    for (const file of generationFiles) {
      const meta = readGenerationMeta(file);
      console.log(`    ${file}: ${meta?.verdict ?? "?"} — ${meta?.reason ?? "?"}`);
    }
  }
  console.log("");

  if (sensitive.length === 0) {
    console.log("  No contract-sensitive code changed since the tag.");
  } else {
    console.log("  Contract-sensitive code changed since the tag:");
    for (const file of sensitive) console.log(`    ${file}`);
  }
  console.log("");

  console.log("Checklist:");
  console.log("  [ ] every decision.reason is accurate and names the side that upgrades");
  console.log("  [ ] MIN_CLIENT_CONTRACT moved only for a breaking change");
  console.log(
    "  [ ] a semantic change with no surface diff has an L1 test and an owning-document update",
  );
  console.log("  [ ] the release notes say which side upgrades");
  console.log("  [ ] this report was read before approving the release environment");
}

/** The latest reachable tag, for a local review with no `--since`. */
function latestTag(): string | undefined {
  try {
    return git(["describe", "--tags", "--abbrev=0"]);
  } catch {
    return undefined;
  }
}

/** Run one git command in the repository and return its trimmed stdout. */
function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

/** The generation numbers as they were at `since`, or undefined before the file existed. */
function previousGenerations(since: string): Generations | undefined {
  try {
    const source = execFileSync("git", ["show", `${since}:packages/shared/src/contract.ts`], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const contract = declarationNumber(source, "CONTRACT_GENERATION");
    const minClient = declarationNumber(source, "MIN_CLIENT_CONTRACT");
    return contract === undefined || minClient === undefined ? undefined : { contract, minClient };
  } catch {
    return undefined;
  }
}

function declarationNumber(source: string, name: string): number | undefined {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  return match === null ? undefined : Number(match[1]);
}

/** One generation file's decision, for the release report. */
function readGenerationMeta(file: string): { verdict: string; reason: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, file), "utf8")) as {
      decision?: { verdict?: unknown; reason?: unknown };
    };
    return {
      verdict: typeof parsed.decision?.verdict === "string" ? parsed.decision.verdict : "?",
      reason: typeof parsed.decision?.reason === "string" ? parsed.decision.reason : "?",
    };
  } catch {
    return undefined;
  }
}

/** Classify the diff against the current generation and (with `--write`) apply it. */
function bump(): void {
  if (!existsSync(generationFile)) {
    console.error(
      `contract: generation ${generations.contract} has no surface file to compare against.\n` +
        '  Run `bun run contract write --reason "..."` first.',
    );
    process.exit(1);
  }

  const classification = classify(readSurfaceFile(generationFile), surface);
  if (classification.verdict === "unchanged") {
    console.log("contract: the surface is unchanged; there is nothing to bump");
    return;
  }

  printClassification(classification);
  const next = plan(classification);
  printRecommendation(classification, next);

  if (!apply) {
    console.error(
      "\ncontract: nothing was written. Re-run with --write to apply the numbers above.\n",
    );
    process.exit(1);
  }
  if (reason === undefined) {
    console.error(
      '\ncontract: --write needs --reason "why this generation moves, and which side upgrades".\n',
    );
    process.exit(1);
  }

  const target = join(contractDirectory, `${next.generations.contract}.surface.json`);
  if (existsSync(target)) {
    console.error(`contract: ${relative(target)} already exists; generations only move forward.`);
    process.exit(1);
  }

  writeGenerations(next.generations);
  mkdirSync(contractDirectory, { recursive: true });
  writeFileSync(
    target,
    generationFileText(next.generations.contract, classification.verdict, reason, surface),
    "utf8",
  );
  console.log(
    `\ncontract: generation ${generations.contract} → ${next.generations.contract}; wrote ${relative(target)} and ${relative(contractSource)}.`,
  );
  console.log("contract: this release's notes must say which side has to upgrade.\n");
}

/** Create the surface file for the current generation. Never overwrites one. */
function createFirstSurface(): void {
  if (existsSync(generationFile)) {
    console.error(
      `contract: ${relative(generationFile)} already exists.\n` +
        '  A changed surface is a generation bump: `bun run contract bump --write --reason "..."`.',
    );
    process.exit(1);
  }
  if (reason === undefined) {
    console.error('contract: write needs --reason "why this generation exists".\n');
    process.exit(1);
  }
  if (fileVerdict !== "initial" && fileVerdict !== "format-change") {
    console.error('contract: --verdict must be "initial" or "format-change".');
    process.exit(2);
  }
  mkdirSync(contractDirectory, { recursive: true });
  writeFileSync(
    generationFile,
    generationFileText(generations.contract, fileVerdict, reason, surface),
    "utf8",
  );
  console.log(`contract: wrote ${relative(generationFile)} for generation ${generations.contract}`);
}

/** A recommendation: the numbers to write, plus the client references the diff mentions. */
interface Plan {
  generations: Generations;
  usage: string[];
}

/** The numbers the classification asks for. */
function plan(classification: Classification): Plan {
  const next = generations.contract + 1;
  if (classification.verdict === "breaking") {
    // `--keep-floor` is the documented escape hatch for a change that *degrades* an
    // older peer without corrupting its reading. A degrading change is classified
    // automatically now, so the flag is only for a case the tool read as breaking.
    return {
      generations: { contract: next, minClient: keepFloor ? generations.minClient : next },
      usage: [],
    };
  }

  const usage = assumeClientUsage
    ? ["assumed (--server)"]
    : denyClientUsage
      ? []
      : clientUsage(addedNames(classification.changes));

  // Additive and degrading: the server's floor stays where it is, because it still reads
  // what it read before. `usage` is reported, not applied.
  return { generations: { contract: next, minClient: generations.minClient }, usage };
}

function printClassification(classification: Classification): void {
  const heading =
    classification.verdict === "breaking"
      ? "breaking: an older peer would misread this change"
      : classification.verdict === "degrading"
        ? "degrading: an older peer misses or ignores this, but reads the rest correctly"
        : "additive: an older peer still reads this correctly";
  console.log(`contract generation ${generations.contract}: the surface changed — ${heading}\n`);
  for (const change of classification.changes) {
    console.log(`  ${marker(change)} ${change.path}`);
    console.log(`      ${change.detail}`);
  }
}

function printRecommendation(classification: Classification, recommendation: Plan): void {
  const next = recommendation.generations;
  console.log("\nThe numbers in packages/shared/src/contract.ts:\n");
  console.log(`  CONTRACT_GENERATION = ${next.contract}`);
  console.log(`  MIN_CLIENT_CONTRACT = ${next.minClient}`);

  if (classification.verdict === "degrading") {
    console.log(
      "\nThe floor stays put: the change degrades an older peer without misreading it.\n" +
        "The generation moves because the wire changed; the server still serves those clients.",
    );
  } else if (classification.verdict !== "breaking") {
    console.log(
      "\nThe server's floor stays put unless the server stops reading older clients.\n" +
        "A client needs a server at its own generation either way, so an additive release\n" +
        "moves only CONTRACT_GENERATION.",
    );
  } else if (keepFloor) {
    console.log(
      "\nThe floor stays where it is (--keep-floor): an older peer is degraded, not misread.\n" +
        "Say which, in the commit message; only a corruption moves the floor.",
    );
  }

  if (recommendation.usage.length > 0) {
    console.log("\nThe clients already reference what was added:\n");
    for (const hit of recommendation.usage) console.log(`  ${hit}`);
    console.log(
      "\n  That is a hint for the reviewer, not a number to write: nothing moves for it.\n",
    );
  }
}

function marker(change: Change): string {
  if (change.verdict === "breaking") return "!";
  if (change.verdict === "degrading") return "~";
  return "+";
}

/**
 * Names the clients already mention.
 *
 * A new field or route the plugin/CLI already references is one the client may depend on,
 * so printing it is a hint for the reviewer. It moves no number.
 */
function clientUsage(names: readonly string[]): string[] {
  const identifiers = names.filter(
    (name) => !name.includes("/") && /^[A-Za-z_$][\w$]*$/.test(name),
  );
  if (identifiers.length === 0) return [];

  const files = sourceFiles([
    join(repoRoot, "packages", "plugin", "src"),
    join(repoRoot, "packages", "cli", "src"),
  ]);
  const hits: string[] = [];
  for (const identifier of identifiers) {
    const pattern = new RegExp(`\\b${identifier}\\b`);
    for (const file of files) {
      if (pattern.test(readFileSync(file, "utf8"))) {
        hits.push(`${identifier} (${relative(file)})`);
        break;
      }
    }
  }
  return hits;
}

function sourceFiles(directories: readonly string[]): string[] {
  const files: string[] = [];
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { recursive: true }) as string[]) {
      if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) files.push(join(directory, entry));
    }
  }
  return files;
}

/** The committed file: generation, the human decision, and the surface. */
function generationFileText(
  generation: number,
  verdict: string,
  decision: string,
  committed: Surface,
): string {
  return `${JSON.stringify(
    { generation, decision: { verdict, reason: decision }, surface: committed },
    null,
    2,
  )}\n`;
}

/** Rewrite one `export const NAME = N;` declaration in place. */
function replaceGeneration(text: string, name: string, value: number): string {
  const pattern = new RegExp(`(export const ${name} = )\\d+(;)`);
  if (!pattern.test(text)) throw new Error(`contract.ts no longer declares ${name}`);
  return text.replace(pattern, `$1${value}$2`);
}

/** Rewrite the numbers in place, leaving the prose around them untouched. */
function writeGenerations(next: Generations): void {
  const source = readFileSync(contractSource, "utf8");
  let updated = replaceGeneration(source, "CONTRACT_GENERATION", next.contract);
  updated = replaceGeneration(updated, "MIN_CLIENT_CONTRACT", next.minClient);
  writeFileSync(contractSource, updated, "utf8");
}

/** The value of `--name value` or `--name=value`. */
function argument(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline !== undefined) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function relative(file: string): string {
  return file.slice(repoRoot.length + 1).replaceAll("\\", "/");
}
