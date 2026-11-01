# Courier

Sync your Obsidian vault across devices — open source, self-hosted, and encrypted on the device.

Courier is a complete sync solution for Obsidian: a plugin for desktop and mobile, a headless CLI
for machines that never open Obsidian, and one server that you run yourself.

## What Courier does

- **Encrypted on your device.** Note contents and paths are encrypted with a key derived from your
  vault password before they leave the device. The server keeps ciphertext, sizes and timestamps;
  it never sees the password or your notes.
- **Every device, one engine.** The Obsidian plugin runs on desktop and mobile, and `courier-cli`
  runs the same sync engine on a NAS or VPS — it keeps syncing while Obsidian is closed.
- **History you can go back to.** Every file keeps a version chain: browse its versions, restore
  an old one, or recover a deleted note from the recycle bin for as long as your server's retention
  keeps it.
- **Conflicts are parked, not merged.** When a conflict happens there is no implicit merge: the
  remote version wins and the local one is parked beside it as
  `note-2026-10-31-120000.conflict.md`; compare the two and replace in one click.
- **You choose what syncs.** Markdown and Canvas always sync. Other file types, excluded folders
  and Obsidian's config folder are configured per device and per vault.
- **No lock-in.** Apache-2.0, one server binary, no vendor account, no telemetry, no ads.

## Requirements

- Obsidian 1.13.0 or newer.
- A Courier server you run (Linux x64, macOS on Apple Silicon, or Windows x64) and a user key on it.
- A vault password. It encrypts the remote vault and is never sent to the server. **If you lose it,
  the remote content cannot be decrypted — there is no reset.**

## Quick start

Four steps; the [quick start guide](docs/quick-start.md) has the exact commands and the labels you
will see in Obsidian.

1. **Run a server.** Download the build for your machine from the
   [latest release](https://github.com/ah-yu/courier.dev/releases/latest), run
   `./courier-server-linux-x64 migrate`, then `./courier-server-linux-x64 start`.
2. **Create a user key.** `./courier-server-linux-x64 apikey create admin` prints a host key; use
   it once to create your account, and copy the `ck_...` user key it returns.
3. **Install the plugin.** In Obsidian: Settings → Community plugins → Browse → search for
   **Courier** → Install → Enable. (Or copy the release's `main.js`, `manifest.json` and
   `styles.css` into `<vault>/.obsidian/plugins/courier/`.)
4. **Connect the vault.** Settings → Courier: enter the server address and the user key, sign in,
   then create or choose a remote vault and enter its password.

Repeat steps 3 and 4 on your other devices with the same server address, user key and vault
password.

## Privacy and network use

- **An account is required.** Courier syncs through a server you run with a user key on it; without
  both, the plugin has nothing to sync to.
- **Network use.** The plugin contacts only the server address you enter (and Obsidian's own
  community-plugin update check). It sends encrypted file content, encrypted paths, sizes,
  timestamps and the device label you set. There is no telemetry, no analytics and no crash
  reporting, and no third-party service is contacted.
- **Nothing self-updates.** The plugin is updated only through Obsidian's community-plugin
  mechanism; the server binary is updated by whoever runs it.
- **What the server can see.** Its operator can see which vaults exist, their sizes, version
  timestamps and device labels — not your notes, paths or passwords. Run the server yourself, or
  choose an operator you trust with that metadata.
- **Credentials on the device.** The user key and plugin settings live in the plugin's `data.json`
  inside the vault; the derived vault key is kept in Obsidian's device-local storage and does not
  enter the vault, so vault-level syncing (iCloud, Dropbox, Git) cannot carry it off the device.

## Support

If Courier is useful to you, star the repository and share it — both help other people find the
project.

## Documentation

- [Quick start](docs/quick-start.md) — server, first device, second device.
- [Documentation index](docs/README.md) — sync engine rules, scope, plugin, server, API, CLI and
  the release process.

## License

[Apache License 2.0](LICENSE)
