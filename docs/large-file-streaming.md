# Large file streaming

Status: **authoritative**, implemented 2026-10-30. The download half of the large-file-streaming
work; the upload half is still open.

## The problem

Chunking stopped at the transport layer. A version above 8 MiB was already fetched as 4 MiB
`Range` requests and decrypted chunk by chunk, but the plaintext was then assembled into one
`Uint8Array(plaintextSize)` because `SyncAdapter.writeFile` takes the file whole. Peak memory for
a download was therefore the file's size plus the chunks in flight, and a 200 MiB attachment
allocated 200 MiB on every device that pulled it. On a phone that allocation can be an OOM kill
rather than a catchable `RangeError`.

The same was true of some "is there a file here?" checks: following a remote move read both
sides whole, and inspecting a restore target read the file it was about to ask about.

## What changed

- **`SyncAdapter.beginWrite(path)`** (optional) returns a `SyncWriteStream` with
  `write(chunk)`, `close()` and `abort()`. The contract is that the target is **not visible**
  while chunks arrive, `close` places the complete file in one step, and `abort` discards the
  partial file. A host without `beginWrite` keeps the whole-buffer path.
- **The engine streams a chunked download.** `writeRemoteVersion` calls `beginWrite` when the
  version is above the 8 MiB threshold, decrypts each chunk, writes it, and drops it. A failed
  fetch, a failed decryption or a failed `close` aborts the stream; the next pass is the retry.
- **The one-write invariant is preserved.** A streamed pull records the head's content hash in
  `SelfEventLog` **before** `close` (which performs the rename that fires the event), so the
  event is recognised as the engine's own write. It also records the committed file's stamp,
  and `applyLocalChange` checks that stamp before reading: the watcher event therefore does
  **not** read the file back (a whole-file read immediately after streaming would defeat the
  memory bound). A genuine edit moves the stamp and takes the ordinary read-and-hash path.
  The temporary file lives under `.courier/tmp`, a hidden path the scope never lists, so no
  per-chunk event and no half-written readable file exists.
- **The CLI writes through an `fs` handle.** `FsAdapter.beginWrite` opens a unique file under
  `.courier/tmp`, writes each chunk, closes it, creates the target's folder and renames it into
  place. A crash leaves a stale temporary file, never a truncated target that the next pass
  would read as a local edit; the next large write sweeps `.part` files older than a day.
- **The plugin writes through `DataAdapter` + rename.** `ObsidianVaultAdapter.beginWrite` uses
  `writeBinary` for the first chunk and `appendBinary` for the rest (`@since 1.12.3`, and the
  plugin's floor is 1.13.0), then `adapter.rename`.
- **A lagging Obsidian index does not read as a deletion, and stale index metadata is not
  recorded.** A data-adapter rename fires no vault event, so the app's watcher indexes the
  target on its own schedule. Until it does, the adapter keeps the path in `pendingIndex`,
  lists it from the disk, and answers `statFile`/`readFile` from the data adapter. A replaced
  file's old `TFile.stat` is also kept out of the state (`streamedStats`) until the watcher's
  stat matches the disk, so the new hash is never paired with the old stamp. Delete, rename and
  a small write in that window go through the data adapter instead of being silent no-ops.
  Entries are dropped once the index sees the file, or if the user deletes it first.
- **Integrity is per chunk and whole-file.** Each chunk's AEAD additional data names the
  version's content hash, the chunk index, the chunk count and the plaintext size, so a chunk
  from another file, another position or a reordered upload fails to decrypt. A streaming
  SHA-256 over the decrypted chunks then proves the concatenation is the version's content
  before `close` makes it visible; this is the same final-hash check the whole-buffer path
  makes, using an incremental implementation because Web Crypto only offers one-shot
  `digest`. A blob whose chunks decrypt but whose plaintext hashes to a different value is
  refused.
- **A broken sink falls back.** If `beginWrite`/`write`/`close` throws, the stream aborts and
  the pull is retried once through the old whole-buffer `fetchRemoteVersionBytes` +
  `writeFile` path, so an adapter bug or an unsupported platform cannot make a large pull fail
  forever.
- **Existence checks stopped reading files.** `followRemotePath`, `inspectRestoreTarget`,
  `parkConflictFile`, the tombstone confirmation and the notification's head-path check use
  `statFile` instead of `readFile`. The pre-pull re-check also uses the pass's stamp before it
  falls back to re-reading, so an unchanged large file is not read again before its pull.

## Measurements

`bun run bench large` on Windows 11 (`10.0.26300`, i7-13790F, 24 logical CPUs, server and both
vaults over loopback), measured while the suite still ran on the pre-Bun toolchain. Base is `main` at
`c264ba7`; head is the change. Base and
head alternate, three independent runs per side; the table reports medians. The phase baseline
is sampled at the start of the pull, after the push has already allocated and dropped its
buffers, so the memory delta isolates the download. The benchmark drives the CLI adapter, which
supplies the runtime's native streaming SHA-256; the plugin uses the TypeScript fallback, so its wall
clock may be higher while the memory bound is the same.

| 64 MiB version               |    Before |    After | Change |
| ---------------------------- | --------: | -------: | -----: |
| Pull wall clock              |  665.3 ms | 561.5 ms | −15.6% |
| Pull peak RSS above baseline | +79.6 MiB |    0 MiB |  −100% |
| Pull ArrayBuffers above base | +14.4 MiB |    0 MiB |  −100% |
| Push wall clock (unchanged)  |  698.1 ms | 712.6 ms |  +2.1% |

| 256 MiB version              |     Before |     After | Change |
| ---------------------------- | ---------: | --------: | -----: |
| Pull wall clock              |  2257.9 ms | 2017.9 ms | −10.6% |
| Pull peak RSS above baseline | +318.7 MiB |     0 MiB |  −100% |
| Pull ArrayBuffers above base | +300.5 MiB | +46.6 MiB | −84.5% |
| Push wall clock (unchanged)  |  2859.3 ms | 2681.8 ms |  −6.2% |

The 256 MiB pull's absolute peak RSS was 1074 MiB before and 757 MiB after; the remaining
difference is the push phase's retained buffers, which the phase baseline already includes. The
+46 MiB that remains in `arrayBuffers` is the bounded in-flight window (roughly a handful of
4 MiB chunks waiting for garbage collection), not a function of the file size: the 64 MiB pull
shows none. The push timings are the unchanged upload path and move by a few percent between
runs; they are not a regression signal.

The pull also got faster, because the old path copied the decrypted chunks into one buffer and
hashed that buffer again before writing it; the streaming path writes each chunk and hashes it
as it arrives (native in the CLI). Loopback has no network latency, so a real WAN download
spends proportionally more time in transit and less in this CPU work — the wall-clock gain is a
loopback best case.

`bun run bench large`'s invariants still pass: `bytesEqual`, `chunkedEncoding`,
`chunkIndicesSequential`, `pushBodyEmpty`, `pullStreamsOneWrite` and `pullStreamsEveryChunk`.
The peer-download cases in `large-file.e2e.test.ts` and the plugin's large attachment case in
`plugin.e2e.test.ts` assert the same bytes and that no temporary file is left behind.

## What is still whole-file

**Upload.** A push still reads, hashes and encrypts the whole file, because a streamed upload
needs an incremental SHA-256 (the content hash is the blob address, the rename-reuse key and the
deduplication key) or a protocol-level change to a chunk-hash manifest. That item stays
open. On a phone, a large file is much more likely to be downloaded than created, which is
why the download half came first.

**Restore.** `restoreFile` fetches a version into one buffer because it then pushes those bytes
back as the restore version. Streaming both halves would need the upload path above.

**Conflict resolution.** `handleConflict` reads the local side whole before applying the remote
one, because the local bytes are what gets parked in the conflict copy. A large attachment that
conflicts on both sides is therefore still read whole once; the ordinary pull is not.

**Small files.** A version at or below the 8 MiB threshold is still fetched and written in one
piece. That is the same trade as the chunk threshold: one request and one buffer are cheaper than
several round trips, and the memory is bounded by the threshold. The whole-buffer path for a
chunked version (a host without `beginWrite`, or the fallback) still checks the final hash.

## Files

- `packages/engine/src/adapter.ts` — `SyncWriteStream`, optional `beginWrite`.
- `packages/engine/src/engine.ts` — `writeRemoteVersion`, `streamRemoteVersion`,
  `fetchRemoteChunk`; stat-based existence checks.
- `packages/cli/src/fs-adapter.ts` — `fs`-handle implementation.
- `packages/plugin/src/unified/adapter.ts` — data-adapter implementation, `pendingIndex`,
  index-lag fallbacks.
- `packages/e2e/src/bench/sync.bench.test.ts` — streamed-write counters and invariants.
- `packages/e2e/src/large-file.e2e.test.ts`, `packages/e2e/src/plugin.e2e.test.ts` — bytes and
  temporary-file assertions.
