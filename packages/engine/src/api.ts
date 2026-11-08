import {
  buildPushBody,
  type CourierClient,
  type SyncPullResponse,
  type SyncPushResponse,
  type VaultSyncIndexResponse,
  type PushFileFrame,
} from "@courier/shared";

/**
 * One file change to push. The wire shape itself — a binary frame carrying the
 * header and the raw ciphertext — lives in `@courier/shared`'s `wire.ts`, so the
 * hosts that build a request and the server that reads it share one definition.
 *
 * Two fields carry the weight here:
 *
 * - `content` is `null` for a version that has no payload to send: a `delete`, or a
 *   `rename` whose bytes the store already holds under `contentHash` (the engine's
 *   rename rule — a move costs one small request, not a second upload of the file).
 * - `sizeBytes` is the **plaintext** size of the version even when `content` is
 *   null: it plans the chunked transfer and the progress report. It does not decide
 *   whether a peer downloads the version — the cap bounds uploads only.
 */
export type PushFile = PushFileFrame;

/**
 * Network abstraction the sync engine uses. Hosts inject concrete
 * implementations: the plugin wires `requestUrl`, the CLI wires `fetch`.
 */
export interface SyncApi {
  /** Push local file changes to the server (batch). */
  push(vaultId: string, files: PushFile[]): Promise<SyncPushResponse>;

  /** Fetch remote version chains for the given fileIds. */
  pull(vaultId: string, fileIds: string[]): Promise<SyncPullResponse>;

  /**
   * Fetch the ciphertext of a specific version: `iv ‖ AES-256-GCM ciphertext ‖ tag`,
   * exactly as the store holds it. The caller already knows the hash it asked for,
   * so there is no envelope and no base64 — see {@link decryptCombinedBytes}.
   *
   * Whole-file reads are for versions at or below the chunking threshold; a larger
   * one is fetched with {@link getVersionContentRange} so a download never holds the
   * whole payload.
   */
  getVersionContent(vaultId: string, contentHash: string): Promise<Uint8Array>;

  /**
   * The ciphertext of several versions in one request, in the order asked for; `null` for a
   * hash the store does not hold (an ordinary answer, like a `404` for one version).
   *
   * The engine batches the content reads of a pass or a notification burst through this:
   * a download used to cost one request per file (`docs/first-bind-performance.md`).
   */
  getVersionContents(
    vaultId: string,
    contentHashes: readonly string[],
  ): Promise<Array<Uint8Array | null>>;

  /** One inclusive byte range of a version's chunk region (see `getVersionContent`). */
  getVersionContentRange(
    vaultId: string,
    contentHash: string,
    start: number,
    end: number,
  ): Promise<Uint8Array>;

  /** Stage one chunk of a chunked upload; answers the contiguous prefix on disk. */
  uploadChunk(
    vaultId: string,
    contentHash: string,
    index: number,
    chunkCount: number,
    plaintextSize: number,
    content: Uint8Array,
  ): Promise<{ received: number }>;

  /**
   * The resume point of a staged upload, or `null` when the server holds none.
   *
   * A `null` is an answer, not a failure: a fresh upload starts at chunk 0, and a
   * resumed one continues at `received`.
   */
  getChunkStatus(
    vaultId: string,
    contentHash: string,
  ): Promise<{ received: number; complete: boolean } | null>;

  /** One row per chain — the head a reconcile decides from (see `getVaultSyncIndex`). */
  getVaultSyncIndex(vaultId: string): Promise<VaultSyncIndexResponse>;

  /**
   * Tell the API this client's WebSocket session id, so a push can identify
   * itself and the server skips echoing it back (`X-Courier-Session-Id`).
   *
   * Optional: hosts without a socket (a one-shot CLI run) simply never call it,
   * and the engine's own echo suppression still applies. Hosts that do have a
   * socket call it on every connection state change, since a reconnect gets a
   * new session id.
   */
  setSessionId?(sessionId: string | null): void;
}

/**
 * The engine's network layer, over the shared HTTP client.
 *
 * The client (`@courier/shared`'s `http.ts`) owns URLs, auth, session id and
 * error mapping on every host; the engine only adds what is specific to the sync
 * protocol — the binary push frame with the **current** device label in it.
 *
 * The label is read through a getter rather than captured: a host may rename
 * itself while it runs (the plugin's device-name field, `courier-cli device
 * rename`), and the next push has to state the new name. Capturing it is what
 * made a CLI rename require a daemon restart.
 */
export function createSyncApi(client: CourierClient, getDeviceName: () => string): SyncApi {
  return {
    setSessionId(sessionId) {
      client.setSessionId(sessionId);
    },
    async push(vaultId, files) {
      return await client.push(vaultId, buildPushBody(files, { deviceName: getDeviceName() }));
    },
    async pull(vaultId, fileIds) {
      return await client.pull(vaultId, fileIds);
    },
    async getVersionContent(vaultId, contentHash) {
      return await client.getVersionContent(vaultId, contentHash);
    },
    async getVersionContents(vaultId, contentHashes) {
      return await client.getVersionContents(vaultId, contentHashes);
    },
    async getVersionContentRange(vaultId, contentHash, start, end) {
      return await client.getVersionContentRange(vaultId, contentHash, start, end);
    },
    async uploadChunk(vaultId, contentHash, index, chunkCount, plaintextSize, content) {
      return await client.uploadChunk(
        vaultId,
        contentHash,
        index,
        chunkCount,
        plaintextSize,
        content,
      );
    },
    async getChunkStatus(vaultId, contentHash) {
      return await client.getChunkStatus(vaultId, contentHash);
    },
    async getVaultSyncIndex(vaultId) {
      return await client.getVaultSyncIndex(vaultId);
    },
  };
}
