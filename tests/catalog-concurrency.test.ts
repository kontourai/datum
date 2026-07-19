import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { serializeCatalog } from "@kontourai/bearing";
import { DatumError, loadCapabilityCatalog, refreshCapabilityCatalog } from "../src/index.js";
import { tempTree } from "./helpers.js";
import {
  clock,
  catalog,
  catalogVariant,
  config,
  stateFiles,
  seed,
  rejectsCode,
} from "./catalog-fixtures.js";

test("catalog activation: a slower older refresh cannot regress newer active state", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  let finishOlder!: (response: Response) => void;
  let finishNewer!: (response: Response) => void;
  const olderResponse = new Promise<Response>((resolvePromise) => { finishOlder = resolvePromise; });
  const newerResponse = new Promise<Response>((resolvePromise) => { finishNewer = resolvePromise; });
  let currentTime = "2026-07-18T00:00:30.000Z";
  try {
    t.writeRepo(config());
    const older = catalog("2026-07-18T00:00:00.000Z");
    const newer = catalog("2026-07-18T00:01:00.000Z");
    const olderRun = refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date(currentTime),
      transport: async () => olderResponse,
    });
    currentTime = "2026-07-18T00:03:00.000Z";
    const newerRun = refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date(currentTime),
      transport: async () => newerResponse,
    });
    finishNewer(new Response(serializeCatalog(newer), { status: 200 }));
    assert.equal((await newerRun).catalog.digest, newer.digest);
    currentTime = "2026-07-18T00:04:00.000Z";
    finishOlder(new Response(serializeCatalog(older), { status: 200 }));
    assert.equal((await olderRun).catalog.digest, newer.digest);
    assert.equal(loadCapabilityCatalog({ cwd: t.cwd, home: t.home, cacheRoot, now: () => new Date("2026-07-18T00:03:00.000Z") }).catalog.digest, newer.digest);
  } finally {
    t.cleanup();
  }
});
test("catalog fallback: a delayed failure selects the cache active at completion", async () => {
  for (const initiallySeeded of [false, true]) {
    const t = tempTree();
    const cacheRoot = path.join(t.dir, "cache");
    let failDelayed!: (error: Error) => void;
    const delayedFailure = new Promise<Response>((_resolve, reject) => { failDelayed = reject; });
    try {
      t.writeRepo(config());
      if (initiallySeeded) await seed(t, cacheRoot, catalog("2026-07-18T00:00:00.000Z"));
      const delayed = refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot,
        now: () => new Date("2026-07-18T00:04:00.000Z"),
        transport: async () => delayedFailure,
      });
      const newer = catalog("2026-07-18T00:01:00.000Z");
      const activated = await refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot,
        now: () => new Date("2026-07-18T00:03:00.000Z"),
        transport: async () => new Response(serializeCatalog(newer), { status: 200 }),
      });
      failDelayed(new Error("offline"));
      const fallback = await delayed;
      assert.equal(activated.catalog.digest, newer.digest);
      assert.equal(fallback.catalog.digest, newer.digest);
      assert.equal(fallback.metadata.fallback, true);
      assert.equal(fallback.metadata.diagnostics[0]?.code, "CAPABILITY_CATALOG_UNAVAILABLE");
    } finally {
      t.cleanup();
    }
  }
});

test("catalog activation: distinct digests with one asOf fail as a source conflict", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  const asOf = "2026-07-18T00:00:00.000Z";
  try {
    await seed(t, cacheRoot, catalogVariant(asOf, "example/model-a"));
    await rejectsCode(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot,
        now: () => new Date("2026-07-18T00:02:00.000Z"),
        transport: async () => new Response(serializeCatalog(catalogVariant(asOf, "example/model-b")), { status: 200 }),
      }),
      "CAPABILITY_CATALOG_CONFLICT",
    );
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, cacheRoot, now: clock }),
      (error: unknown) => error instanceof DatumError && error.code === "CAPABILITY_CATALOG_CONFLICT",
    );
  } finally {
    t.cleanup();
  }
});

test("catalog activation: a late cross-process state candidate cannot replace the deterministic maximum", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    const older = await seed(t, cacheRoot, catalog("2026-07-18T00:00:00.000Z"));
    const [olderStateFile] = stateFiles(cacheRoot, older.metadata.source.key);
    const olderStateName = path.basename(olderStateFile);
    const olderState = readFileSync(olderStateFile, "utf8");

    const newer = catalog("2026-07-18T00:01:00.000Z");
    const activated = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date("2026-07-18T00:03:00.000Z"),
      transport: async () => new Response(serializeCatalog(newer), { status: 200, headers: { etag: '"v2"' } }),
    });
    assert.equal(activated.catalog.digest, newer.digest);

    // Model a second process completing an older read/compare/write after the newer activation.
    writeFileSync(path.join(cacheRoot, "state", older.metadata.source.key, olderStateName), olderState);
    const loaded = loadCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date("2026-07-18T00:03:00.000Z"),
    });
    assert.equal(loaded.catalog.digest, newer.digest);
    assert.equal(loaded.metadata.etag, '"v2"');
  } finally {
    t.cleanup();
  }
});

test("catalog activation: a delayed 304 cannot re-promote the ETag snapshot after newer activation", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  let finishNotModified!: (response: Response) => void;
  const notModifiedResponse = new Promise<Response>((resolvePromise) => { finishNotModified = resolvePromise; });
  try {
    await seed(t, cacheRoot, catalog("2026-07-18T00:00:00.000Z"));
    const delayed = refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date("2026-07-18T00:04:00.000Z"),
      transport: async () => notModifiedResponse,
    });
    const newer = catalog("2026-07-18T00:01:00.000Z");
    const activated = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date("2026-07-18T00:03:00.000Z"),
      transport: async () => new Response(serializeCatalog(newer), { status: 200, headers: { etag: '"v2"' } }),
    });
    assert.equal(activated.catalog.digest, newer.digest);
    finishNotModified(new Response(null, { status: 304 }));
    const completed = await delayed;
    assert.equal(completed.catalog.digest, newer.digest);
    assert.equal(completed.metadata.etag, '"v2"');
    assert.equal(completed.metadata.fetchedAt, "2026-07-18T00:03:00.000Z");
    assert.equal(completed.metadata.notModified, false);
    assert.match(completed.metadata.warnings[0] ?? "", /superseded ETag/);
  } finally {
    t.cleanup();
  }
});
