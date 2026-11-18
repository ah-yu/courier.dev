# Courier documentation index

> This is the only entry point for "which document do I trust". **Read this first, then the document itself.**
>
> | Status          | Meaning                                                         |
> | --------------- | --------------------------------------------------------------- |
> | `authoritative` | Current. Update it in the same change as the code it describes. |
> | `historical`    | Records the past. The body is no longer valid; background only. |
> | `deprecated`    | Do not implement or integrate against it.                       |
> | `superseded`    | Replaced by a later decision, in whole or in part.              |
>
> **Only `authoritative` documents remain in this repository.** `historical` / `superseded` material lives in git history; never implement from a non-authoritative source.

| Document                                                      | Status          | Purpose                                                                                                                                              |
| ------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AGENTS.md`](../AGENTS.md)                                   | `authoritative` | Project intro + agent operating contract: policies, commands, cross-package invariants; details point to `docs/`. **Read before changing anything.** |
| [`docs/quick-start.md`](quick-start.md)                       | `authoritative` | User quick start: run a server, create a host key and user account, install the plugin, connect a vault, add a second device                         |
| [`docs/agent-safety.md`](agent-safety.md)                     | `authoritative` | Destructive operations on Windows, macOS and Linux: hard rules, safe deletion, shell traps, sandbox/approval exceptions                              |
| [`docs/sync-engine.md`](sync-engine.md)                       | `authoritative` | Sync engine rules: decisions, conflicts, tombstones, conditional push, offline/reconcile, hosts, restore                                             |
| [`docs/sync-scope.md`](sync-scope.md)                         | `authoritative` | Device sync scope, file types, excluded folders, config-folder settings groups, size cap                                                             |
| [`docs/plugin.md`](plugin.md)                                 | `authoritative` | Obsidian plugin: build, host wiring, settings page, dialogs, notices, status bar                                                                     |
| [`docs/testing.md`](testing.md)                               | `authoritative` | Test layers, harness, L3 mechanics (incl. mobile emulation), stub fidelity, coverage/mutation detail                                                 |
| [`docs/server.md`](server.md)                                 | `authoritative` | Server architecture: layering, TLS/ACME, errors, configuration                                                                                       |
| [`docs/api.md`](api.md)                                       | `authoritative` | Server REST + WebSocket contract (multi-user / device model)                                                                                         |
| [`docs/cli.md`](cli.md)                                       | `authoritative` | headless `courier-cli` commands and behaviour                                                                                                        |
| [`docs/release.md`](release.md)                               | `authoritative` | CI workflows, version/tag rule, snapshot versions and GitHub release assets                                                                          |
| [`docs/cnb-mirror.md`](cnb-mirror.md)                         | `authoritative` | CNB (cnb.cool) download mirror: why artifacts rather than a second build, the stable URL, setup and failure modes                                    |
| [`docs/i18n.md`](i18n.md)                                     | `authoritative` | Plugin and CLI copy, language rules, i18n maintenance                                                                                                |
| [`docs/plugin-ui-preview.md`](plugin-ui-preview.md)           | `authoritative` | How to "see" the plugin UI while developing: `bun run preview:ui`, real-Obsidian geometry, why screenshots lie                                       |
| [`docs/mutation-testing.md`](mutation-testing.md)             | `authoritative` | How to run mutation testing (Stryker, installed for one survey) + the recorded runs                                                                  |
| [`docs/first-bind-performance.md`](first-bind-performance.md) | `authoritative` | Measured cost of a first bind over a large vault, the rate-limit cliffs it meets, and the optimization plan                                          |
| [`docs/large-file-streaming.md`](large-file-streaming.md)     | `authoritative` | Streaming a large download to disk: the adapter contract, temp-file + rename, plugin index lag, and before/after measurements                        |
| [`docs/blob-files.md`](blob-files.md)                         | `authoritative` | Blob storage as one immutable file per push batch: why the per-blob flush went away, the layout, recovery, reclaim                                   |
| [`docs/ci-sync-benchmarks.md`](ci-sync-benchmarks.md)         | `authoritative` | Sync benchmarks in CI: the three scenarios, the path-filtered trigger, the base/head comparison and the pull-request summary                         |

## Division of labour

- **`AGENTS.md` is the agent operating contract**: only the policies, commands, cross-package invariants and document routing an agent must know before acting. No design history, per-file test inventories, UI pixel detail, or restated API/CLI contracts.
- **The public entry point is the repository-root [`README.md`](../README.md).** It carries the product introduction, the quick start link, the network disclosure and the license; its Chinese translation is [`README.zh-CN.md`](../README.zh-CN.md), with the English page authoritative. The Obsidian community directory reads the generated publishing mirror instead, whose `README.md` is written from [`packages/plugin/README.md`](../packages/plugin/README.md) (see [`release.md`](release.md#the-publishing-mirror)). This index stays the internal routing table for design and operations documents.
- **Sync engine behaviour** lives in [`docs/sync-engine.md`](sync-engine.md) and [`docs/sync-scope.md`](sync-scope.md). **The executable spec is still `packages/engine/src/` and its `*.test.ts`**; when a document and the code disagree, the code is right and the document is the bug.
- **Server** architecture and layering are in [`docs/server.md`](server.md), the HTTP/WebSocket contract in [`docs/api.md`](api.md); handler test patterns are in [`docs/testing.md`](testing.md).

## Maintenance

- REST / message-type changes → update [`docs/api.md`](api.md); CLI changes → update [`docs/cli.md`](cli.md); sync behaviour changes → update `docs/sync-engine.md` / `docs/sync-scope.md` and the matching tests.
- **A behaviour change updates its owning document**: when code and document disagree, the code wins and the document is fixed to match. Never keep two versions of the same claim.
- **`AGENTS.md` holds summaries only**: if a rule needs more than a few lines, put it in the owning document and link the anchor. `bun run check:docs` enforces `AGENTS.md ≤ 32 KiB`, that every document under `docs/` is listed here, and that every relative link and `#fragment` in `AGENTS.md`, the repository-root `README.md`, `README.zh-CN.md` and `docs/` resolves; it is also a `bun run verify` gate.
- **The publishing mirror is what the Obsidian community directory reads**: [`ah-yu/courier`](https://github.com/ah-yu/courier) is generated from this tree by [`scripts/mirror-plugin.ts`](../scripts/mirror-plugin.ts). Its root `README.md` comes from [`packages/plugin/README.md`](../packages/plugin/README.md), and the repository-root `manifest.json` is a verbatim copy of `packages/plugin/manifest.json` (the plugin manifest is the only one to edit; `bun scripts/check-release.ts` fails when the two differ).
- **Run `bun run verify` after every change**: one command gives the docs + migrations + lint + typecheck + test verdict.
- New document → register its status here. When two documents contradict each other, **fix or delete one of them**; never keep both.
