import type { PluginMessageKey } from "./zh";

/**
 * The English catalog.
 *
 * Typed over the Chinese catalog's keys, so the two can never drift apart.
 * English copy uses sentence case, straight quotes around vault paths and
 * explicit plural forms (the caller picks `.one`/`.other` via `plural()`).
 */
export const en: Record<PluginMessageKey, string> = {
  // ── Common ──
  "common.cancel": "Cancel",
  "common.ok": "OK",
  "common.retry": "Retry",
  "common.restore": "Restore",
  "common.listSeparator": ", ",
  "common.detailSeparator": "; ",

  // ── Action names for error prefixes ──
  "action.signIn": "Sign-in failed",
  "action.createVault": "Could not create the remote vault",
  "action.deleteVault": "Could not delete the remote vault",
  "action.fetchVaultInfo": "Could not read this remote vault's encryption details",
  "action.verifyVaultPassword": "Could not verify the vault password",
  "action.loadVaults": "Could not load the remote vaults",
  "action.loadHistory": "Could not load the sync history",
  "action.loadRecycleBin": "Could not load the recycle bin",

  // ── Validation / API errors ──
  "error.serverUrlRequired": "Enter the server address, for example http://localhost:3002.",
  "error.serverUrlScheme": "The server address must start with http:// or https://.",
  "error.serverUrlInvalid": "That server address is not valid. Check it and try again.",
  "error.unreachable":
    "Cannot reach the server. Check the address, your network, and that the server is running.",
  "error.keyExpired": "This user key has expired. Contact the server administrator.",
  "error.keyDisabled": "This user key has been disabled. Contact the server administrator.",
  "error.keyInvalid": "The user key is invalid or expired. Check the server address and key.",
  "error.vaultNotFound": "The server has no such remote vault (it may have been deleted).",
  "error.vaultLimitReached":
    "This account has used up its vault allowance. Ask the server administrator to raise it.",
  "error.withDetails": "{fallback}: {details}",
  "error.withMessage": "{fallback}: {message}",
  "error.keyRequired": "Enter your user key (ck_…).",
  "error.keyPrefix": "A user key starts with ck_.",
  "error.keyDerivation": "Could not generate the encryption key. Try again.",
  "error.signInKeyChanged": "The user key changed while signing in. Try again.",
  "error.vaultInfoMissing": "The vault details are missing. Choose the remote vault again.",
  "error.passwordIncorrect": "That vault password is incorrect.",
  "error.noFileId": "Could not find this file's sync record.",
  "error.conflictOriginalUnknown":
    "Could not tell which original file this conflict copy belongs to.",

  // ── Notices ──
  //
  // A notice is for an event the user did not start, and that no persistent surface will
  // show them. The result of the user's own click belongs to the surface they clicked in
  // (the settings page, a picker, a dialog), and an error caused by that click stays
  // inline there — see the `courier-setup-error` rows in the dialogs.
  "notice.bindFailed": "The first sync did not finish: {error}. The plugin will retry.",
  "notice.syncStartFailed": "Sync could not start: {error}",
  "notice.userKeyRequiredSettings": "A user key is required to sync. Add it in Courier settings.",
  "notice.serverUnreachableKeepKey":
    "Cannot reach the sync server. Your local key was kept; the next start will try again.",
  "notice.storedCredentialInvalid":
    "The saved credential cannot unlock this remote vault. Enter the password again.",
  "notice.needsResume": "Sync is paused. Resume it in settings first.",
  "notice.notConnected": "No remote vault is connected.",
  "notice.remoteVaultDeleted": 'Remote vault "{vault}" was deleted on the server. Disconnecting.',
  "notice.userKeyRevoked": "The user key was revoked. Disconnecting.",
  "notice.keyExpired":
    "The user key has expired. Syncing is paused — resume it in Settings after renewal.",
  "notice.keyDisabled":
    "The user key has been disabled. Syncing is paused — resume it in Settings once it is enabled again.",
  "notice.manualReload": "Quit and reopen Obsidian manually.",

  // ── Settings page: login / choose / locked ──
  "settings.login.title": "Sign in to Courier",
  "settings.login.subtitle": "Use your server address and user key to sign in.",
  "settings.login.serverAddress": "Server address",
  "settings.login.userKey": "User key",
  "settings.login.serverPlaceholder": "https://your-server.com",
  "settings.login.showKey": "Show user key",
  "settings.login.hideKey": "Hide user key",
  "settings.login.fullAddress": "Full address: {url}",
  "settings.login.submit": "Sign in",
  "settings.login.submitting": "Signing in…",
  "settings.account.reading": "Reading account…",
  "settings.account.unknown": "Unknown account",
  "settings.account.server": "Server: {url}",
  "settings.account.keyExpiry": "Key validity",
  "settings.account.storage": "Storage",
  "settings.account.detailSeparator": ": ",
  "settings.account.expiryValue": "{date} · {remaining}",
  "settings.account.usageUnavailable": "Could not read account information",
  "settings.account.signOut": "Sign out",
  "settings.choose.selectVault": "Choose a remote vault",
  "settings.choose.noVault": "No remote vault is connected.",
  "settings.choose.button": "Choose",
  "settings.locked.bound": 'Bound to "{vault}"',
  "settings.locked.desc": "Enter the vault password to unlock sync.",
  "settings.locked.unlockTitle": 'Unlock "{vault}"',
  "settings.locked.unlock": "Unlock with password",
  "settings.locked.disconnect": "Disconnect",
  "settings.unverified.desc":
    "The vault key is saved on this device; the server has not confirmed it this time. Retry now, or it will be tried again the next time Obsidian opens.",
  "settings.unverified.retry": "Retry",
  "settings.unverified.retrying": "Retrying…",
  "settings.unverified.failed": "Still cannot reach the server. Try again later.",

  // ── Settings page: state and sections ──
  "settings.state.paused": "⏸ Sync paused",
  "settings.state.connected": "● Connected",
  "settings.state.connecting": "○ Connecting…",
  "settings.state.error": "✕ Connection error",
  "settings.state.disconnected": "○ Disconnected",
  "settings.section.vault": "Remote vault",
  "settings.section.vault.tooltip":
    "This device's connection to the remote vault. Pausing only stops sync; the connection and this device's credentials stay. Disconnecting unbinds the vault and clears the vault password saved here. Neither changes the vault or anything on the server.",
  "settings.section.fileTypes": "File types",
  "settings.section.fileTypes.tooltip":
    "Markdown and Canvas always sync. A type you switch off is neither pushed nor pulled on this device, and nothing is deleted on either side.",
  "settings.section.excludedFolders": "Excluded folders",
  "settings.section.excludedFolders.tooltip":
    "Excluded folders and their contents are neither pushed nor pulled on this device, and no conflict copies are parked for them. Excluding deletes nothing; removing an exclusion resumes syncing. The list applies to the connected remote vault only; excluding nothing still counts as configured. The config folder (.obsidian) is controlled by the settings sync below.",
  "settings.section.settingsSync": "Obsidian settings sync",
  "settings.section.settingsSync.tooltip":
    "Each group in the config folder (.obsidian) can be switched on separately. A group you switch off is not affected by other devices, and no conflict copies are parked for it. If both sides edit the same file, the newer modification time wins. Pulled settings may need a reload of Obsidian to take effect; workspace layout, caches and this plugin's own settings never sync.",
  "settings.section.account": "Account",
  "settings.section.account.tooltip":
    "The account this device syncs with. Signing out clears the key and connection saved on this device; nothing on the server changes.",
  "settings.section.device": "This device",
  "settings.section.device.tooltip":
    "This name is only a label in the current remote vault's sync history. It is saved per remote vault; the server registers no devices and does not identify you by it.",
  "settings.ready.connected": 'Connected to "{vault}"',
  "settings.ready.disconnect": "Disconnect",
  "settings.pause.name": "Sync",
  "settings.pause.descRunning":
    "Sync is on. Pausing only stops sync on this device; it does not disconnect the remote vault.",
  "settings.pause.descPaused":
    "Sync is paused. Local changes are not uploaded and other devices' changes are not downloaded.",
  "settings.pause.pause": "Pause sync",
  "settings.pause.resume": "Resume sync",
  "settings.device.name": "Device name",
  "settings.device.desc": "Only a label written into the current remote vault's sync history.",
  "settings.device.placeholder": "My device",
  "settings.history.name": "Sync history",
  "settings.history.desc":
    "This run's sync events: what was sent, what was applied, and what a setting kept out. Kept in memory; a reload starts empty.",
  "settings.history.view": "View",
  "settings.recycleBin.name": "Recycle bin",
  "settings.recycleBin.desc": "View and restore deleted files.",
  "settings.recycleBin.descLocked":
    "Resume sync and unlock the remote vault to view deleted files.",
  "settings.recycleBin.view": "View",
  "settings.vaultPassword.name": "Vault password",
  "settings.vaultPassword.notStoredPaused":
    "Not saved on this device. You will need to enter it when you resume sync.",
  "settings.vaultPassword.notStored":
    "Not saved on this device. You will need to enter it next time Obsidian opens.",
  "settings.vaultPassword.storedPaused":
    "Saved on this device. Resuming sync unlocks the vault automatically (this is not synced with the vault).",
  "settings.vaultPassword.stored":
    "Saved on this device. Obsidian unlocks the vault automatically on the next start (this is not synced with the vault).",
  "settings.vaultPassword.clear": "Clear",
  "settings.excludedFolders.list.name": "Excluded folders",
  "settings.excludedFolders.list.descNone": "Keep some folders out of sync.",
  "settings.excludedFolders.list.descCount.one": "{count} folder is currently excluded.",
  "settings.excludedFolders.list.descCount.other": "{count} folders are currently excluded.",
  "settings.excludedFolders.manage": "Manage",
  "settings.groupDescriptionWithReload": "{base} Requires reloading Obsidian to take effect.",

  // ── File type switches ──
  "settings.fileType.images.label": "Images",
  "settings.fileType.images.desc": "Image attachments such as screenshots and illustrations.",
  "settings.fileType.audio.label": "Audio",
  "settings.fileType.audio.desc": "Audio attachments such as recordings and music.",
  "settings.fileType.video.label": "Video",
  "settings.fileType.video.desc": "Video attachments.",
  "settings.fileType.pdf.label": "PDF",
  "settings.fileType.pdf.desc": "PDF documents.",
  "settings.fileType.otherTypes.label": "Other file types",
  "settings.fileType.otherTypes.desc": "Files outside the categories above.",

  // ── Obsidian settings groups ──
  "settings.group.app.label": "Main settings",
  "settings.group.app.desc": "app.json: editor, files & links and other core options.",
  "settings.group.appearance.label": "Appearance",
  "settings.group.appearance.desc": "appearance.json: theme, fonts and interface appearance.",
  "settings.group.themes.label": "Themes",
  "settings.group.themes.desc": "Theme CSS files under themes/.",
  "settings.group.snippets.label": "CSS snippets",
  "settings.group.snippets.desc": "CSS snippets under snippets/.",
  "settings.group.hotkeys.label": "Hotkeys",
  "settings.group.hotkeys.desc": "hotkeys.json: custom hotkeys.",
  "settings.group.corePlugins.label": "Core plugins enabled",
  "settings.group.corePlugins.desc": "core-plugins.json: which core plugins are enabled.",
  "settings.group.corePluginSettings.label": "Core plugin settings",
  "settings.group.corePluginSettings.desc": "Per-plugin settings for core plugins.",
  "settings.group.communityPluginList.label": "Community plugins enabled",
  "settings.group.communityPluginList.desc":
    "community-plugins.json: which community plugins are enabled.",
  "settings.group.communityPlugins.label": "Installed community plugins",
  "settings.group.communityPlugins.desc": "Plugin files under plugins/ (main.js, styles, assets).",
  "settings.group.otherFiles.label": "Other config files",
  "settings.group.otherFiles.desc": "Unclassified files in the config folder.",

  // ── Password dialog ──
  "dialog.password.title": "Vault password required",
  "dialog.password.intro": "Enter your vault password to enable encryption for file sync.",
  "dialog.password.label": "Vault password",
  "dialog.password.placeholder": "Enter vault password",
  "dialog.password.remember": "Remember password",
  "dialog.password.rememberDesc":
    "Save the key on this device so Obsidian unlocks automatically next time (this is not synced with the vault).",
  "dialog.password.unlock": "Unlock",
  "dialog.password.required": "A password is required.",

  // ── Create vault dialog ──
  "dialog.createVault.title": "Create remote vault",
  "dialog.createVault.name": "Vault name",
  "dialog.createVault.nameDesc": "A friendly name for this remote vault.",
  "dialog.createVault.namePlaceholder": "My remote vault",
  "dialog.createVault.password": "Vault password",
  "dialog.createVault.passwordDesc":
    "Encrypts and verifies the remote vault. The password is never sent to the server.",
  "dialog.createVault.passwordPlaceholder": "Enter a strong password",
  "dialog.createVault.create": "Create",
  "dialog.createVault.nameRequired": "A vault name is required.",
  "dialog.createVault.passwordRequired": "A vault password is required.",

  // ── Vault picker ──
  "dialog.vaultPicker.title": "Choose a remote vault",
  "dialog.vaultPicker.create": "Create remote vault",
  "dialog.vaultPicker.loading": "Loading remote vaults…",
  "dialog.vaultPicker.empty": "No remote vaults yet. Create one first.",
  "dialog.vaultPicker.deleteTooltip": "Delete remote vault",
  "dialog.vaultPicker.connect": "Connect",
  "dialog.vaultPicker.deleteTitle": 'Delete "{vault}"',
  "dialog.vaultPicker.deleteConfirm": 'Delete the remote vault "{vault}"? This cannot be undone.',
  "dialog.vaultPicker.wrongPassword": "The vault password is incorrect. Deletion cancelled.",
  "dialog.vaultPicker.confirmTitle": "Confirm",
  "dialog.vaultPicker.confirmCancel": "Cancel",
  "dialog.vaultPicker.confirmOk": "Confirm",

  // ── Connection setup dialog ──
  "dialog.setup.title": "Connection setup",
  "dialog.setup.leadTitle": "Connect to remote vault",
  "dialog.setup.subtitleConfigured": "Review and confirm the connection settings for this vault.",
  "dialog.setup.subtitleNew": "Choose how this device syncs this remote vault.",
  "dialog.setup.password": "Vault password",
  "dialog.setup.passwordDesc":
    "Used to verify this remote vault. The password is never sent to the server.",
  "dialog.setup.passwordPlaceholder": "Enter vault password",
  "dialog.setup.remember": "Remember password",
  "dialog.setup.rememberDesc":
    "Save the key on this device so Obsidian unlocks automatically next time (this is not synced with the vault).",
  "dialog.setup.device": "Device name",
  "dialog.setup.deviceDesc":
    "Only a label written into this remote vault's sync history; saved per remote vault.",
  "dialog.setup.devicePlaceholder": "My device",
  "dialog.setup.folders": "Excluded folders",
  "dialog.setup.foldersNone": "No folders excluded",
  "dialog.setup.foldersCount.one": "{count} folder excluded",
  "dialog.setup.foldersCount.other": "{count} folders excluded",
  "dialog.setup.manage": "Manage",
  "dialog.setup.footerHint": "These settings are saved on this device only.",
  "dialog.setup.cancel": "Cancel",
  "dialog.setup.start": "Start syncing",
  "dialog.setup.connecting": "Connecting…",
  "dialog.setup.passwordRequired": "Enter the vault password.",
  "dialog.setup.connectFailed": "Connection failed",

  // ── Excluded folders dialog ──
  "dialog.excludedFolders.title": "Manage excluded folders",
  "dialog.excludedFolders.empty": "This vault has no folders yet.",
  "dialog.excludedFolders.done": "Done",
  "dialog.excludedFolders.missingTitle": "Deleted folders (still excluded)",
  "dialog.excludedFolders.missingHint": "A folder recreated at the same path will stay excluded.",
  "dialog.excludedFolders.stopExcluding": "Stop excluding",
  "dialog.excludedFolders.none": "No folders are excluded right now.",
  "dialog.excludedFolders.summary.one": "{count} folder is excluded; its contents will not sync.",
  "dialog.excludedFolders.summary.other":
    "{count} folders are excluded; their contents will not sync.",
  "dialog.excludedFolders.summaryWithMissing":
    "Excluded folders: {count} ({missing} deleted); their contents will not sync.",
  "dialog.excludedFolders.saveFailed": "Could not save the excluded folders: {error}",

  // ── Sync history dialog ──
  // A log of **this run**: the engine's activity events, kept in memory. The header reads
  // as one stat ("128 sync events") plus a note that it is this run's; each row is the
  // direction arrow (no text), the path, and a muted line of time + device with the action
  // word on the right. A skipped row adds the switch that fired, as it was at the time.
  "dialog.syncHistory.title": "Sync history",
  "dialog.syncHistory.countLabel.one": "sync event",
  "dialog.syncHistory.countLabel.other": "sync events",
  "dialog.syncHistory.sessionNote": "This run",
  "dialog.syncHistory.truncated": "This run · showing the latest {shown}",
  "dialog.syncHistory.today": "Today",
  "dialog.syncHistory.yesterday": "Yesterday",
  "dialog.syncHistory.meta": "{time} · {device}",
  // The reasons a row can carry for a path this device left alone. Each names the setting
  // that owns the rule, because "excluded" alone does not say where to look.
  "dialog.syncHistory.skipReason.folder": "The folder is excluded",
  "dialog.syncHistory.skipReason.fileType": "This file type is off",
  "dialog.syncHistory.skipReason.settingsGroup": "This settings group was off",
  "dialog.syncHistory.skipReason.size": "larger than this account's size limit",
  "dialog.syncHistory.skipReason.pathTooLong": "Too long a path for the server",
  "dialog.syncHistory.notApplied": "Not applied here: {reason}",
  "dialog.syncHistory.notSent": "Not sent: {reason}",
  "dialog.syncHistory.directionOut": "From this device",
  "dialog.syncHistory.directionIn": "From another device",
  "dialog.syncHistory.peerUnknown": "Another device",
  "dialog.syncHistory.emptyTitle": "No sync events this run",
  "dialog.syncHistory.emptyDesc":
    "Sends, arrivals and the files a setting kept out show up here as they happen. The log lives in memory for this run and starts empty after a reload.",
  "dialog.syncHistory.disconnectedTitle": "No remote vault connected",
  "dialog.syncHistory.disconnectedDesc":
    "Connect a remote vault to see this run's sync events here.",

  // ── Version history ──
  "dialog.versionHistory.loadError": "Could not load the version history: {error}",
  "dialog.versionHistory.empty": "No versions yet.",
  "dialog.versionHistory.countLabel.one": "{count} version",
  "dialog.versionHistory.countLabel.other": "{count} versions",
  "dialog.versionHistory.current": "Current",
  "dialog.versionHistory.deleteWarning": "Delete record; cannot be restored",
  "dialog.versionHistory.restore": "Restore",
  "dialog.versionHistory.noKey": "Cannot decrypt: no remote vault key is bound.",
  "dialog.versionHistory.contentError": "Could not fetch or decrypt this version's content.",
  "dialog.versionHistory.restored": "Restored to version {id}…",
  "dialog.versionHistory.confirmTitle": "Restore version",
  "dialog.versionHistory.confirmText":
    'Replace the contents of "{path}" with this version ({time})?',
  "dialog.versionHistory.confirmBody":
    "The current content stays in the version history and can be restored again.",
  "dialog.versionHistory.sizeEmpty": "No content",

  // ── The version history view ──
  "versionHistory.viewTitle": "Version history",
  "versionHistory.noTarget": "This tab does not record which file's history to show.",
  "versionHistory.notConnected": "No remote vault is connected, so its history cannot be read.",
  "versionHistory.loading": "Reading versions…",
  "versionHistory.refresh": "Refresh",
  "versionHistory.restore": "Restore this version",
  "versionHistory.mode.content": "Content",
  "versionHistory.mode.diff": "Diff",
  "versionHistory.modeLabel": "Display mode",
  "versionHistory.diffCaption": "Compared with the previous version ({time})",
  "versionHistory.diffFirst": "The oldest version: every line below is new",
  "versionHistory.diffSame": "The content is the same as the previous version.",
  "versionHistory.diffTooLarge": "The content is too large to compare.",
  "explorer.versionHistory": "History",

  // ── File content preview ──
  "dialog.fileContent.kind.markdown": "Markdown",
  "dialog.fileContent.kind.text": "Text",
  "dialog.fileContent.kind.image": "Image",
  "dialog.fileContent.kind.video": "Video",
  "dialog.fileContent.kind.audio": "Audio",
  "dialog.fileContent.kind.binary": "Binary",
  "dialog.fileContent.emptyTitle": "Empty file",
  "dialog.fileContent.emptyDesc": "This version has no content.",
  "dialog.fileContent.binaryTitle": "Cannot preview this file",
  "dialog.fileContent.binaryDesc":
    "This is a binary file (PDF, archive, plugin bundle and so on) and cannot be previewed in a dialog.",
  "dialog.fileContent.mediaTitle": "Cannot play inline",
  "dialog.fileContent.mediaDesc":
    "This file cannot be previewed here: inline playback is not available in this environment.",

  // ── Recycle bin ──
  "dialog.recycleBin.title": "Recycle bin",
  "dialog.recycleBin.refresh": "Refresh recycle bin",
  "dialog.recycleBin.footerHint": "Clearing cannot be undone",
  "dialog.recycleBin.clear": "Clear recycle bin",
  "dialog.recycleBin.disconnected": "No remote vault is connected",
  "dialog.recycleBin.loading": "Loading recycle bin…",
  "dialog.recycleBin.loadFailed": "Could not load the recycle bin",
  "dialog.recycleBin.countLabel.one": "deleted file",
  "dialog.recycleBin.countLabel.other": "deleted files",
  "dialog.recycleBin.emptyTitle": "Recycle bin is empty",
  "dialog.recycleBin.emptyDesc": "Deleted files appear here.",
  "dialog.recycleBin.connectHint": "Connect a remote vault to see deleted files here.",
  "dialog.recycleBin.unknownPath": "[unknown path] {id}…",
  "dialog.recycleBin.meta": "Deleted {time} · by {device}",
  "dialog.recycleBin.viewContent": "View file content",
  "dialog.recycleBin.restore": "Restore",
  "dialog.recycleBin.contentTitle": "File content",
  "dialog.recycleBin.deletedAt": "Deleted {time}",
  "dialog.recycleBin.byDevice": "By {device}",
  "dialog.recycleBin.contentError": "Could not fetch or decrypt this file's content.",
  "dialog.recycleBin.clearFailed": "Could not clear the recycle bin: {error}",
  "dialog.recycleBin.clearConfirmTitle": "Clear recycle bin",
  "dialog.recycleBin.clearConfirmText.one":
    "This permanently deletes {count} file and its version history from the recycle bin.",
  "dialog.recycleBin.clearConfirmText.other":
    "This permanently deletes {count} files and their version history from the recycle bin.",
  "dialog.recycleBin.irreversible": "This cannot be undone.",
  "dialog.recycleBin.deletePermanently": "Delete permanently",
  "dialog.recycleBin.warning.pruned":
    "⚠ The restorable version was pruned; this file cannot be restored",
  "dialog.recycleBin.warning.pathUnknown":
    "⚠ The path recorded for this file cannot be decrypted; it cannot be restored",

  // ── Conflict comparison ──
  "dialog.conflictDiff.title": "Compare conflict copy",
  "dialog.conflictDiff.tooLarge": "The file is too large to compare.",
  "dialog.conflictDiff.unreadable": '"{name}" could not be read, so it cannot be compared.',
  "dialog.conflictDiff.missingCopy":
    'The conflict copy "{name}" was not found. It may have been deleted or renamed, so it cannot be compared.',
  "dialog.conflictDiff.missingOriginal":
    'The original file "{name}" was not found. It may have been renamed or deleted, so it cannot be compared.',
  "dialog.conflictDiff.layout": "Layout",
  "dialog.conflictDiff.split": "Split",
  "dialog.conflictDiff.unified": "Unified",
  "dialog.conflictDiff.replace": "Replace current file with conflict copy",
  "dialog.conflictDiff.restoreOriginal": "Restore as original",
  "dialog.conflictDiff.added": "+{count}",
  "dialog.conflictDiff.removed": "−{count}",
  "dialog.conflictDiff.copyLegend": "Conflict copy",
  "dialog.conflictDiff.currentLegend": "Current file",
  "dialog.conflictDiff.empty":
    "This comparison has no recorded files. Open it again from the conflict copy.",

  // ── Conflict replace ──
  "dialog.conflictReplace.titleReplace": "Replace current file with conflict copy",
  "dialog.conflictReplace.titleRecreate": "Restore as original",
  "dialog.conflictReplace.buttonReplace": "Replace",
  "dialog.conflictReplace.buttonRecreate": "Restore",
  "dialog.conflictReplace.textReplace": 'This replaces "{path}" with the conflict copy.',
  "dialog.conflictReplace.textRecreate":
    'The original file does not exist; it will be created from the conflict copy at "{path}".',
  "dialog.conflictReplace.deleteCopy": "Delete the conflict copy after replacing",
  "dialog.conflictReplace.folderOccupied": 'Cannot replace: "{path}" is occupied by a folder.',
  "dialog.conflictReplace.noticeFailed":
    'Replace failed: the conflict copy could not be read or "{path}" could not be written. No files were changed.',
  "dialog.conflictReplace.noticeReplaced": 'Replaced "{path}" with the conflict copy',
  "dialog.conflictReplace.noticeCreated": 'Created "{path}" from the conflict copy',
  "dialog.conflictReplace.noticeCopyKept": "{verb}. The conflict copy was kept.",

  // ── Conflict file actions ──
  "conflict.action.diff.title": "Compare conflict copy with original",
  "conflict.action.replace.title": "Replace current file with conflict copy",
  "conflict.action.diff.label": "diff",
  "conflict.action.replace.label": "replace",

  // ── Conflict notices ──
  "conflict.notice.one": "Detected a conflict",
  "conflict.notice.many": "Detected {count} conflicts",
  "conflict.notice.noLocal":
    "{head}: the remote version was kept, and there was no local content to keep.",
  "conflict.notice.parkedOne":
    '{head}: the remote version was kept, and your local change was saved as "{path}".',
  "conflict.notice.parkedMany":
    '{head}: the remote version was kept, and your local changes were saved as {count} conflict copies (for example "{path}").',
  "conflict.notice.tooLargeOne": "A file exceeds the sync size limit",
  "conflict.notice.tooLargeMany": "{count} files exceed the sync size limit",
  "conflict.notice.tooLargeNames":
    "{head}; skipped: {names}{more}. The limit is set per key by your administrator — ask them to raise it.",
  "conflict.notice.tooLargeMore": ", …",
  "conflict.notice.fileName": '"{path}" ({size})',

  // ── Sync history / time ──
  "history.action.create": "Created",
  "history.action.modify": "Modified",
  "history.action.rename": "Renamed",
  "history.action.delete": "Deleted",
  "history.action.restore": "Restored",
  "history.relative.justNow": "just now",
  "history.relative.minutes.one": "{count} minute ago",
  "history.relative.minutes.other": "{count} minutes ago",
  "history.relative.hours.one": "{count} hour ago",
  "history.relative.hours.other": "{count} hours ago",
  "history.relative.days.one": "{count} day ago",
  "history.relative.days.other": "{count} days ago",
  "history.relative.months.one": "{count} month ago",
  "history.relative.months.other": "{count} months ago",
  "history.relative.years.one": "{count} year ago",
  "history.relative.years.other": "{count} years ago",
  "history.createdAgo": "Created {relative}",
  "history.deviceUnknown": "Unknown device",

  // ── Settings reload ──
  "reload.title": "Settings synced",
  "reload.message":
    "Obsidian settings changed on another device have synced here. Reload Obsidian to apply them.",
  "reload.reload": "Reload",
  "reload.dismiss": "Later",

  // ── Restore flow ──
  "restore.title": "Restore file",
  "restore.occupied": '"{path}" is already occupied by another file.',
  "restore.hint": "Choose another file name for the restored file.",
  "restore.folder": 'The restored file will be placed under "{dir}/".',
  "restore.root": "The restored file will be placed at the vault root.",
  "restore.nameLabel": "New file name",
  "restore.nameRequired": "Enter a file name.",
  "restore.nameSlash":
    'A file name cannot contain "/". Move the file after restoring if it needs another folder.',
  "restore.nameOutOfScope":
    "This file name is outside this device's sync scope, so other devices will not receive it. Choose another name.",
  "restore.nameTaken": "That file name is taken too. Choose another one.",
  "restore.failedOccupied": "Cannot restore: {path} is occupied by another file.",
  "restore.failedUnsynced": "Cannot restore: {path} already has an unsynced local file.",
  "restore.failed": "Restore failed: {error}",

  // ── Status bar and its menu ──
  "status.state.notConnected": "Not connected",
  "status.state.notSynced": "Not syncing",
  "status.state.syncing": "Syncing",
  "status.state.waiting": "External sync service is syncing",
  "status.state.paused": "Sync paused",
  "status.tooltip": "Courier: {state}",
  "status.tooltipVault": 'Courier: {state} in "{vault}"',
  "status.tooltipFirstSync": "Courier: first sync — {done} of {total} files",
  "status.tooltipFirstSyncVault": 'Courier: first sync — {done} of {total} files in "{vault}"',
  "status.menu.accountUnavailable": "Could not read account information",
  "status.menu.settings": "Settings",
  "status.value.expiry.never": "Never expires",
  "status.value.expiry.expired": "Expired",
  "status.value.expiry.unknown": "Unknown",
  "status.value.expiry.days.one": "{count} day left",
  "status.value.expiry.days.other": "{count} days left",
  "status.value.storage.ratio": "{used}/{limit}",
  "status.value.storage.unlimited": "{used} / unlimited",
  "status.value.storage.unknown": "Unavailable",

  // ── File menu ──
  "menu.versionHistory": "Courier version history",
};
