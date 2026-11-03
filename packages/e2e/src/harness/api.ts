import { decryptString, encryptString, sha256Text } from "../../../engine/src/index";
import { buildPushBody } from "../../../shared/src/index";
import type {
  HistoryKind,
  SyncPushResult,
  UpdateVaultRequest,
  VaultSettingsResponse,
  VaultSummary,
} from "../../../shared/src/index";
import type { TestServer } from "./server";

/**
 * Direct reads of the server's REST surface, so tests can assert on what the
 * server actually stored (version chains, recycle bin, device attribution)
 * rather than only on what the clients believe.
 */
async function getJson<T>(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  path: string,
): Promise<T> {
  const response = await fetch(`${server.serverUrl}${path}`, {
    headers: { Authorization: `Bearer ${server.userKey}` },
  });
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export interface ServerVersion {
  versionId: string;
  contentHash: string;
  action: string;
  /** The label the pushing client stated; `null` when the push carried none. */
  deviceName: string | null;
  createdAt: string;
}

export interface ServerFile {
  fileId: string;
  /** The path of the file's latest version, encrypted with the vault key. */
  encryptedPath: string;
  currentVersionId: string;
  currentContentHash: string;
  versions: ServerVersion[];
}

/** Every file the vault's version chains know about. */
export async function vaultHistory(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
): Promise<ServerFile[]> {
  const body = await getJson<{ files: ServerFile[] }>(
    server,
    `/api/vaults/${vaultId}/sync/history`,
  );
  return body.files;
}

/** The version chain of one file, oldest → newest. */
export async function fileVersions(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
  fileId: string,
): Promise<ServerVersion[]> {
  const body = await getJson<{ versions: ServerVersion[] }>(
    server,
    `/api/vaults/${vaultId}/sync/versions?fileId=${encodeURIComponent(fileId)}`,
  );
  return body.versions;
}

/**
 * The HTTP status of a version content read.
 *
 * `404` is how "the store no longer holds these bytes" reads — what a history trim that
 * reclaimed the blobs its removed rows named should leave behind.
 */
export async function versionContentStatus(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
  contentHash: string,
): Promise<number> {
  const response = await fetch(
    `${server.serverUrl}/api/vaults/${vaultId}/sync/versions/${contentHash}/content`,
    { headers: { Authorization: `Bearer ${server.userKey}` } },
  );
  return response.status;
}

/**
 * A vault's retention limits as the server lists them (`GET /api/vaults`).
 *
 * This is the read every client does before painting or printing the limits, so a test
 * asserting "the server really holds this" goes through the same route instead of the
 * PATCH response it just received.
 */
export async function vaultSettings(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
): Promise<VaultSummary> {
  const body = await getJson<{ vaults: VaultSummary[] }>(server, "/api/vaults");
  const vault = body.vaults.find((entry) => entry.id === vaultId);
  if (!vault) throw new Error(`vault ${vaultId} is not listed`);
  return vault;
}

/**
 * Change a vault's retention limits (or its name) through the API the clients use.
 *
 * The limits are **vault-level server state**: a test that wants a small bound sets it
 * here, once, and every device pushing into the vault is trimmed by it — there is no
 * per-client setting to pass. The answer is the vault as it now stands (limits included);
 * a lowering also trims the chains already stored, before it returns.
 */
export async function updateVaultSettings(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
  patch: UpdateVaultRequest,
): Promise<VaultSettingsResponse> {
  const response = await fetch(`${server.serverUrl}/api/vaults/${vaultId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${server.userKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(`vault update failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as VaultSettingsResponse;
}

export interface ServerDeletedFile {
  fileId: string;
  lastEncryptedPath: string | null;
  previousVersionId: string | null;
  previousContentHash: string | null;
  deletedByDeviceName: string | null;
  deletedAt: string;
}

/** The recycle bin: files whose chain ends in `delete`. */
export async function deletedFiles(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
): Promise<ServerDeletedFile[]> {
  const body = await getJson<{ files: ServerDeletedFile[] }>(
    server,
    `/api/vaults/${vaultId}/sync/deleted`,
  );
  return body.files;
}

export interface PushVersionInput {
  fileId: string;
  /** The plain path; encrypted here with the vault key. */
  path: string;
  key: CryptoKey;
  action: "create" | "modify" | "rename" | "delete" | "restore";
  versionId: string;
  /** Defaults to the empty string's hash — what a `delete` version carries. */
  contentHash?: string;
  /** The ciphertext to store under `contentHash`; omitted when the version has none. */
  content?: Uint8Array | null;
  /** Plaintext size of the version; defaults to `0` (no content). */
  sizeBytes?: number;
  /**
   * The file's modification time on the pushing device, in ms since the epoch.
   * Defaults to `0`; a test that exercises the config-folder "newer wins" rule states
   * both sides explicitly.
   */
  mtimeMs?: number;
  baseVersionId?: string | null;
  /**
   * Which side of the vault's retention split the file name suggests. Defaults to
   * `"documents"`; a retention test that needs the attachment limit states it explicitly.
   * The **numbers** are the vault's, set through its `PATCH` route.
   */
  historyKind?: HistoryKind;
}

/**
 * Push one version straight to the server, without a client in the middle.
 *
 * Tests that need a chain *shape* no client would produce on its own — a delete
 * as a file's only version, which retention pruning leaves behind — can build it
 * this way.
 */
export async function pushVersion(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
  input: PushVersionInput,
): Promise<void> {
  const results = await pushFilesRaw(server, vaultId, [
    {
      fileId: input.fileId,
      encryptedPath: await encryptString(input.key, input.path),
      content: input.content ?? null,
      action: input.action,
      versionId: input.versionId,
      contentHash: input.contentHash ?? (await sha256Text("")),
      // Plaintext size of the version; `0` unless a test says otherwise (a
      // rename/delete version carries no content).
      sizeBytes: input.sizeBytes ?? 0,
      mtimeMs: input.mtimeMs ?? 0,
      baseVersionId: input.baseVersionId ?? null,
      historyKind: input.historyKind ?? "documents",
    },
  ]);
  const result = results[0];
  if (result?.status !== "ok") {
    throw new Error(`push not accepted: ${JSON.stringify(result)}`);
  }
}

/** One file of a raw push: the wire shape, with the path already encrypted. */
export interface RawPushFile {
  fileId: string;
  encryptedPath: string;
  /** Ciphertext for this version; `null`/omitted when it carries none. */
  content?: Uint8Array | null;
  action: "create" | "modify" | "rename" | "delete" | "restore";
  versionId: string;
  contentHash: string;
  sizeBytes?: number;
  /** Modification time of the file on the pushing device; defaults to `0`. */
  mtimeMs?: number;
  baseVersionId: string | null;
  /** Which side of the vault's retention split the file name suggests; defaults to notes. */
  historyKind?: HistoryKind;
}

/**
 * Push raw files and return the server's per-file verdicts (`ok` / `stale_base` /
 * `content_missing` / `error`) instead of insisting on acceptance.
 *
 * The refusal is what a test of the conditional push asserts, so this is the one
 * path that has to be able to *fail* a push and read the answer: a push decided
 * from a head the chain has moved past must be refused, and two pushes decided from
 * the same head must not both be appended.
 */
export async function pushFilesRaw(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
  files: RawPushFile[],
): Promise<SyncPushResult[]> {
  const body = buildPushBody(
    files.map((file) => ({
      fileId: file.fileId,
      encryptedPath: file.encryptedPath,
      action: file.action,
      versionId: file.versionId,
      contentHash: file.contentHash,
      sizeBytes: file.sizeBytes ?? 0,
      mtimeMs: file.mtimeMs ?? 0,
      baseVersionId: file.baseVersionId,
      historyKind: file.historyKind ?? "documents",
      content: file.content ?? null,
    })),
  );
  const response = await fetch(`${server.serverUrl}/api/vaults/${vaultId}/sync/push`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${server.userKey}`,
      "Content-Type": "application/octet-stream",
    },
    body: body as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`push failed: ${response.status} ${await response.text()}`);
  }
  const parsed = (await response.json()) as { results: SyncPushResult[] };
  return parsed.results;
}

/**
 * The fileIds whose latest version lives at `plainPath`.
 *
 * The server stores only encrypted paths, so the test decrypts them with the
 * vault key. This is how "a restore did not leave a second chain for the same
 * path" is asserted — a duplicate identity that no client-side assertion would
 * notice, because both chains would materialise at the same path.
 */
export async function filesAtPath(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
  key: CryptoKey,
  plainPath: string,
): Promise<string[]> {
  const files = await vaultHistory(server, vaultId);
  const matching: string[] = [];
  for (const file of files) {
    try {
      if ((await decryptString(key, file.encryptedPath)) === plainPath) matching.push(file.fileId);
    } catch {
      // Undecryptable path (wrong key) — not this path.
    }
  }
  return matching;
}

/**
 * The device label behind each version of one file, oldest → newest. Read from the
 * sync API, which exposes exactly what the UI shows — the same call a client makes,
 * not a direct look into the database.
 */
export async function versionDeviceNames(
  server: Pick<TestServer, "serverUrl" | "userKey">,
  vaultId: string,
  fileId: string,
): Promise<string[]> {
  const versions = await fileVersions(server, vaultId, fileId);
  return versions.map((version) => version.deviceName ?? "");
}
