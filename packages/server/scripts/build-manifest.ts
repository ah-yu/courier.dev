#!/usr/bin/env bun
/**
 * Generate the release manifest an installer reads to answer "is the
 * service on my server older than the published build?".
 *
 * An installer downloads this file (a few kilobytes) rather than the ~130 MB
 * binary: the manifest carries the `sha256` that identifies the build, so an
 * upgrade is recognised without transferring anything. The asset name and the
 * `<asset>.sha256` file beside it are the published convention (see
 * `docs/release.md`).
 *
 * The file is deliberately named `courier-server-manifest.json`, not
 * `manifest.json`: the same GitHub release also carries the Obsidian plugin,
 * whose manifest must keep that exact name.
 *
 * One manifest serves every published deployment target, keyed by the platform id the
 * asset name uses — the same shape as `courier-cli-manifest.json`, because one release now
 * carries a linux-arm64 binary beside the linux-x64 one. A deployment reads its own entry
 * instead of the manifest describing a single architecture. The linux-x64 entry is *also*
 * repeated as the top-level `asset` / `sha256` / `size`, because clients released before
 * the map existed read exactly those three fields (see the comment on `legacy` below).
 *
 * Usage:
 *   bun run --filter @courier/server manifest
 *   bun run --filter @courier/server manifest \
 *     --dir build --out build/courier-server-manifest.json --notes "first public release"
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { assetName, RELEASE_TARGETS } from "@courier/build";

const packageDir = dirname(import.meta.dir);
/** Published beside the binaries; see the header comment for why it is not `manifest.json`. */
const MANIFEST_NAME = "courier-server-manifest.json";
/**
 * Platform id → asset name, derived from the build table so the two cannot drift. Only the
 * Linux targets are published: the darwin and Windows binaries are convenience builds for
 * a developer's own machine, while a deployment is a Linux host, and the manifest is what
 * a deployment reads. An entry is written only for a binary that exists, so a hand build
 * of one target still produces a manifest.
 */
const TARGETS: Record<string, string> = Object.fromEntries(
  RELEASE_TARGETS.filter((target) => target.platform.startsWith("linux-")).map((target) => [
    target.platform,
    assetName("courier-server", target),
  ]),
);

/** Parse `--key value` pairs; anything unknown is an error rather than silence. */
interface ManifestOptions {
  dir?: string;
  out?: string;
  notes?: string;
}

function parseArgs(argv: string[]): ManifestOptions {
  const known = new Set(["dir", "out", "notes"]);
  const values: ManifestOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    // `bun run script -- args` passes the separator through on some shells
    // (and strips it on others); accept it as the conventional end-of-options
    // marker either way.
    if (key === "--") continue;
    if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
    const name = key.slice(2);
    if (!known.has(name)) throw new Error(`unknown option: ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`option ${key} needs a value`);
    }
    values[name as keyof ManifestOptions] = value;
    i += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const dir = resolve(packageDir, args.dir ?? "build");
const outPath = resolve(packageDir, args.out ?? join(dir, MANIFEST_NAME));
const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf-8"));

const assets: Record<string, { asset: string; sha256: string; size: number }> = {};
for (const [platform, asset] of Object.entries(TARGETS)) {
  const binaryPath = join(dir, asset);
  if (!existsSync(binaryPath)) continue;
  const binary = readFileSync(binaryPath);
  const sha256 = new Bun.CryptoHasher("sha256").update(binary).digest("hex");
  assets[platform] = {
    asset: basename(asset),
    sha256,
    size: statSync(binaryPath).size,
  };
  // The same shape `sha256sum` writes, so a download can also be checked by hand.
  writeFileSync(`${binaryPath}.sha256`, `${sha256}  ${basename(asset)}\n`);
}

if (Object.keys(assets).length === 0) {
  throw new Error(`no server binaries found in ${dir}; run build:exe first`);
}

/**
 * The linux-x64 entry as the top-level `asset` / `sha256` / `size` too.
 *
 * Every 0.1.x deployment installer and the desktop app's update check read those three
 * fields directly; only `assets` readers know about the map. The pair that has to keep
 * working is "a client built before the map existed" × "the manifest a later release
 * publishes", and no repository-side policy can retract a parser that is already installed.
 * So both shapes are emitted: the trio names the x64 deployment asset until no 0.1.x client
 * is in use, and `assets` is what everything newer reads (`docs/cli.md`,
 * `docs/release.md`). A hand build that produced only the arm64 binary has no x64 asset to
 * name, and omits the trio rather than pointing an old client at the wrong file.
 */
const legacy = assets["linux-x64"];

const manifest = {
  version: pkg.version,
  ...(legacy ? { asset: legacy.asset, sha256: legacy.sha256, size: legacy.size } : {}),
  publishedAt: new Date().toISOString(),
  ...(args.notes ? { notes: args.notes } : {}),
  assets,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}`);
for (const [platform, entry] of Object.entries(assets)) {
  console.log(`${platform} ${entry.asset} ${entry.sha256.slice(0, 12)}… ${entry.size} bytes`);
}
