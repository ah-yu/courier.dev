import fs from "fs/promises";
import os from "os";
import path from "path";
import { sqlite } from "../db";
import { countDeviceNames, countUsers, countVaults } from "../db/repositories/admin";
import { buildAdminStatus } from "../handlers/status-handlers";
import { buildRuntimeResponse, cpuPercentBetween } from "../handlers/runtime-handlers";
import { appliedMigrationCount, knownMigrationCount } from "../db/migrations";
import { storageUsage } from "../lib/storage-usage";
import { measureStorageUsage } from "../lib/storage-usage-measure";
import type { WsHub } from "../handlers/ws-handlers";
import { config } from "../config";
import { VERSION } from "../version";
import { runtimeLabel } from "@courier/shared";
import type { RouteHandlers } from "../http/contract-routes";

/**
 * The host-facing admin API: everything an operator can learn **in-band**, over
 * HTTP, from the process that owns the answer.
 *
 * Two deliberately separate reads, because they have different costs:
 *
 *   - `GET /api/admin/runtime` is cheap and is polled: what this process consumes
 *     right now, what the machine looks like, who is subscribed.
 *   - `GET /api/admin/status` walks the blob store (cached for a short window)
 *     and reads the database: storage, counts, and the migration pair.
 *
 * What is **not** here, on purpose: whether the service runs, how often systemd
 * restarted it, why it stopped, its journal, and the installed binary's checksum.
 * A process cannot answer for its own death, so the operator asks systemd over SSH
 * — and only when this API does not answer.
 *
 * The migration pair comes from `db/migrations.ts`: the chain is a plain array in
 * the bundle, so a Vite-processed consumer (the `packages/e2e` suite boots this
 * app) reads the same numbers the binary reports.
 */
export function adminHandlers(hub: WsHub): Pick<RouteHandlers, "admin.status" | "admin.runtime"> {
  return {
    "admin.status": async () => {
      const storage = await storageUsage({ measure: measureStorageUsage });
      const disk = await diskSpace();
      const binary = await binaryMarker();

      return {
        body: buildAdminStatus({
          storageUsedBytes: storage.bytes,
          storageLimitBytes: null, // server-wide limit not configured; enforced per-user
          dbBytes: await dbFileBytes(),
          diskTotalBytes: disk.totalBytes,
          diskUsedBytes: disk.usedBytes,
          diskFreeBytes: disk.freeBytes,
          binarySha256: binary.sha256,
          binarySize: binary.size,
          blobCount: storage.blobs,
          usersCount: await countUsers(),
          devicesCount: await countDeviceNames(),
          vaultsCount: await countVaults(),
          migrationsApplied: appliedMigrationCount(sqlite),
          migrationsKnown: knownMigrationCount(),
          version: VERSION,
        }),
      };
    },
    "admin.runtime": () => {
      const online = hub.onlineSummary();
      const memory = process.memoryUsage();
      const cpu = sampleCpu();

      return {
        body: buildRuntimeResponse({
          version: VERSION,
          runtime: runtimeLabel(process.versions),
          pid: process.pid,
          uptimeSeconds: process.uptime(),
          cpuMicros: cpu.micros,
          cpuPercent: cpu.percent,
          memoryBytes: memory.rss,
          cpuCount: os.cpus().length,
          loadAverage: os.loadavg(),
          freeMemoryBytes: os.freemem(),
          totalMemoryBytes: os.totalmem(),
          onlineUsers: online.users,
          onlineVaults: online.vaults,
          sampledAt: new Date(),
        }),
      };
    },
  };
}

/** The previous CPU reading, so a response can carry a share of one core. */
let previousCpuSample: { micros: number; atMs: number } | null = null;

/**
 * Read the process's cumulative CPU time and turn it into a percentage since the
 * previous read. The first read of a fresh process has nothing to compare
 * against, so it reports `null` — the page shows "sampling" rather than a zero
 * that looks idle.
 *
 * The timestamp is `performance.now()`, not `Date.now()`: two polls a fraction of
 * a millisecond apart are ordinary (a monitoring loop, a test), and a
 * millisecond-resolution delta rounds them to zero, which `cpuPercentBetween`
 * refuses — turning a busy process into a permanent "sampling" label.
 */
function sampleCpu(): { micros: number; percent: number | null } {
  const usage = process.cpuUsage();
  const micros = usage.user + usage.system;
  const now = performance.now();

  let percent: number | null = null;
  if (previousCpuSample) {
    percent = cpuPercentBetween(
      previousCpuSample.micros,
      micros,
      (now - previousCpuSample.atMs) / 1000,
    );
  }
  previousCpuSample = { micros, atMs: now };
  return { micros, percent };
}

async function dbFileBytes(): Promise<number> {
  try {
    const st = await fs.stat(config.SQLITE_PATH);
    return st.size;
  } catch {
    return 0;
  }
}

/**
 * The filesystem the data directory sits on, from `statfs`. `statfs` is one
 * syscall, so the process can answer this in-band; the operator only falls back
 * to `df` over SSH when the process is not there to ask.
 *
 * `used` follows `df` (total minus blocks free to everyone); `free` is what an
 * unprivileged process may still write (`bavail`), which is the number a person
 * means by "available".
 */
async function diskSpace(): Promise<{ totalBytes: number; usedBytes: number; freeBytes: number }> {
  try {
    const stats = await fs.statfs(path.dirname(config.SQLITE_PATH));
    const blockSize = stats.bsize;
    return {
      totalBytes: stats.blocks * blockSize,
      usedBytes: (stats.blocks - stats.bfree) * blockSize,
      freeBytes: stats.bavail * blockSize,
    };
  } catch {
    return { totalBytes: 0, usedBytes: 0, freeBytes: 0 };
  }
}

/**
 * The build marker the deployment writes beside the installed binary
 * (`~/courier/.courier-binary`, `<sha256> <size>`). Reading it here lets an
 * operator run a release check over HTTP; SSH is then needed only for facts a
 * process cannot answer, not for a file next to itself.
 */
async function binaryMarker(): Promise<{ sha256: string; size: number }> {
  try {
    const content = await fs.readFile(
      path.join(path.dirname(process.execPath), ".courier-binary"),
      "utf8",
    );
    const fields = content.trim().split(/\s+/);
    const size = Number(fields[1]);
    if (fields.length !== 2 || fields[0] === "" || !Number.isFinite(size)) {
      return { sha256: "", size: 0 };
    }
    return { sha256: fields[0], size };
  } catch {
    return { sha256: "", size: 0 };
  }
}
