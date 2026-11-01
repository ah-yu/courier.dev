import {
  Platform,
  Plugin,
  requestUrl,
  setIcon,
  TFile,
  getLanguage,
  type WorkspaceLeaf,
} from "obsidian";
import {
  normalizeDeviceName,
  sortedCopy,
  type CreateVaultResponse,
  type HttpTransport,
  type UserSummary,
} from "@courier/shared";
import { resolveObsidianLocale, setLocale, t } from "./i18n";
import { pluginPlatform } from "./platform";
import { getServerUrl, getWsUrl, type PluginActions } from "./shared/api";
import { createPluginActions } from "./shared/actions";
import { exactBuffer } from "./shared/bytes";
import {
  DEFAULT_SETTINGS,
  connectionSettingsForVault,
  forgetVaultConnection,
  normalizeVaultConnections,
  setVaultConnection,
  syncScopeOf,
  updateVaultConnection,
  vaultHasSetup,
  type CourierSettings,
  type VaultConnectionSetup,
} from "./shared/settings";
import {
  describeActionError,
  looksLikeUserKey,
  normalizeServerUrl,
  type ActionOutcome,
} from "./shared/action-error";
import {
  clearVaultCredential,
  loadVaultCredential,
  saveVaultCredential,
} from "./shared/credential-store";
import {
  generateSalt,
  deriveEncryptionKey,
  makeKeyCheck,
  importRawKey,
  exportRawKey,
  normalizeExcludedFolders,
  normalizeScope,
  SyncLease,
  type AuthFailureReason,
  type ConflictResolvedEvent,
  type FileTooLargeEvent,
  type FileTypeGroup,
  type SettingsGroup,
} from "@courier/engine";
import {
  CONFLICT_NOTICE_WINDOW_MS,
  conflictNoticeText,
  tooLargeNoticeText,
} from "./shared/conflict-notice";
import { settingsGroupNeedsReload } from "./shared/settings-reload";
import { createReloadPopup, type ReloadPopup } from "./shared/settings-reload-popup";
import { priorityPathsFrom } from "./shared/priority-paths";
import { createBurstNotifier } from "./shared/notices";
import { showNotice } from "./shared/show-notice";
import { unbindVault } from "./shared/session";
import { clearSyncLog, recordSyncActivity } from "./shared/sync-log";
import {
  checkVaultPassword,
  verifyKeyAgainstServer,
  type StoredKeyCheck,
  type VaultCredentialCheck,
} from "./shared/vault-credentials";

export type { VaultCredentialCheck };
import { EngineHost } from "./unified/host";
import { AdapterLeaseStore } from "./unified/lease";
import { PasswordPromptModal } from "./ui/dialogs/password-prompt-modal";
import type {
  PasswordPromptOptions,
  PasswordPromptResult,
} from "./ui/dialogs/password-prompt-modal";
import { CourierSettingTab } from "./ui/settings";
import { createStatusBar, type StatusBarHandle } from "./ui/status-bar";
import { syncStatusOf, type SyncStatus } from "./shared/sync-status";
import { ACCOUNT_READ_TIMEOUT_MS } from "./shared/account-status";
import { withTimeout } from "./shared/with-timeout";
import {
  VersionHistoryView,
  VERSION_HISTORY_VIEW_TYPE,
  parseVersionHistoryState,
  type VersionHistoryViewState,
} from "./ui/version-history-view";
import {
  ConflictDiffView,
  CONFLICT_DIFF_VIEW_TYPE,
  defaultConflictDiffMode,
  parseConflictDiffState,
  type ConflictDiffState,
} from "./ui/conflict-diff-view";
import { runConflictReplace } from "./ui/dialogs/conflict-replace-modal";
import { installFileExplorerActions, type FileExplorerActions } from "./ui/file-explorer-actions";
import {
  installExcludedFolderDimming,
  type ExcludedFolderDimming,
} from "./ui/file-explorer-excluded-folders";
import {
  CONFLICT_ACTION_ICONS,
  conflictActionFor,
  conflictActionTitle,
  resolveConflictOriginal,
} from "./shared/conflict-actions";
import { fileActionFor } from "./shared/file-actions";
import type { ReplaceTarget } from "./shared/conflict-replace";

// ══════════════════════════════════
// Transport (Obsidian `requestUrl` → the shared HTTP client) and the action
// wiring built on it. The endpoint implementations live in `shared/actions.ts`,
// which imports nothing from Obsidian and is therefore unit-tested directly.
// ══════════════════════════════════

/**
 * The transport every plugin request goes through.
 *
 * `requestUrl` is Obsidian's own HTTP stack (Electron's `net`), so this is the
 * only host-specific part of the plugin's networking: URLs, auth headers, the
 * session-id header and error mapping all belong to the shared client.
 *
 * Its response is handed on **lazily**, because Obsidian's `RequestUrlResponse` reads
 * its body on demand and `json` is a getter that throws when the body is not JSON. The
 * version-content route answers raw ciphertext, so reading `.json` eagerly here made
 * every download fail — as a `SyntaxError` the shared client could only report as
 * "cannot reach the server" — while pushes (JSON responses) kept working. Nothing
 * surfaced it either: a pass tolerates a pull that could not be carried out, and the
 * next one retries into the same failure. `json` therefore answers `null` for a body
 * that is not JSON, which is what `TransportResponse` documents.
 */
const obsidianTransport: HttpTransport = async (request) => {
  const { "Content-Type": contentType, ...headers } = request.headers;
  const body = request.body;
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers,
    ...(contentType === undefined ? {} : { contentType }),
    ...(body === undefined
      ? {}
      : {
          body:
            typeof body === "string" ? body : body instanceof Uint8Array ? exactBuffer(body) : body,
        }),
    // The shared client reads the status and maps the error body itself.
    // Obsidian's `requestUrl` rejects on 4xx/5xx by default (`throw: true`),
    // which hid every structured error from the settings page: an expired key
    // and a stopped server both surfaced as "cannot reach the server".
    throw: false,
  });
  return {
    status: response.status,
    // `requestUrl` already lower-cases its header names; the shared client reads
    // `retry-after` to know how long a 429 asked it to wait.
    headers: response.headers,
    get text() {
      return response.text;
    },
    get json(): unknown {
      try {
        // `RequestUrlResponse.json` is `any`; the shared client narrows what it needs, and
        // answering `unknown` is what keeps the unsafe value from travelling further.
        return response.json as unknown;
      } catch {
        // Not JSON: binary content, an empty body, a proxy's HTML error page.
        return null;
      }
    },
    get arrayBuffer() {
      return response.arrayBuffer;
    },
  };
};

/**
 * Wire the plugin's network actions.
 *
 * Exported for the e2e suite, which drives the real action surface through the
 * real `requestUrl` transport.
 */
export function buildActions(ctx: {
  getSettings: () => CourierSettings;
  getUserKey: () => string | null;
}): PluginActions {
  return createPluginActions({ transport: obsidianTransport, ...ctx });
}

// ══════════════════════════════════
// Plugin
// ══════════════════════════════════

export default class CourierPlugin extends Plugin {
  settings: CourierSettings = DEFAULT_SETTINGS;
  actions: PluginActions = buildActions({
    getSettings: () => this.settings,
    getUserKey: () => this.getUserKey(),
  });
  host: EngineHost | null = null;
  encryptionKey: CryptoKey | null = null;
  private settingTab: CourierSettingTab | null = null;
  /**
   * Conflicts the engine resolved since the last notice, collected for
   * {@link CONFLICT_NOTICE_WINDOW_MS} so a rebind that meets several divergent notes
   * reports one line instead of a wall of them.
   */
  private readonly conflictNotices = createBurstNotifier<ConflictResolvedEvent>({
    windowMs: CONFLICT_NOTICE_WINDOW_MS,
    render: conflictNoticeText,
    emit: (text) => showNotice(text),
  });
  /**
   * Files the size cap skipped, collected for the same one-notice-per-burst treatment.
   *
   * A file over the cap is reported again by **every** pass (the engine resets its
   * per-pass set), so without the identity the notice became an unrequested reminder
   * four times an hour. One line per path per session is the whole point: the fact — and
   * the setting that fixes it — has already been said.
   */
  private readonly tooLargeNotices = createBurstNotifier<FileTooLargeEvent>({
    windowMs: CONFLICT_NOTICE_WINDOW_MS,
    render: tooLargeNoticeText,
    emit: (text) => showNotice(text),
    keyOf: (event) => event.plainPath,
  });
  /**
   * The reload card, built on first use (it needs a parent element to attach to).
   *
   * One object for the whole plugin session: {@link showReloadNotice} decides whether there
   * is anything left to say, and the card itself decides whether it is already saying it.
   */
  private reloadPopup: ReloadPopup | null = null;
  /**
   * What the file explorer's action chips are attached through.
   *
   * Kept as a field rather than registered on the plugin because it disposes more than an
   * event ref: the DOM observers, the chips it injected and its own workspace events (see
   * `ui/file-explorer-actions.ts`).
   */
  private explorerActions: FileExplorerActions | null = null;
  /**
   * The file explorer's greyed-out excluded folders.
   *
   * Display-only, and independent of the conflict buttons: it is installed on every
   * platform because the file explorer exists on mobile too. Kept as a field for the same
   * reason the conflict action is — it owns DOM observers and workspace events.
   */
  private excludedFolderDimming: ExcludedFolderDimming | null = null;
  /** The bottom-right sync state, and the native menu its click opens. */
  private statusBar: StatusBarHandle | null = null;
  /**
   * How far the current pass has got, as the status bar tooltip shows it.
   *
   * Written by the running host's `onProgress` and read only while that host is still
   * binding (see `currentBindProgress`); a later pass reports progress too, but that is not
   * a first sync and must not be labelled one.
   */
  private bindProgress: { done: number; total: number } | null = null;
  /**
   * The last `GET /api/me` answer, kept in memory only.
   *
   * It exists for the status menu's account rows: the call is cheap but not instant, and
   * an unreachable server must still leave the menu able to say what it last knew. It is
   * never written to `data.json`.
   */
  private account: UserSummary | null = null;
  /** The key the cached account was read for, so a new sign-in cannot reuse it. */
  private accountKey: string | null = null;
  /**
   * The password dialog this plugin has open, if any.
   *
   * Two flows can ask for the vault password — the load-time unlock and the settings
   * page's locked step — and the load path is deliberately not awaited by `onload`, so
   * they can meet. Two dialogs would be one question asked twice (and two answers racing
   * for one key), so the second caller joins the first dialog's answer instead.
   */
  private pendingPasswordPrompt: Promise<PasswordPromptResult | null> | null = null;
  /** The modal behind `pendingPasswordPrompt`, so `onunload` can actually dismiss it. */
  private pendingPasswordModal: PasswordPromptModal | null = null;
  /**
   * Whether this instance has been unloaded.
   *
   * A canary check or a host start can finish after `onunload`; without this, a dead
   * instance would keep writing settings and leave a host running that nothing owns.
   */
  private unloaded = false;
  /**
   * The stored-key unlock in flight, if any.
   *
   * Sharing the dialog means two callers can continue past one answer. The settings page
   * must join the running unlock instead of starting a second one: `startHost()` is not
   * serialised, and two runs interleaved can leave one `EngineHost` without a reference.
   */
  private pendingAutoUnlock: Promise<boolean> | null = null;
  /** The typed-password unlock in flight; a double click must not start two hosts. */
  private pendingPasswordUnlock: Promise<ActionOutcome> | null = null;

  get engine() {
    return this.host?.engine ?? null;
  }

  get wsState(): string {
    return this.host?.wsState ?? "disconnected";
  }

  /** Stop the engine host, if one is running (the `SessionHost` seam). */
  stopHost(): void {
    this.host?.stop();
    this.host = null;
    // The state changed without a settings-page render: the icon and the state line follow.
    this.refreshLiveState();
  }

  /** Forget the in-memory vault key (the `SessionHost` seam). */
  forgetKey(): void {
    this.encryptionKey = null;
  }

  private getUserKey(): string | null {
    return this.settings.userKey;
  }

  override async onload(): Promise<void> {
    this.unloaded = false;
    // Obsidian's UI language follows the OS unless the user chose one. Pick the
    // catalog before any setting row, Notice or menu item can be built.
    const language =
      (typeof getLanguage === "function" ? getLanguage() : "") ||
      (typeof navigator !== "undefined" ? navigator.language : "");
    setLocale(resolveObsidianLocale(language));

    // A new plugin run starts with an empty session log. `onunload` already clears it;
    // this is the defensive half for a reload that reuses the module instance.
    clearSyncLog();

    await this.loadSettings();

    this.settingTab = new CourierSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);

    // The always-visible state, bottom-right. Created before the auto-unlock below so the
    // first state a user sees is already the real one (bound but not yet syncing).
    this.statusBar = createStatusBar({
      addStatusBarItem: () => this.addStatusBarItem(),
      getStatus: () => this.currentSyncStatus(),
      getVaultName: () => this.settings.connectedVaultName,
      hasUserKey: () => Boolean(this.settings.userKey),
      getProgress: () => this.currentBindProgress(),
      readAccount: () => this.readAccountForStatusMenu(),
      pauseSync: () => this.pauseSync(),
      resumeSync: () => this.resumeSync(),
      openSettings: () => this.openSettingsTab(),
    });

    // The conflict comparison and the version history, as main-area tabs rather than
    // dialogs (see `ui/conflict-diff-view.ts` and `ui/version-history-view.ts`). Registered
    // unconditionally — an Obsidian layout saved on a desktop can be opened on a phone, and
    // an unregistered type is a tab the app cannot restore.
    this.registerView(CONFLICT_DIFF_VIEW_TYPE, (leaf) => new ConflictDiffView(leaf));
    this.registerView(VERSION_HISTORY_VIEW_TYPE, (leaf) => new VersionHistoryView(leaf, this));

    // One context-menu entry per file: a parked conflict copy offers the action its kind
    // gets (compare or replace), everything else the version history — a conflict copy has
    // no chain at all, so offering history for it would only fail. `fileActionFor` is the
    // same rule the explorer's chips follow, so both surfaces agree on which files this
    // device can act on at all (a file under an excluded folder offers neither).
    //
    // The conflict actions are offered on **every** platform. On a phone the menu is the only
    // entry point (there is no hover, and `installFileExplorerActions` below is desktop-only),
    // so gating it there would leave a parked copy with no action at all. The comparison and
    // the confirmation both adapt to the narrow page (`ui/conflict-diff-view.ts`,
    // `ui/dialogs/conflict-replace-modal.ts`), so the same menu item opens them unchanged.
    //
    // The version-history entry names **Courier** on purpose: Obsidian ships its own "Version
    // history" item on the same file, and two identically named items in one menu is a coin
    // toss. On the desktop the file explorer's chip is the primary one and this stays as the
    // fallback that needs no DOM decoration.
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) return;
        const kind = fileActionFor(file.path, this.settings.excludedFolders);
        if (kind === "conflict") {
          const action = conflictActionFor(file.path);
          menu.addItem((item) => {
            item
              .setTitle(conflictActionTitle(action))
              .setIcon(CONFLICT_ACTION_ICONS[action])
              .onClick(() => {
                if (action === "diff") void this.openConflictDiff(file.path);
                else void this.openConflictReplace(file.path);
              });
          });
          return;
        }
        if (kind === "history" && this.settings.connectedVaultId) {
          menu.addItem((item) => {
            item
              .setTitle(t("menu.versionHistory"))
              .setIcon("history")
              .onClick(() => {
                void this.openVersionHistory(file);
              });
          });
        }
      }),
    );

    // The same actions, next to the file's name in the file explorer (the plugin has no
    // public per-file hook there, so this watches the explorer's DOM). Desktop only, unlike
    // the surfaces they open: a chip is revealed by hover, which a phone does not have — the
    // file menu is that platform's entry point.
    if (Platform.isDesktop) {
      this.explorerActions = installFileExplorerActions(this.app, {
        openDiff: (path) => void this.openConflictDiff(path),
        openReplace: (path) => void this.openConflictReplace(path),
        openVersionHistory: (path) => void this.openVersionHistoryPath(path),
        excludedFolders: () => this.settings.excludedFolders,
      });
    }

    // The excluded folders' visual half: grey their rows (and the files inside them) in
    // the file explorer. Display-only, so it runs on mobile as well.
    this.excludedFolderDimming = installExcludedFolderDimming(this.app, {
      excludedFolders: () => this.settings.excludedFolders,
    });

    // If a vault is bound, unlock it and start the host: silently when this
    // device has a stored credential, otherwise by asking for the password.
    if (this.settings.connectedVaultId) {
      if (this.settings.syncPaused) {
        // Paused is not locked: a paused load neither unlocks nor asks for a password,
        // because pausing exists to stop syncing without the credentials coming out. The
        // settings page offers 继续同步, which takes the normal unlock path.
        this.refreshSettings();
      } else {
        void this.autoUnlockOrPrompt();
      }
    } else {
      this.settingTab?.refresh();
    }
  }

  override onunload(): void {
    // Before the host is stopped: its `state_change` callback repaints the status bar, and
    // there is no element to paint once this plugin is unloading.
    this.statusBar?.destroy();
    this.statusBar = null;
    this.host?.stop();
    this.host = null;
    // A comparison tab is a view this plugin registered: leaving it behind would hand the
    // next plugin version a leaf whose class is gone from the runtime.
    for (const leaf of this.app.workspace.getLeavesOfType(CONFLICT_DIFF_VIEW_TYPE)) leaf.detach();
    for (const leaf of this.app.workspace.getLeavesOfType(VERSION_HISTORY_VIEW_TYPE)) leaf.detach();
    this.explorerActions?.dispose();
    this.explorerActions = null;
    this.excludedFolderDimming?.dispose();
    this.excludedFolderDimming = null;
    // A pending burst message belongs to the session that produced it, and a card whose
    // buttons outlive this instance of the plugin must not stay behind.
    this.conflictNotices.reset();
    this.tooLargeNotices.reset();
    // A dialog raised by this instance belongs to the session that asked for it. Closing it
    // settles every waiter (`PromiseModal.onClose` resolves null), so nothing awaits a
    // dialog that belongs to an unloaded plugin.
    this.unloaded = true;
    this.pendingPasswordModal?.close();
    this.pendingPasswordModal = null;
    this.pendingPasswordPrompt = null;
    this.pendingAutoUnlock = null;
    this.pendingPasswordUnlock = null;
    // The run is over; a re-enabled plugin starts a new log.
    clearSyncLog();
    this.reloadPopup?.destroy();
    this.reloadPopup = null;
  }

  /**
   * Ask the user to reload, once per dismissal.
   *
   * Obsidian reads its config at start-up and works from memory afterwards, so a peer's
   * settings file landing on disk is not something the running app shows — and which files
   * that holds for is a platform fact (`SETTINGS_GROUPS_NEEDING_RELOAD`, measured). The card
   * therefore says only what the user has to do, never which file changed or what it now
   * contains: that is the sync history's job, and naming a file invites the reading that the
   * rest of the change did not arrive.
   *
   * The card does not expire and is shown once however many settings arrive while it is
   * up — closing it without reloading is what arms the next one. It sits in the bottom-right
   * corner on desktop (Obsidian's own `Notice` container is anchored top-right in 1.14.4,
   * which is the wrong corner for this) and becomes a bottom sheet above the mobile nav on
   * a phone; `styles.css` owns both layouts and the breakpoints.
   */
  private showReloadNotice(): void {
    this.reloadPopup ??= createReloadPopup({
      parent: this.app.workspace.containerEl,
      onReload: () => this.reloadApp(),
      onReloadUnavailable: () => showNotice(t("notice.manualReload")),
      renderIcon: (host) => setIcon(host, "refresh-cw"),
    });
    this.reloadPopup.show();
  }

  /**
   * Run Obsidian's own "Reload app without saving" command, and answer whether it exists.
   *
   * It is the only way a third-party plugin can make a *core* plugin's state take effect,
   * and it is outside the public API — so the call is guarded and its absence is reported
   * rather than swallowed.
   */
  private reloadApp(): boolean {
    const commands = (
      this.app as unknown as {
        commands?: { executeCommandById?: (id: string) => boolean };
      }
    ).commands;
    return commands?.executeCommandById?.("app:reload") === true;
  }

  // ── Settings persistence ──

  async loadSettings(): Promise<void> {
    // `loadData()` is Obsidian's `Promise<any>`: `data.json` is a file the user can edit,
    // so the shape is asserted here once and every field is normalised below.
    const data = (await this.loadData()) as Partial<CourierSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // The active label and the per-vault records are rebuilt through the shared
    // normalizers for the same reason as the nested scope below: a hand-edited or older
    // `data.json` must not put an over-long name or a traversal path into a sync scope.
    this.settings.deviceName = normalizeDeviceName(this.settings.deviceName);
    this.settings.vaultConnections = normalizeVaultConnections(this.settings.vaultConnections);
    // `settingsGroups` is a nested record, so the shallow merge above would share
    // (and later mutate) the module-level default. Normalize it into a fresh one:
    // unknown or missing groups read as off.
    this.settings.settingsGroups = normalizeScope({
      settingsGroups: this.settings.settingsGroups,
    }).settingsGroups;
    // Same for the file types — but a missing one keeps its *default* (images and
    // friends stay on), and the account cap falls back to the engine's default.
    const normalized = normalizeScope({
      fileTypes: this.settings.fileTypes,
      excludedFolders: this.settings.excludedFolders,
      maxFileBytes: this.settings.accountMaxFileBytes,
    });
    this.settings.fileTypes = normalized.fileTypes;
    this.settings.excludedFolders = normalized.excludedFolders;
    this.settings.accountMaxFileBytes = normalized.maxFileBytes;
    // A persisted flag is only ever the boolean true; anything else (a hand-edited
    // `data.json`, a value from before the feature existed) reads as "not paused".
    this.settings.syncPaused = this.settings.syncPaused === true;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ── Sign in / bind / unbind ──

  /**
   * Log in: keep the server URL and user key, then prove the key works and learn
   * which account it belongs to.
   *
   * The proof is `GET /api/me` — the account read the page's account row needs
   * anyway, and the cheapest authenticated call the server has. Nothing is
   * persisted as a session flag: the settings page derives its stage from the state
   * this call leaves behind, and a key that stops working is reported again the next
   * time the page is opened.
   */
  async signIn(): Promise<ActionOutcome<void>> {
    const url = normalizeServerUrl(this.settings.serverUrl ?? "");
    if (!url.ok) return { ok: false, error: url.message };

    const key = (this.settings.userKey ?? "").trim();
    if (!key) return { ok: false, error: t("error.keyRequired") };
    if (!looksLikeUserKey(key)) return { ok: false, error: t("error.keyPrefix") };

    this.settings.serverUrl = url.url;
    this.settings.userKey = key;
    await this.saveSettings();

    try {
      const me = await this.actions.getMe();
      // The login fields stay editable while the request is in flight (`onChange` writes
      // the settings on every keystroke). If the key changed, this answer belongs to a key
      // the form no longer holds: committing its name and quota would stamp account A onto
      // key B, and the status menu would then show A's expiry under B on the next failure.
      if (this.settings.userKey !== key) return { ok: false, error: t("error.signInKeyChanged") };
      this.settings.userName = me.name;
      this.settings.accountMaxFileBytes = normalizeScope({
        maxFileBytes: me.maxFileBytes,
      }).maxFileBytes;
      this.account = me;
      this.accountKey = key;
      await this.saveSettings();
      return { ok: true, value: undefined };
    } catch (err) {
      console.error("Sign in failed:", err);
      return { ok: false, error: describeActionError(err, t("action.signIn")) };
    }
  }

  /**
   * What the connection dialog should start from for one remote vault.
   *
   * `configured` says this device already has a record for the vault — the dialog uses it
   * only to choose its lead line (first-time setup vs. confirmation). It is the record's
   * presence, not whether its exclusion list is non-empty: excluding nothing is still a
   * completed configuration.
   */
  getConnectionSetup(vaultId: string): {
    configured: boolean;
    deviceName: string;
    excludedFolders: string[];
  } {
    const connection = connectionSettingsForVault(this.settings, vaultId);
    return {
      configured: vaultHasSetup(this.settings, vaultId),
      deviceName: connection.deviceName,
      excludedFolders: connection.excludedFolders,
    };
  }

  /**
   * Bind this vault: check the password against the server's canary, derive the
   * key, keep it on this device when asked, and start syncing.
   *
   * The password is verified **before** anything is persisted or started — a
   * mistyped password must never derive a key and push content under it, which
   * would leave versions on the server that the real password cannot decrypt.
   *
   * `setup` carries the device label and folder exclusions the setup dialog collected. The
   * picker sends it for **every** connect, including a returning vault, so the values the
   * dialog starts from are simply re-saved; both are written under the vault's own record
   * (even when the folder list is empty). Without `setup` — a direct caller such as the
   * e2e harness — a returning vault restores its record into the active fields before the
   * host starts.
   */
  async connectToVault(
    vaultId: string,
    vaultName: string,
    password: string,
    remember = true,
    setup?: VaultConnectionSetup,
  ): Promise<ActionOutcome> {
    const verification = await this.fetchVaultCredentials(vaultId, password);
    if (verification.kind === "invalid-password") {
      return { ok: false, error: t("error.passwordIncorrect") };
    }
    if (verification.kind === "error") {
      return {
        ok: false,
        error: describeActionError(verification.error, t("action.fetchVaultInfo")),
      };
    }

    if (setup) {
      this.settings.deviceName = normalizeDeviceName(setup.deviceName);
      this.settings.excludedFolders = normalizeExcludedFolders(setup.excludedFolders);
      setVaultConnection(this.settings, vaultId, {
        deviceName: this.settings.deviceName,
        excludedFolders: this.settings.excludedFolders,
      });
    } else if (vaultHasSetup(this.settings, vaultId)) {
      const stored = connectionSettingsForVault(this.settings, vaultId);
      this.settings.deviceName = stored.deviceName;
      this.settings.excludedFolders = stored.excludedFolders;
    }

    // The setup dialog (or a returning vault's record) can change the excluded list, and the
    // explorer's chips were decorated under the previous one. Without this, a file the vault
    // now excludes would keep its `版本历史` chip until the row happened to rebuild — the
    // dead end this scope rule exists to remove. Binds on both success and failure: the
    // settings are already written either way.
    this.refreshExcludedFolderRows();

    return this.bindVault({
      vaultId,
      vaultName,
      encryptionSalt: verification.encryptionSalt,
      password,
      remember,
    });
  }

  /**
   * Create a remote vault on the server. Deliberately does **not** bind it: creating
   * and connecting are two decisions, and the picker lists the new vault so the user
   * can connect to it (or to another one) when they are ready.
   *
   * The dialog collects a password because the vault is created *with* one — its
   * keyCheck canary is derived from it — not because this call needs the key.
   */
  async createVault(
    name: string,
    password: string,
  ): Promise<ActionOutcome<{ id: string; name: string }>> {
    if (!this.getUserKey()) {
      return { ok: false, error: t("error.keyRequired") };
    }

    const encryptionSalt = generateSalt();
    let keyCheck: string;
    try {
      const key = await deriveEncryptionKey(password, encryptionSalt, true);
      keyCheck = await makeKeyCheck(key);
    } catch (err) {
      console.error("Key derivation failed:", err);
      return { ok: false, error: t("error.keyDerivation") };
    }

    let created: CreateVaultResponse;
    try {
      created = await this.actions.createVault(name, encryptionSalt, keyCheck);
    } catch (err) {
      console.error("Creating the remote vault failed:", err);
      return { ok: false, error: describeActionError(err, t("action.createVault")) };
    }

    // No confirmation notice: the picker reloads and lists what was just created, which
    // is the same fact the settings page would have repeated as a toast.
    return { ok: true, value: { id: created.id, name: created.name } };
  }

  /**
   * Delete a remote vault the account owns. Irreversible, so the caller verifies the
   * vault password and confirms first; this only performs the deletion.
   *
   * The vault's connection record goes with it: the record exists only to describe a
   * remote vault this device has configured, so keeping it would make a later vault that
   * happened to reuse the id inherit another vault's label and folder scope. The
   * connected-vault case is also cleaned up by {@link handleRemoteVaultDeleted} when the
   * deletion arrives as a websocket event.
   */
  async deleteVault(vaultId: string): Promise<ActionOutcome> {
    try {
      await this.actions.deleteVault(vaultId);
      forgetVaultConnection(this.settings, vaultId);
      await this.saveSettings();
      return { ok: true, value: undefined };
    } catch (err) {
      console.error("Deleting the remote vault failed:", err);
      return { ok: false, error: describeActionError(err, t("action.deleteVault")) };
    }
  }

  /**
   * Unlock the bound vault with a typed password.
   *
   * Used by the settings page's locked stage. The password is verified against the
   * server's canary first: a wrong one must not start a host that would encrypt with
   * a key the vault was never created with.
   *
   * The key comes from {@link deriveVaultKey}, which stops before starting a host —
   * `resumeSync()` needs exactly that half, because it clears the pause flag after the
   * key is in hand and then starts the host itself.
   *
   * Single-flight: two clicks that join one dialog must unlock once, not start two hosts.
   */
  unlockWithPassword(password: string, remember = true): Promise<ActionOutcome> {
    const running = this.pendingPasswordUnlock;
    if (running) return running;
    const promise = this.runPasswordUnlock(password, remember).finally(() => {
      if (this.pendingPasswordUnlock === promise) this.pendingPasswordUnlock = null;
    });
    this.pendingPasswordUnlock = promise;
    return promise;
  }

  private async runPasswordUnlock(password: string, remember: boolean): Promise<ActionOutcome> {
    const derived = await this.deriveVaultKey(password, remember);
    if (!derived.ok) return derived;
    await this.startHost();
    this.refreshSettings();
    return { ok: true, value: undefined };
  }

  /**
   * Derive a key from a typed password, prove it against the server's canary, and keep
   * it (plus the device-local credential) **without starting the host**.
   *
   * The split exists for the paused vault: `startHost()` refuses to run while the pause
   * flag is set, so a resume that unlocked through `unlockWithPassword()` would derive
   * everything and silently start nothing. The caller decides when sync begins.
   */
  private async deriveVaultKey(
    password: string,
    remember: boolean,
  ): Promise<{ ok: true; key: CryptoKey } | { ok: false; error: string }> {
    const vaultId = this.settings.connectedVaultId;
    const encryptionSalt = this.settings.encryptionSalt;
    if (!vaultId || !encryptionSalt) {
      return { ok: false, error: t("error.vaultInfoMissing") };
    }

    let key: CryptoKey;
    try {
      key = await deriveEncryptionKey(password, encryptionSalt, true);
    } catch (err) {
      console.error("Key derivation failed:", err);
      return { ok: false, error: t("error.keyDerivation") };
    }

    const check = await this.verifyKeyAgainstServer(vaultId, key);
    if (check.kind === "unreachable") {
      // The typed password cannot be proved while the server is down, and starting a host
      // on an unproved key is exactly what pushes content the real password could never
      // decrypt — so nothing starts, and nothing the user typed is thrown away.
      return {
        ok: false,
        error: describeActionError(check.error, t("action.verifyVaultPassword")),
      };
    }
    if (check.kind === "invalid") {
      return { ok: false, error: t("error.passwordIncorrect") };
    }

    // The binding can change while the canary request is in flight: a key proved against
    // one vault must not be kept, or stored, as another's.
    if (
      this.unloaded ||
      this.settings.connectedVaultId !== vaultId ||
      this.settings.encryptionSalt !== encryptionSalt
    ) {
      return { ok: false, error: t("error.vaultInfoMissing") };
    }

    this.encryptionKey = key;
    await this.storeVaultCredential(remember);
    await this.saveSettings();
    return { ok: true, key };
  }

  /** Keep the derived key (or not) and start syncing the vault just bound. */
  private async bindVault(input: {
    vaultId: string;
    vaultName: string;
    encryptionSalt: string;
    password: string;
    remember: boolean;
    /** Already-derived key, when the caller had to derive one anyway. */
    key?: CryptoKey;
  }): Promise<ActionOutcome> {
    let key = input.key;
    if (!key) {
      try {
        key = await deriveEncryptionKey(input.password, input.encryptionSalt, true);
      } catch (err) {
        console.error("Key derivation failed:", err);
        return { ok: false, error: t("error.keyDerivation") };
      }
    }

    this.settings.connectedVaultId = input.vaultId;
    this.settings.connectedVaultName = input.vaultName;
    this.settings.encryptionSalt = input.encryptionSalt;
    // A connection always starts syncing: pausing belongs to the binding that is being
    // replaced, and a user who just chose a vault is not asking for it to stay paused.
    this.settings.syncPaused = false;
    this.encryptionKey = key;
    await this.storeVaultCredential(input.remember);
    await this.saveSettings();
    // The log belongs to the binding: a new vault starts a new run's history.
    clearSyncLog();
    await this.startHost();
    this.refreshSettings();
    return { ok: true, value: undefined };
  }

  /**
   * Stop syncing without letting go of the vault.
   *
   * The difference from {@link disconnectVault} is everything that is *kept*: the binding,
   * the in-memory key, the credential stored on this device and the sync state. Resuming
   * is therefore one click and no password on a device that remembers it.
   *
   * The host is stopped rather than idled — no vault events, no timers, no WebSocket — so
   * nothing leaves or enters until 继续同步. A single operation already in flight may still
   * complete: the engine is not cancellable.
   */
  async pauseSync(): Promise<void> {
    if (!this.settings.connectedVaultId || this.settings.syncPaused) return;
    // Set before stopping: the WebSocket's own state change re-renders the page, and it
    // must already read "paused" rather than a momentarily disconnected connection.
    this.settings.syncPaused = true;
    await this.saveSettings();
    this.stopHost();
    // The page this button sits on is the confirmation: the row flips to 继续同步 and the
    // state line to 同步已暂停. A toast would only repeat it.
    this.refreshSettings();
  }

  /**
   * Start syncing again, from the state pause left behind.
   *
   * The key normally survives a pause in memory, so this is the same `startHost` the
   * connection used. After a restart a paused load deliberately does not unlock the vault,
   * so there is no key yet: {@link acquireVaultKey} takes the *same* canary-checked path a
   * cold start takes, and only once it has a key does the flag come off and the host start.
   * If no key can be produced, the flag stays set: a cancelled dialog or an unreachable
   * server must not silently re-enable syncing.
   */
  async resumeSync(): Promise<void> {
    if (!this.settings.connectedVaultId || !this.settings.syncPaused) return;

    if (!this.encryptionKey) {
      const key = await this.acquireVaultKey();
      if (!key) {
        this.refreshSettings();
        return;
      }
      this.encryptionKey = key;
    }

    this.settings.syncPaused = false;
    await this.saveSettings();
    // A failure reports itself (`startHost`); a success has nothing to add, because the
    // row re-renders to 暂停同步 and the state line to ● 已连接.
    await this.startHost();
    this.refreshSettings();
  }

  /**
   * Unbind this vault and go back to choosing one.
   *
   * The user key stays: this is "switch vault", not "log out".
   */
  async disconnectVault(): Promise<void> {
    await unbindVault(this.app, this);
    clearSyncLog();
    // The page returns to 选择远程库; that transition is the confirmation.
    this.refreshSettings();
  }

  /**
   * Forget this account on this device: unbind, drop the stored key and clear the
   * user key.
   *
   * The server URL and the device label stay — they are not credentials, and
   * keeping them is what makes logging back in one field instead of three.
   */
  async logout(): Promise<void> {
    await unbindVault(this.app, this, { forgetAccount: true });
    clearSyncLog();
    this.forgetAccount();
    // The page returns to the sign-in step; that transition is the confirmation.
    this.refreshSettings();
  }

  /**
   * Check a vault password against the server's salt + key-check canary. The
   * password never reaches the server, and nothing is mutated: callers decide
   * whether the salt is remembered. The check itself is `shared/vault-credentials.ts`,
   * which unit-tests it with two mock actions.
   *
   * It answers *why* a password was refused (wrong password, or a server that could not
   * be reached), because the vault picker shows that reason inline: a boolean made an
   * unreachable server read as "wrong password" under the row the user had just typed it
   * into, and only a toast said otherwise.
   */
  async fetchVaultCredentials(vaultId: string, password: string): Promise<VaultCredentialCheck> {
    return await checkVaultPassword(this.actions, vaultId, password);
  }

  /**
   * Check that a key we already hold still opens this vault, using the server's canary —
   * the auto-unlock path's way of validating a stored key without the password.
   *
   * Three outcomes, and the third is the one that matters: a **transport** failure is not
   * "this key is wrong" (see `shared/vault-credentials.ts`).
   */
  async verifyKeyAgainstServer(vaultId: string, key: CryptoKey): Promise<StoredKeyCheck> {
    return await verifyKeyAgainstServer(this.actions, vaultId, key);
  }

  /** Keep the device-local vault key, or drop it when the user opted out. */
  private async storeVaultCredential(remember: boolean): Promise<void> {
    const vaultId = this.settings.connectedVaultId;
    if (!remember || !vaultId || !this.encryptionKey) {
      clearVaultCredential(this.app);
      return;
    }
    try {
      saveVaultCredential(this.app, vaultId, await exportRawKey(this.encryptionKey));
    } catch (err) {
      // Losing the convenience must not fail the unlock that just succeeded.
      console.error("Courier: failed to persist the vault key on this device:", err);
    }
  }

  // ── Device name ──

  /**
   * Set the label this client states in the **connected** remote vault's history.
   *
   * Purely local: the name is not registered anywhere, and the next push carries it.
   * Versions already on the server keep the name they were written with, so the sync
   * history shows the rename as it happened. The value is stored under the vault's own
   * record as well, so reconnecting that vault restores it; another vault keeps its own
   * label. `options.refresh` re-renders the settings tab; the settings *field* passes
   * `false`, because a re-render while the user is still typing would take the caret with
   * it.
   */
  async setDeviceName(name: string, options: { refresh?: boolean } = {}): Promise<void> {
    // The one normalization (`@courier/shared`): trimmed, bounded to the wire limit,
    // or the default — the plugin used to trim without bounding, while the CLI did
    // neither and the server truncated on one path and refused on the other.
    this.settings.deviceName = normalizeDeviceName(name);
    const vaultId = this.settings.connectedVaultId;
    if (vaultId) {
      // A first edit on an already-bound vault creates the record from the active values,
      // so renaming never forgets the exclusions the vault is currently using.
      updateVaultConnection(this.settings, vaultId, { deviceName: this.settings.deviceName });
    }
    await this.saveSettings();
    if (options.refresh !== false) this.refreshSettings();
  }

  // ── Engine host lifecycle ──

  /**
   * Start the engine host (then sync).
   *
   * A successful start says nothing: it happens on every app launch and after every
   * scope change, and the settings page already shows the state it would announce
   * (`● 已连接`). Failures are the part the user cannot see anywhere else, so they are
   * reported.
   *
   * Answers whether the host is now running; the early refusals are not failures the
   * caller has to report.
   */
  async startHost(): Promise<boolean> {
    // A late canary result must not start a host from an unloaded plugin.
    if (this.unloaded) return false;
    // The one invariant of pause: nothing starts syncing while the flag is set, whichever
    // path asks. `resumeSync()` and a new connection clear the flag before they call this.
    if (this.settings.syncPaused) return false;
    const vaultId = this.settings.connectedVaultId;
    if (!vaultId) return false;
    // Both refusals below are unreachable from the UI (the settings page's stage and every
    // entry point guarantee a key), so they are a diagnostic rather than a message: a
    // toast here would report a state the user has no way to act on.
    const userKey = this.settings.userKey;
    if (!userKey) {
      console.error("Courier: refusing to start sync without a user key.");
      return false;
    }
    if (!this.encryptionKey) {
      console.error("Courier: refusing to start sync without the vault key in memory.");
      return false;
    }

    // The file-size cap belongs to the account's key and the administrator sets it
    // per key, so it is read from the server on every start rather than from a
    // device setting. A failed read keeps the last known value: being offline must
    // not stop the host from starting (the bind pass will report the outage).
    let account: UserSummary | null = null;
    try {
      account = await this.actions.getMe();
    } catch (err) {
      console.error("Courier: could not read the account's file-size limit:", err);
    }
    // The same answer feeds the status menu's expiry and storage rows. Cache it only for
    // the key it was read with: a sign-out or a switch can land while the request is in
    // flight, and the next key must not inherit this account's quota.
    if (account && this.settings.userKey === userKey) {
      this.account = account;
      this.accountKey = userKey;
    }

    // `getMe` is the first await in this method, and `startHost` is not serialised: a
    // disconnect, a logout, a pause or a vault switch can land while it is in flight.
    // A host built from that stale state would reconnect for a vault this device has
    // just let go (usually without a key any more), so re-read everything that made
    // this start valid before writing settings or constructing the host. The earlier
    // refusals are diagnostics for a state the UI cannot produce; this one is a stale
    // start, not a failure, and says nothing.
    if (!this.bindingStillCurrent(vaultId)) return false;

    if (account) {
      const accountMaxFileBytes = normalizeScope({
        maxFileBytes: account.maxFileBytes,
      }).maxFileBytes;
      if (
        this.settings.userName !== account.name ||
        this.settings.accountMaxFileBytes !== accountMaxFileBytes
      ) {
        this.settings.userName = account.name;
        this.settings.accountMaxFileBytes = accountMaxFileBytes;
        try {
          await this.saveSettings();
        } catch (err) {
          // The in-memory value still governs this host; a disk failure is not a reason
          // to skip the sync it was read for.
          console.error("Courier: saving the account's file-size limit failed:", err);
        }
      }
    }

    // The settings write above is another await; the same stale-start rule applies.
    if (!this.bindingStillCurrent(vaultId)) return false;

    // Wait briefly for the old host's drain so the replacement can acquire the lease
    // immediately. A hung adapter must not freeze the settings page: after the bounded
    // wait, build the replacement and let its acquisition wait for the old release. The
    // old host keeps renewing its lease until that release actually lands.
    const previous = this.host;
    this.host = null;
    previous?.stop();
    await previous?.whenStopped();
    const host = new EngineHost({
      vault: this.app.vault,
      fileManager: this.app.fileManager,
      vaultId,
      encryptionKey: this.encryptionKey,
      serverUrl: getServerUrl(this.settings),
      wsUrl: getWsUrl(this.settings),
      // Read once, at start: a change to any group or file type restarts the host
      // (see `restartHostForScope`), because the engine and the vault adapter both
      // capture the scope when they are built. The size cap is re-read above on each
      // start, so an administrator's change applies then.
      syncScope: syncScopeOf(this.settings, this.app.vault.configDir),
      getSettings: () => this.settings,
      saveSettings: () => this.saveSettings(),
      createSyncApi: this.actions.buildSyncApi,
      // The note on screen first, then the ones Obsidian remembers as recently opened.
      // The engine sorts by this at the start of every pass, so a cold start brings the
      // page the user is looking at up to date before the rest of the vault.
      getPriorityPaths: () => priorityPathsFrom(this.app.workspace),
      onConflictResolved: (event) => this.conflictNotices.push(event),
      onFileTooLarge: (event) => this.tooLargeNotices.push(event),
      // The run's history dialog reads this in-memory log; it is cleared with the
      // binding and on unload, and never persisted (see `shared/sync-log.ts`).
      onSyncActivity: (event) => recordSyncActivity(event),
      // A first pass over a large vault runs for a minute or more. The status bar shows
      // the counter in its tooltip while the host is still binding (see `getProgress`).
      onProgress: (progress) => {
        // `done === total` is the pass's own "finished" signal: keep the counter off then,
        // so a completed bind does not leave "10 000 of 10 000" on the icon for good.
        this.bindProgress = progress.total > 0 && progress.done >= progress.total ? null : progress;
        this.statusBar?.refresh();
      },
      // A pass waits out a limiter window by itself; the console says why it is quiet.
      // Not user copy: this is the diagnostic line the other console messages use.
      onRateLimited: ({ waitMs }) => {
        console.warn(
          `Courier: the server's rate limit was reached; waiting ${Math.ceil(waitMs / 1000)}s.`,
        );
      },
      // Only the groups whose effect waits for a reload: a hot-reloadable setting arriving
      // needs no popup, and asking for a reload anyway is how a plugin teaches users to
      // ignore it.
      onSettingsApplied: (event) => {
        if (settingsGroupNeedsReload(event.group)) this.showReloadNotice();
      },
      onStateChange: () => this.refreshLiveState(),
      onBindFailed: (err) => {
        // One report, then the host's own retries keep it quiet (they only log), so an
        // offline laptop does not produce a Notice every five minutes.
        console.error("Courier: the first sync pass failed:", err);
        showNotice(
          t("notice.bindFailed", {
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      },
      onVaultDeleted: () => void this.handleRemoteVaultDeleted(),
      onAuthFailure: (reason) => void this.handleAuthFailure(reason),
      // One writer per vault. The CLI takes the same lease, so this host does not start
      // its engine while that process owns the vault.
      lease: new SyncLease({
        store: new AdapterLeaseStore(this.app.vault.adapter),
        owner: "plugin",
        // The renderer's Node surface: pid evidence on desktop, absent on mobile.
        process: pluginPlatform.process,
      }),
      onLeaseChange: () => this.refreshLiveState(),
    });
    this.host = host;
    // A new host starts with no counter: the previous vault's done / total must not sit
    // on the icon while this one binds.
    this.bindProgress = null;
    // The host exists but has not subscribed yet; show that state instead of the previous
    // icon until `onStateChange` reports the socket.
    this.statusBar?.refresh();

    try {
      await host.start();
      this.refreshLiveState();
      return true;
    } catch (err) {
      this.refreshLiveState();
      console.error("Failed to start sync:", err);
      showNotice(
        t("notice.syncStartFailed", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return false;
    }
  }

  /**
   * Whether the binding a `startHost()` call began with is still the one to start.
   *
   * Only asked after one of its awaits. A pause, a disconnect, a logout or a switch to
   * another vault turns the start that was in flight into a no-op; it is not a failure
   * the user needs to hear about.
   */
  private bindingStillCurrent(vaultId: string): boolean {
    return (
      !this.settings.syncPaused &&
      this.settings.connectedVaultId === vaultId &&
      !!this.settings.userKey &&
      !!this.encryptionKey
    );
  }

  /**
   * Rebuild the running host so a sync-scope change takes effect.
   *
   * Restarting is what re-runs the bind pass with the new scope: turning settings
   * sync on then pushes this device's settings files (a bind pushes a local file
   * the server has no live version of as new), and turning it off leaves them
   * alone on both sides. A host that is not running yet has nothing to rebuild.
   */
  async restartHostForScope(): Promise<void> {
    if (!this.host) {
      this.refreshLiveState();
      return;
    }
    await this.startHost();
  }

  // ── Scope writes ──

  /**
   * The settings page's only write paths for the sync scope.
   *
   * Each one saves and restarts the host, because the engine and the vault adapter read
   * the scope **when they are built** — the page used to do those three steps itself, in
   * three places, and a fourth caller that forgot the restart would silently keep syncing
   * the old scope.
   *
   * Neither re-renders the page: the switch already shows the new value, and the host's
   * state changes repaint only the connection row's line (see `refreshLiveState`). A full
   * render here would move the page under the user, which is the phone's "jump to top".
   */
  async setFileTypeEnabled(group: FileTypeGroup, enabled: boolean): Promise<void> {
    this.settings.fileTypes = { ...this.settings.fileTypes, [group]: enabled };
    await this.saveSettings();
    await this.restartHostForScope();
  }

  async setSettingsGroupEnabled(group: SettingsGroup, enabled: boolean): Promise<void> {
    this.settings.settingsGroups = { ...this.settings.settingsGroups, [group]: enabled };
    await this.saveSettings();
    await this.restartHostForScope();
  }

  /**
   * Replace the list of folders the connected remote vault leaves out of sync.
   *
   * The settings page's manage dialog builds the whole list and writes it once, so one
   * visit is one host restart. A list that normalizes to the current one does not restart
   * the host — but it still **creates the vault's record** when none exists yet: pressing
   * 完成 without selecting a folder is a completed configuration, and the next connect must
   * not ask for setup again.
   */
  async setExcludedFolders(folders: readonly string[]): Promise<void> {
    const next = normalizeExcludedFolders(folders);
    const vaultId = this.settings.connectedVaultId;
    // Compare as a set: the list has no meaningful order (the dialog renders a tree and
    // writes it parent-first), so re-opening the dialog without changing anything must
    // not restart the host just because the entries came back in another order.
    const current = sortedCopy(this.settings.excludedFolders);
    const candidate = sortedCopy(next);
    const unchanged =
      current.length === candidate.length &&
      current.every((folder, index) => folder === candidate[index]);

    // Keep the stored order when the set did not change: pressing 完成 without changing
    // anything must not rewrite the list (the dialog renders a tree, so its order differs
    // from the saved one).
    if (!unchanged) this.settings.excludedFolders = next;
    if (vaultId) {
      // An empty list is stored as an empty list, not as "no record": the record's presence
      // is what says this vault was configured.
      updateVaultConnection(this.settings, vaultId, {
        excludedFolders: unchanged ? this.settings.excludedFolders : next,
      });
    }

    if (unchanged && !vaultId) return;
    await this.saveSettings();
    if (unchanged) return;

    await this.restartHostForScope();
    // The page's row carries the count, so this is one change a host restart cannot show
    // by itself (unlike the scope switches, which keep the page as it is).
    this.refreshSettings();
    // The file explorer is not part of the host's scope: re-decorate the rows now instead
    // of waiting for the next layout change or row rebuild.
    this.refreshExcludedFolderRows();
  }

  /**
   * Re-apply the file explorer's excluded-folder decorations: the greyed-out rows and the
   * action chips on them (an excluded file has neither a chip nor a menu item).
   *
   * The normal path calls this itself after saving a new list; it is public because a host
   * (the real-Obsidian test harness) can change the settings object directly and needs the
   * same re-decoration without restarting sync.
   */
  refreshExcludedFolderRows(): void {
    this.excludedFolderDimming?.refresh();
    this.explorerActions?.refresh();
  }

  /**
   * Unlock the bound vault on load: resume silently from the key stored on this
   * device, and fall back to the password dialog when there is none or it no
   * longer opens the vault.
   *
   * This is what stops "reopen Obsidian" from meaning "type the vault password
   * every time" — on desktop and mobile alike.
   *
   * Public because it is also the settings page's `unverified` retry: when a start
   * could not reach the server to prove the stored key, the page offers this same
   * path again rather than asking for a password that cannot be proved either.
   *
   * Single-flight, for the same reason as the dialog: a retry clicked while the load's
   * unlock is still running must join it instead of starting a second host.
   *
   * Answers whether a host was started, so a caller the user is watching (the settings
   * retry) can report a failure inline instead of leaving the page unchanged.
   */
  autoUnlockOrPrompt(): Promise<boolean> {
    const running = this.pendingAutoUnlock;
    if (running) return running;
    const promise = this.runAutoUnlock().finally(() => {
      if (this.pendingAutoUnlock === promise) this.pendingAutoUnlock = null;
    });
    this.pendingAutoUnlock = promise;
    return promise;
  }

  private async runAutoUnlock(): Promise<boolean> {
    // The key belongs to the binding it was proved for: a disconnect or a vault switch can
    // land while the canary request is in flight, and the old vault's key must not unlock
    // (or start) the new one.
    const vaultId = this.settings.connectedVaultId;
    const key = await this.acquireVaultKey();
    if (this.unloaded) return false;
    if (!key || this.settings.connectedVaultId !== vaultId) {
      this.refreshSettings();
      return false;
    }
    this.encryptionKey = key;
    const started = await this.startHost();
    // The host starts silently; this is the page's step transition (locked → ready) when a
    // settings tab was already open while the key was being acquired.
    this.refreshSettings();
    return started;
  }

  /**
   * Whether a stored-key unlock is running.
   *
   * The settings page's locked step checks this before opening its dialog: while the load
   * unlock is waiting on that same dialog, the click has nothing to add — the running
   * unlock will derive the key and start the host from the one answer.
   */
  get autoUnlockInFlight(): boolean {
    return this.pendingAutoUnlock !== null;
  }

  /**
   * Get a key that opens the bound vault, prompting only when this device cannot
   * supply one silently. Null means "no key", and the reason has already been reported.
   *
   * This is the half of the old `autoUnlockOrPrompt` that does **not** start a host, so
   * the paused path can reuse it: `resumeSync()` must clear the pause flag before
   * anything starts, and `startHost()` refuses to run while it is set.
   */
  private async acquireVaultKey(): Promise<CryptoKey | null> {
    const vaultId = this.settings.connectedVaultId;
    if (!vaultId) return null;

    // Without a user key there is nothing to sync, so asking for the vault
    // password would collect a secret the host cannot use: point at the
    // settings tab instead.
    if (!this.settings.userKey) {
      showNotice(t("notice.userKeyRequiredSettings"));
      return null;
    }

    const credential = loadVaultCredential(this.app, vaultId);
    if (!credential) return await this.promptForVaultKey();

    let key: CryptoKey;
    try {
      key = await importRawKey(credential.encryptionKeyB64);
    } catch (err) {
      console.error("Stored vault key is unusable:", err);
      clearVaultCredential(this.app);
      return await this.promptForVaultKey();
    }

    // Validate against the server's canary: a stale key must degrade to the dialog
    // instead of silently never syncing. A server that cannot be reached is **not** that
    // case — the stored key is kept (it was verified when it was stored, and it is scoped
    // to this vault), the user is not asked for a password they cannot prove either, and
    // the next load tries again.
    const check = await this.verifyKeyAgainstServer(vaultId, key);
    if (check.kind === "unreachable") {
      console.error("Could not check the stored vault key:", check.error);
      showNotice(t("notice.serverUnreachableKeepKey"));
      return null;
    }
    if (check.kind === "invalid") {
      clearVaultCredential(this.app);
      showNotice(t("notice.storedCredentialInvalid"));
      return await this.promptForVaultKey();
    }

    return key;
  }

  /**
   * Open the vault-password dialog, or join the one already open.
   *
   * The single entry point for "ask the user for the vault password" — the load-time
   * unlock, the settings page's locked step and the test harness all come through here.
   * Resolves with the typed password, or null when the dialog was dismissed.
   */
  askForVaultPassword(options: PasswordPromptOptions = {}): Promise<PasswordPromptResult | null> {
    const open = this.pendingPasswordPrompt;
    if (open) return open;
    const modal = new PasswordPromptModal(this.app, options);
    this.pendingPasswordModal = modal;
    const result = modal.getResult().finally(() => {
      if (this.pendingPasswordPrompt === result) this.pendingPasswordPrompt = null;
      if (this.pendingPasswordModal === modal) this.pendingPasswordModal = null;
    });
    this.pendingPasswordPrompt = result;
    modal.open();
    return result;
  }

  /**
   * Prompt for the vault password and return the proven key, **without starting a host**.
   *
   * The typed password is verified against the canary inside {@link deriveVaultKey}: a
   * wrong one must not produce a key this vault was never created with. Null means the
   * dialog was cancelled or the password could not be proved; both cases have reported
   * themselves, and neither may start syncing.
   */
  private async promptForVaultKey(): Promise<CryptoKey | null> {
    if (!this.settings.connectedVaultId) return null;
    const result = await this.askForVaultPassword();
    // Cancelling is not an error: the page stays on the step that asked for the password
    // (locked, or paused), so there is nothing to announce.
    if (!result) return null;
    const derived = await this.deriveVaultKey(result.password, result.remember);
    if (!derived.ok) {
      // The prompt has closed, so this is the only surface left for "that password did not
      // unlock the vault"; the error already says what to do, so it is the whole message.
      showNotice(derived.error);
      return null;
    }
    return derived.key;
  }

  // ── Remote lifecycle notifications ──

  private async handleRemoteVaultDeleted(): Promise<void> {
    const vaultId = this.settings.connectedVaultId;
    if (vaultId) forgetVaultConnection(this.settings, vaultId);
    showNotice(
      t("notice.remoteVaultDeleted", {
        vault: this.settings.connectedVaultName ?? "",
      }),
    );
    await unbindVault(this.app, this);
    clearSyncLog();
    this.refreshSettings();
  }

  /**
   * The credential stopped working, and the host has already stopped itself.
   *
   * The three reasons are not the same event:
   *
   * - **revoked** (the account was deleted): the vault went with it, so the binding is
   *   meaningless — unbind and forget the key, the way a sign-out does;
   * - **expired** / **disabled**: the key, the vault and every version are still on the
   *   server. Dropping the binding would make the user re-enter the password for a
   *   problem an administrator fixes on their side, so the vault is **paused** instead:
   *   the state a deliberate pause leaves, which is also what gives the user the
   *   `恢复同步` action once the key works again.
   */
  private async handleAuthFailure(reason: AuthFailureReason): Promise<void> {
    if (reason === "revoked") {
      showNotice(t("notice.userKeyRevoked"));
      await unbindVault(this.app, this, { forgetAccount: true });
      clearSyncLog();
      this.forgetAccount();
      this.refreshSettings();
      return;
    }

    // Set before the page renders: the state line must read 同步已暂停, not a
    // momentarily disconnected host.
    if (!this.settings.syncPaused) {
      this.settings.syncPaused = true;
      try {
        await this.saveSettings();
      } catch (err) {
        // The in-memory flag already governs this session; a disk failure must not
        // leave the host running against a credential that cannot work.
        console.error("Courier: saving the paused state failed:", err);
      }
    }
    this.stopHost();
    showNotice(t(reason === "expired" ? "notice.keyExpired" : "notice.keyDisabled"));
    this.refreshSettings();
  }

  // ── Version history ──

  /**
   * Open a file's version history as a main-area tab (`ui/version-history-view.ts`).
   *
   * One tab per chain: a chain that already has one gets its tab activated instead of a
   * second. The **fileId**, not the path, is the view's identity, so a rename and a
   * detach/reopen of the same history land back on the same tab.
   *
   * Needs the engine (the chain is resolved from the fileId it tracks) and the vault key
   * (each version's content is decrypted in the view), so a paused, disconnected or untracked
   * file answers with the same notice the old dialog used.
   */
  async openVersionHistory(file: TFile): Promise<WorkspaceLeaf | null> {
    return await this.openVersionHistoryPath(file.path);
  }

  /**
   * The same, from a path — the file explorer's chip only knows the path it decorated, and it
   * must not reach into the vault to build a `TFile` for it.
   */
  async openVersionHistoryPath(path: string): Promise<WorkspaceLeaf | null> {
    const engine = this.host?.engine;
    const vaultId = this.settings.connectedVaultId;
    if (!engine || !vaultId) {
      // Two different reasons reach this line, and "not connected" would be wrong for one
      // of them: a paused vault is still bound, it just has no host to read the chain.
      showNotice(this.settings.syncPaused ? t("notice.needsResume") : t("notice.notConnected"));
      return null;
    }
    const fileId = engine.fileIdForPath(path);
    if (!fileId) {
      showNotice(t("error.noFileId"));
      return null;
    }

    const state: VersionHistoryViewState = {
      target: { vaultId, fileId, path },
      mode: "content",
    };
    const existing = this.app.workspace.getLeavesOfType(VERSION_HISTORY_VIEW_TYPE).find((leaf) => {
      // A background tab is a **deferred** leaf: its `view` is not this class yet, so the
      // history is recognised by its saved state (which is the identity anyway) — a lookup
      // through `view instanceof` would open a second tab for a history that is sitting
      // behind the user's other tabs. The vault is part of the identity: the same fileId in
      // two vaults is two chains.
      const view = leaf.view;
      if (view instanceof VersionHistoryView) {
        return view.trackedFileId === fileId && view.trackedVaultId === vaultId;
      }
      const saved = parseVersionHistoryState(leaf.getViewState().state);
      return saved?.target.fileId === fileId && saved.target.vaultId === vaultId;
    });
    if (existing) {
      // A tab that is already open keeps its selected version and its layout choice: the
      // state presented here would only reset them under the user.
      await this.app.workspace.revealLeaf(existing);
      return existing;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: VERSION_HISTORY_VIEW_TYPE, active: true, state });
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  // ── Conflict copies ──

  /**
   * Compare a parked conflict copy with the file it was parked beside.
   *
   * Opens the comparison as a main-area tab (`ui/conflict-diff-view.ts`). One tab per
   * parked copy: a copy that is already being compared gets its tab activated instead of a
   * second one — the copy's path is the view's identity, so a detach and a re-open of the
   * same comparison lands back on the same tab.
   *
   * One surface for both platforms; a phone gets the **unified** presentation by default,
   * because two columns do not fit a phone's page. Both sides are local vault files, so this
   * needs no vault key, no engine and no network — it keeps working while sync is stopped or
   * the vault is locked.
   */
  async openConflictDiff(conflictPath: string): Promise<WorkspaceLeaf | null> {
    const target = this.conflictTarget(conflictPath);
    if (!target) return null;
    const state: ConflictDiffState = {
      target,
      mode: defaultConflictDiffMode(Platform.isPhone),
    };
    const existing = this.app.workspace.getLeavesOfType(CONFLICT_DIFF_VIEW_TYPE).find((leaf) => {
      // A background tab is a **deferred** leaf: its `view` is not this class yet, so the
      // comparison is recognised by its saved state (which is the identity anyway) — a
      // lookup through `view instanceof` would open a second tab for a copy whose
      // comparison is sitting behind the user's other tabs.
      const view = leaf.view;
      if (view instanceof ConflictDiffView) {
        if (view.comparedTarget?.conflictPath === conflictPath) return true;
      }
      const saved = parseConflictDiffState(leaf.getViewState().state);
      return saved?.target.conflictPath === conflictPath;
    });
    if (existing) {
      // A tab that is already open keeps its layout choice: the state presented here is
      // the same pair, so re-applying it would only reset 并排/统一 under the user.
      await this.app.workspace.revealLeaf(existing);
      return existing;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type: CONFLICT_DIFF_VIEW_TYPE, active: true, state });
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  /**
   * Put the conflict copy's content at the original path, after confirming.
   *
   * A plain vault write: the engine sees the ordinary vault event and treats it as a user
   * edit, so the choice reaches the other devices under the engine's own rules — a `modify`
   * on a tracked path, a new file when the chain is a peer's tombstone. Offered on every
   * platform; the confirmation is a dialog, which the phone renders full width.
   */
  async openConflictReplace(conflictPath: string): Promise<void> {
    const target = this.conflictTarget(conflictPath);
    if (!target) return;
    await runConflictReplace(this.app, target);
  }

  /**
   * The two paths a conflict action works on.
   *
   * The original is resolved from the copy's name against the vault's own index; only a
   * **file** counts, because a folder at that path is not something either action can
   * compare with or write over.
   */
  private conflictTarget(conflictPath: string): ReplaceTarget | null {
    const originalPath = resolveConflictOriginal(
      conflictPath,
      (path) => this.app.vault.getAbstractFileByPath(path) instanceof TFile,
    );
    if (originalPath === null) {
      showNotice(t("error.conflictOriginalUnknown"));
      return null;
    }
    return { conflictPath, originalPath };
  }

  // ── Status bar ──

  /** The plugin state as the status bar shows it. */
  private currentSyncStatus(): SyncStatus {
    return syncStatusOf({
      connectedVaultId: this.settings.connectedVaultId,
      userKey: this.settings.userKey,
      syncPaused: this.settings.syncPaused,
      hostRunning: this.host !== null,
      wsState: this.wsState,
      leaseWaiting: this.host?.leaseWaiting ?? false,
      // The first pass runs before the socket subscribes; it is work, not a fault.
      binding: this.host?.binding ?? false,
    });
  }

  /**
   * How far the current **first** pass has got, for the status bar's tooltip.
   *
   * Only while the host is still binding: a later pass reports progress too, and calling
   * that "first sync" would be a lie. The value is kept by the `onProgress` handler that
   * built the host, so it cannot outlive the pass that produced it.
   */
  private currentBindProgress(): { done: number; total: number } | null {
    // `firstSync` is the narrower claim: a bind pass also runs at every start, but only a
    // vault this device has never synced may be called a first sync.
    return this.host?.firstSync === true ? this.bindProgress : null;
  }

  /**
   * The account behind the current key, for the status menu.
   *
   * A fresh read on every opening (the values are quotas, not a constant), bounded by
   * `ACCOUNT_READ_TIMEOUT_MS` so an unreachable server cannot leave the click with no
   * menu. A failed read falls back to the cached answer for the same key; a different key
   * has no cached answer to fall back to. Nothing here raises a `Notice`: the menu itself
   * is the surface the user clicked, and it says what it could not read.
   */
  private async readAccountForStatusMenu(): Promise<UserSummary | null> {
    const userKey = this.settings.userKey;
    if (!userKey) {
      this.forgetAccount();
      return null;
    }
    const cached = this.accountKey === userKey ? this.account : null;
    try {
      const account = await withTimeout(this.actions.getMe(), ACCOUNT_READ_TIMEOUT_MS);
      // A sign-out or a switch landed while the request was in flight: the answer belongs
      // to a key this device no longer holds, and showing its quota under the new one
      // would be a lie. The caller opens a fresh menu on the new key's own read.
      if (this.settings.userKey !== userKey) return null;
      this.account = account;
      this.accountKey = userKey;
      return account;
    } catch (err) {
      console.error("Courier: could not read the account for the status menu:", err);
      return this.settings.userKey === userKey ? cached : null;
    }
  }

  /** Drop the cached account — the key it belonged to is gone. */
  private forgetAccount(): void {
    this.account = null;
    this.accountKey = null;
  }

  /**
   * Open Courier's own settings tab.
   *
   * `app.setting` is not in Obsidian's public typings, but it is the only way to land on
   * a *specific* plugin's tab (the same call the e2e suite makes). The command is the
   * fallback: it opens Settings without selecting the tab, which is still better than a
   * row that does nothing.
   */
  private openSettingsTab(): void {
    const app = this.app as unknown as {
      setting?: { open(): void; openTabById(id: string): void };
      commands?: { executeCommandById?: (id: string) => boolean };
    };
    if (app.setting) {
      try {
        app.setting.open();
        app.setting.openTabById(this.manifest.id);
        // A tab drawn from definitions is rendered from the ones it stored when it was added
        // (1.13: `settingItems`, filled by `update()`), and opening it again does not re-ask.
        // The state this page shows — the step, the bound vault, the socket — changes behind
        // its back, so the rows are re-stored here, right before the user reads them.
        this.refreshSettings();
        return;
      } catch (err) {
        console.error("Courier: could not open the plugin's settings tab:", err);
      }
    }
    app.commands?.executeCommandById?.("app:open-settings");
  }

  // ── Helpers ──

  /**
   * Repaint the live state surfaces without rebuilding the settings page.
   *
   * The host reports state changes while a scope switch restarts it. The page's rows are
   * settings, so only the status bar and the connection row's state line follow the socket;
   * a full render here would throw away the user's scroll position and replace the switch
   * they just flipped.
   */
  private refreshLiveState(): void {
    this.statusBar?.refresh();
    this.settingTab?.refreshConnectionState();
  }

  /**
   * Re-render the settings page and the status bar after a user action that changes the
   * page's rows or step (bind, unlock, pause/resume, disconnect, logout, an applied folder
   * scope).
   */
  private refreshSettings(): void {
    this.statusBar?.refresh();
    this.settingTab?.refresh();
  }
}
