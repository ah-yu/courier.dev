# How to run mutation testing

> **Status: `authoritative` — how-to plus the recorded runs. It is a one-off survey, never a gate.**
>
> The tool is **Stryker** with `@stryker-mutator/vitest-runner`, installed **temporarily** for one
> survey and uninstalled again: the repository keeps no mutation dependency and no `stryker.*`
> config, so `<code>package.json</code>` / `bun.lock` are unchanged when the survey is over
> (`bun add -d` / `bun remove` below). The suite runs on Vitest, which is exactly what the runner
> expects.
>
> Two things about this repository matter to the setup:
>
> - **Stryker itself runs on Node, and that is fine** — the mutated targets are the engine's pure
>   modules, whose tests are Node-compatible. `bun --bun stryker …` does **not** work: Stryker's
>   plugin discovery fails under Bun ("No TestRunner plugins were loaded"), so the survey runs the
>   normal Node-hosted command. The test helpers in `@courier/testing` therefore avoid the `Bun`
>   global (they fall back to `setTimeout` / a no-op `gc`), which is also what keeps the suite
>   runnable on any host.
> - **Only the engine's own tests are handed to Stryker** (`stryker.vitest.config.ts`), not the
>   repository's six-project config: the e2e layer would make every mutant ~70 seconds instead of
>   ~1.

> This is a how-to for **tool usage + the results of one survey**, not a product contract, and not part of a gate.
> Why it is not part of `bun run verify`: the mutant count × suite duration grows linearly with every commit, while the payoff is one-off
> (once the assertions are added, the finding is permanently fixed into the normal tests); and "equivalent mutants" cannot be avoided, so a score does not work as a threshold.

## What question does it answer

**Coverage says "was this line executed"; mutation testing says "if this line were changed incorrectly, would the tests go red".**

Coverage counts a line as soon as a test **executes** it; mutation testing requires a test to assert on that line's **behaviour**. The method is to deliberately inject small errors (**mutants**) into the code and then run the tests:

- The tests go red → the mutant is **KILLED**, meaning an assertion really does guard this rule;
- The tests still all pass → **SURVIVED**, meaning **no assertion pins this rule down**—it is written in the code, but nobody guards it in the tests.

## How to run it (three commands)

```bash
# 1. Install temporarily (removed after the run; no long-term state in package.json)
bun add -d @stryker-mutator/core @stryker-mutator/vitest-runner

# 2. Write the two files below at the repository root, then run
bunx stryker run stryker.config.ts     # in Stryker 10 the config is a positional argument

# 3. Uninstall and delete the two configs and the artifacts
bun remove @stryker-mutator/core @stryker-mutator/vitest-runner
rm stryker.config.ts stryker.vitest.config.ts
rm -rf reports/mutation .stryker-tmp
```

`stryker.config.ts`:

```js
export default {
  // Small, branch-dense engine core whose tests are millisecond-level L0. This is the key
  // precondition: mutation testing is only affordable on a layer where the tests are fast.
  mutate: [
    "packages/engine/src/decide.ts",
    "packages/engine/src/self-events.ts",
    "packages/engine/src/remote-index.ts",
    "packages/engine/src/op-queue.ts",
  ],
  testRunner: "vitest",
  // Declared explicitly: the runner plugin is not discovered by name here, and Stryker
  // otherwise dies with `Cannot find TestRunner plugin "vitest"`.
  plugins: ["@stryker-mutator/vitest-runner"],
  vitest: { configFile: "stryker.vitest.config.ts" },
  // "all" rather than the lazier "perTest": both measured about the same here, and an
  // untrustworthy survival list is worse than no list — acting on it is the point.
  coverageAnalysis: "all",
  // Cannot be used together with coverageAnalysis: "all"; the static mutants here are only
  // module-level constants, so keeping them is cheap.
  ignoreStatic: false,
  reporters: ["clear-text", "json"],
  jsonReporter: { fileName: "reports/mutation/engine-core.json" },
  // A survey never fails on a score: read the survival list, do not use the score as a gate.
  thresholds: { high: 90, low: 60, break: null },
  concurrency: 8,
  maxConcurrentTestRunners: 8,
  timeoutMS: 30_000,
  tempDirName: ".stryker-tmp",
  cleanTempDir: true,
};
```

`stryker.vitest.config.ts` (**runs only the engine's own tests**; the six projects in
`vitest.config.ts` would pull the e2e layer in as well):

```ts
import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: resolve(__dirname, "packages/engine"),
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/build/**"],
  },
});
```

For a block of new logic rather than a whole module, trim `mutate` to the files that changed and
point `--tests`/the vitest config's `include` at their suite; a whole-file survey of `engine.ts`
costs minutes per mutant and is not worth it.

## Re-baselined run (2026-10-31, the Vitest-era survey repeated on the restored runner)

The suite came back to Vitest, so the survey was repeated on the same four files with Stryker
10.1.1 + `@stryker-mutator/vitest-runner` 10.1.1: **439 mutants, 8 workers, 3–4 minutes per round**
(2 m 56 s on the first, 3 m 54 s on the second).

**Round 1** (baseline):

| File              | Mutation score (total) | covered | killed | timeout | survived | no coverage |
| ----------------- | ---------------------- | ------- | ------ | ------- | -------- | ----------- |
| Total             | **89.07%**             | 89.68%  | 390    | 1       | 45       | 3           |
| `decide.ts`       | 97.86%                 | 97.86%  | 137    | 0       | 3        | 0           |
| `op-queue.ts`     | 98.31%                 | 98.31%  | 57     | 1       | 1        | 0           |
| `remote-index.ts` | 79.57%                 | 79.57%  | 74     | 0       | 19       | 0           |
| `self-events.ts`  | 82.99%                 | 84.72%  | 122    | 0       | 22       | 3           |

**Round 2** (after four assertions added in the triage below):

| File             | Mutation score (total) | covered | killed | timeout | survived | no coverage |
| ---------------- | ---------------------- | ------- | ------ | ------- | -------- | ----------- |
| Total            | 89.07%                 | 89.07%  | 390    | 1       | 48       | **0**       |
| `self-events.ts` | 82.99%                 | 82.99%  | 122    | 0       | 25       | **0**       |

`decide.ts`, `op-queue.ts` and `remote-index.ts` are unchanged from round 1: nothing added that
round touches them.

Nothing was killed that round, and that is the result of the triage, not a miss: the three
`NoCoverage` mutants were the sweep's own `delete` calls, which no test reached — the assertions
below execute them, and the surviving mutants they become are **memory-only** (every read checks the
deadline itself). The four assertions:

- `self-events.test.ts` — one per sweep: after a record's window closes, the next write/delete/rename
  prunes it, and the fresh record still matches (`drops an expired write/delete/move when the next
  one is recorded`).
- `remote-index.test.ts` — "hands a shared content mapping to the most recently recorded chain":
  three chains sharing one hash, the last one forgotten, so the lookup must fall back to the
  _previous_ owner (`owners` order, not just membership).

The remaining 48 survivors, triaged by replaced fragment — equivalent, redundant with a later
check, or a 1 ms boundary:

- **`remote-index.ts` (19)** — bookkeeping the surrounding lines already do, or a guard a later
  lookup repeats:
  - `remember`'s `previousHash !== undefined && previousHash !== head.contentHash` (4: three
    `ConditionalExpression` plus one `&&`→`||`, all at `:104`). The reverse and forward mappings are
    re-set immediately after, so an early drop is invisible.
  - `forgetPrevious`'s clauses (4: `previousPath !== undefined` twice, `!== keepPath`, and the
    `&&`→`||` at `:179`–`:180`). The third clause — "the path map still points at this chain" — is
    what protects a peer, and `remember` re-sets the path right after. The third clause itself is
    killed, by "does not drop another chain's mapping at a path both chains named".
  - `fileIdToHash.clear()` and `.delete(fileId)` (2, `:61` / `:134`). A stale reverse entry can only
    be consulted by that same chain being remembered again, and `dropHash` then returns early
    because the hash has no owner set.
  - `forget`'s `path !== undefined` and `hash !== undefined` (2, `:127` / `:131`). A missing key
    cannot match in `pathToFileId.get(undefined)`, and `dropHash(fileId, undefined)` returns on the
    missing owner set.
  - `dropHash` / `recordHash` internals (7):
    - `owners === undefined` early return (`:160`) — defensive: a recorded hash always has an owner
      set;
    - the empty-set branch and its two calls (`:162` conditional, `:162` block, `:163`) — the
      fall-through then writes `undefined` as the lookup, which `fileIdForHash` answers as `null`;
    - the two hand-over guards (`:164`, `:167`) — `hashToFileId` is always the set's last entry, so
      `[...owners].at(-1)` lands on the same chain;
    - `owners.delete(fileId)` in `recordHash` (`:146`) — the set's order beyond its last entry is
      never observed.
- **`self-events.ts` (25)**
  - **1 ms boundaries (10)**: seven `expiresAt <= now` → `<` (`:92`, `:118`, `:138`, `:162`, `:189`,
    `:211`, `:234`) and three `>` → `>=` (`:225`, `:244`, `:261`).
  - **Sweep pruning (10)**: the three loop bodies as `BlockStatement {}` (`:117`, `:210`, `:233`),
    the three `ConditionalExpression` → `false` (`:118`, `:211`, `:234`), the three delete calls
    they contain, and `pendingDeletes.delete` in its own sweep (`:262`). Pruning is memory hygiene:
    `hasSelfWrite`, `isSelfWrite`, `matchesSelfWriteStamp`, `consumeSelfDelete`,
    `consumeSelfRename` and the pending-delete match all check the deadline when they read. The
    three delete calls are the `NoCoverage` mutants the new sweep tests now execute (see above).
  - **Per-read expiry deletes (3)**: `selfWrites.delete(path)` inside `hasSelfWrite` (`:139`),
    `matchesSelfWriteStamp` (`:163`) and `isSelfWrite` (`:194`) — memory only, for the same
    reason.
  - **`expiresAt === undefined` → `false`** (1, `:223`): equivalent — the next comparison is
    `undefined > now`, which is false too.
  - **the stamp spread `stamp === undefined ? {} : { stamp }` → `false`** (1, `:123`): recording an
    empty `stamp` object still fails `matchesSelfWriteStamp` (there is nothing to compare), so both
    branches answer the same for a write recorded without a stamp.
- **`decide.ts` (3)**: `chain.length > 0 ? … : undefined` (2) reads the same `undefined` on an empty
  chain; `lastKnown.versionId != null` (1) is true whenever that branch is reached, and a null point
  compares unequal to a real hash anyway.
- **`op-queue.ts` (1)**: clearing `exclusiveInFlight` on every completion instead of only for an
  exclusive task — the flag is bookkeeping for the next dispatch, which reads it after the queue has
  already been advanced.

The tool and artifacts were removed as in the section below (`bun remove`, delete the two
`stryker.*` configs, `reports/mutation`, `.stryker-tmp`), leaving `package.json` and `bun.lock`
unchanged.

## Earlier runs: the Vitest + Stryker era (2026-10-16 → 2026-10-26)

Everything below used Stryker 9.6 / 10.1.1 with `@stryker-mutator/vitest-runner` and the temporary
`stryker.config.ts` / `stryker.vitest.config.ts` pair, deleted after each run. The sections are kept
for their **findings**; the runs above are the current baseline.

## First measured run (2026-10-16, four engine files)

358 mutants, 8 workers, **48–56 seconds**.

| File              | First round                         | After adding assertions                |
| ----------------- | ----------------------------------- | -------------------------------------- |
| Total             | 86.48% · 35 survived · 13 uncovered | **91.55% · 27 survived · 3 uncovered** |
| `decide.ts`       | 95.86% · 6                          | 97.93% · 3                             |
| `op-queue.ts`     | 93.22% · 4                          | 96.61% · 2                             |
| `remote-index.ts` | 80.00% · 9                          | 88.89% · 5                             |
| `self-events.ts`  | 72.64% · 16 · 13 uncovered          | 81.13% · 17 · 3 uncovered              |

The first round found **10 rules nobody guarded** (all now have assertions added, +14 test cases):

1. `SelfEventLog`'s sweep loop has no tests at all → during a sweep it **deletes records that are still valid** (the next write to any path loses that path's suppression, and its own write is treated as a user edit and pushed again); the deadline is computed as `now - window` (a record is expired the moment it is born); **an expired rename record still matches** (treating a real user move as the engine's own).
2. `decideInputFrom` **has no tests at all**: changing `locallyTracked: context.entry !== undefined` to `true` stays all green. This flag decides "when binding a vault, is a local file under a remote tombstone a new file or a deleted one".
3. An all-tombstone chain (which retention pruning may leave behind) lacks the `previous !== undefined` guard: it reads a property off `undefined`, or treats the local file as "unmodified" and simply pulls it away.
4. `RemoteIndex.rememberPath` does not clean up the old path (after a chain loses its head and changes path, the old path is still treated as a live chain).
5. The hash sweep is not scoped to the same chain: one move wipes the content index of **another chain** → a rename forks a second chain.
6. `DEFAULT_OP_QUEUE_LIMITS` is not pinned down (changing `8 * 1024 * 1024` to `8 / 1024` stays all green, because the other cases all **read** this bound **from the object under test**, and it is the default that mobile memory safety depends on).

The same round also turned up a real defect along the way: after `FakeVault.rename` was tightened to Obsidian's real contract, if the source file is deleted by a concurrent operation while `ObsidianVaultAdapter.renameFile` is in `await ensureParentFolder` → `vault.rename` throws `ENOENT` → the whole pull fails (one note is lost out of a batch during a folder rename). Fixed in the adapter.

## Triaging the survival list: you must look at "the exact fragment that was replaced"

Judging by the line text alone will mislead you. Example: the `ConditionalExpression` mutant of `return a && b;` replaces the **left operand** (`true && b` ≡ `b`), i.e. "the condition `a` was dropped"—not turning the whole expression into `true`. Only by reading the fragment covered by `location.start/end` in the JSON report do you learn what the mutant actually changed.

The remaining 27 survivors are **all equivalent mutants or 1 ms boundaries**, and recognising them is half of the craft:

- `chain.length > 0 ? chain.at(-1) : undefined` → `true`: on an empty chain `chain[-1]` is `undefined` too, the same answer;
- `if (expiresAt === undefined) return false` → `false`: it falls through to `undefined > now` → still `false`;
- removing `map.delete` from the sweep: only a memory leak (every read checks the deadline itself);
- `delete(path)` immediately followed by `set(path, …)`: the net effect is unchanged;
- `<= now` vs `< now` differs only in the 1 millisecond when the deadline is exactly the current instant.

**One survivor is not noise but a design problem**: with a shared sync point, the chain already moved forward, and the local content exactly equal to the head, it was `conflict` at the time (parking a conflict copy with identical content) rather than `synced`. At the time this was pinned as-is with a comment—changing it to "if the content is the same, converge silently" must be a deliberate decision, not an offhand simplification. **That decision was made on 2026-10-19** (field symptom: a note edited twice, two extra `*.conflict.md` files beside it with content exactly identical to the note), see the fifth measured run.

## Second measured run (2026-10-17: the config-folder conflict section)

The first run picked four pure core files. This time the target was a block of newly added logic in `engine.ts` (config-folder conflicts resolved by modification time), which also incidentally answered "can a large file be tested": **yes, but you have to trim it by line range**.

`mutate` lists only four ranges—`preparePush`'s mtime, reconcile's tombstone retry, `handleConflict` / `resolveSettingsConflict`, `applyLocalDelete`—everything else follows this document's config. 157 mutants, 8 workers, **20 seconds**. Measuring the whole file would take several minutes on this ~10-second suite, while the payoff is all in the newly added ranges.

| Round                                       | Score (covered)    | Survived | Uncovered |
| ------------------------------------------- | ------------------ | -------- | --------- |
| First round                                 | 64.33% (73.72)     | 36       | 20        |
| After adding assertions + fixing one defect | **74.85% (81.33)** | 28       | 13        |

The most valuable finding of the first round was not a "rule nobody guards" but **a piece of dead code**: in reconcile, the `catch` for a refused tombstone push calls `decideIncremental`, and the first thing that function does is `readWithStamp` and `return` if the file is missing—and the precondition of that branch is exactly that the file is missing. So "a delete collides with a peer's edit, and the peer's version must be fetched back immediately" never happened in that round, and could only wait for the next pass. After changing it to call `handleConflict(…, false)` as `applyLocalDelete` does, the peer's version was written back in the same pass (pinned by the new case `resolves a tombstone a peer's edit refused during a pass`).

The assertions added (each corresponds to a mutant that previously **SURVIVED**, +7 cases in total, 2 modified):

- `onConflictResolved.remoteAction` (`delete` / `write`) was never asserted—one `expect` killed 4;
- the success return of the config folder's "local is newer" on the **notification path** (returning `false` makes the notification report a spurious failure);
- when the push inside a conflict fails for a reason **other than stale_base**, it must be reported rather than treated as resolved;
- on the notification path, when the peer's content cannot be read it must be refused rather than silently treated as applied;
- in a conflict, when the local file grows past the limit between two `stat`s, report first and then skip (previously only the pass path had a case);
- renaming to a target outside the scope, deleting a path that was never tracked—neither of the two "early-return guards" was ever exercised.

The remaining 28 survivors + 13 uncovered are **all defensive branches, races or equivalent mutants**, in four categories by replaced fragment:

1. **Duplicate guards the caller already blocked**: `!head` / `!plainPath` / remote over-limit in `handleConflict`, `!localExists` / `break` when unreadable in the pass. They are only reachable when "the state changed between the upstream check and here"; they are defence in depth, and no race cases were invented for them.
2. **Adapter failures**: the `?.` in `stamp?.mtimeMs` and `entry?.deletedAtMs`, and the non-refusal error path of `firstFailure ??= err` in the tombstone branch—testing them would mean injecting "the adapter lies / the network drops at a particular moment", and the signal does not belong to this section.
3. **Arbitrary bounds**: the extra third retry from `attempt <= 2`, `applyPushedVersion` adding the entry back after `pathToFileId.delete`—the behaviour only differs under extreme contention, and is overwritten by later writes.
4. **Deliberately untested low-value paths**: renaming to an over-limit chain (`remoteOversizedPaths`), the `persist()` write after a failed rename—the existing "still one chain after a restart" case covers the success path, and persistence on the failure path has no separate assertion.

The conclusion matches the first run: **read the survival list, add assertions, rerun once, then uninstall**. The score only confirms "whether adding the assertions had any effect".

## Third measured run (2026-10-18: excluded folders)

The target was the newly added "excluded folders" predicate and the two compensation paths for "a move reported as a delete". `mutate` was trimmed by line range:

- `normalizeExcludedFolders` / `isPathInExcludedFolders` / `isExcludedPath` / the wiring in `normalizeScope` / the two exclusion lines in `isSyncablePath`, `isSyncableDir` in `sync-scope.ts`;
- in `engine.ts`, the reconcile delete-branch recheck, `repairMovedFile` + `findExcludedMoveCandidate` + `excludedFilesByName` + `fileNameOf`, `applyLocalDelete`, `handleLocalRename` + `rememberMoveOutOfScope` + `recordLocalPathMove`;
- `plugin/src/shared/excluded-folders.ts` (pure tree/compaction/coverage rules) and `decorateExcludedPathRow` in `ui/file-explorer-excluded-folders.ts`;
- `listExcludedFiles` / `walkExcluded` in `cli/src/node/adapter.ts`.

The tests ran only the L0 cases that carry these rules (28 engine excluded cases, 17 plugin pure-module cases, 17 CLI adapter cases), 4 workers:

| Target              | Score (total / covered) | Killed | Survived | Uncovered | Time |
| ------------------- | ----------------------- | ------ | -------- | --------- | ---- |
| Engine (all ranges) | 70.54% / 73.49%         | 158    | 57       | 9         | 1m01 |
| `sync-scope.ts`     | 96.30% / 96.30%         | 52     | 2        | 0         | —    |
| Plugin pure modules | 85.87% / 85.87%         | 79     | 13       | 0         | 5s   |
| CLI adapter         | 91.18% / 91.18%         | 30     | 3        | 0         | 3s   |

The **real defects** found in this round (not missing assertions):

1. **A chain that moved into an excluded folder still occupies the old path's identity.** `recordLocalPathMove` removes the chain from `RemoteIndex` when the event fires, but the next reconcile rebuilds the index from the server and adds it back under the chain's old path. So a note **created** at the old path during the exclusion is never pushed (the untracked branch thinks a remote chain is already there), and a real delete can lend this parked chain to a new file at the old path. The fix is to skip, when building the index, chains whose "locally recorded path is already out of scope and differs from the server path"; the comment in `engine.ts` explains why. New case: `does not hand the chain to a new file created at the vacated path`.
2. **Move detection for empty files (`sha256("")`)**: a deleted version's content hash is the same as an empty file's, and the previous way of telling a tombstone from a real file ("not the empty hash") misjudged a moved empty note as a delete. That guard was removed, trusting the path index and the candidate file's bytes instead, and `recognises an empty note moved into an excluded folder` was added.

The assertions added (each corresponds to a mutant that previously survived or was uncovered):

- a copy with the same name but **the same size and different content** must still be handled as a delete (the size pre-filter lets it through first; only the hash can stop it);
- a copy with the same name but **a different path** is not a move (`fileNameOf`'s name filter + a same-content, different-name case);
- an old state with **no stamp** in it: skip the size pre-filter and still match by bytes;
- when the candidate file is **already taken by another chain** it must not be borrowed ("two chains, one path"), plus an ambiguity case kept for "two candidates → do not guess";
- when the adapter **does not have** `listExcludedFiles`, fall back to deleting (that method is optional);
- a delete storm lists the excluded directories only once (the 30 s cache in `excludedFilesByName`);
- moves between excluded directories, ordinary renames still being pushed, and the `persist()` of both move paths are each pinned separately.

**Triaging note (important)**: with `coverageAnalysis: "all"` + `testNamePattern`, this version of Stryker's vitest runner records some mutants that would actually be killed as `Survived`—two kinds were confirmed by measurement:

- the `if (!Array.isArray(input))` mutant of `normalizeExcludedFolders` makes the test file throw `input is not iterable` at **import time**, giving the whole suite 0 tests; the runner records "no tests ran" as survived.
- after manually changing `findExcludedMoveCandidate`'s "candidate already taken" guard to `false` and `hasExcludedAncestor` to `true`, the corresponding cases all go red, yet the report says survived.

So the scores in the table above are a **lower bound**; the survival list has to be triaged by hand against the replaced fragment. The remaining survivors cluster around:

- the pre-existing `repairMovedFile` sync branch / `handleLocalDelete` wrapper / old `applyLocalDelete` logic (overlapping line ranges, not rules added this time);
- equivalent or defensive branches in the new code: `scope.excludedFolders.length === 0`, `candidates.length === 0`, `sizeHint !== undefined`, `stamp === null || …` (size is only a pre-filter; skipping it still leaves the hash to decide), the 30 s boundary of the `excludedFiles` cache, `?.stamp`, `?? []`;
- the `filter` in the plugin's `toggleExcludedFolder`: the later `compactExcludedFolders` produces the same result (a parent entry covers the child), so the whole block is redundant but harmless;
- `segments.length === 0` and `ensure(...)?.children` in `buildExcludedFolderTree`: the normalizer already drops empty paths, so both guards are unreachable; the recursion of `sort(node.children)` is pinned by the newly added sibling-ordering case.

The tool and artifacts were removed as per this document's first section (`bun remove` + deleting the `stryker.*` configs, `reports/mutation`, `.stryker-tmp`), leaving no changes in `package.json` / `pnpm-lock.yaml`.

## Fourth measured run (2026-10-18: the two pure modules of pause sync)

The target was the two pure rules added for the plugin's "pause sync": `settings-stage.ts`'s "`paused` → `ready`, and before `unlocked`" and `session.ts` clearing `syncPaused` in `unbindVault`. `mutate` listed only these two files, and the tests ran their respective L0 cases (14), 4 workers.

All 25 mutants were **KILLED** (100%, no survivors, no uncovered), in about 4 seconds. The assertions directly pin the two branches that are easy to get backwards: `paused + unlocked: false` is still `ready` (a paused page does not fall back to `locked`), `paused` does not cross `login`/`choose`, and `syncPaused === false` after unbinding. The `pauseSync` / `resumeSync` orchestration in `main.ts` was **not included**: it only has L2 cases (real plugin + real server), each mutant takes seconds, and by "when to do it" that is not worth it; that part is covered by the three cases in `plugin.e2e.test.ts` and the real-device suite. The tool and artifacts were likewise removed, and no changes were left in `package.json` / `pnpm-lock.yaml`.

## Fifth measured run (2026-10-19: identical content is not a conflict)

The target was the "design problem" already named in the first measured run: `decideFile` returned `conflict` when **the shared sync point lagged behind the chain and the local bytes happened to equal the head**, parking a copy exactly identical to the note and then writing the same bytes back. The field symptom was "a note edited twice, two extra `*.conflict.md` files beside it"—one edit's push had already landed, while a second decision on the same path caught the new chain before the state adopted that version.

`mutate` listed only `packages/engine/src/decide.ts` (the change all lands in this pure file); the tests were still all the engine's L0 cases, 8 workers. **140 mutants, 25 seconds.**

| Target      | Score (total / covered) | Killed | Survived | Uncovered |
| ----------- | ----------------------- | ------ | -------- | --------- |
| `decide.ts` | **97.86% / 97.86%**     | 137    | 3        | 0         |

The mutants of the new branch `if (input.localContentHash === head.contentHash) return { action: "synced" }` were **all KILLED** (condition set to `true` / `false`, `===` changed to `!==`, the whole block deleted, the return value changed to an empty object/empty string), which shows that the "identical bytes → converge" rule has both positive cases (`decide.test.ts`) and negative cases (a real divergence still decides conflict).

All 3 survivors are equivalent or defensive and need no new assertions for the rule:

- `lastKnown.versionId != null` → `true`: the two state fields are always written together, `lastKnownContentHash` is also null when `versionId` is null, and with a local file present the content hash cannot be null, so both sides of the comparison are false together;
- `remoteHead`'s `chain.length > 0` → `true`, `> 0` → `>= 0`: on an empty chain `chain[-1]` is still `undefined` (the same equivalent mutant as in the first measured run).

The three matching "adopt the head as the sync point when converging" spots in the engine (reconcile's `synced` branch, `decideIncremental`, `handleFilePushed`) were **not included** in the mutation scope: one mutant in `engine.test.ts` takes about 13 seconds, which by "when to do it" is not worth it; they are covered by the three new cases in `engine.test.ts`, one L2 in `plugin.e2e.test.ts` and one L3 in the real-device suite. The tool and artifacts were removed as per this document's first section, with no changes left in `package.json` / `pnpm-lock.yaml`.

## Sixth measured run (2026-10-26: the large-file sync rules)

The target was the code added by the large-file work and the review fixes, in two runs
(Stryker 9.6 installed temporarily; the repository still keeps no config). The split is by
suite cost, not by subject:

- **Pure set** (`packages/shared/src/blob.ts`, `wire.ts`; `server/src/lib/byte-range.ts`,
  `quota.ts`, `orphan-blobs.ts`; `server/src/middleware/request-log.ts`;
  `plugin/src/shared/version-content.ts`), with only those files' L0 tests: 654 mutants,
  1m11, **90.37% → 94.50%** after adding assertions (62 → 36 survivors).
- **`engine.ts` ranges** (restore, the `content_missing` retry, `preparePush`, the
  sync-point stamp, `decideIncremental`), with `engine.test.ts`: 264 mutants, 6m12,
  **70.08% → 71.97%** (79 → 74 survivors). The low score is expected for this file: the
  ranges are dense with defence-in-depth guards that the caller already blocks.

The survey found one real defect: `parsePushBody` on a header JSON of `null` threw a raw
`TypeError` while reading `deviceName`, before the shape check could report
`WireFormatError`; `readDeviceName` now ignores a non-object header and lets
`readHeaderEntries` answer. It also settled one boundary: the orphan sweep keeps a blob
that is **exactly** `ORPHAN_TTL_MS` old (`>= cutoff`), because "older than" must not delete
a push that is still between its write and its row.

Assertions added (each pinned a surviving mutant): the exact 8 MiB whole/chunked
boundary and the 24-byte header size constant; the whole 32-byte AAD hash; a valid-magic
header shorter than 24 bytes; the unsafe-size and `MAX_CHUNKS` bounds in isolation;
`null`/array headers and `contentChunks` fields; a zero-length payload; two content files
in order; orphan age boundary, unreadable blob and failed vault/reference reads; a
presented credential on a 400; `PUT` as a mutation; the push regex anchor; the streamed
response's preserved status/headers, elapsed-time subtraction, and a client cancel; the
restore messages and the "chain names content the store lost" case.

The remaining survivors were triaged by replaced fragment and are equivalent or
defensive: reused `?? ""` fallbacks on regex groups that cannot be undefined, `>=`/`>`
at a 1 ms or exactly-at-limit boundary, optional chaining that only matters when a value
the caller guarantees is absent, and the known Stryker-vitest false survivors. No further
assertions were added; the tool and artifacts were removed as in the first section.

## Seventh measured run (2026-10-26: the first-bind rules, `engine/src/rate-limit.ts`)

The new file behind "a refused request waits out the window": `isRateLimitError`,
`rateLimitWaitMs` (the `Retry-After` bounds and the fallback) and `sleep`. L0 only
(`rate-limit.test.ts`), Stryker 10.1.1, 44 mutants, ~15 seconds.

| Round                   | Killed | Survived |
| ----------------------- | ------ | -------- |
| First                   | 39     | 5        |
| After adding assertions | **43** | **1**    |

Assertions added (each killed a surviving mutant): a non-number `retryAfterMs` (`"30000"`,
`true`, `null`), a negative, `Number.POSITIVE_INFINITY`, an object with no field at all,
`undefined` for both functions, and the exact form of the refusal (`status: "429"` as a
string, a lower-case `code`, and the real pair accepted).

The one survivor is `typeof asked === "number"` replaced by `true`, and it is **equivalent
at runtime**: the next operand, `Number.isFinite`, already rejects every non-number (it does
not coerce), so the guard exists only to narrow `unknown` for the type checker. Kept, and
recorded here rather than asserted.

Tooling notes from this run: Stryker 10 could not be installed from the local mirror (it
depends on `@babel/types@^8`); with an `.npmrc` pointing at the official registry through a
proxy it installs and runs, and its sandbox runs its own `bun install`, so the registry
must reach that too. The `engine.ts` / `host.ts` ranges were **not** surveyed here: a
whole-file run on `engine.test.ts` costs minutes per mutant, and those ranges need the
per-function trim described under "When to do it".

## When to do it

- **Engine pure core (done, and the current baseline)**: cheap (about three minutes for the four files), high signal, and it directly serves the question "can this be refactored safely". Last re-baselined on 2026-10-31 through Stryker 10.1.1 (see the re-baselined run above); `remote-index.ts` is where the next round should start.
- **A single block of new logic in `engine.ts` (done 2026-10-17)**: trim `mutate` to the functions that changed (line ranges), on the order of 20 seconds; measuring the whole file is not worth it. When a sync rule lands in `engine.ts`, prefer this approach instead of first asking "is the tool installed in the repo"—the tool is installed temporarily, and this document is its usage.
- `server/src/handlers/**` (before launch / before the protocol is frozen): a fair number of the critical rules are pinned only at L1 (real DB + real routes, ~70 seconds/mutant), the cost is clearly higher, and manual triage time has to be budgeted on the basis that "L0 alone would mix in false survivors".
- **Not in CI**, for the reason at the top of this document.
- ~~The known gap that should be filled first is not in the handler layer: `packages/server/src/lib/acme/jws.ts` (a hand-written JWS/ES256 signature) **has no direct tests**~~ — closed on 2026-10-28: `jws.test.ts` now pins the DER→raw conversion (padding, truncation, tags, component count, long-form lengths), the RFC 7638 thumbprint vector and `signJws`'s wire form, so it is a fair mutation target now. Writing tests first was the right order.
