# Sync engine rules

> Status: `authoritative`. This document records the rules and the non-obvious reasons behind
> them. The executable spec is `packages/engine/src/` and its `*.test.ts` files: when this
> document and the code disagree, the code is right and this document is the bug. Update it in
> the same change as a behaviour change.
>
> It covers `@courier/engine` as every host runs it. Device-local file selection and the
> config-folder settings groups are in [`sync-scope.md`](sync-scope.md); host wiring is in
> [`plugin.md`](plugin.md) and [`cli.md`](cli.md); REST/WebSocket shapes are
> [`api.md`](api.md).

## Modules and composition

Shared TS sync engine, no build step (`src/index.ts` exported directly), depends only on `@courier/shared`.
Key modules: `crypto.ts` (PBKDF2 600k + AES-256-GCM + SHA-256 on Web Crypto), `decide.ts` (pure
versionId-aligned push/pull/conflict decisions), `engine.ts` (`SyncEngine` orchestrator: reconcile,
incremental events, echo suppression, rename-by-hash, conflict resolution, restore helpers),
`adapter.ts` (`SyncAdapter` + `FileStamp` — plugin provides an Obsidian adapter, CLI a filesystem adapter),
`api.ts` (`SyncApi` + `PushFile`), `op-queue.ts` (the host-level bound on how many event-driven
operations run at once), `sync-scope.ts` (the one predicate for _which paths this device syncs_:
markdown, plus the Obsidian config-folder **settings groups** the device switched on — `settingsGroupOf`
is the ownership rule), `conflict-file.ts` (naming the
`{stem}-{YYYY-MM-DD-HHmmss}[-n].conflict{ext}` copy a resolved conflict leaves behind, and
recovering the original path from it), `websocket.ts` (`SyncWebSocket` — user key + a self-declared device label as
the subscribe payload), `host.ts` (`SyncHost` — the loop both hosts run), `self-events.ts`
(`SelfEventLog` — the time-bounded records that let the engine recognise its own writes, deletes,
moves and push echoes, on an injected clock) and `remote-index.ts` (`RemoteIndex` — the live path, head
and content hash of every chain the server holds, which is what keeps one path on one chain). Engine
tests use mock adapters/APIs (`packages/engine/src/*.test.ts`).

Three things `SyncEngine` composes rather than contains, so the 2 000-line orchestrator does not also
own them: **`SelfEventLog`** and **`RemoteIndex`** (above — the first's windows are testable by moving a
fake clock, which used to mean freezing a global `Date`; the second is the identity index every rename,
notification and incremental event asks), the **`ReconcilePass`** value object (the maps and sets one
pass decided from, passed as one read-only snapshot instead of seven positional arguments), and the pure
**decision input builders** in `decide.ts` (`DecideContext` / `decideInputFrom` / `isLocalDeletion`) —
the same input used to be assembled in four places, and the subtle half of it (`localDeletion`) was
written out twice with different expressions. A push is described by one `PushRequest` value object
rather than six positional arguments (three of them strings, one nullable). `packages/engine/src/`'s
`decide.test.ts`, `self-events.test.ts`, `remote-index.test.ts`, `host.test.ts` and `websocket.test.ts`
are the L0 net for those — the last one with a fake global `WebSocket` and fake timers, because the
L1/L2 suites run a real socket against a real server and therefore only ever exercise the happy path
(a refused subscribe, the exponential retry, the 60-second quiet-socket close and a message that is not
JSON had no test at all until it existed).

The rules below are the ones the e2e suites exist to protect.

## Conflicts

- **A conflict is resolved by the remote version, and the local one is parked beside the note — except for
  a config-folder path.** There is one behaviour and no policy: `handleConflict` reads the local bytes
  (when the file exists), writes them to `{stem}-{YYYY-MM-DD-HHmmss}.conflict.md` (with a `-2`, `-3`…
  suffix when that second's name is taken, so a second conflict never overwrites the copy the first one
  parked), then applies the remote head with `pullRemote` — the version written at the path it records,
  or the local file deleted for a tombstone. The losing side **pushes nothing**, so the chain ends at
  whatever won. `onConflictResolved` carries `{ fileId, plainPath, conflictPath, remoteAction }` to the
  host (the plugin shows one Notice per burst, the daemon logs a line).
  - **A config-folder path takes the other rule: newer modification wins, silently, with no copy.** The
    config folder is outside Obsidian's vault index, so a `*.conflict.*` copy parked there has no file
    row, no `file-menu` entry and no `app.vault` handle — there is nothing the user could see or act on.
    `handleConflict` therefore branches on `settingsGroupOf` and compares the local file's stamp with the
    head version's `mtimeMs` (the file's own modification time on the pushing device, carried by every
    push frame and stored in `file_versions.mtime_ms`; a `delete` records the moment that device decided
    on it — held in the state's `deletedAtMs` until the tombstone is accepted, so a deletion made offline
    and retried later does not claim the retry time): the newer side wins. A newer local copy is pushed as
    a `modify` (or a `restore` over a tombstone) using the head as `baseVersionId` — **at the path the
    local file actually has**, because a version names the path its bytes live at, so a chain the peer
    moved comes back to this device's path rather than claiming one whose bytes are not here. A stale-base
    refusal is decided again from the fresh chain; a second one is contention (nothing was written), left
    to the next pass — the settings poll runs every second — instead of being reported as a failure. A
    newer remote head is applied with `pullRemote`. A tie, a missing stamp, or a local side that no longer
    exists (this device deleted it and a peer edited it) resolves to the remote head.
    **No copy is parked and no `onConflictResolved` event is raised** — the plugin still learns about a
    remote copy through `onSettingsApplied` (its reload card), and a local win needs no message because
    the device's file did not change. Covered by the `config-folder conflict` cases in `engine.test.ts`,
    `settings-sync.e2e.test.ts` and `plugin.e2e.test.ts`.
  - **Content this engine wrote itself is never a divergence, because the window is gone.** A pull's
    write and its sync point are one job in the path's queue, so no other decision can run between them:
    a notification or a pass for the same path either ran before the pull (and its snapshot is checked
    against `ReconcilePass.stateAtStart`) or waits behind it. The conflict decision therefore never sees
    the engine's own freshly written bytes against an older sync point. This is the shape a note saved
    twice used to leave behind (Obsidian saves a note again when the file it embeds finishes landing),
    and reading it as a divergence parked a conflict copy of the note the engine had just pulled. The
    self-event log still suppresses the vault event an engine write fires (see
    [Self-events](#self-events)); the config-folder branch still settles by modification time. Covered by
    the `does not park a copy of the note a pull is still recording` case in `sync.e2e.test.ts` and the
    `a notification for the peer's next version during a pull` cases in `engine.test.ts`.
  - The consequences are deliberate: the first pusher wins a two-sided edit, the losing content exists
    only on the device that detected the conflict (those files never sync — the peer would otherwise
    conflict again), and the device that detects a conflict sees the note change under it. Recovery is
    available: the winning version is on the chain, and the losing one is on the device's disk. For a
    config-folder file the losing side is overwritten instead (that is what "newer wins" means), which is
    why the rule only applies where a copy could not be reached anyway.
  - The comparison uses each device's own filesystem clock, so a badly skewed clock can win or lose
    incorrectly. That is the accepted cost of "who modified it last": the alternatives are the server's
    receive time (which misorders edits made while a device was offline) or no local win at all.
  - `ConflictPolicy`, `keep_local`/`keep_remote`/`recorded`, `resolveConflict`, the `conflicted` state
    flag, the conflict panel and `RestoreBlockedError("unresolved-conflict")` were all deleted with the
    policy: there is no "unresolved" state to come back to.

## Sync points and adoption

- **Identical bytes are never a conflict, even when this device's sync point is behind the head.**
  `decideFile` answers `synced` when the local content hash equals the head's, whatever
  `lastKnownVersionId` says, and the callers that can meet it — the reconcile's `synced` branch,
  `decideIncremental` and `handleFilePushed` — record the head as the sync point
  (`adoptRemoteIdentity`) instead of leaving the state behind. A `delete` head is never adopted: a
  tombstone lives at no path, so a pass does not write it into `pathToFileId` (the state records a
  tombstone only where this device pushed the delete). This exists because two operations can
  run on one path: an edit's push lands on the chain while a second decision on that path has already
  fetched the chain but has not seen this device's state adopt the version — the head then holds
  exactly the bytes on disk while the sync point is one version behind. Reading that as a conflict
  parked a copy of the note over itself, wrote the same bytes back and announced a conflict nobody
  had; a note edited twice produced two `*.conflict.md` files next to it. The conservative alternative
  (conflict on every "state behind, content equal") loses nothing either way, because there is no
  divergent content to preserve. Adoption is only allowed while the bytes it was decided from are still
  the bytes on disk: the reconcile confirms the file's stamp is the one this pass hashed (one `stat`),
  and that the sync point the state holds is a version this pass's chain contains — a version created
  by an event **during** the pass is newer than that chain, and adopting the pass's head over it would
  move the sync point backwards under the device's own successful push (the next edit then conflicts
  with it). `decideIncremental` and `handleFilePushed` read the file immediately before deciding and
  need neither check. Covered by `decide.test.ts` and the `a decision that meets this device's own
  content on the head` and `a reconcile racing an incremental event` cases in `engine.test.ts`.

- **A pull is one job, and the pass does not act on a snapshot an event has invalidated.** Every operation
  that reads or writes a path runs as a job in that path's queue (`PathQueue`), so a pull's write and its
  sync point are never observable half-done: the next job on the path starts after the adoption. The queue
  orders the writes, not the snapshots — a pass fetches its chain at the start, and an event can adopt a
  newer version while the pass is still working. The pass therefore records each chain's sync point when it
  begins (`ReconcilePass.stateAtStart`) and **skips** a file whose sync point changed since; a delete it was
  about to publish is also skipped when an event is queued behind its job (`PathQueue.hasQueued`), because
  that event's decision is newer than the pass's snapshot. The next pass decides from the fresh chain.
  Covered by the `a reconcile racing an incremental event` cases in `engine.test.ts` and the
  `does not park a copy of the note a pull is still recording` / `puts back the version a notification
  adopted before the pull's bytes landed` cases in `sync.e2e.test.ts`.

## Tombstones and binding

- **A `delete` head is read two ways, and the pass decides which.** `decideFile` takes a
  `TombstoneHandling` mode and a `locallyTracked` flag:
  - **`bind-merge`** — the single pass that binds a vault (`initialSync({ firstBind: true })`, sent by
    `EngineHost.start()` — so every process start, including a resume after a pause — the CLI's
    one-shot run, and a local event that arrives before the first pass has completed). The server has
    no live version of that file, so a local copy the engine has **never tracked** is "only local":
    it is pushed as a **new file with a new fileId**. This is what stops "connect this vault" from
    deleting notes the remote had already deleted. A local copy whose chain this device still tracks
    is not "only local" — the tombstone is not new to it — so the decision falls through to the
    `apply-remote-delete` rule below: the deletion is applied, or a local copy that diverged from the
    version it removed is parked as a conflict. Dropping the tracked chain here made every start
    revive a note a peer had deleted while this device was paused or closed.
  - **`apply-remote-delete`** — every other pass (scheduled reconciles, user edits after the first
    pass has completed, websocket notifications, and a bind that meets a chain this device already
    tracks). The local copy is the version the tombstone removed, so the deletion **is applied**
    and peers' deletions keep propagating; if the local content diverged from that previous version the
    two are out of step and the engine resolves a **conflict** — the remote deletion stands and the local
    content is parked (see the rule above).
  - A tombstone that is **this device's own sync point** is neither: the device deleted the file and the
    server accepted it, so a file on disk under that point can only be one the user just made — a
    **recreate**, pushed as `restore` on the same chain. Without that rule "delete a note, then write it
    again" would delete the new note and leave it as a conflict file.
  - Either way the comparison is against a live version, never a tombstone, because a delete version's
    content hash is the hash of an **empty string** — an empty local note would otherwise look "synced"
    and the deletion would never surface. A file that converges on content it already had
    is still **recorded** (state + path → fileId) so the host can look up its identity — otherwise a
    converged note had no version history to open.
  - **A tracked tombstone whose path another chain has taken is retired.** The state entry
    that makes a recreate a `restore` is kept across binds, so **ownership** decides which
    chain a local file at the path belongs to: once another chain claims it — a peer
    recreated the note, or this device did and the event gave it its own chain — the pass
    drops the tombstone's state entry instead of pushing a `restore` over the occupant.
    Without that, a scheduled pass read the new note as the file under this device's delete
    point and put the deleted note back on top of it, leaving two live chains at one path.
    Covered by the `does not revive its deleted chain over a peer's new file at the same path`
    case in `engine.test.ts`.
  - **A recreate event checks the server before it restores.** A vault event decides from the tracked
    chain alone, and the in-memory remote index can be stale: a peer's `file_pushed` never arrived
    (the socket was down) and no pass has run since, so the server may already hold a new chain at
    the path. A `restore` is the event push that resurrects a chain this device deleted, and that is
    the one this check covers: before pushing it the engine reads the vault index once and applies the
    pass rule straight away when a live chain records the path — the tombstone entry is retired, the
    owner's head is adopted when the bytes are identical, and a diverged copy is parked as a conflict.
    A failed index read fails the event, and the next pass retries. The read costs one index request
    plus the decryption of every live chain's path (the work a pass starts with), paid only on a
    recreate, not on ordinary edits. An **untracked create** at a path the stale index does not know
    is not covered: the engine cannot afford this read on every new note, so two devices that create
    the same path while out of touch (or before the notification arrives) can still leave two live
    chains until one of them wins a conflict — the same limit the conflict rule already accepts.
    Covered by the `does not restore on a recreate event…` / `adopts the owner…` cases in
    `engine.test.ts` and the `5d` case in `path-sync.e2e.test.ts`.
  - **A tracked chain whose head is a `delete` and whose file is gone is retired too**, unless its
    sync point is the tombstone itself (the recreate case, which keeps the entry). The deletion has
    already happened on this device — the file was removed while nothing watched, or the peer deleted
    it before it was ever materialised — so keeping the pre-delete sync point would leave the state
    naming a path with no file, and the next note written at the freed path would be decided against
    the dead chain (deleted and parked) instead of becoming a new chain. Covered by the
    `retires a peer-deleted chain whose local file was already gone` case in `engine.test.ts`.
  - **Applying a deletion drops the chain from the identity index** (`RemoteIndex.forget`). A chain whose
    head is a `delete` lives at no path, and the index's previous **live** head is not an identity a file
    at that path can adopt: leaving it there made the file adopt a chain whose content it does not have,
    so restoring a parked copy after a peer's delete became a conflict against the deletion that had just
    been applied (and an empty file matched the tombstone by its empty-string content hash). The index
    also refuses a tombstone head on the adoption paths (`handleLocalChange`'s identity lookup and
    `findRemoteFileIdByContent`) as a second line. Covered by the `pushes a local file at a peer-deleted
    path as a new chain, not a conflict` case in `engine.test.ts`, `remote-index.test.ts`, and the L2
    `restores the copy onto a new chain after a peer deleted the original` case.

The layer-by-layer coverage matrix for these bind cases is in [testing.md](testing.md#layer-coverage-the-merge-matrix).

## Adapters

- **Both adapters create a file's parent folder before writing it.** `FsAdapter` does it in
  `writeFile`/`renameFile`; `ObsidianVaultAdapter.writeFile` walks the folder chain and calls
  `createFolder` (guarded by `getFolderByPath`, since `createFolder` throws on an existing folder)
  before `createBinary`. `app.vault.createBinary` does **not** create missing parents: it throws
  ENOENT and leaves the file absent, so a nested note pushed by a peer would silently never land in an
  Obsidian vault. `ObsidianVaultAdapter.renameFile` prepares the target folder for the same reason (a
  peer can move a note into a folder this device does not have yet).
  - **The guard is not atomic, and losing that race is not a failure.** Obsidian reports a folder
    rename — and a batch of notes landing in one new folder — as **one event per file**, and the host
    handles those concurrently, so two operations that need the same absent folder both read `null`
    from `getFolderByPath` before either `createFolder` resolves. The loser used to get
    `Folder already exists.`, which aborted that note's whole move or write until the next reconcile
    (five minutes, in the plugin) — a folder rename losing one of its notes, and the note a peer saw
    re-created at the old path. Both folder helpers therefore catch that error and continue when the
    folder now exists, rethrowing only when it really is absent (no permission, a bad path). Covered
    by the concurrent-burst cases in `packages/e2e/src/folder-rename.e2e.test.ts` and the folder cases
    in the real-Obsidian suite; `FakeVault.createFolder` models Obsidian's window (a macrotask before
    the folder is registered), so a fake vault cannot hide it.
  - **A rename whose source vanished while the target folder was being prepared is not a failure.**
    `renameFile` re-reads the source after `ensureParentFolder` (and after
    `ensureFoldersInAdapter` on the config path) and returns when it is gone: the folder chain costs
    awaits, one note of a burst can be moved while another is still preparing its folder, and
    `Vault.rename` on a file the vault no longer holds throws `ENOENT` — which failed that note's whole
    pull for a move that no longer had anything to move. Found by tightening `FakeVault.rename` to
    Obsidian's own contract, which is what that fake is for.
  - **A delete whose path another writer already removed from disk is not a failure.** `Vault.delete`
    awaits only the adapter's unlink and leaves the vault index to the file watcher, so for one watcher
    pass the index still lists a file that is gone and the second unlink answers `ENOENT`. That happens
    when a peer's delete is applied while the user deletes the same note, and inside the engine itself
    when a reconcile and a `file_pushed` notification apply one delete head at once (see
    [Pass order and concurrency](#pass-order-and-concurrency)). The adapter checks the path on disk
    after a failed delete and returns when it is gone, rethrowing only while the file is still there.
    The L3 harness's own cleanup follows the same rule: `ObsidianVault.remove` and `resetVault` list
    from, and delete through, that same lagging index, which is why a probe note a peer removed first
    used to make teardown log a false `ENOENT`.
  - **Losing a `createBinary` race is not a failure when the bytes match.** `writeFile`'s existence
    lookup, the folder chain and `createBinary` are not atomic: a reconcile pass and a WebSocket
    `file_pushed` notification can pull one path at the same time (the notification runs through
    `OpQueue`, the reconcile does not), so both can read `null` before either `createBinary` resolves
    and the loser gets `File already exists.` — which used to escape `initialSync()` and fail the
    real-Obsidian `reconcile()` eval. The loser re-reads the path and accepts the race only when the
    file holds exactly the bytes it was writing; different bytes (or a file it cannot read) rethrow,
    because overwriting there would destroy content this engine has not seen. Covered by the
    concurrent-write cases in `packages/plugin/src/unified/adapter.test.ts`; `FakeVault.createBinary`
    models the window (a macrotask, then `File already exists.`) and `stub-fidelity.test.ts` pins it.

## Self-events

- **An engine-initiated local write, delete or move is never re-synced as a user action.** A host's
  adapter fires a vault event for those operations too, and the host feeds it straight back into
  `handleLocalChange`/`handleLocalDelete`/`handleLocalRename` before the engine's own state update
  lands (the write and that update are separate async hops). `SyncEngine` records each such operation
  (`selfWrites` / `selfDeletes` / `selfRenames`, hash- and target-matched) and consumes the matching
  event, exactly like `pushedVersions` suppresses a websocket echo. Without it, applying a peer's
  delete pushed a second tombstone — which made the file unrestorable, because the recycle bin reads
  the newest non-delete version as the restorable one — restoring a file pushed a duplicate
  `restore` (or a duplicate fileId, or a phantom conflict), pulling a new remote file pushed it back
  under a second fileId, and following a peer's move pushed a second `rename` version. Covered by the
  `SyncEngine — the vault event caused by its own write` tests in `engine.test.ts` and by the
  recycle-bin cases in `plugin.e2e.test.ts` / the real-Obsidian suite.

## Identity: one path, one chain

A chain's `fileId` is assigned when the file is created and never changes: a rename, a move, a
restore or a conflict keeps the chain and its UUID, and records a new version at the path the
file now lives at.

- **A remote move is applied at the path the version records, and a local event only ever adopts a
  remote identity — it never forks a second chain for a path.** Two halves of the same invariant
  (one path, one chain):
  - `SyncEngine.followRemotePath` never falls back to the mapped local path: when the source file is
    already gone (the vault applied the move first, or a notification was dropped), the pull has to
    land at the peer's path. Returning the old path made `pullRemote` write the content back to the
    path the peer had moved away from, leaving **both** files on disk.
  - `handleLocalChange` looks the path up in the remote index (`RemoteIndex.fileIdAt`) before treating an
    unknown local file as new, and falls back to a content-hash match (`RemoteIndex.fileIdForHash`) only
    when the chain's previous path no longer holds a local file — so two genuinely separate files that
    merely share content still get their own chains.
  - `handleFilePushed` and `pushFile` keep the index current, and the pushed version is recorded
    **before** the push request goes out (`SelfEventLog.rememberPushedVersion`), because the server's
    `file_pushed` echo can beat the HTTP response back.

  Covered by `engine.test.ts`, the rename cases in `plugin.e2e.test.ts`, and the root-level rename case
  in the real-Obsidian suite.

## Offline changes and reconciliation

- **A change made while the connection is down reaches the server on the next reconcile, and that pass
  never undoes it.** There is no offline queue and the server keeps no backlog for a subscriber
  (`subscribe` is answered with a session id and nothing else), so a push that fails is dropped and the
  caller only logs it. A **pull** that cannot be carried out fails the same way — visibly:
  `pullRemote` answers whether the local side now matches the head, and `handleFilePushed` rejects when
  it does not (the plugin's `runInBackground` logs it, the daemon prints a line). A notification is the
  only thing that would have pulled that file before the next pass, so resolving as if there were
  nothing to do left the note missing with nothing said anywhere — which is how the truncated-blob read
  presented itself. A pass is the retry mechanism itself, so it tolerates the same failure and moves on.
  Two answers are "nothing to apply" and are tolerated: the store holds no blob for that hash (`404`,
  reclaimed or never there) and bytes that do not decrypt. Anything else — a `429`, a `5xx`, a transport
  error — **is rethrown and fails the pass**, because a request that did not happen says nothing about
  the blob: treating it as "gone" let a first download of 10 000 files report success with 8 000 files
  missing (see [first-bind-performance.md](first-bind-performance.md)).
  Both hosts therefore reconcile on a **re**connect — never on the first connect,
  which sits right behind the bind pass, and never two at once (two overlapping reconciles decide from
  the same snapshot and push twice; the plugin suite caught exactly that as a duplicated `rename`).
  The engine's half:
  - `decideFile` answers `push: delete` when the chain's live head is still this client's sync point and
    the local file is gone, and the reconcile **pushes that tombstone** instead of skipping it (it
    re-reads the file through the adapter first: a vault listing that lags a write must not become a
    deletion). This is what carries "deleted while offline" and "deleted with the app closed".
  - A failed delete push **keeps the state entry** (`pushFile` rewrites it to the delete version once
    the server accepts it). Dropping it left the fileId untracked locally but live remotely, so the next
    reconcile read the deletion as "a remote file this device is missing" and pulled the note back.
  - `handleLocalRename` persists the new path even when the push fails, and the reconcile pushes a
    `rename` when the chain's recorded path disagrees with the local one — `decideFile` compares
    versionIds and hashes, so a pure path change is invisible to it and the move would otherwise be
    lost (and, after a restart, read as "old path deleted, new path a new file": one note, two chains,
    duplicated on every peer).
  - `repairMovedFile` re-points a chain whose file moved with **no** event at all (plugin disabled while
    the vault was reorganised, an external tool, a killed process), using the state's last synced
    content hash and only when exactly one unclaimed local file matches it — two files that merely share
    content must stay two chains.
  - An edit made while **nothing was running** (another editor such as VS Code, a sync tool) fires no
    event at all, so the only thing that can see it is the bind pass the next `start()` runs. An edit of
    a known file is pushed as a `modify`, a new file as a `create` — both as before — while the delete
    and rename variants are exactly the cases this rule's fixes cover.
  - **A reconcile is serialised against incremental events through the path queue.** It decides from
    the snapshot it took when it started (listing, hashes, chains), while the vault keeps firing
    events — so its per-file work is a job in that path's queue, and an event's job for the same path
    either ran before it (the pass then sees a sync point that moved and **skips** the file, see
    `ReconcilePass.stateAtStart`) or waits behind it. A delete the pass was about to publish is skipped
    when an event is queued behind its job (`PathQueue.hasQueued`). The pass also re-reads a file before
    it writes or deletes it, deciding again from the bytes actually on disk when they moved. That is what
    keeps a pass from pushing a second `modify`/`rename`/tombstone for a file an event already owns, and
    from pulling over an edit that landed mid-pass instead of handling the conflict it is. The wait is
    always before the job runs — a job never waits while holding a path — so a host whose adapter awaits
    the event its own write fires (the tests' `FakeAdapter` does) cannot deadlock.
  - **A push says what it was decided from, and the server checks it.** Each pushed file
    carries `baseVersionId` — the chain head the decision was taken from, `null` for a file the
    client believes is new — and the server refuses the push (`status: "stale_base"` +
    `currentVersionId`, nothing written: no blob, no row, no broadcast) when its own head differs,
    so a pass that read the chain once cannot overwrite a version it never saw. **The check and the
    insert are one atomic step, and one transaction covers the whole push batch**
    (`TryInsertFileVersionsFn`, bound in `routes/sync.ts` to a `db.transaction` whose synchronous
    callback the `bun:sqlite` driver runs to completion in a single tick). Each row is still checked
    against its own chain's head inside it; only the commit is per batch, because a per-file commit cost
    ~0.9 ms of fsync per file and a first bind is hundreds of batches of 100. The handler's own head read
    sits _before_ the blob writes — real asynchronous I/O, and the slowest part of a large file's push —
    so the check that decides has to be in the same transaction as the row it guards. Without that, two
    pushes decided from the same head both pass the check, and the chain's head becomes whichever request
    _finished_ last: an earlier edit held up by a big file overtakes a later one (the peer then
    syncs the note backwards), and two devices editing at once each get `ok` and then silently pull
    over the other's edit instead of parking it. The pre-check stays as a fast path, so an ordinary
    refusal still writes nothing. A fileId the vault
    holds no version for is accepted whatever the base says: there is nothing to overwrite, and
    refusing would strand a client whose chain the recycle bin emptied. The chain order
    (`getVersionChain`, `getLatestEncryptedPath`, the prune pass) is `(created_at, rowid)` — the same
    head the transaction checks, or a client whose base came from the chain's tail would be refused
    forever. The engine answers a
    refusal by pulling the chain it was refused by and deciding **again from it without moving its
    own sync point**, which is what turns a peer's version into the conflict it is rather than
    something this device builds on top of (`SyncPushBaseError`, handled by `decideIncremental` and
    by the reconcile's push branch; the delete/rename intent paths converge the same way). A refusal
    whose head already holds the pushed bytes is adopted as the sync point instead — that is the
    lost-response retry, which no longer duplicates a version or invents a conflict. No client-side
    queue is involved, and none would help: two devices cannot see each other's order, and the
    engine's deliberate no-lock rule (above) exists because waiting on a path deadlocks a host whose
    adapter awaits the event its own write fires. Covered by the
    `two pushes decided from the same head, in flight at once` cases in `sync.e2e.test.ts` (exactly
    one of two concurrent same-base pushes lands; an earlier large edit never becomes the head by
    finishing last; two devices editing at the same instant park the losing text instead of dropping
    it) and by `engine.test.ts` / `sync-handlers.test.ts`.
  - **A deletion that raced an edit is a conflict, not a pull.** `DecideInput.localDeletion` says a
    tracked file's absence is _this device's_ deletion — a **live** sync point of its own, nothing on
    disk, and nothing at the path the head records (a head whose path holds a local file is a peer's
    move to follow; a sync point that is itself a `delete` means the absence is already on the chain
    and a newer live head is a peer **restoring** it). The engine computes it (`decideFile` cannot:
    the filesystem looks identical to "a remote file we never had"); a chain that moved past that
    point then resolves as a **conflict** on every path that meets it — the refused tombstone, a pass,
    a notification — and the remote side wins it: the peer's version comes back, and there is no local
    content to park (the file this device deleted is gone).

  Covered by the `changes made while the connection is down` cases in `engine.test.ts`, the
  `reconciles when the socket comes back` cases in `host.test.ts` / `plugin.e2e.test.ts` /
  `cli-daemon.e2e.test.ts`, and `sync.e2e.test.ts`.

## Cost: stamps and re-reads

- **A pass reads a file once, and not at all when its stamp has not moved.** Every pass used to read and
  hash every syncable file in the vault, which for a vault of attachments means re-reading gigabytes every
  five minutes (and on every reconnect, and on every settings poll) to discover that nothing had
  happened. The state now records a `FileStamp` — size and `mtimeMs` — **alongside the hash it was taken
  for**, and a pass that finds the same pair reuses the recorded hash instead of reading the file.
  - The pass fetches the sync index **first**, then scans: a local file with no state entry and no chain
    at its path cannot be pulled, conflicted or renamed, so the scan records its stamp and leaves the read
    to `createUntrackedFiles`, which needs the bytes anyway. A first bind therefore reads each file
    **once** instead of twice (measured at 10 000 files: 10 001 reads instead of 20 002, and ~0.9 s less
    I/O; see [first-bind-performance.md](first-bind-performance.md)). The one exception is the
    move-repair fallback: if a tracked file has no hash this pass, the untouched files are hashed too,
    because `repairMovedFile` matches an event-less move by content.
  - The scan's per-file work runs through `WorkPool` (four small files at a time), so a cold start is no
    longer one serial `stat`/read/hash per file.
  - `SyncAdapter.statFile` answers `{ sizeBytes, mtimeMs }` (Obsidian's `TFile.stat` / `DataAdapter.stat`,
    the runtime's `fs.stat`), so the size cap and the cache decision come from one call. A stamp is **only**
    ever recorded together with the hash of the bytes that were on disk at it: `readWithStamp` stamps
    _before_ the read, so a write racing the read costs a redundant re-read rather than a wrong hash.
  - A stamp is written where a sync point is written — `pushFile`/`applyPushedVersion` for a push, the
    `synced` branch for a converged file, `pullRemote` after it writes the file it just pulled — and a
    `delete` records none (its sync point is the _absence_ of the file; the next file at that path must
    not look synced). A missing stamp costs exactly one re-read, which is what makes an older persisted
    state safe.
  - It is deliberately a **hint**: a file edited twice inside one filesystem timestamp tick, ending at
    the same size, is missed until something else changes. Every path that can afford to read still
    reads — a push, a conflict, a file whose stamp differs — and a notification about an unchanged file
    no longer reads it at all.
  - Covered by the `SyncEngine — what a large file costs` cases in `engine.test.ts` (the read counter on
    `FakeAdapter`, plus the bind cases that pin one read per file), the `reads an edited file once`
    cases, and the stamp cases in `large-file.e2e.test.ts` (the real filesystem, and a restart over the
    persisted state).

- **An edit reuses the read the event handler already took, and a move reads nothing.** `applyLocalChange`
  reads the file once; `decideIncremental` reuses those bytes while a `stat` still matches the stamp they
  were read at (the same hint a pass trusts) and hands the hash it computed to `preparePush`, so an edit
  costs one read and one hash rather than two of each. A `rename` whose sync point stamp still matches
  pushes the recorded hash and size without opening the file at all — a move changes no bytes — while a
  stamp that moved (edited and renamed with no event in between) falls back to reading and sends the new
  bytes. A `content_missing` refusal of the stamp-proved move is the one place it then reads the file, to
  finish a move whose blob the store has lost. Covered by the `reads an edited file once`, `re-reads an
  edit that lands while the chain is being fetched`, `moves a file without reading it` and `reads a moved
  file whose stamp moved with it` cases in `engine.test.ts`.
  - The stamp a move was proved by is recorded with its sync point, so the next pass reads nothing
    either. A `content_missing` retry sends the file's bytes only after they still hash to the
    version's content (and stages chunks above 8 MiB); a changed or vanished file throws. A decision
    that is not a push (`pull`, `conflict`, `synced`) re-reads before it acts, because the chain
    request gives a same-size edit inside one timestamp tick time to land; if the bytes differ, the
    decision is taken again from disk.

## Renames and content reuse

- **A rename sends no content, and a peer that already has the bytes follows the move without
  downloading.** The content is content-addressed, so a version whose `contentHash` the chain's head
  already records has nothing new to transfer: `pushFile` omits the payload when the file's own sync
  point holds that hash (in practice exactly the rename case), and `pullRemote` renames the local file
  instead of fetching when the head's hash is the one this device already has and the file is provably
  the one that was hashed (the vault moved it, or the head records the path that was hashed). Moving a
  40 MiB attachment costs one small request instead of an upload **and** a download.
  - The server does not take the client's word for it: a content-less version whose blob the store does
    not hold is refused (`content_missing`, nothing written) and the engine re-pushes with the payload.
    A chain can therefore never point at content no peer can fetch.
  - A `rename` still records its **real plaintext size** even when it carries no content. Size never
    refuses a pull (the cap bounds uploads, see [sync-scope.md](sync-scope.md#size-cap)); it is what a
    peer's status surface reports and what a chunked transfer is planned from.
  - Covered by the rename cases in `engine.test.ts` and in `large-file.e2e.test.ts` (which asserts the
    payload bytes on the wire, not just the outcome).

## Batching

- **A pass batches the files it creates.** One request per file made a first bind of a note-heavy vault
  cost one round trip per note; the server has always accepted up to 100 files per push, and the engine
  now uses it (`createUntrackedFiles`). Batches are bounded twice — `MAX_PUSH_BATCH_FILES` (100, the
  server's own cap) and `MAX_PUSH_BATCH_BYTES` (8 MiB), because every file in a batch stays in memory
  until the request is built — and a file larger than the byte bound travels alone, so a bind never holds
  two large payloads at once. `modify`/`rename` pushes stay one per request on the **single-event** path:
  those are event-driven single-file changes, where a round trip is not what the pass is spending its
  time on. A **burst** of such events is batched on both sides — the host hands it to one job whose
  versions and chain reads travel 100/200 per request (see "A burst of local vault events" below).
  - **A refused batch costs one batch, not the pass.** The flush is always awaited before its failure is
    recorded (`const failure = await flush(); firstFailure ??= failure;`) — `firstFailure ??= await
    flush()` short-circuits the **call**, so one refused batch used to silently drop every batch after
    it while their files were already recorded in the state.
  - **A file whose create was refused goes back to being untracked.** The entry (`path → fileId`) is
    written before the request so a vault event that lands meanwhile adopts the same identity; a
    refusal drops it again, so the next pass retries the file through the **batched** create path
    instead of `reconcileOne`'s one-request-per-file push. Measured: 201 stranded files used to cost 201
    requests; they now cost one.
  - **A `429` is waited out, not failed.** The server states the window (`Retry-After`); the batch is
    re-sent after that wait, up to `MAX_RATE_LIMIT_WAITS` times, and only then does the pass stop and
    leave the remaining files untracked for the next one. The same wait applies to a single-file push
    (`sendPush`) **and to content reads**, so neither a first upload nor a first download is turned into
    a failed pass by a window boundary. The wait is reported (`onRateLimited`) so a host can say why
    nothing is happening — a minute of silence reads as a hang.
  - **Preparation and the request overlap.** A full batch is handed to the wire and the next one is read,
    hashed and encrypted while it flies (`flush` starts it, `settle` awaits it); at most one batch is in
    flight and one is being built, so a bind holds two batches of memory at most. A large file still
    travels alone, and a chunked upload still runs without another request interleaved, because both
    `settle` first. At 50 000 files the read/encrypt half is ~1 ms per file, so waiting for every answer
    before reading the next batch left the network idle for about half of the bind.
  - Covered by the batching cases in `engine.test.ts` (the fake server records each request's file
    count), the `a first bind that meets the server's limits` cases (a refused batch, the batches after
    it, a `429` wait, the read count, and "the second batch is ready while the first request is in
    flight"), and `large-file.e2e.test.ts` (250 notes → three pushes).

## Chunked transfer

- **A file above 8 MiB moves in 4 MiB chunks, and resumes where it stopped.** A push for a larger file
  no longer carries it: each chunk is encrypted on its own with the content hash, its index, the chunk
  count and the plaintext size bound into the AEAD (`chunkAdditionalData`), staged with
  `PUT …/blobs/:hash/chunks/:index`, and named by the final push (`contentChunks`, no payload). The
  server assembles the blob before it inserts the row, so a chain never points at a half-uploaded file.
  - The resume point is the server's contiguous prefix (`GET …/blobs/:hash/status`). A dropped connection
    costs one re-read/hash of the file on the next pass and nothing else: already-staged chunks are not
    re-sent. That, plus the bounded request bodies, is the reason the threshold exists — below 8 MiB one
    request is cheaper than several round trips.
  - A download of such a version fetches the same chunks back as byte ranges and decrypts each
    one. The ciphertext **and** the plaintext are bounded: each chunk goes straight into the
    adapter's `beginWrite` sink, which writes a temporary file under `.courier/tmp` and renames
    it into place at `close`, so a 200 MiB pull costs a handful of 4 MiB chunks instead of a
    200 MiB buffer. A host without `beginWrite` falls back to assembling the file whole. Each
    chunk's AEAD binds the content hash, index, chunk count and plaintext size, and a streaming
    SHA-256 over the decrypted chunks verifies the whole-file hash before `close`; a stream that
    cannot be written aborts and falls back once to the whole-buffer path. The watcher event for
    the rename is recognised by the committed file's stamp, so it does not read the file back.
    See [large-file-streaming.md](large-file-streaming.md).
  - The split is by **size**, and the server enforces it: a payload above 8 MiB must be staged, a
    chunked push at or below it is refused, and a payload's length must equal `sizeBytes + 28`. That is
    what lets a reader — this engine, an older peer or a dialog — pick the right framing from the
    version row alone, with no format flag on the wire.
  - A `rename` is unaffected: the threshold applies to a payload, and a move has none.
  - Covered by the chunked cases in `engine.test.ts` (upload calls, range fetches, resume from a
    prefix, the streaming sink, an aborted stream) and in `large-file.e2e.test.ts` (a 9 MiB
    file: three chunk requests, a content-less push, a peer fetching three ranges and writing
    them through one streamed commit, identical bytes; plus the shapes the server refuses).

## Pass order and concurrency

- **A burst of `file_pushed` notifications is coalesced into batched chain pulls.** A bind announces one
  version per file, and applying each notification on its own cost one `POST /sync/pull` per file: 5 000
  requests against a 600/minute limiter left a peer that was online during the bind on 548 of 5 000 files
  until its next pass. The host holds notifications for at most `PUSH_NOTIFICATION_FLUSH_MS` (25 ms) or a
  full `PUSH_NOTIFICATION_BATCH` (200), and the engine then fetches those chains with one request per 200
  files (`handleFilePushedBatch`), applying them from the head the server answered with. Applications run
  through `WorkPool` four at a time **only when the chunk names no path twice** — the head's path and the
  path this device already holds for the chain both count, and a chunk that shares one applies in order;
  the state is written **once per batch**, not once per file (a per-file write rewrote a megabyte-scale
  state thousands of times and was most of a live pull's cost: 5 000 files, 59 s → 18 s, measured in a real
  Obsidian). The trade is crash granularity, not behaviour: a crash mid-batch leaves up to one batch of
  files to re-decide on the next pass. A lone remote edit still costs one request, 25 ms later.
- **A burst of local vault events is carried out as one job, not one request per file.** An agent, a
  script or a folder operation writes hundreds of files in a few seconds and the watcher reports one
  event per file; handled one at a time that is one `POST /sync/push` per file — and, for a file this
  device already tracks, one chain read _before_ it. Measured: 1 000 generated notes were 1 000 pushes;
  300 edits to existing notes were 300 chain reads and 300 pushes. Once more than
  `LOCAL_EVENT_BURST_SIZE` (4) events arrive inside `LOCAL_EVENT_BURST_WINDOW_MS` (500 ms) — eight a
  second, just under the deployed allowance — `SyncHost` collects their paths and
  `LOCAL_EVENT_BURST_FLUSH_MS` (50 ms) later hands them to **one engine job**
  (`SyncEngine.handleLocalEvents`), which makes the same per-path decisions as a single event and sends
  what they produce in batches:
  - changes and edits to tracked files travel **100 versions per request** (the same
    `MAX_PUSH_BATCH_FILES` / `MAX_PUSH_BATCH_BYTES` bounds the pass's creates use), and tracked files'
    chains are fetched **200 per request** (`MAX_PULL_BATCH_FILES`) instead of one request each;
  - deletions travel in the same batch as their own version list. `changed` and `deleted` paths are kept
    apart because a change is decided by reading the file and a deletion by its absence — one list for
    both would read nothing for a removed path and silently drop its tombstone. Deletions are decided
    **first**, so the rename-by-hash record exists before a moved file's create is decided; a path that
    is in both lists is decided as an **edit**, not a deletion (a tool replacing a file in place reports
    both halves, and publishing the tombstone only to follow it with a restore tells every peer to delete
    a note that never went away);
  - the vault is **never scanned** and the chain index is **never fetched**: this is not a pass, and it
    costs the burst, not the vault. A listing is read once per job (only when it has changes), where the
    single-event path reads one listing per new file for its identity fallback.
  - **The engine's own writes are not a burst.** A pull writes its files through the adapter and the
    watcher echoes every one, which is exactly why `SelfEventLog` exists; the host asks the engine first
    (`hasSelfWriteHint` / `hasSelfDeleteHint`) and queues those events as before without counting them.
    Otherwise every large download would batch behind itself. The hint is cheap and time-bounded; the
    engine still matches bytes before it ignores an event.
  - **A burst that is still writing while the job runs owes another job.** Paths arriving during the job
    set the flag again, and its tail arms one more hand-off rather than leaving them to the five-minute
    periodic pass. `whenIdle()` counts an owed or running burst as work, so a host that hands its vault
    lease over does not do it mid-burst.
  - **A move travels as its own list of pairs.** A `rename` re-points a chain instead of producing a
    version of a file's bytes, so it is decided as such — but it joins the same batch, and its version
    carries **no payload** (the head already holds the bytes). A move whose source this device never
    tracked becomes a create at the destination, and a move that leaves this device's scope re-points
    the chain and publishes nothing (see `rememberMoveOutOfScope`); both are decided inside the job, so
    a folder rename is batch-sized too.
  - **A burst is logged with its size.** `local burst: N changed, M deleted in one batched push` goes to
    the host's log, so "did one save just trigger a batch?" is answerable from a plugin console or the
    daemon's log instead of inferred from CPU use. The threshold has headroom over one operation by
    construction: the plugin wires one handler per Obsidian event
    (`vault.on("create"|"modify"|"delete"|"rename")`), so a save is one event, a create at most two
    (`create` and the `modify` the app also fires), and a rename one — against four in 500 ms.
  - Individual events below the threshold keep their immediate push: an ordinary edit still travels on
    the event, not in a batch. Covered by `host.test.ts` (`a burst of local events`: one job and no pass,
    the three event kinds kept apart, the follow-up hand-off, a pull's own events not counted) and
    `bulk-write.e2e.test.ts` (700 creates, 300 edits, 300 deletions and 300 moves against the
    **deployed** 600/minute allowance: every version lands, fewer than 40 requests each way, and the
    receiving host's only index read is its bind).
  - **A download's content reads travel in batches too.** `fetchRemoteBytes` holds a read for
    `CONTENT_BATCH_WINDOW_MS` (5 ms) so the four per-file operations a pass or a burst already runs
    together fetch their versions in one request (`POST …/sync/contents`, see
    [api.md](api.md#11b-get-several-versions-content-at-once)) instead of one per file. The batch is
    bounded by 64 hashes / 8 MiB of plaintext (a file big enough to fill it travels alone), and a hash the
    store does not hold comes back as a missing entry — the same "nothing to apply" a `404` is. A chunked
    version still reads its ranges one at a time, which is what keeps a 200 MiB pull bounded.
  - **What it does not fix:** nothing on the event path is left unbatched. A first bind still scans the
    local vault (one `stat` per file) — the cost that bounds a cold start.
- **A cold-start pass works in the order the user will notice, and bounds how much is in flight.** The work
  is the same either way; the order and the concurrency are what a phone feels:
  - Every reconcile reads `GET /vaults/:id/sync/index` — **one row per chain** (`head`, plus the last live
    version when the head is a `delete`) — not `/sync/history`, which returns the vault's full version
    stream for diagnostics (the plugin's history dialog is its own in-memory session log, see
    [plugin.md](plugin.md)). The pass decides from the head; the full chain is fetched only for the rare
    convergence adoption that has to prove the state's point is in the chain (`engine.ts`'s `synced`
    branch).
  - Files are ordered by `priority.ts`: the host's `getPriorityPaths` (the Obsidian plugin supplies the
    active file plus `Workspace.getLastOpenFiles()`, in that order), then a chain this device tracks before
    a remote-only one, then the local stamp's mtime (recently edited) and finally the pass's original
    order. A chain is ranked by the **better** of the path the server records and the path the local file
    has, because a rename leaves those disagreeing for as long as the move is in flight. The list is a
    preference, never a filter.
  - The per-file half runs through `WorkPool` with the host's `OpQueueLimits`: at most `maxConcurrent`
    (4) small files at once, a file at or above `exclusiveBytes` (8 MiB) alone. Each task is a different
    fileId, so the state it mutates is disjoint; a failure is returned and the first one is raised after
    the pass, so one refused file no longer ends the rest of the work. `WorkPool` is not a path lock —
    nothing waits on another slot. The **local scan** uses the same pool: `stat` per path (plus a read
    only where a chain can claim the file), four at a time, instead of one serial await per file.
  - **Every operation on a path is a job in that path's queue, and two jobs on one path never interleave.**
    A peer's rename (or delete) is recorded on the server while this device's file is still at the old path,
    and another device can have created a new chain there; both tasks would decide from the same bytes, and
    the remote-only one would read the other chain's file as a divergence and park a conflict copy of
    content that never conflicted. `PathQueue` serialises them: a job names the paths it may touch (a
    rename names both), starts after the jobs already queued for them, and holds them until it ends. The
    pass's per-file work, a notification's apply, a local change/delete/rename, a restore, the create
    batch and the move repair are all jobs, so a pull's write and its sync point are one step and no other
    decision can see the half-applied state. A job never waits for another job on a path it holds (the
    inner work — `pullRemote`, `handleConflict`, `pushFile` — is called directly), and the wait happens
    before the job runs, so two multi-path jobs cannot form a cycle.
  - **A vault event fired by the engine's own write is queued, not waited for.** A host may feed the event
    back _inside_ the adapter call that performs the write; waiting for the event's job there would wait
    for the write that is waiting for the handler. `SyncEngine` marks the paths it is writing and, when an
    event arrives for one of them, queues its job and returns — the write finishes, then the job runs (and
    persists its own state). A failure in such a job surfaces through `EngineOptions.onError(error, paths)`,
    which `SyncHost` routes to its own failure path (`fail`: a log line naming the paths, and a stop on an
    auth failure); the adapter that fired the event has no place for the rejection. That is why the engine
    still never deadlocks a host whose adapter awaits its own event.
  - `RemoteIndex` keeps a `fileId → hash` reverse map (its per-`remember` sweep was O(N²) over the vault)
    and a `hash → {fileId}` set (shared content: when the owning chain moves or is forgotten, the lookup
    goes to the chain that still holds those bytes), and `adoptRemoteIdentity` drops only the recorded
    old path instead of scanning `pathToFileId`.
  - `SyncHost` reads the priority list at the start of **every** pass and, when a bind took at least
    `postBindReconcileAfterMs` (default 5 s), runs one ordinary reconcile behind it: the event source is
    wired only after the bind returns, so an edit made during a slow bind would otherwise wait for the
    periodic pass. `0` makes it unconditional, `Infinity` disables it.
  - Covered by `priority.test.ts`, `work-pool.test.ts`, `path-queue.test.ts`, the
    `SyncEngine — the order a pass works in`, `SyncEngine — how much a pass runs at once`,
    `SyncEngine — two chains naming one path` and `SyncEngine — operation interleavings` cases in
    `engine.test.ts`, the priority/catch-up cases in
    `host.test.ts` and the plugin's `host.test.ts`, the `getVaultSyncIndex` mapping in
    `sync-handlers.test.ts`, the head/previousLive SQL in `file-versions.test.ts`, and the cold-start case
    in `sync.e2e.test.ts` / `plugin.e2e.test.ts` (mobile).
- **A host bounds how much event-driven work runs at once (`OpQueue`).** Obsidian's vault events and
  websocket messages are synchronous and cannot be awaited, so a folder dropped into the vault used to
  start a read, hash and encryption for every file in the same tick — the memory blow-up the size cap
  exists to prevent, arriving through the one door the cap does not watch. Both hosts now run that work
  through `OpQueue`: small operations up to `maxConcurrent` (4), anything at or above `exclusiveBytes`
  (8 MiB) alone, and an unknown size — a websocket notification, whose payload is only known after its
  chain is fetched — treated as large. The queue is FIFO, so an exclusive operation waiting also holds
  back the small ones behind it, and it never blocks the engine: a queued operation simply has not
  started, and every decision it takes is taken when it runs.
  - It sits **outside** `SyncEngine` on purpose: the engine's rule is that nothing ever waits on a path
    (see the no-lock rule above), and the queue only decides how many engine calls are in flight.
  - Covered by `op-queue.test.ts` (L0) and wired in `SyncHost` (below).

## The host loop

- **One host loop runs on every client (`SyncHost`, `packages/engine/src/host.ts`).** The plugin's
  `EngineHost` and the CLI's `runDaemon` are thin adapters over it; the loop itself — the bind pass and
  its `bindCompleted` gate, a reconcile that is never re-entered, a reconcile on a **re**connect and not
  on the first connect, the settings poll that reports one failure per outage, the `OpQueue`
  around event-driven work, the **local-burst pass** (below), session-id propagation, and `stop()` —
  exists once. It used to exist twice,
  and the copies had already drifted: the CLI kept running its watcher and interval after
  `user_key_revoked` while only logging "Sync stopped", and it hardcoded an exclusive weight instead of
  `weightForSize`. What a host still owns is what is genuinely host-specific: the event source
  (`SyncEventSource` — Obsidian's `vault.on`, or `fs.watch` coalesced and answered by reading the path),
  the adapter, the state store (`data.json` vs `sync_state.json`), the network (`requestUrl` vs `fetch`),
  the log lines and the `Platform` the timers and the lease's `process` probe schedule through. The
  engine names no global of its own: the renderer creates timers on `window` and has `process` only on
  desktop, Bun's timers are `unref`'d so an idle daemon can exit, and a runtime with no process table
  (the plugin on mobile) leaves the lease deciding on expiry alone.
  `user_key_revoked` / `user_key_disabled` / `vault_deleted` stop the host **before**
  reporting, on both clients. `vault_settings` is the one exception that is neither terminal nor
  sync work: the vault's retention limits are display state (the server trims by its own copy), so the
  host only forwards the pair to `onVaultSettings`, which is how an open settings page follows a change
  made on another device. So does an **HTTP** `401`/`403` (`UNAUTHORIZED`, `KEY_EXPIRED`,
  `KEY_DISABLED`): a pass that fails on a dead credential used to be retried every pass, which left a
  client that looked like it was syncing while every request it made was refused. One callback,
  `onAuthFailure(reason)`, carries the three ways a credential stops working; each host decides what the
  binding is worth (revoked = drop it, expired/disabled = pause and keep it). Covered by
  `packages/engine/src/host.test.ts` (L0: bind gating, reconnect-only reconcile,
  single-flight, failed-bind retry, the settings poll, revocation, session id) plus the plugin's
  `host.test.ts` (the Obsidian wiring) and `cli-daemon.e2e.test.ts` / `plugin.e2e.test.ts` (L1/L2).
  - **A failed bind is retried on its own backoff**, not by waiting for the periodic pass:
    `BIND_RETRY_INITIAL_MS` (30 s) doubling to the reconcile interval, cancelled by a bind that
    completes and cleared on `stop()`. The failures a bind actually meets are transient — a rate-limiter
    window, an outage, a server still starting — and five minutes per attempt turned a large vault's
    first connect into hours (see [first-bind-performance.md](first-bind-performance.md)).
  - **A pass reports how far it has got** (`EngineOptions.onProgress`, `SyncProgress{done,total}`), at
    coarse steps of `PROGRESS_STEP_FILES` plus one report at the end. `total` **grows during a bind**,
    because the creates are discovered as the scan walks the vault, so `done === total` is the pass's own
    "finished" signal rather than a fixed job's completion. `SyncHost.binding` says whether that pass is
    still the bind, which is what lets a host show "first sync" instead of "not synced" — the two
    were indistinguishable, and the second one reads as a fault.
  - **`binding` is not "first time": every `start()` runs a bind pass.** The pass exists because a
    local file this device has **never tracked** must _merge_ rather than be deleted by the connection's
    view of the remote, so a months-old vault still runs one on every app start (it is cheap: stamps
    and one index read). A file the state already tracks is decided from its sync point like any other
    chain, so a peer's deletion made while the device was paused or closed is applied on the next
    start instead of the surviving copy being pushed back as a new file. `SyncHost.firstSync` is the
    narrower fact a status surface needs: `binding` **and** no bind has ever completed for this vault on
    this device. That completion is **persisted beside the per-file state** — the state store's optional
    `loadBindCompleted`/`saveBindCompleted` pair, which the plugin keeps as `syncState.bindCompleted`
    and the CLI as a sibling file next to `state/<vault>.json` — never inside the state JSON, which is
    the engine's `localVersions` map keyed by fileId. The distinction matters: "no sync point was
    loaded" is not the same fact, because a daemon killed after persisting 30 000 of a 50 000-file bind
    leaves a non-empty state, and its next start is still the bind that finishes the job. The plugin's
    tooltip and the CLI's runtime record both read the flag that way, so a restart says "syncing" and a
    half-finished first connect keeps its counter.

## Restore

- **A restore never writes over a file that is not its own.** Bringing a deleted file back means writing
  at the path it used to live at, and that path can have been taken since (a note another device created
  there while the file was deleted, or a note the engine has not indexed yet).
  `SyncEngine.inspectRestoreTarget` resolves the target first (`free` / `same-chain` / `other-file` /
  `unattributed`), `restoreFile` refuses anything but a free or same-chain path with a
  `RestoreBlockedError`, and `options.targetPath` brings the content back **under another name** instead
  (the restore version records that path, so peers materialise it there — still one chain per path).
  The recycle bin deliberately does **not** pre-check whether such a row's path is taken: it renders the
  deleted rows, and the click is where the question is answered. The click-time flow resolves the real
  target with `inspectRestoreTarget` and, when it is taken, asks the user for another **file name**
  (`RestorePathModal`, shared with the version-history view): the field is pre-filled with the original
  name plus `-1` (`hero.md` → `hero-1.md`, raised to `-2`… while those are taken —
  `shared/restore-name.ts`), the folder stays the original one, and a name that is taken as well is
  answered inside the dialog rather than by closing it.
  The name also has to stay **inside this device's sync scope** when the file being restored is in it:
  the field is free text, so typing `hero-1` for `hero.md` would drop the copy into `otherTypes` (off by
  default), and the restored note would sit in this vault while no peer ever materialised it — the whole
  reason the field is checked against `SyncEngine.isSyncablePath`, the engine's own scope predicate (the
  engine answers rather than the dialog rebuilding a scope from settings, because the scope is read once,
  when the host is built). A chain this device does not sync at all — a `.pdf` with that type switched
  off, or a file in a folder this device excludes — is deliberately _not_ constrained by this: restoring
  it under an equally out-of-scope name is what that device asked for. `targetPath` is the one path that
  reaches the engine from a person rather than from the vault or the server; every other door goes
  through the scope guard already.
  A row that is occupied keeps its Restore button enabled — the path being busy changes the name, not the
  possibility — and only a chain with nothing restorable left is disabled.
  Overwriting used to destroy the
  occupying note's live content and leave two chains claiming one path, which the next reconcile
  "resolved" by pushing the restored bytes into the occupant's chain. No server-side check is possible
  here: paths are AES-GCM encrypted with a random IV, so the server cannot tell that two rows name the
  same path — the decision is the client's. Covered by the `restoring onto a path that is no longer free`
  tests in `engine.test.ts`, the recycle-bin cases in `plugin.e2e.test.ts`, and the real-Obsidian case.
  Two consequences of the same rule, both in the plugin: `restoreFile` writes at the chain's **own live
  path** (`pathForFileId`) rather than the argument, because an open dialog's path can be one a rename has
  moved on from — writing there would leave one chain live at two paths; and the version-history view and
  the recycle bin share one interaction (`packages/plugin/src/shared/restore-flow.ts`), so an occupied path
  is answered with the same name dialog on both. A chain whose only remaining version is the tombstone
  (retention pruning or the vault's history limit removed the restorable one) is not offered a restore at all.
