#!/usr/bin/env bun
/**
 * `bun run contract` — the API contract, as a gate an agent cannot skip.
 *
 * `check` (the default, and the mode `bun run verify` runs) compares the code's observable
 * surface with `packages/shared/contract/<CONTRACT_GENERATION>.surface.json`. Any change
 * fails and prints what changed, what it means, and the three numbers to write — so the
 * decision is in front of whoever made the change, not in a document they did not read.
 *
 * `bump --write` applies that decision: it moves `CONTRACT_GENERATION` (and, for a breaking
 * change, both floors) in `packages/shared/src/contract.ts`, and writes the next
 * generation's surface file. `write` exists only to create the first file for a generation.
 *
 * See `docs/api.md` → "Contract generation" for the rules, and
 * `packages/shared/src/contract.ts` for the same table next to the numbers.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { addedNames, classify, type Classification, type Change } from "./classify";
import {
  formatSurface,
  readGenerations,
  readSurface,
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

const generations = readGenerations(repoRoot);
const surface = readSurface(repoRoot);
const generationFile = join(contractDirectory, `${generations.contract}.surface.json`);

switch (command) {
  case "check":
    check();
    break;
  case "bump":
    bump();
    break;
  case "write":
    createFirstSurface();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: bun run contract [check | bump [--write] | write]");
    process.exit(2);
}

/** The gate: the code must match the surface committed for its own generation. */
function check(): void {
  if (!existsSync(generationFile)) {
    console.error(
      `contract: generation ${generations.contract} has no surface file.\n` +
        `  Expected: ${relative(generationFile)}\n` +
        "  Create it with `bun run contract write` (first import), or restore the generation\n" +
        "  constants and run `bun run contract bump --write` instead of editing them by hand.",
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
      "  Run `bun run contract bump --write` to apply the numbers above.\n" +
      "  If the change is meant to be invisible to peers, put it back.\n",
  );
  process.exit(1);
}

/** Classify the diff against the current generation and (with `--write`) apply it. */
function bump(): void {
  if (!existsSync(generationFile)) {
    console.error(
      `contract: generation ${generations.contract} has no surface file to compare against.\n` +
        "  Run `bun run contract write` first, or restore the generation constants.",
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

  const target = join(contractDirectory, `${next.generations.contract}.surface.json`);
  if (existsSync(target)) {
    console.error(`contract: ${relative(target)} already exists; generations only move forward.`);
    process.exit(1);
  }

  writeGenerations(next.generations);
  mkdirSync(contractDirectory, { recursive: true });
  writeFileSync(target, formatSurface(surface), "utf8");
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
        "  A changed surface is a generation bump: `bun run contract bump --write`.",
    );
    process.exit(1);
  }
  mkdirSync(contractDirectory, { recursive: true });
  writeFileSync(generationFile, formatSurface(surface), "utf8");
  console.log(`contract: wrote ${relative(generationFile)} for generation ${generations.contract}`);
}

/** A recommendation: the three numbers, plus the client references that moved a floor. */
interface Plan {
  generations: Generations;
  usage: string[];
}

/** The three numbers the classification asks for. */
function plan(classification: Classification): Plan {
  const next = generations.contract + 1;
  if (classification.verdict === "breaking") {
    return { generations: { contract: next, minClient: next, minServer: next }, usage: [] };
  }

  const usage = assumeClientUsage
    ? ["assumed (--server)"]
    : denyClientUsage
      ? []
      : clientUsage(addedNames(classification.changes));

  return {
    generations: {
      contract: next,
      minClient: generations.minClient,
      minServer: usage.length > 0 ? next : generations.minServer,
    },
    usage,
  };
}

function printClassification(classification: Classification): void {
  const heading =
    classification.verdict === "breaking"
      ? "breaking: an older peer would misread this change"
      : "additive: an older peer still reads this correctly";
  console.log(`contract generation ${generations.contract}: the surface changed — ${heading}\n`);
  for (const change of classification.changes) {
    console.log(`  ${marker(change)} ${change.path}`);
    console.log(`      ${change.detail}`);
  }
}

function printRecommendation(classification: Classification, recommendation: Plan): void {
  const next = recommendation.generations;
  console.log("\nThe three numbers in packages/shared/src/contract.ts:\n");
  console.log(`  CONTRACT_GENERATION = ${next.contract}`);
  console.log(`  MIN_CLIENT_CONTRACT = ${next.minClient}`);
  console.log(`  MIN_SERVER_CONTRACT = ${next.minServer}`);

  if (classification.verdict !== "breaking") {
    console.log(
      "\nBoth minimums stay put unless a peer depends on what was added:\n" +
        "  MIN_CLIENT_CONTRACT moves when the server stops reading older clients.\n" +
        "  MIN_SERVER_CONTRACT moves when a client needs something the server did not have.",
    );
  }

  if (recommendation.usage.length > 0) {
    console.log("\nThe clients already mention what was added, so MIN_SERVER_CONTRACT moves:\n");
    for (const hit of recommendation.usage) console.log(`  ${hit}`);
    console.log(
      "\n  If the client tolerates the field being absent, edit the number back and say why.\n",
    );
  }
}

function marker(change: Change): string {
  return change.verdict === "breaking" ? "!" : "+";
}

/**
 * Names the clients already mention.
 *
 * A new field or route the plugin/CLI already references is one the client may depend on,
 * so the recommendation moves `MIN_SERVER_CONTRACT` (an extra prompt, never a silent
 * failure). A common word in a field name can produce a false positive here; the printed
 * files make that visible, and the numbers can be edited back with a reason.
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

function readSurfaceFile(file: string): Surface {
  return JSON.parse(readFileSync(file, "utf8")) as Surface;
}

/** Rewrite one `export const NAME = N;` declaration in place. */
function replaceGeneration(text: string, name: string, value: number): string {
  const pattern = new RegExp(`(export const ${name} = )\\d+(;)`);
  if (!pattern.test(text)) throw new Error(`contract.ts no longer declares ${name}`);
  return text.replace(pattern, `$1${value}$2`);
}

/** Rewrite the three numbers in place, leaving the prose around them untouched. */
function writeGenerations(next: Generations): void {
  const source = readFileSync(contractSource, "utf8");
  let updated = replaceGeneration(source, "CONTRACT_GENERATION", next.contract);
  updated = replaceGeneration(updated, "MIN_CLIENT_CONTRACT", next.minClient);
  updated = replaceGeneration(updated, "MIN_SERVER_CONTRACT", next.minServer);
  writeFileSync(contractSource, updated, "utf8");
}

function relative(file: string): string {
  return file.slice(repoRoot.length + 1).replaceAll("\\", "/");
}
