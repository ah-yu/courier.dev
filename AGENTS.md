# AGENTS.md

Courier syncs Obsidian vaults across devices. One TypeScript sync engine (`@courier/engine`) runs
inside the Obsidian plugin (desktop and mobile) and the headless `courier-cli`; `@courier/server`
stores encrypted, content-addressed version chains behind a REST + WebSocket API. Every client of a
user shares that user's key and states its own display-only device name.

This repository is the **open-source sync solution**: the engine, the server, the plugin, the CLI,
the end-to-end suites and their contracts. Everything the product needs to sync is here.

`docs/README.md` is the document index and the only answer to "which document do I trust": it
carries every document's status. The rules that must not break are in **Invariants** below;
subsystem detail lives in `docs/`, linked from the routing table.

## Project status: pre-release, no backward compatibility

Courier is pre-release: no release tags, no deployed instance and no user data to preserve.
**Backward compatibility with an earlier state of this repository is not a requirement, and no
agent should add compatibility code for it.**

- **Contracts change in place.** REST/WebSocket shapes, `packages/shared` types, CLI flags,
  plugin settings and on-disk state (`<vault>/.courier/remote.json`, `sync_state.json`, the
  App-level `localStorage` credentials, `~/.courier/*.json`): change them directly. No versioned
  endpoints, field aliases, dual-shape readers or `if (oldKey)` branches.
- **Schemas change in place.** The migrations in `packages/server/drizzle/` keep a development
  database in step; there is nothing to back-fill. Change the schema, rewrite the migration
  chain, delete and recreate `packages/server/data/`. A hand-written incremental migration is
  needed only while a development database you care about exists.
- **Fix call sites, do not shim them.** Update every producer, consumer and test in the same
  change, plus `docs/api.md` / `docs/cli.md` when they own that contract.
- **Compatibility paths may be deleted.** Code that exists only to read what an older version
  wrote (owner-less "legacy" vaults, undecryptable legacy rows) is not a requirement. Delete it
  and the tests that covered only that path; never add a new one.
- **This is not about live features.** The `ak_` host key and the user/admin split
  (`/api/users`, `/api/admin/*`) are current; what this policy removes is the _second_ path that
  exists only for something an earlier version wrote.

## Repository map and where truth lives

Bun workspace for the sync solution.

| Package            | Purpose                         | Stack                                                               |
| ------------------ | ------------------------------- | ------------------------------------------------------------------- |
| `@courier/shared`  | API and wire type definitions   | TypeScript interfaces exported from `src/`; no build                |
| `@courier/engine`  | Shared sync engine              | TypeScript, Web Crypto; used by the plugin and the CLI              |
| `@courier/server`  | Sync service (REST + WebSocket) | `Bun.serve`, Drizzle ORM, `bun:sqlite`                              |
| `@courier/plugin`  | Obsidian plugin (unified)       | TypeScript, `Bun.build` (CJS)                                       |
| `@courier/cli`     | Headless sync CLI (one binary)  | TypeScript, `bun build --compile`; reuses `@courier/engine`         |
| `@courier/e2e`     | End-to-end suites (L1–L3)       | `bun --bun vitest`: server + engine + plugin, up to a real Obsidian |
| `@courier/build`   | Release-binary compile (dev)    | TypeScript; `bun build --compile`; devDependency of the CLI/server  |
| `@courier/testing` | Test helpers shared by packages | TypeScript interfaces exported from `src/`; no build                |

The release workflow publishes the server binaries and the CLI binaries from this repository, and the
Obsidian plugin by writing its **publishing mirror** (see `docs/release.md`). `ah-yu/courier` — the
repository the community directory points at — is a generated artifact: `scripts/mirror-plugin.ts`
writes it from `packages/plugin`, `packages/engine` and `packages/shared` on every tag, so the scan
the directory runs sees the plugin's own source instead of this repository's server and CLI. The root
here still carries `manifest.json` (a verbatim mirror of `packages/plugin/manifest.json`),
`README.md` and `LICENSE` as that generation's input; `scripts/check-release.ts` fails when the two
manifests differ.

**Truth, by subject.** This table is the routing rule; `docs/README.md` registers every document
and its status.

| Subject                                                                       | Authoritative document       |
| ----------------------------------------------------------------------------- | ---------------------------- |
| Sync rules: decisions, conflicts, tombstones, push, offline, restore, hosts   | `docs/sync-engine.md`        |
| Scope: file types, excluded folders, config-folder groups, size cap           | `docs/sync-scope.md`         |
| Obsidian plugin: build, wiring, settings page, dialogs, notices, status bar   | `docs/plugin.md`             |
| Tests: layers, harness, L3 mechanics, stub fidelity, coverage/mutation detail | `docs/testing.md`            |
| Benchmarks: scenarios, CI trigger, base/head comparison, PR summary           | `docs/ci-sync-benchmarks.md` |
| Server architecture and layering                                              | `docs/server.md`             |
| REST + WebSocket contract, auth, error codes                                  | `docs/api.md`                |
| `courier-cli` commands and behaviour                                          | `docs/cli.md`                |
| User-facing copy and language rules                                           | `docs/i18n.md`               |
| Plugin UI preview and geometry                                                | `docs/plugin-ui-preview.md`  |
| Mutation testing how-to                                                       | `docs/mutation-testing.md`   |
| Releases: workflows, version/tag rule, published assets                       | `docs/release.md`            |

- **The code and its tests are the executable spec.** The documents record the rules and the
  non-obvious reasons; when a document and the code disagree, the code is right and the document
  is the bug.
- **Deleted architecture stays deleted.** The Rust/GPUI and WASM engine designs were removed with
  the code; git history is the only archive, and no agent should reintroduce them.
- All code comments, JSDoc and inline documentation are English. User-facing plugin/CLI copy
  lives in the i18n catalogs (`packages/plugin/src/i18n/`, `packages/cli/src/i18n/`) and must
  not be inlined; see `docs/i18n.md`. The plugin follows Obsidian's UI language and the CLI
  follows the OS language with `--lang` / `COURIER_LANG`.

## Commands

```bash
# Verification — after EVERY change; one command, one verdict
bun run verify                  # docs + agent-safety + migrations + lint + review + typecheck + test, one summary
bun run verify test             # only the named gates
bun run verify obsidian         # end-to-end against a real Obsidian (see the L3 rule)
bun run verify obsidian-ci      # the non-layout L3 subset CI runs (see the L3 rule)
bun run test:coverage           # the instrumented suite with the per-package floors
bun run check:docs              # AGENTS.md size, docs index and links/anchors (part of `bun run verify`)
bun run lint:review             # the community directory's scan, mirrored: ESLint over the published packages and Obsidian's Stylelint over `styles.css` (part of `bun run verify`)

# Development
bun run dev                     # server + plugin watchers in parallel
bun run build
bun run --filter @courier/server dev

# Testing (Vitest as the runner, Bun as the runtime: see the note at the end of this block)
bun run test
bun run test:watch
bun run bench <many|large|churn>                        # wall-clock sync benchmark (see docs/ci-sync-benchmarks.md)
bun --bun vitest run packages/server                    # one project
bun --bun vitest run packages/e2e/src/sync.e2e.test.ts  # one file
# `bun test` runs Bun's own runner: it is not this suite, and `--bun` is what keeps
# Vitest inside Bun (without it the CLI runs on Node, where `bun:sqlite` does not exist).

# Lint, format, types
bun run lint
bun run format               # whole checkout; ignores: .gitignore + `.oxfmtrc.json`
bun run format:check
bun run typecheck            # tsc --noEmit in every package + the tooling scripts

# Server database
bun run --filter @courier/server migrations:generate   # after adding drizzle/*/migration.sql
bun run --filter @courier/server migrate                # apply the chain to the dev database
bun run --filter @courier/server db:generate            # author a migration from schema.ts
bun run --filter @courier/server db:studio

# Plugin and e2e fixtures
bun run dev                                    # server + plugin; provisions this checkout's vaults
bun run --filter @courier/plugin setup:vault   # only the plugin install, same vaults
bun run e2e:obsidian                           # one-time disposable vault registration
bun run e2e:obsidian --clean                   # only with Obsidian closed
bun run preview:ui                             # render the live view to a PNG

# Snapshot version for a test build (see docs/release.md)
bun run version:snapshot
```

## Product shape

- **One shared TypeScript sync engine on every client.** The Obsidian plugin (desktop and
  mobile) and `courier-cli` both run `@courier/engine` and talk to the server with a single
  **user key (`ck_...`)** plus a self-declared device name. The name is display metadata only:
  no device registry, no device identity, no revocation; the server stamps it onto version rows.
- **The Obsidian plugin is unified.** One `EngineHost` wires the engine to `requestUrl`, an
  Obsidian vault adapter and the engine's `SyncWebSocket`. There is no platform branch and no WASM
  engine.
- **Every host resolves conflicts the same way, in the engine: the remote version wins, except
  inside the config folder.** The local content is parked beside the note as
  `{stem}-{YYYY-MM-DD-HHmmss}[-n].conflict{ext}`; config-folder paths are settled by
  modification time, silently, with no copy. There is no conflict policy, panel or resolve call.
- **The CLI keeps syncing while Obsidian is closed.** `register` → `vault connect` → `run` with
  `--vault <id>`; one process syncs one vault, bindings are independent, each has its own
  state/runtime/log, and `status` lists every vault and its conflicts. Each process takes its
  vault's lease first; if another writer already has it, the process waits without an engine.
- **One writer per vault is a lease, first come first served.** The plugin and CLI both acquire
  `<vault>/.courier/sync-lease` before building a host; the loser waits without an engine, and
  neither application has priority. The holder releases only after the engine drains. The
  Obsidian state is reported as context, never used to hand the vault over. See
  [cli.md](docs/cli.md#running-while-obsidian-has-the-same-vault-open).
- **The server is stateless about content.** It stores version chains and content-addressed
  encrypted blobs; conflict detection is client-side. Deleted = chains whose last action is
  `delete`; restore = push `action:"restore"`.

## Invariants that must not break

These are the rules whose violation produces silent data loss, a forked identity, a broken
protocol or a security hole. Read the linked section before changing one.

1. **One path, one chain — fileId is the identity.** A chain's `fileId` is assigned once, at
   create, and never changes — not on a rename, a move, a restore or a conflict. A path never
   gets a second chain; a remote move is applied at the path its version records; a local event
   only _adopts_ a remote identity, and only while the bytes and stamp still match the decision.
   `packages/engine/src/engine.ts` is the single reference implementation. See
   [sync-engine.md](docs/sync-engine.md#identity-one-path-one-chain).
2. **Conflicts: remote wins, local is parked.** The loser pushes nothing; identical bytes are
   never a conflict — nor are bytes this engine itself just wrote. Config-folder paths are the
   exception: newer mtime wins, silently, with no copy. Names are
   `{stem}-{YYYY-MM-DD-HHmmss}[-n].conflict{ext}` and conflict copies never
   sync. See [sync-engine.md](docs/sync-engine.md#conflicts) and
   [sync-scope.md](docs/sync-scope.md#conflict-copies).
3. **A `delete` head is read two ways.** The first bind merges (local-only files become new
   chains); every other pass applies the remote deletion. A file under this device's own delete
   point is a recreate, pushed as `restore`; applying a deletion drops the chain from the
   identity index. See [sync-engine.md](docs/sync-engine.md#tombstones-and-binding).
4. **Every push names its base.** `baseVersionId`; the server checks and inserts atomically, so
   two pushes decided from the same head cannot both land. A `stale_base` refusal is re-decided
   from the fresh chain without moving this device's sync point; the same bytes are adopted as
   the sync point (lost-response retry). See
   [sync-engine.md](docs/sync-engine.md#offline-changes-and-reconciliation).
5. **There is no offline queue; the reconcile pass is the retry.** A failed push or pull must be
   visible (never resolved as "nothing to do"). Hosts reconcile on a **re**connect, never on the
   first connect, and never two at once. The engine never waits on a path: no locks, only
   in-flight marking, so a host whose adapter awaits its own event cannot deadlock. See
   [sync-engine.md](docs/sync-engine.md#offline-changes-and-reconciliation).
6. **Engine-initiated writes, deletes and moves are never re-synced as user actions.**
   `SelfEventLog` records each one (and each pushed version before the request goes out) and the
   matching vault/WebSocket event is consumed. See
   [sync-engine.md](docs/sync-engine.md#self-events).
7. **A rename sends no content.** A version whose hash the chain head already holds omits the
   payload; the server checks the blob actually exists (`content_missing`) and a peer that has
   the bytes follows the move without downloading. See
   [sync-engine.md](docs/sync-engine.md#renames-and-content-reuse).
8. **The scope is device-local and applies to both ends.** One predicate filters the local
   listing, the events, the remote chains and the identity indexes; ownership is total and
   exclusive (conflict copies, hidden paths, config-folder groups, excluded folders). Hard
   exclusions include `.obsidian/plugins/courier/**` (this device's credentials). The scope is
   read once when the host is built; changing it restarts the host. A restore may land outside
   the scope; nothing else may. See
   [sync-scope.md](docs/sync-scope.md#ownership-and-the-predicate).
9. **Settings are polled, and applied is not live.** The config folder has no vault index and
   fires no event, so the Obsidian host runs a settings pass (the CLI never syncs the config
   folder); `onSettingsApplied` tells the plugin which group changed, and only groups Obsidian does
   not apply in-process raise the reload card. See
   [sync-scope.md](docs/sync-scope.md#applied-is-not-live).
10. **A restore never overwrites a file that is not its own.** Inspect the target first; only a
    free or same-chain path may be written. A taken path asks for another **name** (pre-filled
    with the original name plus `-1`, e.g. `hero.md` → `hero-1.md`), and the chosen name must
    stay in this device's scope when the restored file is in it. See [sync-engine.md](docs/sync-engine.md#restore).
11. **Cost is bounded.** A stamp is only recorded with the hash of the bytes at that stamp (and
    a missing stamp costs one re-read). Creates are batched (100 files / 8 MiB); a pass orders
    work by priority, runs through `WorkPool`, claims paths through `PathClaims`, bounds
    event-driven work through `OpQueue`, and coalesces a burst of `file_pushed` notifications into
    batched chain pulls (200 per request). See
    [sync-engine.md](docs/sync-engine.md#cost-stamps-and-re-reads) and
    [sync-engine.md](docs/sync-engine.md#pass-order-and-concurrency).
12. **Every client runs the same host loop.** `SyncHost` owns the bind gate, the single-flight
    reconcile, the reconnect-only reconcile, the settings poll, `OpQueue`, session-id propagation
    and `stop()`; `user_key_revoked` / `user_key_disabled` / `vault_deleted`, and any HTTP
    `401`/`403` on a pass, stop the host before reporting (`onAuthFailure(reason)`). A host
    supplies only the adapter, event source, network, state store and **platform** (timers, plus
    the optional Node surface); the engine names no global of its own. See
    [sync-engine.md](docs/sync-engine.md#the-host-loop).
13. **The server holds no content semantics.** Chains plus content-addressed encrypted blobs
    (bytes, one per hash, never a truncating rewrite; a blob is a byte range in one immutable
    file per push batch, flushed once per batch and unlinked with its last row); chain order is
    `(created_at, rowid)`; a
    route is HTTP only, a handler takes injected `*Fn` dependencies and a repository owns SQL,
    enforced by `.oxlintrc.json`. See [server.md](docs/server.md#layering); the wire contract is
    [api.md](docs/api.md).

## Destructive operations (hard rules)

Deleting from a shell is permanent on every platform: it skips the recycle bin (Trash), hides
failures, and leaves no per-file history. This repository is developed on Windows, macOS and Linux,
so a habit that is safe on one is destructive on another. The full rules, including the per-platform
shell traps, are in [docs/agent-safety.md](docs/agent-safety.md); these are the short version:

- **Delete only inside the checkout.** Resolve the target (`realpath` / `Resolve-Path -LiteralPath`),
  print the resolved path, and confirm it is **strictly inside the checkout the session was given**.
  Recursive deletion is allowed only there and only after that check: `rm -rf -- <target>`,
  `Remove-Item -LiteralPath <target> -Recurse -Force`, `find <target> -delete`, or `rsync --delete`
  / `rclone sync` after a reviewed `--dry-run`.
- **Never** run a delete against a filesystem root, `$HOME` / `%USERPROFILE%`, the checkout root
  itself, `.git`, a worktree root, or any path outside the checkout — including through an
  unresolved variable or a glob. Delete a worktree only with `git worktree remove <path>`.
- **Never** run a disk-destroying command: `format`, `diskpart clean`, `Initialize-Disk`, `mkfs*`,
  `dd` to a device, `diskutil eraseDisk`, `parted mklabel`.
- **Never** put an unset variable or a glob in a delete, and never `sudo` a delete that failed
  without it. Resolve the path, print it, confirm it is inside this checkout.
- **Never** use `cmd /c "..."` with nested quotes, or let a quoted Windows path end in `\`; use
  `-LiteralPath` in PowerShell.
- **PowerShell**: `$home` is the read-only `$HOME` (variable names are case-insensitive); assigning
  to it fails without stopping the script. Use `$scratch`, set `$ErrorActionPreference = 'Stop'`,
  and never combine create, run and delete in one command. Cleanup uses
  `bun scripts/safe-delete.ts <file>` for files and
  `bun scripts/safe-delete.ts --recursive <dir>` for a directory inside the checkout; the helper
  enforces the same boundary and refuses `.git`, a Git worktree root, the checkout root, symlinks
  and paths outside it.
- **Never** write recovered or restored data back to its source disk.
- **Never** widen the sandbox or turn off approval to get a command through; stop and ask.

## Testing policy

Five layers, cheapest first. A layer is defined by **what is real and what is substituted**, not
by which package the file lives in. The `L0`–`L4` labels are used in discussion and reviews.

| Layer  | Real                                                     | Substituted                                    | Lives in                              | Per case |
| ------ | -------------------------------------------------------- | ---------------------------------------------- | ------------------------------------- | -------- |
| **L0** | the unit under test                                      | every dependency (`mock()`); no network, no DB | `packages/*/src/**/*.test.ts`         | ms       |
| **L1** | server (SQLite + `Bun.serve` + native WS), engine, files | Obsidian and the plugin                        | `packages/e2e/src/*.e2e.test.ts`      | ~200 ms  |
| **L2** | all of L1 **plus the real plugin class**                 | only the `obsidian` runtime                    | `packages/e2e/src/plugin.e2e.test.ts` | ~200 ms  |
| **L3** | all of L2, including a real running Obsidian             | nothing                                        | `packages/e2e/src/obsidian/`          | ~1 s     |
| **L4** | everything, plus a human looking at it                   | —                                              | manual                                | minutes  |

**Pick the first layer whose "Substituted" column covers what you changed:**

- pure logic (decisions, conflict rules, crypto, path handling) → **L0**;
- engine semantics, server routes, protocol/response fields → **L1**;
- the plugin itself (`main.ts` wiring, dialogs, lifecycle, vault-event handling) → **L2**;
- Obsidian-specific behaviour (the `Vault` API, real event timing, `Platform`, the built bundle,
  real file watching, the config folder) → **L3, mandatory**;
- rendering, layout, a real mobile runtime → **L4**.

**The L3 rule.** Run `bun run verify obsidian` for every change on the sync path, while developing
— not at release time. That includes `packages/engine/**`, `packages/plugin/**`,
`packages/shared/src/wire.ts` / `sync.ts`, `packages/e2e/src/harness/**` or `obsidian/**`, and
the build config or bundle. "It is an engine change, L0/L1 cover it" is not an exception: the
rules are executed by a real adapter in a real app. It needs an Obsidian install with its CLI
enabled — the suite starts the app when it is not already running — and the disposable vaults
registered (`bun run e2e:obsidian`, once per checkout, with Obsidian closed); never point it at the
developer's development vaults (`vault_a` / `vault_b`, or a worktree's suffixed pair), and run one
L3 per checkout — different worktrees may run in parallel because each registers its own suffixed
vault pair. CI runs the behavioural subset
(`bun run verify obsidian-ci`: pinned Obsidian under Xvfb, and an installed pinned build on
Windows) on sync-path changes; rendered-geometry
assertions (`itL`) are a reference-platform contract — Windows by default, moved with
`COURIER_OBSIDIAN_LAYOUT_PLATFORM` — and stay on that machine. CI is additive; it does not replace
the full local gate. When L3 did not run, say so in the report (`L3 not run: <why>`) and do not
call the change done; when it ran,
state the outcome (`L3: … passed`). An L3 failure is a product bug until proven otherwise: the
suite has no retries, so find out whether the app or the test's assumption is wrong.

A **phone-only** behaviour belongs in L3 too, not only in the L2 stub: `app.emulateMobile` reloads
the real app into mobile mode, so the plugin's mobile `onload` actually runs. The helpers and the
rules (always restore the desktop mode) are in
[testing.md](docs/testing.md#mobile-cases-in-l3); write the case as part of a change that branches
on `Platform.isMobile` / `Platform.isPhone`, rather than assuming the stub covers the branch.

**Coverage is a ratchet.** Run `bun run test:coverage` at the boundary (with L3), not in the
inner loop. The per-package floors live in `vitest.config.ts` — lines, statements, functions and
branches, the numbers the repository has held since before the Bun port — and Vitest fails the run
when a package drops below one. It covers `packages/*/src` only, and may only be
raised; never lower one to make a change pass, and never chase a percentage. A package that
genuinely cannot hold its number gets a commit that names the branch and why.

**Mutation testing answers "is this rule actually pinned?"** — coverage does not. It is a
one-off survey, not a gate and never a score: `docs/mutation-testing.md` has the three commands
and the triage rules. Reach for it when a change adds a rule with non-obvious branches.

**A stub must be as strict as the API it replaces.** Both real defects that reached a running
vault were invisible because `obsidian-stub.ts` / `FakeVault` were kinder than the app. Loosening
a fake to make a test pass is a visible decision (`stub-fidelity.test.ts`), not a silent one;
details and the full contract are in [testing.md](docs/testing.md#stub-fidelity).

## Conventions

- **Comments**: add them for non-obvious logic, complex algorithms and public API surfaces;
  skip them for self-explanatory code. All code comments and JSDoc are English.
- **Copy**: every user-facing plugin/CLI string goes through the i18n catalogs and `t()` /
  `plural()`; never cache localized text in module-level constants (the locale is chosen after
  the bundle loads). See [docs/i18n.md](docs/i18n.md).
- **Lint warnings are failures.** `bun run lint` runs `oxlint --deny-warnings`, so a warning fails
  `bun run verify` just like an error. Fix the warning; do not add a rule exception to silence it.
- **Pre-commit** (`lint-staged`) runs `oxfmt --write` → `oxlint` → `bun run typecheck` →
  `bun --bun vitest related --run` on staged files only. It cannot catch cross-package breakage, so run
  `bun run verify` (lint + typecheck + the full suite) before calling a change done and read its
  summary.
- **Generated and ignored**: `dist/`, `node_modules/`, `vault_a/`, `vault_b/` (and their
  per-worktree `vault_a-*` / `vault_b-*` pairs), `.courier-dev/`, `.e2e-vaults/`,
  `packages/server/data/`, `packages/cli/build/` and `.agents/ui-preview/` are not source.
  Dev plugin installs go into the gitignored development vaults; `bun run dev` creates them,
  registers them with Obsidian and signs both in to the local dev server (see
  [plugin.md](docs/plugin.md#dev-loop-and-test-vaults)).
- **Build**: `@courier/shared` has no build step and zero dependencies; the plugin's `tsc` is
  `noEmit`, so **`Bun.build` is the only writer of `packages/plugin/dist/`** (exactly `main.js`);
  the server builds with `tsc` only.
- **Versions**: the three release packages carry one version, stamped by
  `bun run version:snapshot` for test builds (`0.0.0-dev.YYYYMMDD.<shortsha>`) and mirrored to the
  repository-root `manifest.json` the Obsidian directory reads; `version:snapshot` writes all four
  and `scripts/check-release.ts` fails when the mirror and the plugin manifest differ; see
  [docs/release.md](docs/release.md#snapshot-versions-for-test-builds).
