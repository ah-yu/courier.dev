import { realPlatform } from "@courier/testing";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SyncHost,
  normalizeScope,
  type SyncActivityEvent,
  type SyncEventSource,
  type SyncStateStore,
} from "../../engine/src/index";
import { FsAdapter } from "../../cli/src/fs-adapter";
import { createCliSyncApi } from "../../cli/src/api";
import { startTestServer, type TestServer } from "./harness/server";
import { createTestVault, makeVaultMaterial, type VaultMaterial } from "./harness/vault";
import { waitFor } from "./harness/wait";

/**
 * A **bulk local write** — what an agent, a script, a sync-from-elsewhere tool or a folder
 * operation leaves in a vault — seen by the host the way a real file watcher sees it: one
 * event per file, arriving within a second of the next.
 *
 * This is the shape that used to meet the server's sync allowance: the host pushed each
 * event on its own, so 1 000 generated notes were 1 000 `POST /sync/push` requests, and a
 * deployed server (600 requests/minute per vault) refused the vault after about a minute.
 * The client then sat out limiter windows for the rest, and every file it could not push
 * waited for the five-minute periodic pass — the "it syncs a few hundred files and stops"
 * report this case exists for.
 *
 * The fix is the host's burst rule: more than `LOCAL_EVENT_BURST_SIZE` local events inside
 * one window are carried out by **one pass**, whose creates travel 100 files per request.
 * These assertions are the shape of that rule on the wire:
 *
 * - every file reaches the peer (nothing is dropped by holding events for the pass);
 * - the pushing host spends a handful of push requests, not one per file;
 * - the deployed allowance is never reached (`429` would otherwise cost a whole window);
 * - the *receiving* side runs no extra pass: its own pulled writes echo back as vault
 *   events, and counting those as a burst would put a full scan behind every download
 *   (that is what the engine's self-write hint is for — its `indexReads` stays at the bind).
 */

/** Enough files that one-request-per-file is unmistakably over the deployed allowance. */
const FILES = 700;

/** What the two hosts spent on the wire, counted at the transport. */
interface WireCounts {
  pushes: number;
  pullRequests: number;
  indexReads: number;
  rateLimited: number;
  /** Content requests (a read-ahead groups many versions into one). */
  contentRequests: number;
}

function countingFetch(counts: WireCounts): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/sync/push")) counts.pushes += 1;
    else if (url.includes("/sync/pull")) counts.pullRequests += 1;
    else if (url.includes("/sync/index")) counts.indexReads += 1;
    else if (url.includes("/sync/contents")) counts.contentRequests += 1;
    const response = await fetch(input, init);
    if (response.status === 429) counts.rateLimited += 1;
    return response;
  }) as typeof fetch;
}

/**
 * The CLI adapter plus the vault events a real file watcher would fire.
 *
 * `ObsidianVaultAdapter` and the CLI's `fs.watch` both report a write the engine just made,
 * which is why `SelfEventLog` exists. Without this the receiving host would never see the
 * echo, and the assertion that a large pull does not look like a user burst would be
 * vacuous.
 */
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

/** The `.md` files a vault directory holds, at any depth. */
function countNotes(dir: string, prefix = ""): number {
  let total = 0;
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) total += countNotes(dir, rel);
    else if (entry.name.endsWith(".md")) total += 1;
  }
  return total;
}

/** `notes/<prefix>-0000.md`: the path shape the bulk cases write. */
function notePath(prefix: string, index: number): string {
  return `notes/${prefix}-${String(index).padStart(4, "0")}.md`;
}

/** A note body that changes with `version`, so an applied edit is visible on the peer. */
function noteBody(index: number, version: number): string {
  return `# note ${index}\nv${version}\n`;
}

interface TestHost {
  host: SyncHost;
  dir: string;
  counts: WireCounts;
  adapter: EchoingAdapter;
  /** Every decision the engine reported, in order — what a version's action was. */
  activities: SyncActivityEvent[];
}

describe("a bulk local write through a real server", () => {
  let server: TestServer;
  let material: VaultMaterial;

  beforeAll(async () => {
    // The deployed allowance, not the harness ceiling: this case is about staying inside it.
    server = await startTestServer("bulk-write e2e user", { syncRateLimitMaxAttempts: 600 });
    material = await makeVaultMaterial();
  }, 120_000);

  afterAll(async () => {
    await server.close();
  });

  async function startHost(vaultId: string, dir: string, label: string): Promise<TestHost> {
    const counts: WireCounts = {
      pushes: 0,
      pullRequests: 0,
      indexReads: 0,
      rateLimited: 0,
      contentRequests: 0,
    };
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
    const activities: SyncActivityEvent[] = [];
    const host = new SyncHost({
      vaultId,
      encryptionKey: material.key,
      syncScope: normalizeScope({ configDir: ".obsidian" }),
      adapter,
      api: createCliSyncApi({
        serverUrl: server.serverUrl,
        userKey: server.userKey,
        getDeviceName: () => label,
        fetchImpl: countingFetch(counts),
      }),
      wsUrl: server.wsUrl,
      userKey: server.userKey,
      getDeviceName: () => label,
      eventSource,
      stateStore,
      platform: realPlatform,
      // This case drives the event path only: no periodic pass, no settings poll.
      reconcileIntervalMs: 0,
      settingsPollIntervalMs: 0,
      onSyncActivity: (event) => activities.push(event),
      log: () => {},
    });
    await host.start();
    return { host, dir, counts, adapter, activities };
  }

  it("reaches a live peer in batched pushes, inside the deployed sync allowance", async () => {
    const vault = await createTestVault(server, "bulk-write", material);
    const phone = await startHost(vault.id, mkdtempSync(join(tmpdir(), "bulk-phone-")), "phone");
    const mac = await startHost(vault.id, mkdtempSync(join(tmpdir(), "bulk-mac-")), "mac");

    try {
      // The agent writes into the vault directly; the watcher reports each file.
      const events = mac.adapter.handlers!;
      const bodies = new Map<string, string>();
      for (let index = 0; index < FILES; index += 1) {
        const path = `notes/generated-${String(index).padStart(4, "0")}.md`;
        const body = `# generated ${index}\n\n${"lorem ipsum ".repeat(16)}`;
        bodies.set(path, body);
        mkdirSync(join(mac.dir, dirname(path)), { recursive: true });
        writeFileSync(join(mac.dir, path), body);
        events.changed(path, Buffer.byteLength(body));
      }

      await waitFor(
        () => countNotes(phone.dir) === FILES,
        `${FILES} generated notes on the peer`,
        60_000,
      );
      await phone.host.whenIdle();
      await mac.host.whenIdle();

      // Every file arrived, with the bytes it was written with.
      expect(countNotes(phone.dir)).toBe(FILES);
      for (const [path, body] of bodies) {
        expect(readFileSync(join(phone.dir, path), "utf-8"), path).toBe(body);
      }

      // The pushing host spent a handful of requests, not one per file: the individual
      // events below the burst threshold, then 100-file batches.
      expect(mac.counts.pushes).toBeLessThanOrEqual(40);
      expect(mac.counts.rateLimited).toBe(0);
      // No pass: a burst is carried out by the engine's batched job, which reads what it
      // needs and never lists the vault's chains (`indexReads` is the bind's one read).
      expect(mac.counts.indexReads).toBe(1);
      // The peer's chain pulls are few for the same reason — the pushes arrive as bursts,
      // and the host coalesces them (see `PUSH_NOTIFICATION_BATCH`).
      expect(phone.counts.pullRequests).toBeLessThanOrEqual(40);
      expect(phone.counts.rateLimited).toBe(0);
      // A pull's own vault events are not a user burst: the peer runs its bind pass and
      // nothing else (`indexReads` is that pass's one `GET /sync/index`).
      expect(phone.counts.indexReads).toBe(1);
      // The receiving half is batched too: the read-ahead puts 64 versions in one content
      // request, so 700 files cost ~11 reads instead of one per wave of four (~175).
      expect(phone.counts.contentRequests).toBeLessThanOrEqual(20);
    } finally {
      phone.host.stop();
      mac.host.stop();
    }
  }, 120_000);

  it("downloads a full remote in a handful of wide content requests", async () => {
    // The receiving direction of the same lesson. A cold download used to pay one
    // content request per wave of four files — 100 round trips for 400 notes, whatever
    // the wave batcher grouped — because the pool's concurrency, not the batch, decided
    // how many files a round trip could carry. The read-ahead puts 64 versions in one
    // request, so what is left of a first bind is the per-file write, not the network.
    const vault = await createTestVault(server, "bulk-download", material);
    const mac = await startHost(vault.id, mkdtempSync(join(tmpdir(), "bulk-dl-mac-")), "mac");
    let phone: TestHost | null = null;

    const notes = 400;
    const bodies = new Map<string, string>();
    try {
      const events = mac.adapter.handlers!;
      for (let index = 0; index < notes; index += 1) {
        const path = notePath("downloaded", index);
        const body = noteBody(index, 1);
        bodies.set(path, body);
        mkdirSync(join(mac.dir, dirname(path)), { recursive: true });
        writeFileSync(join(mac.dir, path), body);
        events.changed(path, Buffer.byteLength(body));
      }
      // Let the writer settle, so the reader meets a full remote rather than a stream of
      // notifications: this is the *bind* download, not the live one.
      await mac.host.whenIdle();

      phone = await startHost(vault.id, mkdtempSync(join(tmpdir(), "bulk-dl-phone-")), "phone");
      await waitFor(
        () => countNotes(phone!.dir) === notes,
        `${notes} notes on the fresh device`,
        60_000,
      );
      await phone.host.whenIdle();

      expect(countNotes(phone.dir)).toBe(notes);
      for (const [path, body] of bodies) {
        expect(readFileSync(join(phone.dir, path), "utf-8"), path).toBe(body);
      }
      // ceil(400 / 64) = 7 requests, plus the tail a wave read may still make.
      expect(phone.counts.contentRequests).toBeLessThanOrEqual(10);
      expect(phone.counts.rateLimited).toBe(0);
    } finally {
      phone?.host.stop();
      mac.host.stop();
    }
  }, 120_000);

  it("batches a burst of edits to existing notes as well", async () => {
    const vault = await createTestVault(server, "bulk-modify", material);
    const phone = await startHost(
      vault.id,
      mkdtempSync(join(tmpdir(), "bulk-mod-phone-")),
      "phone",
    );
    const mac = await startHost(vault.id, mkdtempSync(join(tmpdir(), "bulk-mod-mac-")), "mac");

    const notes = 300;
    const pathOf = (index: number) => notePath("existing", index);
    const phase = (version: number) => {
      const events = mac.adapter.handlers!;
      for (let index = 0; index < notes; index += 1) {
        const path = pathOf(index);
        const text = noteBody(index, version);
        mkdirSync(join(mac.dir, dirname(path)), { recursive: true });
        writeFileSync(join(mac.dir, path), text);
        events.changed(path, Buffer.byteLength(text));
      }
    };
    const peerCaughtUp = (version: number) => {
      for (let index = 0; index < notes; index += 1) {
        try {
          if (readFileSync(join(phone.dir, pathOf(index)), "utf-8") !== noteBody(index, version)) {
            return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    };

    try {
      // Seed the notes first, let them settle, then measure only the edit burst.
      phase(1);
      await waitFor(() => peerCaughtUp(1), `${notes} seeded notes on the peer`, 60_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();
      for (const key of Object.keys(mac.counts) as Array<keyof WireCounts>) mac.counts[key] = 0;

      // 300 edits to files both sides already track: without batching that is one chain
      // read *and* one push per file against the same 600/minute allowance.
      phase(2);
      await waitFor(() => peerCaughtUp(2), "every edit applied on the peer", 60_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();

      // Chains travel together (200 per request) and versions travel together (100 per
      // request): the burst's four ledger events, two chain reads, three pushes.
      expect(mac.counts.pullRequests).toBeLessThanOrEqual(30);
      expect(mac.counts.pushes).toBeLessThanOrEqual(30);
      expect(mac.counts.rateLimited).toBe(0);
      expect(mac.counts.indexReads).toBe(0);
      expect(phone.counts.rateLimited).toBe(0);
    } finally {
      phone.host.stop();
      mac.host.stop();
    }
  }, 120_000);

  it("batches a burst of deletions as well", async () => {
    const vault = await createTestVault(server, "bulk-delete", material);
    const phone = await startHost(
      vault.id,
      mkdtempSync(join(tmpdir(), "bulk-del-phone-")),
      "phone",
    );
    const mac = await startHost(vault.id, mkdtempSync(join(tmpdir(), "bulk-del-mac-")), "mac");

    const notes = 300;

    try {
      const events = mac.adapter.handlers!;
      for (let index = 0; index < notes; index += 1) {
        const path = notePath("doomed", index);
        const text = `# doomed ${index}\n`;
        mkdirSync(join(mac.dir, dirname(path)), { recursive: true });
        writeFileSync(join(mac.dir, path), text);
        events.changed(path, Buffer.byteLength(text));
      }
      await waitFor(() => countNotes(phone.dir) === notes, `${notes} seeded notes`, 60_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();
      for (const key of Object.keys(mac.counts) as Array<keyof WireCounts>) mac.counts[key] = 0;

      // A folder removal: one `delete` event per file, and one tombstone version each.
      for (let index = 0; index < notes; index += 1) {
        const path = notePath("doomed", index);
        unlinkSync(join(mac.dir, path));
        events.removed(path);
      }
      await waitFor(() => countNotes(phone.dir) === 0, "every note removed on the peer", 60_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();

      // Tombstones are content-less versions, but they are still requests: 100 per batch
      // instead of one per file.
      expect(mac.counts.pushes).toBeLessThanOrEqual(30);
      expect(mac.counts.rateLimited).toBe(0);
      expect(mac.counts.indexReads).toBe(0);
      expect(phone.counts.rateLimited).toBe(0);
    } finally {
      phone.host.stop();
      mac.host.stop();
    }
  }, 120_000);

  it("batches a burst of moves as well", async () => {
    const vault = await createTestVault(server, "bulk-rename", material);
    const phone = await startHost(
      vault.id,
      mkdtempSync(join(tmpdir(), "bulk-ren-phone-")),
      "phone",
    );
    const mac = await startHost(vault.id, mkdtempSync(join(tmpdir(), "bulk-ren-mac-")), "mac");

    const notes = 300;
    const before = (index: number) => notePath("from", index);
    const after = (index: number) => notePath("to", index);
    const body = (index: number) => noteBody(index, 1);

    try {
      const events = mac.adapter.handlers!;
      for (let index = 0; index < notes; index += 1) {
        const path = before(index);
        mkdirSync(join(mac.dir, dirname(path)), { recursive: true });
        writeFileSync(join(mac.dir, path), body(index));
        events.changed(path, body(index).length);
      }
      await waitFor(() => countNotes(phone.dir) === notes, `${notes} seeded notes`, 60_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();
      for (const key of Object.keys(mac.counts) as Array<keyof WireCounts>) mac.counts[key] = 0;

      // A folder rename: Obsidian reports one `rename` per file, and each one re-points
      // its chain (a content-less version the batch can carry 100 at a time).
      for (let index = 0; index < notes; index += 1) {
        renameSync(join(mac.dir, before(index)), join(mac.dir, after(index)));
        events.renamed(before(index), after(index), body(index).length);
      }
      const movedOnPeer = () => {
        try {
          for (let index = 0; index < notes; index += 1) {
            if (existsSync(join(phone.dir, before(index)))) return false;
            if (readFileSync(join(phone.dir, after(index)), "utf-8") !== body(index)) {
              return false;
            }
          }
          return countNotes(phone.dir) === notes;
        } catch {
          return false;
        }
      };
      await waitFor(movedOnPeer, "every move applied on the peer", 60_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();

      // Every note is at its new path on both sides, and no note was deleted.
      expect(countNotes(phone.dir)).toBe(notes);
      for (let index = 0; index < notes; index += 1) {
        expect(readFileSync(join(phone.dir, after(index)), "utf-8"), after(index)).toBe(
          body(index),
        );
      }
      expect(mac.counts.pushes).toBeLessThanOrEqual(30);
      expect(mac.counts.rateLimited).toBe(0);
      expect(mac.counts.indexReads).toBe(0);
      expect(phone.counts.rateLimited).toBe(0);
    } finally {
      phone.host.stop();
      mac.host.stop();
    }
  }, 120_000);

  it("batches a folder move the watcher reports as remove plus create", async () => {
    // The shape the CLI's `fs.watch` and external tools produce — no `rename` event, just
    // the old path gone and the new one created. The batch must read each pair as one
    // content-less rename: a tombstone per moved note would double the pushes and make a
    // peer delete the file before it is written again. The peer side of a move is covered by
    // the `rename` case above; this one pins the sender's wire.
    const vault = await createTestVault(server, "bulk-move-split", material);
    const mac = await startHost(vault.id, mkdtempSync(join(tmpdir(), "bulk-mvs-")), "mac");

    const notes = 60;
    const before = (index: number) => notePath("from", index);
    const after = (index: number) => notePath("to", index);
    const body = (index: number) => noteBody(index, 4);

    try {
      const events = mac.adapter.handlers!;
      for (let index = 0; index < notes; index += 1) {
        const path = before(index);
        mkdirSync(join(mac.dir, dirname(path)), { recursive: true });
        writeFileSync(join(mac.dir, path), body(index));
        events.changed(path, body(index).length);
      }
      await waitFor(
        () =>
          Array.from({ length: notes }, (_, index) => mac.host.fileIdForPath(before(index))).every(
            (fileId) => fileId !== null,
          ),
        `${notes} seeded notes are tracked`,
        60_000,
      );
      await mac.host.whenIdle();
      const fileIds = Array.from({ length: notes }, (_, index) =>
        mac.host.fileIdForPath(before(index)),
      );
      for (const key of Object.keys(mac.counts) as Array<keyof WireCounts>) mac.counts[key] = 0;

      // Both halves of every move, reported together.
      for (let index = 0; index < notes; index += 1) {
        renameSync(join(mac.dir, before(index)), join(mac.dir, after(index)));
        events.removed(before(index));
        events.changed(after(index), body(index).length);
      }
      await mac.host.whenIdle();

      // One chain each, at its new path, with no tombstone in between: a delete plus a
      // rename per file would be ~120 pushes.
      for (let index = 0; index < notes; index += 1) {
        expect(mac.host.fileIdForPath(after(index)), after(index)).toBe(fileIds[index]);
      }
      expect(mac.host.fileIdForPath(before(0))).toBeNull();
      expect(countNotes(mac.dir)).toBe(notes);
      // Four of the one hundred and twenty events are below the burst threshold and take the
      // single-event path (a tombstone and its rename each, for the first two moves); the rest
      // travel as one batch. A delete plus a rename per file would be ~120 pushes.
      expect(mac.counts.pushes).toBeLessThanOrEqual(8);
      expect(mac.counts.rateLimited).toBe(0);
      expect(mac.counts.indexReads).toBe(0);
    } finally {
      mac.host.stop();
    }
  }, 60_000);

  it("does not publish a deletion when a batch removes and rewrites one path", async () => {
    const vault = await createTestVault(server, "bulk-replace", material);
    const phone = await startHost(
      vault.id,
      mkdtempSync(join(tmpdir(), "bulk-rep-phone-")),
      "phone",
    );
    const mac = await startHost(vault.id, mkdtempSync(join(tmpdir(), "bulk-rep-mac-")), "mac");

    const notes = 120;
    const pathOf = (index: number) => notePath("inplace", index);
    const caughtUp = (version: number) => {
      for (let index = 0; index < notes; index += 1) {
        try {
          if (readFileSync(join(phone.dir, pathOf(index)), "utf-8") !== noteBody(index, version)) {
            return false;
          }
        } catch {
          return false;
        }
      }
      return true;
    };

    try {
      const events = mac.adapter.handlers!;
      for (let index = 0; index < notes; index += 1) {
        const path = pathOf(index);
        mkdirSync(join(mac.dir, dirname(path)), { recursive: true });
        writeFileSync(join(mac.dir, path), noteBody(index, 1));
        events.changed(path, noteBody(index, 1).length);
      }
      await waitFor(() => caughtUp(1), "seeded", 60_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();
      for (const key of Object.keys(mac.counts) as Array<keyof WireCounts>) mac.counts[key] = 0;

      // A tool that rewrites in place: the watcher reports the removal and the new write
      // in the same window. The file is there, so the batch must not publish a deletion
      // for it — the removal is followed by the write it was half of.
      for (let index = 0; index < notes; index += 1) {
        const path = pathOf(index);
        writeFileSync(join(mac.dir, path), noteBody(index, 2));
        events.removed(path);
        events.changed(path, noteBody(index, 2).length);
      }
      await waitFor(() => caughtUp(2), "every in-place rewrite applied", 60_000);
      await waitFor(() => countNotes(phone.dir) === notes, "no note removed on the peer", 10_000);
      await phone.host.whenIdle();
      await mac.host.whenIdle();

      expect(mac.counts.pushes).toBeLessThanOrEqual(20);
      expect(mac.counts.rateLimited).toBe(0);
      expect(phone.counts.rateLimited).toBe(0);
      // The rule the batch's delete-first order exists for: a removal that was half of a
      // rewrite never becomes a tombstone, so no peer is told to delete a note that is
      // still there. The events below the burst threshold take the single-event path, whose
      // tombstone is followed by its restore — at most one per tier, never one per file.
      expect(
        mac.activities.filter((event) => event.action === "delete").length,
      ).toBeLessThanOrEqual(4);
    } finally {
      phone.host.stop();
      mac.host.stop();
    }
  }, 120_000);
});
