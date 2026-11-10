import { realPlatform } from "@courier/testing";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SyncHost,
  normalizeScope,
  type SyncEventSource,
  type SyncStateStore,
} from "../../engine/src/index";
import { FsAdapter } from "../../cli/src/fs-adapter";
import { createCliSyncApi } from "../../cli/src/api";
import { startTestServer, type TestServer } from "./harness/server";
import { createTestVault, makeVaultMaterial, type VaultMaterial } from "./harness/vault";
import { waitFor } from "./harness/wait";

/**
 * A **bulk rename performed outside the engine** — a script, a folder move, an agent — reaches a host whose watcher cannot report moves: `fs.watch` (the CLI) and a
 * filesystem-level rename inside Obsidian both arrive as *this path is gone* plus *that
 * path appeared*. The engine's rule is that those two halves are one chain moved, never a
 * tombstone plus a second chain.
 *
 * This case drives that shape at the size the incident reached: hundreds of notes renamed
 * in one go, with the peer connected and the server watching. What it pins is the
 * identity: one chain per note, no tombstone for a note that still exists, the same bytes
 * on the peer, and no conflict copy on the writer.
 */

const NOTES = 200;

interface TestHost {
  host: SyncHost;
  dir: string;
  adapter: EchoingAdapter;
  api: ReturnType<typeof createCliSyncApi>;
  /** `sync/push` requests this host made: what batches a bulk move into a few requests. */
  pushes: () => number;
}

/** The CLI adapter plus the vault events a real file watcher would fire. */
class EchoingAdapter extends FsAdapter {
  handlers: Parameters<SyncEventSource["start"]>[0] | null = null;

  override async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    await super.writeFile(path, bytes);
    this.handlers?.changed(path, bytes.byteLength);
  }

  override async deleteFile(path: string): Promise<void> {
    await super.deleteFile(path);
    this.handlers?.removed(path);
  }

  override async renameFile(from: string, to: string): Promise<void> {
    await super.renameFile(from, to);
    this.handlers?.renamed(from, to, null);
  }
}

function countNotes(dir: string, prefix = ""): number {
  let total = 0;
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) total += countNotes(dir, rel);
    else if (entry.name.endsWith(".md")) total += 1;
  }
  return total;
}

/** Every conflict copy the vault holds, at any depth. */
function conflictCopies(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...conflictCopies(dir, rel));
    else if (entry.name.includes(".conflict.")) found.push(rel);
  }
  return found;
}

describe("a bulk rename through a real server", () => {
  let server: TestServer;
  let material: VaultMaterial;

  beforeAll(async () => {
    server = await startTestServer("bulk-rename e2e user");
    material = await makeVaultMaterial();
  }, 120_000);

  afterAll(async () => {
    await server.close();
  });

  async function startHost(vaultId: string, dir: string, label: string): Promise<TestHost> {
    const adapter = new EchoingAdapter(dir, normalizeScope({ configDir: ".obsidian" }));
    let state: string | null = null;
    let bindCompleted = false;
    const stateStore: SyncStateStore = {
      load: () => state,
      save: (json) => {
        state = json;
      },
      loadBindCompleted: () => bindCompleted,
      saveBindCompleted: () => {
        bindCompleted = true;
      },
    };
    const eventSource: SyncEventSource = {
      start(handlers) {
        adapter.handlers = handlers;
        return () => {
          adapter.handlers = null;
        };
      },
    };
    let pushes = 0;
    const api = createCliSyncApi({
      serverUrl: server.serverUrl,
      userKey: server.userKey,
      getDeviceName: () => label,
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/sync/push")) pushes += 1;
        return fetch(input as RequestInfo, init);
      }) as typeof fetch,
    });
    const host = new SyncHost({
      vaultId,
      encryptionKey: material.key,
      syncScope: normalizeScope({ configDir: ".obsidian" }),
      adapter,
      api,
      wsUrl: server.wsUrl,
      userKey: server.userKey,
      getDeviceName: () => label,
      eventSource,
      stateStore,
      platform: realPlatform,
      // A pass as the safety net every real host has: a notification this busy test server
      // drops must not leave a peer waiting for a reconcile that is five minutes away.
      reconcileIntervalMs: 1_000,
      settingsPollIntervalMs: 0,
      log: () => {},
    });
    await host.start();
    return { host, dir, adapter, api, pushes: () => pushes };
  }

  it("keeps one live chain per note when the move's two halves arrive in separate batches", async () => {
    const vault = await createTestVault(server, "bulk-rename-split", material);
    const mac = await startHost(vault.id, mkdtempSync(join(tmpdir(), "split-mac-")), "mac");
    const phone = await startHost(vault.id, mkdtempSync(join(tmpdir(), "split-phone-")), "phone");

    try {
      const events = mac.adapter.handlers!;
      const bodies = new Map<string, string>();
      for (let index = 0; index < NOTES; index += 1) {
        const path = `notes/a-${String(index).padStart(4, "0")}.md`;
        const body = `# note ${index}\n\nbody ${index}\n`;
        bodies.set(path, body);
        mkdirSync(join(mac.dir, dirname(path)), { recursive: true });
        writeFileSync(join(mac.dir, path), body);
        events.changed(path, Buffer.byteLength(body));
      }
      await waitFor(() => countNotes(phone.dir) === NOTES, `${NOTES} seeded notes`, 60_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();

      // A watcher that reports the two halves of a move as separate debounced batches:
      // every old path disappears first, the new ones are reported a window later. The
      // engine's rename-by-hash memory has to survive the gap, or the move forks.
      const renamed: Array<{ from: string; to: string }> = [];
      for (let index = 0; index < NOTES; index += 1) {
        const from = `notes/a-${String(index).padStart(4, "0")}.md`;
        const to = `notes/b-${String(index).padStart(4, "0")}.md`;
        renameSync(join(mac.dir, from), join(mac.dir, to));
        renamed.push({ from, to });
      }
      for (const { from } of renamed) events.removed(from);
      await mac.host.whenIdle();
      // Longer than the five-second window this fix replaced (the current one is a whole
      // reconcile interval): the gap a rate-limited burst or a slow watcher can produce
      // between the two halves of one move.
      await new Promise((resolve) => setTimeout(resolve, 6_000));
      for (const { to } of renamed) events.changed(to, null);
      await mac.host.whenIdle();

      const peerMoved = (): boolean => {
        // One listing per poll, not 400 `stat`s: the peer is writing the same directory
        // while this runs, and on a loaded CI runner the stat storm starved it.
        const names = readdirSync(join(phone.dir, "notes"));
        return (
          names.filter((name) => name.startsWith("b-")).length >= NOTES &&
          !names.some((name) => name.startsWith("a-"))
        );
      };
      await waitFor(peerMoved, `${NOTES} renamed notes on the peer`, 90_000);
      await phone.host.whenIdle();

      const index = await mac.api.getVaultSyncIndex(vault.id);
      expect(index.files.filter((file) => file.head.action === "delete")).toHaveLength(0);
      expect(index.files.length).toBe(NOTES);
      // The adopted renames travelled in batches: 200 notes must not cost 200 `sync/push`
      // requests (the deletes and the bind add a few more).
      expect(mac.pushes()).toBeLessThan(40);
    } finally {
      phone.host.stop();
      mac.host.stop();
    }
  }, 120_000);

  it("keeps one live chain per note when a watcher reports the move as delete+create", async () => {
    const vault = await createTestVault(server, "bulk-rename", material);
    const mac = await startHost(vault.id, mkdtempSync(join(tmpdir(), "rename-mac-")), "mac");
    const phone = await startHost(vault.id, mkdtempSync(join(tmpdir(), "rename-phone-")), "phone");

    try {
      const events = mac.adapter.handlers!;
      const bodies = new Map<string, string>();
      for (let index = 0; index < NOTES; index += 1) {
        const path = `notes/a-${String(index).padStart(4, "0")}.md`;
        const body = `# note ${index}\n\nbody ${index}\n`;
        bodies.set(path, body);
        mkdirSync(join(mac.dir, dirname(path)), { recursive: true });
        writeFileSync(join(mac.dir, path), body);
        events.changed(path, Buffer.byteLength(body));
      }
      await waitFor(() => countNotes(phone.dir) === NOTES, `${NOTES} seeded notes`, 60_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();

      // The move itself: every note renamed on disk, then the two halves a watcher that
      // cannot see a move reports — one batch for the whole vault, like a script's pass.
      const renamed: Array<{ from: string; to: string }> = [];
      for (let index = 0; index < NOTES; index += 1) {
        const from = `notes/a-${String(index).padStart(4, "0")}.md`;
        const to = `notes/b-${String(index).padStart(4, "0")}.md`;
        renameSync(join(mac.dir, from), join(mac.dir, to));
        renamed.push({ from, to });
      }
      for (const { from, to } of renamed) {
        events.removed(from);
        events.changed(to, Buffer.byteLength(bodies.get(from)!));
      }

      // The peer has to hold every note at its **new** path and none at the old ones: a
      // count alone would pass while a rename was still half applied.
      const peerMoved = (): boolean => {
        const names = readdirSync(join(phone.dir, "notes"));
        return (
          names.filter((name) => name.startsWith("b-")).length >= NOTES &&
          !names.some((name) => name.startsWith("a-"))
        );
      };
      await waitFor(peerMoved, `${NOTES} renamed notes on the peer`, 90_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();

      // The peer holds the bytes at the new paths and nothing at the old ones.
      for (let index = 0; index < NOTES; index += 1) {
        const from = `notes/a-${String(index).padStart(4, "0")}.md`;
        const to = `notes/b-${String(index).padStart(4, "0")}.md`;
        expect(() => readFileSync(join(phone.dir, from)), from).toThrow();
        expect(readFileSync(join(phone.dir, to), "utf-8"), to).toBe(bodies.get(from)!);
      }

      // One chain per note: a move re-points its chain, so the server must hold exactly
      // the notes it started with — no tombstone and no second chain for the new path.
      const index = await mac.api.getVaultSyncIndex(vault.id);
      const heads = index.files.map((file) => file.head.action);
      expect(heads.filter((action) => action === "delete")).toHaveLength(0);
      expect(index.files.length).toBe(NOTES);

      // No conflict copy: both halves of the move are the same file.
      expect(conflictCopies(mac.dir)).toEqual([]);
    } finally {
      phone.host.stop();
      mac.host.stop();
    }
  }, 120_000);
});
