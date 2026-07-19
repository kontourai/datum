import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { compileCatalog, serializeCatalog } from "@kontourai/bearing";
import {
  DatumError,
  loadCapabilityCatalog,
  refreshCapabilityCatalog,
} from "../src/index.js";
import { loadCachedAt } from "../src/catalog/cache.js";
import { tempTree } from "./helpers.js";

const REMOTE_URL = "https://93.184.216.34/snapshot.json";

function catalog() {
  return compileCatalog([], { asOf: "2026-07-18T00:00:00.000Z" });
}

function rejectsCode(work: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(
    work,
    (error: unknown) => error instanceof DatumError && error.code === code,
  );
}

test("an unsolicited 304 never revalidates an unconditional request", async () => {
  const t = tempTree();
  let conditional: string | undefined;
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    await rejectsCode(() => refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: path.join(t.dir, "cache"),
      transport: async (_url, init) => {
        conditional = init.headers?.["if-none-match"];
        return new Response(null, { status: 304 });
      },
    }), "CAPABILITY_CATALOG_UNAVAILABLE");
    assert.equal(conditional, undefined);
  } finally {
    t.cleanup();
  }
});

test("a cached snapshot without an ETag treats 304 as a fallback failure", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  let conditional: string | undefined;
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date("2026-07-18T00:01:00.000Z"),
      transport: async () => new Response(serializeCatalog(catalog()), { status: 200 }),
    });
    const fallback = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot,
      now: () => new Date("2026-07-18T00:02:00.000Z"),
      transport: async (_url, init) => {
        conditional = init.headers?.["if-none-match"];
        return new Response(null, { status: 304 });
      },
    });
    assert.equal(conditional, undefined);
    assert.equal(fallback.metadata.notModified, false);
    assert.equal(fallback.metadata.fallback, true);
    assert.equal(fallback.metadata.fetchedAt, "2026-07-18T00:01:00.000Z");
    assert.equal(fallback.metadata.diagnostics[0]?.code, "CAPABILITY_CATALOG_UNAVAILABLE");
  } finally {
    t.cleanup();
  }
});

test("invalid response limits fail before transport", async () => {
  const t = tempTree();
  let calls = 0;
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    for (const maxResponseBytes of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      await rejectsCode(() => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot: path.join(t.dir, "cache"),
        maxResponseBytes,
        transport: async () => {
          calls += 1;
          return new Response(serializeCatalog(catalog()), { status: 200 });
        },
      }), "CAPABILITY_CATALOG_LIMIT_EXCEEDED");
    }
    assert.equal(calls, 0);
  } finally {
    t.cleanup();
  }
});

test("a bodyless successful injected response is rejected without buffering text", async () => {
  const t = tempTree();
  let textCalled = false;
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    await rejectsCode(() => refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: path.join(t.dir, "cache"),
      transport: async () => ({
        status: 200,
        text: async () => {
          textCalled = true;
          return serializeCatalog(catalog());
        },
      }),
    }), "CAPABILITY_CATALOG_UNAVAILABLE");
    assert.equal(textCalled, false);
  } finally {
    t.cleanup();
  }
});

test("local catalog metadata does not expose the configured path", () => {
  const t = tempTree();
  try {
    t.writeRepo({ capabilityCatalog: { localPath: "private/catalog.json" } });
    mkdirSync(path.join(t.cwd, "private"));
    writeFileSync(path.join(t.cwd, "private", "catalog.json"), serializeCatalog(catalog()));
    const result = loadCapabilityCatalog({ cwd: t.cwd, home: t.home });
    assert.equal(result.metadata.source.kind, "local");
    assert.equal(result.metadata.source.location, "<local>");
  } finally {
    t.cleanup();
  }
});

test("missing local catalog diagnostics do not expose configured or absolute paths", () => {
  const t = tempTree();
  try {
    t.writeRepo({ capabilityCatalog: { localPath: "private/secret/catalog.json" } });
    assert.throws(
      () => loadCapabilityCatalog({ cwd: t.cwd, home: t.home }),
      (error: unknown) => {
        assert.equal(error instanceof DatumError, true);
        if (!(error instanceof DatumError)) return false;
        assert.equal(error.code, "CAPABILITY_CATALOG_UNAVAILABLE");
        assert.equal(error.message, "Local capability catalog is unavailable.");
        assert.doesNotMatch(error.message, /private|secret|catalog\.json|Users/);
        return true;
      },
    );
  } finally {
    t.cleanup();
  }
});

test("concurrent first writers can create one empty cache", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  const key = "concurrent-source";
  const childScript = `
    import { compileCatalog } from "@kontourai/bearing";
    import { persistSnapshot } from "./dist/src/catalog/cache.js";
    const [root, key, index] = process.argv.slice(1);
    const value = compileCatalog([], { asOf: "2026-07-18T00:00:00.000Z" });
    persistSnapshot(root, key, value, {
      version: 1,
      digest: value.digest,
      fetchedAt: new Date(Date.UTC(2026, 6, 18, 0, 0, Number(index))).toISOString(),
    });
  `;
  try {
    const exits = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", childScript, cacheRoot, key, String(index)], {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolve(code) : reject(new Error(stderr)));
      })));
    assert.deepEqual(exits, Array(12).fill(0));
    assert.equal(loadCachedAt(cacheRoot, key).catalog.digest, catalog().digest);
  } finally {
    t.cleanup();
  }
});
