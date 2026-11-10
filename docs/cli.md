# Courier Headless CLI (`courier-cli`)

> **Status: current and authoritative.** This is the single source of truth for this CLI's
> commands, arguments and behavior; changes to the CLI must update this document in the same
> change. See `docs/README.md` for the documentation index.

> The CLI and the Obsidian plugin reuse the same TypeScript sync engine
> (`@courier/engine`); the CLI suits headless environments such as a VPS / NAS / local machine, and
> it keeps syncing while Obsidian is closed.

Like the server, `courier-cli` is packaged into a **single binary** with
`bun build --compile` (linux-x64 / darwin-arm64 / win-x64). The artifacts live in
`packages/cli/build/`:

```
packages/cli/build/courier-cli-linux-x64
packages/cli/build/courier-cli-darwin-arm64
packages/cli/build/courier-cli-win-x64.exe
```

Build: `bun run --filter @courier/cli build:exe`.

## Linux needs no extra system library

The binary embeds the Bun runtime, and Bun's Linux build is self-contained: it links glibc and
nothing else. A machine that can run `bash` can run the binary, and nothing installs a library
first — not `install.sh`, not any other application.

### Install scripts

`install.sh` (Linux and macOS) and `install.ps1` (Windows) at the repository root are how a machine gets the
binary without any other application; the public guide publishes their one-liners. Each one:

- picks the build for the machine — `linux-x64`, `darwin-arm64` (Apple Silicon only, an Intel Mac is
  refused) or `win-x64` — and refuses anything else, without installing anything else first;
- downloads the asset from `.../releases/latest/download` and checks it against the `sha256` for that
  platform in `courier-cli-manifest.json` (the check is skipped only when no hash tool exists);
- installs it as `~/.local/bin/courier-cli`, or `%LOCALAPPDATA%\Courier\bin\courier-cli.exe` with
  that folder added to the user `PATH` once;
- is safe to re-run: it replaces the binary and leaves the configuration, bindings and sync state
  alone.

`COURIER_CLI_RELEASE_URL` points either script at a mirror or one fixed release, `COURIER_CLI_BIN_DIR`
at another install directory, and `COURIER_CLI_NO_PATH=1` skips the Windows `PATH` change. Both derive
what they verify from the release manifest, not from a version string, so a re-run over the same
release is a no-op and an interrupted download is refused instead of installed.

The Linux artifacts are glibc builds; an Alpine (musl) host is not a supported target. A
cross-build on macOS or Windows produces the Linux binary too; it just cannot verify it without
a Linux host. That is what the release workflow (Ubuntu) is for.

A release also publishes `courier-cli-manifest.json` beside those binaries
(`bun run --filter @courier/cli manifest`). Unlike the server manifest — Linux x64 is the only
deployment target — one CLI release serves three platforms, so the manifest carries an
`assets` map keyed by the release's platform id:

```json
{
  "version": "0.2.0",
  "publishedAt": "…",
  "notes": "…",
  "assets": {
    "win-x64": { "asset": "courier-cli-win-x64.exe", "sha256": "…", "size": 95790080 },
    "linux-x64": { "asset": "courier-cli-linux-x64", "sha256": "…", "size": 129063976 },
    "darwin-arm64": { "asset": "courier-cli-darwin-arm64", "sha256": "…", "size": 131529280 }
  }
}
```

The checksum identifies a build; the version decides whether it is newer. An
installer verifies both before replacing anything, and refuses an asset whose checksum is
missing.

## Concepts

- **Single user key (`ck_...`)**: all of one user's clients share one key, created and authorized
  by the server host (validity period / storage quota / history retention).
- **Device name (`deviceName`)**: the display label this machine **self-reports** on every push,
  written into the sync history. The server **has no concept of devices**: no registration, no
  `deviceId`, no revocation; the name can change at any time, and after a change new versions carry
  the new name while old versions keep the old name.
- **Multiple vaults, one process each**: `vault connect` adds a binding, and every binding is
  synced by its own `run --vault <id>` process. Bindings share the server, user key and device
  name but have independent scope, state, runtime and log.
- Configuration lives in `~/.courier-cli/config.json`; each vault's sync state is
  `~/.courier-cli/state/<vault>.json` (with the bind's completion record beside it as
  `<vault>.bind.json`) and its daemon record is `~/.courier-cli/runtime/<vault>.json`. The
  directory is overridable with `COURIER_CLI_CONFIG_DIR`.

## Language

- Human-readable output follows the **operating system language** by default: Chinese systems
  display Chinese, other systems display English.
- `--lang zh|en` or `COURIER_LANG=zh|en` overrides this; precedence is `--lang` > `COURIER_LANG` >
  system language. `--lang` may appear before or after a subcommand and also accepts `--lang=en`.
- Invalid values for `--lang` / `COURIER_LANG` cause an immediate error exit; when the system
  language cannot be recognized, English is used.
- Machine fields such as `--json` field names, `fileTypes` ids, and paths do not change with
  the language.
- Daemon logs also choose their language by the same rules; systemd can pin it with
  `Environment=COURIER_LANG=en` (or `zh`).
- The plugin has no language switch: it follows Obsidian's interface language (Chinese → Chinese,
  anything else → English).

## The CLI's own identity

The binary can say which build it is, without reading a file beside itself or reaching the
network:

```bash
courier-cli version [--json]
```

`--json` reports `{ "version", "gitSha", "buildTime", "runtime" }`. The values are baked in by
`bun build`'s `--define` at build time (the same mechanism the server uses), and a development build
reports `dev`. This identifies a **local** build, which has no release
manifest to read; a downloaded build is identified by the manifest instead.

## Information about the server itself

Besides the sync API, the server binary (`courier`) also provides a read-only command, which
tells which build is installed on the server:

```bash
courier version [--json]
```

`--json` outputs `{ "version", "gitSha", "buildTime", "runtime" }`. These values are injected at build
time by `bun build`'s `--define` (`COURIER_VERSION` / `COURIER_GIT_SHA` / `COURIER_BUILD_TIME`); builds
without them report `dev`.

The server has **no** CLI command for querying its own runtime state; storage usage,
user/device-name/vault counts and migration counts are all answered over HTTP:

```bash
GET /api/admin/status
```

`{ storageUsedBytes, storageLimitBytes, dbBytes, diskTotalBytes, diskUsedBytes, diskFreeBytes, binarySha256, binarySize, blobCount, usersCount, devicesCount, vaultsCount, migrationsApplied, migrationsKnown, version }`
(see `docs/api.md` §7c) — host credentials already have to go through this channel, so a
management client does not need to open a separate SSH command for the same numbers.

- `migrationsApplied` / `migrationsKnown` are "the number recorded in the database" and "the number
  this binary carries". An upgrade compares the two: when the database is
  newer than the binary, it will not overwrite it with an older build.
- **No `uptime`**: the process can report its own uptime (`GET /api/admin/runtime`), while "whether
  the service is running, how long it has been running, and why it stopped" belongs to systemd and
  is answered over SSH (`systemctl --user show`).

When publishing a release, place `courier-server-manifest.json` next to the binary (generated by
`bun run --filter @courier/server manifest`, together with `<asset>.sha256`). It is deliberately not
named `manifest.json`: the same release also ships the Obsidian plugin, whose manifest must keep
that name. The manifest looks like:

```json
{
  "version": "0.2.0",
  "asset": "courier-server-linux-x64",
  "sha256": "…",
  "size": 135266304,
  "publishedAt": "…",
  "notes": "…"
}
```

The checksum decides "is this the same build", while the version number only decides "which is
newer" — these are the two criteria for an upgrade, and neither can be
omitted.

A **manual** server install needs no extra package either: the server binary
embeds Bun and links only glibc, exactly as the CLI does. See
[release.md](release.md#linux-binaries-need-nothing-extra).

The release address is built in (`.../releases/latest/download`), and this repository's releases
are public, so the scripts read the assets through the plain download
URLs. `COURIER_CLI_RELEASE_URL` points the scripts at a mirror or a pinned release. What a
repository move means for an installer is in
[release.md](release.md#moving-the-repository).

The complete release workflow (CI, tagging and published assets) is in [release.md](release.md).

## When the CLI and the server are different versions

A release ships the CLI and the server together, but a machine upgrades them at different
times. Before `run`, `vault connect` and `vault create` touch anything, the CLI asks
`/api/health` which contract generation the server speaks and compares it with its own
([api.md](api.md#contract-generation)):

- **the server is older** than this CLI can use — including a server built before the check
  existed — the command prints one line naming the server's version and exits with **`78`**;
- **this CLI is older** than the server still serves, the line says to update `courier-cli`
  instead, and the exit code is the same;
- anything else works: an older CLI keeps syncing against a newer server, because an
  additive release does not move the server's floor.

Nothing is left half-done: no vault is created, no binding is written, and the daemon does
not take the vault lease before the check, so the plugin is never blocked by a CLI that is
about to exit.

`78` is `EX_CONFIG` from `sysexits.h`, and it is distinct on purpose: a supervisor that
restarts on any failure would loop forever over a mismatch nobody is fixing. The service
unit in [Service setup](#service-setup-systemd-user-service) therefore carries
`RestartPreventExitStatus=78`.

A server that cannot be reached is **not** this case: it stays the ordinary "cannot reach"
error and keeps its retry path.

## Commands

### Save this machine's sync configuration

```bash
courier-cli register --server https://vps.example.com --user-key ck_xxx -n "NAS"
```

Write the server address, user key and device name (`-n` / `--name`), and validate the key with one `GET /api/vaults`
(a wrong key fails here immediately instead of waiting until the first sync). For the same server it
is idempotent: running it again only updates these values and preserves **every** existing vault
binding and its sync state. A **different server** clears all bindings, the cached vault keys and
their per-vault state — those belong to that server's database — while the device-local scope
(file types, exclusions) is per binding; run `vault connect` again for each vault.
It registers nothing with the server.

`--server` is the server address itself: a deployed service uses HTTPS (a deployment
automatically requests and renews a Let's Encrypt certificate for the server's public IP
or domain; the service listens on 8443 by default, so the address usually carries `:8443`), while a
local development service is `http://localhost:3002`. The WebSocket address is derived from it
(`http`→`ws`), so `https://…` connects to `wss://…` with no separate configuration.

### Log out of this machine

```bash
courier-cli logout
```

Removes the stored server address, user key and **every** vault binding, together with each
binding's state file; the vault keys go with the config. Local files and the content on the
server are not touched. Stop the daemons first: a running process keeps syncing from the state
it already loaded (a supervisor stops them before it calls this).

### Bind a remote vault to a local directory

```bash
courier-cli vault connect --id <vaultId> --path /mnt/vault --password <pw> \
  --device-name "工作电脑"
# Or: COURIER_VAULT_PASSWORD=<pw> courier-cli vault connect --id ... --path ...

# File types: images/audio/video/PDF sync by default; here keep only md and canvas
courier-cli vault connect --id <vaultId> --path /mnt/vault --sync-file-types=

# Sync only images and PDF, and additionally turn on "all other file types"
courier-cli vault connect --id <vaultId> --path /mnt/vault \
  --sync-file-types images,pdf --sync-other-types

# Exclude two folders (comma-separated; --exclude-folders= clears the saved list)
courier-cli vault connect --id <vaultId> --path /mnt/vault \
  --exclude-folders private,drafts

# Keep 500 versions of notes and canvas, 5 of every other file, for the vault
# (defaults: 200 / 10; the value is the vault's, shared with its other devices)
courier-cli vault connect --id <vaultId> --path /mnt/vault \
  --history-limit-documents 500 --history-limit-attachments 5
```

`--device-name` is the label **this binding** stamps on the versions it pushes — it is per
vault, not per machine, so two bindings on one computer can state different names. Omitting it
keeps the binding's current name (on an update) or falls back to the machine name that
`register` saved; `device rename` only changes that fallback. A supervisor always asks
for a name and never defaults it.

Binding also stores the vault's **server name** (`vaultName`) in the local config, so the
daemon's own start log and `status` say "工作笔记" rather than the local folder's name; a
supervisor reads the same field for its list.

The command takes **no settings-sync flag**: Obsidian's config folder is not part of a headless
machine's sync (see [Which files sync](#which-files-sync)). Settings sync belongs to the plugin —
the only client with an Obsidian to read them.

Derive and **persist locally** the raw AES key (the same approach as the plugin's
`.courier/remote.json`), so `run` needs no password afterward.

This command **adds or updates one binding**. Run it once per vault; the bindings are stored in
`~/.courier-cli/config.json` as a list, and each gets its own state file under
`~/.courier-cli/state/`. A local folder belongs to exactly one vault: the command refuses a path
that is the same as, or inside, another binding's folder.

```bash
courier-cli vault connect --id <vaultB> --path /mnt/vault-b --password <pw>
courier-cli vault disconnect --id <vaultB>   # removes the binding and its state
```

`vault disconnect` does not stop a running process; stop that vault's `run` first (a supervisor
does so automatically). The local files are never touched.

### Create a remote vault and bind it

```bash
courier-cli vault create --name "工作笔记" --path /mnt/vault --password <pw> \
  --device-name "工作电脑"
# One machine-readable line for a supervisor: {"id":"…","name":"工作笔记"}
courier-cli vault create --name "工作笔记" --path /mnt/vault --json
```

Creates the vault on the server and binds the folder in one step, so a machine that will never
open Obsidian can start from nothing. The encryption salt and the key-check canary are derived
here from the vault password, with the engine's own derivation, so the vault the CLI creates is
one the plugin (or another machine) can connect to with the same password; the server stores
metadata only. The scope flags are the ones `vault connect` takes, and so is `--device-name`.
A folder that already belongs to another binding is refused **before** the vault is created, so a
failed run leaves nothing behind.

### Change a binding's name or scope

```bash
courier-cli vault update --id <vaultId> --device-name "家里的电脑"
courier-cli vault update --id <vaultId> --sync-file-types images,pdf --exclude-folders private
courier-cli vault update --id <vaultId> --history-limit-documents 500 --history-limit-attachments 5
```

Edits the stored binding in place: no vault password (the key is already on this machine), no
folder change (that would move what the binding means — disconnect and connect again instead),
and the new name applies to the next push. A scope change takes effect when the vault's
daemon restarts: the engine reads the scope when its host is built.

### Multiple vaults: one process per vault

A single CLI process syncs **one** vault. Running three vaults means three processes:

```bash
courier-cli run --vault <vaultA>
courier-cli run --vault <vaultB>
courier-cli run --vault <vaultC>
```

`run` (and `run --once`) without `--vault` works only while exactly one vault is bound; with more, it
refuses and names the flag instead of guessing. Each process has its own file watcher, WebSocket,
state file, runtime record and log, so starting, stopping or failing one vault cannot affect
another. `status` lists every binding with its own daemon; `status --vault <id>` narrows it.

A supervisor starts one child process per vault and gives each row its own start/stop, log and
status — equivalent to the three commands above.

## Which files sync

**Markdown (`.md`) and Canvas (`.canvas`) always sync and cannot be disabled** — they are the vault
content itself. The rest are grouped into categories officially supported by Obsidian, each
switchable per device:

| File type    | Extensions                                                                           | Default |
| ------------ | ------------------------------------------------------------------------------------ | ------- |
| `images`     | `.avif` `.bmp` `.gif` `.jpeg` `.jpg` `.png` `.svg` `.webp`                           | On      |
| `audio`      | `.flac` `.m4a` `.mp3` `.ogg` `.wav` `.3gp`                                           | On      |
| `video`      | `.mkv` `.mov` `.mp4` `.ogv` `.webm`                                                  | On      |
| `pdf`        | `.pdf`                                                                               | On      |
| `otherTypes` | Everything else (`.base` databases, `.excalidraw`, archives, extensionless files, …) | **Off** |

Rules:

- `--sync-file-types=<list>` **replaces** the saved record (`--sync-file-types=` empty list = sync
  only md and canvas; bare `--sync-file-types` = the four defaults); `--sync-other-types` only
  **appends** `otherTypes`.
- Each extension **belongs to exactly one category**: `.webm` is video (Obsidian lists it under both
  audio and video).
- Turning off a type ⇒ this machine **neither pushes nor pulls** that type (no conflict copies, no
  files deleted on either side); turning it back on resumes syncing.
- A single file's **size cap** is not a CLI setting: an administrator configures it per user key on
  the server (default 50 MiB, `0` = no limit). `register`, `vault connect`, `run` and `status` all
  read the current value via `GET /api/me`; files over the cap are **skipped on both ends**, `run`'s
  logs list each one, and `status` lists them too. The engine reads a file whole to hash it (and
  encrypts it in one buffer below the chunk threshold), so this cap still protects a phone or a small
  machine; a file above 8 MiB is transferred in 4 MiB chunks, which bounds the transfer buffers but
  not that one plaintext copy. Measured on a 50 MiB file: the upload's bind peak is about 3.3× its
  size (167 MiB) and max RSS about 6.2× (309 MiB), down from 9×/11× before chunked transfer; a
  download peaks below 1× (47 MiB).
- Everything inside dot-directories (`.trash/`, `.git/`, etc.) is out of scope, and `*.conflict.*`
  conflict copies never participate in sync. `.obsidian/` is out of scope too, but for its own
  reason: this client never enables a config-folder group (see below), so the folder's contents are
  owned by settings groups that are all off rather than by the dot-folder rule.

### Excluded folders (this machine)

`--exclude-folders=<paths>` removes folders inside the vault from **this machine's** sync scope:
anything whose path equals an exclusion or starts with `exclusion/` is neither pushed nor pulled,
and no conflict copy is produced. Comma-separated; `--exclude-folders=` clears; omitting the flag
preserves the saved list. Exclusions apply only to the vault itself; the config folder is not part
of this client's sync at all (see below).

Rules:

- **Exclusion is not deletion**: content already synced to the server does not disappear because of
  a local exclusion, and this machine does not delete those files either. After re-running
  `vault connect` and removing the exclusion, pushing/pulling resumes from the locally saved sync
  state, and newer remote edits and deletions are applied as usual.
- `*.conflict.*` files previously parked inside an excluded folder are still listed by `status`
  (conflict files may predate this exclusion).
- Paths are case-sensitive and matched by `/` segments: excluding `notes` excludes
  `notes/deep/a.md` but not `notes2/a.md`.
- After changing the exclusion list, restart `run` (the scope is read once when the daemon starts).
- The CLI's `fs.watch` can only see "delete + create" and cannot report a rename as a pair the way
  Obsidian does; if a synced file is moved into an excluded folder while the daemon is running,
  when the old path disappears the engine looks for a unique file in the excluded folder with the
  **same name + same content**, and if found records it as a move (no tombstone is pushed).
  Therefore, renaming and then moving (so the same-name condition no longer holds) is still treated
  as a deletion; configuring the exclusion first and then moving files is safest. Moves that occur
  while the daemon is stopped go through the same determination during the full scan at startup.

### Version history kept on the server

How many versions of each file the **vault** keeps is server-side state, shared by every device of that
vault. The CLI edits it through `vault connect`, `vault create` and `vault update`; the flags become a
`PATCH /api/vaults/:id`, so the value applies to every device (including one that never ran the
command) and a lowered value also trims the histories already stored.

| Kind                                | Default | Flag                              |
| ----------------------------------- | ------- | --------------------------------- |
| Markdown notes and Canvas files     | 200     | `--history-limit-documents <n>`   |
| Every other file (images, audio, …) | 10      | `--history-limit-attachments <n>` |

- A limit is a whole number of versions from 1 to 10000; anything else is refused rather than
  clamped, because `0` would read as "keep only the current version".
- Each flag states only its own half of the vault's record; omitting both keeps what the vault has.
  `status` prints both values (or says they could not be read), and `vault connect` / `vault update`
  print them after a write.
- Nothing about the limits is stored in this machine's config: a binding does not carry them, so two
  machines bound to the same vault cannot disagree, and a hand-edited `config.json` cannot override
  the server.
- Trimming is separate from an account's `retentionDays` age window (an administrator's setting), and
  the versions a vault prunes are not recoverable afterwards.
- The blob of a pruned version is reclaimed only when no remaining version row references it, so
  two files holding the same bytes do not lose them from one file's trim.

### Obsidian settings (the config folder) — the plugin's job

The Obsidian **plugin** syncs the config folder in ten independent groups (main settings,
appearance, themes, snippets, hotkeys, core plugins, core-plugin settings, the community plugin
list, installed community plugins, and other files). That is a per-device choice on its settings
page, and the plugin is the only client that can apply a setting and tell the user a reload is
needed; [sync-scope.md](sync-scope.md#settings-groups) owns the groups and their rules.

The **CLI has no settings sync at all**: `vault connect` takes no flag for it, `run` neither pushes
nor pulls anything inside the config folder, and `status` reports no settings scope. A headless
machine has no Obsidian to read those files, and the one rule that settles a config-folder conflict —
newest modification time wins, silently, with no copy — would let a stale copy overwrite the
settings on the devices that do read them. `.obsidian/` is therefore a plain dot-folder for this
client; the engine's hard exclusions still apply, so `plugins/courier/**` (this device's credentials)
never travels even when another client syncs that folder.

### Continuous sync (daemon)

```bash
courier-cli run --vault <id>              # One process for one vault
courier-cli run --vault <id> --once       # Run a single reconcile and exit
courier-cli run --vault <id> --take-over  # Take the vault from its current writer instead of waiting
courier-cli run --vault <id> --interval 60  # Custom full-reconcile interval (minutes)
courier-cli run --vault <id> --interval 0   # Disable periodic reconcile (events + reconnect only)
```

`--vault` may be omitted only while exactly one vault is bound. To sync three vaults, start three
processes (systemd: three user units, or one unit with three `ExecStart` lines is **not** enough —
each line needs its own `Type=simple` process; the template below is per vault).

`--interval` accepts only non-negative numbers: a malformed value (`5m`, an empty string, a negative
number) exits with an error instead of being treated as "off" — the periodic reconcile is the only
fallback for a headless machine (the server keeps no backlog for subscribers, so pushes missed while
offline are not resent), and silently turning it off is a failure the user cannot notice. `0` is the
only spelling that means off.

**Stopping with its supervisor.** A process that should not outlive whatever started it says so with
`COURIER_DAEMON_SUPERVISED=1`: `run` then watches stdin and treats EOF — or the pipe closing — the way
it treats `SIGTERM`. It drains, releases the lease, clears its runtime record and exits. The desktop
app starts every daemon that way and keeps its end of the pipe open for as long as it runs, so a
quit, a crash or a force-kill of the app stops its daemons too. macOS is the case that needs it: a
child there is only reparented to launchd, so the pipe closing is the one way a daemon hears that its
supervisor is gone. The variable is opt-in on purpose — a terminal `run` with stdin redirected to
`/dev/null` reads EOF at once, and a daemon must not stop because nothing is on its stdin. Without it,
`run` ignores stdin entirely.

Behavior: scan local syncable files (md/canvas and the enabled file types, excluding conflict
copies; the config folder is never part of this scan) → full reconcile (push/pull/conflicts) → watch
local file events for incremental pushes → subscribe to remote changes over WebSocket and pull. There
is **no settings poll**: it exists for a host whose config folder is outside its vault index, and the
CLI syncs no settings. Vault-file conflicts are **exactly the same as on the plugin side**: the
remote version wins, and the local copy is written to
`{stem}-YYYY-MM-DD-HHmmss.conflict{extension}` (`-2`, `-3` are appended only for another conflict
within the same second; md remains `.conflict.md`, while an image becomes `.conflict.png`, so
Obsidian can still open it); each conflict logs one line, and `status` lists the conflict files
parked in the vault. Conflict files **do not participate in sync**, so the daemon leaves a trace
only on this machine. Files over the administrator-configured size cap are neither pushed nor
pulled, `run`'s logs list each one, and `status` lists them too. A pass over a large vault logs
`Syncing: {done} of {total} files ({percent}%)` once per tenth (the engine's `onProgress`), so a
first connect of tens of thousands of files shows that it is working rather than going quiet; a pass
that has to wait out the server's rate limit logs how long before it continues. The daemon's own
record (`~/.courier-cli/runtime/<vault>.json`) carries the same counter as `progress {done,total}`,
plus `firstSync` when no bind has ever **completed** for the vault on this machine — that is what a
supervisor's row reads, and why it can say "首次同步 12%" without calling every restart a first sync.
A bind killed after persisting part of a large vault leaves state behind; the completion record is
what keeps the next daemon's pass a first sync anyway.

**Run history.** The daemon also writes the engine's activity events — the same
`onSyncActivity` stream the plugin's history dialog shows from memory — as one JSON line per
event under `~/.courier-cli/history/<vault>.jsonl` (the vault id hashed the same way as the
state file, so an id from the server cannot escape the directory). Each decision is recorded
once per run (the plugin's log de-duplicates the same way), the file is cleared when a run
first gets the vault, so it describes **this run** only, and it is rotated to the last 500
lines past 2 MiB. A supervisor's 「同步历史」 view reads it; `status` does not, and
nothing in the sync path depends on it — a write failure is ignored.

### Running while Obsidian has the same vault open

The Obsidian plugin and one vault's CLI process run the **same engine against the same local
folder**. If both are active, they decide from separate snapshots and race: conflict copies at
best, a lost write at worst. **Observation is not enough** — a file change arrives after the other
host may have started, and a config file can be read half-written — so both sides take the same
per-vault lease:

```text
<vault>/.courier/sync-lease/
  owner.json      # written once, on acquire
  <token>.hb      # rewritten by renewal
```

- **Acquire before the engine exists.** A host calls `mkdir(".courier/sync-lease")`, which is
  atomic on the filesystems both clients support. Only one `mkdir` wins. A loser waits without
  building an `SyncHost`; it produces no sync traffic.
- **Renew every 5 seconds, expire after 20.** Renewal rewrites only the heartbeat file named
  for the holder's token, never `owner.json`. A holder suspended past the TTL can therefore
  come back and write its old heartbeat into a directory a contender has taken over, but it
  cannot replace the new owner record; the renewal reads the owner back and stops the host if
  it no longer matches. A stale directory is renamed aside first so two contenders cannot both
  delete and recreate it.
- **A record whose process is gone is stale at once, not after the TTL.** The record names the
  holder's pid and the machine that wrote it, so a pid no process holds **on that machine** proves
  nobody is renewing, whether the holder was the CLI or the plugin. A stop is not always a clean
  exit: a SIGKILL, a crash, and Obsidian quitting without waiting for the plugin's asynchronous
  release all end the process with no `release()`. A supervised daemon does release on its way out
  (the pipe closing is one of its stop paths, and it drains first), but the rule above must hold
  for the exits nothing can observe. Waiting out the TTL would keep reporting a process that no
  longer exists as the writer — for the page, for the other application that wants the vault
  (closing Obsidian hands it to a waiting CLI at once), and for the user who restarts the same
  vault. A plugin lease belongs to the renderer that wrote it and dies with that window or the
  app, so its pid is evidence in the same way. Expiry remains the clock for a reader on another
  machine or without a process table.
- **First come, first served — no application has priority.** The lease is acquired before an
  engine exists and is held until that writer stops. If the CLI holds it and Obsidian opens, the
  plugin waits; the CLI keeps syncing. If the plugin holds it and the CLI starts, the CLI waits.
  Whoever took the lease first continues until it releases; the other side never assumes ownership
  just because it is the Obsidian plugin or the CLI.
- **One deliberate exception: a person can take the vault back.** While the plugin is waiting, the
  status-bar menu offers **接管同步** (`SyncLease.takeOver()`): the plugin renames the holder's
  lease directory aside and writes its own record — the same atomic step `acquire()` uses for a
  stale directory — because a writer whose process the user cannot find must not lock their own
  vault for good. The previous holder is **not** killed; it stops when it next reads a record that
  is not its own — within milliseconds through the lease-directory watcher, or at the next renewal
  (≤5 s) where no watcher is available — and a pass already in flight there finishes first, so the
  two can overlap briefly. The confirmation names the holder (owner, pid, host) and says that
  before anything is taken; nothing else triggers it. The headless equivalent is
  `courier-cli run --take-over` (see below).
- **The holder watches the directory; the renewal still owns freshness.** While a host holds the
  lease it keeps a watcher on `<vault>/.courier` (the CLI's `fs.watch`; the plugin's desktop
  adapter — mobile has none and falls back to the timer). An event triggers a **read-only**
  ownership check (`SyncLease.stillOwner()`), so a takeover stops the old writer in milliseconds
  instead of at its next tick. The event never renews: the five-second renewal is what keeps the
  holder's own record fresh for every other reader, and a watcher that wrote would be woken by its
  own heartbeat. A missed event therefore costs one renewal period, never correctness.
- **Release only after the engine drains.** CLI `run` stops new work, waits for an in-flight pass
  via `SyncHost.whenIdle()`, then releases; `run --once` releases after its pass. The plugin does
  the same in `stop()` (pause, disconnect, unload) and keeps renewing while it drains.
- **No observation-based parking.** The CLI no longer reads `obsidian.json` / plugin `data.json`
  to decide whether to pause; that observation remains only in `status` as context. A process
  that cannot take the lease **because another writer holds it** waits and retries, building no
  engine and producing no sync traffic.
- **A lease filesystem error is not a lock conflict.** If creating or reading the lease fails
  (a permission error, a full disk, a `.courier` path that is a file), the CLI reports
  `cli.error.leaseFailed` and exits non-zero instead of entering `waiting`/`other-writer`;
  `run --once` reports the same error. Waiting would hide the failure forever.
- **The waiter wakes on the directory event.** While waiting, the CLI watches `<vault>/.courier` with
  `fs.watch`; the plugin watches the same directory through the same `fs`. Removing the lease
  wakes the waiter immediately. A 500 ms timer is the fallback for a filesystem that reports no
  event (and the only path on mobile, where the plugin has no filesystem watcher).
- **`run --take-over` is the headless takeover.** Refused once, the process prints who held the
  vault (owner, pid, host), takes it, and starts syncing; `--once` uses it instead of failing with
  `syncLocked`. It asks **once**, on the first refusal: a refused takeover (a rename the filesystem
  did not allow, or another takeover that landed first) is reported and the process then waits like
  any other, because retrying on the wait cadence would turn two `--take-over` daemons into a
  takeover fight. It is never implicit — a supervisor's unit must ask for it.
- Other vaults have their own lease path and processes; they are unaffected.
- `run --once` refuses if the lease is held by anyone else (the plugin or another CLI), with
  `cli.error.syncLocked` — unless `--take-over` is given.
- A waiting process records `phase: "waiting"`, `reason: "other-writer"` in its runtime file;
  `status` reports the lease owner and a supervisor's page labels the row **等待其他同步**.

The lease is implemented once in `@courier/engine` (`lease.ts`), with a filesystem store in
the CLI and an Obsidian `DataAdapter` store in the plugin. It is per-vault, so a supervisor
and the plugin stay correct even when neither observes the other.

### Check status

```bash
courier-cli status                     # Every bound vault, with its own process and conflicts
courier-cli status --vault <id>        # Only one vault
courier-cli status --json
courier-cli device rename "NewName"    # Only changes this machine's self-reported display label; no network
```

Device names are normalized (trimmed, truncated to 100 characters, an empty value falls back to
`My Device`), using the same rule as the plugin and the push frame header (`normalizeDeviceName` in
`@courier/shared`). A binding's own `--device-name` wins over `device rename`, which now only
changes the machine-wide fallback (and what a new binding without a flag records); set a bound
vault's name with `vault update --id <id> --device-name <name>`. A running daemon reads the
binding's name from the config file **on every push**, so a name change applies without a restart.

The `Device` line inside each vault block (`deviceName` in that vault's summary) is the label
that binding stamps on its pushes — its own `--device-name` when it has one. The header's
`Device` is the machine-wide default (`register` / `device rename`), used by a binding that
never set its own.

The `File types` line (`fileTypes` + `maxFileBytes` fields) reports the enabled file types and the
administrator-configured size cap, the `History` line (`historyLimits` field) reports how many versions
of each file the **vault** keeps on the server (`null` when the server could not be read, and the line
says so), and the `Excluded` line (`excludedFolders` field) reports the folders excluded on this
machine, for example (English output):

```
File types:  md, canvas, images, video, audio, pdf, otherTypes (max 50 MB, admin-set)
History:     notes/canvas 200, attachments 10
Excluded:    private, drafts
Conflicts:   (none)
```

When no folders are excluded it displays `(none)`; the `Too large` line appears only when files
actually exceed the cap — a headless machine has no UI, so this is the only place the user can tell
why "that video didn't sync over".

When this CLI and the server speak different contract generations
([above](#when-the-cli-and-the-server-are-different-versions)), the header gains one row and
`contractIssue` is set in `--json`:

```
Server:    https://vps.example.com:8443
Device:    NAS
Vaults:    1
Contract:  this server (0.6.0) is older than this CLI (0.7.0) can use — upgrade the server
```

It is read on the same trip that fetches the account's file cap, so it costs nothing extra, and an
unreachable server simply leaves the row out. This is where a supervisor or a person finds out why
the daemon keeps exiting: a process that stopped for this reason leaves no runtime record behind.

`status --json` is a **list** built from one read per binding, because each vault has its own
process. It is stable machine data, and a supervisor reads it verbatim:

```json
{
  "serverUrl": "https://vps.example.com:8443",
  "deviceName": "NAS",
  "contractIssue": null,
  "vaults": [
    {
      "vaultId": "vault-a",
      "vaultPath": "/mnt/vault-a",
      "hasState": true,
      "fileTypes": ["images", "video", "audio", "pdf"],
      "maxFileBytes": 52428800,
      "historyLimits": { "documents": 200, "attachments": 10 },
      "excludedFolders": ["private"],
      "oversizeFiles": [],
      "conflictFiles": [],
      "daemon": {
        "running": true,
        "pid": 4242,
        "startedAt": "2026-10-21T08:00:00.000Z",
        "updatedAt": "2026-10-21T08:01:00.000Z",
        "phase": "waiting",
        "reason": "other-writer",
        "lastActivityAt": "2026-10-21T08:00:59.000Z",
        "lastError": null
      },
      "lease": {
        "version": 1,
        "owner": "plugin",
        "token": "plugin-…",
        "pid": 0,
        "acquiredAt": "2026-10-21T08:00:00.000Z",
        "updatedAt": "2026-10-21T08:01:00.000Z",
        "expiresAt": 1787904120000
      },
      "coexistence": {
        "obsidianOpen": true,
        "pluginSyncActive": true,
        "reason": "obsidian-plugin"
      }
    }
  ]
}
```

- `daemon.running` is decided by asking the operating system about `pid`, **never** by trusting
  the file: a daemon killed by a crash or a power loss reads as stopped even though its last
  record is still on disk. The record lives at `~/.courier-cli/runtime/<vault>.json` (overridable
  with `COURIER_CLI_CONFIG_DIR`), is rewritten by that vault's `run` on every phase change, and is
  removed on a clean stop. `phase` is `starting`, `syncing`, `waiting` (waiting for another
  writer's lease) or `stopped` — with `reason` `key-revoked` (the account was deleted, and its
  vaults with it), `key-expired`, `key-disabled` (the host paused the key; the data is still
  there, so a later `run` resumes), `vault-deleted` or `failed`. All of them end the process: a
  daemon that keeps running against a dead credential only fills the log. A `stopped` record is
  written before the process drains, so a read during the drain still shows the pid and the
  reason; once the process is gone the record is cleared and reads as `not running`. A `waiting`
  record's `reason` is `other-writer`. `lastActivityAt` is the last decision the engine
  reported, written at most every five seconds; `lastError` is the latest failure and is cleared
  by the next successful connect.
- `lease` is the current writer: `null` when free, otherwise `{owner, pid, expiresAt}`. A record
  past its expiry, or one whose pid no longer exists on this machine, reports `null`. It is the
  authority; `coexistence` is an observation (`no-vault`, `obsidian-closed`, `obsidian-plugin` or
  `obsidian-plugin-off`) shown as context, not a pause rule.
- The per-file sync state lives beside the runtime records, under `~/.courier-cli/state/<vault>.json`,
  with a sibling `<vault>.bind.json` recording that a bind completed; binding one vault to a different
  remote vault never reads another vault's `fileId`s, and `disconnect` drops both.
- A vault with no daemon still appears in the list; its `daemon.pid` and timestamps are `null`.

## Service setup (systemd user service)

Place the binary in `~/courier/`. It links only glibc, so there is no package to install first; see
[Linux needs no extra system library](#linux-needs-no-extra-system-library).

Then, one unit per vault, because one process syncs one vault. Repeat the file with a different
unit name and `--vault` id:

```ini
[Unit]
Description=Courier sync CLI (vault-a)
After=network.target

[Service]
Type=simple
ExecStart=%h/courier/courier-cli run --vault vault-a
Restart=on-failure
RestartSec=5
# A server this CLI cannot talk to is not a crash: the process exits 78 and stays down
# until someone upgrades the side that is behind (see "When the CLI and the server are
# different versions"). Restarting it every five seconds only fills the journal.
RestartPreventExitStatus=78
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now courier-cli-vault-a
# systemctl --user enable --now courier-cli-vault-b   # the second vault's unit
loginctl enable-linger   # once: keep every unit running after logout
```

> This is the headless-server setup. A machine that wants one process per vault without systemd
> can start the same commands itself and read `status --json`.
