# Quick start

> **Status: authoritative.** The shortest path from nothing to a synced vault: one server, one user
> key, and the plugin on two devices. The rules behind each step are in
> [`plugin.md`](plugin.md), [`sync-scope.md`](sync-scope.md) and [`cli.md`](cli.md); the wire
> contract is [`api.md`](api.md).

This takes about ten minutes. You need:

- Obsidian 1.13.0 or newer on two devices (the plugin supports desktop and mobile);
- a machine that can run the Courier server and is reachable from every device — a NAS, a VPS or
  the computer you already leave on;
- a name for the remote vault and a strong vault password (it cannot be recovered).

## 1. Run a server

Download the build for your machine from the
[latest release](https://github.com/ah-yu/courier.dev/releases/latest): `courier-server-linux-x64`,
`courier-server-darwin-arm64` or `courier-server-win-x64.exe`. Then create the database and start
the service:

```bash
chmod +x courier-server-linux-x64
./courier-server-linux-x64 migrate
./courier-server-linux-x64 start --port 3002
```

On Windows, skip the `chmod` and run `.\courier-server-win-x64.exe migrate`, then
`.\courier-server-win-x64.exe start --port 3002`.

- The server logs the address it is serving (`… Server running at http://localhost:3002`) and keeps
  running in the foreground. Its database and blob store live in `data/` **next to the binary**, so
  run it from a directory you back up. Leave it running (a systemd unit or a service wrapper) for
  normal use.
- `--port` is only for this first try: without it the service listens on port 80, and a deployed
  instance is reached on `https://…:8443`.
- **For a server exposed to the internet, use HTTPS.** Set `TLS_NAME` to the DNS name or public IP
  address clients will use, open ports 80 (the ACME challenge) and 8443, and start it with
  `TLS_NAME=notes.example.com PORT=8443 ./courier-server-linux-x64 start`. The process requests and
  renews its own Let's Encrypt certificate; the service port opens once the first certificate
  arrives (see [`server.md`](server.md#tls-and-acme)). Binding port 80 needs root or
  `cap_net_bind_service`.

## 2. Create a user key

The server has no sign-up page: the host creates accounts. First mint a host key (`ak_...`), which
is the administrator credential — keep it on the server and never paste it into a client:

```bash
./courier-server-linux-x64 apikey create admin
# ak_...
```

Then use it once to create your account. The response contains the user key (`ck_...`) every device
will sign in with:

```bash
curl -fsS -X POST http://127.0.0.1:3002/api/users \
  -H "Authorization: Bearer ak_..." \
  -H "Content-Type: application/json" \
  -d '{"name":"me"}'
# {"id":"...","name":"me","key":"ck_...", ...}
```

Copy the `key`. Treat it like a password: every device of this account shares it. An account can
own one remote vault by default (`maxVaults`); the host can raise that through the same admin API.
Use the address the server is reachable at in the `curl` call — `https://…:8443` when TLS is on.

## 3. Install the plugin

- **Community plugins:** Settings → Community plugins → Browse → search for **Courier** → Install →
  Enable. (Courier is submitted to the directory; until it is listed there, use one of the options
  below.)
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the release into
  `<vault>/.obsidian/plugins/courier/`, then enable Courier under Community plugins.
- **BRAT:** add this repository as a beta plugin; it installs the release assets. See
  [`release.md`](release.md#installing-the-obsidian-plugin).

## 4. Sign in and connect the vault

Open Settings → Courier and fill in the login form:

| Field          | Value                                                            |
| -------------- | ---------------------------------------------------------------- |
| Server address | `http://192.168.1.10:3002` (or `https://notes.example.com:8443`) |
| User key       | the `ck_...` key from step 2                                     |

Select **Sign in**. Then choose the remote vault:

- **Create remote vault** the first time: give it a name and a **vault password**. The password
  encrypts the vault's content; it is never sent to the server, and it cannot be recovered.
- On a device that joins an existing vault, pick the vault from the list and enter the same vault
  password.

The status bar then reports **Syncing**. The first bind uploads (or downloads) the whole vault, so a
large vault takes a while; the tooltip shows the progress counter.

## 5. Add a second device

Install the plugin there too, sign in with the same server address and the same `ck_...` user key,
choose the same remote vault, and enter the same vault password. Each device can set its own device
name, which is only a label in the sync history — the server keeps no device registry.

## Check that it works

- Edit a note on the first device: it appears on the second within a moment.
- Open a file's **version history** (the hover chip in the file explorer on desktop, the file menu on
  a phone) to read earlier versions and restore one.
- Delete a note and open the recycle bin on the settings page to recover it.

## Troubleshooting

| Symptom                                     | What to check                                                                                                                                         |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in fails, or the server is unreachable | The address and port must be reachable from that device; the key must be the `ck_...` user key, not `ak_...`, and not expired or disabled             |
| Certificate errors                          | `TLS_NAME` must be exactly the name clients use, port 80 must be reachable for the challenge, and the first issuance takes a moment                   |
| "No remote vaults yet"                      | Create the remote vault first; an account owns one vault by default                                                                                   |
| The vault password is rejected              | Use the password set when the vault was created (not the user key). It cannot be reset: without it the content stays encrypted                        |
| Only some files sync                        | Check the file types and excluded folders in Settings → Courier; a file over the account's size cap is skipped (see [`sync-scope.md`](sync-scope.md)) |
| A phone cannot reach the server             | A LAN address only works on that network; use a public HTTPS address for a phone on mobile data                                                       |

## Next steps

- [Sync while Obsidian is closed](cli.md): run `courier-cli` on a NAS or VPS with the same user key.
- [Which files sync](sync-scope.md): file types, excluded folders, the config folder and the size cap.
- [The plugin](plugin.md): settings page, version history, conflicts and the status bar.
- [Release and install options](release.md#installing-the-obsidian-plugin).
