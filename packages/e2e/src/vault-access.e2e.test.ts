import { createHash } from "crypto";
import { join } from "path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPushBody } from "../../shared/src/index";
import { startTestServer, type TestServer } from "./harness/server";

/**
 * Who may use a vault, at the wire.
 *
 * The ownership rule itself is a unit test (`server/src/lib/vault-access.test.ts`),
 * but what a unit test cannot answer is whether the rule is actually **applied**
 * on every way into a vault: the five sync routes and the WebSocket
 * subscription. Before this suite existed, any valid `ck_` user key plus someone
 * else's vault id could push, pull, read the history and empty the recycle bin —
 * the content is encrypted, but integrity and quota are not.
 *
 * The last case pins the other half of the contract: `GET /api/vaults` (which
 * filters in SQL) and the sync surface (which filters in TypeScript) have to
 * agree about which vault ids a given key may reach.
 */

interface CreatedUser {
  id: string;
  key: string;
}

async function createUser(
  server: TestServer,
  name: string,
  limits: { maxVaults?: number } = {},
): Promise<CreatedUser> {
  const response = await fetch(`${server.serverUrl}/api/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.hostKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...limits }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as CreatedUser;
}

async function createVault(server: TestServer, userKey: string, name: string): Promise<string> {
  const response = await fetch(`${server.serverUrl}/api/vaults`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, encryptionSalt: "salt", keyCheck: "canary" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/** The 64-hex content hash the push contract asks for. */
function hashOf(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function pushBody(fileId: string, contentLabel: string): Uint8Array {
  const plain = new TextEncoder().encode(contentLabel);
  // A payload shaped like a real one: IV and tag in front of the plaintext.
  const content = new Uint8Array(plain.byteLength + 28);
  content.set(plain, 28);
  const contentHash = hashOf(contentLabel);
  return buildPushBody([
    {
      fileId,
      encryptedPath: "cGF0aA==",
      content,
      action: "create",
      versionId: contentHash.slice(0, 16),
      contentHash,
      sizeBytes: plain.byteLength,
      mtimeMs: 0,
      baseVersionId: null,
      historyKind: "documents",
    },
  ]);
}

interface Answer {
  status: number;
  body: Record<string, unknown>;
}

async function push(
  server: TestServer,
  vaultId: string,
  userKey: string,
  body: Uint8Array,
): Promise<Answer> {
  const response = await fetch(`${server.serverUrl}/api/vaults/${vaultId}/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userKey}`, "Content-Type": "application/octet-stream" },
    body: body as unknown as BodyInit,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function jsonRequest(
  server: TestServer,
  path: string,
  userKey: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Answer> {
  const response = await fetch(`${server.serverUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${userKey}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The ids `GET /api/vaults` reports for one key. */
async function listedVaultIds(server: TestServer, userKey: string): Promise<string[]> {
  const answer = await jsonRequest(server, "/api/vaults", userKey);
  expect(answer.status).toBe(200);
  const vaults = answer.body.vaults as Array<{ id: string }>;
  return vaults.map((vault) => vault.id).toSorted();
}

/** The five sync routes, as a request each, for the "every way in" assertion. */
async function syncSurface(
  server: TestServer,
  vaultId: string,
  userKey: string,
): Promise<Answer[]> {
  return [
    await push(server, vaultId, userKey, pushBody("file-1", "x")),
    await jsonRequest(server, `/api/vaults/${vaultId}/sync/pull`, userKey, {
      method: "POST",
      body: { files: [{ fileId: "file-1" }] },
    }),
    await jsonRequest(server, `/api/vaults/${vaultId}/sync/history`, userKey),
    await jsonRequest(server, `/api/vaults/${vaultId}/sync/deleted`, userKey),
    await jsonRequest(server, `/api/vaults/${vaultId}/sync/deleted/clear`, userKey, {
      method: "POST",
    }),
  ];
}

/**
 * Send one `subscribe` and answer the first message the server sends back.
 *
 * A raw socket rather than the engine's `SyncWebSocket`: the point here is the
 * message text, which the client turns into a connection state and drops.
 */
function subscribe(
  server: TestServer,
  vaultId: string,
  userKey: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(server.wsUrl);
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("the server never answered the subscribe"));
    }, 5_000);
    const done = (message: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.close();
      resolve(message);
    };
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", vaultId, userKey, deviceName: "e2e" }));
    });
    socket.addEventListener("message", (event) => {
      done(JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("the WebSocket could not be opened"));
    });
  });
}

describe("sync access is scoped to the vault's owner", () => {
  let server: TestServer;
  let alice: CreatedUser;
  let bob: CreatedUser;

  beforeAll(async () => {
    server = await startTestServer("vault access owner");
    // This suite is about access, not the allowance: each case creates its own
    // vault for the same account, so the accounts are given room for them.
    alice = await createUser(server, "Alice", { maxVaults: 10 });
    bob = await createUser(server, "Bob", { maxVaults: 10 });
  });

  afterAll(async () => {
    await server.close();
  });

  it("lets the owner list, push to and pull from their vault", async () => {
    const vaultId = await createVault(server, alice.key, "Alice's vault");

    const pushed = await push(server, vaultId, alice.key, pushBody("file-a", "alice"));
    expect(pushed.status).toBe(200);
    expect((pushed.body.results as Array<{ status: string }>)[0].status).toBe("ok");

    const pulled = await jsonRequest(server, `/api/vaults/${vaultId}/sync/pull`, alice.key, {
      method: "POST",
      body: { files: [{ fileId: "file-a" }] },
    });
    expect(pulled.status).toBe(200);

    expect(await listedVaultIds(server, alice.key)).toContain(vaultId);
  });

  it("answers every sync route for another account's vault as not found", async () => {
    const vaultId = await createVault(server, alice.key, "Private");

    for (const answer of await syncSurface(server, vaultId, bob.key)) {
      // Not `401`: a client reads that as "your key is dead" and may drop the
      // credential, while the key here is perfectly valid — the binding is what is
      // wrong. `404` also refuses to confirm that someone else's vault id exists.
      expect(answer.status).toBe(404);
      expect(answer.body.error).toBe("NOT_FOUND");
      expect(answer.body.message).toBe("Vault not found");
    }

    // Nothing was written by the refused push, and the vault is not even
    // listable for Bob — the two answers have to agree.
    expect(await listedVaultIds(server, bob.key)).not.toContain(vaultId);
  });

  it("refuses a subscription to another account's vault, and accepts the owner's", async () => {
    const vaultId = await createVault(server, alice.key, "Subscriptions");

    const refused = await subscribe(server, vaultId, bob.key);
    expect(refused.type).toBe("subscribe_error");
    // The same answer a nonexistent vault gets (see the case below): the refusal must not
    // tell Bob that Alice's vault id is real.
    expect(refused.message).toBe("Vault not found");

    const accepted = await subscribe(server, vaultId, alice.key);
    expect(accepted.type).toBe("subscribe_success");
    expect(accepted.vaultId).toBe(vaultId);
  });

  it("refuses a subscription to a vault that does not exist", async () => {
    const answer = await subscribe(server, "no-such-vault-id", alice.key);
    expect(answer.type).toBe("subscribe_error");
    expect(answer.message).toBe("Vault not found");
  });

  it("still lets any account use an owner-less legacy vault", async () => {
    const vaultId = await createVault(server, alice.key, "Legacy");
    // What a vault created before the multi-user model looks like. Flipped
    // directly, because no route can produce an owner-less vault any more.
    makeOwnerless(server, vaultId);

    // Bob can sync it and list it...
    const pushed = await push(server, vaultId, bob.key, pushBody("file-legacy", "legacy"));
    expect(pushed.status).toBe(200);
    expect(await listedVaultIds(server, bob.key)).toContain(vaultId);

    const subscribed = await subscribe(server, vaultId, bob.key);
    expect(subscribed.type).toBe("subscribe_success");
  });

  it("lists exactly the vaults whose sync requests it accepts", async () => {
    // The SQL half of the rule (`visibleVaultsWhere`) and the TypeScript half
    // (`canAccessVault`) are two spellings of one predicate; this is what keeps
    // them from drifting apart.
    const ownA = await createVault(server, alice.key, "Mine A");
    const ownB = await createVault(server, alice.key, "Mine B");
    const theirs = await createVault(server, bob.key, "Theirs");

    const listed = new Set(await listedVaultIds(server, alice.key));
    expect([...listed]).toEqual(expect.arrayContaining([ownA, ownB]));
    expect(listed.has(theirs)).toBe(false);

    const accepted: string[] = [];
    for (const vaultId of [ownA, ownB, theirs]) {
      const answer = await push(server, vaultId, alice.key, pushBody(`file-${vaultId}`, vaultId));
      expect([200, 404]).toContain(answer.status);
      if (answer.status === 200) accepted.push(vaultId);
    }

    // For these three, "listed" and "sync accepted" are the same set.
    expect(accepted.toSorted()).toEqual([ownA, ownB].toSorted());
    expect(listed.has(ownA) && listed.has(ownB) && !listed.has(theirs)).toBe(true);
  });
});

/** Flip a vault to `owner_user_id = NULL`, as a pre-multi-user row would be. */
function makeOwnerless(server: TestServer, vaultId: string): void {
  const sqlite = new Database(join(server.rootDir, "courier.db"));
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    sqlite.prepare("UPDATE vaults SET owner_user_id = NULL WHERE id = ?").run(vaultId);
  } finally {
    sqlite.close();
  }
}
