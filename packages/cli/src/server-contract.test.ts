import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTRACT_GENERATION } from "@courier/shared";
import {
  EXIT_CONTRACT_MISMATCH,
  ServerContractError,
  ensureCompatibleServer,
} from "./server-contract";

/**
 * The CLI's pre-flight check: it is the one thing that runs **before** the vault lease is
 * taken, so its three outcomes are what decide between "syncs", "exits 78" and "the ordinary
 * cannot-reach path".
 */
const config = { serverUrl: "http://srv.test", userKey: "ck_user" };

function health(body: Record<string, unknown>): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureCompatibleServer", () => {
  it("lets a matching server through", async () => {
    health({
      status: "ok",
      timestamp: "2026-11-10T00:00:00.000Z",
      generation: CONTRACT_GENERATION,
      minClient: 1,
      version: "0.6.0",
    });
    await expect(ensureCompatibleServer(config)).resolves.toBeUndefined();
  });

  it("refuses a server older than this build speaks", async () => {
    health({
      status: "ok",
      timestamp: "2026-11-10T00:00:00.000Z",
      generation: CONTRACT_GENERATION - 1,
      minClient: 1,
      version: "0.5.2",
    });
    await expect(ensureCompatibleServer(config)).rejects.toBeInstanceOf(ServerContractError);
  });

  it("refuses a server whose floor no longer serves this build", async () => {
    health({
      status: "ok",
      timestamp: "2026-11-10T00:00:00.000Z",
      generation: CONTRACT_GENERATION + 1,
      minClient: CONTRACT_GENERATION + 1,
      version: "0.9.0",
    });
    await expect(ensureCompatibleServer(config)).rejects.toBeInstanceOf(ServerContractError);
  });

  it("leaves an unreachable server to the caller's own retry path", async () => {
    // Only a *mismatch* exits 78. A transport failure must stay the ordinary error (and, in
    // the daemon, the retry loop), so it must not come back as this error type.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    let thrown: unknown = null;
    try {
      await ensureCompatibleServer(config);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(thrown).not.toBeInstanceOf(ServerContractError);
  });

  it("documents its exit code as sysexits EX_CONFIG", () => {
    expect(EXIT_CONTRACT_MISMATCH).toBe(78);
  });

  it("exits 78 through the action-level refusal, before any lease exists", async () => {
    // The wiring, not just the constant: `requireCompatibleServer` is what `run`,
    // `vault connect` and `vault create` call **before** they acquire the vault's lease, and
    // its whole job is to leave with 78 (a supervisor must not restart that).
    health({
      status: "ok",
      timestamp: "2026-11-10T00:00:00.000Z",
      generation: CONTRACT_GENERATION - 1,
      minClient: 1,
      version: "0.5.2",
    });
    const { requireCompatibleServer } = await import("./program");
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    try {
      const fullConfig = {
        ...config,
        deviceName: "test",
        vaults: [],
      } as unknown as Parameters<typeof requireCompatibleServer>[0];
      await expect(requireCompatibleServer(fullConfig)).rejects.toThrow("exit:78");
    } finally {
      exit.mockRestore();
    }
  });
});

describe("readContractIssue", () => {
  it("reports a window this build is outside", async () => {
    const { readContractIssue } = await import("./program");
    expect(
      await readContractIssue({
        getServerInfo: async () => ({
          status: "ok",
          timestamp: "2026-11-10T00:00:00.000Z",
          generation: 1,
          minClient: 1,
          version: "0.5.2",
        }),
      }),
    ).toEqual({ verdict: "server-too-old" });
  });

  it("answers nothing for a server it can talk to", async () => {
    const { readContractIssue } = await import("./program");
    expect(
      await readContractIssue({
        getServerInfo: async () => ({
          status: "ok",
          timestamp: "2026-11-10T00:00:00.000Z",
          generation: CONTRACT_GENERATION,
          minClient: 1,
        }),
      }),
    ).toBeNull();
  });

  it("answers nothing — and never throws — for a body that is not health, or an unreachable server", async () => {
    // The regression this pins: `status` returned from the whole block on a 200 that was not
    // the health document, so a supervisor got exit 0 and no body at all.
    const { readContractIssue } = await import("./program");
    expect(
      await readContractIssue({ getServerInfo: async () => ({ error: "UPSTREAM_ERROR" }) }),
    ).toBeNull();
    expect(await readContractIssue({ getServerInfo: async () => null })).toBeNull();
    expect(
      await readContractIssue({
        getServerInfo: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    ).toBeNull();
  });
});
