# Courier

English · [简体中文](README.zh-CN.md)

Sync your Obsidian vault across devices — end-to-end encrypted, in real time.

Courier is an open-source sync solution for Obsidian: a plugin for desktop and mobile, a headless
CLI for machines that never open Obsidian, and one server that you run yourself.

## What Courier does

- **End-to-end encrypted.** Note contents and paths are encrypted with a key derived from your vault
  password before they leave the device. The server stores the ciphertext, sizes and timestamps, plus
  the account name, vault name and device labels you choose; it never sees your password or your
  notes.
- **Changes arrive as you type.** Edits on one device reach the others in real time, so the same
  note converges everywhere without a manual sync step.
- **Every device, one engine.** The Obsidian plugin runs on desktop and mobile, and `courier-cli`
  runs the same sync engine on a NAS or VPS — it keeps syncing while Obsidian is closed.
- **History you can go back to.** Every file keeps a version chain: browse its versions, restore an
  old one, or recover a deleted note from the recycle bin for as long as your server's retention
  keeps it.
- **Conflicts are parked, not merged.** When a conflict happens there is no implicit merge: the
  remote version wins and the local one is parked beside it as
  `note-2026-10-31-120000.conflict.md`; compare the two and replace in one click.
- **You choose what syncs.** Markdown and Canvas always sync. Other file types, excluded folders
  and Obsidian's config folder are configured per device and per vault.

## Requirements

- Obsidian 1.13.0 or newer.

## Quick start

Five steps; the [quick start guide](docs/quick-start.md) shows the same flow with the labels you
will see in Obsidian.

1. **Run a server.** Download the asset for your machine from the
   [latest release](https://github.com/ah-yu/courier.dev/releases/latest), then create the database
   and start it — leave it running: the database and blob store live in `data/` beside the binary.

   Linux (x64):

   ```bash
   chmod +x courier-server-linux-x64
   ./courier-server-linux-x64 migrate
   ./courier-server-linux-x64 start --port 3002
   ```

   Linux (arm64):

   ```bash
   chmod +x courier-server-linux-arm64
   ./courier-server-linux-arm64 migrate
   ./courier-server-linux-arm64 start --port 3002
   ```

   macOS (Apple Silicon):

   ```bash
   chmod +x courier-server-darwin-arm64
   ./courier-server-darwin-arm64 migrate
   ./courier-server-darwin-arm64 start --port 3002
   ```

   Windows (x64, PowerShell):

   ```powershell
   .\courier-server-win-x64.exe migrate
   .\courier-server-win-x64.exe start --port 3002
   ```

   `--port 3002` is only for this local first try; a server other machines reach needs TLS and the
   address those clients use — see the
   [quick start guide](docs/quick-start.md#1-run-a-server).

2. **Create a host key.** Run the same binary with `apikey create admin` — Linux:
   `./courier-server-linux-x64 apikey create admin`, macOS:
   `./courier-server-darwin-arm64 apikey create admin`, Windows:
   `.\courier-server-win-x64.exe apikey create admin`. It prints the host key (`ak_...`) — the
   administrator credential, kept on the server and never pasted into a client.
3. **Create your account and copy its user key.** With the server running, call the users API once —
   `{server-url}` is `http://127.0.0.1:3002` on the server itself (or the address clients reach,
   `https://{your-domain}:8443` once TLS is on), `{host-key}` is the `ak_...` key from step 2, and
   `{user-name}` is any name you want the account to show.

   Linux and macOS:

   ```bash
   curl -fsS -X POST {server-url}/api/users \
     -H "Authorization: Bearer {host-key}" \
     -H "Content-Type: application/json" \
     -d '{"name":"{user-name}"}'
   ```

   Windows (PowerShell):

   ```powershell
   Invoke-RestMethod -Method Post -Uri "{server-url}/api/users" `
     -Headers @{ Authorization = "Bearer {host-key}" } `
     -ContentType "application/json" `
     -Body '{"name":"{user-name}"}'
   ```

   The response's `key` is the user key (`ck_...`) every device signs in with, shared by the whole
   account — treat it like a password.

4. **Install the plugin.** In Obsidian: Settings → Community plugins → Browse → search for
   **Courier** → Install → Enable. (Or copy the release's `main.js`, `manifest.json` and
   `styles.css` into `<vault>/.obsidian/plugins/courier/`.)
5. **Connect the vault.** Settings → Courier: enter `{server-url}` and `{user-key}`, sign in, then
   create or choose a remote vault and enter its password — **it cannot be recovered if you lose
   it**.

## Privacy and network use

- **Network use.** The plugin contacts only the server address you enter (and Obsidian's own
  community-plugin update check). It sends encrypted file content, encrypted paths, sizes,
  timestamps and the device label you set. There is no telemetry, no analytics and no crash
  reporting, and no third-party service is contacted.
- **What the server can see.** Its operator can see the account and vault names you chose, which
  vaults exist, their sizes, version timestamps and device labels — not your notes, paths or
  passwords.
- **Credentials on the device.** The user key and plugin settings live in the plugin's `data.json`
  inside the vault; the derived vault key is kept in Obsidian's device-local storage and does not
  enter the vault, so vault-level syncing (iCloud, Dropbox, Git) cannot carry it off the device.

## Support

- Getting the [Courier desktop app](https://couriersync.dev/) is the most direct way to support
  Courier's development.
- If Courier is useful to you, star the repository and share it — both help other people find the
  project.

## Documentation

- [Quick start](docs/quick-start.md) — server, first device, second device.
- [Documentation index](docs/README.md) — sync engine rules, scope, plugin, server, API, CLI and
  the release process.

## License

[Apache License 2.0](LICENSE)
