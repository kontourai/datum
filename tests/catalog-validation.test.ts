import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { serializeCatalog } from "@kontourai/bearing";
import {
  DEFAULT_CATALOG_MAX_RESPONSE_BYTES,
  DatumError,
  loadCapabilityCatalog,
  refreshCapabilityCatalog,
  validateConfig,
} from "../src/index.js";
import { tempTree } from "./helpers.js";
import { NOW, clock, catalog, config, seed, rejectsCode } from "./catalog-fixtures.js";

test("catalog local/cache paths reject traversal, escaping symlinks, and symlinked cache directories", async () => {
  const t = tempTree();
  try {
    assert.throws(
      () => validateConfig({ capabilityCatalog: { localPath: "../outside.json" } }),
      (error: unknown) => error instanceof DatumError && error.code === "INVALID_CONFIG",
    );
    const outside = path.join(t.dir, "outside.json");
    writeFileSync(outside, serializeCatalog(catalog()));
    symlinkSync(outside, path.join(t.cwd, "linked-catalog.json"));
    t.writeRepo({ capabilityCatalog: { localPath: "linked-catalog.json" } });
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, now: clock }),
      (error: unknown) => {
        assert.ok(error instanceof DatumError);
        assert.equal(error.code, "CAPABILITY_CATALOG_PATH_OUTSIDE_ROOT");
        assert.equal(error.message, "Local capability catalog resolves outside the Datum working directory.");
        assert.doesNotMatch(error.message, /linked-catalog\.json|outside\.json|Users/);
        return true;
      },
    );

    t.writeRepo(config());
    const cacheRoot = path.join(t.dir, "symlink-cache");
    const outsideState = path.join(t.dir, "outside-state");
    mkdirSync(cacheRoot);
    mkdirSync(outsideState);
    symlinkSync(outsideState, path.join(cacheRoot, "state"));
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, cacheRoot, now: clock }),
      (error: unknown) => error instanceof DatumError && error.code === "CAPABILITY_CATALOG_CACHE_CORRUPT",
    );
    await rejectsCode(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot,
        now: clock,
        transport: async () => new Response(serializeCatalog(catalog()), { status: 200 }),
      }),
      "CAPABILITY_CATALOG_CACHE_CORRUPT",
    );
  } finally {
    t.cleanup();
  }
});

test("catalog validation caps model and observation complexity before Bearing recompilation", () => {
  const t = tempTree();
  try {
    const file = path.join(t.cwd, "catalog.json");
    writeFileSync(file, JSON.stringify({
      schemaVersion: "bearing.catalog/v1",
      asOf: NOW,
      digest: "0".repeat(64),
      models: Array.from({ length: 2_001 }, () => ({ observations: [] })),
      conflicts: [],
    }));
    t.writeRepo({ capabilityCatalog: { localPath: "catalog.json" } });
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, now: clock }),
      (error: unknown) => error instanceof DatumError && error.code === "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
    );
  } finally {
    t.cleanup();
  }
});

test("catalog validation applies byte limits to local and cached snapshots", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    writeFileSync(path.join(t.cwd, "catalog.json"), " ".repeat(DEFAULT_CATALOG_MAX_RESPONSE_BYTES + 1));
    t.writeRepo({ capabilityCatalog: { localPath: "catalog.json" } });
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, now: clock }),
      (error: unknown) => error instanceof DatumError && error.code === "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
    );

    const seeded = await seed(t, cacheRoot);
    writeFileSync(
      path.join(cacheRoot, "snapshots", `${seeded.catalog.digest}.json`),
      " ".repeat(DEFAULT_CATALOG_MAX_RESPONSE_BYTES + 1),
    );
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home, cacheRoot, now: clock }),
      (error: unknown) => error instanceof DatumError && error.code === "CAPABILITY_CATALOG_CACHE_CORRUPT",
    );
  } finally {
    t.cleanup();
  }
});
