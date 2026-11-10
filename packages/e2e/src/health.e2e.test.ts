import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CONTRACT_GENERATION,
  CONTRACT_HEADER,
  MIN_CLIENT_CONTRACT,
  contractVerdict,
} from "@courier/shared";
import { startTestServer, type TestServer } from "./harness/server";

/**
 * The liveness probe `docs/api.md` §1 documents, and the contract gate behind it.
 *
 * The probe is the one route with no auth and no data, so what is worth pinning is that it
 * answers **without** a key, with the documented shape, and with the numbers a peer needs
 * to decide whether it can talk to this server at all.
 *
 * The gate is the other half: a real server and the headers older or newer builds would
 * send. This is the only place all four corners of the window run against the route table
 * rather than against a mock.
 */
describe("health e2e — the probe, and the contract gate behind it", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer("health user");
  });

  afterAll(async () => {
    await server.close();
  });

  /** One `ck_` request, with whatever contract header the caller wants. */
  const call = (generation?: number): Promise<Response> =>
    fetch(`${server.serverUrl}/api/vaults`, {
      headers: {
        Authorization: `Bearer ${server.userKey}`,
        ...(generation === undefined ? {} : { [CONTRACT_HEADER]: String(generation) }),
      },
    });

  it("answers without a key, with the documented shape", async () => {
    const response = await fetch(`${server.serverUrl}/api/health`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { status?: string; timestamp?: string };
    expect(body.status).toBe("ok");
    // A stamp a monitor can parse, not just some string.
    expect(Number.isNaN(Date.parse(body.timestamp ?? ""))).toBe(false);
  });

  it("publishes the generations this build speaks", async () => {
    const health = (await (await fetch(`${server.serverUrl}/api/health`)).json()) as {
      generation?: number;
      minClient?: number;
      version?: string;
    };
    expect(health.generation).toBe(CONTRACT_GENERATION);
    expect(health.minClient).toBe(MIN_CLIENT_CONTRACT);
    expect(typeof health.version).toBe("string");
  });

  it("serves a client of this generation", async () => {
    const response = await call(CONTRACT_GENERATION);
    expect(response.status).toBe(200);
  });

  it("serves a client that sends no header at all, as generation 1", async () => {
    const response = await call();
    expect(response.status).toBe(MIN_CLIENT_CONTRACT <= 1 ? 200 : 426);
  });

  it("refuses a client below the server's floor with 426 and both numbers", async () => {
    // One generation below the floor, whatever the floor currently is. While the floor is
    // 1 there is no such client: generation 0 does not exist, so the header reads as 1 and
    // is served — the refusal only has meaning once a breaking change has moved the floor.
    const stale = MIN_CLIENT_CONTRACT - 1;
    const response = await call(stale);
    if (MIN_CLIENT_CONTRACT <= 1) {
      expect(response.status).toBe(200);
      return;
    }
    expect(response.status).toBe(426);
    const body = (await response.json()) as {
      error?: string;
      serverContract?: number;
      clientContract?: number;
      minClient?: number;
    };
    expect(body.error).toBe("CONTRACT_MISMATCH");
    expect(body.clientContract).toBe(stale);
    expect(body.serverContract).toBe(CONTRACT_GENERATION);
    expect(body.minClient).toBe(MIN_CLIENT_CONTRACT);
  });

  it("refuses a client from a newer generation, because it cannot know what it says", async () => {
    const response = await call(CONTRACT_GENERATION + 1);
    expect(response.status).toBe(426);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toBe("CONTRACT_MISMATCH");
  });

  it("refuses before it reads the key: an unusable pair is not a credential failure", async () => {
    const response = await fetch(`${server.serverUrl}/api/vaults`, {
      headers: { [CONTRACT_HEADER]: String(CONTRACT_GENERATION + 1) },
    });
    expect(response.status).toBe(426);
  });

  it("leaves the probe itself unguarded, so a mismatched peer can be told why", async () => {
    const response = await fetch(`${server.serverUrl}/api/health`, {
      headers: { [CONTRACT_HEADER]: String(CONTRACT_GENERATION + 1) },
    });
    expect(response.status).toBe(200);
  });

  it("agrees with the verdict the clients compute", async () => {
    const health = (await (await fetch(`${server.serverUrl}/api/health`)).json()) as {
      generation?: number;
      minClient?: number;
    };
    expect(contractVerdict(health)).toBe("ok");
    // A peer left behind by a newer floor is told to upgrade the client, and one older than
    // this build's own generation is told to upgrade the server — the second is the case
    // that would otherwise be a 426 on every request with no message.
    expect(contractVerdict({ ...health, minClient: CONTRACT_GENERATION + 1 })).toBe(
      "client-too-old",
    );
    expect(contractVerdict({ generation: CONTRACT_GENERATION - 1, minClient: 1 })).toBe(
      CONTRACT_GENERATION > 1 ? "server-too-old" : "ok",
    );
  });
});
