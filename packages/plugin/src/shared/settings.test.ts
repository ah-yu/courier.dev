import { describe, expect, it } from "vitest";
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
} from "./settings";

function settingsWith(overrides: Partial<CourierSettings> = {}): CourierSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...overrides,
    // A fresh object, so one test cannot mutate the module-level default.
    vaultConnections: { ...overrides.vaultConnections },
  };
}

/**
 * The per-vault connection records.
 *
 * The one rule these tests exist for is that **an empty folder list is still a completed
 * configuration**. The reconnect flow asks `vaultHasSetup`, not `excludedFolders.length`,
 * so a record whose list is `[]` must survive normalization, updates and a settings edit
 * that changes nothing.
 */
describe("vault connection records", () => {
  describe("normalizeVaultConnections", () => {
    it("returns an empty record for anything that is not an object", () => {
      expect(normalizeVaultConnections(undefined)).toEqual({});
      expect(normalizeVaultConnections(null)).toEqual({});
      expect(normalizeVaultConnections([])).toEqual({});
      expect(normalizeVaultConnections("vault")).toEqual({});
    });

    it("normalizes the label and the folder list, and keeps empty lists", () => {
      expect(
        normalizeVaultConnections({
          v1: {
            deviceName: "  Study Laptop  ",
            excludedFolders: ["private/", "private", "../escape", "daily"],
          },
          " v2 ": { deviceName: "", excludedFolders: [] },
        }),
      ).toEqual({
        v1: { deviceName: "Study Laptop", excludedFolders: ["private", "daily"] },
        // A blank label falls back to the default, and the empty list stays a record.
        v2: { deviceName: "My Device", excludedFolders: [] },
      });
    });

    it("drops empty keys and values that are not records", () => {
      expect(
        normalizeVaultConnections({
          "": { deviceName: "x", excludedFolders: [] },
          v1: "not a record",
          v2: [],
          v3: { deviceName: 42 },
        }),
      ).toEqual({
        // A record object with an unusable name still marks the vault as configured.
        v3: { deviceName: "My Device", excludedFolders: [] },
      });
    });
  });

  describe("vaultHasSetup", () => {
    it("is false only when the vault has no record", () => {
      const settings = settingsWith();
      expect(vaultHasSetup(settings, "v1")).toBe(false);

      setVaultConnection(settings, "v1", { deviceName: "Laptop", excludedFolders: [] });
      // The point: no folders selected still counts as configured.
      expect(vaultHasSetup(settings, "v1")).toBe(true);
    });

    it("does not mistake inherited properties for a record", () => {
      expect(vaultHasSetup(settingsWith(), "toString")).toBe(false);
    });
  });

  describe("connectionSettingsForVault", () => {
    it("starts a new vault from the active label and no exclusions", () => {
      const settings = settingsWith({ deviceName: "Laptop", excludedFolders: ["private"] });

      expect(connectionSettingsForVault(settings, "v1")).toEqual({
        deviceName: "Laptop",
        excludedFolders: [],
      });
    });

    it("returns the vault's own stored values", () => {
      const settings = settingsWith({
        deviceName: "Active",
        excludedFolders: ["active"],
        vaultConnections: {
          v1: { deviceName: "Vault One", excludedFolders: ["private"] },
        },
      });

      expect(connectionSettingsForVault(settings, "v1")).toEqual({
        deviceName: "Vault One",
        excludedFolders: ["private"],
      });
    });
  });

  describe("setVaultConnection / updateVaultConnection", () => {
    it("stores an empty folder list instead of dropping the record", () => {
      const settings = settingsWith();
      setVaultConnection(settings, "v1", { deviceName: "Laptop", excludedFolders: [] });

      expect(settings.vaultConnections.v1).toEqual({
        deviceName: "Laptop",
        excludedFolders: [],
      });
      expect(vaultHasSetup(settings, "v1")).toBe(true);
    });

    it("keeps the active folders when a first rename creates the record", () => {
      // A vault bound before this feature (or seeded by a test) has no record yet. Renaming
      // it must not silently drop the exclusions the host is currently using.
      const settings = settingsWith({ deviceName: "Old", excludedFolders: ["private"] });

      updateVaultConnection(settings, "v1", { deviceName: "New" });

      expect(settings.vaultConnections.v1).toEqual({
        deviceName: "New",
        excludedFolders: ["private"],
      });
    });

    it("patches one field and keeps the other", () => {
      const settings = settingsWith({
        vaultConnections: {
          v1: { deviceName: "Laptop", excludedFolders: ["private"] },
        },
      });

      updateVaultConnection(settings, "v1", { excludedFolders: [] });
      expect(settings.vaultConnections.v1).toEqual({
        deviceName: "Laptop",
        excludedFolders: [],
      });

      updateVaultConnection(settings, "v1", { deviceName: "Renamed" });
      expect(settings.vaultConnections.v1).toEqual({
        deviceName: "Renamed",
        excludedFolders: [],
      });
    });
  });

  it("forgets exactly one vault", () => {
    const settings = settingsWith({
      vaultConnections: {
        a: { deviceName: "A", excludedFolders: [] },
        b: { deviceName: "B", excludedFolders: ["private"] },
      },
    });

    forgetVaultConnection(settings, "a");

    expect(settings.vaultConnections).toEqual({
      b: { deviceName: "B", excludedFolders: ["private"] },
    });
  });
});

/**
 * The scope the host and the sync history share.
 *
 * The two used to build it separately, which is how a row can claim a file is excluded
 * while the running engine is syncing it. The function is thin, but a swapped field (the
 * groups read as file types, the cap read as a count) would still typecheck in part and
 * silently change what syncs — so the wiring itself is pinned here.
 */
describe("syncScopeOf", () => {
  it("normalizes the settings into the scope the engine reads", () => {
    const settings = settingsWith({
      settingsGroups: { ...DEFAULT_SETTINGS.settingsGroups, corePlugins: true },
      fileTypes: { ...DEFAULT_SETTINGS.fileTypes, images: false },
      excludedFolders: ["private/", "private"],
      accountMaxFileBytes: 4096,
    });

    const scope = syncScopeOf(settings, ".obsidian");

    expect(scope.configDir).toBe(".obsidian");
    expect(scope.settingsGroups).toEqual({
      ...DEFAULT_SETTINGS.settingsGroups,
      corePlugins: true,
    });
    expect(scope.fileTypes).toEqual({ ...DEFAULT_SETTINGS.fileTypes, images: false });
    // Normalized like every other entry point: a trailing slash is not a second folder.
    expect(scope.excludedFolders).toEqual(["private"]);
    expect(scope.maxFileBytes).toBe(4096);
    // The retention limits are the vault's server state, not part of this device's scope.
    expect(scope).not.toHaveProperty("historyLimits");
  });

  it("uses the vault's own config folder rather than assuming .obsidian", () => {
    expect(syncScopeOf(settingsWith(), ".config").configDir).toBe(".config");
  });
});
