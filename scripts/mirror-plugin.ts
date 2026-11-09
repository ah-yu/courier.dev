#!/usr/bin/env bun
/**
 * Generate the publishing mirror the Obsidian community directory points at.
 *
 * The directory reviews a plugin as **the whole repository it was submitted from**: it lints
 * every file the repository holds, with a fixed ignore list and no way to opt out. This
 * monorepo holds a server, a CLI and their end-to-end suites, and a scan of that tree
 * reports findings against code that is not the plugin and cannot be made to satisfy
 * Obsidian's plugin rules.
 *
 * So the plugin is published from a second repository that holds **only** what the plugin
 * needs: the plugin, the two packages it imports, and its release workflow. This script
 * produces that tree. It is deliberately a one-way generation — `courier.dev` is the only
 * place anything is edited, and the mirror is expected to be replaced wholesale.
 *
 *     bun scripts/mirror-plugin.ts --out <dir>     # generate (and install a lockfile)
 *
 * What lands in the mirror, and why:
 *
 * - `packages/{plugin,engine,shared}` with every test file (`*.test.*`, including a suite's
 *   shared fixtures such as `engine.test-helpers.ts`) and `__mocks__` removed: the mirror
 *   runs no tests, and their imports (`vitest`, `@courier/testing`) are workspace packages
 *   that do not exist there.
 * - `manifest.json` at the root: the directory reads it from the default branch, and the
 *   release assets are staged from it.
 * - `package.json` + `bun.lock` generated here, so `bun install --frozen-lockfile` works in
 *   a checkout that has no monorepo above it.
 * - `.github/workflows/release.yml` from `.github/mirror/release.yml`: the mirror builds and
 *   attests its own `main.js`, which is what makes the directory's build verification and
 *   artifact attestation checks meaningful.
 * - the plugin's `scripts/` reduced to `build.ts`: a release needs the bundler and nothing
 *   else, and the development bootstrap imports fixtures that are not copied.
 *
 * The mirror deliberately carries no linter and no test runner. The review scan runs in
 * Obsidian's own service against this tree, and the equivalent gate runs in `courier.dev`
 * over the same three packages before anything is published — duplicating either here
 * would only be a second place to keep in step.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, relative } from "path";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const out = outIndex === -1 ? null : args[outIndex + 1];
const force = args.includes("--force");
const skipLockfile = args.includes("--no-lockfile");

if (!out) {
  console.error("usage: bun scripts/mirror-plugin.ts --out <dir> [--force] [--no-lockfile]");
  process.exit(2);
}

const repoRoot = join(import.meta.dir, "..");
const target = join(out);
const PACKAGES = ["plugin", "engine", "shared"] as const;

/** The source repository, as `owner/name`, named in the generated README and links. */
const SOURCE_REPO = "ah-yu/courier.dev";

function read(rel: string): string {
  return readFileSync(join(repoRoot, rel), "utf8");
}

function readJson(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel)) as Record<string, unknown>;
}

/** A path the mirror must not receive: build output, tests, or another checkout's state. */
function excluded(rel: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.some((part) => part === "node_modules" || part === "dist" || part === ".git"))
    return true;
  if (parts.some((part) => part === "__mocks__")) return true;
  // `*.test.ts`/`*.test.js`, and a suite's shared fixtures (`*.test-helpers.ts`): the mirror
  // runs no tests, and those files import `vitest` / `@courier/testing`, which it lacks.
  const base = parts[parts.length - 1] ?? "";
  return /\.test(?:[.-]|$)/.test(base);
}

/** Copy the package trees, minus the files a release artifact has no use for. */
function copyPackage(name: string): void {
  const from = join(repoRoot, "packages", name);
  const to = join(target, "packages", name);
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = relative(from, src);
      return rel === "" || !excluded(rel);
    },
  });

  const manifestPath = join(to, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  // `@courier/testing` is not copied, and the mirror runs no tests: a workspace protocol
  // pointing at a package that is not there makes `bun install` fail outright.
  if (manifest.devDependencies) {
    delete manifest.devDependencies["@courier/testing"];
    if (Object.keys(manifest.devDependencies).length === 0) delete manifest.devDependencies;
  }
  if (name === "plugin") {
    // Dev-vault bootstrap and the vault installer only exist inside the monorepo.
    if (manifest.scripts) {
      for (const script of ["dev", "setup:vault"]) delete manifest.scripts[script];
    }
    // `build.ts` is the only script a release needs; the rest bootstrap a development
    // vault (and import the fixtures that are not copied).
    const scripts = join(to, "scripts");
    for (const entry of readdirSync(scripts)) {
      if (entry !== "build.ts") rmSync(join(scripts, entry), { recursive: true, force: true });
    }
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeRootManifest(): void {
  const root = readJson("package.json") as { devDependencies?: Record<string, string> };
  const pin = (name: string): string => {
    const version = root.devDependencies?.[name];
    if (!version) throw new Error(`root package.json has no devDependency ${name}`);
    return version;
  };
  const manifest = {
    name: "courier-obsidian",
    private: true,
    type: "module",
    // The same workspace shape the monorepo has, so `workspace:*` inside the three
    // packages resolves without rewriting them to versions that are not published.
    workspaces: ["packages/*"],
    scripts: {
      build: "bun run --filter @courier/plugin build",
      typecheck: "bun run --filter '*' typecheck",
    },
    // The whole toolchain this tree needs: `tsc` for the plugin's type-only build, and the
    // Bun types the plugin's tsconfig asks for. Everything else is a runtime dependency.
    //
    // No `overrides` block, though the repository has one: it is there because the workspace
    // resolves a second typescript for the review linter, and this tree ships no linter and
    // resolves a single compiler of its own. `bun install --lockfile-only` below proves it.
    devDependencies: {
      "@types/bun": pin("@types/bun"),
      typescript: pin("typescript"),
    },
  };
  writeFileSync(join(target, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeReadme(): void {
  const sha = git(["rev-parse", "--short", "HEAD"]).trim();
  const banner = [
    "<!-- Generated by scripts/mirror-plugin.ts in courier.dev — do not edit this repository. -->",
    "",
    `> **This repository is a build artifact.** It is generated from`,
    `> [courier.dev](https://github.com/${SOURCE_REPO}) at \`${sha}\` and replaced wholesale on every`,
    `> release. The source, the issue tracker and pull requests all live in`,
    `> [courier.dev](https://github.com/${SOURCE_REPO}); nothing here is edited by hand.`,
    "",
  ].join("\n");
  writeFileSync(join(target, "README.md"), `${banner}\n${read("packages/plugin/README.md")}`);
}

function git(cliArgs: string[]): string {
  const result = Bun.spawnSync(["git", ...cliArgs], { cwd: repoRoot });
  if (result.exitCode !== 0) throw new Error(`git ${cliArgs.join(" ")} failed`);
  return result.stdout.toString();
}

/** Install the three packages' dependencies and write the lockfile the mirror commits. */
function writeLockfile(): void {
  const result = Bun.spawnSync(["bun", "install", "--lockfile-only"], {
    cwd: target,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error("bun install --lockfile-only failed");
}

if (existsSync(target) && readdirSync(target).length > 0) {
  if (!force) {
    console.error(`${target} is not empty; pass --force to replace it`);
    process.exit(1);
  }
  for (const entry of readdirSync(target))
    rmSync(join(target, entry), { recursive: true, force: true });
}
mkdirSync(join(target, ".github", "workflows"), { recursive: true });

for (const name of PACKAGES) copyPackage(name);

cpSync(join(repoRoot, "packages", "plugin", "manifest.json"), join(target, "manifest.json"));
cpSync(join(repoRoot, "LICENSE"), join(target, "LICENSE"));
cpSync(join(repoRoot, ".bun-version"), join(target, ".bun-version"));
cpSync(join(repoRoot, "tsconfig.base.json"), join(target, "tsconfig.base.json"));
cpSync(
  join(repoRoot, ".github", "mirror", "release.yml"),
  join(target, ".github", "workflows", "release.yml"),
);

writeRootManifest();
writeReadme();
writeFileSync(join(target, ".gitignore"), "node_modules/\ndist/\n");

if (!skipLockfile) writeLockfile();

const files = readdirSync(target).toSorted();
console.log(`mirror written to ${target}`);
console.log(`  ${files.join("  ")}`);
console.log(`  packages/${PACKAGES.join(", packages/")}`);
