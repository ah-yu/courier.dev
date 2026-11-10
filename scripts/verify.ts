#!/usr/bin/env bun
/**
 * Single verification entry point for this repository (`bun run verify`).
 *
 * Runs the gates a change must pass before it counts as done, in a fixed order:
 * `docs` (the agent contract stays within its size cap and the docs index is
 * complete) -> `agent-safety` (the workspace-scoped delete helper's refusals) ->
 * `migrations` (the generated chain matches `drizzle/`) -> `contract` (the API
 * surface matches its committed generation) -> `lint` (oxlint) ->
 * `review` (the community directory's scanner, mirrored by `eslint.config.ts`) ->
 * `typecheck` (tsc --noEmit in every package) -> `test` (Vitest on Bun, every
 * project in `vitest.config.ts`).
 * Every selected gate always runs — an incomplete picture costs more than the
 * extra seconds — and each one streams its own output, so a failure can be read
 * in place.
 *
 * Read the summary at the end first: it names the failing gates and sets a
 * non-zero exit code, which makes this command usable as a CI gate as well.
 *
 * Usage:
 *   bun run verify                 # default gates: docs, agent-safety, migrations, contract, lint, review, typecheck, test
 *   bun run verify test            # only the named gates
 *   bun run verify format          # opt-in gates (formatting)
 *   bun run verify obsidian        # end-to-end against a real running Obsidian
 *   bun run verify obsidian-ci     # same suite, rendered-geometry cases skipped (CI)
 *
 * Gates: docs (AGENTS.md cap + docs index/links), agent-safety (the delete
 * helper's refusals and recursive removal), migrations (the generated chain), contract
 * (the API surface and its generation), lint, review (the community-directory scanner,
 * mirrored), typecheck, test, format
 * (`oxfmt --check`), coverage (the per-package ratchet), obsidian (real Obsidian over
 * the official CLI), obsidian-ci (the same suite without the cases that read rendered
 * geometry).
 */
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The suite runs on `bun --bun vitest`: Vitest is the runner, Bun the runtime (the
 * server's tests import `bun:sqlite` and start a real `Bun.serve`, so a Node runtime
 * cannot run them). `--bun` is what keeps Vitest inside Bun.
 */
const VITEST = ["--bun", "vitest", "run"];

/** The L3 directory, which skips itself unless `COURIER_OBSIDIAN_E2E` is set. */
const L3_ARGS = [...VITEST, "packages/e2e/src/obsidian"];

/**
 * All gates in canonical order. `default: true` gates run when no gate is named
 * on the command line; the rest are opt-in because they are narrower (format),
 * need local software running (obsidian), or cost minutes (coverage).
 */
const GATES = [
  {
    // The agent-facing docs. AGENTS.md is injected into every session, so it has a
    // hard size cap and is registered in the `docs/` index; the checker also holds
    // every relative link and `#fragment` in the docs to a real target.
    name: "docs",
    command: process.execPath,
    args: ["scripts/check-docs.ts"],
    default: true,
  },
  {
    // The helper agents use for cleanup. Its refusals (symlinks, missing
    // paths, the checkout root, .git and paths outside the checkout) and its
    // --recursive removal inside the checkout are the safety boundary, so they
    // run with every verify pass.
    name: "agent-safety",
    command: "bun",
    args: [...VITEST, "scripts/safe-delete.test.ts"],
    default: true,
  },
  {
    // The generated migration chain is committed and shipped inside the server
    // binary, so a stale file means a binary missing its last migration — a
    // missing table at run time. `build`/`build:exe` and `bun run dev` run the same
    // check; this is the one that runs in the gate everyone runs.
    name: "migrations",
    command: process.execPath,
    args: ["packages/server/scripts/generate-migrations.ts", "--check"],
    default: true,
  },
  {
    // The API contract, as a diff against the committed surface of its generation
    // (`packages/shared/contract/<n>.surface.json`). A changed field, route, error
    // code or shared constant fails here until `contract.ts` says what the change
    // means, which is what keeps an agent from shipping a wire change without a
    // generation bump. The message it prints names the numbers to write.
    name: "contract",
    command: process.execPath,
    args: ["scripts/contract/main.ts"],
    default: true,
  },
  { name: "lint", command: "bun", args: ["run", "lint"], default: true },
  {
    // The community directory reviews the repository the plugin is published from: a
    // generated mirror of `packages/plugin`, `packages/engine` and `packages/shared`, so
    // an error anywhere in that tree (not only the plugin) can fail the plugin's review.
    // `eslint.config.ts` reproduces that scan over the same three packages (its rule set,
    // its ignore list), and only the findings the directory calls errors fail it. The
    // sheet it ships is scanned too, so this gate runs Obsidian's own Stylelint config over
    // `packages/plugin/styles.css` as well. Cheap (seconds) and not a second style gate:
    // `lint` still owns this repository's own style.
    name: "review",
    command: "bun",
    args: ["run", "lint:review"],
    default: true,
  },
  { name: "typecheck", command: "bun", args: ["run", "typecheck"], default: true },
  { name: "test", command: "bun", args: ["run", "test"], default: true },
  { name: "format", command: "bun", args: ["run", "format:check"], default: false },
  {
    // The same suite as `test`, instrumented, with the per-package floors in
    // `vitest.config.ts`. Opt-in for the inner loop because instrumenting every project
    // costs a couple of minutes; CI runs it as its own step, so the floors are enforced
    // on every pull request. It is the gate that catches "a module landed without tests":
    // each floor sits at or a point or two below what its package reaches, and may only
    // be raised.
    name: "coverage",
    command: "bun",
    args: ["run", "test:coverage"],
    default: false,
  },
  {
    // Drives a real, running Obsidian (two vaults, official CLI). The suite
    // skips itself without this env var, so it never runs in the default suite.
    name: "obsidian",
    command: "bun",
    args: [...L3_ARGS],
    env: { COURIER_OBSIDIAN_E2E: "1" },
    default: false,
  },
  {
    // The same suite without the three cases that assert rendered geometry
    // (`getBoundingClientRect`, `getComputedStyle`, `styles.css`). A headless
    // CI runner has different fonts, DPI and theme, so those numbers are not a
    // product signal there; they stay on the developer's machine.
    name: "obsidian-ci",
    command: "bun",
    args: [...L3_ARGS],
    env: { COURIER_OBSIDIAN_E2E: "1", COURIER_OBSIDIAN_E2E_LAYOUT: "0" },
    default: false,
  },
];

const gateResults = resolveGates(process.argv.slice(2)).map(runGate);
printSummary(gateResults);
process.exit(gateResults.every((outcome) => outcome.ok) ? 0 : 1);

/**
 * Map CLI arguments to gates, keeping canonical order so any subset reads the
 * same way. Unknown names fail fast instead of silently running nothing.
 */
function resolveGates(names) {
  if (names.length === 0) return GATES.filter((gate) => gate.default);
  const unknown = names.filter((name) => !GATES.some((gate) => gate.name === name));
  if (unknown.length > 0) {
    console.error(`Unknown gate(s): ${unknown.join(", ")}`);
    console.error(`Available gates: ${GATES.map((gate) => gate.name).join(", ")}`);
    process.exit(2);
  }
  return GATES.filter((gate) => names.includes(gate.name));
}

/** Run one gate, streaming its output, and report how it went. */
function runGate(gate) {
  console.log(`\n=== ${gate.name}: ${gate.command} ${gate.args.join(" ")} ===`);
  const startedAt = Date.now();
  // `shell` on Windows is required to resolve the `go` and `bun` shims on PATH.
  const result = spawnSync(gate.command, gate.args, {
    cwd: gate.cwd ? join(repoRoot, gate.cwd) : repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: gate.env ? { ...process.env, ...gate.env } : process.env,
  });
  if (result.error) console.error(`[verify] ${gate.name} could not run: ${result.error.message}`);
  return { name: gate.name, ok: result.status === 0, durationMs: Date.now() - startedAt };
}

/** Print the one thing to read first: which gates failed, and how long each took. */
function printSummary(results) {
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${"-".repeat(52)}`);
  for (const result of results) {
    const status = result.ok ? "ok  " : "FAIL";
    console.log(`[${status}] ${result.name.padEnd(10)} ${(result.durationMs / 1000).toFixed(1)}s`);
  }
  console.log(
    failed.length === 0
      ? `[verify] passed — ${results.length}/${results.length} gates green`
      : `[verify] FAILED — ${failed.map((result) => result.name).join(", ")}`,
  );
}
