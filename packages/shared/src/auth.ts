// ── Host keys (`ak_...`) ──

/**
 * A capability an `ak_` host key carries. `admin` implies every other scope, so
 * a key a human creates with `courier apikey create` keeps the full power the
 * old keys had; a host mints itself a `status,users` key instead,
 * which cannot manage vaults or mint other keys.
 */
export const API_KEY_SCOPES = ["admin", "status", "users"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export interface CreateApiKeyResponse {
  id: string;
  name: string;
  key: string;
  scopes: ApiKeyScope[];
  /** ISO 8601 expiry of the host key. Null = never expires. */
  expiresAt: string | null;
  createdAt: string;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  /** Masked (`ak_xxxxxxxx***yyyy`); the full key is returned once, at creation. */
  key: string;
  scopes: ApiKeyScope[];
  expiresAt: string | null;
  createdAt: string;
}

export interface ListApiKeysResponse {
  apiKeys: ApiKeySummary[];
}

// ── Users (shared-server multi-user model) ──

/**
 * How many vaults a new user key may own unless the host says otherwise.
 *
 * One: the default deployment is one person, one vault, and a second vault is a
 * deliberate allowance the host grants on the account (`maxVaults`). `0` means
 * unlimited. The server stores this as the default of `users.max_vaults` and
 * enforces it on `POST /api/vaults`.
 */
export const DEFAULT_MAX_VAULTS = 1;

/**
 * A user is an account on a shared Courier server. Each user owns up to
 * `maxVaults` vaults and holds a single user key (`ck_...`) shared across all of
 * their devices. The server host authorizes the user's vault count, storage
 * quota, history retention window, and key validity period.
 */
export interface UserSummary {
  id: string;
  name: string;
  /** User key prefix omitted for masking; the full `ck_...` is returned once at creation. */
  storageBytesLimit: number | null;
  /**
   * The key with its middle replaced by `*` (`ck_ab12****cd34`), safe to show in
   * a host's user list. The full key is only returned at creation or by
   * `GET /api/users/:id/key`, which is host-only.
   */
  maskedKey: string;
  /** How long (in days) version history is retained for this user's vaults. */
  retentionDays: number | null;
  /**
   * Largest plaintext file this key's clients may sync, in bytes (`0` = unlimited).
   *
   * The host sets it per account and every official client reads it from
   * `GET /api/me` before deciding what it can read or download. It is a client-side
   * guard rail, not the server's storage limit (`storageBytesLimit`).
   */
  maxFileBytes: number;
  /**
   * How many vaults this key may own. `0` = unlimited.
   *
   * Enforced by the server on `POST /api/vaults`: an account already owning
   * that many vaults gets `409 VAULT_LIMIT_REACHED` and creates nothing. It is
   * per account, so every device holding the same key shares the allowance.
   */
  maxVaults: number;
  /** ISO 8601 expiry of the user key. Null = never expires. */
  expiresAt: string | null;
  /**
   * Whether the host has disabled this account.
   *
   * A disabled key keeps everything it owns — the key itself, its vaults, their
   * version chains and blobs — but authenticates nothing: every route answers
   * `403 KEY_DISABLED` until the host enables it again. It is the reversible
   * counterpart of deleting the account.
   */
  disabled: boolean;
  createdAt: string;
  /** Approximate storage currently used across the user's vaults (bytes). */
  usedBytes?: number;
  /** How many vaults the account owns right now. */
  vaultsCount?: number;
}

export interface CreateUserResponse extends UserSummary {
  /**
   * The full user key (`ck_...`). Returned at creation, and again by the explicit
   * host-only reveal endpoint; the list only carries `maskedKey`.
   */
  key: string;
}

/** The full key of one account, returned only by `GET /api/users/:id/key`. */
export interface RevealUserKeyResponse {
  key: string;
}

export interface ListUsersResponse {
  users: UserSummary[];
}

/** `POST /api/users`: the host's account-creation body. */
export interface CreateUserRequest {
  name: string;
  storageBytesLimit?: number | null;
  retentionDays?: number | null;
  maxFileBytes?: number;
  maxVaults?: number;
  expiresAt?: string | null;
  disabled?: boolean;
}

export interface UpdateUserRequest {
  name?: string;
  storageBytesLimit?: number | null;
  retentionDays?: number | null;
  /** Largest plaintext file this key's clients may sync, in bytes (`0` = unlimited). */
  maxFileBytes?: number;
  /** How many vaults this key may own (`0` = unlimited). */
  maxVaults?: number;
  expiresAt?: string | null;
  /** Disable (or re-enable) the key without touching what it owns. */
  disabled?: boolean;
}

// ── Admin / service status ──

/** Service-level status for a service-management panel. */
export interface AdminStatusResponse {
  storageUsedBytes: number;
  storageLimitBytes: number | null;
  dbBytes: number;
  /**
   * The filesystem holding the service's data, from `statfs`, in bytes. They are
   * reported over HTTP because `statfs` is cheap and the process can answer it;
   * the operator asks systemd over SSH for the same numbers only when the process
   * does not answer. Zero means the filesystem could not be read.
   */
  diskTotalBytes: number;
  diskUsedBytes: number;
  diskFreeBytes: number;
  /**
   * The build marker beside the running binary (`~/courier/.courier-binary`):
   * the installed build's SHA-256 and size. Empty/zero when the marker is not
   * readable (a development run, or a binary started outside a deployment).
   * The update check reads this over HTTP instead of asking SSH for a file.
   */
  binarySha256: string;
  binarySize: number;
  /** How many encrypted blobs the store holds. */
  blobCount: number;
  usersCount: number;
  /**
   * How many distinct device labels the vault history has seen.
   *
   * There is no device registry: a client states its own name on every push, so
   * this is "names that appear in `file_versions`", not "registered devices" —
   * two machines may share one name, and a renamed machine counts twice.
   */
  devicesCount: number;
  vaultsCount: number;
  /** Migrations the database has applied. */
  migrationsApplied: number;
  /** Migrations this binary carries. A database ahead of it was migrated by a newer build. */
  migrationsKnown: number;
  /** The reporting binary's version, `"dev"` for a build the release process did not produce. */
  version: string;
}

/**
 * Facts only the **running process** can answer about itself: what it consumes,
 * how long it has been up, and what the machine under it looks like right now.
 *
 * Deliberately not here: whether the service is running, how often systemd
 * restarted it, and why it stopped. A process cannot report its own death, so the
 * operator asks systemd over SSH for those — and only when this endpoint does not
 * answer.
 */
export interface AdminRuntimeResponse {
  version: string;
  /** The JavaScript runtime the service is running on, as `name/version`. */
  runtime: string;
  pid: number;
  /** Seconds since this process started. */
  uptimeSeconds: number;
  /** Cumulative user+system CPU microseconds, for deltas. */
  cpuMicros: number;
  /** Percent of one core since the previous read; null until there is a previous one. */
  cpuPercent: number | null;
  /** Resident set size, bytes. */
  memoryBytes: number;
  /** Machine-wide, from the OS: how many cores, and the load averages. */
  cpuCount: number;
  loadAverage: [number, number, number];
  freeMemoryBytes: number;
  totalMemoryBytes: number;
  /** Distinct users with a WebSocket subscriber right now, and vaults with any. */
  onlineUsers: number;
  onlineVaults: number;
  /** When this sample was taken, ISO 8601. */
  sampledAt: string;
}
