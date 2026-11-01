import { KEY_CHECK_VALUE } from "@courier/shared";

/**
 * Cryptographic primitives shared by every sync host (Obsidian plugin and
 * headless CLI). Implemented on Web Crypto (`crypto.subtle`), which is native
 * in browsers, Obsidian's runtime and Bun.
 *
 * Wire format is identical to the previous Rust engine: content encrypted with
 * AES-256-GCM under PBKDF2(HMAC-SHA256, 600k)-derived keys, canary key-check,
 * SHA-256 content hashes.
 */

/** Generate a cryptographically random 32-byte salt, base64-encoded. */
export function generateSalt(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

/** Convert bytes to base64 (chunked to avoid stack overflow on large inputs). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** Convert a base64 string to bytes. */
export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Derive an AES-256-GCM key from a password + base64 salt.
 *
 * Non-extractable by default. A host that persists the key locally instead of
 * asking for the password again (the plugin's device-local credential store,
 * the headless CLI) passes `extractable: true` so it can `exportKey("raw", …)`
 * without paying for a second PBKDF2 pass.
 */
export async function deriveEncryptionKey(
  password: string,
  encryptionSalt: string,
  extractable = false,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  const saltBytes = Uint8Array.from(atob(encryptionSalt), (c) => c.charCodeAt(0));

  const keyMaterial = await crypto.subtle.importKey("raw", passwordBytes, "PBKDF2", false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 600_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"],
  );
}

/** Import a raw 32-byte AES key from base64 (used when the key is already derived). */
export async function importRawKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key);
  if (raw.length !== 32) {
    throw new Error(`Invalid AES key length: expected 32 bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Export an AES key as base64 raw bytes, for a host that persists it locally.
 *
 * The key must have been derived (or imported) as extractable; otherwise Web
 * Crypto throws `InvalidAccessError` by design.
 */
export async function exportRawKey(key: CryptoKey): Promise<string> {
  if (!key.extractable) {
    throw new Error("Cannot export a non-extractable key");
  }
  return bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
}

/** Generate a random 12-byte IV for AES-GCM. */
export function generateIv(): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  return iv;
}

/**
 * Encrypt bytes with AES-256-GCM, returning `iv ‖ ciphertext ‖ authTag` as **raw
 * bytes** — the form the wire and the blob store use.
 *
 * The base64 form ({@link encryptBytes}) is for a payload that has to travel inside
 * JSON: the key-check canary, an encrypted path, a version's content *path*. File
 * content does not: encoding it cost a pass over every byte of every file, a third
 * more bytes on the wire and on disk, and a decode pass in front of every read.
 */
export async function encryptCombinedBytes(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = generateIv();
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return combined;
}

/** Encrypt bytes with AES-256-GCM, returning base64(iv || ciphertext || authTag). */
export async function encryptBytes(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return bytesToBase64(await encryptCombinedBytes(key, plaintext));
}

/** Decrypt base64(iv || ciphertext || authTag) with AES-256-GCM. Throws on bad key/tamper. */
export async function decryptBytes(key: CryptoKey, payload: string): Promise<Uint8Array> {
  return await decryptCombinedBytes(key, base64ToBytes(payload));
}

/**
 * The same decryption for a payload that is **already** decoded: `iv || ciphertext || authTag`.
 *
 * A caller that received base64 from the API and wants bytes has no reason to encode it
 * back before decrypting — for a multi-megabyte file that round-trip is meaningful work
 * (and it used to go through a second, unchunked base64 helper).
 */
export async function decryptCombinedBytes(
  key: CryptoKey,
  combined: Uint8Array,
): Promise<Uint8Array> {
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new Uint8Array(decrypted);
}

/**
 * Encrypt one chunk of a large file, binding it to its place with `additionalData`.
 *
 * Same wire shape as {@link encryptCombinedBytes} (`iv ‖ ciphertext ‖ tag`), plus the
 * AEAD's additional data — `chunkAdditionalData` from `@courier/shared`, which carries
 * the content hash, the index, the chunk count and the plaintext size. A chunk decrypted
 * anywhere else fails, so a reader never assembles one from another file or position.
 */
export async function encryptChunkBytes(
  key: CryptoKey,
  plaintext: Uint8Array<ArrayBuffer>,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = generateIv();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    plaintext,
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return combined;
}

/** Decrypt one chunk produced by {@link encryptChunkBytes}. Throws on a wrong place or key. */
export async function decryptChunkBytes(
  key: CryptoKey,
  combined: Uint8Array,
  additionalData: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv, additionalData },
    key,
    ciphertext,
  );
  return new Uint8Array(decrypted);
}

/** Encrypt a string (e.g. a file path) with AES-256-GCM → base64(iv||ct||tag). */
export async function encryptString(key: CryptoKey, text: string): Promise<string> {
  return encryptBytes(key, new TextEncoder().encode(text));
}

/** Decrypt a base64(iv||ct||tag) payload back to a string. */
export async function decryptString(key: CryptoKey, payload: string): Promise<string> {
  const bytes = await decryptBytes(key, payload);
  return new TextDecoder().decode(bytes);
}

/** Encrypt the fixed canary plaintext with the vault key (stored on the server). */
export async function makeKeyCheck(key: CryptoKey): Promise<string> {
  return encryptString(key, KEY_CHECK_VALUE);
}

/**
 * Verify a password-derived key against the stored key-check canary.
 * AES-GCM authentication guarantees decryption succeeds ⟺ the key is correct.
 */
export async function verifyKeyCheck(key: CryptoKey, keyCheck: string): Promise<boolean> {
  try {
    const plaintext = await decryptString(key, keyCheck);
    return plaintext === KEY_CHECK_VALUE;
  } catch {
    return false;
  }
}

/** SHA-256 of bytes, hex-encoded (used as the content hash). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Bun's native hasher is synchronous. Besides being faster, it keeps hashing
  // off the event loop: a WebCrypto digest started inside a faked-timer callback
  // never resolves, which deadlocks a test that runs a sync pass under
  // `vi.useFakeTimers()`. Obsidian's runtime has no `Bun` global, so the
  // portable WebCrypto path stays for the plugin.
  if (typeof Bun !== "undefined") {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  }
  // `BufferSource` narrowed to an `ArrayBuffer`-backed view in TypeScript 6, while a
  // `Uint8Array` is generic over any buffer; WebCrypto takes the view as it is (offset,
  // byte length and a shared buffer included), so the assertion describes the call instead
  // of copying the bytes — a copied 200 MiB preview would be a second allocation on top of
  // the buffer the caller already holds. Bun hashes in place above.
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of a UTF-8 string, hex-encoded. */
export async function sha256Text(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/**
 * Incremental SHA-256, byte-for-byte identical to {@link sha256Hex}.
 *
 * Web Crypto only offers one-shot `digest`, which forces a whole file into memory before
 * it can be hashed. A streamed download verifies the content hash as the chunks go by,
 * so it needs the FIPS 180-4 compression function over 32-bit words. `crypto.test.ts`
 * pins it against `crypto.subtle` around block and chunk boundaries.
 *
 * `digestHex` finalises the object; a second call throws. Not a wire primitive: the
 * content hash on the wire is still produced by {@link sha256Hex}.
 */
export class Sha256 {
  private readonly state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private blockLength = 0;
  private bytesHashed = 0;
  private finished = false;

  /** Feed the next part of the message. Order is the message's order. */
  update(data: Uint8Array): this {
    if (this.finished) throw new Error("Sha256: update after digest");
    this.bytesHashed += data.byteLength;
    let offset = 0;
    if (this.blockLength > 0) {
      const take = Math.min(64 - this.blockLength, data.byteLength);
      this.block.set(data.subarray(0, take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 64) {
        this.compress(this.block, 0);
        this.blockLength = 0;
      }
    }
    while (offset + 64 <= data.byteLength) {
      this.compress(data, offset);
      offset += 64;
    }
    if (offset < data.byteLength) {
      this.block.set(data.subarray(offset), 0);
      this.blockLength = data.byteLength - offset;
    }
    return this;
  }

  /** Finish and return the lowercase hex digest. */
  digestHex(): string {
    if (this.finished) throw new Error("Sha256: digest called twice");
    this.finished = true;
    const bitLength = this.bytesHashed * 8;
    const padLength = this.blockLength < 56 ? 56 - this.blockLength : 120 - this.blockLength;
    const tail = new Uint8Array(this.blockLength + padLength + 8);
    tail.set(this.block.subarray(0, this.blockLength), 0);
    tail[this.blockLength] = 0x80;
    const lengthAt = tail.byteLength - 8;
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    tail[lengthAt] = (high >>> 24) & 0xff;
    tail[lengthAt + 1] = (high >>> 16) & 0xff;
    tail[lengthAt + 2] = (high >>> 8) & 0xff;
    tail[lengthAt + 3] = high & 0xff;
    tail[lengthAt + 4] = (low >>> 24) & 0xff;
    tail[lengthAt + 5] = (low >>> 16) & 0xff;
    tail[lengthAt + 6] = (low >>> 8) & 0xff;
    tail[lengthAt + 7] = low & 0xff;
    for (let offset = 0; offset < tail.byteLength; offset += 64) this.compress(tail, offset);

    let hex = "";
    for (const word of this.state) hex += word.toString(16).padStart(8, "0");
    return hex;
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((data[j] << 24) | (data[j + 1] << 16) | (data[j + 2] << 8) | data[j + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];

    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }
}

/** FIPS 180-4 round constants. */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
