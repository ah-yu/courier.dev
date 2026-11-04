# CI and releases

> **Status: authoritative.** This is the single source of truth for the GitHub Actions
> workflows, the version/tag rule and the assets a release publishes. See `docs/README.md`
> for the documentation index.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and `dev`, on every pull request, and on
manual dispatch. Its `verify` job runs the same gates on **Ubuntu, macOS and Windows**, each with
the Bun version pinned by `.bun-version` (also named by `packageManager` in the root
`package.json`); `.github/actions/setup` installs it and runs `bun install --frozen-lockfile`.

The three-platform matrix is the point, not redundancy: the engine runs on each host's own
filesystem, and path case rules, rename semantics, file watching and the adapter's error codes
differ per OS. A green Ubuntu run says nothing about the Windows adapter, so every platform runs
the **whole** suite rather than a smoke subset — a platform that cannot pass it is a platform the
product does not support, and the fix belongs in the code, not in a skip list. `macos-latest` is
arm64, which is also the architecture of the published darwin asset. The matrix is the most
expensive part of CI — three runners execute the whole suite instead of one — and it runs on every
pull request because the alternative is discovering a platform break at release time.

`l3-obsidian.yml` is the real-Obsidian layer: it runs on pull requests and pushes to `main` whose
`paths` touch the sync path, plus manual dispatch, so a docs-only change never spends a run. It has
two jobs — a headless Ubuntu runner and a Windows runner — and `.github/actions/obsidian-linux` /
`.github/actions/obsidian-windows` install the pinned app and expose its CLI; the version and sha256
live in those actions and are bumped together. Both jobs run the behavioural subset
(`bun run verify obsidian-ci`); the rendered-geometry cases stay on the reference machine.

`bench.yml` runs the sync benchmark: three scenarios (many small files, one large chunked file,
renames and deletes) against the merge base and the pull request on the same runner, then posts a
sticky comment with the medians. It runs only for pull requests whose `paths` touch the sync path,
and on manual dispatch (one run per scenario, head only); it is **not** a gate — only the
benchmark's correctness invariants can fail it. The scenarios, the comparison rules and the cost
are in [ci-sync-benchmarks.md](ci-sync-benchmarks.md).

| Job           | Runner                 | What it runs                                                                             |
| ------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| `verify`      | Ubuntu, macOS, Windows | `bun scripts/check-release.ts`, `bun run verify`, `bun run build`                        |
| `boundary`    | Ubuntu                 | `bun run verify coverage`, `bun run verify format`                                       |
| `l3-obsidian` | Ubuntu and Windows     | real Obsidian through its CLI: `bun run e2e:obsidian`, then `bun run verify obsidian-ci` |

`bun run verify` covers the docs index, the generated migration chain, lint, the community
directory's scan, typecheck and the test suite (L0–L2, including the in-memory end-to-end suites) on
every platform. `bun run build` compiles the plugin bundle, the server and the CLI on every
platform as well, so a build-script path assumption fails in CI rather than in a release job.

`boundary` exists because two gates are not a per-platform signal. The **coverage floors** are
measured on the Linux runner — a second OS would move the numbers for reasons that are not the
change — and formatting is platform-independent; both run once, on the platform they are pinned
to. CI **does not** run:

- the **rendered-geometry** L3 assertions (`COURIER_OBSIDIAN_E2E_LAYOUT=0`): the `itL` halves of
  the history, conflict-comparison and status-bar cases, plus the file-explorer dimming checks
  inside the excluded-folders case. They are a **reference-platform** contract (Windows by
  default, `COURIER_OBSIDIAN_LAYOUT_PLATFORM` moves it); fonts, DPI and the theme differ per OS,
  so CI runs their behavioural halves through `bun run verify obsidian-ci` and skips the
  measurements;
- the compiled binary builds: the release workflow builds those;
- **L3 on macOS**: its CLI is registered through the app's settings and an administrator dialog that
  creates `/usr/local/bin/obsidian`, which a runner cannot click. The macOS branches run through the
  local gate (`bun run verify obsidian`) on a Mac instead. The layout contract above stays off CI on
  every platform; see [testing.md](testing.md#l3-in-ci).

The binary build jobs run `bun build --compile` (see `@courier/build`, shared by both binaries) for each target. Bun
downloads the target's runtime and embeds it, so a Linux runner can produce the darwin-arm64 and
win-x64 assets too, and no host runtime has to match anything: the version is pinned once in
`.bun-version`, which `.github/actions/setup` installs. There is no blob-assembly step, no separate
build host and no cross-architecture cache to seed — the same command produces all three assets.
What the produced binaries need from the machine that _runs_ them is in
[Linux binaries need nothing extra](#linux-binaries-need-nothing-extra).

### Snapshot versions for test builds

A test build is not a release, so it carries `0.0.0-dev.YYYYMMDD.<shortsha>`:

```bash
bun run version:snapshot
```

`scripts/version.ts` writes that value into the three package files listed below and copies the
plugin manifest to the repository-root `manifest.json`, with the date in UTC and the current
commit's short sha (the CI-provided revision when git is unavailable). The committed value is a
snapshot too, so a fresh clone is buildable; run the script before a build you want to trace back to
a commit. The form is valid semver, so `check-release.ts` (the versions agree and the root mirror
matches) still runs in CI. A real release replaces it with `X.Y.Z` by hand.

## Release procedure

The three packages ship together under one product version, and the Obsidian community directory
reads that version from a fourth file at the repository root:

- `packages/server/package.json` → `version`
- `packages/cli/package.json` → `version`
- `packages/plugin/manifest.json` → `version` (the canonical plugin manifest)
- `manifest.json` (repository root) → a verbatim copy of the plugin manifest, because the directory
  processes the manifest at the HEAD of the default branch

`scripts/check-release.ts` enforces this: with no argument it checks the versions agree and the root
mirror is identical to the plugin manifest (the CI step); with a tag it also checks they equal the
tag (the release preflight). A mismatch fails before anything is built. The root copy is never
edited by hand — copy the plugin manifest over it.

1. Bump all three package versions to the same value, for example `0.1.0` (replacing the snapshot),
   and copy the plugin manifest to the root: `cp packages/plugin/manifest.json manifest.json`.
2. Run `bun scripts/check-release.ts 0.1.0` and commit the bump. (A `v` prefix is accepted too,
   but the tag itself is the bare version — see below.)
3. Tag and push:

   ```bash
   git tag 0.1.0
   git push origin 0.1.0
   ```

The tag push starts `.github/workflows/release.yml`, which:

1. `preflight` validates the tag against the four version files and captures the version;
2. `verify` runs the same `bun run verify` and `bun run verify format` gates as CI;
3. `server`, `cli` and `plugin` build in parallel;
4. `release` downloads the three artifacts, checks every expected file, writes `checksums.txt`,
   attests every asset with `actions/attest-build-provenance` (SLSA provenance, which the community
   directory recommends and anyone can verify with `gh attestation verify`), creates a **draft**
   release, uploads the assets — the binaries, the plugin zip and the three files the Obsidian
   directory reads (`main.js`, `manifest.json`, `styles.css`) — then publishes it;
5. `cnb` (optional) mirrors the published assets to cnb.cool. It is skipped when the repository
   variable `CNB_REPO` is unset, and a failure there cannot fail the release. Only stable releases
   are mirrored; tags containing a hyphen (release candidates and snapshot builds) are skipped.
   The `latest` alias is updated only when GitHub reports the tag as the latest stable release, so
   re-running an old release does not move the stable download channel backwards.

The `cnb` job is a download mirror, not a second build: it uploads the same bytes, so the
manifests and `checksums.txt` verify either location. Setup, the stable URL and the failure modes
are in [cnb-mirror.md](cnb-mirror.md).

The release is created from the tag commit with generated release notes. Re-running a failed
workflow is safe: a draft release is completed, and an existing release has its assets replaced with
`--clobber`. A tag containing a hyphen (for example `0.1.0-rc.1`) is published as a prerelease, so
`releases/latest` keeps pointing at the latest stable release.

### The Obsidian community directory

The plugin is published from `ah-yu/courier`, a repository **generated** by
[`scripts/mirror-plugin.ts`](../scripts/mirror-plugin.ts) — see
[the publishing mirror](#the-publishing-mirror) below. The directory's rules therefore apply to that
tree, and this repository's release is what writes it:

- **The files it reads must be at that repository's root**: `README.md` (the public page whose excerpt
  the listing shows), `LICENSE`, and `manifest.json` — all three written by the generator, the last
  from `packages/plugin/manifest.json`, which stays canonical here.
- **Versions are `x.y.z` only, and the release tag is the version itself.** The directory does not
  accept the snapshot form (`0.0.0-dev.YYYYMMDD.<shortsha>`) or a prerelease tag such as
  `0.1.0-rc.1`, and the GitHub release tag must equal the manifest `version` exactly. That is why
  the tag carries no product `v`: `0.1.0` is both the tag and `releases/latest`, so the binary
  installers and the directory read the same release. A snapshot build or a prerelease is for
  testing; bump to a plain `X.Y.Z` before submitting a plugin release, and remember that the
  directory reads the manifest at the default branch's HEAD, so the bump has to be committed first.
- **The root manifest is a mirror, never a second source.** CI and the release preflight fail when
  it differs from `packages/plugin/manifest.json`; the release assets are still staged from the
  plugin manifest.
- **Manifest fields the directory reviews** (`scripts/check-release.ts` pins the mechanical ones):
  `id` is lowercase letters/digits/hyphens, unique across the directory, and neither ends with
  `plugin` nor contains `obsidian`; `description` is at most 250 characters, ends with a period and
  must not contain the word "Obsidian" (the directory rejects it as redundant);
  `minAppVersion` is the real minimum; `fundingUrl` exists only if the project accepts donations;
  `isDesktopOnly` is `false` only when no Node.js or Electron API is used.
- **The README carries the policy disclosures**: that an account on a self-hosted server is required
  for full functionality, and where the plugin's network requests go. The linked usage guide is
  [quick-start.md](quick-start.md).

#### The review scanner, mirrored

The directory's automated review scans the repository the plugin is published from with
`eslint-plugin-obsidianmd` and its own fixed ignore list, and it scans the release's `styles.css`
with Obsidian's Stylelint config. It does not read this repository's config; what it reads is the
[publishing mirror](#the-publishing-mirror), which holds only the three published packages.

[`eslint.config.ts`](../eslint.config.ts) reproduces the ESLint half and
[`stylelint.config.ts`](../stylelint.config.ts) the stylesheet half; `bun run lint:review` runs
both, as a default `bun run verify` gate. Both name their scope themselves rather than in the
command, so an editor's linter and the gate report the same files:

- the same rule set (`eslint-plugin-obsidianmd` / `stylelint-config-obsidianmd`, pinned in
  `package.json`);
- the directory's fixed ignore list, plus this repository's own: the packages the plugin is not
  published from (`server`, `cli`, `e2e`, `build`, `testing`) and the repository's tooling. Those
  are exactly the files the mirror does not contain, so the scan here covers the tree the directory
  will read;
- `--max-warnings 0`. The directory splits its findings into errors and warnings; this gate fails
  on both, which is stricter than the review — the three packages are clean of both, and the flag is
  what keeps them that way.

Three things must stay in step with the directory: the ignore list and `DIRECTORY_ERROR_RULES` in
the ESLint config, and the two plugin versions. The mirror cannot judge the directory's non-ESLint
checks (manifest, release assets, build verification) — `scripts/check-release.ts` owns the
manifest half, and the release workflow builds the assets.

Because that scan cannot be configured, the plugin is published from a repository that holds only
the plugin — [the publishing mirror](#the-publishing-mirror).

### The publishing mirror

`ah-yu/courier` is the repository the community directory points at. It is **generated**, not
developed in: `scripts/mirror-plugin.ts` writes it from `packages/plugin`, `packages/engine` and
`packages/shared`, and every release replaces it wholesale.

- **What it holds**: the three packages with their tests and `__mocks__` removed (the mirror runs no
  tests, and their `@courier/testing` imports name a workspace package that is not there), the
  plugin's `scripts/build.ts` and nothing else from `scripts/`, a generated root `package.json` and
  `bun.lock`, `manifest.json` at the root, the generated `README.md`, `LICENSE`, `.bun-version`,
  `tsconfig.base.json`, and one workflow: `release.yml`.
- **What it deliberately lacks**: a linter, a test runner, the installers, the docs. The review gate
  runs here over the same three packages (`bun run lint:review`), and the mirror's own scan is
  Obsidian's — duplicating either in the generated tree would be a second place to keep in step.
- **When it is written**: on a tag, before the product release, never on a push to `main`. The
  directory reads `manifest.json` from the default branch, so the released version must be the one on
  `main`; a generated commit carries it, and the tag points at that commit so build verification
  rebuilds the bytes that were released.
- **The copy is unconditional, and the version is asserted.** The push replaces the mirror's working
  tree with `rsync --ignore-times`, because rsync's default quick check is size plus mtime and a file
  whose only change is a version line keeps its size (`0.1.3` → `0.1.4`, `77adf9e` → `f1b335a`) — a
  shared timestamp second then skips it. Before pushing, the job reads the copied `manifest.json` and
  fails when it does not name the release version, so a stale manifest blocks the release instead of
  leaving a mirror that builds the previous plugin.
- **How the release triggers it**: the `mirror` job pushes `main` and then the tag to `ah-yu/courier`
  with a personal access token. The tag push is what starts the mirror's `release.yml` — `GITHUB_TOKEN`
  can neither write to another repository nor trigger a workflow with a push, so the token needs
  `contents: write` on the mirror and the `workflow` scope (the generated commit contains
  `.github/workflows/release.yml`). The job runs **before** the product release, so a mirror failure
  blocks it rather than publishing binaries for a plugin nobody can install.
- **Why it builds its own assets**: the mirror's workflow runs `bun install --frozen-lockfile` and
  `bun run build`, and attests what it produced. That is what makes the directory's build
  verification and artifact attestation checks describe this project rather than a copy of a build
  that happened somewhere else.

### Manual smoke check (L4)

The automated layers stop at "the values are right" — the stub records the DOM, it does not draw it.
Before a release, with a real Obsidian and a real vault, spend a few minutes on the parts only a
person can judge:

- open Settings → Courier and scroll the page, then the sync-history dialog: no section clipped, the
  title stays put while the list scrolls;
- hover a note in the explorer: the version-history chip appears and the file name truncates to make
  room for it; open the tab and click through two versions;
- park a conflict copy and open its comparison on a phone: one readable column, the replace
  confirmation reachable;
- open the status bar menu and the account-usage bars: every row at one label size, the bars filled
  but never past their track;
- switch Obsidian's UI language and repeat the two dialogs above — a translated string can be a line
  longer than its box;
- `bun run preview:ui` renders the settings page to a PNG when a screenshot says it faster than words
  (see [plugin-ui-preview.md](plugin-ui-preview.md)).

Anything that fails here becomes an `itL` case in `packages/e2e/src/obsidian/` (a rendered-geometry
assertion, reference platform only) or a plain bug — not a note that "it looked off once".

## Published assets

| Asset                                                                                                      | Consumer                                                          |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `courier-server-linux-x64`, `courier-server-darwin-arm64`, `courier-server-win-x64.exe` and each `.sha256` | the server deployment                                             |
| `courier-server-manifest.json`                                                                             | the server update check                                           |
| `courier-cli-linux-x64`, `courier-cli-darwin-arm64`, `courier-cli-win-x64.exe` and each `.sha256`          | headless `courier-cli`                                            |
| `courier-cli-manifest.json`                                                                                | the CLI install/upgrade check                                     |
| `main.js`, `manifest.json`, `styles.css`                                                                   | Obsidian plugin (manual install or BRAT)                          |
| `courier-plugin-X.Y.Z.zip`                                                                                 | manual install; contains a `courier/` folder with the three files |
| `checksums.txt`                                                                                            | verifying any binary before running it                            |

One release carries everything: the binaries, the plugin zip and the three files the Obsidian
directory reads (`main.js`, `manifest.json`, `styles.css`). Its tag is the bare version (`0.1.0`,
no `v`) — the tag the directory looks up — and it is `releases/latest`, so the install scripts and
the directory read the same release.

### The CLI manifest carries one asset per platform

`courier-cli-manifest.json` is generated by `bun run --filter @courier/cli manifest` after the
three compiled binaries exist. Its `assets` map is keyed by `win-x64`, `linux-x64` and
`darwin-arm64`; each entry carries the asset name, checksum and size. An installer
downloads this small file, picks its own platform, and verifies the binary's SHA-256 before
replacing anything. The server manifest cannot be reused because it describes exactly one
Linux x64 asset, which is the only target a deployment has.

### Linux binaries need nothing extra

Both binaries embed the Bun runtime, and Bun's Linux build is self-contained: it links glibc and
nothing else. The install table in [`docs/cli.md`](cli.md) therefore has no system-package step,
and an installer has no library probe or package install of its own.

### Why the server manifest is not `manifest.json`

An Obsidian plugin release must carry a file named exactly `manifest.json`, and the server installer
looks for the server update manifest beside the server binary. One GitHub release cannot hold both
under the same name, so the server manifest is `courier-server-manifest.json`. See
[`docs/cli.md`](cli.md#information-about-the-server-itself) for the contract.

The release address is built in: `https://github.com/ah-yu/courier.dev/releases/latest/download`. An
installer appends `/courier-server-manifest.json` itself. A deployment's address field and
`COURIER_SERVER_RELEASE_URL` / `COURIER_CLI_RELEASE_URL` override it for a mirror or a pinned
prerelease; the CLI install has no address field, so it always uses the built-in address (or that
environment override). The manifest describes the Linux x64 asset, which is the deployment target;
the macOS and Windows binaries are published with their own `.sha256` files.

### Moving the repository

The release address is compiled into installers, so renaming or transferring this
repository means updating their copy of the address and rebuilding them: an installed build keeps
the address it was compiled with. GitHub redirects the old
repository URLs for a while, and the resolver follows the extra API redirect a renamed repository
produces, so old builds usually keep working during the transition — but do not rely on it.
Redirects are permanently deleted if a new repository or fork is created at the old location, and a
fine-grained token scoped to the old owner may lose access after a transfer.
`COURIER_SERVER_RELEASE_URL` / `COURIER_CLI_RELEASE_URL` can point an existing build at the new
address until it is rebuilt.

### Private mirrors

This repository's releases are public, so the install scripts read the assets through the anonymous
`releases/latest/download` URLs. A mirror, or a pinned prerelease, is selected with
`COURIER_SERVER_RELEASE_URL` / `COURIER_CLI_RELEASE_URL`; an installer that needs a token for a
private mirror documents its own flow.

The repository also maintains a public CNB (cnb.cool) mirror of the same assets, with the stable
base `https://cnb.cool/<repo>/-/releases/download/latest`. Its setup, its versioned URLs and the
`latest` alias convention are in [cnb-mirror.md](cnb-mirror.md).

### Installing the Obsidian plugin

- **Manual:** download `main.js`, `manifest.json` and `styles.css` into
  `<vault>/.obsidian/plugins/courier/`, or unzip `courier-plugin-X.Y.Z.zip` into
  `<vault>/.obsidian/plugins/`, then enable Courier in Obsidian's community plugins.
- **BRAT:** add the repository and use the release; BRAT reads the flat `main.js`, `manifest.json`
  and `styles.css` assets.

## Checksums

Every binary is published with a `<asset>.sha256` file in the shape `sha256sum` writes, and
`checksums.txt` collects all of them:

```bash
sha256sum -c courier-server-linux-x64.sha256
sha256sum -c checksums.txt
```

The server manifest also carries the Linux x64 binary's `sha256` and `size`; an installer
uses that pair to decide whether the published build is the same one it already runs. The CLI
manifest does the same per platform.

## Failure modes

| Failure                                       | Result                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- |
| tag does not match the four version files     | `preflight` fails; nothing is built or published                                             |
| the root manifest differs from the plugin one | `check-release` fails in CI and in `preflight`; nothing is built                             |
| a gate fails (`bun run verify`, formatting)   | no build jobs start                                                                          |
| a binary, manifest, bundle or zip is missing  | the artifact upload or the release job fails; no publication                                 |
| an upload fails midway                        | the release stays a draft; re-run the workflow to finish it                                  |
| the repository token cannot write releases    | the `release` job fails; allow `contents: write` for Actions or use a PAT                    |
| the generated mirror keeps a stale manifest   | the `mirror` job's version assertion fails; nothing is published until it is re-run          |
| the CNB mirror fails (outage, token, quota)   | the `cnb` job is marked failed but allowed; the GitHub release is unaffected; re-run the job |
| an older release's CNB job is re-run          | only that version's release is updated; `latest` and CNB's latest flag stay with the newest  |

No extra secrets are required for the GitHub release itself; the `release` job uses the automatic
`GITHUB_TOKEN` and requests `contents: write` only there. The optional CNB mirror uses the
`CNB_TOKEN` secret (see [cnb-mirror.md](cnb-mirror.md)).
