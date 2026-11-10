# Testing

> Status: `authoritative`. The layer definitions, the "pick a layer" rule, the L3 mandate and
> the coverage policy are normative in [`AGENTS.md`](../AGENTS.md#testing-policy); this
> document describes the harness, the non-obvious mechanics and the stub-fidelity contract.

## Runner and projects

- **Runner**: `bun run test` is `bun --bun vitest run` — **Vitest is the runner, Bun is the runtime**. The `--bun` flag matters: without it Bun runs the Vitest CLI on Node, where the server's `bun:sqlite` import does not exist. `vitest.config.ts` holds seven projects: the six packages (`packages/e2e`, `packages/plugin`, `packages/server`, `packages/engine`, `packages/cli`, `packages/shared`) plus one for the repository tooling under `scripts/`; the plugin project has the `@` → `/src` alias and the e2e project aliases `obsidian` to its runtime stub. Test files import `describe`/`expect`/`it` from `vitest` explicitly; the global types come from `@types/bun` in the base tsconfig. Every project sets an explicit `exclude` (`node_modules`, `dist`, `build`, `target`) so build output is never collected as a test — a `tsc`-emitted `packages/plugin/dist/*.test.js` used to run as a stale duplicate of the real test file and report a misleading pass. Vitest isolates every test file by default, so a module-level handle one suite closes cannot leak into the next.

## Test patterns by package

- **Server tests — logic with injected dependencies, SQL with a throwaway database**: business logic lives in `src/handlers/` as pure functions receiving DB/fs operations as injectable function parameters; those tests pass `vi.fn()` functions and never open a database. The modules that _are_ the SQL — `src/db/repositories/*`, `src/db/migrations.ts`, `src/commands/prune.ts` — are tested against a real `bun:sqlite` database: a temp file for the modules that import `../db/index` (`SQLITE_PATH` set **before** the import), and `:memory:` for the migration chain itself; the schema comes from the server's own `runMigrations`, so a test cannot drift from the shipped chain. Real bindings live in `src/routes/*` (HTTP) and `src/commands/*-actions.ts` (CLI); `main.ts` wires CLI commands to their actions modules. (The e2e project runs the real routes against the same kind of throwaway database.)
- **Server routing integration**: may start the listener and use its real routes with the real DB; prefer handler unit tests with mocked actions.
- **Contract tests**: the wire is executable, so its tests are too. `packages/shared/src/wire/conformance.test.ts` pins every schema's inferred type to the interface it replaced; `surface.test.ts` pins the serialized surface (constraints, determinism, the unknown-key rule); `scripts/contract/classify.test.ts` pins the direction-aware verdicts; `packages/server/src/routes/health.test.ts` builds a real table from the registry with stub auth lookups — which is why `toRouteTable` takes its dependencies instead of importing them. L1 drives every route and every frame against the real server.
- **Engine tests**: pure decision tests (`decide.test.ts`) + `SyncEngine` integration tests with fake adapters/APIs and a real derived Web Crypto key (`engine.*.test.ts`).
- **CLI tests**: config persistence (temp dir via `COURIER_CLI_CONFIG_DIR`) + the `status` summary in `src/status.test.ts`, whose JSON shape and text lines are built by the pure `src/status.ts` — `main.ts` runs `program.parse()` on import, so nothing in it is reachable from a test + API client with injected mock `fetch` (`api.test.ts`). The **command surface itself** (flag → action → stored config → stdout/exit code) is `packages/e2e/src/cli-commands.e2e.test.ts`, because a supervising process spawns the binary and reads exactly that contract.
- **Plugin tests**: network calls abstracted as injectable action types in `src/shared/api.ts`, wired to real `requestUrl()` in `src/main.ts`. Tests inject plain `vi.fn()` mocks — no real network, no module mocking. (The wiring itself is covered by the e2e project, not here.)

## Suite map

Run the file for the current list; this is the theme each one owns.

| File                                           | Theme                                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/e2e/src/sync.e2e.test.ts`            | create/edit/rename/delete, restore, chains, offline catch-up, conditional-push races                                         |
| `packages/e2e/src/path-sync.e2e.test.ts`       | the same operations across path shapes (root, nested, deep chains, cross-folder moves)                                       |
| `packages/e2e/src/cli-daemon.e2e.test.ts`      | the headless daemon and its reconnect path                                                                                   |
| `packages/e2e/src/cli-commands.e2e.test.ts`    | the command surface a supervising process reads (register, vault connect/update/disconnect, device, status --json, refusals) |
| `packages/e2e/src/settings-sync.e2e.test.ts`   | the Obsidian config folder and the per-group rules                                                                           |
| `packages/e2e/src/attachment-sync.e2e.test.ts` | file types, byte equality, the size cap, binary conflicts                                                                    |
| `packages/e2e/src/large-file.e2e.test.ts`      | wire cost: bytes not base64, rename without content, batching, stamps                                                        |
| `packages/e2e/src/folder-rename.e2e.test.ts`   | folder renames and the concurrent burst                                                                                      |
| `packages/e2e/src/user-lifecycle.e2e.test.ts`  | disable/re-enable, cascade delete, and the edits the service refuses                                                         |
| `packages/e2e/src/bulk-write.e2e.test.ts`      | a bulk local write through the real `SyncHost` against the **deployed** allowance (creates, edits, deletions, moves)         |
| `packages/e2e/src/plugin.e2e.test.ts`          | the real plugin class (L2)                                                                                                   |
| `packages/e2e/src/obsidian/`                   | real Obsidian over the CLI (L3)                                                                                              |

`src/bench/` and `src/research/` are **opt-in and skipped by default**: the first is the CI-measured
product benchmark (`bun run bench`, see [ci-sync-benchmarks.md](ci-sync-benchmarks.md)), the second holds
one-off probes that stay local. Neither is part of `bun run verify`, so a file there only runs when its own
`COURIER_BENCH` guard is set — and a probe that outlives its question (the fix landed, or the rule is
pinned elsewhere) is deleted rather than kept: nothing in those folders can fail the default gate, so
nothing there notices when it goes stale.

## L1: engine and server, headless

The "device" half is `src/harness/client.ts`: a temp directory + the CLI's real `FsAdapter` +
real `createCliSyncApi` + the real `SyncEngine`. Nothing stands in for production code except the
Obsidian runtime.

The boundary worth internalising: **L1 has no file events.** A test writes with `client.write()` and
must then tell the engine itself (`await client.change(path)`), where real Obsidian would fire
`vault.on("modify")`. That single difference is the whole gap to L2 — a defect in the event wiring is
invisible from here.

**Every `TestClient` helper asserts the settled-client invariants** after it returns
(`src/harness/consistency.ts`, from `sync`/`bind`/`change`/`rename`/`removeAndSync`/`syncSettings`; `remotePushed` is not checked, because a notification may be delivered concurrently or from inside a write):
for each chain that owns a path **and is inside this device's scope**, the bytes on disk hash to the
sync point the state records, and no two live chains claim one path. Two exemptions: an entry whose
path is out of scope is skipped (the engine deliberately leaves it alone), and an entry with the
empty content hash is skipped because a tombstone and a live empty file cannot be told apart from the
state alone — the L0 matrix has the chain action and checks both. Two consequences for test authors: a
case that writes without reporting it must report it before the next helper call (the harness fails the
case with "the state and the disk disagree"), and the check re-hashes every tracked file per helper
call, so many unreported edits are cheaper as raw `client.write()` calls plus one `change()` than as
many helper calls.

## L2: the real plugin, Obsidian stubbed

Same server and engine, but the client is the real `CourierPlugin`, with `obsidian` aliased to
`src/harness/obsidian-stub.ts` (the published package ships types only).

- **What stays L4**: the stub records the DOM, it does not draw it. "Does this dialog read correctly on
  a phone, and does the button _look_ disabled" is a human looking at a real vault.

## Shared harness

- **Harness** (`src/harness/`): `server.ts` boots the real `Bun.serve` app + native WebSocket server against a
  throwaway SQLite file and blob store, and builds its schema with the server's own
  `runMigrations` — the same chain `courier migrate` applies, ledger included. `fake-vault.ts` is an in-memory `Vault` that **emits events like the real app does**,
  which is what makes echo suppression and the host's event wiring testable. Turning the connection off
  is part of the harness too: `TestClient.goOffline()` makes every request throw (a vault event's push
  is then lost, as it is offline), and `server.dropSockets()` closes the live sockets without stopping
  the server, so the client's own reconnect path is what a test exercises. The harness boots the server the way the dev loop does — **plain HTTP**, with `TLS_NAME` unset — because a test client would have to be handed the fixture certificate as its CA: the TLS listener is covered by `packages/server`'s own tests with that committed fixture, and real issuance only exists against a deployed server.
- **Conventions**: files run sequentially (each boots a server on its own port and points
  `process.env` at its own temp database). Sibling packages are imported by relative path so the
  suite needs no linking step and their third-party deps resolve from their own `node_modules`;
  only `obsidian` needs the alias. `packages/e2e/tsconfig.json` is type-check only and exists so
  `bun run typecheck` still covers the harness. `startTestServer` also sets
  `SYNC_RATE_LIMIT_MAX_ATTEMPTS` for its throwaway server (`syncRateLimitOptions()` in
  `packages/server/src/middleware/rate-limit.ts`) — a scenario has two clients answering each other,
  and a `429` mid-scenario reads as a sync failure instead of the limiter it is. That ceiling is a
  default, not a law: `startTestServer(name, { syncRateLimitMaxAttempts })` passes the deployed number
  (600) for a case that **is** about the allowance — `bulk-write.e2e.test.ts` does, because its point is
  that a bulk write stays inside it.
- **Request volume is bounded, and measured.** Idle traffic is **0 requests**; one local edit costs
  ~3 (pull → push → pull) and adds exactly one version to the chain; a first bind costs one request per
  **100 files** created (the pass batches its creates — see [sync-engine.md](sync-engine.md#batching)) plus the history call, not
  one per file; a 700-file bulk write costs fewer than 40 pushes (the host hands the burst to one batched
  job — see [sync-engine.md](sync-engine.md#pass-order-and-concurrency)); a reconnect costs one
  reconcile (2 requests: the vault history plus whatever it has to push or pull); the whole
  real-Obsidian suite is ~200. So the burst is honest event propagation, not a
  retry loop — but if a chain ever grows while nothing changes, that _is_ a loop: investigate it instead
  of raising the ceiling again.
- **Known gaps are encoded as `it.fails(...)`** with a comment explaining what is broken, so the
  suite stays green while the defect is tracked and starts failing the day it is fixed (removing the
  marker is then deliberate). Run `grep -rn "it.fails" packages/e2e/src` for the current list instead
  of trusting a snapshot in this file.

## L3: real Obsidian

The layer that removes the last human from the loop. Two real Obsidian vaults with the real plugin
loaded, driven through the **official Obsidian CLI**; assertions are values read back from the _other_
vault. No screenshots, no clicking. `bun run verify obsidian` is the gate (it skips itself unless
`COURIER_OBSIDIAN_E2E=1` is set, and **its prerequisites are the disposable vaults being registered**,
not Obsidian already running — `ensureObsidianRunning()`/`prepareVault()` start it and open the
window). `COURIER_OBSIDIAN_E2E=1 bun --bun vitest run packages/e2e/src/obsidian` runs it
directly. The inner loop names one case instead of the whole suite:
`COURIER_OBSIDIAN_E2E=1 bun --bun vitest run packages/e2e/src/obsidian -t "settings conflict"`. The
`beforeAll` builds the plugin and binds both vaults either way, so the full gate is the normal thing
after a slice; the filtered form is for iterating inside one case.

**Order of operations.** A fresh checkout (or one whose `.e2e-vaults/` was deleted):

```bash
# 1. Once per checkout. Obsidian must be CLOSED: it reads obsidian.json at startup and
#    rewrites the file itself, so the registry can only be edited while it is not
#    running. The script registers the pair, builds the plugin, installs it into both
#    vaults, starts the app and opens a window per vault.
bun run e2e:obsidian

# 2. The gate, as often as you like. Obsidian may be open or closed; a cold app comes
#    up on the vault chooser and the harness opens the windows itself.
bun run verify obsidian
```

Re-running step 1 with Obsidian **open** is fine and is the normal way to pick up a plugin
change: both vaults are already registered, so it leaves the registry alone, rebuilds and
reinstalls. It stops and asks you to close the app only when a vault is actually missing from
the registry — the one case where it would have to write the file.

- **`bun run e2e:obsidian` is a one-time registration step** and it is idempotent: it skips the registry
  entirely when both vault paths are already in it, so re-running it only wastes a build. Run it once
  **per checkout**: each checkout registers its own pair (see the naming rule below), and two setups
  must not run at the same time — they compose the same `obsidian.json`.
- **One runner per checkout; different checkouts may run in parallel.** A checkout owns its two vault
  folders and the `data.json` they share, so a second concurrent run _in the same checkout_ — or a run
  racing `bun run dev`'s vault hot-reload there — produces meaningless, flaky-looking failures. Two
  **different** checkouts are independent: `e2eVaults()` names the pair after the checkout
  (`courier-e2e-a` in the primary one, `courier-e2e-a-<worktree>` elsewhere), because Obsidian resolves
  `vault=<name>` to one folder and two worktrees sharing a name would drive each other's vault.
  `prepareVault` additionally fails fast when the app has that name open at a folder that is not this
  checkout's. Parallel runs share one Obsidian and one machine's CPU, so expect both to run slower.
- **Never touch the developer's own vaults** (`vault_a` / `vault_b` at the repo root, or a worktree's
  `vault_a-<worktree>` pair — see [plugin.md](plugin.md#dev-loop-and-test-vaults)). `e2eVaults()` in
  `src/obsidian/vaults.ts` is the only sanctioned way to reach the disposable ones — do not bypass it —
  and do not run `bun run e2e:obsidian --clean` (it unregisters and deletes, and needs Obsidian closed).
- **Decoding a failure**: `unable to find Obsidian`, or a vault that never becomes reachable → Obsidian
  is down or that vault is not in the registry (`obsidian vaults verbose` should list both
  `courier-e2e-*`). `Command "eval" not found` → that vault has no window yet. A case failing because of
  a genuine Obsidian behaviour difference is real information: do not weaken the assertion to make it
  pass — decide from the actual semantics whether the assertion, the harness, or the product is wrong.
- **Why registration is a separate, explicit step**: Obsidian reads its vault registry only at
  startup _and_ writes that file itself, so an entry added while it runs is ignored and can be
  clobbered. `bun run e2e:obsidian` therefore refuses to touch the registry unless Obsidian is closed,
  keeps a backup the first time it writes, and only ever removes entries inside `.e2e-vaults/`.
- **Why a fresh vault needs two nudges**: the CLI can only run `eval` in a vault that has a window,
  and a vault Obsidian has never opened comes up in **restricted mode**, which keeps community
  plugins from loading even when `community-plugins.json` lists them. `prepareVault()` opens the
  window (only when the vault has none — see the next bullet) and runs `plugins:restrict off`.
- **A warm run leaves Obsidian where it is.** `prepareVault()` reaches for `obsidian://open` only
  when the vault has no window: the URI handler restores and focuses an existing window, while the
  CLI's own `eval` path asks for `focus: false`, so polling and every other helper leave the window
  behind whatever the developer has in front. Settings is the other window that used to jump
  forward: 1.14.4 renders it in a popout and focuses that window's `electronWindow` on every
  `app.setting.open()`, so `keepSettingsInVaultWindow()` closes a leftover popout, pins
  `app.setting.shouldUsePopout` false (the same modal then renders in the vault window) and
  `restoreSettingsWindow()` puts the original back in teardown. A **cold** run — Obsidian being
  launched by `ensureObsidianRunning()`, or a vault with no window — still shows a window; that is
  the only moment a run can raise the app.
- **How it drives Obsidian** (`src/obsidian/cli.ts`): `vault=<name> eval code="<js>"` runs JS in that
  vault's renderer, and `eval` awaits promises, so a whole setup sequence fits in one call. Writes go
  through `app.vault.create/modify/rename/delete` (`src/obsidian/plugin-control.ts`) — Obsidian's own
  file layer — so the plugin sees **genuine vault events**. Reads use the first-class
  `vault=<name> read path=...` command, an assertion path independent of the plugin.
  **Settings files are the exception**: they are not in the index, so `plugin-control.ts` carries
  `readConfigFileInVault`/`writeConfigFileInVault`/`removeConfigFileInVault`/`listConfigFolderInVault`
  over `app.vault.adapter` (the write deliberately fires no vault event), plus `runSettingsPass` to run
  the host's settings pass without waiting for the next tick of its timer. `configurePluginHost` takes
  `settingsGroups` so a case can bind a real vault with a scope.
- **Every CLI call is async on purpose.** The test server shares the suite's process, so a
  blocking `spawnSync` would freeze the event loop and deadlock the very HTTP request the evaluated
  plugin code is waiting on. (Learned the hard way.)
- **The plugin is bound without the password dialog**: `configurePluginHost` writes settings, derives
  the AES key in the renderer and calls the real `startHost()`. The dialog itself is covered by
  `plugin.e2e.test.ts`; everything after it is real. With `resetSyncState: true` (default) the persisted sync state is cleared too, so the plugin binds the
  vault like a fresh install; there is nothing else about this client to reset — the `deviceName` it
  states is only a label written onto version rows. `resetSyncState: false` keeps state and models "Obsidian was
  closed and reopened".

### Mobile cases in L3

A phone-only surface is testable in the real app, and a rule that must hold on **every** platform
deserves the case: Obsidian's own mobile emulation makes the plugin start the way it does on a
phone. Use it — the mobile path is not "the same code, so L2 covers it"; L2's stub sets
`Platform.isMobile` itself, while L3 re-runs `onload` with the app actually reporting mobile.

- **`setMobileEmulation(vault, enabled)`** (`src/obsidian/plugin-control.ts`) calls
  `app.emulateMobile(enabled)`. That method is not in the public typings: it stores a flag and
  reloads the window, so the call can even lose its own answer to the reload. The helper confirms
  the mode instead of assuming it — it waits until the vault answers again, reports the requested
  `app.isMobile`, and has the plugin loaded. The reload is the point: the plugin's `onload` runs
  with `Platform.isDesktop === false`, which is the real mobile start (`ui/file-explorer-actions.ts`
  is skipped, the long-press `file-menu` is the only surface).
- **`readFileMenuTitles(vault, path)`** triggers the app's own `file-menu` event for a real `TFile`
  with a chainable stand-in `Menu`. Core plugins run too, so assert on **Courier's** titles
  (`t("menu.versionHistory")`, `t("conflict.action.diff.title")`), not on the whole list. No menu is
  shown, so no pointer, layout or invoker is involved — which is why the case runs in `obsidian-ci`.
  A path that is not a vault file throws rather than answering an empty list, so a negative
  assertion cannot pass because the fixture was missing.
- **Always restore it in a `finally`.** `await setMobileEmulation(vault, false)` reloads the app
  back; every later case in the suite assumes the desktop layout, and a stuck mobile run fails the
  cases after it in a way that looks unrelated. The same `finally` owns whatever the case wrote: a
  list it excluded stays excluded for the next case otherwise (the harness's `configurePluginHost`
  does not reset `excludedFolders` when the case passes none), so clear it through
  `setExcludedFoldersInVault(vault, [])`.
- **Assert the branch, not only the absence.** A case that hides an action on a phone must also
  show an **in-scope** file where the action remains (the version-history item, a parked copy's
  comparison), and that positive is the one to **wait for first**: the handler is registered during
  the reload's `onload`, so an empty menu proves nothing until it has answered once.
- **Do not poke `Platform.isMobile` from an L3 body.** The plugin reads the module singleton and
  `onload` has already run, so the app would claim to be a phone without the plugin ever starting as
  one. That shortcut belongs to L2, where the flags are set **before** the plugin loads
  (`plugin.e2e.test.ts`).
- **When to write one**: a rule that has to answer the same on every platform (the sync scope,
  conflict actions, a settings switch), or a surface only a phone has (the long-press menu, the
  one-column comparison). If the change branches on `Platform.isMobile`/`Platform.isPhone`, the L3
  case is not optional — write it as part of the change, not as a follow-up, and do not assume the
  stub covers the branch.

### L3 in CI

`.github/workflows/l3-obsidian.yml` runs the suite on **up to three runners**, each driven through the
app's own CLI exactly as a local run is: a headless Ubuntu runner with a pinned Obsidian Linux build
under Xvfb, a Windows runner with a pinned Obsidian Windows installer, and a macOS runner with a
pinned Obsidian DMG. The workflow triggers on pull requests (and pushes to `main`) whose `paths`
touch the sync path, and on manual dispatch; docs-only changes do not spend a run. Ubuntu and
Windows run on every one of those events; the macOS job is manual-dispatch only while a runner hang
is investigated (see the end of this section).
`.github/actions/obsidian-linux` installs `xvfb`/`fluxbox` and the Electron libraries, verifies the
pinned tarball's sha256, caches the extracted build, and pins `releases.obsidian.md` to `127.0.0.1`
so a background update cannot replace the app mid-run. It installs **no CJK font**:
`fonts-noto-cjk` was 61 MB of the ~85 MB the step downloads on every run, the gate skips every
`itL` case, and its value cases compare text, file state and CSS-anchored corners, so no assertion
depends on a glyph's shape. The job's 40-minute cap has the same reason — a slow package mirror
once took 28 minutes of a 30-minute run and must not decide whether the run says anything.

`.github/actions/obsidian-windows` caches the pinned `Obsidian-<version>.exe` by version and
sha256, verifies that hash (on a cache hit too), makes up to four download attempts when GitHub's
release CDN answers a 5xx — a 503 and a 504 ended two L3 runs on 2026-11-08, before the suite had
started — installs it silently to `%LOCALAPPDATA%\Programs\Obsidian`, and exposes `Obsidian.exe` as
`COURIER_OBSIDIAN_APP` and `Obsidian.com` — the terminal redirector a GUI app needs — as
`COURIER_OBSIDIAN_CLI`. It pins the same update endpoint through the runner's hosts file. The
install itself runs every time: the installer registers the `obsidian://` protocol handler, so a
restored install directory is not the same machine state as an installed app, while the cached
bytes are.

`.github/actions/obsidian-macos` downloads the pinned `Obsidian-<version>.dmg`, verifies its
sha256, copies `Obsidian.app` to `/Applications`, and symlinks the CLI the bundle already carries
(`Contents/MacOS/obsidian-cli`) to `/usr/local/bin/obsidian`. That is the file the app's own
"Register the CLI" step creates through an administrator dialog, which a runner cannot click; the
other half of that setting, the `cli` flag in Obsidian's vault registry, is written by
`bun run e2e:obsidian` before the app starts.

The Windows and macOS jobs register the vaults with `COURIER_E2E_OPEN_VAULTS=1` like the Linux one,
so the cold start restores both windows instead of needing a focused window for `obsidian://open`.

GitHub's macOS arm64 pool is capacity-constrained, so the macOS job can be cancelled before it
starts with "not acquired by Runner of type hosted" after ~15 minutes of queueing. That is not a
code signal: re-run the job (the same commit passed in about three minutes once it got a runner).

**The macOS job runs on manual dispatch only for now.** It has passed there (96 passed, 6 skipped,
3m07s) and it has also hung on cases that wait for a vault state — a 300 s hook timeout, then 120 s
per case — on the same commit that passed earlier. That is either a macOS product behaviour or a
harness assumption about the app's windows, and it needs a Mac to tell which; until it is diagnosed
`workflow_dispatch` runs it and pull requests do not, so a known-flaky run cannot redden an
unrelated change. Remove the `if` once the hang is understood.

- **The gate is `bun run verify obsidian-ci`**: the same suite with
  `COURIER_OBSIDIAN_E2E_LAYOUT=0`. The cases that mixed behaviour and layout were split: their
  behavioural halves (the history's content, the parked-copy comparison/replace flow, the status
  bar's menu pause/resume/settings) run in CI; their layout halves are `itL` cases — rendered
  geometry (`getBoundingClientRect`, `getComputedStyle`, `styles.css`), the file explorer's
  dimming classes and the status bar / account-usage bars. Those measurements pin the design on
  the **reference platform** (Windows by default, because that is where it was checked):
  `COURIER_OBSIDIAN_LAYOUT_PLATFORM=darwin` moves the reference, `COURIER_OBSIDIAN_E2E_LAYOUT=1`
  forces a trial run anywhere, and `=0` turns the layout assertions off. Fonts, DPI and the theme
  differ per OS, and a headless runner may not mount the file explorer's rows, so they are not a
  cross-platform product signal. Everything else, including Obsidian's own file layer, websocket
  timing, reloads and the config folder, runs in CI.
- **Menus are DOM on the reference platforms, native on macOS.** Obsidian 1.14 on macOS opens a
  `Menu` as a native menu: no `BrowserWindow`'s document contains `.menu`, so
  `readStatusMenu` / `clickStatusMenuRow` cannot see it. The one case that asserts the real menu's
  content is `itMenu` — it runs where menus are DOM (Windows/Linux, the reference platforms) and is
  skipped on macOS unless `COURIER_OBSIDIAN_MENU_DOM=1` forces it. The plugin still anchors a
  synthetic click to the status bar (so the menu opens next to it, not at the last pointer
  position). The macOS menu's placement and the option of a DOM-free assertion are open work.
- **CI has no `obsidian://` handler and no desktop session.** `COURIER_E2E_OPEN_VAULTS=1` makes
  the setup script register both vaults as open, so the cold start restores their windows;
  `COURIER_OBSIDIAN_APP` points at the extracted app binary (the CLI copy in `~/.local/bin` is not
  the app), and `COURIER_OBSIDIAN_APP_FLAGS` carries `--no-sandbox --disable-gpu`.
- **The same no-retry rule applies.** If a case fails on the runner, it is a product bug or a
  wrong test assumption until proven otherwise; do not add a retry or skip it silently. A **wait**
  for a surface that fills asynchronously is not a case retry — `waitForVaultState` polls one, and
  `expectEventually` (`src/harness/wait.ts`) asserts a reading a repaint can legitimately blank —
  but a case that failed is never re-run to make it pass. A layout assertion that turns out to be
  environment-dependent belongs behind the layout flag, with the reason written next to it.
- **The layout assertions are a reference-platform contract.** They do not claim the UI is
  pixel-identical across OSes; they pin the design on one machine's fonts, DPI and theme. When
  the primary dev machine changes, set `COURIER_OBSIDIAN_LAYOUT_PLATFORM` and run the `itL` cases
  once there — do not loosen the numbers to make another OS pass.
- **Reproducing locally on Linux**: install Obsidian (with its CLI) and run the same command the
  workflow runs — `xvfb-run -a -s "-screen 0 1920x1080x24 -dpi 96 -extension MIT-SHM -nolisten tcp"
  bash -c 'fluxbox & bun run e2e:obsidian && bun run verify obsidian-ci'`. On Windows/macOS the local
  gate is still `bun run verify obsidian` (all cases).

## L3 caveats and reset

- **Caveats**: it drives the real app — it opens the two disposable vaults, reloads the plugin and
  creates/removes `courier-e2e-*` notes in them (that is the point). A full run takes tens of seconds.
- **A run starts from a wipe that also reaches the config folder.** `resetVault()` deletes every file in
  `app.vault.getFiles()` — the **vault index** — and the config folder is deliberately not in it (see the
  sync-scope rule), so it clears `.obsidian/` separately, the way it also deletes the plugin's
  `data.json`. Nothing in the current code parks a `*.conflict.*` copy there — a config-folder conflict is
  settled by modification time and leaves no file — so what this guards against is a leftover from an older
  build or a hand-placed file, not something a run creates. The settings cases still assert that a device
  which does not sync a group parks nothing, and one stale file under `.obsidian/` would fail that
  assertion with a message pointing at the current code.

## Stub fidelity

**A stub must be as strict as the API it replaces, or it hides the defect it exists to catch.** Both
real defects that reached a running Obsidian vault were invisible because `packages/e2e/src/harness/obsidian-stub.ts`
and `FakeVault` were _more forgiving_ than the app, and both are now modelled there:

- `requestUrl` **rejects** on 4xx/5xx unless `throw: false` is passed (Obsidian's default). A stub that
  always resolved let every structured error (an expired key, a stopped server) surface as "cannot reach
  the server" in the app while the suite passed.
- `RequestUrlResponse.json` is a **getter that throws** when the body is not JSON (Obsidian parses the
  body lazily). A stub handing back a plain value let the plugin's transport read `.json` eagerly: in the
  app every binary download — the version-content route answers ciphertext — threw a `SyntaxError` the
  client could only report as a transport failure, so **no device could ever pull**, while pushes (JSON
  responses) kept working and the whole L1/L2 suite passed. A pass tolerates a pull it could not carry
  out, so nothing was even logged.
- `Vault.createBinary` **refuses a path whose folder is not in the index** (ENOENT, nothing written), as
  does `Vault.rename` for its target and `DataAdapter.writeBinary` for a folder that does not exist;
  `modifyBinary`/`delete` refuse a `TFile` the vault no longer holds; `createFolder` throws on an
  existing folder and registers it only after its adapter call (the window that makes two concurrent
  creates a real race); `.obsidian` exists on the adapter but not in the index; a data-adapter write
  fires **no** event. A fake that accepted all of that let the plugin's `ensureParentFolder` /
  `ensureFoldersInAdapter` be wrong and still pass — and the note would land nowhere in the app.
  `FakeVault`'s user-facing helpers (`create`, `createAttachment`, `move`, `writeConfig`) create the
  folder chain first, because that is what a user's Obsidian does; the API the plugin calls stays strict.

`packages/e2e/src/harness/stub-fidelity.test.ts` asserts that contract, one case per modelled behaviour,
each naming the defect it prevents. **Loosening the fake to make a test pass is therefore a visible
decision, not a silent one** — extend that file when you model another Obsidian behaviour, and keep the
fake stricter rather than kinder when the two disagree.

The rule that follows from the second one: **a host transport hands a response on lazily** and answers
`json: null` for a body that is not JSON (the `TransportResponse` contract in `packages/shared/src/http.ts`).
The CLI's `fetch` transport always did this (it reads the bytes once and `JSON.parse`s in a `try`); the
plugin's now does too. When you add a host, copy the CLI's shape, not the eager one.

## Layer coverage: the merge matrix

- **The merge matrix (what a bind does when both sides already have content) is covered at all four
  layers**, because each layer can see something the one below cannot — the decision, the real
  filesystem, the real plugin/dialog, and a real Obsidian vault:

  | case                          | L0 `decide.test.ts`                                         | L1 `path-sync.e2e.test.ts`      | L2 `plugin.e2e.test.ts`    | L3 real Obsidian       |
  | ----------------------------- | ----------------------------------------------------------- | ------------------------------- | -------------------------- | ---------------------- |
  | local only                    | push `create` (both modes)                                  | "1. local only"                 | "1. local only"            | "1. local only"        |
  | remote only                   | pull (both modes)                                           | "2. remote only"                | "2. remote only"           | "2. remote only"       |
  | same name, different content  | conflict (both modes)                                       | "3. …remote wins, local parked" | "3. …local one is parked"  | "3. …remote note wins" |
  | same name, same content       | synced (both modes)                                         | "4. same name, same content"    | "4. …no second chain"      | "4. …no conflict"      |
  | remote tombstone + local file | new file when never tracked; deletion/conflict when tracked | "5a/5b/5c/5d"                   | "5a/5b, the paused resume" | "5. …new chain"        |

  The L3 cases put notes in place through Obsidian's own file layer (`app.vault.create`): a file
  dropped on disk is not in Obsidian's index until it rescans, so the plugin cannot see it.

## Coverage and mutation

- `bun run test:coverage` is `bun --bun vitest run --coverage`, and the per-package floors live
  in `vitest.config.ts` (`test.coverage.thresholds`): **lines, statements, functions and branches**,
  the four numbers this repository has held since before the Bun port. Vitest fails the run when a
  package drops below one, so the ratchet is enforced by the runner itself.
- Coverage is measured over `packages/*/src` only — the e2e harness is the instrument, not the
  subject — and a module that lands without tests moves its package's number down. The thresholds
  only ever ratchet up; never lower one to make a change pass.
- **CI runs it** (`.github/workflows/ci.yml`, its own step in the `boundary` job, which is
  Ubuntu-only because the floors are measured there). Locally it stays
  opt-in because instrumenting every project costs a couple of minutes, but a ratchet nobody
  executes is not a ratchet: the engine drifted 0.13 points under its line floor over two weeks of
  feature work and nothing noticed until the gate was run by hand. When a floor is raised, raise it
  from a measured run on the commit that raises it, not from an older comment.
- Coverage says a line ran, not that an assertion would notice it changing. Mutation testing is
  a one-off survey, not a gate: the how-to, the measured results and the triage rules are in
  [`mutation-testing.md`](mutation-testing.md).
