# First bind of a large local vault: measured cost and limits

Status: research measurement, recorded 2026-10-26. The **before** numbers are commit `cc395e2`; the
fixes described below are on the same branch as this document.

**Question.** A user already has a big vault on disk (thousands of notes, years of history) and connects
it to a remote vault for the first time. What does that first pass cost, and is it acceptable?

**Answer.** The pass is linear in the vault and, on a healthy server, cheap enough:

| Vault        | Upload bind (empty remote) | First download (empty local vault) | Steady state afterwards |
| ------------ | -------------------------- | ---------------------------------- | ----------------------- |
| 10 000 files | **16.6 s**                 | 28 s                               | 0.6 s per pass          |
| 12 500 files | 23.6 s, one pass           | —                                  | 0.8 s per pass          |
| 50 000 files | **82.9 s** (115 MiB)       | **140.9 s** (115 MiB)              | 8.4 s per pass          |

Per-file cost is ~1.7 ms up and ~2.8 ms down on this machine (localhost, WAL, four concurrent small
files). The upload number is about twice as fast as the earlier measurement because batch preparation and
the request now overlap; the download was measured at one content request plus one write per file, and
since 2026-11-08 a read-ahead makes it one content request per **64** files instead (see
[that section](#2026-11-08-a-download-read-ahead-measured)) — so a download's cost is now the write, not
the round trip.

Before the fixes the same 10 000-file bind took 28.1 s, a 12 500-file vault **failed** after 33 s and
needed ~25 minutes of five-minute retries to finish, a 50 000-file bind needed ~26 hours of extrapolated
retries, and a 10 000-file download reported success with 8 000 files missing. Those defects — and what
was done about them — are the record below.

## Empty local vault, large remote

The other direction of the same first connect: this device has nothing, the remote holds the vault. The
pipeline below is the **wave** read — one content request for a wave's four files — and since
2026-11-08 a read-ahead puts 64 versions in one request, so the round trip no longer decides how many
files a pass can take (the measurements are under **Download** and
[2026-11-08](#2026-11-08-a-download-read-ahead-measured)).

| 50 000 files, 115 MiB | Before                                                                                        | After                               |
| --------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------- |
| Wall time             | 141.6 s for 45 778 files, then a **failed pass**, then 20.8 s for the rest (~162 s, 2 passes) | **140.9 s, 50 001 files, one pass** |
| Result                | the transfer limit cut the pass off mid-vault                                                 | no errors; `filesOnDisk` 50 001     |
| Second pass           | 20.8 s (the remainder)                                                                        | 8.4 s (index + stamps, no reads)    |

Two things changed: the transfer allowance is now sized for a download (60 000/min, so the limiter stops
being the ceiling at this size), and a refused content read **waits out the window** instead of failing
the pass. The per-file pipeline — one decrypt, one write, one stat, four at a time — is why 50 000 files
settle at ~2.8 ms each on localhost; the reads feeding it are now 64 to a request (measured: 1 001 files
went from 10.1 s to 0.76 s at an injected 30 ms, and 5 001 from 46.6 s to 2.1 s), so what is left at that
size is the local half, not the network.

## Method

Real code only: the real `SyncEngine`, the real CLI `FsAdapter`, and a real server (SQLite + `Bun.serve` +
ws). The synthetic vault is 40 folders of 0.8–4 KiB notes plus one 1 MiB attachment (a typical note
vault's shape). Everything ran on one Windows machine with the server on `127.0.0.1`, so **network
latency is absent** and the numbers below are optimistic for a deployed server; the Obsidian adapter
(`readBinary` over Electron IPC) is also slower than `fs.readFile`, so the local half is optimistic as
well. The database is in WAL mode, which is what `courier migrate` does in production; the e2e harness's
own schema setup leaves SQLite's default rollback journal, where the same bind is ~1.6× slower.

Opt-in benchmarks (`COURIER_BENCH=1`):

| File                                                          | What it measures                                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/e2e/src/research/first-bind.bench.test.ts`          | upload bind, steady-state pass, download bind                              |
| `packages/e2e/src/research/first-bind-limits.bench.test.ts`   | server marginal cost, the deployed limiters, a bind larger than one window |
| `packages/e2e/src/research/download-read-ahead.bench.test.ts` | a cold download with the read-ahead on and off, at 0 and 30 ms per request |

```bash
COURIER_BENCH=1 COURIER_BENCH_WAL=1 COURIER_BENCH_FILES=10000 \
  bun --bun vitest run packages/e2e/src/research/first-bind.bench.test.ts
COURIER_BENCH=1 COURIER_BENCH_FILES=12500 \
  bun --bun vitest run packages/e2e/src/research/first-bind-limits.bench.test.ts
COURIER_BENCH=1 COURIER_BENCH_FILES=1000 COURIER_BENCH_RTT=30 \
  bun --bun vitest run packages/e2e/src/research/download-read-ahead.bench.test.ts
```

The refused-batch reproduction that used to sit beside them was removed once the fix landed: what it
measured — one refused batch costs one batch, not the rest of the pass — is pinned by the `a first bind
that meets the server's limits` cases in `packages/engine/src/engine.test.ts`, which run in the default
gate instead of behind `COURIER_BENCH`.

## Where a first bind spends its time

A bind of 10 001 files (23.9 MiB) against an empty remote, after the fixes:

| Phase                                       | Measured   | Notes                                                        |
| ------------------------------------------- | ---------- | ------------------------------------------------------------ |
| local scan (`stat` + hash of claimed files) | 0.4 s      | 10 001 reads; unclaimed files are read by the create instead |
| 101 push requests (100 files each)          | 16.1 s     | 1.7 ms/file over loopback, prepared while the previous flies |
| index and bookkeeping                       | ~0.5 s     | one `GET /sync/index`                                        |
| **total**                                   | **16.6 s** | 1.7 ms/file                                                  |

At 50 000 files the same push phase is 79.4 s (1.6 ms/file) — the per-batch time stays flat from batch 1
to batch 500, which is what says the pass is linear rather than quadratic.

The server's own marginal cost, measured directly (100-file batches, WAL):

| 100-file batch                         | Before | After     |
| -------------------------------------- | ------ | --------- |
| 100 distinct payloads (blob + row)     | 132 ms | **52 ms** |
| 100 files sharing one blob (rows only) | 115 ms | 41 ms     |
| 100 tombstones (rows only)             | 89 ms  | 21 ms     |

That drop is the batch transaction: 100 commits (each an fsync) became one.

A second pass over the same vault costs 0.6 s (0.06 ms/file): every stamp still matches, so nothing is
read and nothing is pushed.

### Download (an empty device meets a full remote)

| Scenario     | Before                                   | After                                |
| ------------ | ---------------------------------------- | ------------------------------------ |
| 2 000 files  | 4.9 s, all landed                        | 4.9 s, all landed                    |
| 10 000 files | 35.1 s, **2 000 landed, `error: null`**  | **27.9 s, 10 001 landed, no errors** |
| 50 000 files | ~162 s over two passes, first one failed | **140.9 s, one pass**                |

One request per remote file, so the transfer allowance used to be the ceiling (2 000/min). It is now
60 000/min — above what the per-file pipeline can use — and a refusal is waited out instead of ending the
pass. The numbers above are the **per-file** pipeline at four concurrent files; since the batch content
route (`POST …/sync/contents`, [api.md](api.md#11b-get-several-versions-content-at-once)) the reads of a
wave travel together, and a read-ahead puts **several waves** in each request (see
[the 2026-11-08 section](#2026-11-08-a-download-read-ahead-measured)).

**What each step buys, measured** (1 001 files / 3.3 MiB, L1; the round trip is injected on the client's
transport, and each row is one run of the tree this document describes):

| 1 001-file cold download                      | requests | ~0 ms RTT  | 30 ms RTT  |
| --------------------------------------------- | -------: | ---------- | ---------- |
| per-wave batch (the route before this change) |      251 | 646 ms     | 10 132 ms  |
| read-ahead (64 per request)                   |   **16** | **335 ms** | **764 ms** |

The wave batch itself divided the **request count** by four without moving the clock — its own A/B measured
9 254 ms one request per file against 9 233 ms batched at 30 ms, because the pool already keeps four reads
in flight, so a batch of four costs the same round trip one request per file did. A batch that waits for a
timer before it goes out makes this _worse_, not better: with a 5 ms hold the same download took 2.3 s
locally. The read pipeline, not the batch, is the lever for time — a read-ahead that puts more files in one
round trip is what turns `waves × RTT` into `requests × RTT` (measured above: 10.1 s → 0.76 s; 5 001 files
at 30 ms, 46.6 s → 2.1 s).

## The three cliffs (before the fixes)

These are the defects the measurement found; each was reproduced, then fixed, and each fix has a test.

### 1. A refusal dropped every later batch, and stranded its files

`createUntrackedFiles` flushed with `firstFailure ??= await flush()`. `??=` does not evaluate its
right-hand side once `firstFailure` is set, so after the first refusal **no further batch was sent** —
while the loop kept reading, encrypting and recording every remaining file in `this.state` with no
version. Measured: 251 files, first batch refused → `batchesAttempted: [100]`, `stateEntries: 251`,
`stateEntriesWithoutVersion: 251`.

Those phantom entries then made the next pass push the files **one request per file** (201 files = 201
requests, 119 accepted before the limiter refused again). Recovery was therefore limited by the request
budget, not by bandwidth, and the plugin retried every five minutes: a 20 000-file vault needed ~5.5
hours, a 50 000-file one ~26 hours.

### 2. Rate limits were request-based and sized for steady state

| Limiter  | Before    | Applied to                                    | Bind cost                     |
| -------- | --------- | --------------------------------------------- | ----------------------------- |
| `sync`   | 120/min   | push, pull, index, versions, history, deleted | 1 request per 100 local files |
| transfer | 2 000/min | version content, chunk staging                | 1 request per remote file     |

A 12 101-file bind measured: 120 pushes (12 000 files) in 29 s, the 121st refused, the bind failed at
33 s. A 10 000-file download was cut off at 2 000 files. No client code read `Retry-After` or retried a
429; the server did not send one.

### 3. A refused pull looked exactly like a missing blob

`fetchRemoteBytes` caught **every** error and answered "content unavailable", and the reconcile tolerated
that answer. So a 429 (or a 5xx, or a dropped connection) during a first download made the pass report
success while the device stayed incomplete — the 10 000-file case above.

## What changed

**Engine**

- The batch flush is always awaited (`const failure = await flush(); firstFailure ??= failure;`), so a
  refused batch costs one batch, not the rest of the pass.
- A refused create **drops its pending state entry** (`dropPendingCreate`): the file is untracked again and
  the next pass retries it through the batched create path (100 files per request instead of 1). Only the
  pending shape is dropped, so a version a concurrent event pushed in the meantime survives.
- A `429` is **waited out** (`withRateLimitWaits`, using the server's `Retry-After`), and the same batch
  is re-sent; only after `MAX_RATE_LIMIT_WAITS` does the pass stop and leave the rest untracked. The wait
  applies to single-file pushes **and to content reads**, so a large first download waits instead of
  failing.
- **Preparation and the request overlap**: a full batch is handed to the wire and the next one is read,
  hashed and encrypted while it flies. At most one batch is in flight and one is being built; a large file
  still travels alone and a chunked upload still runs without another request interleaved.
- A pass reports **progress** (`SyncProgress{done,total}`, coarse steps plus one report at the end);
  `SyncHost.binding` says whether it is still the first pass and `SyncHost.firstSync` additionally
  requires that no bind ever completed (a flag the host persists beside the per-file state), so a bind
  killed half-way keeps its counter on the next start. The plugin shows it in the status bar's tooltip
  and counts a bind as `syncing`; the CLI logs a line per tenth.
- A wait is **reported** (`onRateLimited`), so a pass that sits out a limiter window is not mistaken for a
  hang: the CLI logs it, the plugin says it on the console.
- The pull path distinguishes "the store holds nothing" (`404`, undecryptable) from "the request did not
  happen" (`429`, `5xx`, transport): the first is tolerated as before, the second **fails the pass** so
  the host retries it and the user sees it.
- The scan fetches the sync index **first** and hashes only files a chain or a state entry can claim; the
  rest are read once, by the create that needs the bytes anyway. A first bind reads the vault once
  instead of twice.
- The scan's per-file work runs through `WorkPool` (4 at a time) instead of one serial await per file.
- A failed bind is retried by the host on its own backoff (30 s → 60 s → … → the reconcile interval)
  instead of waiting for the five-minute periodic pass.

**Server**

- `tryInsertFileVersions`: one transaction for a whole push batch, still checking each row's chain head
  inside it. ~0.9 ms of fsync per file became one commit per 100 files.
- Rate limits raised to 600/min (sync) and 60 000/min (transfer), sized for a bind; a 429 now carries a
  standard `Retry-After`.
- The shared HTTP client surfaces `retryAfterMs` on `ApiClientError`, read from `Retry-After`.

**Docs**: [sync-engine.md](sync-engine.md) (batching, pipelining, progress, pull failures, read-once,
host retry), [api.md](api.md) (rate limits, `Retry-After`), [server.md](server.md) (the batch
transaction), [plugin.md](plugin.md) (the status bar's first-sync state), [cli.md](cli.md) (the progress
line).

## Verdict

- **Up to ~20 000 files, healthy server:** a first connect is a one-off 15–75 s locally, and roughly two
  to three times that over a real network (upload bandwidth and per-batch RTT). Acceptable.
- **Tens of thousands of files:** linear — 50 001 files is 501 pushes in 83 s, inside the 600/min
  allowance — and a 50 000-file first download finishes in one pass in ~141 s on localhost. The steady
  state afterwards is 0.6 s per pass at 10 000 files, 8.4 s at 50 000 (one `stat` per file). The download
  figure predates the read-ahead: at 64 versions per request (2026-11-08) the 5 001-file bind went from
  46.6 s to 2.1 s at an injected 30 ms, so what is left at that size is the local half.
- **Interruptions:** a refused batch, a rate-limited window, or a dropped connection now costs one batch
  or one window, not hours. A partially failed bind leaves the unlanded files untracked, so the retry
  re-batches them.

## Remaining work

- **The local scan of a first bind.** It is one `stat` per file (0.6 s per 10 000, 8.4 s per 50 000) and it
  is now what a cold start spends its time on; the download's request count is no longer the ceiling (the
  read-ahead puts 64 versions in one request, and only the pool's concurrency bounds the per-file half).
- **The same measurement on a real network and on mobile.** Everything here is localhost on a desktop
  (plus injected RTT); the adapter's IPC cost and the memory budget of the read-ahead on a phone are what
  a real device makes of the same numbers.
- **A peer that is online during the bind.** Not covered by the numbers above, because the harness
  starts the second device after the first one finished: in the real two-window case the peer receives
  one `file_pushed` per file and used to answer each with its own `POST /sync/pull`. That spent the
  600/minute window on 548 files of 5 000 and left the rest to the next pass. Notifications are now
  coalesced into batched chain pulls (200 per request, 25 ms of holding); see
  [sync-engine.md](sync-engine.md#pass-order-and-concurrency).

## Files

- `packages/e2e/src/research/timing.ts` — counters and clocks around the adapter/API.
- `packages/e2e/src/research/first-bind.bench.test.ts` — upload / steady state / download.
- `packages/e2e/src/research/first-bind-limits.bench.test.ts` — production limiters, server marginal
  cost, a bind bigger than one window.
- `packages/e2e/src/research/download-read-ahead.bench.test.ts` — a cold download with the read-ahead
  on and off, at 0 and 30 ms per request.

## 2026-10-30: per-blob `fsync` removed, batch writes run concurrently

Re-measured on an Apple M1 (macOS 26.6, server on `127.0.0.1`, 5 000 notes of
1–4 KiB, 12.3 MiB): the upload bind took **22.1 s**, and its push phase was the same 22.1 s — every
byte of the gap was the `fsync` in `writePartsAtomic`, one per blob, awaited one file at a time.
A micro-benchmark of the same write pattern measured 4.5 ms per blob with the flush and 0.46 ms
without it.

The store now writes a batch's payloads into **one file** and flushes it **once per push batch**:
the batch appends them, one `fsync` makes the batch durable, and only then do the rows that name
those bytes commit (`docs/blob-files.md` has the layout and the reclaim rule). A flush per blob was
the 22 s; a flush per batch is the 2.5 s.

| 5 000-file bind               |      Push |  Pull |
| ----------------------------- | --------: | ----: |
| before (flush per blob)       |    22.1 s | 3.5 s |
| no flush at all               |     1.9 s | 3.5 s |
| **flush per batch (current)** | **2.5 s** | 3.5 s |

A read resolves the row (one indexed lookup, measured at 0.058 ms per call) and reads the range
with one `pread`, where the old layout derived the path from the hash and opened the file. On this
machine the 5 000-file `many` pull measures 14.7 s (base) against 16.7 s (batch files), and the
churn pull at 500 files is level (1.39 s against 1.42 s). Ruled out as causes: the row lookup
(0.29 s over 5 000 calls), the file layout (a run that wrote one blob per file measured the same
16.6 s pull), and test ordering (reversing the sides did not change the result). The delta scales
with the number of blobs and nothing attributes it yet; it is recorded as an open item rather than
papered over.

What remains is ~0.38 ms per file: the local `stat`/read half (~0.8 s for the vault), encryption,
50 HTTP requests and 50 SQLite commits. The next levers are batch size (100 files / 8 MiB today) and
the per-request fixed cost, not the store.

## 2026-11-07: a bulk local write (one push per file)

The bind passes above were never the whole story: **the event path was one request per file**, and that is
what a generator, an agent or a "drop a folder in" produces. Measured at L1 — two real `SyncHost`s (the
loop both clients run) against a real server, one device writing 1 000 notes into its vault and firing the
watcher event each write would fire, the other online and bound:

| 1 000 generated notes  | Before           | After (one batched job) |
| ---------------------- | ---------------- | ----------------------- |
| pushing host           | **1 000** pushes | **14** pushes (4 + 10)  |
| peer                   | 125 chain pulls  | 11 chain pulls          |
| vault scans            | —                | **0** (not a pass)      |
| wall clock (localhost) | 6.0 s            | 1.5 s                   |

The same shape for the other two bulk operations, measured the same way (300 files each):

| 300 files | Before                       | After                        |
| --------- | ---------------------------- | ---------------------------- |
| edits     | 300 chain reads + 300 pushes | **6 chain reads + 7 pushes** |
| deletions | 300 pushes                   | **3–7 pushes**               |

Both numbers before are per-file requests against a **600/minute** sync allowance: the 1 000 pushes are
refused after about a minute, and the client then sat out whole limiter windows while the rest of the
vault waited for the five-minute pass. That is the "it syncs a few hundred files and then stops" report.
The peer's 125 pulls were the same shape from the other side (a notification arriving after each push is
its own chain request when the pushes are not batched; here they clustered, on a real network they do
not).

The fix is in the engine, driven by the host: more than `LOCAL_EVENT_BURST_SIZE` (4) local events inside
`LOCAL_EVENT_BURST_WINDOW_MS` (500 ms) are collected and handed to **one job**
(`SyncEngine.handleLocalEvents`), which decides each path exactly as a single event would and sends the
versions 100 per request, with tracked files' chains fetched 200 per request. There is no vault walk and
no per-file listing: one listing is read per job (only when it has changes), and a job that restores files
reads the chain index once for the job, so the cost follows the burst rather than the vault. The rule (and
its guards: the engine's own writes are not counted, a burst still writing during the job owes one more
job, changes / deletions / moves are their own lists) is in
[sync-engine.md](sync-engine.md#pass-order-and-concurrency); the cases are `bulk-write.e2e.test.ts`, run
against the deployed 600/minute allowance rather than the harness's raised one.

One limit stays: a first bind still scans the vault — the lever listed under Remaining work. The
download that follows a bulk push is no longer one round trip per wave of four files: the read-ahead of
2026-11-08 (next section) carries 64 versions per request, for the peer's burst and for a cold bind
alike.

## 2026-11-08: a download read-ahead (measured)

**The problem the batch content route did not solve was time, not requests.** A download cost
_round trips × waves_, where a wave is one `maxConcurrent` (four) of per-file operations: each wave
waited for its own content request. The batch route turned a wave's four requests into one, which divides
the request count by four and leaves the number of waves — and therefore the wall clock — where it was
(measured: 1 105 ms against 1 073 ms at 1 ms RTT, 9 254 ms against 9 308 ms at 30 ms). One round trip
had to carry more files than the pool has slots.

**What was built: a read-ahead beside the pass, not a wider pool.** `ContentPrefetcher`
(`packages/engine/src/content-prefetch.ts`) is fed the versions a pass or a notification burst is about
to pull, and reads them ahead in wide batches. The per-file loop asks it first (`ContentReader.read`) and
falls back to the wave batch it always had.

- **Only the content pipeline is widened.** `WorkPool`/`OpQueue` concurrency stays at four: it also runs
  pushes, deletes and large files, and each of those holds a plaintext copy — that bound is what protects
  a phone. The read-ahead holds **ciphertext only**, so it does not raise it.
- **The candidates are a superset in the ordinary case, and a wrong guess cannot change a decision.**
  After the index and the local scan, every live chain whose head content is not among the hashes the scan
  just took is queued, in the pass's own priority order. A conflict copy, a local edit that decides as a
  push, or a path the size cap refuses may still be read: the bytes are downloaded and dropped. Decryption,
  verification and the write stay in the pull that needs them, exactly as before. It is not a _strict_
  superset — bytes this device holds at another path are not in that set — so such a pull is simply read
  the old way, at the cost of one request. The state's recorded sync points are deliberately **not**
  consulted: a record outlives the bytes it describes, and treating it as content this device holds would
  leave exactly the pulls that matter (a peer's revert, a conflict settled the remote's way) outside the
  read-ahead.
- **64 hashes or 4 MiB per request, two in flight.** The route accepts 64 hashes and answers up to
  16 MiB; the limits a host may override are normalized against both, because a request the route
  refuses would reject every read in it. A version above the 4 MiB request cap is never queued — it
  would be a request of its own, and a read-ahead is for the many small files that make a round trip
  the unit of progress — so it keeps the wave read the pool already gives it. The store is an LRU
  capped at 8 MiB / 4 096 entries, and it is a **buffer, not a cache**: a taken answer leaves it, which
  is what frees room for the next request — a read-ahead may only be ahead of the reader by what the
  store holds, or a fast link would outrun a slow writer and every evicted entry would cost a second
  read.
- **Nothing here is a failure path.** A hit answers with the ciphertext; a hash the store never had
  answers "not prefetched" and the caller reads it the old way; a request that failed answers "not
  prefetched" too, so the on-demand read is the retry and the one that can raise. A `404` answer is
  delivered as "nothing to apply" but **not cached**: a reclaimed blob can come back, and the pull path's
  rule is that the next pass is the retry.
- **A caller that is blocked on a hash jumps the queue.** A pass and a peer's burst can be in flight at
  the same time, and the burst's apply loop runs as an exclusive job in the host — a demanded hash queued
  behind hundreds of speculative ones would stall the files the user can see, and the events behind them.
  `take` therefore promotes its hash ahead of the speculative queue.
- **The same read-ahead serves a peer's burst.** `handleFilePushedBatch` queues the heads of each chunk it
  fetched before applying them (skipping chains outside this device's scope), which is the download a peer
  that is online during a bulk push pays.

**Measured** (real engine, real server, real CLI adapter; RTT injected on the client's transport):

| Vault                  | Read-ahead | Requests | ~0 ms RTT  | 30 ms RTT    |
| ---------------------- | ---------- | -------: | ---------- | ------------ |
| 1 001 files / 3.3 MiB  | off        |      251 | 646 ms     | 10 132 ms    |
| 1 001 files / 3.3 MiB  | **on**     |   **16** | **335 ms** | **764 ms**   |
| 5 001 files / 12.4 MiB | off        |     1375 | —          | 46 570 ms    |
| 5 001 files / 12.4 MiB | **on**     |   **79** | —          | **2 092 ms** |

The read-ahead is worth **13×** at one round trip per request and **1.9×** on localhost, where the round
trip was never the bottleneck; the request count falls by the same factor as the pool concurrency it
bypasses (a wave of four → 64 files). The batch size was chosen from an earlier run that measured 32 files
per request (932 ms), 64 with a 4 MiB byte cap (892 ms) and 64 with an 8 MiB cap (827 ms) at 30 ms: the
4 MiB cap keeps the worst-case ciphertext at ~16 MiB (8 MiB store + 2 × 4 MiB in flight) and the wider
batch buys 7 %.

Run it with `COURIER_BENCH=1 bun --bun vitest run packages/e2e/src/research/download-read-ahead.bench.test.ts`
(`COURIER_BENCH_FILES`, `COURIER_BENCH_RTT`); `contentPrefetch: false` on the engine options is the
baseline it compares against.

**Rejected alternatives.** Raising `maxConcurrent` would raise every per-file operation (and its
plaintext copy) with it — the phone-memory guard exists for that. Multi-range requests
(`multipart/byteranges`) only help one large file and add a response format. Server push over the
WebSocket would be a contract change for a transport-level win.

**Pinned by**: the `ContentPrefetcher` cases in `content-prefetch.test.ts` (one request per hash, the
count/byte caps, concurrency, LRU by bytes and by entries, a failed request answering "not prefetched",
a `404` not being cached, `stop` answering its waiters); the `SyncEngine — download read-ahead` cases in
`engine.test.ts` (a cold bind reads 64 per request, a failed read-ahead request costs the pass nothing,
`contentPrefetch: false` keeps the wave, a notification burst reads ahead); and
`bulk-write.e2e.test.ts`, where a 400-note remote lands on a fresh device in ≤ 10 content requests and the
live peer's 700-file burst stays under 20.
