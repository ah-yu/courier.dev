/**
 * Research benchmark: what a **cold download** costs, with the read-ahead on and off,
 * on a fast link and on a link with a round trip.
 *
 * Not a test of a rule — it asserts nothing about correctness. It drives the real
 * `SyncEngine`, the real CLI adapter and a real server, and injects latency into the
 * client's transport so a run says what the round trip costs rather than what localhost
 * costs. On localhost the read-ahead has almost nothing to win (the round trip is
 * already ~0); on a 30 ms link it is the whole difference between `waves × RTT` and
 * `requests × RTT`.
 *
 * ```bash
 * COURIER_BENCH=1 bun --bun vitest run packages/e2e/src/research/download-read-ahead.bench.test.ts
 * ```
 *
 * `COURIER_BENCH_FILES` sets the vault size (default 1000); `COURIER_BENCH_RTT` the
 * injected round trip in milliseconds (default `0,30`).
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, it } from "vitest";
import type { SyncApi } from "../../../engine/src/index";
import { SyncEngine, normalizeScope } from "../../../engine/src/index";
import { realPlatform } from "@courier/testing";
import { createCliSyncApi } from "../../../cli/src/api";
import { startTestServer, type TestServer } from "../harness/server";
import { createTestVault, makeVaultMaterial, type VaultMaterial } from "../harness/vault";
import { TimedApi, TimedAdapter, countFiles, makeVault } from "./timing";

const enabled = process.env.COURIER_BENCH === "1";
const FILES = Number(process.env.COURIER_BENCH_FILES ?? "1000");
const RTTS = (process.env.COURIER_BENCH_RTT ?? "0,30").split(",").map(Number);
const scope = normalizeScope({ configDir: ".obsidian" });

/**
 * The shapes to compare: the per-wave read alone, and the default read-ahead. The
 * defaults were chosen from a run that also measured 32 files per request (932 ms) and
 * 64 files per request with an 8 MiB byte cap (827 ms) at an injected 30 ms — the
 * 4 MiB cap keeps the worst-case ciphertext at ~16 MiB, and the wider batch buys 7 %.
 */
const CONFIGS: ReadonlyArray<{ label: string; contentPrefetch: false | object }> = [
  { label: "off", contentPrefetch: false },
  { label: "64 files / 4 MiB (default)", contentPrefetch: {} },
];

/**
 * The client's transport with one round trip of latency per request.
 *
 * A real network pays per request, not per byte for small notes — which is exactly the
 * term the read-ahead attacks. It is applied to the API, not to the server, because the
 * engine's own batching is what decides how many requests a download makes.
 */
class DelayedApi extends TimedApi {
  /** Content requests made (as opposed to `contentCalls`, which counts hashes). */
  contentRequests = 0;
  /** How many hashes each content request named. */
  contentBatchSizes: number[] = [];

  constructor(
    inner: SyncApi,
    private readonly rttMs: number,
  ) {
    super(inner);
  }

  private async rtt(): Promise<void> {
    if (this.rttMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.rttMs));
  }

  override async getVersionContents(
    vaultId: string,
    contentHashes: readonly string[],
  ): Promise<Array<Uint8Array | null>> {
    this.contentRequests++;
    this.contentBatchSizes.push(contentHashes.length);
    await this.rtt();
    return await super.getVersionContents(vaultId, contentHashes);
  }

  override async pull(
    vaultId: string,
    fileIds: string[],
  ): Promise<Awaited<ReturnType<TimedApi["pull"]>>> {
    await this.rtt();
    return await super.pull(vaultId, fileIds);
  }

  override async getVaultSyncIndex(
    vaultId: string,
  ): Promise<Awaited<ReturnType<TimedApi["getVaultSyncIndex"]>>> {
    await this.rtt();
    return await super.getVaultSyncIndex(vaultId);
  }
}

describe.skipIf(!enabled)("research — cold download, read-ahead on and off", () => {
  let server: TestServer;
  let material: VaultMaterial;
  const dirs: string[] = [];

  beforeAll(async () => {
    server = await startTestServer("bench user");
    material = await makeVaultMaterial();
  }, 300_000);

  afterAll(async () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    await server.close();
  }, 120_000);

  it("downloads the same vault with and without the read-ahead", async () => {
    // One remote vault, filled once by an upload bind.
    const vault = await createTestVault(server, "download-read-ahead", material);
    const seedDir = mkdtempSync(join(tmpdir(), "courier-readahead-seed-"));
    dirs.push(seedDir);
    const bytes = makeVault(seedDir, FILES);
    const seed = new SyncEngine({
      platform: realPlatform,
      vaultId: vault.id,
      adapter: new TimedAdapter(seedDir, scope),
      api: createCliSyncApi({
        serverUrl: server.serverUrl,
        userKey: server.userKey,
        getDeviceName: () => "bench-seed",
      }),
      encryptionKey: material.key,
      syncScope: scope,
    });
    await seed.initialSync({ firstBind: true });

    for (const rttMs of RTTS) {
      for (const config of CONFIGS) {
        const dir = mkdtempSync(join(tmpdir(), "courier-readahead-"));
        dirs.push(dir);
        const api = new DelayedApi(
          createCliSyncApi({
            serverUrl: server.serverUrl,
            userKey: server.userKey,
            getDeviceName: () => "bench-download",
          }),
          rttMs,
        );
        const engine = new SyncEngine({
          platform: realPlatform,
          vaultId: vault.id,
          adapter: new TimedAdapter(dir, scope),
          api,
          encryptionKey: material.key,
          syncScope: scope,
          contentPrefetch: config.contentPrefetch,
        });
        const started = performance.now();
        await engine.initialSync({ firstBind: true });
        const totalMs = performance.now() - started;
        const sizes = api.contentBatchSizes;
        console.log(
          `BENCH ${JSON.stringify({
            label: "cold download",
            config: config.label,
            rttMs,
            files: FILES + 1,
            MiB: Number((bytes / 1024 / 1024).toFixed(1)),
            totalMs: Math.round(totalMs),
            perFileMs: Number((totalMs / (FILES + 1)).toFixed(2)),
            contentRequests: sizes.length,
            widestRequest: sizes.length === 0 ? 0 : Math.max(...sizes),
            pullRequests: api.pullCalls,
            filesOnDisk: countFiles(dir),
          })}`,
        );
      }
    }
  }, 1_800_000);
});
