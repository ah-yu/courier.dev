#!/usr/bin/env bun
/**
 * Build the service's release binaries into `build/` — one per target in `@courier/build`.
 *
 * Run it as `bun run --filter @courier/server build:exe` (that script also refuses a stale
 * generated migration chain first). The compile itself lives in `@courier/build`: the
 * targets, the asset naming and the baked-in build identity are the same for both binaries
 * this repository ships, and only the entry point and the asset prefix differ.
 */
import { resolve } from "path";
import { buildExecutables } from "@courier/build";

await buildExecutables({
  packageDir: resolve(import.meta.dir, ".."),
  entry: "src/main.ts",
  prefix: "courier-server",
});
