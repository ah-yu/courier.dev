# Server (`packages/server`)

> Status: `authoritative` for architecture and layering. The HTTP/WebSocket contract is
> [`api.md`](api.md); this document does not restate it.

## Framework, entry and database

- **Framework**: `Bun.serve` with its `routes` table — each route module exports a `RouteTable` instance; mounted in `app.ts` via `app.route()`.
- **Entry point**: `src/main.ts` starts the server; `src/index.ts` creates/exports the `Bun.serve` app (used by `main.ts` and tests).
- **Database**: Drizzle ORM with **bun:sqlite** (`DatabaseSync`), Drizzle dialect `sqlite`. Tables (`users`, `vaults`, `api_keys`, `file_versions`) in `src/db/schema.ts`. Not Neon/PostgreSQL. `vaults.owner_user_id` scopes vaults to users; `file_versions.device_name` records the pushing client's self-declared label; `users` carry per-user `storage_bytes_limit` / `retention_days` / `expires_at`; `vaults` carry the two retention limits (`history_limit_documents` / `history_limit_attachments`), and `file_versions.history_kind` records which of them a version's chain is trimmed by.
- **Migrations**: `drizzle/*/migration.sql`, applied by `courier migrate` (`bun run --filter @courier/server migrate`). A migration is identified by its directory name — never its content — and recorded in `courier_migrations (name, applied_at)`, one transaction per migration; editing a migration that is already applied has no effect, so a schema change is always a new migration. A database whose ledger holds a name this binary does not carry is refused (`upgrade the binary`). The chain starts from one generated baseline (`drizzle/*_*/migration.sql` plus its `snapshot.json`), so a fresh database gets the current schema in one step; later changes are added as new migrations, hand-written or authored with `bun run --filter @courier/server db:generate`. The chain is generated into `src/db/migrations.generated.ts` (`bun run --filter @courier/server migrations:generate`) so the single-file binary carries it without reading the filesystem; the file is committed, `build`/`build:exe` refuse a stale one (`bun scripts/generate-migrations.ts --check`), `bun run dev` and the dev `migrate` script regenerate it first, and `bun run verify` runs the same check as its `migrations` gate. `db:push`/`db:migrate` are gone because they write drizzle's own ledger and would leave this one empty.
- **Config**: `src/config.ts` (Zod) validates `SQLITE_PATH` (default `./data/courier.db`), `BLOB_STORE_DIR` (default `./data/blobs`), `PORT` (default 80 prod / 3002 dev; an explicit `PORT` in the dev environment wins, so two worktrees can run side by side), `PRUNE_INTERVAL_MS` (retention-pruning job), the `LOG_*` set (below) and the TLS/ACME set. Those relative defaults are resolved against the **executable's directory** in a build (`COURIER_ENV=production`): inside a `bun build --compile` binary `import.meta.dir` points at Bun's virtual root (`/$bunfs/root`, `B:\~BUN\root`), which the runtime reports as existing while writes into it never reach the disk — so a deployed binary must not derive its data directory from it. `resolveDataDir` rejects that path explicitly and `config.test.ts` pins the three cases (bundled, real module dir, missing module dir).

## Blobs and the push frame

Content is addressed by its plaintext hash, and the store holds the ciphertext.

- **A blob is a byte range in one immutable batch file, addressed by its plaintext hash.** A push
  batch writes `<uuid>.blob` (payloads appended, `fsync`, `rename`, directory flush) and then
  inserts the `blobs` rows that name those ranges — one file per batch, one flush per batch.
  "The row exists" therefore means "the bytes are on disk": a crash before the rename leaves a
  `.tmp` no row names, a crash before the row transaction leaves a complete file no row names, and
  both are garbage the unreferenced-file sweep deletes. Nothing is ever appended to a published
  file, so there is no committed length to recover and no compaction step: a file is unlinked when
  its last row goes. Every file with the same content (a vault of empty notes, a duplicated
  attachment) shares one blob, and the store keeps the bytes it already holds instead of rewriting
  them — which also matters for readers, since a shared blob is pulled while another client pushes
  it. One flush per batch is the whole point: 5 000 files took 22.1 s with a flush per blob, 1.9 s
  with none, and **2.5 s** with one per batch — see [blob-files.md](blob-files.md) for the layout,
  the reclaim rule and the measurements.
- **A blob is bytes, not base64 text.** The payload crosses the wire as the frame's binary content
  (`packages/shared/src/wire.ts`), so the store writes what it received and a read hands it back
  unchanged: no 4/3 inflation on disk, no encode/decode pass per file. `docs/api.md` owns the frame.
- **The stored file is a v2 frame: a 24-byte header, then chunks.** `magic "CBR2" | flags | chunkSize |
  chunkCount | plaintextSize` (`@courier/shared`'s `blob.ts`). A normal push is framed as flags `0`, one
  whole-file AES-GCM payload; a chunked upload is flags `1`, one AEAD payload per 4 MiB chunk with the
  content hash, chunk index, count and plaintext size in its additional data. The header never crosses
  the wire — the content route serves the chunk region only — so a client sees the same bytes it would
  have before, and the store gains one place to say where the chunks are. There is no v1 reader:
  pre-release changes the format in place, so an old blob has to be re-uploaded (delete and recreate
  the data directory).
- **A chunked upload is staged, then assembled by the push that names it.** Chunks land in
  `<vault>/uploads/<contentHash>/<index>.chunk` with a `meta.json`; the push's `contentChunks` makes
  the server concatenate them behind a flags-`1` header and publish the blob **before** it inserts the
  row, so a chain never points at a half-uploaded file (`chunk_missing` instead). Staged bytes count as
  storage the account holds (`sumBytes` walks them), so the chunk route checks the quota before it writes;
  a staged upload that is never committed is reclaimed by its own sweep after `UPLOAD_TTL_MS` (the sweep
  runs even when retention pruning is off). A vault deletion removes the directory with everything else.
- **An unreferenced blob is reclaimed even without retention.** A push writes the blob
  **before** the conditional insert, so a refused push (`stale_base`, `content_missing`, an error)
  can leave bytes with no row pointing at them. `sweepOrphanBlobs` runs for every vault
  (`ORPHAN_SWEEP_INTERVAL_MS`, 6 h by default) and deletes a blob older than `ORPHAN_TTL_MS` (24 h)
  that no `file_versions` row references; the age gate leaves a push that is still between its write
  and its insert alone. A blob's age is its **file's** modification time; since a file is deleted
  with its last row, there is no dead-byte backlog to wait for. A user with retention
  pruning disabled used to keep those bytes forever.
- **One push batch is one conditional-insert transaction.** `tryInsertFileVersions` reads each row's
  chain head and inserts that row inside a single `db.transaction`, so a batch of 100 files commits
  once instead of a hundred times. Each row is still checked against its **own** head — the check is
  per row, only the commit is per batch — which keeps the conditional push atomic against another
  writer. A per-file commit cost ~0.9 ms of fsync per file, nearly all of the server's marginal cost
  per file and most of a first bind's server time (see
  [first-bind-performance.md](first-bind-performance.md)); a batch that fails to insert answers every
  file in it with `error`, which is what a per-file insert answered for the one file.
- **The same transaction trims each chain to the vault's history limit.** The two limits are columns on
  the **vault** (`history_limit_documents` / `history_limit_attachments`, 200 / 10 by default), so
  every device pushing into that vault is trimmed by the same numbers; a version carries only
  `history_kind` (`documents` for markdown/canvas, `attachments` otherwise), which the server maps to
  the vault's value and stores on the row. The transaction deletes that chain's rows past the newest N
  with one `LIMIT -1 OFFSET <n>` selection ordered `(created_at DESC, rowid DESC)` — the same order
  every reader calls "newest", and the version just appended is always inside the kept window. The
  removed rows' content hashes are returned to the handler, which after the commit deletes each blob
  **only if no remaining `file_versions` row of the vault still names it** (the same bytes may be
  another file's content) — the `(vault_id, content_hash)` index makes that one look-up rather than a
  walk of the vault. A failed reclaim is not a failed push: the row is committed, and
  `sweepOrphanBlobs` is the backstop.
- **Lowering a limit trims the whole vault, without waiting for a push.** `PATCH /api/vaults/:id`
  writes the new numbers and then runs `trimVaultHistory` (`lib/history-trim.ts`): one window-function
  query ranks every chain and picks the rows past the limit its chain's head kind names, deletes them
  in one transaction, and reclaims the blobs that became unreferenced (the same rule as the push path).
  It is idempotent, which is what lets a retried `PATCH` finish a job whose first attempt failed. Raising
  a limit trims nothing. The age-based `retentionDays` pass is separate and unaffected.
- **A batch's blobs go into one file, and the file is flushed once.** One push carries at most 100
  files; the handler writes their payloads into the batch's file instead of paying one store round
  trip and one `fsync` per file, and checks presence afterwards so a `rename` in the same batch finds
  the bytes a `create` in it wrote. The file is `fsync`ed, renamed into place, and only then do the
  rows that name it commit, so a committed row always means readable bytes. The flush is the entire
  upload cost of a first bind: ~4.5 ms per small blob on APFS made 5 000 files take 22.1 s, against
  1.9 s with no flush at all and 2.5 s with one per batch (see
  [first-bind-performance.md](first-bind-performance.md)).
- **Only a readable range counts as a blob.** `hasBlob` answers from the row **and** what the disk
  says: the file must exist and be at least `offset + length` long, and a short read answers absent
  rather than a partial payload. A truncated or missing file therefore reads as absent — a
  content-less push is refused `content_missing` instead of being accepted against unreadable bytes,
  a staged upload replaces it, and `writeBlob` never reports success over it. A re-push of the same
  content **repoints** the row at the copy it writes, so the hash is repairable instead of stuck.
  Paths are scoped to the vault's own directory, so an encoded `..%2F` cannot name another vault's
  file, and the content route only accepts a 64-hex hash.
- **A read gives back exactly the bytes the row names, and a client may ask for one range.**
  `openBlobReader` opens the file once and checks its length against the row before anything is
  served, so a truncated file answers 404 instead of a short `200`. A body of at most 256 KiB is
  answered from one positional read; anything larger — and every `Range` — is streamed (64 KiB
  buffers) from the same handle, so the size, the header and the stream all describe one inode and
  a concurrent reclaim cannot leave a committed `200` with a `Content-Length` and no body.
  `Range: bytes=…` selects one block (`206` + `Content-Range`; a 416 carries
  `Content-Range: bytes */<size>`), and a `HEAD` answers the same headers without opening a stream —
  it does not read the blob. `lib/byte-range.ts`
  owns the resolution in `BigInt` (so a value past 2^53 is not silently ignored); the bytes are the
  stored ciphertext either way, and the route is the only reader (the whole-file `readBlob` is for tests).
  A committed chunked upload answers `status` with `complete: true` from its assembled blob, so a client
  whose push response was lost does not stage the whole file again.
- **The push is a binary frame, and a version may carry no content.** `POST …/sync/push` takes
  `[4-byte header length][header JSON][ciphertexts in header order]`, up to 100 files per request;
  the same module builds it on every host and parses it on the server, so both ends agree by
  construction. A `delete` never carries content, and a `rename` omits it when the store already
  holds the same `contentHash` — moving a large attachment is then a small request instead of a
  second upload. The server verifies that claim rather than trusting it (`content_missing`) and the
  client re-pushes with the payload; a chain can never point at content nobody can fetch. The frame
  is bounded by `SYNC_MAX_PUSH_BYTES` (default 256 MiB) and refused with 413 before it is read.

## TLS and ACME

- **TLS is the server's own job, and only a deployed instance uses it.** With `TLS_NAME` (the IP literal or DNS name the service is reached at) **unset** the process serves plain HTTP exactly as the dev loop and the L1/L2 harnesses need it. With it set — the deployment always sets it — the main listener is an `https.Server` (`serve({ createServer: https.createServer, serverOptions })`) with the same `WebSocketServer` attached, serving `TLS_CERT_FILE`-style state from `TLS_DIR` (`./data/tls`: `account.key`, `privkey.pem` both 0600, `fullchain.pem`). The default is resolved against the executable's directory (or the package directory in dev, see `basedir` above); a deployment passes an absolute `TLS_DIR` outside the service directory (`%h/.courier-tls`), so deleting the service leaves the certificate for the next deployment to the same address. The certificate is a **Let's Encrypt IP certificate issued by an ACME client inside the process** (`src/lib/acme/*` — hand-rolled RFC 8555, JWS/ES256 and a hand-rolled PKCS#10 DER encoder with an `iPAddress` SAN in `src/lib/tls/csr.ts`): no ACME dependency, no certbot, no `openssl`, no root. The http-01 challenge is served by a second plain-HTTP listener on `ACME_CHALLENGE_PORT` (80) that answers nothing but `/.well-known/acme-challenge/<token>` — that port is the only reason the deployed binary needs `cap_net_bind_service`. An IP identifier must request the ACME **`shortlived` profile** (LE requires it; the certificate is 160 h), so a background loop (single-flight, every 6 h) issues when under 72 h remain and `setSecureContext()` swaps the new certificate into the running listener — a renewal restarts nothing and drops no connection. When no usable certificate exists yet the listener starts anyway and handshakes fail until issuance finishes. `ACME_DIRECTORY_URL` overrides the directory (tests, staging). Clients need no change at all: `https://…` is what the plugin's and the CLI's `http`→`ws` rewrite already turns into `wss://…`.

## Auth model

- **Auth model** (details in `docs/api.md`):
  - **Key check (canary)**: at vault creation the client derives an AES key locally (`PBKDF2(password, encryptionSalt, 600K, SHA-256)`) and stores `keyCheck = AES-256-GCM(key, KEY_CHECK_VALUE)` on the server. Any client verifies the vault password locally by decrypting the canary — the password never reaches the server, and there are no vault tokens.
  - **User key (`ck_...`)**: the single account/sync credential in the shared multi-user model — one per user, shared by all their clients, each of which states its own display label on every push (no device registry, no per-device key). Users are created by the host via `POST /api/users` / `PATCH` / `DELETE` (the admin API is the reference client), and each carries three limits the **server** enforces: `expiresAt` (refused at the route, `KEY_EXPIRED`), `storageBytesLimit` (checked before a push writes anything — `413 QUOTA_EXCEEDED` for the whole batch, with content the store already holds left out of the count; usage is per-user blob bytes, cached 30 s and adjusted by what a push wrote, so a limit can be overshot by about one window), and `maxVaults` (checked by `POST /api/vaults` in the same transaction that inserts the vault — `409 VAULT_LIMIT_REACHED`; `1` by default, `0` = unlimited). A fourth field, `disabled`, is a **reversible stop**: the key, its vaults and every version stay, but `assertUserActive` refuses it everywhere (`403 KEY_DISABLED`) and a PATCH that sets it revokes the account's live sessions with `api_key_disabled`. `PATCH` also refuses the three edits that would strand the account (`422`, see `docs/api.md` §7b): a cap below current usage, an allowance below the vaults owned, and an expiry in the past.
  - **Deleting a user deletes its vaults.** `users-db.ts`'s `deleteUser` removes the owned vault rows (chains cascade) in the same transaction as the user row and answers their ids, and the route reclaims each vault's blobs and invalidates both usage caches. Leaving them behind is the trap the schema sets: `vaults.owner_user_id` is `ON DELETE SET NULL`, so a surviving vault becomes an owner-less row that **any** account may list, push to and delete, with its blobs charged to nobody.
  - **Host key (`ak_...`)**: the admin/host credential for `/api/users` and `/api/admin/*`. Each key carries a **scope** (`admin` — implies every other — / `status` / `users`) and an optional expiry, both enforced by `createApiKeyAuth` (403 `KEY_EXPIRED` / `INSUFFICIENT_SCOPE`). Stored in plaintext in `api_keys.key`; **not** a sync credential.
  - `apiKeyAuth` validates Bearer host keys (scope + expiry); `userAuth` validates `ck_` user keys (rejects expired) and backs `GET /api/me` — the one read that tells a `ck_`-only client which account it is signed in as (the name the plugin's account row shows; `ak_` keys are refused there); `syncAuth` accepts **only** `ck_` user keys and resolves the vault from the `:id` param; the WebSocket `subscribe` likewise accepts only `ck_` and takes the client's self-declared `deviceName` as display-only metadata; sync pushes carry that label in the push frame, which the server writes onto every version row (`file_versions.device_name`) — there is no device identity to validate or revoke.
  - **Using a vault is scoped to its owner.** `canAccessVault` (`lib/vault-access.ts`) is the one predicate — the owner, or any authenticated user for an owner-less legacy vault — and it is asked by the management routes, by `syncAuth` (every `…/sync/*` route) and by the WebSocket `subscribe`, so a valid `ck_` key plus someone else's vault id can neither push, pull, read that vault's history nor empty its recycle bin. The SQL half of the same rule is `visibleVaultsWhere` (`db/repositories/vaults.ts`, what `GET /api/vaults` filters with); `packages/e2e/src/vault-access.e2e.test.ts` pins the two together by asserting that the ids a key can list are exactly the ids its sync requests are accepted for. The `ck_` credential check itself is `lib/user-credentials.ts`, shared by both middlewares and the WS handler (`docs/api.md` §Sync endpoints owns the contract).

## Layering

- **Layering**: a route module is the handler map for its registry contracts — the schemas, auth, body reading, status codes and response validation come from `@courier/shared/wire` through `src/http/contract-routes.ts`. Every statement lives in `src/db/repositories/*` (`file-versions.ts` owns the chain order, the conditional insert and the window queries the recycle bin uses; `vaults.ts` owns vault rows, the visibility `WHERE` and the management writes; `admin.ts` the host-facing counts), and every handler in `src/handlers/*` is a pure function taking those statements as injected `*Fn`s (the push and clear-deleted handlers take a **deps object**, not a positional list). `src/index.ts` composes the one dependency a route cannot build itself — the WebSocket hub — for `startServer`, which owns the socket server and builds the route table from the registry (`src/http/contract-routes.ts`): nothing reaches a session registry through module state, so a REST push announces itself to the sessions the same listener accepted (`handlers/ws-handlers.ts` `createWsHub`). The wire limits and the action enum are `@courier/shared`'s (`SYNC_ACTIONS`, `MAX_PUSH_BATCH_FILES`, `MAX_PULL_BATCH_FILES`, `MAX_ID_LENGTH`, `MAX_ENCRYPTED_PATH_LENGTH`, `CONTENT_HASH_PATTERN`), used by the shared schema, by the drizzle `action` column and by the engine's own batch bound — so a client can see the limits it has to respect. **`.oxlintrc.json` enforces the direction**: `handlers/**` may not import the database, `Bun.serve`, `fs` or the routes; `middleware/**` may not import the database or the routes; `routes/**` may not import `drizzle-orm`.

## Logging

- **Two sinks, one level.** `src/lib/logger.ts` writes a human line to **stderr** (which the unit's
  `StandardError=journal` hands to journald) and a **JSON line** to `LOG_FILE`; `LOG_LEVEL`
  (`debug` | `info` | `warn` | `error`, default `info`) gates both, so one setting decides what the
  log is for. The file sink is off when `LOG_FILE` is empty, which is the default: a test run, the
  dev loop and the L1/L2 harnesses must not write one. The deployed unit sets it to
  `~/courier/logs/courier.log` (`Environment=LOG_FILE=%h/courier/logs/courier.log`), which is the
  one path a monitoring client tails over SSH — the web surface never reads the log.
- **The file is the store this deployment controls.** It rotates by size in-process
  (`LOG_MAX_BYTES`, default 5 MiB, keeping `LOG_MAX_FILES` = 3: `courier.log.1` … `.3`) instead of
  relying on journald's retention, because a journal's per-UID files are not something a root-owned
  user unit gets — journald keeps those entries in `system.journal`, so `journalctl --user -u courier`
  opens nothing at all. A monitoring client therefore reads the file, and falls back to
  `journalctl --user-unit=courier -o json` only when no file exists (a service that died before it
  opened its log file).
- **What is logged, and at which level.** Start-up/TLS/ACME lines and WebSocket subscribe/close
  events are `info` (a normal close is `debug`); the access log in `src/middleware/request-log.ts` is
  `debug` for a successful read (2xx/3xx) — **including the health/runtime/status polls** —
  for the successful sync push, and for a request **no route answered**. The deployed port listens on
  the public internet and is scanned continuously (`GET /`, `GET /.git/HEAD`, `GET /mcp`,
  `POST /sdk`); those paths are somebody else's traffic, so they stay in the full access log a
  deployment turns on with `LOG_LEVEL=debug` and never reach the default view. `info` is a 4xx **a
  route produced** (an unknown vault or version, a bad body) and a **successful mutation** (creating
  or deleting an account, emptying the recycle bin — the acts an operator asks about afterwards);
  `warn` is a **rejected credential** (a 401/403 whose request carried an `Authorization` header)
  and a request that took `LOG_SLOW_MS` (default 500 ms) or more; `error` is a 5xx. A rejected
  credential is the one client error that means something on this side is wrong — an operator's own
  key expired, a device is on an old key — so it belongs in 「警告以上」. A 401/403 with **no**
  credential is a probe of a protected path, not a refused client, so it is `debug`: a real client
  always presents its key. The one exception is a slow anonymous request, where the latency warning
  wins and the line is `warn`.
  The sync push is the one mutation kept at `debug` — data traffic, whose refusals the route logs. A
  **push refusal** is not an HTTP failure — `POST …/sync/push` answers `200` with per-file
  `stale_base` / `content_missing` — so the route logs the counts itself (`lib/push-log.ts`):
  `stale_base` at `info`, a missing blob or a handler error at `warn`. Unhandled exceptions log their
  stack through the same logger. At the default level the service log is not a traffic log: a path
  that never matched a route appears only with `LOG_LEVEL=debug`.
- **Nothing about content.** No route logs a body, a path, a filename or a device label beyond the
  self-declared name a push already carries; the service stays content-blind.

## Errors and validation

- **Errors**: custom `AppError` hierarchy in `src/lib/errors.ts`, whose `code` is the shared `ApiErrorCode` and whose `statusCode` is `Bun.serve`'s `ContentfulStatusCode`; global `errorHandler` returns `{ error, message, details? }`. `lib/validator.ts` owns the one `validationDetails` mapper, used by `createValidator` and by the push route's binary-body validation. Expiry is one rule for both credentials (`lib/expiry.ts`): an unparseable `expires_at` counts as **expired**, the answer `users` and `api_keys` used to disagree about.
- **Validation**: Zod through `withJson` / `parseJson` (`http/guards.ts`), which answer the same 422 with `details`.
