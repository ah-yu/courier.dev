import type { MessageKey } from "./zh";

/**
 * The CLI's English catalog.
 *
 * Typed as a complete `Record<MessageKey, string>`, so an added, renamed or removed
 * Chinese key is a compile error here. English copy is sentence case, uses correct
 * plurals through the `.one` / `.other` key pairs, and keeps command/flag/id values
 * untranslated.
 */
export const en: Record<MessageKey, string> = {
  "common.none": "(none)",
  "common.listSeparator": ", ",

  "cli.description":
    "Headless sync CLI for Courier (syncs an Obsidian vault folder with the server)",
  "cli.option.lang":
    "Output language: zh or en (default: the system language, English when unrecognized)",
  "cli.command.vault.description": "Manage the vault binding",
  "cli.command.register.description":
    "Save the server URL, user key and the device name this machine syncs under",
  "cli.command.logout.description":
    "Remove this machine's server URL, user key and every vault binding",
  "cli.command.vaultConnect.description":
    "Bind this machine to a remote vault (derives + stores the vault key locally)",
  "cli.command.vaultCreate.description":
    "Create a remote vault and bind it to a local folder (derives its key from the vault password)",
  "cli.command.vaultUpdate.description":
    "Change a bound vault's settings (device name, file types, excluded folders) without the vault password",
  "cli.command.vaultDisconnect.description":
    "Remove a remote vault binding and delete its local sync state",
  "cli.command.run.description":
    "Start headless sync for one vault (watch + websocket + periodic reconcile)",
  "cli.command.status.description": "Show the sync status",
  "cli.command.version.description": "Print the version and build identity",
  "cli.command.device.description": "Manage the name this machine syncs under",
  "cli.command.deviceRename.description": "Set the name written into the sync history from now on",

  "cli.option.server": "Server base URL, e.g. http://vps.example.com",
  "cli.option.userKey": "The user's ck_ key (shared by all their devices)",
  "cli.option.name": "Device name shown in the sync history (default: hostname)",
  "cli.option.vaultId": "Remote vault id",
  "cli.option.vaultName": "Name of the new remote vault",
  "cli.option.vaultPath": "Absolute path of the local vault folder",
  "cli.option.deviceName":
    "Device name this vault's pushes state (one per vault; defaults to this machine's name)",
  "cli.option.vault": "Vault id to act on (selects one when several are bound)",
  "cli.option.password": "Vault password (alternatively set COURIER_VAULT_PASSWORD)",
  "cli.option.syncFileTypes":
    "Sync these vault file types (bare = the defaults: images,video,audio,pdf; " +
    "empty = markdown and canvas only; comma list of images,video,audio,pdf,otherTypes)",
  "cli.option.syncOtherTypes": "Also sync every other file type (.base, .excalidraw, archives, …)",
  "cli.option.excludeFolders":
    "Leave these vault folders out of sync (comma list; --exclude-folders= clears)",
  "cli.option.historyLimitDocuments":
    "Versions of each markdown note and canvas file the vault keeps on the server (default 200)",
  "cli.option.historyLimitAttachments":
    "Versions of every other file the vault keeps on the server (default 10)",
  "cli.option.once": "Run a single reconcile pass and exit",
  "cli.option.interval": "Full-reconcile interval in minutes (default 30)",
  "cli.option.takeOver":
    "Take the vault from whichever syncer holds it, once, at the first refusal",
  "cli.option.json": "Output as JSON",

  "cli.error.invalidLanguage": 'Unsupported language "{value}". Valid values: zh, en.',
  "cli.error.missingLanguage": "`--lang` needs a value: zh or en.",
  "cli.error.notConfigured": "Not configured. Run `courier-cli register` first.",
  "cli.error.invalidUserKey": "Registration failed: invalid user key ({error}).",
  "cli.error.vaultPasswordRequired":
    "Vault password required: pass --password or set COURIER_VAULT_PASSWORD.",
  "cli.error.incorrectVaultPassword": "Incorrect vault password.",
  "cli.error.vaultNameRequired": "Pass `--name` to name the new remote vault.",
  "cli.error.vaultNameTooLong": "A vault name is at most {max} characters.",
  "cli.error.deviceNameRequired": "The device name cannot be empty.",
  "cli.error.vaultNotBound": "No vault with id {id} is bound on this machine.",
  "cli.error.notBound": "No vault bound. Run `courier-cli vault connect` first.",
  "cli.error.connectFirst": "Run `courier-cli vault connect` first.",
  "cli.error.pathEscapes": "Path escapes vault root: {path}",
  "cli.error.unknownVault":
    'No vault "{vaultId}" is bound. Run `courier-cli vault connect` to add it.',
  "cli.error.multipleVaults":
    "This machine has {count} bound vaults. Each runs in its own process; pass `--vault <id>` to choose one.",
  "cli.error.vaultPathOverlap":
    'Local folder "{path}" overlaps the bound {other}. One folder belongs to one vault; choose another path.',
  "cli.error.syncLocked":
    "Another syncer (the Obsidian plugin or another CLI) is writing this vault. Stop it first.",
  "cli.error.takeOverFailed": "Could not take the vault from its writer (--take-over).",
  "cli.error.leaseFailed":
    "Cannot access the sync lease: {error}. This is a filesystem error (permissions, space, or a damaged path), not another syncer.",
  "cli.error.contractServerOutdated":
    "The server this CLI is configured for is too old. Upgrade the server, then run this command again.",
  "cli.error.contractClientOutdated":
    "This CLI is too old for this server. Update courier-cli, then run this command again.",

  "cli.register.saved": 'Saved device name "{deviceName}".',
  "cli.register.vaultCount": "{count} vault(s) currently bound on this machine.",
  "cli.logout.done": "Logged out and removed {count} vault binding(s) from this machine.",
  "cli.logout.none": "This machine is not logged in; nothing to clear.",
  "cli.create.created": 'Created remote vault "{name}" ({id}).',
  "cli.connect.connected": "Bound vault {vaultId} at {path}; {count} vault(s) on this machine.",
  "cli.connect.deviceName": "Device name: {value}.",
  "cli.update.saved":
    "Updated {vaultId}: device name {device}, file types {fileTypes}, excluded folders {folders}.",
  "cli.disconnect.done": "Removed the vault {vaultId} binding; {count} vault(s) remain.",
  "cli.disconnect.running":
    "That vault's daemon is still running. Stop it (or end its `courier-cli run --vault` process).",
  "cli.connect.fileTypes": "File types: {value}.",
  "cli.connect.excludedFolders": "Excluded folders: {value}.",
  "cli.connect.historyLimits": "History versions: {value}.",
  "cli.run.stopping": "Stopping...",
  "cli.run.started":
    'Started headless sync: {vault}, {vaultPath} against {serverUrl} (device "{deviceName}"). ' +
    "See `courier-cli status --vault {vaultId}` for details.",
  "cli.version.line": "Version {version} ({gitSha}, built {buildTime}, runtime {runtime})",
  "cli.device.renamed": 'Device name set to "{deviceName}".',

  "cli.status.label.server": "Server",
  "cli.status.label.contract": "Compatibility",
  "cli.status.contract.serverTooOld": "the server's version is too old — upgrade it",
  "cli.status.contract.clientTooOld": "this CLI is too old — update courier-cli",
  "cli.status.label.defaultDevice": "Default device",
  "cli.status.label.device": "Device",
  "cli.status.label.vaults": "Vaults",
  "cli.status.label.vault": "Vault",
  "cli.status.label.path": "Path",
  "cli.status.label.daemon": "Daemon",
  "cli.status.label.lease": "Lease",
  "cli.status.lease.free": "free (first come, first served)",
  "cli.status.lease.cli": "CLI process (PID {pid})",
  "cli.status.lease.plugin": "Obsidian plugin",
  "cli.status.label.obsidian": "Obsidian",
  "cli.status.label.state": "State",
  "cli.status.label.fileTypes": "File types",
  "cli.status.label.historyLimit": "History",
  "cli.status.label.excluded": "Excluded",
  "cli.status.label.conflicts": "Conflicts",
  "cli.status.label.tooLarge": "Too large",
  "cli.status.label.hint": "Hint",

  "cli.status.value.notConnected": "(not connected)",
  "cli.status.value.tracked": "tracked",
  "cli.status.value.noState": "(no sync state yet)",
  "cli.status.fileTypes.value": "{types} ({cap})",
  "cli.status.fileTypes.valueOnly": "{types} only ({cap})",
  "cli.status.cap.unlimited": "max unlimited, admin-set",
  "cli.status.cap.limited": "max {megabytes} MB, admin-set",
  "cli.status.historyLimit.value": "notes/canvas {documents}, attachments {attachments}",
  "cli.status.historyLimit.unknown": "(not readable from the server)",
  "cli.status.conflicts.one": "1 parked file: {files}",
  "cli.status.conflicts.other": "{count} parked files: {files}",
  "cli.status.tooLarge.one": "1 file over the cap: {files}",
  "cli.status.tooLarge.other": "{count} files over the cap: {files}",
  "cli.status.hint": "run `courier-cli run --vault <id>` to start syncing",
  "cli.status.hintWithDaemon":
    "each vault runs in its own process: start one with `courier-cli run --vault <id>`; " +
    "the first process to take the vault's lease syncs it, and the other waits.",
  "cli.status.hintNotBound": "no vault is bound: run `courier-cli vault connect` to add one.",
  "cli.status.vaults.count": "{count}",
  "cli.status.daemon.stopped": "not running",
  "cli.status.daemon.starting": "starting (PID {pid})",
  "cli.status.daemon.running": "running (PID {pid})",
  "cli.status.daemon.runningSince": "running (PID {pid}), last activity at {time}",
  "cli.status.daemon.otherWriter": "waiting for another syncer to release the lease (PID {pid})",
  "cli.status.daemon.failed": "stopped (PID {pid}): {error}",
  "cli.status.obsidian.closed": "not open; the CLI owns sync",
  "cli.status.obsidian.plugin": "open and the Courier plugin is set up to sync",
  "cli.status.obsidian.pluginOff": "open, but the plugin is not set up to sync",

  "cli.config.error.unknownFileType": 'Unknown file type "{name}". Valid types: {valid}.',
  "cli.config.error.historyLimit":
    'A history limit is a whole number of versions between 1 and {max}, got "{value}".',
  "cli.options.error.interval":
    '--interval takes a non-negative number of minutes, got "{value}" ' +
    "(0 disables the periodic reconcile).",

  "cli.log.conflict.remoteDelete":
    'Conflict on "{path}": the remote deletion was applied, nothing local to keep.',
  "cli.log.conflict.remoteAdopted":
    'Conflict on "{path}": the remote version was adopted (no local content).',
  "cli.log.conflict.parked":
    'Conflict on "{path}": the remote version won, your content is in "{conflictPath}".',
  "cli.log.tooLarge":
    'Skipped "{path}" ({megabytes} MB): over the maximum sync file size. ' +
    "Your administrator sets that limit per key; ask them to raise it.",
  "cli.log.limitsUnavailable":
    "Could not read the account's file-size limit ({error}); using {megabytes} MB for now.",
  "cli.log.reconciled.one": "Reconciled in {milliseconds}ms; 1 conflict file in the vault.",
  "cli.log.reconciled.other":
    "Reconciled in {milliseconds}ms; {count} conflict files in the vault.",
  "cli.log.connected": 'Connected to server (device "{deviceName}").',
  "cli.log.bindFailed": "Initial reconcile failed ({error}); retrying shortly.",
  "cli.log.progress": "Syncing: {done} of {total} files ({percent}%).",
  "cli.log.rateLimited": "Server rate limit reached; waiting {seconds}s before continuing.",
  "cli.log.keyRevoked": "Sync stopped: the user key was revoked.",
  "cli.log.keyExpired": "Sync stopped: the user key has expired.",
  "cli.log.keyDisabled": "Sync stopped: the user key is disabled (its data stays on the server).",
  "cli.log.vaultDeleted": "Sync stopped: the vault was deleted on the server.",
  "cli.log.watching.one": "Watching {vaultPath}; 1 conflict file in the vault.",
  "cli.log.watching.other": "Watching {vaultPath}; {count} conflict files in the vault.",
  "cli.log.fileSkipped": 'Skipped "{path}": the path is too long for the server\'s limit.',
  "cli.log.eventFailed": "Event failed for {path}: {error}",
  "cli.log.watchUnavailable": "Watch unavailable ({error}); relying on the polling interval.",
  "cli.log.obsidianWaiting":
    'Obsidian has "{vault}" open and the Courier plugin is syncing; this vault\'s CLI process ' +
    "is parked and will resume when Obsidian closes.",
  "cli.log.obsidianResumed": 'Obsidian closed or its plugin paused; "{vault}" resumed syncing.',
  "cli.log.leaseWaiting":
    'Another syncer holds the "{vault}" lease; this process waits without starting an engine.',
  "cli.log.leaseResumed": 'The sync lease was released; "{vault}" resumed syncing.',
  "cli.log.takingOver":
    'Taking the "{vault}" lease from {holder} (--take-over). That writer stops within seconds; a pass it already started finishes first.',
  "cli.lease.holderUnknown": "another writer",
  "cli.lease.ownerCli": "the CLI",
  "cli.lease.ownerPlugin": "the Obsidian plugin",
  "cli.lease.pid": "PID {pid}",
  "cli.lease.host": "on {host}",
  "cli.log.coexistenceFailed":
    "Could not tell whether Obsidian is syncing ({error}); treating it as closed.",
  "cli.log.startFailed": "The sync process failed to start ({error}); retrying shortly.",
};
