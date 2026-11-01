import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  isSyncablePath,
  normalizeScope,
  OBSIDIAN_DEFAULT_GROUPS,
  SETTINGS_GROUPS,
  settingsGroupOf,
  type SettingsAppliedEvent,
  type SettingsGroup,
  type SettingsSyncGroups,
  type SyncScope,
} from "../../engine/src/index";
import { createTestClient, type TestClient } from "./harness/client";
import { startTestServer, type TestServer } from "./harness/server";
import {
  createTestVault,
  makeVaultMaterial,
  type TestVault,
  type VaultMaterial,
} from "./harness/vault";
import { vaultHistory, filesAtPath } from "./harness/api";

/** The paths the server holds a chain for, as this device sees them. */
async function chainCount(target: TestServer, vaultId: string): Promise<number> {
  return (await vaultHistory(target, vaultId)).length;
}

/** Only the named groups on — the record the settings page writes for one switch. */
function onlyGroups(...groups: SettingsGroup[]): Partial<SettingsSyncGroups> {
  const settingsGroups: Record<string, boolean> = {};
  for (const group of groups) settingsGroups[group] = true;
  return settingsGroups;
}

/**
 * Syncing Obsidian's settings files (the `.obsidian` config folder) end to end:
 * real server, real `SyncEngine`, real CLI filesystem adapter.
 *
 * Two things make this layer the right one for the feature. First, the config
 * folder is **outside Obsidian's vault index**, so a settings change is invisible
 * to a listing of notes and has to travel through the sync scope instead; the
 * adapter's walk is what these cases exercise against a real filesystem. Second,
 * the scope is a *device-local* decision, and the interesting failure is the
 * asymmetric one — a peer that has settings on must not be able to make a device
 * that has them off pull, delete or "conflict" on files it never asked to sync.
 */
describe("settings sync e2e — the Obsidian config folder", () => {
  let server: TestServer;
  let material: VaultMaterial;
  let clients: TestClient[] = [];

  beforeAll(async () => {
    server = await startTestServer("settings sync e2e user");
    material = await makeVaultMaterial();
  }, 120_000);

  afterEach(() => {
    for (const client of clients) client.cleanup();
    clients = [];
  });

  afterAll(async () => {
    await server.close();
  });

  async function newVault(name: string): Promise<TestVault> {
    return await createTestVault(server, name, material);
  }

  async function newClient(
    vaultId: string,
    deviceName: string,
    options: {
      settingsGroups?: Partial<SettingsSyncGroups>;
      dir?: string;
      /** Fired for every config-folder file this device applied from a peer. */
      onSettingsApplied?: (event: SettingsAppliedEvent) => void;
    } = {},
  ): Promise<TestClient> {
    const client = await createTestClient({
      server,
      vaultId,
      key: material.key,
      deviceName,
      ...options,
    });
    clients.push(client);
    return client;
  }

  /** Every config-folder group on — the "sync all settings" device. */
  const ALL_GROUPS: SettingsSyncGroups = {
    ...OBSIDIAN_DEFAULT_GROUPS,
    communityPluginList: true,
    communityPlugins: true,
    otherFiles: true,
  };

  /**
   * One representative file per config-folder group, with the content it carries.
   *
   * The group list is the engine's own (`SETTINGS_GROUPS`) and every path in here is
   * checked against `settingsGroupOf` in the case that uses it, so the table cannot
   * drift into testing the wrong switch: a path whose owner moves fails that check, and
   * a group added to the engine later fails the coverage case below until it is listed.
   */
  const GROUP_FILES: Record<SettingsGroup, ReadonlyArray<{ path: string; content: string }>> = {
    app: [{ path: ".obsidian/app.json", content: '{"theme":"moonstone"}' }],
    appearance: [{ path: ".obsidian/appearance.json", content: '{"accentColor":"#123456"}' }],
    themes: [
      { path: ".obsidian/themes/Minimal/theme.css", content: "body { --line-width: 100%; }" },
    ],
    snippets: [{ path: ".obsidian/snippets/wide.css", content: ".wide { max-width: 100%; }" }],
    hotkeys: [{ path: ".obsidian/hotkeys.json", content: '{"new-note":[]}' }],
    corePlugins: [
      { path: ".obsidian/core-plugins.json", content: '{"sync":false,"daily-notes":true}' },
    ],
    corePluginSettings: [{ path: ".obsidian/graph.json", content: '{"zoom":0.8}' }],
    communityPluginList: [{ path: ".obsidian/community-plugins.json", content: '["dataview"]' }],
    communityPlugins: [
      { path: ".obsidian/plugins/dataview/main.js", content: "module.exports = {};" },
    ],
    otherFiles: [{ path: ".obsidian/my-tool/state.json", content: '{"x":1}' }],
  };

  it("carries a settings file to a peer that syncs settings too", async () => {
    const vault = await newVault("settings-transfer");
    const a = await newClient(vault.id, "device-a", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
    const b = await newClient(vault.id, "device-b", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });

    a.write(".obsidian/app.json", '{"theme":"moonstone"}');
    a.write(".obsidian/snippets/wide.css", "body { --line-width: 100%; }");
    await a.sync();

    await b.sync();

    expect(b.read(".obsidian/app.json")).toBe('{"theme":"moonstone"}');
    expect(b.read(".obsidian/snippets/wide.css")).toBe("body { --line-width: 100%; }");
    expect(await b.list()).toContain(".obsidian/app.json");
  });

  it("pushes an edit made with no vault event at all", async () => {
    const vault = await newVault("settings-poll");
    const a = await newClient(vault.id, "device-a", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
    const b = await newClient(vault.id, "device-b", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });

    a.write(".obsidian/app.json", '{"theme":"moonstone"}');
    await a.sync();

    // Obsidian rewrites a settings file through its data adapter: no event, so
    // the host's settings pass is the only thing that can see the change.
    a.write(".obsidian/app.json", '{"theme":"obsidian"}');
    a.write(".obsidian/hotkeys.json", '{"new-note":[]}');
    await a.syncSettings();

    await b.sync();
    expect(b.read(".obsidian/app.json")).toBe('{"theme":"obsidian"}');
    expect(b.read(".obsidian/hotkeys.json")).toBe('{"new-note":[]}');
  });

  it("propagates a deleted settings file as a deletion", async () => {
    const vault = await newVault("settings-delete");
    const a = await newClient(vault.id, "device-a", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
    const b = await newClient(vault.id, "device-b", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });

    a.write(".obsidian/app.json", "{}");
    await a.sync();
    await b.sync();
    expect(b.read(".obsidian/app.json")).toBe("{}");

    a.remove(".obsidian/app.json");
    await a.syncSettings();

    await b.sync();
    expect(b.read(".obsidian/app.json")).toBeNull();
    // The deletion is on the chain, not a local-only absence on B.
    const chain = (await vaultHistory(server, vault.id)).find((file) =>
      file.versions.some((version) => version.action === "delete"),
    );
    expect(chain?.versions.at(-1)?.action).toBe("delete");
  });

  it("leaves a peer's settings chain completely alone when settings sync is off", async () => {
    const vault = await newVault("settings-ignored");
    const on = await newClient(vault.id, "settings-on", {
      settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
    });
    const off = await newClient(vault.id, "settings-off");

    on.write(".obsidian/app.json", '{"theme":"moonstone"}');
    on.write("note.md", "# note");
    await on.sync();
    const chainsBefore = await chainCount(server, vault.id);

    // The narrow device sees the note and nothing else — no pull, no conflict
    // file, and no repeated work on a second pass.
    await off.sync();
    await off.sync();

    expect(off.read("note.md")).toBe("# note");
    expect(off.read(".obsidian/app.json")).toBeNull();
    expect(await off.conflictFiles()).toEqual([]);
    expect(await chainCount(server, vault.id)).toBe(chainsBefore);
  });

  it("resumes a settings chain when the switch is turned on later", async () => {
    const vault = await newVault("settings-late-enable");
    const on = await newClient(vault.id, "settings-on", {
      settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
    });
    const late = await newClient(vault.id, "settings-late");

    on.write(".obsidian/app.json", '{"theme":"moonstone"}');
    await on.sync();
    // Bound while settings sync was off: the file is not on this device, and the
    // chain must survive that untouched.
    await late.sync();
    expect(late.read(".obsidian/app.json")).toBeNull();

    // The host restarts with the group on: the bind pass applies the peer's file.
    const lateWithSettings = await newClient(vault.id, "settings-late", {
      settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
      dir: late.dir,
    });
    lateWithSettings.engine.loadState(late.state.json ?? "{}");
    await lateWithSettings.bind();

    expect(lateWithSettings.read(".obsidian/app.json")).toBe('{"theme":"moonstone"}');
  });

  /**
   * The point of the per-group switches: a device can take one category and leave
   * the rest, in both directions — what it does not want never leaves it, and what
   * it does not want never arrives.
   */
  it("carries only the groups a device switched on, in both directions", async () => {
    const vault = await newVault("settings-groups");
    // A: appearance + hotkeys. B: the app settings only.
    const a = await newClient(vault.id, "device-a", {
      settingsGroups: { appearance: true, hotkeys: true },
    });
    const b = await newClient(vault.id, "device-b", { settingsGroups: { app: true } });

    a.write(".obsidian/app.json", '{"attachmentFolderPath":"files"}');
    a.write(".obsidian/appearance.json", '{"theme":"moonstone"}');
    a.write(".obsidian/hotkeys.json", '{"new-note":[]}');
    await a.sync();

    // Outbound: only the groups A has on left the device.
    expect(await filesAtPath(server, vault.id, material.key, ".obsidian/app.json")).toEqual([]);
    expect(
      await filesAtPath(server, vault.id, material.key, ".obsidian/appearance.json"),
    ).toHaveLength(1);
    expect(
      await filesAtPath(server, vault.id, material.key, ".obsidian/hotkeys.json"),
    ).toHaveLength(1);

    // Inbound: what B does not sync never arrives, and does not become a conflict.
    await b.sync();
    expect(b.read(".obsidian/appearance.json")).toBeNull();
    expect(b.read(".obsidian/hotkeys.json")).toBeNull();
    expect(await b.conflictFiles()).toEqual([]);

    // B's own group still travels: it pushes its app settings…
    b.write(".obsidian/app.json", '{"newFileLocation":"folder"}');
    await b.sync();
    expect(await filesAtPath(server, vault.id, material.key, ".obsidian/app.json")).toHaveLength(1);

    // …and a third device that turned appearance on receives that one category
    // while ignoring the app settings it does not sync.
    const c = await newClient(vault.id, "device-c", { settingsGroups: { appearance: true } });
    await c.sync();
    expect(c.read(".obsidian/appearance.json")).toBe('{"theme":"moonstone"}');
    expect(c.read(".obsidian/app.json")).toBeNull();
    expect(c.read(".obsidian/hotkeys.json")).toBeNull();
  });

  /**
   * The option list itself, not only the rule behind it.
   *
   * The cases above pick a category to tell a story; this one walks **every** switch the
   * settings page shows, so a group that no end-to-end case ever used (which is how
   * `core-plugins.json` and the `corePluginSettings` catch-all stayed untested) cannot
   * hide behind the ones that are covered.
   */
  it("lists a representative path for every config-folder group the engine defines", () => {
    expect(Object.keys(GROUP_FILES).toSorted()).toEqual([...SETTINGS_GROUPS].toSorted());
  });

  /**
   * Every group, in both states, through the whole stack.
   *
   * For each switch: the device that has it on is what puts the file on the server, a
   * device with every group off takes nothing — no file, no conflict copy, no chain, and
   * no "a setting arrived" report, because it never applied one — and a third device with
   * exactly that group on receives the exact content and is told about each file.
   *
   * The reload a host asks for is driven by `onSettingsApplied`, so the note beside the
   * settings files is what keeps this honest: a note is not a setting, and a report for it
   * would prompt the user to reload for an ordinary file.
   */
  it.each([...SETTINGS_GROUPS])(
    "carries the %s group to a device that has it on, and nothing to one that has it off",
    async (group) => {
      const vault = await newVault(`settings-matrix-${group}`);
      const files = GROUP_FILES[group];
      const paths = files.map((file) => file.path);
      // The table above is worth something only if the engine agrees on the owner.
      const scope = normalizeScope({ configDir: ".obsidian", settingsGroups: onlyGroups(group) });
      for (const path of paths) expect(settingsGroupOf(path, scope)).toBe(group);

      const a = await newClient(vault.id, "device-a", { settingsGroups: onlyGroups(group) });
      for (const file of files) a.write(file.path, file.content);
      a.write("note.md", `# ${group}`);
      await a.sync();

      // Outbound: one chain per file of the group, at the path it left from.
      for (const path of paths) {
        expect(await filesAtPath(server, vault.id, material.key, path), path).toHaveLength(1);
      }
      const chainsAfterA = await chainCount(server, vault.id);
      expect(chainsAfterA).toBe(paths.length + 1); // the group's files plus the note

      // The device that wants nothing takes nothing — no pull, no conflict copy, and no
      // chain of its own for a path it does not sync — while the note still travels.
      const offApplied: SettingsAppliedEvent[] = [];
      const off = await newClient(vault.id, "device-off", {
        onSettingsApplied: (event) => offApplied.push(event),
      });
      await off.sync();
      await off.sync();
      for (const path of paths) {
        expect(off.read(path), path).toBeNull();
        expect(off.engine.fileIdForPath(path), path).toBeNull();
      }
      expect(off.read("note.md")).toBe(`# ${group}`);
      expect(await off.conflictFiles()).toEqual([]);
      expect(offApplied).toEqual([]);
      expect(await chainCount(server, vault.id)).toBe(chainsAfterA);

      // The device with exactly this group on gets every file with its content, and hears
      // about each configuration file — the reports a host turns into one reload prompt.
      const applied: SettingsAppliedEvent[] = [];
      const on = await newClient(vault.id, "device-on", {
        settingsGroups: onlyGroups(group),
        onSettingsApplied: (event) => applied.push(event),
      });
      await on.sync();
      for (const file of files) expect(on.read(file.path), file.path).toBe(file.content);
      expect(on.read("note.md")).toBe(`# ${group}`);
      expect(applied.map((event) => `${event.plainPath} ${event.action}`).toSorted()).toEqual(
        paths.map((path) => `${path} write`).toSorted(),
      );
    },
  );

  it("carries the config folder's non-standard files only with otherFiles on", async () => {
    const vault = await newVault("settings-other-files");
    const settingsOnly = await newClient(vault.id, "settings-only", {
      settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
    });
    const withOtherFiles = await newClient(vault.id, "with-other-files", {
      settingsGroups: { ...OBSIDIAN_DEFAULT_GROUPS, otherFiles: true },
    });

    withOtherFiles.write(".obsidian/my-tool/state.json", '{"x":1}');
    withOtherFiles.write(".obsidian/icons/star.svg", "<svg/>");
    withOtherFiles.write(".obsidian/app.json", "{}");
    await withOtherFiles.sync();

    await settingsOnly.sync();
    expect(settingsOnly.read(".obsidian/my-tool/state.json")).toBeNull();
    expect(settingsOnly.read(".obsidian/app.json")).toBe("{}");

    const peer = await newClient(vault.id, "other-files-peer", {
      settingsGroups: { ...OBSIDIAN_DEFAULT_GROUPS, otherFiles: true },
    });
    await peer.sync();
    expect(peer.read(".obsidian/my-tool/state.json")).toBe('{"x":1}');
    expect(peer.read(".obsidian/icons/star.svg")).toBe("<svg/>");
    // `otherFiles` owns unclaimed paths only: app.json still belongs to its group.
    expect(peer.read(".obsidian/app.json")).toBe("{}");
  });

  it("never syncs this plugin's own config, whatever the switches say", async () => {
    const vault = await newVault("settings-courier-excluded");
    const a = await newClient(vault.id, "device-a", { settingsGroups: ALL_GROUPS });

    a.write(".obsidian/plugins/courier/data.json", '{"deviceName":"leak","userKey":"ck_leak"}');
    a.write(".obsidian/workspace.json", '{"main":{}}');
    a.write(".obsidian/cache/hashes.json", "{}");
    a.write(".obsidian/app.json", "{}");
    await a.sync();

    // Only app.json produced a chain.
    expect(await vaultHistory(server, vault.id)).toHaveLength(1);

    const b = await newClient(vault.id, "device-b", { settingsGroups: ALL_GROUPS });
    await b.sync();
    expect(b.read(".obsidian/plugins/courier/data.json")).toBeNull();
    expect(b.read(".obsidian/workspace.json")).toBeNull();
    expect(b.read(".obsidian/app.json")).toBe("{}");
  });

  /**
   * Obsidian's two community-plugin switches are two groups here: the enabled
   * state list (`communityPlugins.json`) and the installed plugin bodies
   * (`plugins/<id>/**`). Neither implies the other.
   */
  it("carries the enabled-plugin list and the installed plugin files as separate options", async () => {
    const vault = await newVault("settings-plugins");
    const settingsOnly = await newClient(vault.id, "settings-only", {
      settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
    });
    const withPlugins = await newClient(vault.id, "with-plugins", { settingsGroups: ALL_GROUPS });
    const listOnly = await newClient(vault.id, "list-only", {
      settingsGroups: { ...OBSIDIAN_DEFAULT_GROUPS, communityPluginList: true },
    });
    const filesOnly = await newClient(vault.id, "files-only", {
      settingsGroups: { ...OBSIDIAN_DEFAULT_GROUPS, communityPlugins: true },
    });

    withPlugins.write(".obsidian/plugins/dataview/main.js", "module.exports = {};");
    withPlugins.write(".obsidian/plugins/dataview/data.json", '{"enabled":true}');
    withPlugins.write(".obsidian/community-plugins.json", '["dataview"]');
    await withPlugins.sync();

    // A device with neither group takes neither.
    await settingsOnly.sync();
    expect(settingsOnly.read(".obsidian/plugins/dataview/main.js")).toBeNull();
    expect(settingsOnly.read(".obsidian/community-plugins.json")).toBeNull();

    // "Enabled plugin list" alone: the state list arrives, the plugin body does not.
    await listOnly.sync();
    expect(listOnly.read(".obsidian/community-plugins.json")).toBe('["dataview"]');
    expect(listOnly.read(".obsidian/plugins/dataview/main.js")).toBeNull();
    expect(listOnly.read(".obsidian/plugins/dataview/data.json")).toBeNull();

    // "Installed community plugins" alone: the plugin body arrives, the list does not.
    await filesOnly.sync();
    expect(filesOnly.read(".obsidian/plugins/dataview/main.js")).toBe("module.exports = {};");
    expect(filesOnly.read(".obsidian/plugins/dataview/data.json")).toBe('{"enabled":true}');
    expect(filesOnly.read(".obsidian/community-plugins.json")).toBeNull();

    // A device with both gets both.
    const peer = await newClient(vault.id, "plugins-peer", { settingsGroups: ALL_GROUPS });
    await peer.sync();
    expect(peer.read(".obsidian/plugins/dataview/main.js")).toBe("module.exports = {};");
    expect(peer.read(".obsidian/community-plugins.json")).toBe('["dataview"]');
  });

  /**
   * The scope predicate is the engine's, and the adapters only prune their walk
   * with it. These are the shapes that must never travel, asserted on the rule
   * the two hosts share.
   */
  it("keeps the device-local config files out of the scope's own rule", () => {
    const scope: SyncScope = normalizeScope({
      configDir: ".obsidian",
      settingsGroups: ALL_GROUPS,
    });
    for (const path of [
      ".obsidian/workspace.json",
      ".obsidian/workspaces.json",
      ".obsidian/workspace-mobile.json",
      ".obsidian/plugins/courier/data.json",
      ".obsidian/cache/hashes.json",
      ".obsidian/app-2026-02-14-101530.conflict.md",
    ]) {
      expect(isSyncablePath(path, scope)).toBe(false);
    }
  });

  /**
   * A conflict inside `.obsidian/` is settled by **last modification time**, not by a
   * parked copy: the config folder is outside Obsidian's file index, so a copy written
   * there is something the user cannot see or act on. The losing side is overwritten,
   * the winning side is pushed, and neither device parks a file.
   *
   * The offline case is the one that tells this apart from "whoever pushed last wins":
   * the later edit wins even when the other device reconnects (and pushes) first, which
   * is exactly the ordering a server receive time gets wrong.
   */
  describe("a config-folder conflict resolves by modification time", () => {
    it("keeps the later edit when both devices edited offline", async () => {
      const vault = await newVault("settings-conflict-lww");
      const a = await newClient(vault.id, "device-a", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
      const b = await newClient(vault.id, "device-b", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
      const path = ".obsidian/app.json";

      a.write(path, '{"theme":"moonstone"}');
      a.setMtime(path, 1_000);
      await a.sync();
      await b.sync();
      expect(b.read(path)).toBe('{"theme":"moonstone"}');

      // Both edits happen while neither client can reach the server. A's reconnect is
      // first, so its push reaches the chain first — but B's edit is the later one.
      a.goOffline();
      b.goOffline();
      a.write(path, '{"theme":"a-pushed-first"}');
      a.setMtime(path, 2_000);
      b.write(path, '{"theme":"b-edited-later"}');
      b.setMtime(path, 3_000);

      a.goOnline();
      await a.sync();
      b.goOnline();
      await b.sync();
      await a.sync();

      expect(a.read(path)).toBe('{"theme":"b-edited-later"}');
      expect(b.read(path)).toBe('{"theme":"b-edited-later"}');
      expect(await a.conflictFiles()).toEqual([]);
      expect(await b.conflictFiles()).toEqual([]);
    });

    it("takes the peer's later edit and reports it as applied, with no copy", async () => {
      const vault = await newVault("settings-conflict-remote-newer");
      const applied: SettingsAppliedEvent[] = [];
      const a = await newClient(vault.id, "device-a", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
      const b = await newClient(vault.id, "device-b", {
        settingsGroups: OBSIDIAN_DEFAULT_GROUPS,
        onSettingsApplied: (event) => applied.push(event),
      });
      const path = ".obsidian/app.json";

      a.write(path, '{"theme":"moonstone"}');
      a.setMtime(path, 1_000);
      await a.sync();
      await b.sync();

      a.write(path, '{"theme":"peer-newer"}');
      a.setMtime(path, 3_000);
      await a.sync();
      b.write(path, '{"theme":"local-older"}');
      b.setMtime(path, 2_000);
      await b.sync();

      expect(b.read(path)).toBe('{"theme":"peer-newer"}');
      expect(await b.conflictFiles()).toEqual([]);
      // The app had already read the old file, so applying the peer's copy is what the
      // host turns into its reload card.
      expect(applied).toContainEqual({ plainPath: path, action: "write", group: "app" });
    });

    it("brings the file back when the local edit is newer than the peer's deletion", async () => {
      const vault = await newVault("settings-conflict-restore");
      const a = await newClient(vault.id, "device-a", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
      const b = await newClient(vault.id, "device-b", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
      const path = ".obsidian/snippets/wide.css";

      a.write(path, ".wide {}");
      a.setMtime(path, 1_000);
      await a.sync();
      await b.sync();

      // The deletion is pushed "now"; B's edit is stamped well past it.
      a.remove(path);
      await a.sync();
      b.write(path, ".wide { color: red; }");
      b.setMtime(path, Date.now() + 60_000);
      await b.sync();

      expect(b.read(path)).toBe(".wide { color: red; }");
      expect(await b.conflictFiles()).toEqual([]);
      // A live version after a tombstone is a restore on the same chain.
      const chains = await vaultHistory(server, vault.id);
      expect(chains).toHaveLength(1);
      expect(chains[0]!.versions.map((version) => version.action)).toEqual([
        "create",
        "delete",
        "restore",
      ]);
    });

    it("applies a deletion that is newer than the local copy", async () => {
      const vault = await newVault("settings-conflict-delete");
      const a = await newClient(vault.id, "device-a", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
      const b = await newClient(vault.id, "device-b", { settingsGroups: OBSIDIAN_DEFAULT_GROUPS });
      const path = ".obsidian/snippets/wide.css";

      a.write(path, ".wide {}");
      a.setMtime(path, 1_000);
      await a.sync();
      await b.sync();

      a.remove(path);
      await a.sync();
      b.write(path, ".wide { color: red; }");
      b.setMtime(path, 1_000);
      await b.sync();

      expect(b.read(path)).toBeNull();
      expect(await b.conflictFiles()).toEqual([]);
    });
  });
});
