import {
  FakeAdapter,
  FakeApi,
  MAX_CONTENT_BATCH_FILES,
  MAX_RATE_LIMIT_WAITS,
  SyncEngine,
  decryptString,
  describe,
  encoder,
  encryptCombinedBytes,
  encryptString,
  expect,
  expectConsistent,
  freezeConflictClock,
  generateFileId,
  generateVersionId,
  it,
  makeEngine,
  rateLimited,
  realPlatform,
  scopeWith,
  sha256Hex,
  sha256Text,
} from "./engine.test-helpers";
import type { FileSkippedEvent, OpQueueLimits, SyncProgress } from "./engine.test-helpers";
import type { Platform } from "./platform";

freezeConflictClock();

/**
 * A platform whose one-shot timers never fire.
 *
 * The content reader's tail flush is the only one-shot timer a bind uses with the read-ahead
 * off, and holding it forever is what makes a **full** wave deterministic: with as many
 * reads as the request accepts, the last `read` is what flushes the batch, not a 0 ms turn.
 * With a real clock that turn can fire between the per-file tasks and split the wave
 * (`[61, 3]`, or `[2, 1]` for three reads, on a loaded runner); the route accepts any split,
 * so a case that cannot hold the timer asserts the rule rather than the split (see "sends a
 * partial wave on the next turn" and "never names more hashes than the route accepts").
 */
const noTurnTimers: Platform = {
  ...realPlatform,
  after: () => ({ cancel: () => {} }),
};

describe("SyncEngine — a first bind that meets the server's limits", () => {
  it("waits out a rate limit and sends the same batch again", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    const realPush = api.push.bind(api);
    let refusals = 0;
    api.push = async (vaultId, files) => {
      if (refusals === 0) {
        refusals += 1;
        throw rateLimited();
      }
      return await realPush(vaultId, files);
    };

    await engine.initialSync();

    // The refused batch was re-sent after the wait, so every file landed and the pass
    // did not have to be retried by the host.
    expect(refusals).toBe(1);
    expect(api.pushCalls).toEqual([100, 100, 50]);
    expect(api.chains.size).toBe(250);
  });

  it("sends the batches after one the server refused, and keeps their files untracked", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    const realPush = api.push.bind(api);
    let attempts = 0;
    api.push = async (vaultId, files) => {
      // The first batch is refused for a reason a wait cannot fix (a quota, say).
      if (attempts++ === 0) throw new Error("quota exceeded");
      return await realPush(vaultId, files);
    };

    await expect(engine.initialSync()).rejects.toThrow("quota exceeded");

    // The pass kept going: the two batches after the refused one still went out.
    expect(api.pushCalls).toEqual([100, 50]);
    expect(api.chains.size).toBe(150);
    // And the refused batch's 100 files are *untracked*: no phantom state entry makes
    // the next pass push them one request at a time.
    expect(Object.keys(JSON.parse(engine.serializeState()))).toHaveLength(150);

    // The next pass retries them through the batched create path: one request for 100
    // files, not 100 requests.
    api.push = realPush;
    api.pushCalls.length = 0;
    await engine.initialSync();
    expect(api.pushCalls).toEqual([100]);
    expect(api.chains.size).toBe(250);
  });

  it("reads each file once when the remote holds nothing", async () => {
    const { engine, adapter } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    await engine.initialSync();

    // The scan hashes what a chain or a state entry claims; a file with neither is only
    // ever a `create`, so it is read once — by the create — instead of twice.
    expect(adapter.reads).toHaveLength(250);
    expect(new Set(adapter.reads).size).toBe(250);
  });

  it("prepares the next batch while the previous request is still in flight", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    const realPush = api.push.bind(api);
    const realRead = adapter.readFile.bind(adapter);
    let reads = 0;
    let readsWhenFirstPushResolved = 0;
    let announceSecondBatch!: () => void;
    const secondBatchRead = new Promise<void>((resolve) => {
      announceSecondBatch = resolve;
    });
    adapter.readFile = async (path) => {
      const bytes = await realRead(path);
      reads += 1;
      // The second batch's 100 files are done reading at read 200 (the first batch's 100
      // plus this one's).
      if (reads === 200) announceSecondBatch();
      return bytes;
    };
    api.push = async (vaultId, files) => {
      if (api.pushCalls.length === 0) {
        // Hold the first request until the second batch has been read (or give up after a
        // moment, which is what a serial bind does — and then this test fails on the count).
        await Promise.race([
          secondBatchRead,
          new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
        ]);
        readsWhenFirstPushResolved = reads;
      }
      return await realPush(vaultId, files);
    };

    try {
      await engine.initialSync();
    } finally {
      adapter.readFile = realRead;
      api.push = realPush;
    }

    // The second batch was ready before the first answer arrived: preparation and the
    // request overlap instead of taking turns.
    expect(readsWhenFirstPushResolved).toBeGreaterThanOrEqual(200);
    expect(api.chains.size).toBe(250);
  });

  it("reports a bind's progress, and ends it at done === total", async () => {
    const progress: SyncProgress[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => progress.push(event),
    );
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    await engine.initialSync();

    // Coarse steps, not one callback per file: 250 files report far fewer than 250 times.
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.length).toBeLessThan(250);
    // The last report is the pass's own "finished": a status surface can stop there.
    expect(progress.at(-1)).toEqual({ done: 250, total: 250 });
    // …and the counter never moves backwards while `total` only grows.
    for (let index = 1; index < progress.length; index++) {
      expect(progress[index]!.done).toBeGreaterThanOrEqual(progress[index - 1]!.done);
      expect(progress[index]!.total).toBeGreaterThanOrEqual(progress[index - 1]!.total);
    }
  });

  it("reports the total of a download up front, because every chain is known", async () => {
    const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
    sourceAdapter.files.set("a.md", encoder.encode("# a"));
    sourceAdapter.files.set("b.md", encoder.encode("# b"));
    await source.initialSync();

    const progress: SyncProgress[] = [];
    const download = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: new FakeAdapter(),
      api,
      encryptionKey: key,
      onProgress: (event) => progress.push(event),
    });
    await download.initialSync();

    // The first report already knows the size of the job: a download's chains all come
    // from the index, unlike a bind's creates, which are discovered as the scan walks.
    expect(progress[0]).toEqual({ done: 0, total: 2 });
    expect(progress.at(-1)).toEqual({ done: 2, total: 2 });
  });

  it("never reads a file twice on a second pass", async () => {
    const { engine, adapter } = await makeEngine();
    for (let i = 0; i < 50; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }
    await engine.initialSync();
    adapter.reads.length = 0;

    await engine.initialSync();

    // Every file's stamp was recorded with its hash, so a pass that finds the same bytes
    // reads none of them.
    expect(adapter.reads).toEqual([]);
  });

  it("reports a wait instead of going silent when the limiter refuses a batch", async () => {
    const waits: number[] = [];
    const { engine, adapter, api } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => waits.push(event.waitMs),
    );
    for (let i = 0; i < 150; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    const realPush = api.push.bind(api);
    let refusals = 0;
    api.push = async (vaultId, files) => {
      if (refusals++ === 0) throw rateLimited(120);
      return await realPush(vaultId, files);
    };
    try {
      await engine.initialSync();
    } finally {
      api.push = realPush;
    }

    // One report per wait, carrying the server's own delay — a host can log "waiting 1s"
    // instead of leaving a minute of silence that looks like a hang.
    expect(waits).toEqual([120]);
    expect(api.chains.size).toBe(150);
  });

  it("stops the pass when a rate limit outlasts its waits, and leaves the rest untracked", async () => {
    const { engine, adapter, api } = await makeEngine();
    for (let i = 0; i < 250; i++) {
      adapter.files.set(`notes/${i}.md`, encoder.encode(`# note ${i}`));
    }

    // The limiter never lets the first batch through: after the bounded waits the pass
    // gives up instead of spinning, and records nothing for the batch it could not send.
    const realPush = api.push.bind(api);
    let attempts = 0;
    api.push = async () => {
      attempts += 1;
      throw rateLimited();
    };
    await expect(engine.initialSync()).rejects.toMatchObject({ status: 429 });
    expect(attempts).toBe(MAX_RATE_LIMIT_WAITS + 1);
    expect(JSON.parse(engine.serializeState())).toEqual({});

    // The next pass, once the window is over, creates everything in batches — the files
    // were never recorded as tracked, so nothing is retried one request at a time.
    api.push = realPush;
    api.pushCalls.length = 0;
    await engine.initialSync();
    expect(api.pushCalls).toEqual([100, 100, 50]);
    expect(api.chains.size).toBe(250);
  });

  it("reports a refused content download instead of treating the blob as gone", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("# from the peer"));
    await engine.initialSync();

    // A fresh device pulls the same chain, but its content request is refused.
    const downloadAdapter = new FakeAdapter();
    const download = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: downloadAdapter,
      api,
      encryptionKey: key,
    });
    const realContent = api.getVersionContents.bind(api);
    api.getVersionContents = async () => {
      throw rateLimited(1);
    };
    try {
      // A 429 is a request that did not happen, not a missing blob: the pass fails so
      // the host retries it, instead of reporting success with the file still absent.
      await expect(download.initialSync()).rejects.toThrow(/rate limit/i);
      expect(downloadAdapter.files.has("note.md")).toBe(false);
    } finally {
      api.getVersionContents = realContent;
    }

    // The next pass, with the limiter window over, applies it.
    await download.initialSync();
    expect(new TextDecoder().decode(downloadAdapter.files.get("note.md"))).toBe("# from the peer");
  });

  it("waits out a rate-limited content read and still applies the file", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("# from the peer"));
    await engine.initialSync();

    const downloadAdapter = new FakeAdapter();
    const download = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: downloadAdapter,
      api,
      encryptionKey: key,
    });
    const realContent = api.getVersionContents.bind(api);
    let attempts = 0;
    api.getVersionContents = async (vaultId, contentHashes) => {
      attempts += 1;
      if (attempts === 1) throw rateLimited();
      return await realContent(vaultId, contentHashes);
    };
    try {
      // The window is waited out (the server said how long), so the first download of a
      // large vault does not fail on a bound it can simply wait for.
      await expect(download.initialSync()).resolves.toBeUndefined();
    } finally {
      api.getVersionContents = realContent;
    }

    expect(attempts).toBe(2);
    expect(new TextDecoder().decode(downloadAdapter.files.get("note.md"))).toBe("# from the peer");
  });

  it("still treats a blob the store does not hold as nothing to apply", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("note.md", encoder.encode("# from the peer"));
    await engine.initialSync();

    const downloadAdapter = new FakeAdapter();
    const download = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: downloadAdapter,
      api,
      encryptionKey: key,
    });
    api.getVersionContents = async (_vaultId, contentHashes) => contentHashes.map(() => null);

    // A 404 is the store saying it holds nothing: no file is written and the pass does
    // not fail — the next pass decides again.
    await expect(download.initialSync()).resolves.toBeUndefined();
    expect(downloadAdapter.files.has("note.md")).toBe(false);
  });
});

describe("SyncEngine — the empty-content hash", () => {
  it("shares one in-flight digest between the decisions a pass starts together", async () => {
    const { engine } = await makeEngine();
    const internals = engine as unknown as {
      emptyContentHash(): Promise<string>;
    };

    const first = internals.emptyContentHash();
    const second = internals.emptyContentHash();

    // One promise, not one per decision: a pool wave awaits the same digest.
    expect(second).toBe(first);
    expect(await first).toBe(await sha256Text(""));
    // The settled digest stays cached for the decisions after the wave.
    expect(internals.emptyContentHash()).toBe(first);
  });
});

/** A source vault holding `paths`, bound and synced, ready to be pulled by a target. */
async function sourceFor(
  paths: ReadonlyArray<{ path: string; text: string }>,
): Promise<{ api: FakeApi; key: CryptoKey }> {
  const { engine, adapter, api, key } = await makeEngine();
  for (const entry of paths) adapter.files.set(entry.path, encoder.encode(entry.text));
  await engine.initialSync();
  return { api, key };
}

/** A fresh device that binds the same vault, and answers its content requests. */
async function bindTarget(
  api: FakeApi,
  key: CryptoKey,
  opLimits?: OpQueueLimits,
  platform: Platform = realPlatform,
) {
  const adapter = new FakeAdapter();
  const engine = new SyncEngine({
    platform,
    vaultId: "vault-1",
    adapter,
    api,
    encryptionKey: key,
    // These cases are about the **wave** batcher — how the pool's concurrency sizes one
    // request — so the read-ahead beside it is off here. It is measured and pinned on
    // its own in "download read-ahead".
    contentPrefetch: false,
    ...(opLimits === undefined ? {} : { opLimits }),
  });
  await engine.initialSync();
  return { engine, adapter };
}

describe("SyncEngine — batched content reads", () => {
  it("names a content hash two files share once", async () => {
    const { api, key } = await sourceFor([
      { path: "a.md", text: "identical bytes" },
      { path: "b.md", text: "identical bytes" },
    ]);
    api.contentBatchCalls.length = 0;

    // Both chains point at the same blob; the wave fetches it once and both files apply.
    const { adapter } = await bindTarget(api, key, { maxConcurrent: 4, exclusiveBytes: 1_024 });

    expect(api.contentBatchCalls).toHaveLength(1);
    expect(api.contentBatchCalls[0]).toHaveLength(1);
    expect(new TextDecoder().decode(adapter.files.get("a.md"))).toBe("identical bytes");
    expect(new TextDecoder().decode(adapter.files.get("b.md"))).toBe("identical bytes");
  });

  it("flushes a batch when the next file would pass its byte budget", async () => {
    // 5 MiB each, below the chunking threshold, so each is one whole-file read; two of
    // them do not fit in one 8 MiB batch.
    const five = new Uint8Array(5 * 1024 * 1024).fill(7);
    const other = new Uint8Array(5 * 1024 * 1024).fill(8);
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("big-a.pdf", five);
    adapter.files.set("big-b.pdf", other);
    await engine.initialSync();
    api.contentBatchCalls.length = 0;

    const target = await bindTarget(api, key, {
      maxConcurrent: 4,
      exclusiveBytes: 16 * 1024 * 1024,
    });

    expect(api.contentBatchCalls.map((call) => call.length)).toEqual([1, 1]);
    expect(target.adapter.files.get("big-a.pdf")?.byteLength).toBe(five.byteLength);
    expect(target.adapter.files.get("big-b.pdf")?.byteLength).toBe(five.byteLength);
  });

  it("never names more hashes than the route accepts, whatever the pool runs", async () => {
    // `opLimits` is caller-settable: a host may run more per-file operations than the
    // content route accepts. The batch must still stop at 64.
    const paths = Array.from({ length: 70 }, (_, index) => ({
      path: `wide/n-${index}.md`,
      text: `# wide ${index}`,
    }));
    const { api, key } = await sourceFor(paths);
    api.contentBatchCalls.length = 0;

    const target = await bindTarget(api, key, { maxConcurrent: 80, exclusiveBytes: 1_024 });

    // The cap is what this pins. How the six reads the first request could not hold are
    // split is the 0 ms tail timer's business: they reach the batcher in whatever turns
    // their per-file tasks finish in, so a loaded runner sends them as [64, 3, 3] rather
    // than [64, 6]. Both honour the route; only a request over its cap does not.
    const sizes = api.contentBatchCalls.map((call) => call.length);
    expect(sizes.every((size) => size <= MAX_CONTENT_BATCH_FILES)).toBe(true);
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(paths.length);
    expect(target.adapter.files.size).toBe(paths.length);
  });

  it("sends a partial wave on the next turn rather than waiting for a full batch", async () => {
    // Three reads against a pool that could run eight: the batch can never fill, so the pass
    // cannot wait for one — a partial wave has to travel. Which turn each per-file task
    // reaches the batcher in is the scheduler's business (a loaded runner splits the three
    // reads into `[2, 1]`, which the route accepts), so this pins that every read travels and
    // every file lands; the one-request window itself is pinned deterministically in
    // `content-reader.test.ts`.
    const paths = Array.from({ length: 3 }, (_, index) => ({
      path: `tail/n-${index}.md`,
      text: `# tail ${index}`,
    }));
    const { api, key } = await sourceFor(paths);
    api.contentBatchCalls.length = 0;

    const target = await bindTarget(api, key, { maxConcurrent: 8, exclusiveBytes: 1_024 });

    const sizes = api.contentBatchCalls.map((call) => call.length);
    expect(sizes.reduce((total, size) => total + size, 0)).toBe(3);
    expect(target.adapter.files.size).toBe(3);
  });

  it("flushes a full wave at the request's file cap", async () => {
    const paths = Array.from({ length: MAX_CONTENT_BATCH_FILES }, (_, index) => ({
      path: `cap/n-${index}.md`,
      text: `# cap ${index}`,
    }));
    const { api, key } = await sourceFor(paths);
    api.contentBatchCalls.length = 0;

    // The pool runs every file at once, so the wave fills the request, and the read that
    // fills it flushes it: the tail timer is held forever, which is what makes this case
    // about the cap rather than about the order the per-file tasks finish in.
    const target = await bindTarget(
      api,
      key,
      { maxConcurrent: MAX_CONTENT_BATCH_FILES, exclusiveBytes: 1_024 },
      noTurnTimers,
    );

    expect(api.contentBatchCalls).toHaveLength(1);
    expect(api.contentBatchCalls[0]).toHaveLength(MAX_CONTENT_BATCH_FILES);
    expect(target.adapter.files.size).toBe(MAX_CONTENT_BATCH_FILES);
  });
});

/** A source vault of `count` notes already bound to the fake store. */
async function seedRemote(count: number) {
  const { engine, adapter, api, key } = await makeEngine();
  for (let index = 0; index < count; index++) {
    adapter.files.set(`wide/n-${index}.md`, encoder.encode(`# note ${index}`));
  }
  await engine.initialSync();
  return { api, key };
}

/** A fresh device against the same store; the read-ahead is on unless stated. */
function newDevice(
  api: FakeApi,
  key: CryptoKey,
  options: { contentPrefetch?: false; platform?: Platform } = {},
): { engine: SyncEngine; adapter: FakeAdapter } {
  const { platform = realPlatform, ...engineOptions } = options;
  const adapter = new FakeAdapter();
  const engine = new SyncEngine({
    platform,
    vaultId: "vault-1",
    adapter,
    api,
    encryptionKey: key,
    ...engineOptions,
  });
  return { engine, adapter };
}

describe("SyncEngine — download read-ahead", () => {
  it("reads a cold download 64 files per request instead of one wave", async () => {
    // 70 files, a pool of four: the wave batcher would need 18 requests, whatever it
    // grouped; the read-ahead puts sixteen waves in each round trip.
    const { api, key } = await seedRemote(70);
    api.contentBatchCalls.length = 0;

    const { engine, adapter } = newDevice(api, key);
    await engine.initialSync();

    const sizes = api.contentBatchCalls.map((call) => call.length);
    expect(Math.max(...sizes)).toBe(64);
    // 64 + 6 covers 70 files; a third would be a tail wave read, and none should happen.
    expect(sizes.length).toBeLessThanOrEqual(2);
    expect(adapter.files.size).toBe(70);
    expect(engine.fileIdForPath("wide/n-69.md")).not.toBeNull();
  });

  it("falls back to the wave read when a read-ahead request fails", async () => {
    const { api, key } = await seedRemote(40);
    const real = api.getVersionContents.bind(api);
    let failed = false;
    api.getVersionContents = async (vaultId, contentHashes) => {
      if (!failed) {
        failed = true;
        throw new Error("the connection dropped");
      }
      return await real(vaultId, contentHashes);
    };
    api.contentBatchCalls.length = 0;

    const { engine, adapter } = newDevice(api, key);
    // A speculative read that did not happen must not fail the pass, and must not be
    // mistaken for "the store holds nothing": every file still lands.
    await expect(engine.initialSync()).resolves.toBeUndefined();
    expect(adapter.files.size).toBe(40);
    // The failed batch's hashes were read the old way, in waves, behind the retry.
    expect(api.contentBatchCalls.length).toBeGreaterThan(2);
    await expectConsistent(engine, adapter, api);
  });

  it("turns the read-ahead off with `contentPrefetch: false`", async () => {
    const { api, key } = await seedRemote(16);
    api.contentBatchCalls.length = 0;

    // The timer is held forever, so a wave is exactly the pool's width; a real 0 ms turn
    // can split it on a loaded runner, which the route accepts.
    const { engine, adapter } = newDevice(api, key, {
      contentPrefetch: false,
      platform: noTurnTimers,
    });
    await engine.initialSync();

    // Without it, a request names one wave — the pool's four — and nothing more.
    const sizes = api.contentBatchCalls.map((call) => call.length);
    expect(sizes).toEqual([4, 4, 4, 4]);
    expect(adapter.files.size).toBe(16);
    // …and there is nothing to report: the accessor's `null` is the "off" answer.
    expect(engine.prefetchStats()).toBeNull();
  });

  it("does not read ahead a chain this device does not sync", async () => {
    const { engine, adapter, api, key } = await makeEngine(undefined, undefined, scopeWith());
    await engine.initialSync();
    // A peer's settings file: this device's scope keeps it out of the config folder, so
    // the burst must not spend bytes reading it ahead (invariant 8).
    const bytes = encoder.encode("{}");
    const contentHash = await sha256Hex(bytes);
    api.blobs.set(contentHash, await encryptCombinedBytes(key, bytes as Uint8Array<ArrayBuffer>));
    const fileId = generateFileId();
    const versionId = generateVersionId();
    const encryptedPath = await encryptString(key, ".obsidian/app.json");
    api.paths.set(fileId, encryptedPath);
    api.chains.set(fileId, [
      {
        versionId,
        contentHash,
        encryptedPath,
        action: "create",
        sizeBytes: bytes.byteLength,
        mtimeMs: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    api.contentFetches.length = 0;

    await engine.handleFilePushedBatch([{ fileId, versionId }]);

    expect(api.contentFetches).toEqual([]);
    expect(adapter.files.has(".obsidian/app.json")).toBe(false);
  });

  it("releases the read-ahead a pass decided not to use", async () => {
    // A locally edited file's remote head is a candidate the pass decides to push **over**,
    // so nothing takes it. The pass has to release it: an unconsumed entry would keep the
    // room the next pass's read-ahead needs, and the feature would quietly stop working.
    const { api, key } = await seedRemote(2);
    const { engine, adapter } = newDevice(api, key);
    await engine.initialSync();

    adapter.files.set("wide/n-0.md", encoder.encode("# note 0, edited here"));
    await api.remoteEdit(engine.fileIdForPath("wide/n-1.md")!, "# note 1, edited there");
    const pushedBefore = api.pushed.length;

    await engine.initialSync();

    // The pull landed and the edit was pushed, so the pass really did decide both ways.
    expect(new TextDecoder().decode(adapter.files.get("wide/n-1.md"))).toBe(
      "# note 1, edited there",
    );
    expect(api.pushed.slice(pushedBefore).map((push) => push.action)).toContain("modify");
    // …and the head it did not download is not still buffered.
    expect(engine.prefetchStats()).toMatchObject({ storedEntries: 0, storedBytes: 0 });
  });

  it("releases the read-ahead a burst decided not to use", async () => {
    // The peer pushes a version whose bytes are already here: the burst queues its head, the
    // apply decides "synced", and nothing takes it — so the burst must drop it in the end.
    const { api, key } = await seedRemote(1);
    const { engine, adapter } = newDevice(api, key);
    await engine.initialSync();
    const fileId = engine.fileIdForPath("wide/n-0.md")!;
    await api.remoteEdit(fileId, "# note 0");
    const versionId = (await api.latestVersionId(fileId))!;
    const before = engine.prefetchStats()!;

    await engine.handleFilePushedBatch([{ fileId, versionId }]);

    expect(new TextDecoder().decode(adapter.files.get("wide/n-0.md"))).toBe("# note 0");
    const after = engine.prefetchStats()!;
    // The burst really did read its head ahead (one more request) and nothing consumed it
    // (no hit): that pair is what would disappear if this head ever decided as a pull.
    expect(after.requests).toBe(before.requests + 1);
    expect(after.hits).toBe(before.hits);
    expect(after).toMatchObject({ storedEntries: 0, storedBytes: 0 });
  });

  it("releases the read-ahead when a burst's apply fails", async () => {
    // The drop is in a `finally`, so a failed chunk releases what the read-ahead had stored
    // for it: one file's version is already here (its head is never taken) and the other's
    // write fails, which is what throws.
    const { api, key } = await seedRemote(2);
    const { engine, adapter } = newDevice(api, key);
    await engine.initialSync();
    const synced = engine.fileIdForPath("wide/n-0.md")!;
    await api.remoteEdit(synced, "# note 0");
    const failing = engine.fileIdForPath("wide/n-1.md")!;
    await api.remoteEdit(failing, "# note 1, from the peer");
    adapter.writeFile = async () => {
      throw new Error("the disk is full");
    };

    await expect(
      engine.handleFilePushedBatch([
        { fileId: synced, versionId: (await api.latestVersionId(synced))! },
        { fileId: failing, versionId: (await api.latestVersionId(failing))! },
      ]),
    ).rejects.toThrow("the disk is full");

    expect(engine.prefetchStats()).toMatchObject({ storedEntries: 0, storedBytes: 0 });
  });

  it("waits out a rate limit on the pull a burst's notifications need", async () => {
    // The bulk chain reads wait a limiter out (`withRateLimitWaits`); the batch's chain pull
    // used to be one that threw instead, so a burst arriving while the window was open failed
    // the whole hand-off. (The chunk-staging calls and the pass's `getVaultSyncIndex` do not
    // wait — they are not bulk reads, and this case pins neither of them.)
    const { api, key } = await seedRemote(1);
    const { engine, adapter } = newDevice(api, key);
    await engine.initialSync();
    const fileId = engine.fileIdForPath("wide/n-0.md")!;
    // Content the device does **not** already hold, so the assertion below proves the retry
    // applied something rather than merely that the file was still there.
    await api.remoteEdit(fileId, "# note 0, from the peer");
    const versionId = (await api.latestVersionId(fileId))!;

    const realPull = api.pull.bind(api);
    let calls = 0;
    api.pull = async (vaultId, fileIds) => {
      if (calls++ === 0) throw rateLimited(1);
      return await realPull(vaultId, fileIds);
    };

    await expect(engine.handleFilePushedBatch([{ fileId, versionId }])).resolves.toBeUndefined();

    // The refused request was re-sent after the wait, and the whole burst still landed.
    expect(calls).toBe(2);
    expect(new TextDecoder().decode(adapter.files.get("wide/n-0.md"))).toBe(
      "# note 0, from the peer",
    );
  });

  it("waits out a rate limit on the pull a single notification needs", async () => {
    // The same gap on the un-coalesced path: `handleFilePushed` reads the chain before it
    // applies the head, and that read used to throw where the bulk reads wait.
    const { api, key } = await seedRemote(1);
    const { engine, adapter } = newDevice(api, key);
    await engine.initialSync();
    const fileId = engine.fileIdForPath("wide/n-0.md")!;
    await api.remoteEdit(fileId, "# note 0, from the peer");
    const versionId = (await api.latestVersionId(fileId))!;

    const realPull = api.pull.bind(api);
    let calls = 0;
    api.pull = async (vaultId, fileIds) => {
      if (calls++ === 0) throw rateLimited(1);
      return await realPull(vaultId, fileIds);
    };

    await expect(engine.handleFilePushed(fileId, versionId)).resolves.toBeUndefined();

    expect(calls).toBe(2);
    expect(new TextDecoder().decode(adapter.files.get("wide/n-0.md"))).toBe(
      "# note 0, from the peer",
    );
  });

  it("normalizes a host's limits instead of stalling on them", async () => {
    // `concurrency: 0` would leave the read-ahead's queue unmoving and the pass waiting
    // on it forever; a batch wider than the route accepts would reject every read in it.
    const { api, key } = await seedRemote(3);
    api.contentBatchCalls.length = 0;
    const adapter = new FakeAdapter();
    const engine = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter,
      api,
      encryptionKey: key,
      contentPrefetch: { concurrency: 0, batchFiles: 1000 },
    });

    await engine.initialSync();

    expect(adapter.files.size).toBe(3);
    expect(api.contentBatchCalls.every((call) => call.length <= MAX_CONTENT_BATCH_FILES)).toBe(
      true,
    );
  });

  it("reads ahead for a notification burst", async () => {
    const { api, key } = await seedRemote(70);
    const { engine: peer, adapter: peerAdapter } = newDevice(api, key);
    await peer.initialSync();
    expect(peerAdapter.files.size).toBe(70);

    // The peer edits all 70 notes: the burst's apply loop is four files at a time. Each
    // edit is distinct, because two files sharing content share one read (and one entry).
    const paths = Array.from({ length: 70 }, (_, index) => `wide/n-${index}.md`);
    for (const path of paths) {
      await api.remoteEdit(peer.fileIdForPath(path)!, `updated ${path}`);
    }
    api.contentBatchCalls.length = 0;
    const events = paths.map((path) => {
      const fileId = peer.fileIdForPath(path)!;
      return { fileId, versionId: api.chains.get(fileId)!.at(-1)!.versionId };
    });

    await peer.handleFilePushedBatch(events);

    const sizes = api.contentBatchCalls.map((call) => call.length);
    expect(Math.max(...sizes)).toBe(64);
    expect(sizes.length).toBeLessThanOrEqual(3);
    expect(new TextDecoder().decode(peerAdapter.files.get("wide/n-0.md"))).toBe(
      "updated wide/n-0.md",
    );
  });
});

describe("SyncEngine — a path the API cannot carry", () => {
  /**
   * The API bounds `encryptedPath` (base64 of `iv ‖ ciphertext ‖ tag`), and it refuses
   * an over-long one for the **whole batch** — so one deep path used to poison up to
   * 100 files that travelled with it, on every pass, with a 422 no client could
   * explain. The file is skipped instead (and reported), and the rest of the bind
   * happens.
   */
  const longPath = `${"d".repeat(400)}.md`;

  it("skips the over-long file, reports it, and still syncs the rest", async () => {
    const skipped: FileSkippedEvent[] = [];
    const { engine, adapter, api, key } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => skipped.push(event),
    );
    adapter.files.set(longPath, encoder.encode("# deep"));
    adapter.files.set("notes/shallow.md", encoder.encode("# shallow"));

    await engine.initialSync();

    expect(skipped).toEqual([{ plainPath: longPath, reason: "path-too-long" }]);
    // The shallow note is unaffected: one request, and only its chain exists.
    expect(api.pushCalls).toEqual([1]);
    const paths = await Promise.all(
      api.pushed.map((push) => decryptString(key, push.encryptedPath)),
    );
    expect(paths).toEqual(["notes/shallow.md"]);
    // Nothing was left looking tracked with no version.
    expect(engine.fileIdForPath(longPath)).toBeNull();
  });

  it("reports the skip once per pass, not once per file read", async () => {
    const skipped: FileSkippedEvent[] = [];
    const { engine, adapter } = await makeEngine(
      undefined,
      undefined,
      undefined,
      undefined,
      (event) => skipped.push(event),
    );
    adapter.files.set(longPath, encoder.encode("# deep"));

    await engine.initialSync();
    await engine.initialSync();

    expect(skipped).toHaveLength(2);
    expect(skipped.map((event) => event.plainPath)).toEqual([longPath, longPath]);
  });
});

describe("SyncEngine — the order a pass works in", () => {
  /**
   * A cold start decides the same files either way; the order is what a user feels.
   * These cases pin the two signals the order is built from — the host's paths and the
   * local modification stamps — and the one subtlety: a chain whose path moved on one
   * side is ranked by **whichever** of the two paths the user has.
   */

  it("pulls the note the host named first", async () => {
    const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
    for (const [path, text] of [
      ["a.md", "a v1"],
      ["b.md", "b v1"],
      ["c.md", "c v1"],
    ]) {
      sourceAdapter.files.set(path, encoder.encode(text));
    }
    await source.initialSync();

    const targetAdapter = new FakeAdapter();
    const target = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: targetAdapter,
      api,
      encryptionKey: key,
      // Serialise the pass: this case is about the **order** the work is taken in,
      // and a concurrent pool may let two files reach the network together.
      opLimits: { maxConcurrent: 1, exclusiveBytes: 1_024 },
    });
    await target.initialSync();

    // Every file changes on the peer, so all three need a pull.
    for (const path of ["a.md", "b.md", "c.md"]) {
      await api.remoteEdit(target.fileIdForPath(path)!, `${path} v2`);
    }
    api.contentFetches.length = 0;

    await target.initialSync({ priorityPaths: ["b.md"] });

    expect(api.contentFetches).toHaveLength(3);
    expect(api.contentFetches[0]).toBe(await sha256Hex(encoder.encode("b.md v2")));
  });

  it("ranks a file by the local path when the peer moved its chain", async () => {
    const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
    sourceAdapter.files.set("old.md", encoder.encode("old v1"));
    sourceAdapter.files.set("z.md", encoder.encode("z v1"));
    await source.initialSync();

    const targetAdapter = new FakeAdapter();
    const target = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: targetAdapter,
      api,
      encryptionKey: key,
      // Same reason as the case above: this asserts the order, not the concurrency.
      opLimits: { maxConcurrent: 1, exclusiveBytes: 1_024 },
    });
    await target.initialSync();

    // The peer edits the note and moves it. The chain now records `new.md`, while the
    // local file — and the path the user has open — is still `old.md`.
    const movedFileId = target.fileIdForPath("old.md")!;
    await api.remoteEdit(movedFileId, "old v2");
    await api.remoteRename(movedFileId, await encryptString(key, "new.md"));
    await api.remoteEdit(target.fileIdForPath("z.md")!, "z v2");
    api.contentFetches.length = 0;

    await target.initialSync({ priorityPaths: ["old.md"] });

    expect(api.contentFetches).toHaveLength(2);
    expect(api.contentFetches[0]).toBe(await sha256Hex(encoder.encode("old v2")));
    expect(new TextDecoder().decode(targetAdapter.files.get("new.md"))).toBe("old v2");
  });

  it("orders the files nobody listed by the local modification time, newest first", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("old.md", encoder.encode("old"));
    adapter.files.set("new.md", encoder.encode("new"));
    adapter.files.set("mid.md", encoder.encode("mid"));
    adapter.files.touch("old.md", 1_000);
    adapter.files.touch("new.md", 3_000);
    adapter.files.touch("mid.md", 2_000);

    await engine.initialSync();

    const pushedPaths = await Promise.all(
      api.pushed.map((push) => decryptString(key, push.encryptedPath)),
    );
    expect(pushedPaths).toEqual(["new.md", "mid.md", "old.md"]);
  });

  it("pushes a local file the host named before the other creates", async () => {
    const { engine, adapter, api, key } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a"));
    adapter.files.set("b.md", encoder.encode("b"));
    adapter.files.set("c.md", encoder.encode("c"));

    await engine.initialSync({ priorityPaths: ["b.md"] });

    const pushedPaths = await Promise.all(
      api.pushed.map((push) => decryptString(key, push.encryptedPath)),
    );
    expect(pushedPaths).toEqual(["b.md", "c.md", "a.md"]);
  });
});

/**
 * A bound, not a speed: the pass must not open one connection (and hold one file's
 * plaintext and ciphertext) per pending change on a phone. The pool's own edge cases
 * are pinned in `work-pool.test.ts`; what these cases prove is that the engine
 * actually sizes its per-file work with it, and that the size rule sees the bytes.
 */
async function prepareChanges(
  count: number,
  opLimits: { maxConcurrent: number; exclusiveBytes: number },
  padding = "",
  platform: Platform = realPlatform,
) {
  const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
  for (let index = 0; index < count; index++) {
    sourceAdapter.files.set(`n-${index}.md`, encoder.encode(`${padding}n-${index} v1`));
  }
  await source.initialSync();

  const targetAdapter = new FakeAdapter();
  const target = new SyncEngine({
    platform,
    vaultId: "vault-1",
    adapter: targetAdapter,
    api,
    encryptionKey: key,
    opLimits,
    // The cases below measure the pool's concurrency *inside* the wave batch, which a
    // read-ahead would answer from its store; its own bound is pinned separately.
    contentPrefetch: false,
  });
  // The bind gives the target a sync point (and a local copy) for every file.
  await target.initialSync();
  for (let index = 0; index < count; index++) {
    await api.remoteEdit(target.fileIdForPath(`n-${index}.md`)!, `${padding}n-${index} v2`);
  }

  api.contentFetches.length = 0;
  api.contentBatchCalls.length = 0;
  api.maxInFlightContent = 0;
  api.contentDelayMs = 10;
  return { target, api };
}

describe("SyncEngine — how much a pass runs at once", () => {
  it("pulls small files concurrently, up to the pool's limit", async () => {
    // The timer is held forever so a wave is exactly the pool's width: the read that fills
    // it is what flushes it, and a real 0 ms turn cannot split it on a loaded runner (which
    // the route accepts — see "sends a partial wave on the next turn").
    const { target, api } = await prepareChanges(
      9,
      { maxConcurrent: 3, exclusiveBytes: 1_024 },
      "",
      noTurnTimers,
    );

    await target.initialSync();

    // Every version still comes back once, and the pool's concurrency now shows *inside*
    // the content requests: three files travel together instead of three requests.
    expect(api.contentFetches).toHaveLength(9);
    const sizes = api.contentBatchCalls.map((call) => call.length);
    expect(sizes).toEqual([3, 3, 3]);
    expect(sizes.every((size) => size <= 3)).toBe(true);
  });

  it("runs a file at or above exclusiveBytes alone", async () => {
    const { target, api } = await prepareChanges(
      4,
      { maxConcurrent: 3, exclusiveBytes: 8 },
      "0123456789abcdef",
    );

    await target.initialSync();

    expect(api.contentFetches).toHaveLength(4);
    // Every file is over the exclusive bound, so no two reads may share a batch.
    expect(api.contentBatchCalls.every((call) => call.length === 1)).toBe(true);
  });

  it("weighs a local file by its own size, not only the size the head records", async () => {
    // A local edit can make the file much larger than the version the server holds. The
    // pass has to read those bytes to push them, so the local stamp's size is what
    // decides whether the file runs alone.
    const { engine: source, adapter: sourceAdapter, api, key } = await makeEngine();
    sourceAdapter.files.set("a.md", encoder.encode("a"));
    sourceAdapter.files.set("b.md", encoder.encode("b"));
    await source.initialSync();

    const targetAdapter = new FakeAdapter();
    const target = new SyncEngine({
      platform: realPlatform,
      vaultId: "vault-1",
      adapter: targetAdapter,
      api,
      encryptionKey: key,
      opLimits: { maxConcurrent: 2, exclusiveBytes: 64 },
    });
    await target.initialSync();

    targetAdapter.files.set("a.md", encoder.encode("a2"));
    targetAdapter.files.set("b.md", encoder.encode("b".repeat(200)));
    api.pushCalls.length = 0;
    api.maxInFlightPush = 0;
    api.pushDelayMs = 10;

    await target.initialSync();

    expect(api.pushCalls).toHaveLength(2);
    // `b.md` is at or above the exclusive bound locally, so it never shares the pool.
    expect(api.maxInFlightPush).toBe(1);
  });

  it("keeps the other files going when one per-file operation throws", async () => {
    const { engine, adapter, api } = await makeEngine();
    adapter.files.set("a.md", encoder.encode("a v1"));
    adapter.files.set("b.md", encoder.encode("b v1"));
    await engine.initialSync();
    const aFileId = engine.fileIdForPath("a.md")!;
    const bFileId = engine.fileIdForPath("b.md")!;

    adapter.files.set("a.md", encoder.encode("a v2"));
    adapter.files.set("b.md", encoder.encode("b v2"));

    // The pass's own listing hashes each file once; the per-file push reads it again.
    // Fail that second read for A only, so the throw happens inside one pool task.
    let readsOfA = 0;
    const originalRead = adapter.readFile.bind(adapter);
    adapter.readFile = async (path) => {
      if (path === "a.md" && ++readsOfA > 1) throw new Error("EACCES: a.md");
      return await originalRead(path);
    };

    await expect(engine.initialSync()).rejects.toThrow("EACCES");

    // B's edit still reached the server; A's did not, and A is retried next pass.
    expect(api.chains.get(bFileId)!).toHaveLength(2);
    expect(api.chains.get(aFileId)!).toHaveLength(1);
  });
});
