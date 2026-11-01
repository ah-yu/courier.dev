# Courier

Sync your Obsidian vault across devices — self-hosted, and encrypted on the device.

This repository is the Obsidian plugin. The plugin is one client of **Courier**, a complete sync
solution you run yourself: this plugin for desktop and mobile, a headless CLI for machines that
never open Obsidian, and one server that holds the encrypted copy of your vault. The server and the
CLI live in [**courier.dev**](https://github.com/ah-yu/courier.dev).

## Install

Settings → Community plugins → Browse → search for **Courier** → Install → Enable.

To install by hand, copy this release's `main.js`, `manifest.json` and `styles.css` into
`<vault>/.obsidian/plugins/courier/`.

## Requirements

- Obsidian 1.13.0 or newer.
- A Courier server you run, and a user key on it. Without both there is nothing to sync to —
  [the server is the other half](https://github.com/ah-yu/courier.dev#quick-start).
- A vault password. It encrypts the remote vault and is never sent to the server. **If you lose it,
  the remote content cannot be decrypted — there is no reset.**

## What the plugin does

- **Encrypted on your device.** Note contents and paths are encrypted with a key derived from your
  vault password before they leave the device. The server keeps ciphertext, sizes and timestamps;
  it never sees the password or your notes.
- **History you can go back to.** Every file keeps a version chain: browse its versions, restore an
  old one, or recover a deleted note from the recycle bin for as long as your server's retention
  keeps it.
- **Conflicts are parked, not merged.** The remote version wins and the local one is parked beside
  it as `note-2026-10-31-120000.conflict.md`; compare the two and replace in one click.
- **You choose what syncs.** Markdown and Canvas always sync; other file types, excluded folders
  and Obsidian's config folder are configured per device and per vault.

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
  timestamps and device labels — not your notes, paths or passwords.
- **Credentials on the device.** The user key and plugin settings live in the plugin's `data.json`
  inside the vault; the derived vault key is kept in Obsidian's device-local storage and does not
  enter the vault, so vault-level syncing (iCloud, Dropbox, Git) cannot carry it off the device.

## Documentation and support

- [Quick start](https://github.com/ah-yu/courier.dev/blob/main/docs/quick-start.md) — server, first
  device, second device.
- [Documentation index](https://github.com/ah-yu/courier.dev/blob/main/docs/README.md).
- Bugs and feature requests: [open an issue](https://github.com/ah-yu/courier.dev/issues).

## License

[Apache License 2.0](LICENSE)
