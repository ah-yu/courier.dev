#!/usr/bin/env bun
/**
 * Generate the release manifest an installer reads to install and upgrade the
 * headless CLI.
 *
 * The installer must know three things before replacing a binary: which asset belongs to
 * this machine, which checksum identifies it, and which version it is. The first two are
 * per platform, so this manifest carries an `assets` map keyed by the release's platform
 * id — the same shape `courier-server-manifest.json` uses since the server also ships more
 * than one Linux target.
 *
 * Usage:
 *   bun run --filter @courier/cli manifest
 *   bun run --filter @courier/cli manifest -- --dir build --out build/courier-cli-manifest.json \
 *     --notes "first public release"
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { assetName, RELEASE_TARGETS } from "@courier/build";

const packageDir = dirname(import.meta.dir);
/** Published beside the binaries; never `manifest.json`, which belongs to the plugin. */
const MANIFEST_NAME = "courier-cli-manifest.json";
/** Platform id → asset name, derived from the build table so the two cannot drift. */
const TARGETS: Record<string, string> = Object.fromEntries(
  RELEASE_TARGETS.map((target) => [target.platform, assetName("courier-cli", target)]),
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
    // `bun run script -- args` passes the separator through on some shells and
    // strips it on others; accept it either way.
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

const assets = {};
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
  throw new Error(`no CLI binaries found in ${dir}; run build:exe first`);
}

const manifest = {
  version: pkg.version,
  publishedAt: new Date().toISOString(),
  ...(args.notes ? { notes: args.notes } : {}),
  assets,
};

writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${outPath}`);
for (const [platform, entry] of Object.entries(assets) as [
  string,
  { asset: string; sha256: string; size: number },
][]) {
  console.log(`${platform} ${entry.asset} ${entry.sha256.slice(0, 12)}… ${entry.size} bytes`);
}
