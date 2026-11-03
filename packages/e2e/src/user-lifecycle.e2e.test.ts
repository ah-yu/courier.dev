import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPushBody } from "../../shared/src/index";
import { startTestServer, type TestServer } from "./harness/server";

/**
 * The two ways a key stops working, and the three edits the service refuses.
 *
 * `disable` is the reversible stop: the key, its vaults, their chains and their blobs
 * all stay, and the credential authenticates nothing until it is enabled again.
 * `delete` is the irreversible one, and it takes the account's vaults with it — a vault
 * left behind would be an owner-less row every other account could use, with blobs
 * charged to nobody.
 *
 * The refused edits are the ones that would leave an account in a state it can never
 * leave on its own: a storage cap below what is already stored, a vault allowance below
 * the vaults that exist, and a validity that has already run out (which is what disabling
 * is for).
 */

interface CreatedUser {
  id: string;
  key: string;
}

async function createUser(
  server: TestServer,
  name: string,
  limits: Record<string, unknown> = {},
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

/** One pushed version, shaped like a real one (IV and tag in front of the plaintext). */
function pushBody(fileId: string, contentLabel: string, size = 64): Uint8Array {
  const plain = new Uint8Array(size).fill(contentLabel.length);
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

async function request(
  server: TestServer,
  path: string,
  token: string,
  options: { method?: string; body?: unknown } = {},
): Promise<Answer> {
  const response = await fetch(`${server.serverUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : (JSON.parse(text) as never) };
}

/** Change one account the way an admin edit dialog does. */
function patchUser(
  server: TestServer,
  id: string,
  patch: Record<string, unknown>,
): Promise<Answer> {
  return request(server, `/api/users/${id}`, server.hostKey, { method: "PATCH", body: patch });
}

function me(server: TestServer, userKey: string): Promise<Answer> {
  return request(server, "/api/me", userKey);
}

/** The ids `GET /api/vaults` reports for one key. */
async function listedVaultIds(server: TestServer, userKey: string): Promise<string[]> {
  const answer = await request(server, "/api/vaults", userKey);
  expect(answer.status).toBe(200);
  return ((answer.body.vaults as Array<{ id: string }>) ?? []).map((vault) => vault.id).toSorted();
}

/** The blob directory a vault's content-addressed store lives in. */
function blobDir(server: TestServer, vaultId: string): string {
  return join(server.rootDir, "blobs", vaultId);
}

/**
 * How many version rows the database holds for a vault.
 *
 * Read straight from SQLite because the delete cascade is a schema rule: the API can no
 * longer name a deleted vault, so a surviving orphan row would be invisible from the
 * outside — and would keep its blob referenced (and un-reclaimable) forever.
 */
function versionRowCount(server: TestServer, vaultId: string): number {
  const sqlite = new Database(join(server.rootDir, "courier.db"));
  try {
    sqlite.exec("PRAGMA busy_timeout = 5000");
    const row = sqlite
      .prepare("SELECT COUNT(*) AS n FROM file_versions WHERE vault_id = ?")
      .get(vaultId) as { n: number };
    return Number(row.n);
  } finally {
    sqlite.close();
  }
}

/**
 * Subscribe and answer the socket plus a way to await the next server message.
 *
 * The subscribe's own `subscribe_success` is consumed here, so the first `next()`
 * resolves with whatever the server says afterwards — which is what a revocation is.
 */
function subscribeSocket(
  server: TestServer,
  vaultId: string,
  userKey: string,
): Promise<{
  next: () => Promise<Record<string, unknown>>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(server.wsUrl);
    const inbox: Array<Record<string, unknown>> = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];
    let subscribed = false;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("the server never answered the subscribe"));
    }, 5_000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", vaultId, userKey, deviceName: "e2e" }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as Record<string, unknown>;
      if (!subscribed) {
        if (message.type !== "subscribe_success") {
          clearTimeout(timer);
          socket.close();
          reject(new Error(`subscribe refused: ${JSON.stringify(message)}`));
          return;
        }
        subscribed = true;
        clearTimeout(timer);
        resolve({
          next: () =>
            new Promise<Record<string, unknown>>((next) => {
              const queued = inbox.shift();
              if (queued) next(queued);
              else waiters.push(next);
            }),
          close: () => socket.close(),
        });
        return;
      }
      const waiter = waiters.shift();
      if (waiter) waiter(message);
      else inbox.push(message);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("the WebSocket could not be opened"));
    });
  });
}

describe("a key's lifecycle", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer("key lifecycle");
  });

  afterAll(async () => {
    await server.close();
  });

  it("disables a key without touching what it owns, and re-enables it", async () => {
    const user = await createUser(server, "要停用的人", { maxVaults: 1 });
    const vaultId = await createVault(server, user.key, "停用前的库");
    expect((await push(server, vaultId, user.key, pushBody("f-1", "before"))).status).toBe(200);

    const before = await me(server, user.key);
    const usedBytes = before.body.usedBytes as number;
    expect(usedBytes).toBeGreaterThan(0);

    const disabled = await patchUser(server, user.id, { disabled: true });
    expect(disabled.status).toBe(200);
    expect(disabled.body.disabled).toBe(true);

    // Every way in is refused, with the code that says "paused", not "expired".
    for (const answer of [
      await me(server, user.key),
      await request(server, "/api/vaults", user.key),
      await push(server, vaultId, user.key, pushBody("f-2", "while-disabled")),
    ]) {
      expect(answer.status).toBe(403);
      expect(answer.body.error).toBe("KEY_DISABLED");
    }

    // Nothing was deleted: the usage is the same, and the vault is still listed.
    const enabled = await patchUser(server, user.id, { disabled: false });
    expect(enabled.status).toBe(200);
    expect(enabled.body.disabled).toBe(false);
    const after = await me(server, user.key);
    expect(after.status).toBe(200);
    expect(after.body.usedBytes).toBe(usedBytes);
    expect(await listedVaultIds(server, user.key)).toEqual([vaultId]);

    // Both directions are idempotent: a second disable (a stale dialog, two hosts) and an
    // enable on an account that is already enabled are ordinary 200s, not errors.
    expect((await patchUser(server, user.id, { disabled: true })).status).toBe(200);
    expect((await patchUser(server, user.id, { disabled: true })).status).toBe(200);
    expect((await patchUser(server, user.id, { disabled: false })).status).toBe(200);
    expect((await patchUser(server, user.id, { disabled: false })).status).toBe(200);

    // And it syncs again: the next push lands on the same vault.
    expect((await push(server, vaultId, user.key, pushBody("f-2", "after"))).status).toBe(200);
  });

  it("tells a disabled account's live sessions the key was disabled, not revoked", async () => {
    const user = await createUser(server, "在线停用的人", { maxVaults: 1 });
    const vaultId = await createVault(server, user.key, "在线库");
    const socket = await subscribeSocket(server, vaultId, user.key);
    try {
      await patchUser(server, user.id, { disabled: true });
      const message = await socket.next();
      // A client that saw `api_key_revoked` would drop the binding; disabled is a pause
      // the same key resumes from.
      expect(message).toMatchObject({ type: "api_key_disabled", vaultId });
    } finally {
      socket.close();
    }
  });

  it("deletes a key together with its vaults, their rows and their blobs", async () => {
    const doomed = await createUser(server, "要删掉的人", { maxVaults: 2 });
    const first = await createVault(server, doomed.key, "第一个库");
    const second = await createVault(server, doomed.key, "第二个库");
    expect((await push(server, first, doomed.key, pushBody("f-a", "a"))).status).toBe(200);
    expect((await push(server, second, doomed.key, pushBody("f-b", "b"))).status).toBe(200);
    expect(existsSync(blobDir(server, first))).toBe(true);

    // A second account is the witness: an owner-less vault would become visible to it.
    const witness = await createUser(server, "旁观的人", { maxVaults: 0 });
    expect(await listedVaultIds(server, witness.key)).toEqual([]);

    const deleted = await request(server, `/api/users/${doomed.id}`, server.hostKey, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    // The credential is gone...
    expect((await me(server, doomed.key)).status).toBe(401);
    // ...the vaults are gone with it, and nothing became owner-less...
    expect(await listedVaultIds(server, witness.key)).toEqual([]);
    // ...the rows are gone, so no route can name the old vault...
    expect((await push(server, first, witness.key, pushBody("f-c", "c"))).status).toBe(404);
    // ...the version rows went with the vault (the `file_versions` cascade), not just the
    // vault row: an orphan would keep its blob referenced and un-reclaimable forever...
    expect(versionRowCount(server, first)).toBe(0);
    expect(versionRowCount(server, second)).toBe(0);
    // ...and the bytes were reclaimed.
    expect(existsSync(blobDir(server, first))).toBe(false);
    expect(existsSync(blobDir(server, second))).toBe(false);

    const list = await request(server, "/api/users", server.hostKey);
    expect((list.body.users as Array<{ id: string }>).map((u) => u.id)).not.toContain(doomed.id);
  });

  it("deletes an account that owns nothing, and one whose vault is empty", async () => {
    // The cascade must not assume a vault exists, and must not assume a vault directory
    // exists: `deleteVaultBlobs` is `fs.rm(force: true)`, and a path with no blobs is the
    // normal state of a vault nobody has pushed to yet.
    const idle = await createUser(server, "没库的人", { maxVaults: 1 });
    expect(
      (await request(server, `/api/users/${idle.id}`, server.hostKey, { method: "DELETE" })).status,
    ).toBe(204);
    expect((await me(server, idle.key)).status).toBe(401);

    const empty = await createUser(server, "空库的人", { maxVaults: 1 });
    const vaultId = await createVault(server, empty.key, "空库");
    expect(existsSync(blobDir(server, vaultId))).toBe(false);
    expect(
      (await request(server, `/api/users/${empty.id}`, server.hostKey, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(versionRowCount(server, vaultId)).toBe(0);
  });

  it("tells a deleted account's live sessions the key was revoked", async () => {
    const user = await createUser(server, "在线删除的人", { maxVaults: 1 });
    const vaultId = await createVault(server, user.key, "在线删除库");
    const socket = await subscribeSocket(server, vaultId, user.key);
    try {
      await request(server, `/api/users/${user.id}`, server.hostKey, { method: "DELETE" });
      const message = await socket.next();
      expect(message).toMatchObject({ type: "api_key_revoked", vaultId });
    } finally {
      socket.close();
    }
  });

  it("refuses a storage cap below what the account already stores", async () => {
    const user = await createUser(server, "有数据的人", {
      maxVaults: 1,
      storageBytesLimit: 64 * 1024,
    });
    const vaultId = await createVault(server, user.key, "有数据的库");
    expect((await push(server, vaultId, user.key, pushBody("f-s", "s", 1024))).status).toBe(200);
    const used = (await me(server, user.key)).body.usedBytes as number;
    expect(used).toBeGreaterThan(1024);

    const refused = await patchUser(server, user.id, { storageBytesLimit: 1024 });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("VALIDATION_ERROR");
    expect(refused.body.details).toEqual([expect.objectContaining({ field: "storageBytesLimit" })]);

    // A cap at or above the usage is accepted, and clearing it always is.
    expect((await patchUser(server, user.id, { storageBytesLimit: used })).status).toBe(200);
    expect((await patchUser(server, user.id, { storageBytesLimit: null })).status).toBe(200);
  });

  it("refuses a vault allowance below the vaults the account owns", async () => {
    const user = await createUser(server, "库多的人", { maxVaults: 2 });
    await createVault(server, user.key, "一");
    await createVault(server, user.key, "二");

    const refused = await patchUser(server, user.id, { maxVaults: 1 });
    expect(refused.status).toBe(422);
    expect(refused.body.details).toEqual([expect.objectContaining({ field: "maxVaults" })]);

    // 0 is still "unlimited", and a raise is always allowed.
    expect((await patchUser(server, user.id, { maxVaults: 0 })).status).toBe(200);
    expect((await patchUser(server, user.id, { maxVaults: 3 })).status).toBe(200);
  });

  it("refuses a validity that has already passed, on create and on edit", async () => {
    const past = "2020-01-01T00:00:00.000Z";
    const created = await fetch(`${server.serverUrl}/api/users`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.hostKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "过期出生", expiresAt: past }),
    });
    expect(created.status).toBe(422);

    const user = await createUser(server, "要改期的人", { maxVaults: 1 });
    const refused = await patchUser(server, user.id, { expiresAt: past });
    expect(refused.status).toBe(422);
    expect(refused.body.details).toEqual([expect.objectContaining({ field: "expiresAt" })]);

    // A day in the future is the normal case, and clearing is 「永久」.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect((await patchUser(server, user.id, { expiresAt: tomorrow })).status).toBe(200);
    expect((await patchUser(server, user.id, { expiresAt: null })).status).toBe(200);
  });

  it("still lets the host lower the file cap, which the service does not enforce", async () => {
    // `maxFileBytes` is a client-side read guard: the server must accept the value and
    // must not start refusing pushes for it. Lowering it below an existing file is
    // therefore a policy change, not a data change — the file stays in every vault.
    const user = await createUser(server, "改小文件上限的人", { maxVaults: 1 });
    const vaultId = await createVault(server, user.key, "文件库");
    expect((await push(server, vaultId, user.key, pushBody("f-big", "big", 4096))).status).toBe(
      200,
    );

    expect((await patchUser(server, user.id, { maxFileBytes: 1 })).status).toBe(200);
    expect((await me(server, user.key)).body.maxFileBytes).toBe(1);
    // The server does not use it to refuse a push, even one far above it.
    expect((await push(server, vaultId, user.key, pushBody("f-big-2", "big2", 8192))).status).toBe(
      200,
    );
  });
});
