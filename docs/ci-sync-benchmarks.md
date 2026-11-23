# Sync benchmarks in CI

Status: **implemented** 2026-10-27. `.github/workflows/bench.yml` runs the three scenarios below on
pull requests that touch the sync path and posts a summary comment; `bun run bench <scenario>` runs
one on a developer machine. The timing is informational — only the correctness invariants fail a
run.

**Baseline, 2026-10-31** — one head-only run per scenario on Windows (i7-13790F, 24 logical CPUs,
server and vaults over `127.0.0.1`), with the suite on Vitest + Bun and the plugin built by
`Bun.build`. All invariants true; the absolute numbers are what a comparison starts from:

| Scenario | Phase                          | This machine |
| -------- | ------------------------------ | -----------: |
| `many`   | A first bind (all creates)     |     1 311 ms |
|          | A idle reconcile               |       154 ms |
|          | B first pull (whole vault)     |     2 300 ms |
|          | B idle reconcile               |       182 ms |
|          | A incremental push (30 edits)  |       151 ms |
|          | B incremental catch-up (30)    |       173 ms |
| `large`  | A push 64 MiB (chunked upload) |       630 ms |
|          | B pull 64 MiB (chunked ranges) |       314 ms |
| `churn`  | A first bind (500 notes)       |       267 ms |
|          | B first pull (whole vault)     |       285 ms |
|          | A rename 50 + delete 50        |       158 ms |
|          | B applies moves and tombstones |        94 ms |
|          | A idle reconcile               |        36 ms |

The pages below that carry older measurements ([`first-bind-performance.md`](first-bind-performance.md),
[`large-file-streaming.md`](large-file-streaming.md)) were recorded on the pre-Bun toolchain; they
keep their _findings_, and their absolute numbers are historical rather than comparable.

**Question.** Can the sync benchmarks run in CI, and can the pull request show their summary?

**Answer.** Yes. The runner is `packages/e2e/src/bench/sync.bench.test.ts` (one scenario per
process, real server + SQLite + `SyncEngine` + CLI adapter over loopback), the report is
`scripts/bench-report.ts`, and the workflow compares the merge base against the pull request on
the same runner. A comment arrives when the run finishes; the job only fails on a lost file, a
broken request count, or a crashed run.

## Scenarios

| Scenario | Default size                                              | Phases                                                                     | Invariants it pins                                                                                                                                                                                                                                                                                       |
| -------- | --------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `many`   | 3 000 notes (1–4 KiB, 7.4 MiB), 1% edited afterwards (30) | A bind → A idle → B full pull → B idle → A 30 edits four ways → B catch-up | bytes equal, every file landed, idle pass costs 0 reads / 0 pushes / 0 content requests, one content request per pulled file, two versions per edited file                                                                                                                                               |
| `large`  | one 64 MiB `media/large.mp4` (16 × 4 MiB chunks)          | A chunked push → B ranged pull                                             | blob header `flags=1`, chunk size/count/plaintext size, sequential chunk indices, push body carries 0 bytes, one streamed commit per pulled file (every chunk through the adapter sink, no whole-file write), SHA-256 equals the source                                                                  |
| `churn`  | 500 notes, then 50 renamed and 50 deleted                 | A bind → B pull → A rename + delete → B applies → A idle                   | chains stay 500 (no forked identity), every rename keeps its `fileId` and reuses its bytes, every delete ends in a tombstone and the recycle bin holds it, the peer applies moves with 0 content / 0 writes, a deleted path stays claimable so a file written there is recognised and gets its own chain |

`churn` is the scenario the other two cannot replace. `many` and `large` only create and modify;
the identity rules (a rename never sends content, a delete is a tombstone, a file written at this
device's own tombstone gets a new chain rather than the deleted one's history) live on the paths it exercises. It is also
the only scenario that grows the server's recycle bin.

Sizes are env-overridable for a research run — `BENCH_FILES=10000`, `BENCH_LARGE_MIB=512`,
`BENCH_CHURN_FILES=4000` — and every scenario is one measured process: the server, database and
vaults are created and removed per run, so a median is over independent runs.

```bash
bun run bench many     # ~25 s
bun run bench large    # ~4 s
bun run bench churn    # ~6 s
BENCH_RESULTS_DIR=.bench-results bun run bench many   # keep the JSON (default: OS temp)
```

## Do we benchmark every pull request?

**No.** `bench.yml` runs only when a pull request touches a path that can move these numbers:

- `packages/engine/**` — the sync engine itself;
- `packages/cli/**` — the adapter and HTTP client the benchmark drives;
- `packages/server/**` — blob store, batch transaction, rate limiter;
- `packages/shared/**` — wire types and blob/chunk framing;
- `packages/e2e/src/bench/**`, `packages/e2e/src/harness/**` — the runner and its harness;
- `scripts/bench.ts`, `scripts/bench-report.ts`, `package.json`, `bun.lock`,
  `vitest.config.ts`, and the workflow file.

A docs, i18n or plugin-UI change starts no benchmark and spends no minutes; a plugin
change does not move these numbers because the benchmark drives the CLI adapter and the engine, not
the Obsidian host (plugin behaviour is covered by L3). `workflow_dispatch` runs the three scenarios
once, head only, and writes absolute numbers to the run summary — useful for the benchmark itself
or to compare a machine with the runner.

The label alternative — "run it on any PR that asks" — needs either dropping `paths` (a changed-files
job on every PR, ~15 s each) or a second workflow. Not worth it at this size; a pull request can
always touch a listed path (including the bench itself) to get a run.

## What a run does

`.github/workflows/bench.yml` is two jobs.

**`bench`** (`contents: read`): checks out with full history, installs, and adds the **merge base**
as a second worktree with its own `bun install`. It then alternates base and head, three rounds
per scenario, one scenario per process:

```bash
BENCH_RUN_ID="$side-$round" BENCH_RESULTS_DIR="$run/$side" bun run bench "$scenario"
```

The base side is the commit this branch diverged from, not today's `main`, so the delta is the
pull request's change. A branch that predates the runner has no base side; the job then runs head
only and the comment says so. The raw JSON of every run is uploaded as `bench-results` (14 days).

**`comment`** (`needs: bench`, `pull-requests: write`): checks out the **base commit** — it holds
the write token and must not execute a script from the pull request — downloads the artifact, runs
`scripts/bench-report.ts`, writes the table to the run summary, and creates or updates the sticky
comment (marker `<!-- courier-bench-summary -->`). For a fork pull request the token is read-only;
the step is `continue-on-error`, so the run stays green and the summary page still carries the table.

## What the comment looks like

The first run that could post one (pull request #63, a stacked verification change that touched no
code, so both sides are the same commit) produced this `many` table:

```markdown
### many (3,000 files · 7.4 MiB · 30 edited afterwards)

| Phase                                          | Base (median) | PR (median) |       Δ |
| ---------------------------------------------- | ------------: | ----------: | ------: |
| A first bind (all creates)                     |    4,415.2 ms |  4,425.9 ms |   +0.2% |
| A idle reconcile                               |      549.6 ms |    546.2 ms |   -0.6% |
| B first pull (whole vault)                     |      5,372 ms |  5,334.6 ms | -0.7% ⚠ |
| B idle reconcile                               |      509.2 ms |    510.8 ms |   +0.3% |
| A incremental push (30 edits, host-like 4-way) |        226 ms |    221.9 ms |   -1.8% |
| B incremental catch-up (30)                    |      558.6 ms |    563.9 ms |   +0.9% |

Correctness: base 27/27 invariants held · PR 27/27 invariants held. Runs: 3 base, 3 PR; largest within-side spread 21.1%.
```

±2% on identical code is what three rounds buy; the one ⚠ on the pull is exactly the honesty the
spread column is for (that phase's own runs spanned 21%). The same run also posted `large` and
`churn` tables with 21/21 and 36/36 invariants. Cross-runner or cross-day comparisons are never
valid: use the numbers in one comment against each other, not against an older comment.

### Rules

| Rule            | Value                                                          | Where                     |
| --------------- | -------------------------------------------------------------- | ------------------------- |
| Rounds per side | 3, alternating base/head                                       | `bench.yml`               |
| Reported number | median per phase                                               | `scripts/bench-report.ts` |
| Noise floor     | 10% (stated in the comment)                                    | report                    |
| Unreliable mark | ⚠ when a side's own spread is over 20%                         | report                    |
| Hard failure    | a correctness invariant false, a run `ok: false`, a crash      | runner + report           |
| Timing failure  | none by default; `--fail-over <percent>` exists but is not set | report                    |

A red `bench` job therefore means "this benchmark could not prove the data arrived", not "this
pull request is 12% slower". If two weeks of runner data show the spread stays under ~10%, the
workflow can add `--fail-over 25`; until then a regression is a number a reviewer reads, not a gate.

## Measured cost

| What                                           | Where                | Time             |
| ---------------------------------------------- | -------------------- | ---------------- |
| `bun run bench many` / `large` / `churn`       | this Windows machine | 25 s / 4 s / 6 s |
| the `bench` job, 18 runs (a pull request)      | ubuntu-24.04, 2 vCPU | **3m13s**        |
| the `bench` job, 9 runs (bootstrap, head only) | same                 | 1m47s            |
| the `comment` job                              | ubuntu-latest        | 13 s             |

The first live pull requests (#62 and #63, 2026-10-27) measured it: **~3.5 minutes per pull
request**, not the ten the local numbers suggested. The Linux runner was faster on the file-heavy
phases (bind 4.4 s against 8.9 s, pull 5.3 s against 8.4 s at 3 000 files) even with two logical
CPUs: the Windows filesystem and Defender cost more than the smaller CPU did. The runner is an
`AMD EPYC 7763` with 2 logical CPUs, 8 GB of RAM and a 14 GB disk; a public repository would get
4 vCPU / 16 GB.

The research sizes are heavier and stay local: 10 000 files ≈ 63 s and 512 MiB ≈ 21.5 s per run on
this machine. The longer-lived measurements and the per-phase breakdown are in
[first-bind-performance.md](first-bind-performance.md).

On the runner, keep an eye on disk: 3 000 notes are ~7 MiB, the 64 MiB file becomes a 64 MiB blob,
and both sides plus the server live under `$RUNNER_TEMP` — well under 1 GB against a 14 GB disk.

## Alternatives considered

| Option                                                                                                    | Why not                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`benchmark-action/github-action-benchmark`](https://github.com/benchmark-action/github-action-benchmark) | Tracks history on `gh-pages` and posts "X% change", but compares against the last stored run on the base branch, so runner drift becomes the delta. A possible trend addition later, not the per-PR comparison. |
| [CodSpeed](https://codspeed.io/)                                                                          | Deterministic instruction counting, but a paid SaaS for private repositories and CPU-only, while these numbers live in SQLite commits, file I/O and loopback HTTP.                                              |
| `hyperfine`                                                                                               | A/B of a command line; the server lifecycle and fixture generation are inside the process.                                                                                                                      |
| Unit-test timing (`vitest run` on a bench file)                                                           | In-process loops; no fresh database, no real server, no byte-equality check.                                                                                                                                    |
| A committed JSON baseline                                                                                 | Measured on a different machine; turns runner drift into a fake regression.                                                                                                                                     |
| Running it inside `ci.yml`                                                                                | `verify` must stay a correctness gate with `contents: read`; a comment needs a write token, and a noisy wall-clock number must not turn `verify` red.                                                           |

## Risks and limits

- **Noise.** Same-runner A/B, alternating rounds, medians and the spread mark are the only defence.
  A 10% change is inside the floor; never compare this week's number with last week's.
- **The first pull request.** It runs head only: no base side, and the comment job notices the base
  branch has no renderer yet. Per-PR comments start with the next change.
- **Two installs.** The base worktree gets its own `node_modules` (correct when the lockfile
  changed); the Bun install cache keeps it fast.
- **Fork tokens.** A fork PR cannot comment. Use `workflow_run` on the default branch before the
  repository is public; do not use `pull_request_target` with a checkout of the pull request.
- **The workflow is part of the pull request.** A PR can weaken its own benchmark (fewer rounds,
  smaller sizes). That is acceptable for an informational check and is why it is not a gate.
- **Obsidian is not in the loop.** The adapter is the CLI's `FsAdapter`; IPC cost and real
  event timing are L3's job, not this benchmark's.

## Files

- `packages/e2e/src/bench/sync.bench.test.ts` — the three scenarios, one per process.
- `scripts/bench.ts` — `bun run bench <scenario>`; sets `COURIER_BENCH=1` and forwards the env.
- `scripts/bench-report.ts` — medians, spread, invariants and the sticky comment.
- `scripts/bench-report.test.ts` — `bun run test:bench-report`.
- `.github/workflows/bench.yml` — the two jobs and the path filter.
- `packages/e2e/src/research/*.bench.test.ts` — the older one-off probes; they stay local.
