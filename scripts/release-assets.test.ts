import assert from "assert/strict";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { test } from "vitest";

import { assetName, RELEASE_TARGETS } from "../packages/build/src/index.ts";

/**
 * `@courier/build` is the single table of release targets, but its two consumers outside
 * TypeScript are plain text: `install.sh` (a shell `case`) and the release workflow's
 * expected-asset list. Nothing type-checks those, so a platform added to `RELEASE_TARGETS`
 * and forgotten in either one ships an asset no installer picks up, or one the release
 * publishes without ever verifying. These tests are that check.
 *
 * They also pin the duplication the table replaced: both manifest generators derive their
 * platform ids from `RELEASE_TARGETS`, so a hand-written id list cannot reappear.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf-8");

test("every release target has a unique platform id and asset name", () => {
  const platforms = RELEASE_TARGETS.map((target) => target.platform);
  assert.equal(new Set(platforms).size, platforms.length, "duplicate platform id");

  const assets = RELEASE_TARGETS.flatMap((target) => [
    assetName("courier-cli", target),
    assetName("courier-server", target),
  ]);
  assert.equal(new Set(assets).size, assets.length, "two targets share an asset name");
});

test("install.sh installs exactly the Linux targets the build compiles", () => {
  const arms = [
    ...read("install.sh").matchAll(/^\s*(Linux:[^)]+)\)\s*asset=(\S+);\s*platform=(\S+)\s*;;/gm),
  ].map((match) => ({ pattern: match[1], asset: match[2], platform: match[3] }));
  const linux = RELEASE_TARGETS.filter((target) => target.platform.startsWith("linux-"));

  assert.equal(arms.length, linux.length, "an installer arm and a Linux target disagree");
  for (const target of linux) {
    const expected = assetName("courier-cli", target);
    const arm = arms.find((candidate) => candidate.asset === expected);
    assert.ok(arm, `install.sh has no case for ${expected}`);
    assert.equal(arm.platform, target.platform, `${expected} installs as the wrong platform id`);
    assert.match(arm.pattern, /^Linux:/);
  }

  // A 64-bit ARM kernel reports either name, and both must reach the same asset.
  const arm64 = arms.find((arm) => arm.platform === "linux-arm64");
  assert.ok(arm64, "install.sh has no arm64 case");
  assert.match(arm64.pattern, /aarch64/, "install.sh does not accept the aarch64 machine name");
  assert.match(arm64.pattern, /\barm64\b/, "install.sh does not accept the arm64 machine name");
});

test("the release job verifies every asset it publishes", () => {
  const workflow = read(".github/workflows/release.yml");
  // The expected-file block of the `release` job: the names between `for asset in \` and
  // the loop's `; do`. A rename of the step moves this text and must fail here, not pass
  // silently.
  const block = /for asset in \\\n([\s\S]*?); do/.exec(workflow)?.[1];
  assert.ok(block, "the release job's expected-asset list is not where this test looks");

  for (const target of RELEASE_TARGETS) {
    for (const prefix of ["courier-server", "courier-cli"]) {
      const asset = assetName(prefix, target);
      assert.ok(block.includes(asset), `${asset} is published without being verified`);
      assert.ok(
        block.includes(`${asset}.sha256`),
        `${asset}.sha256 is published without being verified`,
      );
    }
  }
});
