# Device-local sync scope and Obsidian settings sync

> Status: `authoritative`. This is what a device pushes, pulls, deletes and parks — and the
> config-folder half of it. The user-facing CLI flags and tables are in [`cli.md`](cli.md); the
> config-folder groups are the plugin's and are described here. The extension table is
> `packages/engine/src/file-types.ts` and the predicate is `packages/engine/src/sync-scope.ts`.

## Ownership and the predicate

- **A device-local sync scope decides what leaves and enters it, and the decision holds on both ends of
  the wire.** `sync-scope.ts` owns the one predicate (`isSyncablePath`, with `isSyncableDir` as its
  pruning half) and `file-types.ts` owns the extension table that feeds the vault half of it. Ownership
  is total and exclusive, in this order: `*.conflict.*` copies never sync; a hidden (dot-prefixed) name
  never syncs; a path **inside the config folder** belongs to exactly one settings group
  (`settingsGroupOf`) and the file-type rules do not apply there (`themes/**` needs `themes`, and
  `.obsidian/plugins/x/icon.png` needs `communityPlugins`, not `images`); anywhere else a path under an
  **excluded folder** never syncs, and `fileTypeOf` names the category.

## File types

- **File types**: markdown (`.md`) and JSON Canvas (`.canvas`) are synced on every device and have no
  switch. `images` (`.avif` `.bmp` `.gif` `.jpeg` `.jpg` `.png` `.svg` `.webp`), `audio` (`.flac`
  `.m4a` `.mp3` `.ogg` `.wav` `.3gp`), `video` (`.mkv` `.mov` `.mp4` `.ogv` `.webm`) and `pdf` are on
  by default and can each be switched off per device; `otherTypes` — everything the table does not
  claim (`.base`, `.markdown`, `.excalidraw`, archives, extension-less files) — is off by default.
  Table order decides ties, so every extension has one owner (`.webm` is Obsidian's only double
  listing and video wins). `DEFAULT_FILE_TYPES` is the default record; a switch that is missing or
  unknown keeps its **default** rather than reading as off.

## Excluded folders

- **Excluded folders** (`excludedFolders`) are the third switch in the same device-local scope: a vault
  path equal to an entry or under `entry + "/"` never syncs — not pushed, not pulled, not turned into a
  conflict copy, and not deleted by turning the exclusion on or off. On the plugin the list is stored
  **per remote vault** (`vaultConnections` in `shared/settings.ts`); `excludedFolders` is the active
  vault's projection, and an **empty** list still counts as a completed configuration — the record's
  presence, not the list length, is what makes a later connect open as a confirmation of the saved
  values instead of a first-time setup. The list is normalized once by
  `normalizeScope` (`normalizeExcludedFolders`: forward slashes, no leading/trailing slash, no empty or
  `.` segments, an entry containing `..` dropped, duplicates removed) and applies only outside the config
  folder, which stays governed by the settings groups. It is wired through the same door as the file
  types (`isSyncablePath` / `isSyncableDir`), so the remote chains and the identity indexes are filtered
  too. A chain whose **recorded local path** is out of scope (this device moved its file into an
  excluded folder) is left out of the identity index even though the server still records the old path:
  keeping it there would reserve the vacated path for a chain that no longer lives there, so a new note
  created at that path would never be pushed and a local event could hand the parked chain an identity
  its bytes no longer match. Turning an exclusion off deletes nothing; the state entries and remote
  chains stay put and the next pass resumes from them.
  A tracked file moved into an excluded folder has to stay that chain, and there are two shapes to
  handle. When the host reports a rename (`Obsidian` does, with both paths), `handleLocalRename`
  records the new path in that path's job (and drops the chain from the remote index)
  **without pushing**, so the vacancy at the old path cannot become a tombstone; moving it back in
  resumes the same chain as a `rename`. When the move arrives as "removed here, created there" (an
  external tool, the CLI's `fs.watch`, a plugin that was not running), the created half is dropped by
  the scope and the removal would become a deletion: `applyLocalDelete` and `repairMovedFile` therefore
  look in the excluded folders before deciding — same file name, same size when the state has one, and
  **exactly one** candidate whose bytes hash to the sync point (`SyncAdapter.listExcludedFiles`, a
  listing only, cached for 30 s so a delete burst walks the folders once). A match records the new path
  and pushes nothing; no match keeps the normal deletion. A move that also renames is not matched (the
  name is the cheap first filter), and that limit is documented in `docs/cli.md`. `repairMovedFile`
  refuses an excluded recorded path (a same-content file is not that chain), and the reconcile's delete
  branch re-checks the state's current path before pushing a tombstone a stale snapshot decided on.
  A **restore** is the one write allowed to land outside the scope: the recycle bin lists what the
  server holds whatever this device syncs, so a user asking for a version back is an explicit action;
  the restored version is pushed, and the path stays excluded here afterwards (see `restoreFile`).
  The plugin's **entry points** follow the same rule (`shared/file-actions.ts`): a file under an
  excluded folder carries no version-history chip and no file-menu item, and a `*.conflict.*` name
  there gets no conflict action. The answer follows the **scope**, not the file: a chain from before
  the exclusion (or one this device moved into the folder) is still kept — see above — and a copy
  parked before the exclusion is still on disk, but none of them is offered an action from here.
  The recycle bin stays reachable regardless, because it lists the server's chains rather than this
  device's files.

## Size cap

- **The size cap** (`maxFileBytes`, default 50 MiB, `0` = unlimited) is a **per-user-key**
  value the server owns: the host sets it on the account (`POST/PATCH /api/users`), every
  official client reads it from `GET /api/me` when its host starts, and **neither the plugin
  settings page nor the CLI exposes a user-facing way to change it**. It bounds what a device
  **sends**, and a file over it is skipped **before it is read** — the engine reads a file
  whole to hash it (and encrypts it in one buffer below the chunk threshold), so the cap is
  what keeps a phone from dying on a large video. A file above 8 MiB is transferred in 4 MiB
  chunks ([sync-engine.md](sync-engine.md#chunked-transfer)), which bounds the ciphertext and
  the request bodies but **not** that one plaintext copy: measured on a 50 MiB file, the
  upload's bind peak is about 3.3× (167 MiB) and max RSS about 6.2× (309 MiB), where it used
  to be 9×/11×; a download peaks below 1× (47 MiB). The cap therefore stays a safety valve,
  and `0` is still a deliberate risk on a phone. Locally the cap comes from
  `SyncAdapter.statFile` (Obsidian's `TFile.stat.size` / `DataAdapter.stat`, the CLI's `fs.stat`);
  **a peer's chain is never refused for size**: a version someone already uploaded is part of
  the vault, and skipping it made the file silently absent from a new device — indistinguishable
  from data loss — so a lowered cap changes what this device will send, never what it will
  receive. (This is the one place the two directions differ.) A `delete` head is always
  honoured. Reported through `EngineOptions.onFileTooLarge`
  (once per path per pass), the CLI's daemon log and `status`'s "Too large" line. Raising the
  cap makes a local file eligible again on the client's next host start. It is a client-side guard
  rail, not the server's resource limit (that is `storageBytesLimit`), because plaintext size is
  client-declared.

## Version history kept on the server

- **The history limit is the vault's, not this device's.** `vaults.history_limit_documents` (200) and
  `vaults.history_limit_attachments` (10) live on the server, are edited through `PATCH /api/vaults/:id`
  by the plugin's settings page and the CLI's `vault connect` / `vault update` flags, and are read by
  every device of the vault — so one device changing them changes them for all, and the last device to
  edit a file cannot impose its own bound. This module has **no** history field: the engine only
  classifies each file with the table the file types use (`fileTypeOf` — markdown and canvas are
  `"always"`, every other path is an attachment) and states that `historyKind` on the push
  ([api.md](api.md#9-push-local-changes)), because the category is only visible in the plaintext path.
  The server applies its own numbers in the insert transaction and, on a lowering, trims the chains
  already stored ([server.md](server.md)). This is independent of the administrator's age-based
  `retentionDays`.

## Conflict copies

- **Conflict copies keep the original extension**: `{stem}-{YYYY-MM-DD-HHmmss}[-n].conflict{ext}` —
  `note-2026-02-14-101530.conflict.md`, `photo-2026-02-14-101530.conflict.png` for an image, `.conflict.md`
  as the fallback for a path with no extension. The name is local time to the second, and `-n` only
  appears when a second conflict is parked inside the same second, so a burst of conflicts no longer
  needs `-2`/`-3` to be told apart. `isConflictFile` matches exactly that name — date, time,
  optional counter, kept extension — and runs first, so a parked binary copy never syncs even while
  its own category is on. The extension split happens on the file name, not the whole path, so a
  folder called `notes.v2` keeps its folder.

## Settings groups

- **Settings groups** (the config-folder half): the ten groups mirror the categories Obsidian's own
  Sync offers — `app` (`app.json`), `appearance` (`appearance.json`), `themes` (`themes/**`),
  `snippets` (`snippets/**`), `hotkeys` (`hotkeys.json`), `corePlugins` (`core-plugins.json`),
  `corePluginSettings` (every **other** top-level `*.json` — a catch-all, so a core plugin added later
  needs no code change), `communityPluginList` (`community-plugins.json`: which community plugins are
  _enabled_ — a state list), `communityPlugins` (`plugins/<id>/**`: the **installed** plugin bodies —
  `main.js`, styles, assets, `data.json`; Obsidian's two community-plugin switches, kept separate here
  too, so a device syncing only the list will list plugins it does not have), and `otherFiles` (the
  config folder's unclaimed files). All ten are off by default. Only the Obsidian plugin turns them
  on; the CLI runs with every group off and never syncs the config folder at all (see
  [cli.md](cli.md#obsidian-settings-the-config-folder--the-plugins-job)). `themes` and `snippets`
  are one category in Obsidian's UI and two switches here. The engine applies the predicate to the
  local listing, to the events a host feeds in **and to the remote chains** — including the identity
  indexes — so a device that leaves a group off neither pulls, nor deletes, nor parks a conflict file
  for a peer's chain of that group (ignoring only the local side is what turned "peer has settings on"
  into a pull-conflict loop every pass). The predicate also has one public door,
  `SyncEngine.isSyncablePath`, for the single path that comes from a person rather than from the vault
  or the server — the new file name a restore is put under (see
  [sync-engine.md](sync-engine.md#restore)); it answers from the scope the engine was built with,
  never from a second reading of the settings. Hard exclusions, in every scope:
  `workspace.json` / `workspaces.json` / `workspace-mobile.json` (the layout Obsidian rewrites
  constantly), `sync.json`, `ui-state.json`, `core-plugins-migration.json`, `cache/**`, every dot-folder
  other than the config one, `*.conflict.*`, and `.obsidian/plugins/courier/**` — that last one holds
  this plugin's user key and sync state, so syncing it would hand a peer this device's credentials.

## Settings pass and polling

- The config folder is **not in Obsidian's vault index** and its files fire **no vault event**
  (`vault.adapter` is the only way in, and it emits nothing), so the Obsidian host cannot learn about a
  local settings change from an event. `SyncEngine.syncLocalSettings()` is the small pass that host
  runs on a timer when any group is on — it lists, hashes and reads only the settings paths, re-reads a
  file before believing a listing that lacks it, and returns immediately before the first bind (which is
  what decides which local settings files are the user's own). The periodic reconcile stays the safety
  net. **The interval is host-specific and that is the whole latency of a settings change**: Obsidian's
  pass costs 0.7–2 ms (13 ms with every group on and 109 config files; its listing is the in-memory vault
  index plus a scope-pruned config walk — `stat` per settings file, and the stamp cache means an unchanged
  file is never read again), so its host polls every **1 s**; the engine's **30 s** default is the
  fallback for a host that does not choose one (the CLI starts no poll at all — it syncs no settings).
  One second is the floor on purpose: a
  shorter interval is faster than the platform's own clamp on a hidden window and than anything a person
  perceives, while each pass is a handful of I/O round trips (across the Capacitor bridge, on mobile).
  Nothing accumulates per pass — the arrays it allocates die immediately and the engine's state is updated
  in place — and a pass that is still running makes the next tick a no-op, so a slow vault cannot pile
  passes up. Before this, the host sat at 30 s and "I toggled a core plugin and nothing happened" was the
  reported symptom. `OBSIDIAN_DEFAULT_GROUPS` records Obsidian Sync's default set (the e2e suites bind
  devices with it); the plugin has no shortcut for it (each group is switched on individually in the
  settings page).
- Turning a group, a file type or an excluded folder on/off restarts the host: the plugin's
  `CourierPlugin.restartHostForScope` for every switch on its page, and
  `vault connect --sync-file-types[=<types>] / --sync-other-types / --exclude-folders=<paths>` for the
  CLI's. The scope is read once, when the engine and the adapter are built. Turning one off deletes
  nothing on either side; the state entries stay, so turning it on again resumes where it stopped. The
  **size cap** is not one of these switches — it is the account's per-key value, and a host start
  re-reads it (see the size-cap rule above).

Covered by `sync-scope.test.ts` (one group, one file type and one excluded folder at a time,
ownership, the cap), `file-types.test.ts` (the extension table), `conflict-file.test.ts` (the naming
rule), the `SyncEngine — the sync scope` and `SyncEngine — vault file types and the size cap` cases in
`engine.test.ts`, `packages/e2e/src/settings-sync.e2e.test.ts`,
`packages/e2e/src/excluded-folders.e2e.test.ts`, `packages/e2e/src/attachment-sync.e2e.test.ts`, the
`Obsidian settings sync` / `vault file types` / `excluded folders` cases in `plugin.e2e.test.ts`, and
the config-folder, attachment and excluded-folder cases in the real-Obsidian suite.
The settings e2e layers walk the **whole option list** and each switch's off state — the settings
groups (and the files each one owns, taken from the same table as `sync-scope.test.ts`) and every
file type — so a group or type added later cannot lose its cases silently. The CLI's half of the
rule is pinned by `packages/cli/src/config.test.ts`: `syncScopeOf` never enables a group, whatever a
stored binding says.

## Applied is not live

- **Applying a settings file is not the same as the running app using it, and the engine says which is which.**
  Obsidian reads its config folder at start-up and then works from memory: a file this plugin writes
  (through `vault.adapter`, the only way into that folder) changes nothing the user can see. **Which**
  files that holds for is a property of the platform and was measured against a real Obsidian (1.14.4),
  not taken from the docs — the app does watch its config folder, and `app.json`, `hotkeys.json`, a theme
  _name_ in `appearance.json` and the _list_ of snippet files take effect live; a theme folder that
  arrives, the snippet **enable** list in that same `appearance.json`, a core plugin's state and a
  community plugin's install/enable do not (Obsidian's own Sync documents the same split for the parts it
  applies in-process). This project cannot close the gap from a third-party plugin: `app.internalPlugins`
  (the app's own record, with `getPluginById` / `getEnabledPluginById` / `requestSaveConfig`) is outside
  the public API, and `app.commands` — the only way to ask for the reload — is too; the `customCss` and
  `hotkeyManager` internals that provide the live half (`boundRaw`, `requestReadThemes`, `onConfigFileChange`)
  are equally private. `SyncEngine` therefore reports every config-folder file it applies from the remote
  through `EngineOptions.onSettingsApplied` (`SettingsAppliedEvent`: the path, whether it was written, moved or
  deleted, and **which settings group owns it** — the host judges the change, the engine does not know what a
  running Obsidian re-reads; **nothing** is reported for a vault file, and nothing for a chain this device's scope
  ignores), `SyncHost`/`EngineHost` forward it, and the plugin answers with **one card per dismissal** —
  its own element, not a `Notice` (`packages/plugin/src/shared/settings-reload-popup.ts`): Obsidian's notice
  container is anchored `top: 22px; right: 0` in 1.14.4, and a toast that vanishes on a timer is the wrong
  shape for something that carries a decision. The card is attached to `app.workspace.containerEl`, and its
  layout lives in `packages/plugin/styles.css` rather than in inline styles: bottom-right on desktop, a
  bottom sheet above Obsidian's floating mobile nav on a phone (offset by the app's own
  `--mobile-toolbar-height` plus the safe-area inset, with a 12 px floor because Android reports no inset),
  every colour and radius from Obsidian's CSS variables and `mod-cta` for the primary action. The icon is
  injected (`renderIcon`, wired to Obsidian's `setIcon`), so the plain unit test can build the card
  without the `obsidian` package. It is shaped like a status card — `role="status"`, a title, one sentence
  and Reload / Later — and is deliberately non-modal: it never takes focus. It names **no** file and no
  count — the change came from another device, and which path it was is the sync history's job. It never
  expires, `show()` is a no-op while the card is up (so a burst of changes, or a first bind of a phone's
  settings, raises exactly one), and the card is `detach()`ed — by Later, by the reload button, or by a plugin
  unload — which is what arms the next one.
  The reload itself is `app.commands.executeCommandById("app:reload")`, outside the public API, so the call
  is guarded and its absence is reported instead of swallowed. Only the groups on the one shared list
  (`packages/plugin/src/shared/settings-reload.ts`, `SETTINGS_GROUPS_NEEDING_RELOAD`) raise the card or carry
  the extra line under their switch: `app.json`, `appearance.json` and `hotkeys.json` are applied live by
  Obsidian, so asking for a reload after one of those is how a plugin teaches users to dismiss the card
  unread. Without any of it, a sync that worked is indistinguishable from one that failed, which is exactly
  how the first field report of this feature read.
  Covered by the `onSettingsApplied` cases in `engine.test.ts` (the event carries path, action and group),
  `settings-reload.test.ts` + `settings-reload-popup.test.ts` (which groups need a reload, that the card names
  no file, that its layout is left to the stylesheet (no inline positioning) and which classes/semantics it
  carries, and the whole show/one-at-a-time/dismiss/re-arm lifecycle against a fake element), the card
  cases in `plugin.e2e.test.ts` (through the real plugin: one card, nothing added while it is up, back after
  dismissal, silent for a hot group), and — in a real Obsidian — the case that
  asserts the file holds the peer's flipped `core-plugins.json` **while** `app.internalPlugins` still reports
  the plugin as enabled, the card the plugin raises for it (read from the DOM: one element, in the
  bottom-right corner, still there after 8 s, naming no file), plus the case that pins the live/stale split
  itself for hotkeys, `app.json`, core plugins, community plugins, themes and snippets.
