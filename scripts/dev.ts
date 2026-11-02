#!/usr/bin/env bun
/**
 * Start the development loop on a free port.
 *
 * `bun run dev` used to assume 3002. Two worktrees (or a stale watcher) then fight over one
 * port, and the one started second dies with `EADDRINUSE`. This wrapper picks 3002 when it
 * is free and the next free port otherwise, then starts the workspace dev scripts with
 * `PORT` in the environment — so the server and `dev-setup.ts` agree without either side
 * guessing.
 *
 * An explicit `PORT` is a promise, not a hint: it is passed through unchanged, and a busy
 * port still fails loudly. `COURIER_DEV_SERVER_URL` keeps its meaning for the plugin side
 * (an explicit address that does not have to be local).
 */
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const FIRST_PORT = 3002;
const PORT_ATTEMPTS = 100;

/** The port in the dev loop's own state, when it names a local server. */
export function portFromDevUrl(value: unknown): number | null {
  if (typeof value !== "string" || value === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/** The port the last dev run used, so a restart keeps the same address when it can. */
function rememberedPort(): number | null {
  const statePath = join(repoRoot, ".courier-dev", "dev.json");
  if (!existsSync(statePath)) return null;
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    return portFromDevUrl(state?.serverUrl);
  } catch {
    return null;
  }
}

/** Whether a fresh server could bind `port` right now. */
async function portIsFree(port: number): Promise<boolean> {
  try {
    const probe = Bun.serve({
      port,
      fetch: () => new Response(""),
    });
    await probe.stop(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first port at or after `start` that the injected checker accepts.
 *
 * The checker is injected so the selection rule can be tested without binding sockets; the
 * real one uses the same `Bun.serve` call the dev server will.
 */
export async function firstFreePort(
  start: number,
  isFree: (port: number) => Promise<boolean>,
  attempts = PORT_ATTEMPTS,
): Promise<number> {
  for (let port = start; port < start + attempts; port++) {
    if (await isFree(port)) return port;
  }
  throw new Error(`no free port in ${start}..${start + attempts - 1}`);
}

async function main(): Promise<void> {
  const requested = (process.env.PORT ?? "").trim();
  let port: number;

  if (requested) {
    port = Number(requested);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      console.error(`[courier:dev] PORT="${requested}" is not a valid port`);
      process.exit(2);
    }
    console.log(`[courier:dev] using PORT=${port}`);
  } else {
    const remembered = rememberedPort();
    if (remembered !== null && (await portIsFree(remembered))) {
      port = remembered;
      console.log(`[courier:dev] dev server port ${port}`);
    } else {
      port = await firstFreePort(FIRST_PORT, portIsFree);
      console.log(
        port === FIRST_PORT
          ? `[courier:dev] dev server port ${port}`
          : `[courier:dev] port ${FIRST_PORT} is busy — using ${port}`,
      );
    }
  }

  const child = spawn(process.execPath, ["run", "--filter", "*", "--parallel", "dev"], {
    cwd: repoRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`[courier:dev] could not start the dev scripts: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    // Re-raising the signal is not reliable on Windows; map it to the shell's
    // conventional exit codes instead of risking an uncaught `process.kill` error.
    if (signal) process.exit(signal === "SIGINT" ? 130 : 1);
    else process.exit(code ?? 0);
  });
}

if (import.meta.main) await main();
