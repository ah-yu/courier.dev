# CNB (cnb.cool) download mirror

Status: **implemented** 2026-10-31. GitHub remains the only build; the mirror stores and serves the
same release bytes from `cnb.cool`. The workflows are inactive until the repository variable
`CNB_REPO` is set; the platform behaviour below was probed on 2026-10-31 and must be re-checked
when CNB changes its API.

## The two questions

**Should the repository be mirrored to CNB and released twice, once per platform?**
No. A second build pipeline duplicates the version preflight, the verification gates, the
compiled-binary smoke tests, the manifests and the checksums; it produces a second set of bytes,
so the CNB manifests could not be used to verify a GitHub download or the other way round. It
also spends CNB build CPU (160 core-hours/month free) and still fetches Bun and npm from the
internet. If the goal is a faster download, building again is the expensive way to get it.

**Can only the GitHub release assets be mirrored 鈥?does the code have to move?**
The assets do not need the source tree, but a CNB release is attached to a Git tag, and a tag is
a ref in a CNB repository. The minimum is therefore a repository that holds the tag's commit. If
that commit is the real release commit, its tree is on CNB too 鈥?pushing a tag publishes the
source at that tag whether or not `main` is mirrored. Avoiding source entirely means creating the
tag at a placeholder commit, which throws away the provenance between the binary and the commit
it was built from.

For an open-source project the useful answer is the cheap one: mirror the real refs one way
(GitHub 鈫?CNB), and upload the GitHub-built assets as CNB release attachments. One build
pipeline, two download locations, identical `sha256` values.

## What is mirrored

Only a **stable** release is mirrored; a tag containing a hyphen is a prerelease and is skipped.
For a stable release, `release.yml` publishes these assets and the mirror uploads every one of them
unchanged:

| Asset                                                                                                       | Consumer                             |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `courier-server-linux-x64`, `courier-server-darwin-arm64`, `courier-server-win-x64.exe` and their `.sha256` | the server deployment                |
| `courier-server-manifest.json`                                                                              | the server update check              |
| `courier-cli-linux-x64`, `courier-cli-darwin-arm64`, `courier-cli-win-x64.exe` and their `.sha256`          | `courier-cli`                        |
| `courier-cli-manifest.json`                                                                                 | the CLI install/upgrade check        |
| `main.js`, `manifest.json`, `styles.css`                                                                    | the Obsidian plugin (manual install) |
| `courier-plugin-X.Y.Z.zip`                                                                                  | manual plugin install                |
| `checksums.txt`                                                                                             | verifying any binary                 |

The files keep their names. The server manifest is still `courier-server-manifest.json`: one CNB
release also carries the plugin's `manifest.json`, so the two cannot share a name there either.

## How the mirror runs

### Source: `sync-cnb.yml`

On every push to `main` (and by manual dispatch) the workflow force-pushes `main` to
`https://cnb.cool/<CNB_REPO>.git`. That keeps the CNB repository browsable and makes
`/-/git/raw/main/install.sh` and `install.ps1` available. It does not run a CNB pipeline: this
repository has no `.cnb.yml`, so CNB treats the push as a plain Git update. The job is skipped
while `CNB_REPO` is empty.

`sync-cnb.yml` is optional. If the source should stay off CNB, point `CNB_REPO` at a separate
public distribution repository and disable (or delete) `sync-cnb.yml`; the `cnb` job still pushes
the version tag there, so the release assets and their provenance URL work, while the repository
has no `main` branch. Keeping the source mirror costs no build time and makes the raw install
scripts available, which is why it is the default.

### Release: the `cnb` job in `release.yml`

The job runs after `release` in the same workflow, downloads the just-published assets with
`gh release download`, pushes the version tag, and calls `scripts/cnb-mirror.ts`, which creates
or updates the CNB release, uploads each file through the pre-signed upload API, confirms it, and
reads the release back to check size and `sha256`. A re-run is idempotent: an asset whose name,
size and hash already match is skipped.

The job is `continue-on-error: true` on purpose. A CNB outage or an expired token must not turn a
successful GitHub release red; the job itself is still visible as failed, and re-running it from
the release run retries the mirror.

It is **not** a separate `release: published` workflow because the release is created with
`GITHUB_TOKEN`, and GitHub does not start workflows from events that token triggers (the
exception is `workflow_dispatch` / `repository_dispatch`). A separate workflow would silently
never run. See [GitHub's automatic token
documentation](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication).

### The stable URL and the `latest` alias

CNB has no `releases/latest/download` equivalent. Its download route is:

```text
https://cnb.cool/<repo>/-/releases/download/<tag>/<asset>
```

so a version-pinned download is always available:

```text
https://cnb.cool/ah-yu/courier/-/releases/download/0.1.0/courier-cli-manifest.json
```

For a one-command install the release job also maintains a `latest` alias release. It is updated
only when GitHub reports the tag as the latest stable release (`releases/latest`), so re-running
an older tag leaves the alias alone. The `latest` tag is **moved** to that release on every stable
release: the alias page carries the current assets, and CNB builds its source-archive links from
the tag, so a tag left behind shows the current binaries beside an old source tree. It is a
download channel, not a version anybody pins to — use the versioned release when you need the
source tree that matches a binary.

```text
https://cnb.cool/ah-yu/courier/-/releases/download/latest/courier-cli-manifest.json
```

The alias is a convention, not a CNB feature. Set the `CNB_LATEST_ALIAS` repository variable to
`false` to skip the alias entirely. Only stable releases are mirrored: a tag containing a hyphen
(`0.1.0-rc.1`, `0.0.0-dev.<date>.<sha>`) is a prerelease and the `cnb` job is skipped. While
the alias is being updated its release is briefly a draft, so a reader sees the old channel or a
404, never a new manifest beside an old binary. The current versioned plugin zip replaces the
previous one; older zips are deleted from the alias.

The alias doubles the stored copy of each release. The free object-storage allowance is 100 GiB
for artifacts, LFS objects, images and attachments. A release is roughly 600 MiB (six compiled
binaries plus the plugin), so the allowance covers about 80 mirrored stable releases with the
alias, or twice that without it.

## Setup

1. Create a **public** repository at `https://cnb.cool/<group>/<repo>` (an empty repository is
   fine). Public visibility is required: the download route is anonymous.
2. Create an access token at `https://cnb.cool/profile/token`:
   - `repo-code: write` 鈥?Git client credentials, branches and commits (needed by the tag and
     `main` pushes; `write` already includes read, and `default` is not enough);
   - `repo-release: write` 鈥?create/update releases and upload attachments;
   - scope it to that repository and set an expiry.
3. In the GitHub repository settings, add:
   - secret `CNB_TOKEN` 鈥?the token above, used by both workflows;
   - variable `CNB_REPO` 鈥?`<group>/<repo>` without the `.git` suffix.

   The workflows read the variable; with it unset they are skipped rather than failing.

```bash
gh secret set CNB_TOKEN --repo <owner>/<repo>
gh variable set CNB_REPO --repo <owner>/<repo> --body "<group>/<repo>"
```

`gh secret set` without `--body` prompts with a hidden input, so the token does not land in shell
history. Never put it in the repository, an issue or the workflow file.

After the first `sync-cnb.yml` run, set the CNB repository's default branch to `main` (an empty
repository has no default history yet).

## Using the mirror

CLI, Linux or macOS:

```bash
curl -fsSL https://cnb.cool/<repo>/-/git/raw/main/install.sh \
  | COURIER_CLI_RELEASE_URL=https://cnb.cool/<repo>/-/releases/download/latest sh
```

CLI, Windows PowerShell:

```powershell
$env:COURIER_CLI_RELEASE_URL = "https://cnb.cool/<repo>/-/releases/download/latest"
irm https://cnb.cool/<repo>/-/git/raw/main/install.ps1 | iex
```

Both scripts read `courier-cli-manifest.json` from the same base, so the checksum check still
runs. `COURIER_CLI_RELEASE_URL` also accepts a pinned version:
`https://cnb.cool/<repo>/-/releases/download/0.1.0`.

Server deployment: set `COURIER_SERVER_RELEASE_URL` to the same base; the deployment appends
`courier-server-manifest.json`.

The Obsidian plugin is manual-only. Download `main.js`, `manifest.json` and `styles.css` (or
`courier-plugin-X.Y.Z.zip`) from the CNB release. BRAT and the Obsidian community plugin
directory address GitHub repositories, so they cannot consume the mirror.

## Verified platform behaviour (2026-10-31)

| Fact                                                                  | Evidence                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Public release assets download anonymously                            | on a public CNB repository, `GET .../releases/download/v0.9.9/<asset>` returned the file (302 to a signed URL)      |
| There is no anonymous `latest` alias                                  | `GET .../releases/download/latest/<asset>` returned `404 {"errcode":5,"errmsg":"release for tag latest not found"}` |
| The API requires authentication                                       | `GET https://api.cnb.cool/<repo>/-/releases/latest` returned `401`                                                  |
| Raw files and source archives are anonymous                           | `/-/git/raw/main/<file>` and `/-/git/archive/<tag>.zip` returned `200`                                              |
| Releases have create, patch, upload-url and confirmation endpoints    | `https://api.cnb.cool/swagger.json`                                                                                 |
| Uploads support `overwrite` and `ttl`; releases support `make_latest` | `PostReleaseAssetUploadURLForm`, `PostReleaseForm`                                                                  |
| `git:release` cannot upload attachments                               | the built-in step's documentation points at `cnbcool/attachments`                                                   |
| Free quota                                                            | 100 GiB object storage; 160 build core-hours/month                                                                  |

The signed `asset.cnb.cool` URL is time-limited; always request the `cnb.cool` route, never store
or publish the redirected URL.

## Failure modes

| Failure                                                       | Result                                                                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| CNB unreachable or times out                                  | the `cnb` job fails, the GitHub release stays published; re-run the job                              |
| `CNB_TOKEN` missing, expired or missing `repo-release: write` | 401/403 with the CNB `errmsg`; rotate or widen the token                                             |
| `repo-code: write` missing                                    | the tag push fails before any asset is uploaded                                                      |
| tag protected, force push refused                             | the job stops before uploading; fix the protection or publish a new tag                              |
| upload interrupted or the pre-signed URL expires              | the script retries, then re-run the job; uploads are idempotent                                      |
| no remote hash, or a hash/size mismatch                       | the script downloads and hashes the asset; any mismatch fails the job                                |
| the job fails mid-upload                                      | the version release stays a draft (or the alias stays hidden); re-run the job                        |
| an older release is re-run                                    | the alias and CNB's latest flag stay with the newest release; only that version's release is updated |
| prerelease tag                                                | not mirrored; the `cnb` job is skipped                                                               |
| object-storage quota exhausted                                | the upload fails; prune old releases or disable the alias                                            |
| repository renamed or made private                            | the anonymous download URLs break; update `CNB_REPO` and the documentation                           |
| a release is edited after publication                         | re-run the `cnb` job (or run the script manually)                                                    |

## Repairing a mirror by hand

The script is the only mover; it needs a token and the downloaded asset directory:

```bash
gh release download 0.1.0 --dir cnb-assets
read -rsp "CNB token: " CNB_TOKEN; echo
export CNB_TOKEN
bun scripts/cnb-mirror.ts \
  --repo <group>/<repo> --tag 0.1.0 \
  --target-sha "$(git rev-parse 0.1.0)" \
  --assets cnb-assets \
  --no-make-latest
```

`--no-make-latest` is the safe choice for an old release: it updates that version's release
without touching the `latest` alias or CNB's latest flag. Only when repairing the release GitHub
currently reports as latest, use `--make-latest --latest-tag latest`.

`--dry-run` prints the asset list and the plan without a token or a network call.

## Related

- [release.md](release.md) 鈥?the GitHub release procedure, assets and checksums.
- [cli.md](cli.md) 鈥?the install scripts and the `COURIER_CLI_RELEASE_URL` override.
