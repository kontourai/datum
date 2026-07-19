import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serializeCatalog } from "@kontourai/bearing";
import { DatumError, loadCapabilityCatalog, loadConfig, refreshCapabilityCatalog, resolve, resolveRef, validateConfig } from "../src/index.js";
import { sourceFromOptions } from "../src/catalog/source.js";
import { tempTree } from "./helpers.js";
import {
  REMOTE_URL as URL,
  clock,
  catalog,
  config,
  stateFiles,
  seed,
  rejectsCode,
} from "./catalog-fixtures.js";

test("catalog refresh: first remote fetch stores a validated content-addressed snapshot and active state", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  const snapshot = catalog();
  try {
    t.writeRepo(config());

    const result = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: clock,
      transport: async (_url, _init, target) => {
        assert.deepEqual(target.addresses, [{ address: "93.184.216.34", family: 4 }]);
        return new Response(serializeCatalog(snapshot), { status: 200, headers: { etag: '"v1"' } });
      },
    });

    assert.equal(result.catalog.digest, snapshot.digest);
    assert.equal(result.metadata.digest, snapshot.digest);
    assert.equal(result.metadata.source.kind, "remote");
    assert.equal(result.metadata.source.location, "https://93.184.216.34/<redacted>");
    assert.equal(result.metadata.fetchedAt, "2026-07-18T00:01:00.000Z");
    assert.equal(existsSync(path.join(cacheRoot, "snapshots", `${snapshot.digest}.json`)), true);
    const files = stateFiles(cacheRoot, result.metadata.source.key);
    assert.equal(files.length, 1);
    const state = JSON.parse(readFileSync(files[0], "utf8"));
    assert.equal(state.digest, snapshot.digest);
    assert.equal(state.etag, '"v1"');
  } finally {
    t.cleanup();
  }
});
test("catalog refresh: sends ETag and accepts 304 without replacing the active snapshot", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    const first = await seed(t, cacheRoot);
    let receivedEtag: string | undefined;
    const refreshed = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
      transport: async (_url, init) => {
        receivedEtag = init.headers?.["if-none-match"];
        return new Response(null, { status: 304 });
      },
    });
    assert.equal(receivedEtag, '"v1"');
    assert.equal(refreshed.metadata.notModified, true);
    assert.equal(refreshed.metadata.fallback, false);
    assert.equal(refreshed.catalog.digest, first.catalog.digest);
    assert.equal(refreshed.metadata.fetchedAt, "2026-07-18T00:02:00.000Z");
  } finally {
    t.cleanup();
  }
});

test("catalog load is offline and refresh failure returns a valid cache with an explicit diagnostic", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    const first = await seed(t, cacheRoot);
    const loaded = loadCapabilityCatalog({ cwd: t.cwd, home: t.home, cacheRoot, now: clock });
    assert.equal(loaded.catalog.digest, first.catalog.digest);
    const fallback = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: clock,
      transport: async () => { throw new Error("offline"); },
    });
    assert.equal(fallback.metadata.fallback, true);
    assert.equal(fallback.metadata.diagnostics[0]?.code, "CAPABILITY_CATALOG_UNAVAILABLE");
    assert.match(fallback.metadata.diagnostics[0]?.message ?? "", /offline/);
    assert.equal(fallback.catalog.digest, first.catalog.digest);
  } finally {
    t.cleanup();
  }
});

test("catalog refresh: fallback freshness is evaluated when a delayed request completes", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  let failRefresh!: (error: Error) => void;
  const delayedFailure = new Promise<Response>((_resolve, reject) => { failRefresh = reject; });
  let currentTime = "2026-07-18T00:00:30.000Z";
  try {
    await seed(t, cacheRoot, catalog("2026-07-18T00:00:00.000Z"));
    t.writeRepo(config(URL, 60));
    const refresh = refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date(currentTime),
      transport: async () => delayedFailure,
    });

    currentTime = "2026-07-18T00:02:00.000Z";
    failRefresh(new Error("offline"));
    await rejectsCode(() => refresh, "CAPABILITY_CATALOG_STALE");
  } finally {
    t.cleanup();
  }
});

test("catalog refresh: malformed, unsupported, and digest-mismatched responses preserve last valid state", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    const first = await seed(t, cacheRoot);
    const mismatched = JSON.parse(serializeCatalog(catalog())) as Record<string, unknown>;
    mismatched.digest = "0".repeat(64);
    const cases: Array<[string, string, string]> = [
      ["malformed", "not json", "CAPABILITY_CATALOG_MALFORMED"],
      ["unsupported", JSON.stringify({ schemaVersion: "bearing.catalog/v999" }), "CAPABILITY_CATALOG_UNSUPPORTED_SCHEMA"],
      ["digest mismatch", JSON.stringify(mismatched), "CAPABILITY_CATALOG_DIGEST_MISMATCH"],
    ];
    for (const [, body, code] of cases) {
      const fallback = await refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot,
        now: clock,
        transport: async () => new Response(body, { status: 200 }),
      });
      assert.equal(fallback.catalog.digest, first.catalog.digest);
      assert.equal(fallback.metadata.fallback, true);
      assert.equal(fallback.metadata.diagnostics[0]?.code, code);
      assert.equal(loadCapabilityCatalog({ cwd: t.cwd, home: t.home, cacheRoot, now: clock }).catalog.digest, first.catalog.digest);
    }
  } finally {
    t.cleanup();
  }
});

test("catalog: local snapshots validate directly and catalog config preserves static resolution", () => {
  const t = tempTree();
  const file = path.join(t.cwd, "catalog.json");
  const snapshot = catalog();
  try {
    writeFileSync(file, serializeCatalog(snapshot));
    t.writeRepo({
      capabilityCatalog: { localPath: "catalog.json" },
      providers: { local: { kind: "openai-compatible", auth: { env: "LOCAL_KEY" }, models: ["model"] } },
      roles: { worker: "model@local" },
    });
    const loaded = loadCapabilityCatalog({ cwd: t.cwd, home: t.home, now: clock });
    assert.equal(loaded.catalog.digest, snapshot.digest);
    assert.equal(loaded.metadata.source.kind, "local");
    assert.equal(resolveRef("worker", { cwd: t.cwd, home: t.home, env: { LOCAL_KEY: "x" } }).model, "model");
    assert.equal(resolve("worker", { cwd: t.cwd, home: t.home, env: { LOCAL_KEY: "x" } }).apiKey, "x");
  } finally {
    t.cleanup();
  }
});

test("catalog: typed malformed, stale, unsupported, and digest mismatch errors do not need a network call", async () => {
  const t = tempTree();
  const file = path.join(t.cwd, "catalog.json");
  try {
    t.writeRepo({ capabilityCatalog: { localPath: "catalog.json" } });
    writeFileSync(file, "not json");
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, now: clock }),
      (error: unknown) => {
        assert.ok(error instanceof DatumError);
        assert.equal(error.code, "CAPABILITY_CATALOG_MALFORMED");
        assert.equal(error.message, "local capability catalog is not a valid Bearing catalog.");
        assert.doesNotMatch(error.message, /catalog\.json|not json|Users/);
        return true;
      },
    );
    writeFileSync(file, JSON.stringify({ schemaVersion: "bearing.catalog/v999" }));
    assert.throws(() => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, now: clock }), (err: unknown) => err instanceof DatumError && err.code === "CAPABILITY_CATALOG_UNSUPPORTED_SCHEMA");
    const mismatched = JSON.parse(serializeCatalog(catalog())) as Record<string, unknown>;
    mismatched.digest = "0".repeat(64);
    writeFileSync(file, JSON.stringify(mismatched));
    assert.throws(() => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, now: clock }), (err: unknown) => err instanceof DatumError && err.code === "CAPABILITY_CATALOG_DIGEST_MISMATCH");
    writeFileSync(file, serializeCatalog(catalog("2026-07-18T00:00:00.000Z")));
    t.writeRepo({ capabilityCatalog: { localPath: "catalog.json", maxAgeSeconds: 1 } });
    assert.throws(() => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, now: () => new Date("2026-07-18T00:00:02.000Z") }), (err: unknown) => err instanceof DatumError && err.code === "CAPABILITY_CATALOG_STALE");
    t.writeRepo(config());
    await rejectsCode(() => refreshCapabilityCatalog({ cwd: t.cwd, home: t.home, cacheRoot: path.join(t.dir, "none"), now: clock, transport: async () => { throw new Error("no network"); } }), "CAPABILITY_CATALOG_UNAVAILABLE");
  } finally {
    t.cleanup();
  }
});

test("catalog refresh: response limit and insecure URL policy block transport before cache replacement", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    const first = await seed(t, cacheRoot);
    const tooLarge = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: clock,
      maxResponseBytes: 1,
      transport: async () => new Response(serializeCatalog(catalog()), { status: 200 }),
    });
    assert.equal(tooLarge.metadata.diagnostics[0]?.code, "CAPABILITY_CATALOG_RESPONSE_TOO_LARGE");
    assert.equal(tooLarge.catalog.digest, first.catalog.digest);
    let advertisedBodyCancelled = false;
    const advertisedTooLarge = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: clock,
      maxResponseBytes: 1,
      transport: async () => new Response(new ReadableStream({
        pull() {
          // Intentionally remain open until the consumer cancels.
        },
        cancel() {
          advertisedBodyCancelled = true;
        },
      }), { status: 200, headers: { "content-length": "2" } }),
    });
    assert.equal(advertisedTooLarge.metadata.diagnostics[0]?.code, "CAPABILITY_CATALOG_RESPONSE_TOO_LARGE");
    assert.equal(advertisedBodyCancelled, true);
    const oversizedEtag = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: clock,
      transport: async () => new Response(serializeCatalog(catalog()), {
        status: 200,
        headers: { etag: "x".repeat(8 * 1024 + 1) },
      }),
    });
    assert.equal(oversizedEtag.metadata.diagnostics[0]?.code, "CAPABILITY_CATALOG_LIMIT_EXCEEDED");
    assert.equal(oversizedEtag.catalog.digest, first.catalog.digest);
    t.writeRepo(config("http://catalog.example/snapshot.json"));
    let calls = 0;
    await rejectsCode(() => refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: path.join(t.dir, "other-cache"),
      now: clock,
      transport: async () => { calls += 1; return new Response(serializeCatalog(catalog()), { status: 200 }); },
    }), "CAPABILITY_CATALOG_INSECURE_URL");
    assert.equal(calls, 0);
    const allowed = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: path.join(t.dir, "other-cache"),
      now: clock,
      allowInsecure: true,
      resolveHost: async () => ["93.184.216.34"],
      transport: async () => { calls += 1; return new Response(serializeCatalog(catalog()), { status: 200 }); },
    });
    assert.equal(calls, 1);
    assert.equal(allowed.metadata.source.kind, "remote");
    assert.equal(allowed.metadata.warnings.length, 1);
    assert.match(allowed.metadata.warnings[0] ?? "", /plaintext http/);
  } finally {
    t.cleanup();
  }
});

test("catalog config validation requires one source and a positive max age", () => {
  for (const capabilityCatalog of [
    {},
    { remoteUrl: URL, localPath: "catalog.json" },
    { remoteUrl: URL, maxAgeSeconds: 0 },
    { remoteUrl: "https://user:password@catalog.example/snapshot.json" },
    { remoteUrl: "https://catalog.example/snapshot.json?token=secret" },
    { remoteUrl: "https:catalog.example/snapshot.json" },
    { remoteUrl: " https://catalog.example/snapshot.json " },
    { remoteUrl: "\nhttps://catalog.example/snapshot.json" },
    { remoteUrl: "https://catalog.example/snapshot.json?" },
    { remoteUrl: "https://catalog.example/snapshot.json#" },
  ]) {
    assert.throws(() => validateConfig({ capabilityCatalog }), (err: unknown) => err instanceof DatumError && err.code === "INVALID_CONFIG");
  }
});

test("catalog config canonicalizes equivalent accepted remote URLs before source identity", () => {
  const t = tempTree();
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: "HTTPS://CATALOG.EXAMPLE/snapshot.json" } });
    const upper = sourceFromOptions({ cwd: t.cwd, home: t.home });
    t.writeRepo({ capabilityCatalog: { remoteUrl: "https://catalog.example/snapshot.json" } });
    const lower = sourceFromOptions({ cwd: t.cwd, home: t.home });
    assert.equal(upper.requestUrl, "https://catalog.example/snapshot.json");
    assert.equal(upper.key, lower.key);
    assert.equal(upper.location, lower.location);
  } finally {
    t.cleanup();
  }
});

test("catalog config: repo source replaces the user source union atomically", () => {
  const t = tempTree();
  try {
    t.writeUser({ capabilityCatalog: { remoteUrl: URL, maxAgeSeconds: 3600 } });
    t.writeRepo({ capabilityCatalog: { localPath: "catalog.json" } });
    assert.deepEqual(loadConfig({ cwd: t.cwd, home: t.home }).config.capabilityCatalog, {
      localPath: "catalog.json",
      maxAgeSeconds: 3600,
    });
  } finally {
    t.cleanup();
  }
});

test("catalog config: a repo freshness-only overlay retains the user source", () => {
  const t = tempTree();
  try {
    t.writeUser({ capabilityCatalog: { remoteUrl: URL, maxAgeSeconds: 3600 } });
    t.writeRepo({ capabilityCatalog: { maxAgeSeconds: 60 } });
    assert.deepEqual(loadConfig({ cwd: t.cwd, home: t.home }).config.capabilityCatalog, {
      remoteUrl: URL,
      maxAgeSeconds: 60,
    });
  } finally {
    t.cleanup();
  }
});

test("catalog freshness: future-dated snapshots are rejected instead of reporting age zero", () => {
  const t = tempTree();
  try {
    writeFileSync(path.join(t.cwd, "catalog.json"), serializeCatalog(catalog("2026-07-18T00:02:00.000Z")));
    t.writeRepo({ capabilityCatalog: { localPath: "catalog.json" } });
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, now: clock }),
      (err: unknown) => err instanceof DatumError && err.code === "CAPABILITY_CATALOG_MALFORMED",
    );
  } finally {
    t.cleanup();
  }
});

test("catalog refresh repairs a corrupt content-addressed cache before moving active state", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    const first = await seed(t, cacheRoot);
    const snapshotFile = path.join(cacheRoot, "snapshots", `${first.catalog.digest}.json`);
    writeFileSync(snapshotFile, "corrupt");
    const repaired = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: clock,
      transport: async () => new Response(serializeCatalog(first.catalog), { status: 200, headers: { etag: '"v2"' } }),
    });
    assert.equal(repaired.catalog.digest, first.catalog.digest);
    assert.equal(loadCapabilityCatalog({ cwd: t.cwd, home: t.home, cacheRoot, now: clock }).catalog.digest, first.catalog.digest);
  } finally {
    t.cleanup();
  }
});

test("catalog cache: source keys isolate remote URLs sharing one cache root", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    await seed(t, cacheRoot);
    t.writeRepo(config("https://other.example/snapshot.json"));
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, cacheRoot, now: clock }),
      (error: unknown) => error instanceof DatumError && error.code === "CAPABILITY_CATALOG_UNAVAILABLE",
    );
  } finally {
    t.cleanup();
  }
});

test("catalog fallback: stale and corrupt caches retain their typed diagnosis when transport fails", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    const first = await seed(t, cacheRoot);
    t.writeRepo(config(URL, 1));
    await assert.rejects(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot,
        now: () => new Date("2026-07-18T00:02:00.000Z"),
        transport: async () => { throw new Error("offline"); },
      }),
      (error: unknown) => error instanceof DatumError &&
        error.code === "CAPABILITY_CATALOG_STALE" &&
        error.message.includes("Refresh also failed"),
    );

    t.writeRepo(config());
    writeFileSync(path.join(cacheRoot, "snapshots", `${first.catalog.digest}.json`), "corrupt");
    await assert.rejects(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot,
        now: clock,
        transport: async () => { throw new Error("offline"); },
      }),
      (error: unknown) => error instanceof DatumError &&
        error.code === "CAPABILITY_CATALOG_CACHE_CORRUPT" &&
        error.message.includes("Refresh also failed"),
    );
  } finally {
    t.cleanup();
  }
});
