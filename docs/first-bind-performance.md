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
the request now overlap; the download is dominated by one content request plus one write per file, not by
a limit.

Before the fixes the same 10 000-file bind took 28.1 s, a 12 500-file vault **failed** after 33 s and
needed ~25 minutes of five-minute retries to finish, a 50 000-file bind needed ~26 hours of extrapolated
retries, and a 10 000-file download reported success with 8 000 files missing. Those defects — and what
was done about them — are the record below.

## Empty local vault, large remote

The other direction of the same first connect: this device has nothing, the remote holds the vault. It is
one content request per file in the pipeline below — the batch content route (`POST …/sync/contents`)
now carries a wave's four reads in one request, but a round trip still carries four files, because the
pass runs four at a time (the measurement is under **Download**).

| 50 000 files, 115 MiB | Before                                                                                        | After                               |
| --------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------- |
| Wall time             | 141.6 s for 45 778 files, then a **failed pass**, then 20.8 s for the rest (~162 s, 2 passes) | **140.9 s, 50 001 files, one pass** |
| Result                | the transfer limit cut the pass off mid-vault                                                 | no errors; `filesOnDisk` 50 001     |
| Second pass           | 20.8 s (the remainder)                                                                        | 8.4 s (index + stamps, no reads)    |

Two things changed: the transfer allowance is now sized for a download (60 000/min, so the limiter stops
being the ceiling at this size), and a refused content read **waits out the window** instead of failing
the pass. The per-file pipeline — one decrypt, one write, one stat, four at a time — is why 50 000 files
settle at ~2.8 ms each. The requests a first download costs are four times fewer than that pipeline
suggests (see **Download**); the wall clock is unchanged, because the waves are the same. Moving the
clock needs a prefetch that puts more than four files in one round trip — the plan under **Planned next**.

## Method

Real code only: the real `SyncEngine`, the real CLI `FsAdapter`, and a real server (SQLite + `Bun.serve` +
ws). The synthetic vault is 40 folders of 0.8–4 KiB notes plus one 1 MiB attachment (a typical note
vault's shape). Everything ran on one Windows machine with the server on `127.0.0.1`, so **network
latency is absent** and the numbers below are optimistic for a deployed server; the Obsidian adapter
(`readBinary` over Electron IPC) is also slower than `fs.readFile`, so the local half is optimistic as
well. The database is in WAL mode, which is what `courier migrate` does in production; the e2e harness's
own schema setup leaves SQLite's default rollback journal, where the same bind is ~1.6× slower.

Two opt-in benchmarks (`COURIER_BENCH=1`):

| File                                                        | What it measures                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/e2e/src/research/first-bind.bench.test.ts`        | upload bind, steady-state pass, download bind                              |
| `packages/e2e/src/research/first-bind-limits.bench.test.ts` | server marginal cost, the deployed limiters, a bind larger than one window |

```bash
COURIER_BENCH=1 COURIER_BENCH_WAL=1 COURIER_BENCH_FILES=10000 \
  bun --bun vitest run packages/e2e/src/research/first-bind.bench.test.ts
COURIER_BENCH=1 COURIER_BENCH_FILES=12500 \
  bun --bun vitest run packages/e2e/src/research/first-bind-limits.bench.test.ts
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
wave travel together.

**What the batch actually buys, measured** (1 000 files, L1, RTT injected on the client's transport):

| 1 000-file cold download | requests | 1 ms RTT | 30 ms RTT |
| ------------------------ | -------: | -------- | --------- |
| one request per file     |     1000 | 1 105 ms | 9 254 ms  |
| batched (this change)    |  **250** | 1 073 ms | 9 308 ms  |

The wall clock is the same — the pool already keeps four reads in flight, so a batch of four costs the
same round trip one request per file did — and the **request count falls 4×**, which is what keeps a fast
link under the transfer limiter and cuts the server's handler work. A batch that waits for a timer before
it goes out makes this _worse_, not better: with a 5 ms hold the same download took 2.3 s locally. The
read pipeline, not the batch, would be the lever for time: prefetching a wave ahead would put more files
per round trip, which is a larger change than this one.

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
  allowance — and a 50 000-file first download finishes in one pass in ~141 s. The steady state
  afterwards is 0.6 s per pass at 10 000 files, 8.4 s at 50 000 (one `stat` per file).
- **Interruptions:** a refused batch, a rate-limited window, or a dropped connection now costs one batch
  or one window, not hours. A partially failed bind leaves the unlanded files untracked, so the retry
  re-batches them.

## Remaining work

- **The local scan of a first bind.** It is one `stat` per file (0.6 s per 10 000, 8.4 s per 50 000) and it
  is now what a cold start spends its time on; the download's request count is no longer the ceiling (the
  content route batches the reads of a wave, and only the pool's concurrency bounds it).
- **The same measurement on a real network and on mobile.** Everything here is localhost on a desktop;
  the per-batch RTT and the adapter's IPC cost are what a phone makes of the same numbers.
- **A peer that is online during the bind.** Not covered by the numbers above, because the harness
  starts the second device after the first one finished: in the real two-window case the peer receives
  one `file_pushed` per file and used to answer each with its own `POST /sync/pull`. That spent the
  600/minute window on 548 files of 5 000 and left the rest to the next pass. Notifications are now
  coalesced into batched chain pulls (200 per request, 25 ms of holding); see
  [sync-engine.md](sync-engine.md#pass-order-and-concurrency).

## Planned next: a prefetch pipeline (not implemented)

> Status: **design, not behaviour.** Nothing below exists in the engine today; the measurements above
> are the baseline it has to beat, and the plan is recorded here because this document owns the
> optimization plan.

**The problem the batch content route did not solve is time, not requests.** A download costs
_round trips × waves_, where a wave is one `maxConcurrent` (four) of per-file operations: each wave
waits for its own content request. The batch route turned a wave's four requests into one, which divides
the request count by four but leaves the number of waves — and therefore the wall clock — where it was
(measured: 1 105 ms against 1 073 ms at 1 ms RTT, 9 254 ms against 9 308 ms at 30 ms). To go faster,
**one round trip has to carry more files than the pool has slots**.

**Design: a prefetcher beside the pass, not a wider pool.**

- **Raise only the content pipeline.** The `WorkPool`/`OpQueue` concurrency stays at four: it also runs
  pushes, deletes and large files, and each of those holds a plaintext copy in memory — that bound is
  what protects a phone. The prefetcher holds **ciphertext only**, and nothing else changes.
- **Fill it before the per-file loop.** After a pass has the index and the local scan, it knows which
  chains' bytes are not on this device: a chain whose head hash is neither in the local hashes nor in the
  state's last known hash. Those paths — and the same set for a notification burst, from the chains it
  already fetched — are a **superset** of what `decideFile` will pull. A wrong guess costs one download
  that is discarded; it cannot change a decision.
- **Fetch them ahead, in wide batches.** A `ContentPrefetcher` owns the queue: up to `batchFiles` (32)
  hashes or `batchBytes` (8 MiB) per request, `concurrency` (2) requests in flight, so up to 64 files are
  in one round trip instead of four. It reuses `POST …/sync/contents` — the server already accepts 64
  hashes and refuses an answer over 16 MiB — so the protocol does not change.
- **Consume exactly as today.** `fetchContentBatched` checks the prefetch store first and falls back to
  the current wave batch on a miss. Ciphertext is decrypted and verified per file by the reader, exactly
  as now; the store is an LRU capped at `storeBytes` (8 MiB), so dropped entries simply cost a re-fetch.

**Bounds and failure semantics.**

| Situation                                     | Behaviour                                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Prefetch hit                                  | The file decodes immediately; a download wave costs no round trip                         |
| Miss / evicted                                | Fall back to the current per-wave batch (unchanged)                                       |
| 429                                           | Waited out by `withRateLimitWaits`, as every bulk read is; the store keeps serving        |
| Whole-request failure                         | Marked "not prefetched", **never raised to the pass**; the on-demand read retries         |
| Hash the store does not hold (`404`)          | A `null` entry with a TTL, the same "nothing to apply" as today                           |
| `stop()` / `whenIdle()`                       | In-flight prefetches count as background work; `stop` rejects waiters and drops the store |
| Wasted prefetch (conflict, cap, out of scope) | Discarded; counted for tuning, never reported as activity                                 |

Peak extra memory is ciphertext: the store (8 MiB) plus the in-flight requests (2 × 8 MiB) ≈ 24 MiB,
bounded by bytes rather than by file count. The per-file plaintext bound is untouched.

**Rejected alternatives.** Raising `maxConcurrent` would speed this up and shove every other per-file
operation (and its plaintext copy) up with it — the phone-memory guard exists for that. Multi-range
requests (`multipart/byteranges`) only help one large file and add a response format. Server push over
the WebSocket would be a contract change for a transport-level win.

**Expected effect, to be measured rather than promised.** 1 000 files at 30 ms RTT (today 9.31 s) becomes
about sixteen content requests, so the network term is ~0.5 s and what remains is decrypting and writing
four at a time (~1–2 s): roughly 2–3.5 s. On localhost the win is small, because RTT is not the bottleneck
there — which is why the existing benchmark runs both.

**Verification plan.** L0 for the prefetcher (byte/count caps, LRU eviction, hit/miss, a failed prefetch
not failing the pass, a `404` TTL, `stop` rejecting waiters), L1 for a 1 000-file cold bind with an
injected round trip (requests, wall clock, peak store bytes) and for a mixed push/pull pass, L3 for a real
Obsidian bind over a 3 000-file vault, and an extension of `first-bind.bench.test.ts` comparing prefetch
on/off locally and at 30 ms RTT. Off by default behind `prefetch: { enabled, batchFiles, batchBytes,
concurrency, storeBytes }`, enabled for a pass whose candidate count is above a threshold, so a small
pass keeps today's path.

**Decisions to take before implementing.** (1) The phone memory budget — the proposal is 8 MiB store plus
two 8 MiB requests. (2) Whether it ships enabled or behind an opt-in for one measurement round; the
diagnostic counters (hit rate, wasted prefetches) should decide, not intuition.

## Files

- `packages/e2e/src/research/timing.ts` — counters and clocks around the adapter/API.
- `packages/e2e/src/research/first-bind.bench.test.ts` — upload / steady state / download.
- `packages/e2e/src/research/first-bind-limits.bench.test.ts` — production limiters, server marginal
  cost, a bind bigger than one window.

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

Two limits stay: a **download** still pays one round trip per wave of four files (its request count is
four times lower, its wall clock is not — see **Download**), and a first bind still scans the vault —
the levers listed under Remaining work.
