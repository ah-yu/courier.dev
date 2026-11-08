import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bytesToBase64, deriveEncryptionKey, DEFAULT_MAX_FILE_BYTES } from "../../engine/src/index";
import { runDaemon, runOnceSync, type RunnerHandle } from "../../cli/src/runner";
import { setLocale } from "../../cli/src/i18n";
import type { CliConfig } from "../../cli/src/config";
import { conflictCopyOf } from "./harness/conflict";
import { createTestClient, type TestClient } from "./harness/client";
import { startTestServer, setUserMaxFileBytes, type TestServer } from "./harness/server";
import { createTestVault, makeVaultMaterial, type VaultMaterial } from "./harness/vault";
import { filesAtPath, vaultHistory } from "./harness/api";
import { waitFor, waitForAsync } from "./harness/wait";

/**
 * The headless daemon against a real server: `courier-cli run` watching a folder,
 * holding a websocket, and reconciling on an interval.
 *
 * The interval is disabled in the scenario below on purpose — it is the only way
 * to assert that a **reconnect** is what carries the change, rather than the
 * timer, which would be 30 minutes away.
 */
/**
 * Write `content` to `name` the way an editor does: a temporary file in the same
 * directory, renamed over the target.
 *
 * A plain write truncates the file first, so a watcher that reads in that window
 * sees an empty file — which is a real event here: the daemon under test watches
 * the very directory this test writes to, and a truncated read parked an empty
 * conflict copy (this case was flaky under load).
 */
function writeAtomically(dir: string, name: string, content: string): void {
  const target = join(dir, name);
  const temporary = join(dir, `.${name}.tmp`);
  writeFileSync(temporary, content);
  renameSync(temporary, target);
}

describe("cli daemon e2e — the headless host over a real server", () => {
  let server: TestServer;
  let material: VaultMaterial;
  /** The base64 raw AES key a `vault connect` would have persisted. */
  let keyB64: string;
  let configDir: string;
  let daemon: RunnerHandle | null = null;
  const peers: TestClient[] = [];
  const tempDirs: string[] = [];

  beforeAll(async () => {
    // This suite calls `runDaemon` directly, so it is the one that chooses the
    // language: the assertions below read English log lines. Production resolves
    // the language in `main.ts` from the OS.
    setLocale("en");
    server = await startTestServer("cli daemon e2e user");
    material = await makeVaultMaterial();
    const key = await deriveEncryptionKey(material.password, material.salt, true);
    keyB64 = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey("raw", key)));
    // The CLI reads its state file from here; keep it out of the developer's home.
    configDir = mkdtempSync(join(tmpdir(), "courier-cli-config-"));
    process.env.COURIER_CLI_CONFIG_DIR = configDir;
  }, 120_000);

  afterEach(() => {
    daemon?.stop();
    daemon = null;
    for (const peer of peers) peer.cleanup();
    peers.length = 0;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    // State and runtime are per vault; a second scenario must start clean.
    rmSync(join(configDir, "state"), { recursive: true, force: true });
    rmSync(join(configDir, "runtime"), { recursive: true, force: true });
  });

  /** A config with one binding, and that binding — one process syncs one vault. */
  function target(vaultId: string, vaultPath: string, serverUrl = server.serverUrl) {
    const vault = { vaultId, vaultPath, encryptionKeyB64: keyB64 };
    return {
      vault,
      config: {
        serverUrl,
        userKey: server.userKey,
        deviceName: "headless",
        vaults: [vault],
      } satisfies CliConfig,
    };
  }

  afterAll(async () => {
    await server.close();
    delete process.env.COURIER_CLI_CONFIG_DIR;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("starts the loop anyway when its startup pass cannot reach the server", async () => {
    const remote = await createTestVault(server, "cli-startup-failure", material);
    const vaultPath = mkdtempSync(join(tmpdir(), "courier-cli-vault-"));
    tempDirs.push(vaultPath);

    const logs: string[] = [];
    // Nothing listens there: what a machine that boots before its network looks like.
    const { vault, config } = target(remote.id, vaultPath, "http://127.0.0.1:1");
    daemon = await runDaemon(config, vault, {
      intervalMinutes: 0,
      onLog: (message) => logs.push(message),
    });

    // This used to reject: the startup pass was awaited before the watcher, the socket and
    // the interval existed, so systemd restarted the daemon into the same failure — and the
    // log line that exists for this state was never reached.
    expect(logs.some((message) => message.includes("retrying shortly"))).toBe(true);
    expect(daemon.engine).toBeTruthy();

    // The loop is really up: a local change is noticed and pushed (which fails here, because
    // the server is still away — the point is that the watcher drives it at all). The line
    // comes from the shared host's queue and names the file (`push n.md failed: …`).
    writeFileSync(join(vaultPath, "n.md"), "written while the server was away");
    await waitFor(
      () => logs.some((message) => message.includes("n.md") && message.includes("failed")),
      "the daemon never picked the local change up",
    );
  });

  it("reconciles on a reconnect, bringing in what a peer pushed while it was down", async () => {
    const remote = await createTestVault(server, "cli-reconnect", material);
    const vaultPath = mkdtempSync(join(tmpdir(), "courier-cli-vault-"));
    tempDirs.push(vaultPath);

    const logs: string[] = [];
    const { vault, config } = target(remote.id, vaultPath);
    daemon = await runDaemon(config, vault, {
      intervalMinutes: 0,
      onLog: (message) => logs.push(message),
    });
    await waitFor(
      () => logs.some((message) => message.startsWith("Connected to server")),
      "the daemon never subscribed to the vault",
    );

    const peer = await createTestClient({
      server,
      vaultId: remote.id,
      key: material.key,
      deviceName: "peer",
    });
    peers.push(peer);

    // The socket goes away, the peer pushes in the gap, and the socket comes back.
    // The server keeps no backlog for a subscriber, so that notification is gone:
    // only the reconcile the reconnect runs can bring the note to the daemon.
    server.dropSockets();
    peer.write("while-down.md", "pushed while the daemon was disconnected");
    await peer.sync();
    await peer.change("while-down.md");

    // The socket reconnects on an exponential backoff (1s, then 2s, 4s…), so this
    // waits on the daemon's own retry schedule rather than on a fixed window: a
    // loaded machine can spend a few attempts getting the connection back.
    await waitFor(
      () => existsSync(join(vaultPath, "while-down.md")),
      "the daemon never reconciled after its socket came back",
      30_000,
    );
    expect(readFileSync(join(vaultPath, "while-down.md"), "utf-8")).toBe(
      "pushed while the daemon was disconnected",
    );
  });

  /**
   * The daemon's conflict behaviour, over the real filesystem watcher and the real
   * `FsAdapter`: a conflict is settled by taking the remote version, and the
   * content that lost is parked next to the note. There is no flag and no prompt —
   * `journalctl` and the conflict file are the whole trail.
   */
  it("takes the remote version on a conflict and parks this machine's copy", async () => {
    const remote = await createTestVault(server, "cli-conflict", material);
    const vaultPath = mkdtempSync(join(tmpdir(), "courier-cli-vault-"));
    tempDirs.push(vaultPath);

    const logs: string[] = [];
    const { vault, config } = target(remote.id, vaultPath);
    daemon = await runDaemon(config, vault, {
      intervalMinutes: 0,
      onLog: (message) => logs.push(message),
    });
    await waitFor(
      () => logs.some((message) => message.startsWith("Connected to server")),
      "the daemon never subscribed to the vault",
    );

    const peer = await createTestClient({
      server,
      vaultId: remote.id,
      key: material.key,
      deviceName: "peer",
    });
    peers.push(peer);
    peer.write("shared.md", "base");
    await peer.sync();
    await peer.change("shared.md");
    await waitFor(
      () => existsSync(join(vaultPath, "shared.md")),
      "the daemon never pulled the base note",
    );

    // The socket goes away and the peer pushes behind the daemon's back, so the
    // only thing that can see the conflict is the daemon's own filesystem watcher
    // when the AI agent (or another editor) writes the note.
    server.dropSockets();
    peer.write("shared.md", "edited on the peer");
    await peer.change("shared.md");
    // Written the way an editor writes: to a temporary file, then renamed over the
    // note. A plain `writeFileSync` truncates first, and the daemon's watcher can
    // read the file in that window — which parked an *empty* conflict copy and made
    // this case flaky under load. An atomic write has no such window: whichever
    // moment the daemon reads, it reads one of the two complete versions.
    writeAtomically(vaultPath, "shared.md", "written on the headless machine");

    const readIfPresent = (path: string): string | null => {
      try {
        return readFileSync(join(vaultPath, path), "utf-8");
      } catch {
        return null;
      }
    };
    // The copy is named after the second it was parked at, so it is found in the vault
    // rather than rebuilt from the test's clock (see `conflictCopyOf`).
    const parkedCopy = (): string | null => conflictCopyOf(readdirSync(vaultPath), "shared.md");
    // Both halves land in sequence — the local copy is parked first, then the remote
    // version is written — and the daemon's conflict log line trails the file by a tick.
    // Waiting for all three is the state a resolved conflict ends in; asserting the log
    // immediately after the files made this case flaky under full-suite load.
    await waitFor(
      () => {
        const copy = parkedCopy();
        return (
          copy !== null &&
          readIfPresent(copy) !== null &&
          readIfPresent("shared.md") === "edited on the peer" &&
          logs.join("\n").includes(copy)
        );
      },
      "the daemon never resolved the conflict",
      30_000,
    );

    const conflictPath = parkedCopy()!;
    expect(readIfPresent(conflictPath)).toBe("written on the headless machine");
    expect(logs.join("\n")).toContain(conflictPath);

    // The losing side pushed nothing: one chain, still ending at the peer's edit.
    const history = await vaultHistory(server, remote.id);
    expect(history).toHaveLength(1);
    expect(history[0].versions.map((v) => v.action)).toEqual(["create", "modify"]);
  });

  /**
   * `run --once` and the daemon's startup pass both go through `runOnceSync`, and
   * that pass **binds** the vault: a file the server no longer has a live version of
   * belongs to the user, so it is pushed as a new file rather than deleted by the
   * connection.
   */
  it("runs two vaults as two independent processes", async () => {
    const firstRemote = await createTestVault(server, "cli-multi-one", material);
    const secondRemote = await createTestVault(server, "cli-multi-two", material);
    const firstPath = mkdtempSync(join(tmpdir(), "courier-cli-vault-"));
    const secondPath = mkdtempSync(join(tmpdir(), "courier-cli-vault-"));
    tempDirs.push(firstPath, secondPath);

    const first = target(firstRemote.id, firstPath);
    const second = target(secondRemote.id, secondPath);
    // One config can carry both bindings; each process still receives exactly one.
    const shared: CliConfig = { ...first.config, vaults: [first.vault, second.vault] };
    const firstLogs: string[] = [];
    const secondLogs: string[] = [];
    const firstDaemon = await runDaemon(shared, first.vault, {
      intervalMinutes: 0,
      onLog: (message) => firstLogs.push(message),
    });
    const secondDaemon = await runDaemon(shared, second.vault, {
      intervalMinutes: 0,
      onLog: (message) => secondLogs.push(message),
    });
    try {
      const firstPeer = await createTestClient({
        server,
        vaultId: firstRemote.id,
        key: material.key,
        deviceName: "peer-one",
      });
      const secondPeer = await createTestClient({
        server,
        vaultId: secondRemote.id,
        key: material.key,
        deviceName: "peer-two",
      });
      peers.push(firstPeer, secondPeer);

      firstPeer.write("one.md", "first vault");
      await firstPeer.sync();
      await firstPeer.change("one.md");
      secondPeer.write("two.md", "second vault");
      await secondPeer.sync();
      await secondPeer.change("two.md");

      await waitFor(
        () => existsSync(join(firstPath, "one.md")) && !existsSync(join(firstPath, "two.md")),
        "the first process never synced its own vault only",
      );
      await waitFor(
        () => existsSync(join(secondPath, "two.md")) && !existsSync(join(secondPath, "one.md")),
        "the second process never synced its own vault only",
      );

      // Stopping one process leaves the other running: that is the point of one
      // process per vault.
      firstDaemon.stop();
      secondPeer.write("after-stop.md", "still syncing");
      await secondPeer.sync();
      await secondPeer.change("after-stop.md");
      await waitFor(
        () => existsSync(join(secondPath, "after-stop.md")),
        "stopping the first process stopped the second",
      );
      expect(existsSync(join(firstPath, "after-stop.md"))).toBe(false);
    } finally {
      firstDaemon.stop();
      secondDaemon.stop();
    }
  });

  it("refuses a second process on the same vault and leaves the first running", async () => {
    const remote = await createTestVault(server, "cli-lease", material);
    const vaultPath = mkdtempSync(join(tmpdir(), "courier-cli-vault-"));
    tempDirs.push(vaultPath);
    const { vault, config } = target(remote.id, vaultPath);

    const firstLogs: string[] = [];
    const first = await runDaemon(config, vault, {
      intervalMinutes: 0,
      onLog: (message) => firstLogs.push(message),
    });
    try {
      await waitFor(
        () => firstLogs.some((message) => message.startsWith("Connected to server")),
        "the first process never subscribed",
      );

      const secondLogs: string[] = [];
      const second = await runDaemon(config, vault, {
        intervalMinutes: 0,
        onLog: (message) => secondLogs.push(message),
      });
      try {
        expect(second.engine).toBeNull();
        expect(secondLogs.some((message) => message.includes("lease"))).toBe(true);
        // The first writer is untouched by the contender.
        expect(first.engine).toBeTruthy();

        // Releasing the lease wakes the waiter through the directory watch (or the
        // half-second fallback); it must take over without a restart.
        await first.stop();
        await waitFor(
          () => second.engine !== null,
          "the second process never took over the released lease",
          5_000,
        );
      } finally {
        await second.stop();
      }
    } finally {
      await first.stop();
    }
  });

  it("takes the vault from a running process with takeOver, and the displaced writer stops", async () => {
    const remote = await createTestVault(server, "cli-take-over", material);
    const vaultPath = mkdtempSync(join(tmpdir(), "courier-cli-vault-"));
    tempDirs.push(vaultPath);
    const { vault, config } = target(remote.id, vaultPath);

    const firstLogs: string[] = [];
    const first = await runDaemon(config, vault, {
      intervalMinutes: 0,
      onLog: (message) => firstLogs.push(message),
    });
    try {
      await waitFor(
        () => firstLogs.some((message) => message.startsWith("Connected to server")),
        "the first process never subscribed",
      );
      expect(first.engine).toBeTruthy();

      const secondLogs: string[] = [];
      const second = await runDaemon(config, vault, {
        intervalMinutes: 0,
        takeOver: true,
        onLog: (message) => secondLogs.push(message),
      });
      try {
        // The one process that asked for it ends up syncing, and says whose process it
        // displaced — the only evidence left after the record is replaced.
        expect(second.engine).toBeTruthy();
        expect(secondLogs.some((message) => message.includes("--take-over"))).toBe(true);

        // The displaced writer leaves the vault on the directory event, not at its next
        // five-second renewal: this assertion is the accelerator's reason to exist.
        await waitFor(
          () => first.engine === null,
          "the displaced process kept its engine after the takeover",
          2_000,
        );
        expect(firstLogs.some((message) => message.includes("lease"))).toBe(true);

        // And the survivor is a normal writer: what it writes reaches the **server**, not
        // just the local folder (waiting for a file this test wrote itself proves nothing).
        writeAtomically(vaultPath, "after-take-over.md", "# after");
        await waitForAsync(
          async () =>
            (await filesAtPath(server, remote.id, material.key, "after-take-over.md")).length > 0,
          "the survivor's file never reached the server",
          15_000,
        );
      } finally {
        await second.stop();
      }
    } finally {
      await first.stop();
    }
  });

  it("lets run --once take the vault with takeOver instead of refusing with syncLocked", async () => {
    const remote = await createTestVault(server, "cli-once-take-over", material);
    const vaultPath = mkdtempSync(join(tmpdir(), "courier-cli-vault-"));
    tempDirs.push(vaultPath);
    const { vault, config } = target(remote.id, vaultPath);

    const holderLogs: string[] = [];
    const holder = await runDaemon(config, vault, {
      intervalMinutes: 0,
      onLog: (message) => holderLogs.push(message),
    });
    try {
      await waitFor(
        () => holderLogs.some((message) => message.startsWith("Connected to server")),
        "the holding process never subscribed",
      );

      // Without the flag the one-shot pass refuses, exactly as before this change.
      await expect(runOnceSync(config, vault, { onLog: () => {} })).rejects.toThrow(
        /another syncer|sync lock|lease|leaseFailed/i,
      );

      // With it, the same call takes the vault, runs its pass, and releases again.
      const logs: string[] = [];
      writeAtomically(vaultPath, "once.md", "written by --once --take-over");
      await runOnceSync(config, vault, {
        takeOver: true,
        // A record short enough to expire inside a real pass. The renewal that keeps it
        // fresh is pinned where it is testable — `keepLeaseFresh`'s own cases — because
        // the pass here is far shorter than any TTL worth asserting on from the outside.
        leaseTtlMs: 400,
        onLog: (message) => logs.push(message),
      });
      expect(logs.some((message) => message.includes("--take-over"))).toBe(true);
      await waitForAsync(
        async () => (await filesAtPath(server, remote.id, material.key, "once.md")).length > 0,
        "the one-shot pass never pushed its file",
        15_000,
      );
      // It released the vault on the way out: the displaced holder takes it back.
      await waitFor(
        () => holder.engine !== null,
        "the holder never got the released lease back",
        10_000,
      );
    } finally {
      await holder.stop();
    }
  });

  it("keeps a local file the remote already deleted when the CLI binds the vault", async () => {
    const remote = await createTestVault(server, "cli-first-bind", material);
    const vaultPath = mkdtempSync(join(tmpdir(), "courier-cli-vault-"));
    tempDirs.push(vaultPath);

    // The peer creates the note and deletes it again, so the chain ends in a
    // tombstone while this machine still has a copy on disk.
    const peer = await createTestClient({
      server,
      vaultId: remote.id,
      key: material.key,
      deviceName: "peer",
    });
    peers.push(peer);
    peer.write("gone.md", "first life");
    await peer.sync();
    await peer.change("gone.md");
    peer.remove("gone.md");
    await peer.removeAndSync("gone.md");

    writeFileSync(join(vaultPath, "gone.md"), "still here");

    const { vault, config } = target(remote.id, vaultPath);
    await runOnceSync(config, vault, { onLog: () => {} });

    // The note is still here, under its own new chain — the tombstone's chain keeps
    // its delete and stays in the recycle bin.
    expect(readFileSync(join(vaultPath, "gone.md"), "utf-8")).toBe("still here");
    const history = await vaultHistory(server, remote.id);
    expect(history).toHaveLength(2);
    expect(history.map((file) => file.versions.map((v) => v.action)).toSorted()).toEqual([
      ["create"],
      ["create", "delete"],
    ]);
  });

  /**
   * The file cap is the account's, not the machine's.
   *
   * This config carries no `accountMaxFileBytes` at all, which is exactly what a
   * hand-written or pre-cap config looks like: the only way the cap below can take
   * effect is the `GET /api/me` read `runOnceSync` does before it builds the engine.
   * The note is four bytes so it is inside the cap; the PNG is twelve, so a CLI that
   * fell back to its 50 MiB default would upload it and the case would fail.
   */
  it("reads the account's file cap from the server before it reads the vault", async () => {
    await setUserMaxFileBytes(server, 8);
    try {
      const remote = await createTestVault(server, "cli-account-cap", material);
      const vaultPath = mkdtempSync(join(tmpdir(), "courier-cli-cap-"));
      tempDirs.push(vaultPath);
      writeFileSync(join(vaultPath, "note.md"), "note");
      writeFileSync(
        join(vaultPath, "photo.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]),
      );

      const { vault, config } = target(remote.id, vaultPath);
      await runOnceSync(config, vault, { onLog: () => {} });

      expect(await filesAtPath(server, remote.id, material.key, "note.md")).toHaveLength(1);
      expect(await filesAtPath(server, remote.id, material.key, "photo.png")).toEqual([]);
    } finally {
      await setUserMaxFileBytes(server, DEFAULT_MAX_FILE_BYTES);
    }
  });
});
