/**
 * The exact bytes of a view, as the `ArrayBuffer` Obsidian's APIs want.
 *
 * `bytes.buffer` alone would include anything the view does not cover — a
 * subarray of a larger buffer would write (or send) the wrong content — so a
 * partial view is copied first.
 *
 * Shared because two host boundaries need it: the vault adapter (`writeBinary`,
 * `modifyBinary`, `createBinary`) and the `requestUrl` transport that carries a
 * push frame.
 */
export function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer;
}
