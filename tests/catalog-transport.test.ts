import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { serializeCatalog } from "@kontourai/bearing";
import { DatumError, refreshCapabilityCatalog } from "../src/index.js";
import { startFakeHttpServer, tempTree } from "./helpers.js";
import { clock, catalog, config, rejectsCode } from "./catalog-fixtures.js";

test("catalog transport: redirect targets stay same-origin and transport errors redact URL credentials", async () => {
  const t = tempTree();
  try {
    t.writeRepo(config());
    let calls = 0;
    await rejectsCode(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot: path.join(t.dir, "redirect-cache"),
        now: clock,
        transport: async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } });
        },
      }),
      "CAPABILITY_CATALOG_INSECURE_URL",
    );
    assert.equal(calls, 1);

    await assert.rejects(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot: path.join(t.dir, "error-cache"),
        now: clock,
        transport: async () => {
          throw new Error("request failed for https://user:pa)ss@redirect.example/path-secret?token=super-secret");
        },
      }),
      (error: unknown) => error instanceof DatumError &&
        !error.message.includes("password") &&
        !error.message.includes("pa)ss") &&
        !error.message.includes("path-secret") &&
        !error.message.includes("super-secret") &&
        !error.message.includes("token="),
    );
  } finally {
    t.cleanup();
  }
});
test("catalog transport: resolved private addresses are blocked before fetch", async () => {
  const t = tempTree();
  try {
    t.writeRepo(config());
    let calls = 0;
    await rejectsCode(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot: path.join(t.dir, "cache"),
        now: clock,
        resolveHost: async () => ["169.254.169.254"],
        transport: async () => {
          calls += 1;
          return new Response(serializeCatalog(catalog()), { status: 200 });
        },
      }),
      "CAPABILITY_CATALOG_INSECURE_URL",
    );
    assert.equal(calls, 0);
  } finally {
    t.cleanup();
  }
});

test("catalog transport: an explicitly local source may resolve only to loopback addresses", async () => {
  const t = tempTree();
  try {
    t.writeRepo(config("http://localhost/snapshot.json"));
    let calls = 0;
    await rejectsCode(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot: path.join(t.dir, "cache"),
        now: clock,
        resolveHost: async () => ["93.184.216.34"],
        transport: async () => {
          calls += 1;
          return new Response(serializeCatalog(catalog()), { status: 200 });
        },
      }),
      "CAPABILITY_CATALOG_INSECURE_URL",
    );
    assert.equal(calls, 0);
  } finally {
    t.cleanup();
  }
});

test("catalog transport: default HTTP client connects through the validated resolver result", async () => {
  const t = tempTree();
  const snapshot = catalog();
  const server = await startFakeHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json", etag: '"pinned-v1"' });
    response.end(serializeCatalog(snapshot));
  });
  try {
    const remoteUrl = `${server.url.replace("127.0.0.1", "localhost")}/snapshot.json`;
    t.writeRepo(config(remoteUrl));
    let resolutions = 0;
    const loaded = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: path.join(t.dir, "cache"),
      now: clock,
      resolveHost: async (hostname) => {
        resolutions += 1;
        assert.equal(hostname, "localhost");
        return ["127.0.0.1"];
      },
    });
    assert.equal(resolutions, 1);
    assert.equal(loaded.catalog.digest, snapshot.digest);
    assert.equal(loaded.metadata.etag, '"pinned-v1"');
  } finally {
    await server.close();
    t.cleanup();
  }
});

test("catalog transport: shared loopback policy accepts trailing-dot localhost", async () => {
  const t = tempTree();
  const snapshot = catalog();
  const server = await startFakeHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(serializeCatalog(snapshot));
  });
  try {
    const remoteUrl = `${server.url.replace("127.0.0.1", "localhost.")}/snapshot.json`;
    t.writeRepo(config(remoteUrl));
    const refreshed = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: path.join(t.dir, "cache"),
      now: clock,
      resolveHost: async () => ["127.0.0.1"],
    });
    assert.equal(refreshed.catalog.digest, snapshot.digest);
  } finally {
    await server.close();
    t.cleanup();
  }
});

test("catalog transport: shared loopback policy accepts normalized IPv4-mapped IPv6", async () => {
  const t = tempTree();
  const snapshot = catalog();
  const remoteUrl = "http://[::ffff:127.0.0.1]/snapshot.json";
  try {
    t.writeRepo(config(remoteUrl));
    const refreshed = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: path.join(t.dir, "cache"),
      now: clock,
      resolveHost: async () => ["::ffff:7f00:1"],
      transport: async () => new Response(serializeCatalog(snapshot), { status: 200 }),
    });
    assert.equal(refreshed.catalog.digest, snapshot.digest);
  } finally {
    t.cleanup();
  }
});

test("catalog transport: default HTTP client enforces the overall request deadline", async () => {
  const t = tempTree();
  const server = await startFakeHttpServer(() => {
    // Intentionally withhold headers and body until the client destroys the request.
  });
  try {
    const remoteUrl = `${server.url.replace("127.0.0.1", "localhost")}/snapshot.json`;
    t.writeRepo(config(remoteUrl));
    const started = Date.now();
    await rejectsCode(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot: path.join(t.dir, "cache"),
        now: clock,
        requestTimeoutMs: 50,
        resolveHost: async () => ["127.0.0.1"],
      }),
      "CAPABILITY_CATALOG_UNAVAILABLE",
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await server.close();
    t.cleanup();
  }
});

test("catalog transport: default deadline includes DNS resolution", async () => {
  const t = tempTree();
  try {
    t.writeRepo(config());
    const started = Date.now();
    await rejectsCode(
      () => refreshCapabilityCatalog({
        cwd: t.cwd,
        home: t.home,
        cacheRoot: path.join(t.dir, "cache"),
        now: clock,
        requestTimeoutMs: 50,
        resolveHost: async () => new Promise<string[]>(() => {}),
      }),
      "CAPABILITY_CATALOG_UNAVAILABLE",
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    t.cleanup();
  }
});
