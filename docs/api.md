# Courier API documentation

> **Status: `authoritative`.** The single source of truth for the server's REST + WebSocket
> contract: when you add a route or change a request / response shape or a message type, you must
> update this document in the same change. For the document index, see `docs/README.md`.

## Base URL

```
http://localhost:3002/api
```

The address above is for local development (`bun run dev`). **A deployed service is always HTTPS**: a
deployment automatically requests and renews a Let's Encrypt certificate for the
server's public IP (or domain name), and the service listens on **8443** by default, so the service
address a client uses usually carries `:8443` — `https://<public IP or domain>:8443` (443 is
accepted and then left out of the spelling; write `https://<host>:<port>` for any other port). The
WebSocket URL is derived from that address by the same rule; see below.

## Authentication

Authenticated endpoints use a **Bearer Token**, and credentials come in two kinds:

- **User key (`ck_...`)**: the **single account/sync credential** on a multi-user shared service, one
  per user, created by the server host (through `POST /api/users`). Every client of the
  same user shares this one key; each client **self-declares a device name** as a display label in
  every push (there is no separate device key and no device registry; see "Device model" below).
- **Host key (`ak_...`)**: the server administrator/host credential, used for management endpoints such
  as `/api/users` and `/api/admin/*`. It is **not a sync credential** (sync accepts only `ck_`). Each
  key carries **scopes** (`admin` / `status` / `users`, where `admin` implies all of them) and an
  **optional expiry**; `/api/users` needs `users`, `/api/admin/*` needs `status`. A host signs
  itself a short-lived `status,users` key (see §7b).

```
Authorization: Bearer ck_xxxxxxxxxxxx
```

### Device model (the client-declared display label)

- All clients of one user (each Obsidian plugin instance, each headless `courier-cli` instance) share
  **one user key**.
- **The server has no device registry**: no `devices` table, no `POST /api/devices`, no
  `X-Courier-Device-Id` header and no device revocation.
- A client carries `deviceName` in the frame header of **every push** (a self-declared display label,
  changeable at any time; non-ASCII is fine, which is why it travels in the frame-header JSON rather
  than an HTTP header), and the WS `subscribe` message carries it as well. The server writes it onto
  every `file_versions.device_name` row produced by that push.
- The version-history UI shows **the name recorded on that version at the time**: after a rename, new
  versions carry the new name and old versions keep the old one, so it shows "which name was syncing
  when". The plugin's session log shows the label it knows for the event: an outgoing change uses this
  device's current label, an incoming one the label a WebSocket notification carried (or "another
  device" when a reconcile found the chain without one).
- The label is pure display metadata; the server validates only its type and length (≤ 100 characters):
  different clients may use the same name, and any client may call itself anything — it is not an
  identity and takes no part in any authorization.

---

## Endpoint list

### 1. Health check

```
GET /api/health
```

Checks whether the service is running normally.

**Response** `200 OK`

```json
{
  "status": "ok",
  "timestamp": "2026-06-10T21:00:00.000Z"
}
```

---

### 2. List all vaults

```
GET /api/vaults
```

Lists the vault metadata visible to the current user: the vaults they own, plus owner-less legacy
vaults (visible to every authenticated user). This endpoint **requires a user key** (`ck_`) and returns
`id`, `name`, `createdAt` and the vault's two **retention limits**; it contains nothing sensitive.

**Response** `200 OK`

```json
{
  "vaults": [
    {
      "id": "Lcl2pM7xQaKbDn9fR3sT...",
      "name": "My remote vault",
      "createdAt": "2026-06-10T21:00:00.000Z",
      "historyLimitDocuments": 200,
      "historyLimitAttachments": 10
    }
  ]
}
```

| Field                              | Description                                          |
| ---------------------------------- | ---------------------------------------------------- |
| `vaults[].id`                      | Vault identifier                                     |
| `vaults[].name`                    | Vault name                                           |
| `vaults[].createdAt`               | ISO 8601 creation timestamp                          |
| `vaults[].historyLimitDocuments`   | Versions kept per markdown note / canvas file        |
| `vaults[].historyLimitAttachments` | Versions kept per other file (see **History limit**) |

---

### 3. Create a vault

```
POST /api/vaults
```

Creates a remote vault. **Requires a user key (`ck_`).** The server stores metadata only; the
encryption password never leaves the client.

**Request headers**

```
Authorization: Bearer ck_xxxxxxxxxxxx
```

**Request body**

| Field            | Type   | Required | Description                                                                                                             |
| ---------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `name`           | string | Yes      | Vault name (1–255 characters)                                                                                           |
| `encryptionSalt` | string | Yes      | 32 random bytes, base64-encoded, used to derive the file encryption key (AES-256-GCM)                                   |
| `keyCheck`       | string | Yes      | `AES-256-GCM(key, KEY_CHECK_VALUE)`, base64(iv‖ciphertext‖authTag). Used by a new device to verify the password locally |

**Example**

```json
{
  "name": "My remote vault",
  "encryptionSalt": "eNcRyPtIoNsAlT...",
  "keyCheck": "aXYrY2lwaGVydGV4dCt0YWc..."
}
```

**Response** `201 Created`

```json
{
  "id": "Lcl2pM7xQaKbDn9fR3sT...",
  "name": "My remote vault",
  "createdAt": "2026-06-10T21:00:00.000Z",
  "historyLimitDocuments": 200,
  "historyLimitAttachments": 10
}
```

| Field                     | Description                                   |
| ------------------------- | --------------------------------------------- |
| `id`                      | 32-byte random vault identifier (base64url)   |
| `createdAt`               | ISO 8601 timestamp                            |
| `historyLimitDocuments`   | Versions kept per note / canvas (default 200) |
| `historyLimitAttachments` | Versions kept per other file (default 10)     |

**Errors**

| Status code | Error code            | Description                                          |
| ----------- | --------------------- | ---------------------------------------------------- |
| `422`       | `VALIDATION_ERROR`    | A required field is missing or badly formatted       |
| `403`       | `KEY_EXPIRED`         | The user key has expired                             |
| `403`       | `KEY_DISABLED`        | The host disabled the account (see 7b)               |
| `409`       | `VAULT_LIMIT_REACHED` | The account already owns `maxVaults` vaults (see 7b) |

---

### 4. Get the key check

```
GET /api/vaults/:id/key-check
```

Fetches the vault's canary ciphertext (key check). This endpoint is **public** and needs no
authentication. A new device uses it to verify the password **locally**: derive the key, then attempt
decryption; the AES-GCM authentication tag guarantees "decryption succeeds ⟺ the password is correct".

**Path parameters**

| Parameter | Description |
| --------- | ----------- |
| `id`      | Vault ID    |

**Response** `200 OK`

```json
{
  "keyCheck": "aXYrY2lwaGVydGV4dCt0YWc..."
}
```

**Errors**

| Status code | Error code  | Description                                       |
| ----------- | ----------- | ------------------------------------------------- |
| `404`       | `NOT_FOUND` | The vault does not exist or has no key check data |

---

### 5. Get the encryption salt

```
GET /api/vaults/:id/encryption-salt
```

Fetches the vault's encryption salt. This endpoint is **public** and needs no authentication. A new
device uses it to derive the AES-256-GCM file encryption key.

**Path parameters**

| Parameter | Description |
| --------- | ----------- |
| `id`      | Vault ID    |

**Response** `200 OK`

```json
{
  "encryptionSalt": "eNcRyPtIoNsAlT..."
}
```

**Errors**

| Status code | Error code  | Description              |
| ----------- | ----------- | ------------------------ |
| `404`       | `NOT_FOUND` | The vault does not exist |

---

### 6. Verify the password (local, no server endpoint)

Password verification happens entirely on the client; there is no verify endpoint on the server and no
vault token:

1. Call `GET /api/vaults/:id/encryption-salt` to get the encryption salt
2. Call `GET /api/vaults/:id/key-check` to get the canary ciphertext
3. The client derives `key = PBKDF2(password, encryptionSalt, 600000, SHA-256, 32)`
4. Attempt to decrypt `keyCheck` with `key`: decryption succeeds and the plaintext equals the fixed
   value `courier-key-check` ⟺ the password is correct

Neither the password nor any hash derived from it is ever sent to the server. Access control for server
endpoints rests entirely on API keys.

---

### 7. Vault management (HTTP)

Creating, renaming, re-configuring and deleting a vault exist only as HTTP endpoints (managed from the
plugin and the CLI; the server no longer offers `courier vault …` commands):

- `POST   /api/vaults` (needs a user key; the vault belongs to that user)
- `PATCH  /api/vaults/:id` (body `{ name?, historyLimitDocuments?, historyLimitAttachments? }`, at
  least one; allowed only for the owner, or for a legacy vault any authenticated user). Response:
  `{ id, name, historyLimitDocuments, historyLimitAttachments }` — the vault as it now stands. The
  two limits are the vault's **retention policy** (see **History limit** under 9); lowering either one
  trims the chains already stored before the response, so an idle file is bounded too. A request that
  states a limit also broadcasts `vault_settings` to every subscriber of the vault, so a settings page
  that is already open on another device repaints instead of waiting for a reopen.
- `DELETE /api/vaults/:id` (allowed only for the owner, or for a legacy vault any authenticated user;
  **also broadcasts `vault_deleted` to every subscriber of that vault, within the process**, and
  **deletes the vault's whole directory in blob storage**)

Before creating or deleting, the client verifies the password the user typed against the keyCheck
canary **locally** (to prevent accidental deletion). Deletion is thorough: `file_versions` rows are
deleted by cascade with the vault (`ON DELETE CASCADE`), and the ciphertext directory goes with
them — keeping it would mean "the freed space can never be reclaimed", and the per-vault usage would
then be under-counted for this user. Pruning old versions by **age** is a different path (a scheduled
task inside the service process; see `retentionDays` in 7b); pruning by **count** is the vault's two
limits, applied on every push and on a limits update.

### 7a. Current account (`GET /api/me`)

```
GET /api/me
```

Requires a `ck_` user key. Returns the `UserSummary` of **the account this key belongs to**
(`{ id, name, maskedKey, storageBytesLimit, retentionDays, maxFileBytes, maxVaults, expiresAt, disabled, createdAt, usedBytes, vaultsCount }`).
`maskedKey` is the redacted key (e.g. `ck_ab12****cd34`); **the full key is never returned here**. A
host key (`ak_`) always gets 401 here.

A client that holds only a `ck_` has no other way to learn which account it is signed in to:
`/api/users` is a host endpoint, and it lists everyone. This is also the cheapest read of "is this key
still valid" — step 1 of the plugin settings page (sign-in) uses it to validate the key, while the vault
list is read only when the user actually opens "select remote vault".

### 7b. User management (host)

| Method   | Path                 | Auth           | Description                                                                                               |
| -------- | -------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/users`         | `ak_`(`users`) | Create a user and return the full `ck_` key                                                               |
| `GET`    | `/api/users`         | `ak_`(`users`) | List users with quota/usage/retention/file cap/vault allowance/expiry; keys come back only as `maskedKey` |
| `GET`    | `/api/users/:id/key` | `ak_`(`users`) | Explicitly read one user's full `ck_` key (to copy it)                                                    |
| `PATCH`  | `/api/users/:id`     | `ak_`(`users`) | Update name / storageBytesLimit / retentionDays / maxFileBytes / maxVaults / expiresAt / disabled         |
| `DELETE` | `/api/users/:id`     | `ak_`(`users`) | Delete a user **and every vault it owns** (chains, blobs and disk), and revoke its live WS sessions       |

Create body `{ name, storageBytesLimit?, retentionDays?, maxFileBytes?, maxVaults?, expiresAt?, disabled? }`; for
PATCH every one of those fields is optional, and passing `null` clears the quota/retention/expiry limit
(`maxFileBytes`, `maxVaults` and `disabled` have no `null` form; `0` means unlimited for the two caps).
Additional error codes: `KEY_EXPIRED` (403), `KEY_DISABLED` (403), `INSUFFICIENT_SCOPE` (403).

**Full keys never appear in bulk**: the list returns only `maskedKey`; when the host needs to copy a key
again it calls `GET /api/users/:id/key` for a single account, which returns `{ key }`. Both endpoints
need the `users` scope on an `ak_`, and a user key (`ck_`) always gets 401. The list endpoint therefore
never leaks every account's credential at once, while an administrator can still see the masked key in
a table and copy it.

Users are managed only through these endpoints (that is exactly what the admin API's "key management"
does): the server no longer offers `courier user …` commands.

**`DELETE /api/users/:id` deletes the account and everything it owns.** The vault rows go in the same
transaction as the user row (`file_versions` cascades), then each vault's blob directory is reclaimed and
both usage caches are invalidated. That is deliberate: `vaults.owner_user_id` is `ON DELETE SET NULL`, so
deleting only the key would leave **owner-less** vaults that every other account may list, push to and
delete (`lib/vault-access.ts`), while their blobs are charged to nobody and never reclaimed. The account's
live WebSocket sessions are revoked in the same request (`api_key_revoked`).

**`disabled` is the reversible stop**, `false` by default:

- A disabled key authenticates nothing: `syncAuth`, `userAuth` and the WebSocket `subscribe` all answer
  `403 KEY_DISABLED`. Its vaults, version chains and blobs are untouched, and `GET /api/users` keeps
  reporting the account (with `disabled: true`) so a host can see what is paused.
- `PATCH { "disabled": true }` also revokes the account's live WebSocket sessions, with
  `api_key_disabled` — **not** `api_key_revoked`: a client that saw the latter drops the binding, while a
  disabled key is a pause the same key resumes from. `PATCH { "disabled": false }` pushes nothing; the
  client reconnects (or is resumed by its user).
- It exists so "stop this key now" does not have to be expressed as "delete the account" or "set the
  expiry into the past" (which the validity rule below refuses).

**An edit that would leave the account in a state it cannot leave on its own is refused** (`422
VALIDATION_ERROR`, with `details[].field` naming the field):

- `storageBytesLimit` **below the account's current usage**. A cap deletes nothing, so the account would
  silently become read-only for new content while reads, deletes and renames kept working — a state only
  the host can understand. Free space first (clear the recycle bin, or let retention prune), or set the
  cap at or above the usage.
- `maxVaults` **below the vaults the account already owns** (when the value is a finite number; `0` is
  still unlimited). Vaults are only deleted by hand, so such a number could never describe the account
  again.
- `expiresAt` **in the past** (or an unparseable value, which the auth path treats as expired). A key that
  is born dead is what `disabled` is for, and disabling is reversible. The rule is checked on create as
  well as on edit. A date **today** is allowed: the client sends the end of that local day.

**`storageBytesLimit` and `expiresAt` are enforced by the server**; a client only sets them:

- Once `expiresAt` passes, a `ck_` key gets 403 (`KEY_EXPIRED`) in both `syncAuth` and `userAuth`, so
  sync and WebSocket subscriptions stop working at the same time. An **already-subscribed** socket is not
  cut by the clock: its next request fails, and the client's host stops on that 401/403 instead of
  retrying forever.
- `storageBytesLimit` is checked **before a push**: if `current usage + new ciphertext bytes in this
  batch > limit`, the whole request gets 413 `QUOTA_EXCEEDED` and not a single byte is written.
  **Content that already exists is not charged** (blobs are addressed by hash, and a store that
  already holds the bytes keeps its copy), so a peer renaming a note or re-pushing it is not
  rejected.
- Usage is "the sum of blob lengths across all of the user's vaults", cached by the server for 30
  seconds; a successful push adds the written bytes to the cache, so within one window the directory is
  not walked again. The price is that **the limit can be overshot by roughly one window's worth** — the
  alternative is "walk the storage on every push", and that is not worth it.

**`maxFileBytes` is "the size cap for a single file"**, configured per **user key**, 50 MiB by default,
`0` = unlimited:

- It is a **client-side guard**, not a server-side enforcement: the engine reads a whole file into
  memory to hash and encrypt it, and this cap keeps a phone from being dragged down by a large video.
- It bounds what a device **sends**. A version a peer already uploaded is part of the vault, so every
  device materialises it whatever its own cap says — refusing it made a file a peer had synced silently
  absent from a new device, which is indistinguishable from data loss.
- The official clients (the plugin and `courier-cli`) read this value through `GET /api/me` when the
  host starts, so there is **no** user-editable field for it in the plugin settings page or as a CLI
  flag; an administrator changes it through `POST/PATCH /api/users` (the admin API's "key
  management"). A change takes effect the next time a client starts its host.
- The server does **not** reject pushes based on it: the plaintext size is declared by the client and
  cannot serve as a trustworthy basis for enforcement; what the server actually enforces is
  `storageBytesLimit`.

**`maxVaults` is "how many vaults this account may own"**, `1` by default, `0` = unlimited:

- It is enforced by `POST /api/vaults`: the server counts the vaults the key owns and, once that count
  reaches the allowance, answers `409 VAULT_LIMIT_REACHED` and creates nothing. The count and the
  insert run in **one SQLite transaction**, so two concurrent creates cannot both take the last slot.
- Only vaults **owned by the key** count. Owner-less (legacy) vaults count against nobody, and deleting
  a vault frees its slot immediately.
- `GET /api/users` and `GET /api/me` report `vaultsCount`, so a host can see how full an account is
  before handing it out. Raising `maxVaults` takes effect on the next create; lowering it below the
  current count is refused (see the edit rules above).
- It is not a sync limit: every vault the account already owns keeps syncing with every device that
  holds the key.

**`retentionDays` is "how many days of version history to keep"**, `null` (the default) = keep forever:

- It constrains **historical version rows**, not the files themselves: a file's latest version is never
  pruned (that row is the current state; deleting it would lose the current path and content), and the
  tombstone left by a delete is also a "latest version", so it is not pruned either.
- The executor is a background task inside the service process (`courier start` launches
  `startPruneLoop` at `PRUNE_INTERVAL_MS`, 1 hour by default, set to 0 to disable; nothing is pruned
  while the service is not running). Each round: for every chain in every vault of that user, delete the
  rows older than `now - retentionDays days` (except the chain head), then delete blob files that no
  version row references any more; a file is unlinked as soon as its last row is deleted, and
  `usedBytes` follows the rows, so the quota drops immediately.
- It therefore lowers both **disk usage** and `usedBytes` (the quota counts all blob bytes, history
  included). On a shared machine, "letting history shrink itself" is usually less trouble than "capping
  the limit".
- **The trade-off with the recycle bin**: the recycle bin restores "the version before the delete". If
  the retention period has pruned that one too, the chain holds only a tombstone and the client offers no
  restore (see the "recycle bin" section). The shorter the retention period, the fewer early accidental
  deletions can be rescued.

`retentionDays` is the administrator's **age** policy. It is not the only bound on history: each
**vault** also carries a **count** policy — `historyLimitDocuments` / `historyLimitAttachments` on
the vault row, editable through `PATCH /api/vaults/:id` — which the server applies inside the insert
transaction (see **History limit** under 9) and to the chains already stored when it is lowered. The
two are independent: a vault can keep years of history under the default `null` `retentionDays` and
still be bounded by its own two counts.

### 7b-2. Host key scopes and expiry

Two columns on `api_keys` decide what an `ak_` can do and how long it works:

- `scopes`: comma-separated, values `admin` / `status` / `users`; **`admin` implies all of them**. A key
  with no scopes authenticates but gets 403 (`INSUFFICIENT_SCOPE`) on every endpoint.
- `expires_at`: ISO 8601, empty = never expires; once expired it always gets 403 (`KEY_EXPIRED`).

```
courier apikey create <name> [--json] [--expires-in <30m|12h|7d>] [--scopes <list>]
courier apikey list [--json]        # the JSON includes scopes and expiresAt
```

- Without `--scopes`, the key created is a full-privilege `admin` key (the behaviour before scopes
  existed, and the column's default).
- A host signs itself `--expires-in 12h --scopes status,users`: short-lived and
  least-privilege, re-signed automatically after expiry or revocation.
- If `--scopes` contains an unknown name, or `--expires-in` is not a positive duration, the command
  fails with exit code 1 and writes nothing to the database.

### 7c. Service status (host)

```
GET /api/admin/status
```

Requires an `ak_` with the `status` scope. Returns
`{ storageUsedBytes, storageLimitBytes, dbBytes, diskTotalBytes, diskUsedBytes, diskFreeBytes, binarySha256, binarySize, blobCount, usersCount, devicesCount, vaultsCount, migrationsApplied, migrationsKnown, version }`
for a service-monitoring page. This one walks blob storage (cached by the server for
30 seconds), so a monitoring client reads it on the slow 30-second cadence.

- `diskTotalBytes` / `diskUsedBytes` / `diskFreeBytes` are the capacity of the filesystem holding the
  data directory, from an in-process `statfs`: one system call answers it, which is why it goes over
  HTTP. `used` follows `df`'s accounting (total blocks minus free blocks, including root-reserved
  space), and `free` is what an ordinary process can still write (`bavail`). Only when the process is
  down does a monitoring client fall back to `df` over SSH.
- `binarySha256` / `binarySize` are the contents of the build marker `~/courier/.courier-binary` next to
  the binary; after startup the service reads it from disk and returns it with the status, so version
  checks do not need SSH for this file either. In a development run, or when the marker is unreadable,
  they are empty/0.
- `devicesCount` is **the number of distinct device names that have appeared in sync history**
  (`COUNT(DISTINCT device_name)`): there is no registry, so one machine that was renamed counts as two
  and two machines with the same name count as one.

- `version` is this binary's own version (the same source as `courier version --json`), `"dev"` when not
  injected.
- `migrationsApplied` / `migrationsKnown` are "the number of migrations recorded in the database" and
  "the number of migrations this binary carries"; an upgrade compares the two, so
  when the database is newer than the binary it will not overwrite it with an older build. Both come
  from `db/migrations.ts` — a row count of `courier_migrations` and the length of the chain module that
  is generated into the bundle — so the service runs no loader of its own.
- **No `uptime`**: how long the process has been running belongs to the process itself and is answered
  by `/api/admin/runtime`; `courier version --json` reports identity only, not database facts.

### 7c-2. Process runtime (host)

```
GET /api/admin/runtime
```

Requires an `ak_` with the `status` scope. Returns the facts the process knows itself and can answer
**without SSH**, for a monitoring client to poll on the fast 1-second cadence:

```json
{
  "version": "0.2.0",
  "runtime": "bun/1.4.4",
  "pid": 1234,
  "uptimeSeconds": 3720,
  "cpuMicros": 1234567,
  "cpuPercent": 1.5,
  "memoryBytes": 100663296,
  "cpuCount": 2,
  "loadAverage": [0.1, 0.2, 0.3],
  "freeMemoryBytes": 1073741824,
  "totalMemoryBytes": 2147483648,
  "onlineUsers": 2,
  "onlineVaults": 3,
  "sampledAt": "2026-09-15T08:00:00.000Z"
}
```

- `cpuPercent` is "the share of one core used since the previous read"; right after the process starts
  there is no comparable sample, so it is `null` and the UI shows "sampling" rather than a 0 that looks
  idle.
- `onlineUsers` / `onlineVaults` are the number of users and vaults with a live WebSocket session (the
  two numbers that `/internal/connections` and `courier port` used to provide, removed together with the
  internal endpoints).
- **No machine disk facts beyond memory usage**: disk, data-directory and backup usage are answered by
  `df` / `du` over SSH (`du` has to walk directories, which is not something the process can answer on
  demand).

---

## WebSocket

The plugin keeps a long-lived WebSocket connection to the server; the sync features below use it to
notify peers of changes.

```
ws://localhost:3002
```

Local development uses `ws://`; a deployed service is `wss://` — the client derives it from the REST
address by the same rule (replace the leading `http` with `ws`), so an `https://…` service address
yields exactly `wss://…`, and neither the plugin nor `courier-cli` needs extra configuration.

### Authentication flow

After connecting, the client sends a subscribe message (authentication uses a **user key**, plus a
self-declared device name). A host key (`ak_`) **cannot subscribe**: it is the credential for HTTP
management endpoints, not a sync credential. A subscription also checks **vault ownership** (the owner,
or any authenticated user for an owner-less legacy vault): the subscription is the channel through which
"a peer's changes arrive here", so it is subject to the same restriction as the sync endpoints.

```
Client → Server:  { "type": "subscribe", "vaultId": "...", "userKey": "ck_...", "deviceName": "..." }
Server → Client:  { "type": "subscribe_success", "vaultId": "...", "sessionId": "..." }
                  or
                  { "type": "subscribe_error", "vaultId": "...", "message": "..." }
```

### Message types

**Client → Server**

| Message type  | Payload                                                     | Description                                                                                                                         |
| ------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `subscribe`   | `vaultId: string`, `userKey: string`, `deviceName?: string` | Subscribe to a vault's change notifications; `deviceName` is a display label, not an identity, and is never used for authentication |
| `unsubscribe` | `vaultId: string`                                           | Cancel all subscriptions to that vault on this connection                                                                           |
| `pong`        | —                                                           | Reply to the server heartbeat                                                                                                       |

**Server → Client**

| Message type        | Payload                                         | Description                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribe_success` | `vaultId`, `sessionId`                          | Subscription succeeded                                                                                                                                                                                                                                                                                                                                                                                      |
| `subscribe_error`   | `vaultId`, `message`, `code?`                   | Subscription failed: the vault does not exist, it belongs to another account, or the user key is invalid / expired / disabled. `code` is the API error code the refusal came from (`NOT_FOUND`, `UNAUTHORIZED`, `KEY_EXPIRED`, `KEY_DISABLED`); `message` is for a log line. A client matches on `code`: `NOT_FOUND` means the vault is gone, and the other three end the binding (the host stops on them). |
| `ping`              | —                                               | Sent once every 30 seconds; the client should reply `pong`                                                                                                                                                                                                                                                                                                                                                  |
| `file_pushed`       | `vaultId`, `fileId`, `versionId`, `deviceName?` | A file has a new version; the client should pull that file's version chain and apply it (the content is fetched separately with `GET …/sync/versions/:contentHash/content`). `deviceName` is the pusher's self-declared label, for display. The pusher's own session does not receive an echo (see `X-Courier-Session-Id`).                                                                                 |
| `vault_deleted`     | `vaultId: string`                               | The vault was deleted; the client should disconnect and clean up its local settings                                                                                                                                                                                                                                                                                                                         |
| `vault_settings`    | `vaultId`, `historyLimits`                      | The vault's retention limits changed (`{ documents, attachments }`), on another device or through `PATCH /api/vaults/:id`. Display state only — the server applies the limits itself when it trims — so a host forwards it to whatever shows them; an open settings page repaints without being reopened.                                                                                                   |
| `api_key_revoked`   | `vaultId: string`                               | The user key was revoked (the account and its vaults were deleted); the client should disconnect and drop the binding                                                                                                                                                                                                                                                                                       |
| `api_key_disabled`  | `vaultId: string`                               | The account was disabled by the host: the key and all its data are still there, so the client should stop and **keep** the binding (a pause it can resume from), not forget the key                                                                                                                                                                                                                         |

### Heartbeat

The server sends `{ "type": "ping" }` every 30 seconds, and the client must reply
`{ "type": "pong" }`.
If the client receives no message for 60 seconds, it should disconnect and reconnect.

### Reconnect

The client reconnects with exponential backoff: delay = `min(1000 × 2^n, 30000)` milliseconds, where n
is the number of reconnects.
An explicit disconnect (the user clicking the Disconnect button) does not trigger a reconnect.

---

## Error format

Every error returns the same structure:

```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable description",
  "details": [{ "field": "name", "message": "Must be at least 1 character" }]
}
```

| Field     | Description                                   |
| --------- | --------------------------------------------- |
| `error`   | Machine-readable error code                   |
| `message` | Human-readable error description              |
| `details` | (optional) Validation errors listed per field |

### Error code list

| Error code              | HTTP status code | Description                                                                     |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`      | 422              | Request body validation failed                                                  |
| `UNAUTHORIZED`          | 401              | Missing Bearer Token or invalid Token                                           |
| `NOT_FOUND`             | 404              | The resource does not exist                                                     |
| `KEY_EXPIRED`           | 403              | The user key or host key has expired                                            |
| `KEY_DISABLED`          | 403              | The host disabled the account; its data is kept                                 |
| `INSUFFICIENT_SCOPE`    | 403              | The host key lacks the scope this endpoint needs                                |
| `RATE_LIMITED`          | 429              | Too many requests; `Retry-After` states the seconds until the window ends       |
| `QUOTA_EXCEEDED`        | 413              | Exceeds the user's storage quota                                                |
| `VAULT_LIMIT_REACHED`   | 409              | The account already owns its allowed vaults                                     |
| `PAYLOAD_TOO_LARGE`     | 413              | The push body exceeds `SYNC_MAX_PUSH_BYTES`                                     |
| `RANGE_NOT_SATISFIABLE` | 416              | The `Range` cannot select any byte; `Content-Range: bytes */<size>` is returned |
| `INTERNAL_ERROR`        | 500              | Internal server error                                                           |

---

## Client key derivation reference

The following describes client-side operations. They are not part of the server API, but they are
needed to understand how requests are constructed.

### Create a vault

```
1. encryptionSalt = crypto.randomBytes(32)          // uploaded to the server

2. key = PBKDF2(
     password,
     encryptionSalt,
     iterations: 600_000,
     hash: SHA-256,
     keyLength: 32
   )

3. keyCheck = AES-256-GCM(key, "courier-key-check") // base64(iv‖ct‖tag), uploaded to the server

4. POST /api/vaults {
     name,
     encryptionSalt,
     keyCheck
   }

5. save locally: { id, encryptionSalt }
```

### New device onboarding

```
1. the user enters the vault ID + password

2. GET /api/vaults/:id/encryption-salt
   → encryptionSalt

3. GET /api/vaults/:id/key-check
   → keyCheck

4. key = PBKDF2(password, encryptionSalt, 600000, SHA-256, 32)

5. decrypt keyCheck locally:
   succeeds and plaintext == "courier-key-check" → the password is correct
   fails → the password is wrong

6. save locally: { id, encryptionSalt }
```

### Key model

```
password
  └── encryptionSalt → PBKDF2 → AES-256-GCM Key
        ├── encrypts/decrypts file content and paths
        └── encrypts/decrypts the keyCheck canary (local password verification)
```

`encryptionSalt` is 32 random bytes, stored on the server together with `keyCheck`; both are public
data. Holding them only allows an offline brute-force guess at the password (slowed down by PBKDF2's
600k iterations); it does not allow decrypting content directly — password strength is the last line of
defence for content confidentiality.

---

## Sync endpoints

The endpoints below handle file sync. Every sync endpoint requires user key Bearer Token authentication
(`Authorization: Bearer ck_...`). **Vault ownership must match too**: only the vault's owner can use it
(an owner-less legacy vault is usable by any authenticated user, the same rule as
`PATCH`/`DELETE /api/vaults/:id`); a vault the account cannot see is answered **`404 NOT_FOUND`
(`Vault not found`)**, exactly like one that does not exist. Not `401`: a client reads that as "your key is
dead" and may drop a perfectly valid credential, and a `404` also refuses to confirm that someone else's
vault id exists. The content itself is end-to-end encrypted, so this check protects **integrity and
quota** — without it, any valid `ck_` key that knows someone else's vaultId could push, pull, read history
and empty the recycle bin. The device name used for version attribution is self-declared in the push frame
header (see below), and **there is no device identity header**. **Host keys (`ak_`) are no longer accepted
by sync
endpoints** — they are management credentials, not sync credentials.

### 9. Push local changes

```
POST /api/vaults/:id/sync/push
```

Pushes local file changes to the remote. The server makes no conflict **merge** decision (conflict
detection stays on the client), but it does perform one **conditional check**: every push declares which
version it based its decision on (`baseVersionId`), and if that version is no longer the current head of
that file's chain, the push is rejected (`stale_base`) and nothing is written. A client that pushes from
a stale version chain therefore never overwrites a version it did not read. Version chains are
append-first and merge-later — a rejection happens only in the one case "the head has already moved".

This check is **atomic**: reading the chain head and writing the version happen in the same transaction
(`bun:sqlite`'s synchronous transaction, where the callback may not `await`), so two pushes based on the
same chain head cannot both succeed — including when both requests are in flight at once and one is
slower because it is writing a large blob. Otherwise the push that arrived first would be overwritten by
the one that finished last, and the head would become "the last write to finish" instead of "the write
based on the newer head". One transaction covers the **whole batch**; each file of it is still checked
against its own chain head inside that transaction.

### Rate limits

The sync routes are request-limited per vault, in a fixed 60-second window. A refused request answers
`429 RATE_LIMITED` with a standard `Retry-After` header (seconds). The defaults are sized for a **first
bind**, not for a steady-state edit:

| Budget     | Routes                                                       | Default      | What it bounds                           |
| ---------- | ------------------------------------------------------------ | ------------ | ---------------------------------------- |
| `sync`     | push, pull, index, versions, history, deleted, clear-deleted | 600 / min    | 60 000 files/min at 100 files per push   |
| `transfer` | version content, chunk staging, upload status                | 60 000 / min | one request per file on a first download |

A steady-state device uses a handful of requests per edit, so neither budget is close to binding there.
A first bind is the largest burst a client ever sends, and a budget below it turned every connect of a
large vault into a failed pass followed by retries (see
[first-bind-performance.md](first-bind-performance.md)). Both are overridable with
`SYNC_RATE_LIMIT_MAX_ATTEMPTS` / `SYNC_RATE_LIMIT_WINDOW_MS` and
`SYNC_TRANSFER_RATE_LIMIT_MAX_ATTEMPTS` / `SYNC_TRANSFER_RATE_LIMIT_WINDOW_MS`. A client that is refused
should wait `Retry-After` and retry the same request; the engine does exactly that for pushes and for
content reads, so a first download of a 50 000-file remote vault completes inside one pass.

**Request headers**

```
Authorization: Bearer ck_xxxxxxxxxxxx
```

Optional request headers:

| Header                 | Description                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Courier-Session-Id` | This device's current WebSocket session id (returned by `subscribe_success`). When present, the server does not send this push's `file_pushed` back to that session, so the client does not receive its own echo; a one-shot run (no WebSocket) may omit it. |

**Request body**

The request body is a **binary frame**, not JSON:

```
[ 4 bytes little-endian: header length ][ header JSON (UTF-8) ][ each file's ciphertext, concatenated in header order ]
```

The header JSON looks like
`{ "deviceName"?: "…", "files": [ { …, "contentLength": <byte count of this file's ciphertext> } ] }`;
each file's ciphertext follows the header in order. Why not JSON + base64: base64 inflates every payload
by 4/3 both on the wire and on disk, and the encoding/decoding itself is the most expensive step for
large files on the client (about 50 ms/MiB measured; a 20 MiB attachment takes over a second just to
encode, slower than the encryption itself). Raw bytes also make blob storage binary files, saving the
same 25% on disk and on every read-back.

`deviceName` lives in the JSON header rather than an HTTP header because it is user-visible text (a
Chinese device name is legal, an HTTP header value is not).

Sender and receiver share one implementation: `wire.ts` in `@courier/shared` (`buildPushBody` /
`parsePushBody`), so the two sides agree by construction.

**Header fields**

| Field                   | Type           | Required | Description                                                                                                                                                                                                                                                         |
| ----------------------- | -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deviceName`            | string \| null | No       | The pusher's self-declared display label (≤ 100 characters), written onto every version row of this push; absent/blank is treated as `null`                                                                                                                         |
| `files[].fileId`        | string         | Yes      | UUID, assigned when the file is created and never changing (a rename does not change it)                                                                                                                                                                            |
| `files[].encryptedPath` | string         | Yes      | The AES-256-GCM-encrypted file path (1–512 characters)                                                                                                                                                                                                              |
| `files[].contentLength` | number         | Yes      | Byte count of this file's ciphertext (`0` = no content in this push, see below)                                                                                                                                                                                     |
| `files[].action`        | string         | Yes      | `create` / `modify` / `rename` / `delete` / `restore`                                                                                                                                                                                                               |
| `files[].versionId`     | string         | Yes      | UUID uniquely identifying this version event                                                                                                                                                                                                                        |
| `files[].contentHash`   | string         | Yes      | SHA-256 hash of the file's plaintext (64 hex characters), used for content addressing and integrity checks                                                                                                                                                          |
| `files[].sizeBytes`     | number         | Yes      | The version's **plaintext byte count**; only a `delete` version passes `0`                                                                                                                                                                                          |
| `files[].mtimeMs`       | number         | Yes      | The file's **last modification time** on the pusher's device (Unix milliseconds). Stored as metadata only and not used to order the chain head; for conflicts inside the config folder (`.obsidian/`) the client uses it to compare "who modified last" (see below) |
| `files[].baseVersionId` | string \| null | Yes      | The chain-head version id this push is based on; the client passes `null` when it believes the file has no version yet (a new file)                                                                                                                                 |
| `files[].contentChunks` | number         | No       | Number of chunks staged for this file; positive means `contentLength: 0` and the server assembles the blob before inserting the row (see **Chunked uploads**)                                                                                                       |
| `files[].historyKind`   | string         | Yes      | `documents` (markdown / canvas) or `attachments` (every other file). The client states it because only the plaintext path can say; the server maps it to the **vault's** own limit (see **History limit** below)                                                    |

> `sizeBytes` is **metadata for clients**: it plans a chunked transfer and drives the progress report.
> It does **not** decide whether a peer accepts the version — each user key's file cap (see 7b) bounds
> what that key's devices **send**, and a version already in the store is materialised by every device
> whatever its own cap says. The server
> does **not** use it for quota accounting — the quota is based on the bytes the store actually writes
> (the payload plus the stored frame's header), so a client cannot under-report the size to get around
> the storage limit. The
> server sets no file size limit of its own: a large file is rejected only by the user's
> `storage_bytes_limit` (`QUOTA_EXCEEDED`).
>
> `sizeBytes` is also the **real plaintext size** for a `rename` version, even when that push carries no
> content (see below), so a device that never had the file still knows what it is about to pull.
>
> `mtimeMs` is the modification time reported by the pusher's **own filesystem** (something like
> `TFile.stat.mtime` / `fs.stat.mtimeMs`). A `delete` has no file to timestamp, so the client passes the
> moment it decided to delete. The server only stores the column (`file_versions.mtime_ms`) and returns
> it unchanged, **using it for no decision at all**, and does not use it to order the version chain
> either: the chain order remains `(created_at, rowid)`. It exists for exactly one reason — `.obsidian/`
> config-folder conflicts in a device-local sync scope: a conflict copy there is invisible to Obsidian,
> so the client instead compares the local file's time with that version's `mtimeMs`, the newer side
> wins and **no conflict copy is produced**. Clock skew between the two ends makes one device
> systematically win or lose; that is the inherent cost of "last modified wins".

**A push without content (`contentLength: 0`)**

A `delete` never carries content. Beyond that, a `rename` may also omit it when **the server already
holds bytes for that `contentHash`**: moving a 40 MiB attachment then becomes a tiny request instead of
uploading the whole file again (the client makes that call based on "this file's sync point is exactly
this content").

The server **does not take that claim on faith**: when no content is sent and the action is not
`delete`, it first confirms the store really has that hash, and otherwise returns `content_missing`
(nothing at all is written for that file); the client then **re-pushes with content** once. That way a
version chain never points at content nobody can pull.

**Chunked uploads (`files[].contentChunks > 0`)**

A client may send a file's content in chunks instead of in the push body — that is what keeps a large
file's memory bounded. The bytes are uploaded first, one encrypted chunk per request (4 MiB of plaintext
plus the 28 bytes of IV and tag; the last chunk is shorter), and the push then names the upload with
`contentChunks` and carries `contentLength: 0`:

| Step | Request                                                                                          | Notes                                                                                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `PUT /api/vaults/:id/sync/blobs/:contentHash/chunks/:index?chunkCount=<n>&plaintextSize=<bytes>` | body is one chunk; answer `{ "received": <contiguous prefix> }`. Idempotent per index                                                                                            |
| 2    | `GET /api/vaults/:id/sync/blobs/:contentHash/status`                                             | `{ "received": <n>, "complete": <bool> }` — the resume point after a reconnect; a committed upload answers `complete: true` from its blob                                        |
| 3    | `POST /api/vaults/:id/sync/push` with `contentChunks: <n>`                                       | the server assembles the staged chunks into the blob **before** it inserts the version row; an incomplete upload is refused with `error: "chunk_missing"` and nothing is written |

`chunkCount` must equal `ceil(plaintextSize / 4 MiB)`; a chunk whose body is not the expected stored
size for its index is refused with `422`, and a chunk that would push the account past its storage
limit is refused with `413` **before it is written** (staged chunks are part of the storage the account
holds). The response of step 1 is the resume point: the server reports the **contiguous** prefix, so a
retry can continue at `received`. A staged upload that is never committed is reclaimed after
`UPLOAD_TTL_MS` (24 h by default) by its own sweep, independent of retention pruning. See
`docs/server.md` for the stored frame.

**A version travels one way or the other.** `content` and `contentChunks` are mutually exclusive, and
the split is by **size**, so a reader can tell a version's framing from its `sizeBytes`:

- `sizeBytes > 8 MiB` (the chunking threshold in `@courier/shared`) must be uploaded in chunks — a push
  carrying such a payload is refused with `422`;
- `sizeBytes <= 8 MiB` must travel as one payload — a chunked push at or below the threshold is refused
  with `422`, as is a `chunkCount` that does not match `sizeBytes`.

A payload's length must also agree with the row: `contentLength` is `sizeBytes + 28` (IV and tag). A
mismatch is answered per file with `error: "size_mismatch"` and writes nothing, because a peer sizes its
read ranges and buffers from `sizeBytes`.

**History limit (`files[].historyKind` + the vault's row)**

How many versions of a chain the server keeps is a **property of the vault**, not of the device and
not of the account: `vaults.history_limit_documents` (default 200) and `vaults.history_limit_attachments`
(default 10), read/written through `PATCH /api/vaults/:id` and returned by `GET /api/vaults`. Every
device of that vault is therefore trimmed by the same numbers — the plugin's settings page and the CLI
edit that one row — and the value a device _pushes_ is only the file's **kind** (`historyKind`),
because the category is visible in the plaintext path and nowhere else.

The server applies the limit in the same transaction that appends the row: a chain is trimmed to its
newest N rows — the version just pushed is always kept, so a limit of 1 leaves only the current state —
and the content hashes of the removed rows are collected. After the commit, each of those blobs is
deleted **only if no remaining version row of the vault still names it** (the same bytes may be another
file's content), and its file goes with the last row that named it. A push that trims nothing reclaims
nothing.

Because the numbers live on the vault, a **lowering** is applied without waiting for the next push: the
`PATCH` trims every chain of the vault to the new values (the same row deletion and blob reclaim, per
chain, choosing the limit from the chain's `history_kind`) before it answers. A chain no device touches
again is therefore bounded too. The deleted versions are not recoverable afterwards.

Trimming is independent of the account's `retentionDays` window (7b), which prunes by **age** in a
scheduled pass; both can apply to the same vault.

**Example** (header part; the actual request body continues with the ciphertext immediately after it)

```json
{
  "files": [
    {
      "fileId": "550e8400-e29b-41d4-a716-446655440000",
      "encryptedPath": "base64_encrypted_path...",
      "contentLength": 24941,
      "action": "modify",
      "versionId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "contentHash": "a1b2c3d4e5f6...",
      "sizeBytes": 24913,
      "mtimeMs": 1760000000000,
      "baseVersionId": "550e8400-e29b-41d4-a716-446655440000",
      "historyKind": "documents"
    }
  ]
}
```

**Request body size limit**: `SYNC_MAX_PUSH_BYTES` (256 MiB by default). Anything larger is rejected up
front by `content-length` with `413 PAYLOAD_TOO_LARGE`, without reading the whole body into memory first;
a malformed frame (length mismatch, undeclared trailing bytes, a header that is not JSON) is rejected
with `422 VALIDATION_ERROR`.

**Response** `200 OK`

```json
{
  "results": [
    {
      "fileId": "550e8400-e29b-41d4-a716-446655440000",
      "status": "ok",
      "versionId": "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      "contentHash": "a1b2c3d4e5f6..."
    },
    {
      "fileId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
      "status": "stale_base",
      "currentVersionId": "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
    }
  ]
}
```

`status` values:

| Value             | Meaning                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`              | The version was appended.                                                                                                                                                                                                                                                                                               |
| `stale_base`      | The current head of that file's chain is not the `baseVersionId` this push declared, and **nothing in this push was written** (no blob, no version row, no `file_pushed` broadcast). `currentVersionId` is the head the server actually holds; the client should re-pull the chain from it, decide again and then push. |
| `content_missing` | That push carries no content and the store has no `contentHash` matching what it declared. Again nothing was written; the client should **re-push with content** once (the safety net for `rename` content reuse).                                                                                                      |
| `error`           | Any other failure; the `error` field gives the reason.                                                                                                                                                                                                                                                                  |

**Notes**

- Encrypted file content is stored in a filesystem keyed by `contentHash` (identical content is
  deduplicated automatically) and **kept as raw ciphertext (binary)**, no longer base64 text
- A `delete` action writes no blob (a delete row has no content)
- At most 100 files per push
- The server does not **adjudicate** conflicts: when both sides changed the same file, the client
  decides the conflict itself after being rejected on `baseVersionId`; the server only guarantees that
  the premise "the head has not moved" holds
- When the server has **no version at all** for a `fileId` it accepts any `baseVersionId` (a non-null
  one included): there is no version to overwrite at that point (the chain may have been emptied by the
  recycle bin or pruned by retention), and rejecting would leave a client holding an old `versionId`
  permanently unable to push
- The head and the version chain are ordered by `(created_at, rowid)`, with `rowid` breaking ties that
  `created_at` (millisecond-precision text) cannot distinguish: the client takes `baseVersionId` from
  the chain tail, so if the two sides disagreed on the order of a tie, that client's pushes would be
  rejected forever
- Push results are returned per file (`results[]`), and one file failing does not affect the rest

---

### 10. Pull version chains

```
POST /api/vaults/:id/sync/pull
```

Fetches the remote version chains of files (ordered oldest to newest). Each version entry contains
`versionId` (UUID) and `contentHash` (SHA-256). The client decides the sync direction by comparing its
local `contentHash` with the remote version chain.

**Request headers**

```
Authorization: Bearer ck_xxxxxxxxxxxx
```

**Request body**

| Field            | Type   | Required | Description                                        |
| ---------------- | ------ | -------- | -------------------------------------------------- |
| `files[].fileId` | string | Yes      | File UUID (assigned by the client, never changing) |

**Example**

```json
{
  "files": [
    { "fileId": "550e8400-e29b-41d4-a716-446655440000" },
    { "fileId": "550e8400-e29b-41d4-a716-446655440001" }
  ]
}
```

**Response** `200 OK`

```json
{
  "files": [
    {
      "encryptedPath": "base64_encrypted_path...",
      "versions": [
        {
          "versionId": "uuid-1",
          "contentHash": "abc123...",
          "action": "create",
          "sizeBytes": 24913,
          "mtimeMs": 1760000000000,
          "createdAt": "2026-06-10T21:00:00.000Z"
        },
        {
          "versionId": "uuid-2",
          "contentHash": "def456...",
          "action": "modify",
          "sizeBytes": 25104,
          "mtimeMs": 1760000600000,
          "createdAt": "2026-06-11T10:00:00.000Z"
        }
      ]
    }
  ]
}
```

**Notes**

- If a file has no sync record, `versions` is an empty array
- The client decides push/pull/conflict by comparing `lastKnownContentHash` with the `contentHash`
  values in the version chain
- `versionId` is the unique UUID of each version event, `contentHash` is the SHA-256 of the file content
- `sizeBytes` lets the client decide, before `GET /sync/versions/:contentHash/content`, whether that
  version exceeds its own size cap; a `delete` version is `0` (a delete carries no content and every
  device should accept it)
- `mtimeMs` is the file's modification time on the pusher's device when that version was written; for
  conflicts inside `.obsidian/` it is compared with the local file's time, the newer side wins and no
  conflict copy is produced (the server takes no part in that decision)

---

### 11. Get version content

```
GET /api/vaults/:id/sync/versions/:contentHash/content
```

Fetches encrypted file content by contentHash. **The response body is the stored ciphertext itself**:
`iv ‖ AES-256-GCM ciphertext ‖ tag`, `Content-Type: application/octet-stream`. The caller is already
asking by hash, so there is no envelope to parse and no base64 — that would add a third more bytes on the
wire and a decode step in front of every pull. A body of at most 256 KiB is read into memory and answered
from one buffer; anything larger — and every `Range` — is **streamed** from the blob store, so the server's
memory is the stream's buffer, not the file. The store's own frame (a 24-byte header plus chunks) never
crosses the wire; this route serves the chunk region only, so a chunked version is the concatenated
chunk ciphertexts and `Range` applies to those bytes (see `docs/server.md`).

**Request headers**

```
Authorization: Bearer ck_xxxxxxxxxxxx
Range: bytes=<start>-<end>        (optional)
```

**Path parameters**

| Parameter     | Description                               |
| ------------- | ----------------------------------------- |
| `id`          | Vault ID                                  |
| `contentHash` | Content hash (SHA-256, 64 hex characters) |

**Response** `200 OK`

```
Content-Type: application/octet-stream
Content-Length: <ciphertext byte count>
Accept-Ranges: bytes

<iv ‖ ciphertext ‖ tag>
```

**Partial content** `206 Partial Content`

```
Range: bytes=0-1048575
→ 206
Content-Type: application/octet-stream
Content-Length: 1048576
Content-Range: bytes 0-1048575/<ciphertext byte count>
Accept-Ranges: bytes
```

One range is supported, in the three forms `start-end`, `start-` and the suffix form `-length`; an end
past the blob is clamped to its last byte, and a value beyond 2^53 is still read as written (a huge
start is unsatisfiable, a huge end clamped). A malformed header, another unit or a multi-range request
is **ignored** (the whole body is served), which RFC 9110 permits. A range that starts at or past the
end — including any range on an empty blob — is unsatisfiable.

`HEAD` answers the same status and headers as `GET` with no body; it does not read the blob, so
checking a 200 MiB version's size costs no disk I/O.

**Errors**

| Status code | Error code              | Description                                                                                  |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `404`       | `NOT_FOUND`             | The version content does not exist (including a `contentHash` that is not 64 hex characters) |
| `416`       | `RANGE_NOT_SATISFIABLE` | The range cannot select any byte; `Content-Range: bytes */<size>` is set                     |

---

### 11a. Chunked uploads

The two endpoints behind `files[].contentChunks` (see §9, **Chunked uploads**): a large file is uploaded
as independent encrypted chunks, and the push that names them assembles the blob. Neither endpoint
authenticates a chunk — the server has no key — it only checks the lengths and stores the parts; the
client's per-chunk AEAD and the whole-file content hash are what a reader verifies.

**`PUT /api/vaults/:id/sync/blobs/:contentHash/chunks/:index`**

```
?chunkCount=<n>&plaintextSize=<bytes>
Content-Type: application/octet-stream

<iv ‖ ciphertext ‖ tag>          (4 MiB of plaintext + 28 bytes, or the shorter last chunk)
```

`chunkCount` must equal `ceil(plaintextSize / 4 MiB)`; `index` must be `< chunkCount`. A body whose length
is not the stored size for that index is refused (`422 VALIDATION_ERROR`), as is a chunk whose
`chunkCount`/`plaintextSize` disagrees with the first chunk of the same hash. Sending an index again
overwrites it — a retry is safe.

**Response** `200 OK`

```json
{ "received": 7 }
```

`received` is the **contiguous** prefix on disk (chunks `0 … received-1`), which is where a reconnecting
client resumes.

**`GET /api/vaults/:id/sync/blobs/:contentHash/status`**

**Response** `200 OK`

```json
{ "received": 7, "complete": false }
```

`404 NOT_FOUND` when no chunk for that hash was ever received. A staged upload is reclaimed after
`UPLOAD_TTL_MS` (24 h by default), so a client that comes back much later starts over.

### 12. File version history

```
GET /api/vaults/:id/sync/versions?fileId=...
```

Fetches the full version history of a single file (for UI display).

**Request headers**

```
Authorization: Bearer ck_xxxxxxxxxxxx
```

**Query parameters**

| Parameter | Required | Description                                        |
| --------- | -------- | -------------------------------------------------- |
| `fileId`  | Yes      | File UUID (assigned by the client, never changing) |

**Response** `200 OK`

```json
{
  "versions": [
    {
      "versionId": "uuid-1",
      "contentHash": "abc123...",
      "encryptedPath": "base64_encrypted_path...",
      "action": "create",
      "sizeBytes": 1234,
      "mtimeMs": 1760000000000,
      "deviceName": "MacBook",
      "createdAt": "2026-06-10T21:00:00.000Z"
    }
  ]
}
```

| Field                      | Description                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `versions[].versionId`     | The UUID of that version event                                                                             |
| `versions[].contentHash`   | SHA-256 of that version's content (the empty-string hash for a `delete` version)                           |
| `versions[].encryptedPath` | **That version's own** encrypted path (a version from before a rename records the old path)                |
| `versions[].action`        | `create` / `modify` / `rename` / `delete` / `restore`                                                      |
| `versions[].deviceName`    | The label the pusher self-declared when writing that version; `null` when none was given                   |
| `versions[].sizeBytes`     | The version's **plaintext** size (`0` for `delete`; a `rename` records the real size even without content) |
| `versions[].mtimeMs`       | The file's modification time on the pusher's device when that version was written (Unix milliseconds)      |
| `versions[].createdAt`     | The version's timestamp (ISO 8601)                                                                         |

**Notes**

- `deviceName` is **the name recorded at the time**: a rename affects only later versions, old versions
  keep the old name, so history shows the rename
- A `delete` version has no content blob to fetch (see section 11), so the UI should not treat it as a
  restorable version

---

### 13. Vault sync history

```
GET /api/vaults/:id/sync/history
```

Fetches the full version-chain history of the entire vault (all files and their version
lists).

The plugin's sync-history dialog no longer calls this: it renders **this run's** activity
log, kept in memory and fed by the engine (see `docs/plugin.md`). The endpoint remains the
server-side answer for diagnostics and any client that wants the vault's whole history.

**Request headers**

```
Authorization: Bearer ck_xxxxxxxxxxxx
```

**Response** `200 OK`

```json
{
  "files": [
    {
      "fileId": "550e8400-e29b-41d4-a716-446655440000",
      "encryptedPath": "base64_encrypted_path...",
      "currentVersionId": "latest-uuid...",
      "currentContentHash": "latest-hash...",
      "versions": [
        {
          "versionId": "uuid-1",
          "contentHash": "abc...",
          "encryptedPath": "...",
          "sizeBytes": 1234,
          "mtimeMs": 1760000000000,
          "action": "create",
          "deviceName": "MacBook",
          "createdAt": "..."
        }
      ]
    }
  ]
}
```

---

### 13a. Vault sync index (for engine cold start)

```
GET /api/vaults/:id/sync/index
```

The lightweight index the engine reads on every reconcile pass: **one head row per chain**. Unlike 13
(`/sync/history`, which returns the vault's full version stream), this returns no historical
versions, so the payload grows only with the number of files, not with the vault's age.

- `head`: the chain's current latest version, using the same ordering as the conditional-push head check
  (`created_at`, then `rowid`).
- `previousLive`: only when `head.action === "delete"`, the last non-`delete` version on the chain;
  otherwise `null`. The engine uses it to decide "whether the local content is still the version the
  tombstone deleted".
- When the chain holds only `delete` rows (or the restorable version has been pruned by retention or
  by the vault's history limit), `previousLive` is `null`.

**Request headers**

```
Authorization: Bearer ck_xxxxxxxxxxxx
```

**Response** `200 OK`

```json
{
  "files": [
    {
      "fileId": "550e8400-e29b-41d4-a716-446655440000",
      "head": {
        "versionId": "latest-uuid...",
        "contentHash": "latest-hash...",
        "encryptedPath": "base64_encrypted_path...",
        "action": "modify",
        "sizeBytes": 1234,
        "mtimeMs": 1760000000000,
        "createdAt": "2026-10-19T02:00:00.000Z"
      },
      "previousLive": null
    }
  ]
}
```

---

### 14. Deleted file list (recycle bin)

```
GET /api/vaults/:id/sync/deleted
```

Fetches every deleted file in the vault (the version chain's last action is `delete`) together with its
**latest non-`delete` version** (the restorable version), for the recycle bin UI.

**Request headers**

```
Authorization: Bearer ck_xxxxxxxxxxxx
```

**Response** `200 OK`

```json
{
  "files": [
    {
      "fileId": "550e8400-e29b-41d4-a716-446655440000",
      "lastEncryptedPath": "base64_encrypted_path...",
      "previousVersionId": "uuid-2",
      "previousContentHash": "def456...",
      "previousSizeBytes": 12582912,
      "deletedByDeviceName": "MacBook",
      "deletedAt": "2026-06-11T10:00:00.000Z"
    }
  ]
}
```

| Field                         | Description                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `files[].fileId`              | UUID of the deleted file                                                                                                 |
| `files[].lastEncryptedPath`   | Encrypted path of the restorable version (`null` when there is none)                                                     |
| `files[].previousVersionId`   | UUID of the restorable version (the latest non-`delete`; `null` when there is none)                                      |
| `files[].previousContentHash` | Content hash of the restorable version (the latest non-`delete`; `null` when there is none)                              |
| `files[].previousSizeBytes`   | Plaintext size of the restorable version (`null` when there is none); a preview needs it to tell whole-file from chunked |
| `files[].deletedByDeviceName` | The label the pusher self-declared when performing the delete (`null` when unknown)                                      |
| `files[].deletedAt`           | Timestamp of the delete event (ISO 8601)                                                                                 |

**Notes**

- Restoring needs no dedicated endpoint: fetch the content with
  `GET /sync/versions/:contentHash/content`, then push it back with `action: "restore"`
- When the chain holds only `delete` rows (retention pruning, or a vault history limit of 1, leaves such
  chains; see `packages/server/src/lib/prune.ts` and the **History limit** section above),
  `lastEncryptedPath` and `previousContentHash` are both `null`: that row has nothing to restore, and
  the UI must say so and disable restore
- `deletedByDeviceName` is simply the name recorded on the delete version row; the UI displays it
  directly, with no query needed
- `POST /sync/deleted/clear` is a wholesale and **irreversible** cleanup (deleting rows + reclaiming
  unreferenced blobs) and must be confirmed by the user before it is called; the response is
  `{ deletedFiles, deletedBlobs }` (the number of version rows deleted and the number of blobs reclaimed)
- Restorable data remains until `/sync/deleted/clear` is called

---

## Sync flow

Push and broadcast are two independent paths: changes are pushed over REST (see
[9. Push local changes](#9-push-local-changes)), and after the server accepts them it **broadcasts**
`file_pushed` to the other sessions on the same vault; a peer receives it, pulls that file's version
chain, and then decides whether to pull content or push its own version.

```
Client A                  Server                   Client B
   |                         |                         |
   |── POST /sync/push ─────>|                         |
   |<── results: [ok] ───────|                         |
   |                         |── file_pushed ─────────>|
   |                         |                         |── POST /sync/pull
   |                         |                         |── GET  /sync/versions/:hash/content
   |                         |                         |── decide push/pull/conflict
```

WebSocket carries notifications only, **never content**: content always goes through the binary response
of `GET /sync/versions/:contentHash/content`. Notifications missed while disconnected are not replayed
(the server keeps no backlog for subscribers), so both sides run a full reconcile after reconnecting.
