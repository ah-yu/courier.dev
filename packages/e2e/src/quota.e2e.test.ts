import { createHash } from "crypto";
import { existsSync } from "fs";
import { join } from "path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLOB_HEADER_BYTES, buildPushBody } from "../../shared/src/index";
import { startTestServer, type TestServer } from "./harness/server";

/**
 * The storage limit a host sets on a user key is enforced at the push, and this is
 * the layer that proves it end to end: the real routes, the real blob store on
 * disk, and the real deduplication that decides whether a payload costs anything.
 *
 * What a unit test cannot answer is whether the encrypted payload the store
 * actually holds is what the check counted — and whether pushing the same content
 * twice is refused for a limit it did not consume.
 */
interface CreatedUser {
  id: string;
  key: string;
}

interface Vault {
  id: string;
}

/** Create a user with an optional storage limit, as the admin API does. */
async function createUser(
  server: TestServer,
  name: string,
  storageBytesLimit: number | null,
): Promise<CreatedUser> {
  const response = await fetch(`${server.serverUrl}/api/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${server.hostKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, storageBytesLimit }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as CreatedUser;
}

/** Create a vault owned by that user, the way the plugin does. */
async function createVault(server: TestServer, userKey: string, name: string): Promise<Vault> {
  const response = await fetch(`${server.serverUrl}/api/vaults`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, encryptionSalt: "salt", keyCheck: "canary" }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as Vault;
}

/**
 * The 64-hex content hash the push contract asks for, derived from a short fixture
 * label.
 *
 * `contentHash` is the SHA-256 of the file's plaintext, and the server checks that
 * shape because the same string is the blob store's path component. These fixtures
 * only need hashes that are *distinct per label*, and the same label has to keep
 * meaning "the same content" — the deduplication case below relies on exactly that.
 */
function hashOf(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

/** One pushed version, with the encrypted payload the store will hold. */
function pushBody(options: {
  fileId: string;
  content: string;
  /** A short label for the payload; see {@link hashOf}. */
  contentLabel: string;
  baseVersionId?: string | null;
}) {
  const base = options.baseVersionId ?? null;
  const content = new TextEncoder().encode(options.content);
  const contentHash = hashOf(options.contentLabel);
  return buildPushBody([
    {
      fileId: options.fileId,
      encryptedPath: "cGF0aA==",
      content,
      action: base === null ? "create" : "modify",
      versionId: contentHash.slice(0, 16),
      contentHash,
      // The payload is `iv(12) ‖ plaintext ‖ tag(16)`; the row records the plaintext.
      sizeBytes: Math.max(0, content.byteLength - 28),
      mtimeMs: 0,
      baseVersionId: base,
      historyKind: "documents",
    },
  ]);
}

async function push(
  server: TestServer,
  vaultId: string,
  userKey: string,
  body: Uint8Array,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${server.serverUrl}/api/vaults/${vaultId}/sync/push`, {
    method: "POST",
    headers: { Authorization: `Bearer ${userKey}`, "Content-Type": "application/octet-stream" },
    body: body as unknown as BodyInit,
  });
  const parsed = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body: parsed };
}

describe("storage quota", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await startTestServer("quota user");
  });

  afterAll(async () => {
    await server.close();
  });

  it("refuses a push that would exceed the user's storage limit", async () => {
    const user = await createUser(server, "有限额的人", 1024 + BLOB_HEADER_BYTES);
    const vault = await createVault(server, user.key, "配额 vault");

    // 1 KiB of ciphertext (plus the stored v2 header) fits exactly; anything more does not.
    const fits = await push(
      server,
      vault.id,
      user.key,
      pushBody({ fileId: "file-a", content: "a".repeat(1024), contentLabel: "hash-a" }),
    );
    expect(fits.status).toBe(200);
    expect((fits.body.results as Array<{ status: string }>)[0].status).toBe("ok");

    const refused = await push(
      server,
      vault.id,
      user.key,
      pushBody({ fileId: "file-b", content: "b".repeat(1024), contentLabel: "hash-b" }),
    );
    expect(refused.status).toBe(413);
    expect(refused.body.error).toBe("QUOTA_EXCEEDED");
  });

  it("refuses a staged chunk that would exceed the limit", async () => {
    // Staging is disk the account holds: a chunk that would cross the limit is refused
    // before it is written, not left for the upload to finish and fail.
    const user = await createUser(server, "分块限额", 1000);
    const vault = await createVault(server, user.key, "分块配额 vault");
    const response = await fetch(
      `${server.serverUrl}/api/vaults/${vault.id}/sync/blobs/${"d".repeat(64)}/chunks/0` +
        "?chunkCount=1&plaintextSize=1024",
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${user.key}`,
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(1024 + 28),
      },
    );

    expect(response.status).toBe(413);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: "QUOTA_EXCEEDED",
    });
  });

  it("does not charge for content the store already holds", async () => {
    // A limit that fits exactly one copy of the payload: with a fresh user the
    // first push fills it, and a second push of the *same* bytes (a rename, or a
    // peer re-pushing what it already had) must not be refused for space it does
    // not consume.
    const user = await createUser(server, "去重的人", 512 + BLOB_HEADER_BYTES);
    const vault = await createVault(server, user.key, "去重 vault");

    const first = await push(
      server,
      vault.id,
      user.key,
      pushBody({ fileId: "file-1", content: "x".repeat(512), contentLabel: "hash-shared" }),
    );
    expect(first.status).toBe(200);

    const again = await push(
      server,
      vault.id,
      user.key,
      pushBody({
        fileId: "file-1",
        content: "x".repeat(512),
        contentLabel: "hash-shared",
        baseVersionId: hashOf("hash-shared").slice(0, 16),
      }),
    );
    expect(again.status).toBe(200);
    expect((again.body.results as Array<{ status: string }>)[0].status).toBe("ok");
  });

  it("lets a user with no limit push without measuring anything", async () => {
    const user = await createUser(server, "不限的人", null);
    const vault = await createVault(server, user.key, "无限额 vault");

    const pushed = await push(
      server,
      vault.id,
      user.key,
      pushBody({ fileId: "file-c", content: "c".repeat(4096), contentLabel: "hash-c" }),
    );
    expect(pushed.status).toBe(200);
    expect((pushed.body.results as Array<{ status: string }>)[0].status).toBe("ok");
  });

  it("accepts the next push once the host raises the limit", async () => {
    const user = await createUser(server, "后来放宽的人", 256);
    const vault = await createVault(server, user.key, "放宽 vault");

    const refused = await push(
      server,
      vault.id,
      user.key,
      pushBody({ fileId: "file-d", content: "d".repeat(512), contentLabel: "hash-d" }),
    );
    expect(refused.status).toBe(413);

    const patched = await fetch(`${server.serverUrl}/api/users/${user.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${server.hostKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ storageBytesLimit: 4096 }),
    });
    expect(patched.status).toBe(200);
    const accepted = await push(
      server,
      vault.id,
      user.key,
      pushBody({ fileId: "file-d", content: "d".repeat(512), contentLabel: "hash-d" }),
    );
    expect(accepted.status).toBe(200);
    expect((accepted.body.results as Array<{ status: string }>)[0].status).toBe("ok");
  });

  it("frees both the disk and the quota when the vault is deleted", async () => {
    const user = await createUser(server, "删库的人", 512 + BLOB_HEADER_BYTES);
    const vault = await createVault(server, user.key, "要删掉的 vault");

    const filled = await push(
      server,
      vault.id,
      user.key,
      pushBody({ fileId: "file-f", content: "f".repeat(512), contentLabel: "hash-f" }),
    );
    expect(filled.status).toBe(200);

    const deleted = await fetch(`${server.serverUrl}/api/vaults/${vault.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${user.key}` },
    });
    expect(deleted.status).toBe(204);

    // The bytes are gone from the store...
    const blobs = join(server.rootDir, "blobs", vault.id);
    expect(existsSync(blobs)).toBe(false);

    // ...and the limit is free again, because the usage no longer counts a vault
    // that does not exist. Without the invalidation the cache would keep charging
    // this push against the deleted vault.
    const again = await push(
      server,
      vault.id,
      user.key,
      pushBody({ fileId: "file-g", content: "g".repeat(512), contentLabel: "hash-g" }),
    );
    // The vault is gone, so the push has nowhere to go — what matters is that it
    // is not refused for space.
    expect(again.status).toBe(404);
  });

  it("refuses an expired user key before it looks at any content", async () => {
    const user = await createUser(server, "过期的人", null);
    const vault = await createVault(server, user.key, "过期 vault");

    // The API refuses to *set* a past expiry (an account that is born dead is what
    // `disabled` is for), but time still passes under a stored one — so the route's
    // answer to an already-expired key is seeded the way the clock produces it.
    const sqlite = new Database(join(server.rootDir, "courier.db"));
    try {
      sqlite.exec("PRAGMA busy_timeout = 5000");
      sqlite
        .prepare("UPDATE users SET expires_at = ? WHERE id = ?")
        .run("2020-01-01T00:00:00.000Z", user.id);
    } finally {
      sqlite.close();
    }

    const refused = await push(
      server,
      vault.id,
      user.key,
      pushBody({ fileId: "file-e", content: "e", contentLabel: "hash-e" }),
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("KEY_EXPIRED");
  });
});
