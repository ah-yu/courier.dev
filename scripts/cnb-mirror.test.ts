/**
 * Tests for `cnb-mirror.ts`, the GitHub-release → CNB-release mirror.
 *
 * The script talks to one external API, so the cases below drive it against a
 * small in-memory CNB: a release store, a pre-signed upload endpoint and a
 * confirmation endpoint. That keeps the assertions on the real wire contract
 * (paths, bodies, auth headers, idempotency) without a network or a token.
 */
import assert from "assert/strict";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, test } from "vitest";

import {
  CnbApiError,
  buildAliasBody,
  buildReleaseBody,
  describeAssets,
  isPrerelease,
  mirror,
  parseArgs,
  planUploads,
  type CnbRelease,
  type FetchLike,
  type MirrorAsset,
} from "./cnb-mirror.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "courier-cnb-mirror-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeAssets(files: Record<string, string>): string {
  const root = scratch();
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, name), content);
  }
  return root;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Call {
  url: string;
  method: string;
  body?: string;
  authorization: string | null;
  blobSize?: number;
}

interface FakeOptions {
  existing?: CnbRelease[];
  fail?: (url: string) => Response | undefined;
  wrongHash?: boolean;
  missingHash?: boolean;
  wrongSize?: boolean;
}

/** An in-memory CNB release API with the endpoints the script uses. */
function fakeCnb(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const releases = new Map<string, CnbRelease>();
  const uploads = new Map<
    string,
    { releaseId: string; size: number; sha256: string; bytes: Uint8Array }
  >();
  let nextId = 1;

  for (const release of options.existing ?? []) {
    releases.set(release.tag_name, {
      ...release,
      assets: (release.assets ?? []).map((asset) => ({ ...asset })),
    });
  }

  const releaseById = (id: string): CnbRelease | undefined => {
    for (const release of releases.values()) if (release.id === id) return release;
    return undefined;
  };

  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : undefined;
    const headers = new Headers(init.headers);
    const blob = init.body instanceof Blob ? init.body : undefined;
    calls.push({
      url,
      method,
      body,
      authorization: headers.get("authorization"),
      blobSize: blob?.size,
    });

    const failed = options.fail?.(url);
    if (failed !== undefined) return failed;

    const path = new URL(url).pathname;
    const tagMatch = /^\/ah-yu\/courier\/-\/releases\/tags\/(.+)$/.exec(path);
    if (tagMatch !== null && method === "GET") {
      const tag = decodeURIComponent(tagMatch[1]);
      const release = releases.get(tag);
      if (release === undefined) {
        return json({ errcode: 5, errmsg: `release for tag ${tag} not found` }, 404);
      }
      return json(release);
    }

    if (path === "/ah-yu/courier/-/releases" && method === "POST") {
      const payload = JSON.parse(body ?? "{}");
      const release: CnbRelease = {
        id: `r${nextId++}`,
        tag_name: payload.tag_name,
        name: payload.name,
        body: payload.body,
        draft: payload.draft,
        prerelease: payload.prerelease,
        assets: [],
      };
      releases.set(release.tag_name, release);
      return json(release, 201);
    }

    const releaseMatch = /^\/ah-yu\/courier\/-\/releases\/([^/]+)$/.exec(path);
    if (releaseMatch !== null && method === "GET") {
      const release = releaseById(releaseMatch[1]);
      return release === undefined ? json({ errmsg: "release not found" }, 404) : json(release);
    }
    if (releaseMatch !== null && method === "PATCH") {
      const release = releaseById(releaseMatch[1]);
      if (release === undefined) return json({ errmsg: "release not found" }, 404);
      const payload = JSON.parse(body ?? "{}");
      release.name = payload.name ?? release.name;
      release.body = payload.body ?? release.body;
      release.prerelease = payload.prerelease ?? release.prerelease;
      if (payload.draft !== undefined) release.draft = payload.draft;
      return json(release);
    }

    const uploadMatch = /^\/ah-yu\/courier\/-\/releases\/([^/]+)\/asset-upload-url$/.exec(path);
    if (uploadMatch !== null && method === "POST") {
      const payload = JSON.parse(body ?? "{}");
      return json(
        {
          upload_url: `https://upload.test/${uploadMatch[1]}/${payload.asset_name}`,
          verify_url: `https://verify.test/${uploadMatch[1]}/${payload.asset_name}`,
          expires_in_sec: 3600,
        },
        201,
      );
    }

    if (url.startsWith("https://upload.test/")) {
      const [, releaseId, name] = /^https:\/\/upload\.test\/([^/]+)\/(.+)$/.exec(url) ?? [];
      if (blob === undefined || releaseId === undefined || name === undefined) {
        throw new Error(`bad upload request: ${url}`);
      }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      uploads.set(name, {
        releaseId,
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes,
      });
      return new Response(null, { status: 200 });
    }

    if (url.startsWith("https://verify.test/")) {
      const [, releaseId, name] = /^https:\/\/verify\.test\/([^/]+)\/(.+)$/.exec(url) ?? [];
      const upload = name === undefined ? undefined : uploads.get(name);
      const release = releaseId === undefined ? undefined : releaseById(releaseId);
      if (upload === undefined || release === undefined || name === undefined) {
        throw new Error(`bad verify request: ${url}`);
      }
      release.assets = release.assets ?? [];
      release.assets.push({
        name,
        size: upload.size + (options.wrongSize === true ? 1 : 0),
        hash_algo: options.missingHash === true ? undefined : "sha256",
        hash_value:
          options.missingHash === true
            ? undefined
            : options.wrongHash === true
              ? "0".repeat(64)
              : upload.sha256,
      });
      return new Response(null, { status: 200 });
    }

    const deleteMatch = /^\/ah-yu\/courier\/-\/releases\/([^/]+)\/assets\/([^/]+)$/.exec(path);
    if (deleteMatch !== null && method === "DELETE") {
      const release = releaseById(deleteMatch[1]);
      if (release !== undefined) {
        release.assets = (release.assets ?? []).filter((asset) => asset.id !== deleteMatch[2]);
      }
      return new Response(null, { status: 204 });
    }

    if (path.includes("/-/releases/download/") && method === "GET") {
      const name = decodeURIComponent(path.split("/").pop() ?? "");
      const upload = uploads.get(name);
      if (upload === undefined) return new Response(null, { status: 404 });
      return new Response(upload.bytes.slice().buffer, { status: 200 });
    }

    if (path.includes("/-/releases/download/") && method === "HEAD") {
      const name = decodeURIComponent(path.split("/").pop() ?? "");
      const upload = uploads.get(name);
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(upload?.size ?? 0) },
      });
    }

    throw new Error(`unexpected request: ${method} ${url}`);
  };

  return { fetchImpl, calls, releases };
}

const NOOP_DEPS = { sleep: async () => {}, log: () => {} };

test("isPrerelease follows release.yml's hyphen rule", () => {
  assert.equal(isPrerelease("v0.1.0"), false);
  assert.equal(isPrerelease("v0.1.0-rc.1"), true);
  assert.equal(isPrerelease("0.1.0-beta"), true);
  assert.equal(isPrerelease("latest"), false);
});

test("describeAssets lists regular, non-hidden files with size and sha256", async () => {
  const dir = writeAssets({ "b.txt": "bee", "a.txt": "aye", ".hidden": "ignored" });
  const assets = await describeAssets(dir);

  assert.deepEqual(
    assets.map((asset) => asset.name),
    ["a.txt", "b.txt"],
  );
  assert.equal(assets[0].size, 3);
  assert.equal(assets[0].sha256, sha256("aye"));
  assert.equal(assets[1].sha256, sha256("bee"));
});

test("describeAssets refuses a nested directory and an empty directory", async () => {
  const withDir = writeAssets({ "a.txt": "aye" });
  mkdirSync(join(withDir, "nested"));
  await assert.rejects(() => describeAssets(withDir), /non-file entry: nested/);

  const empty = scratch();
  await assert.rejects(() => describeAssets(empty), /no assets found/);
});

test("planUploads skips only a same-name, same-size, same-sha256 asset", () => {
  const local: MirrorAsset[] = [
    { name: "same", path: "/same", size: 3, sha256: sha256("one") },
    { name: "changed", path: "/changed", size: 3, sha256: sha256("two") },
    { name: "missing", path: "/missing", size: 3, sha256: sha256("three") },
    { name: "unhashed", path: "/unhashed", size: 3, sha256: sha256("four") },
  ];
  const plan = planUploads(local, [
    { name: "same", size: 3, hash_algo: "sha256", hash_value: sha256("one") },
    { name: "changed", size: 3, hash_algo: "sha256", hash_value: sha256("different") },
    { name: "unhashed", size: 3 },
  ]);

  assert.deepEqual(
    plan.skip.map((asset) => asset.name),
    ["same"],
  );
  assert.deepEqual(
    plan.upload.map((asset) => asset.name),
    ["changed", "missing", "unhashed"],
  );
});

test("parseArgs normalizes a refs/tags prefix and rejects unknown or missing flags", () => {
  const cli = parseArgs([
    "--repo",
    "ah-yu/courier",
    "--tag=refs/tags/v0.1.0",
    "--target-sha",
    "a".repeat(40),
    "--assets",
    "dist",
    "--dry-run",
  ]);

  assert.equal(cli.tag, "v0.1.0");
  assert.equal(cli.dryRun, true);
  assert.equal(cli.repo, "ah-yu/courier");
  assert.throws(
    () => parseArgs(["--repo", "a/b", "--tag", "v1", "--target-sha", "x"]),
    /missing --assets/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--repo",
        "a/b",
        "--tag",
        "v1",
        "--target-sha",
        "x",
        "--assets",
        "d",
        "--unknown",
        "x",
      ]),
    /unknown flag: --unknown/,
  );
  assert.throws(
    () => parseArgs(["--repo", "a/b", "--tag", "--dry-run", "--target-sha", "x", "--assets", "d"]),
    /--tag needs a value/,
  );
  assert.equal(
    parseArgs([
      "--repo",
      "a/b",
      "--tag",
      "v1",
      "--target-sha",
      "x",
      "--assets",
      "d",
      "--no-make-latest",
    ]).makeLatest,
    false,
  );
});

test("release bodies carry provenance and the checksum instruction", () => {
  const stable = buildReleaseBody(
    "What changed",
    "v0.1.0",
    "https://github.com/o/r/releases/tag/v0.1.0",
  );
  assert.match(stable, /What changed/);
  assert.match(stable, /\[v0\.1\.0\]\(https:\/\/github\.com\/o\/r\/releases\/tag\/v0\.1\.0\)/);
  assert.match(stable, /byte-identical/);
  assert.match(stable, /sha256sum -c checksums\.txt/);

  const alias = buildAliasBody("v0.1.0", "https://github.com/o/r/releases/tag/v0.1.0");
  assert.match(alias, /Latest stable Courier build/);
  assert.match(alias, /replaced on each stable release/);
});

test("mirror creates the release and verifies every uploaded asset", async () => {
  const dir = writeAssets({
    "checksums.txt": "abc  binary",
    "manifest.json": '{"version":"0.1.0"}',
  });
  const fake = fakeCnb();
  const result = await mirror({
    repo: "ah-yu/courier",
    tag: "v0.1.0",
    targetSha: "a".repeat(40),
    assetsDir: dir,
    body: "Release notes",
    sourceUrl: "https://github.com/ah-yu/courier.dev/releases/tag/v0.1.0",
    token: "test-token",
    deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
  });

  assert.equal(result.uploaded, 2);
  assert.equal(result.dryRun, false);
  assert.equal(result.alias, undefined);
  assert.ok(fake.releases.has("v0.1.0"));
  const create = fake.calls.find(
    (call) => call.method === "POST" && call.url.endsWith("/releases"),
  );
  assert.ok(create?.body);
  assert.equal(JSON.parse(create.body).make_latest, "false");
  assert.equal(JSON.parse(create.body).draft, true);
  assert.equal(JSON.parse(create.body).prerelease, false);
  assert.equal(create.authorization, "Bearer test-token");
  assert.equal(fake.calls.filter((call) => call.method === "PUT").length, 2);

  const publish = fake.calls.filter((call) => call.method === "PATCH").at(-1);
  assert.ok(publish?.body);
  assert.equal(JSON.parse(publish.body).draft, false);
  assert.equal(JSON.parse(publish.body).make_latest, "true");
  assert.equal(fake.releases.get("v0.1.0")?.draft, false);
});

test("mirror patches an existing release and skips an unchanged asset", async () => {
  const dir = writeAssets({ "a.txt": "same", "b.txt": "new" });
  const fake = fakeCnb({
    existing: [
      {
        id: "r1",
        tag_name: "v0.1.0",
        name: "old title",
        assets: [{ name: "a.txt", size: 4, hash_algo: "sha256", hash_value: sha256("same") }],
      },
    ],
  });

  const result = await mirror({
    repo: "ah-yu/courier",
    tag: "v0.1.0",
    targetSha: "b".repeat(40),
    assetsDir: dir,
    token: "test-token",
    deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
  });

  assert.equal(result.uploaded, 1);
  assert.equal(result.skipped, 1);
  assert.equal(
    fake.calls.filter((call) => call.method === "POST" && call.url.endsWith("/releases")).length,
    0,
  );
  assert.equal(fake.calls.filter((call) => call.method === "PATCH").length, 2);
  assert.equal(fake.calls.filter((call) => call.method === "PUT").length, 1);
});

test("mirror also fills the latest alias for a stable release", async () => {
  const dir = writeAssets({ "a.txt": "aye" });
  const fake = fakeCnb();
  const result = await mirror({
    repo: "ah-yu/courier",
    tag: "v0.1.0",
    targetSha: "c".repeat(40),
    assetsDir: dir,
    latestTag: "latest",
    token: "test-token",
    deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
  });

  assert.ok(result.alias);
  assert.equal(result.alias?.uploaded, 1);
  assert.ok(fake.releases.has("latest"));
  assert.equal(fake.calls.filter((call) => call.method === "PUT").length, 2);
  const aliasCreate = fake.calls.filter(
    (call) => call.method === "POST" && call.url.endsWith("/releases"),
  )[1];
  assert.ok(aliasCreate?.body);
  assert.equal(JSON.parse(aliasCreate.body).tag_name, "latest");
  assert.equal(JSON.parse(aliasCreate.body).make_latest, "false");
  assert.equal(JSON.parse(aliasCreate.body).draft, true);

  const aliasPublish = fake.calls.filter((call) => call.method === "PATCH").at(-1);
  assert.ok(aliasPublish?.body);
  assert.equal(JSON.parse(aliasPublish.body).draft, false);

  // The confirmation URL is on another origin in this fake; the release token
  // must not be sent there.
  const confirm = fake.calls.find((call) => call.url.startsWith("https://verify.test/"));
  assert.equal(confirm?.authorization, null);
});

test("mirror prunes the previous plugin zip from the latest alias", async () => {
  const dir = writeAssets({ "a.txt": "aye" });
  const fake = fakeCnb({
    existing: [
      {
        id: "alias-1",
        tag_name: "latest",
        name: "Courier latest (v0.0.9)",
        assets: [
          {
            id: "old-zip",
            name: "courier-plugin-0.0.9.zip",
            size: 4,
            hash_algo: "sha256",
            hash_value: sha256("old!"),
          },
        ],
      },
    ],
  });

  await mirror({
    repo: "ah-yu/courier",
    tag: "v0.1.0",
    targetSha: "3".repeat(40),
    assetsDir: dir,
    latestTag: "latest",
    token: "test-token",
    deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
  });

  const deletes = fake.calls.filter((call) => call.method === "DELETE");
  assert.equal(deletes.length, 1);
  assert.match(deletes[0].url, /\/assets\/old-zip$/);
  assert.deepEqual(
    fake.releases.get("latest")?.assets?.map((asset) => asset.name),
    ["a.txt"],
  );
});

test("mirror leaves the latest alias alone when makeLatest is false", async () => {
  const dir = writeAssets({ "a.txt": "aye" });
  const fake = fakeCnb();

  const result = await mirror({
    repo: "ah-yu/courier",
    tag: "v0.1.0",
    targetSha: "4".repeat(40),
    assetsDir: dir,
    latestTag: "latest",
    makeLatest: false,
    token: "test-token",
    deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
  });

  assert.equal(result.alias, undefined);
  assert.equal(fake.releases.has("latest"), false);
  const publish = fake.calls.filter((call) => call.method === "PATCH").at(-1);
  assert.ok(publish?.body);
  assert.equal(JSON.parse(publish.body).make_latest, "false");
});

test("the upload request declares the asset size, overwrite and ttl", async () => {
  const dir = writeAssets({ "a.bin": "12345" });
  const fake = fakeCnb();

  await mirror({
    repo: "ah-yu/courier",
    tag: "v0.1.0",
    targetSha: "5".repeat(40),
    assetsDir: dir,
    token: "test-token",
    deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
  });

  const request = fake.calls.find(
    (call) => call.method === "POST" && call.url.endsWith("/asset-upload-url"),
  );
  assert.ok(request?.body);
  assert.deepEqual(JSON.parse(request.body), {
    asset_name: "a.bin",
    size: 5,
    overwrite: true,
    ttl: 0,
  });
});

test("a remote size mismatch fails the mirror", async () => {
  const dir = writeAssets({ "a.txt": "aye" });
  const fake = fakeCnb({ wrongSize: true });

  await assert.rejects(
    () =>
      mirror({
        repo: "ah-yu/courier",
        tag: "v0.1.0",
        targetSha: "6".repeat(40),
        assetsDir: dir,
        token: "test-token",
        deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
      }),
    /is 4 bytes, expected 3/,
  );
});

test("mirror refuses a missing token before reading the assets", async () => {
  const fake = fakeCnb({
    fail: () => {
      throw new Error("must not call the API without a token");
    },
  });

  await assert.rejects(
    () =>
      mirror({
        repo: "ah-yu/courier",
        tag: "v0.1.0",
        targetSha: "7".repeat(40),
        assetsDir: "this-directory-does-not-exist",
        token: "",
        deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
      }),
    /CNB_TOKEN is not set/,
  );
});

test("a prerelease never touches the latest alias", async () => {
  const dir = writeAssets({ "a.txt": "aye" });
  const fake = fakeCnb();
  const result = await mirror({
    repo: "ah-yu/courier",
    tag: "v0.1.0-rc.1",
    targetSha: "d".repeat(40),
    assetsDir: dir,
    latestTag: "latest",
    token: "test-token",
    deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
  });

  assert.equal(result.alias, undefined);
  assert.equal(fake.releases.has("latest"), false);
  const create = fake.calls.find(
    (call) => call.method === "POST" && call.url.endsWith("/releases"),
  );
  assert.ok(create?.body);
  assert.equal(JSON.parse(create.body).prerelease, true);
  assert.equal(JSON.parse(create.body).make_latest, "false");
});

test("a 401 surfaces the CNB error without leaking the token", async () => {
  const dir = writeAssets({ "a.txt": "aye" });
  const fake = fakeCnb({
    fail: () => json({ errmsg: "The task will not run because the user is not logged in." }, 401),
  });

  await assert.rejects(
    () =>
      mirror({
        repo: "ah-yu/courier",
        tag: "v0.1.0",
        targetSha: "e".repeat(40),
        assetsDir: dir,
        token: "super-secret-token",
        deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
      }),
    (error: unknown) => {
      assert.ok(error instanceof CnbApiError);
      assert.equal(error.status, 401);
      assert.match(error.message, /not logged in/);
      assert.doesNotMatch(error.message, /super-secret-token/);
      return true;
    },
  );
});

test("a remote hash mismatch fails the mirror", async () => {
  const dir = writeAssets({ "a.txt": "aye" });
  const fake = fakeCnb({ wrongHash: true });

  await assert.rejects(
    () =>
      mirror({
        repo: "ah-yu/courier",
        tag: "v0.1.0",
        targetSha: "f".repeat(40),
        assetsDir: dir,
        token: "test-token",
        deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
      }),
    /has sha256/,
  );
});

test("a release without a remote hash is verified by downloading the asset", async () => {
  const dir = writeAssets({ "a.txt": "aye" });
  const fake = fakeCnb({ missingHash: true });

  const result = await mirror({
    repo: "ah-yu/courier",
    tag: "v0.1.0",
    targetSha: "1".repeat(40),
    assetsDir: dir,
    token: "test-token",
    deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
  });

  assert.equal(result.uploaded, 1);
  assert.equal(
    fake.calls.filter((call) => call.method === "GET" && call.url.includes("/releases/download/"))
      .length,
    1,
  );
});

test("dry run makes no request and needs no token", async () => {
  const dir = writeAssets({ "a.txt": "aye" });
  const fake = fakeCnb({
    fail: () => {
      throw new Error("dry run must not call the API");
    },
  });

  const result = await mirror({
    repo: "ah-yu/courier",
    tag: "v0.1.0",
    targetSha: "2".repeat(40),
    assetsDir: dir,
    latestTag: "latest",
    dryRun: true,
    deps: { fetch: fake.fetchImpl, ...NOOP_DEPS },
  });

  assert.equal(result.dryRun, true);
  assert.equal(fake.calls.length, 0);
});
