import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compileCatalog, serializeCatalog } from "@kontourai/bearing";
import { tempTree, SAMPLE, startFakeHttpServer } from "./helpers.js";

const dirname = path.dirname(fileURLToPath(import.meta.url));
// compiled test lives at dist/tests/cli.test.js -> repo root is ../../..
const BIN = path.resolve(dirname, "..", "..", "bin", "datum.mjs");

function run(args: string[], env: Record<string, string>, cwd: string) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
  });
}

/**
 * ASYNC variant of `run()`, required only by the discover/test-connection
 * cases below that spawn the CLI while a fake `node:http` server (from
 * `startFakeHttpServer`) is listening IN THIS SAME test process:
 * `spawnSync` blocks this process's event loop while waiting on the child,
 * which would starve the in-process fake server of the ability to accept/
 * service the child's `fetch` request — a deadlock, not a slowdown. `spawn`
 * (non-blocking) keeps this process's event loop running so the server can
 * respond while we `await` the child's exit. Every other CLI test keeps
 * using the plain synchronous `run()` above (no in-process network
 * involved, no risk of this deadlock) — do not switch those.
 */
function runAsync(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}

function withTree(env: Record<string, string>, fn: (cwd: string, env: Record<string, string>) => void) {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    fn(t.cwd, { HOME: t.home, ...env });
  } finally {
    t.cleanup();
  }
}

test("cli resolve --json: structure without secret", () => {
  withTree({ TEST_ZAI_KEY: "reveal-me-value" }, (cwd, env) => {
    const r = run(["resolve", "extraction-default", "--json"], env, cwd);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.provider, "zai");
    assert.equal(out.model, "glm-5.2");
    assert.equal(out.apiKeyEnv, "TEST_ZAI_KEY");
    assert.equal(out.apiKeySet, true);
    assert.ok(!("apiKey" in out));
    assert.ok(!r.stdout.includes("reveal-me-value"));
  });
});

test("cli resolve-policy: reads a bounded JSON request through the offline library and returns machine-readable errors", () => {
  const t = tempTree();
  try {
    t.writeRepo({
      providers: { local: { kind: "openai-compatible", auth: { env: "LOCAL_KEY" }, models: ["local"] } },
      roles: { chat: "local@local" },
    });
    const request = path.join(t.cwd, "request.json");
    writeFileSync(request, JSON.stringify({
      schemaVersion: "datum.capability-role.request/v1",
      task: { family: "chat", suite: null },
      inventory: [{
        id: "local", providerId: "local", providerModel: "local", locality: "local",
        model: { id: "local", revision: null, quantization: null },
        execution: { runtime: { id: "fixture", version: "1" }, adapter: null, effectiveContextTokens: 8192, toolSurface: [], hardware: null, workflow: null },
      }],
    }));
    const ok = run(["resolve-policy", "chat", "--request", request, "--json"], { HOME: t.home, LOCAL_KEY: "present" }, t.cwd);
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).target.id, "local");
    writeFileSync(request, "{");
    const malformed = run(["resolve-policy", "chat", "--request", request, "--json"], { HOME: t.home, LOCAL_KEY: "present" }, t.cwd);
    assert.equal(malformed.status, 1);
    const failure = JSON.parse(malformed.stdout);
    assert.equal(failure.schemaVersion, "datum.resolve-policy.error/v1");
    assert.equal(failure.error.code, "INVALID_CONFIG");
    writeFileSync(request, " ".repeat(1024 * 1024 + 1));
    const oversized = run(["resolve-policy", "chat", "--request", request, "--json"], { HOME: t.home, LOCAL_KEY: "present" }, t.cwd);
    assert.equal(oversized.status, 1);
    assert.equal(JSON.parse(oversized.stdout).error.code, "INVALID_CONFIG");
    assert.ok(JSON.parse(oversized.stdout).error.message.includes("exceeds"));
    const nonFile = run(["resolve-policy", "chat", "--request", t.cwd, "--json"], { HOME: t.home, LOCAL_KEY: "present" }, t.cwd);
    assert.equal(nonFile.status, 1);
    assert.equal(JSON.parse(nonFile.stdout).error.code, "INVALID_CONFIG");
  } finally { t.cleanup(); }
});

test("cli resolve --env: never prints secret without --reveal", () => {
  withTree({ TEST_ZAI_KEY: "reveal-me-value" }, (cwd, env) => {
    const r = run(["resolve", "extraction-default", "--env"], env, cwd);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("export DATUM_PROVIDER=\"zai\""));
    assert.ok(r.stdout.includes("export DATUM_MODEL=\"glm-5.2\""));
    assert.ok(!r.stdout.includes("reveal-me-value"));
    assert.ok(r.stdout.includes("--reveal"));
  });
});

test("cli resolve --env --reveal: emits the secret export", () => {
  withTree({ TEST_ZAI_KEY: "reveal-me-value" }, (cwd, env) => {
    const r = run(["resolve", "extraction-default", "--env", "--reveal"], env, cwd);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('export TEST_ZAI_KEY="reveal-me-value"'));
  });
});

test("cli list: shows providers, roles, and key status", () => {
  withTree({ TEST_ZAI_KEY: "x" }, (cwd, env) => {
    const r = run(["list"], env, cwd);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("zai"));
    assert.ok(r.stdout.includes("TEST_ZAI_KEY (set)"));
    assert.ok(r.stdout.includes("TEST_ANTHROPIC_KEY (MISSING)"));
    assert.ok(r.stdout.includes("extraction-default"));
  });
});

test("cli sync opencode --dry-run: emits provider block, no secret", () => {
  withTree({ TEST_ZAI_KEY: "reveal-me-value" }, (cwd, env) => {
    const r = run(["sync", "opencode", "--dry-run"], env, cwd);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("@ai-sdk/anthropic"));
    assert.ok(r.stdout.includes("TEST_ZAI_KEY"));
    assert.ok(!r.stdout.includes("apiKey"));
    assert.ok(!r.stdout.includes("reveal-me-value"));
  });
});

test("cli: unknown role exits non-zero with typed code", () => {
  withTree({}, (cwd, env) => {
    const r = run(["resolve", "does-not-exist"], env, cwd);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("UNKNOWN_ROLE"));
  });
});

test("cli: unknown command exits non-zero", () => {
  withTree({}, (cwd, env) => {
    const r = run(["frobnicate"], env, cwd);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("unknown command"));
  });
});

test("cli sync claude-code --role: emits env block, key as comment only", () => {
  withTree({ TEST_ANTHROPIC_KEY: "super-secret-value" }, (cwd, env) => {
    const r = run(["sync", "claude-code", "--role", "worker", "--dry-run"], env, cwd);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("ANTHROPIC_MODEL"));
    assert.ok(r.stdout.includes("claude-sonnet-5"));
    // Key never written into the settings JSON; only referenced as a comment.
    assert.ok(!r.stdout.includes("super-secret-value"));
    assert.ok(r.stdout.includes("TEST_ANTHROPIC_KEY")); // named in instruction comment
    assert.ok(r.stdout.includes("NEVER"));
  });
});

test("cli sync claude-code: baseUrl provider sets ANTHROPIC_BASE_URL", () => {
  withTree({ TEST_ZAI_KEY: "x" }, (cwd, env) => {
    const r = run(["sync", "claude-code", "--role", "extraction-default", "--dry-run"], env, cwd);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("ANTHROPIC_BASE_URL"));
    assert.ok(r.stdout.includes("https://api.z.ai/api/anthropic"));
  });
});

test("cli sync claude-code: missing --role errors", () => {
  withTree({}, (cwd, env) => {
    const r = run(["sync", "claude-code", "--dry-run"], env, cwd);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("--role"));
  });
});

test("cli sync: unknown target errors", () => {
  withTree({}, (cwd, env) => {
    const r = run(["sync", "frobnicate"], env, cwd);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("unknown target"));
  });
});

// --- discover / test-connection (issue #5) ---
// End-to-end against a LOCAL node:http server bound to 127.0.0.1:<ephemeral
// port> — never a real provider host (AC5). Every server started here is
// closed in a `finally` block.

function discoverProviderConfig(baseUrl: string) {
  return {
    providers: {
      "local-oai": {
        kind: "openai-compatible",
        baseUrl,
        auth: { env: "LOCAL_OAI_KEY" },
        models: ["local-model-a"],
      },
    },
  };
}

test("cli discover: lists models from a local /models fixture, exit 0", async () => {
  const server = await startFakeHttpServer((req, res) => {
    if (req.headers.authorization === "Bearer test-key") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-model-a" }, { id: "local-model-b" }] }));
    } else {
      res.writeHead(401);
      res.end();
    }
  });
  try {
    const t = tempTree();
    try {
      t.writeRepo(discoverProviderConfig(server.url));
      const r = await runAsync(["discover", "local-oai"], { HOME: t.home, LOCAL_OAI_KEY: "test-key" }, t.cwd);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes("local-model-a"));
      assert.ok(r.stdout.includes("local-model-b"));
    } finally {
      t.cleanup();
    }
  } finally {
    await server.close();
  }
});

test("cli discover --json: emits structured model list", async () => {
  const server = await startFakeHttpServer((req, res) => {
    if (req.headers.authorization === "Bearer test-key") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-model-a" }, { id: "local-model-b" }] }));
    } else {
      res.writeHead(401);
      res.end();
    }
  });
  try {
    const t = tempTree();
    try {
      t.writeRepo(discoverProviderConfig(server.url));
      const r = await runAsync(["discover", "local-oai", "--json"], { HOME: t.home, LOCAL_OAI_KEY: "test-key" }, t.cwd);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.ok(out.models.includes("local-model-a"));
      assert.ok(out.models.includes("local-model-b"));
    } finally {
      t.cleanup();
    }
  } finally {
    await server.close();
  }
});

test("cli test-connection: exit 0 on a healthy local fixture", async () => {
  const server = await startFakeHttpServer((req, res) => {
    if (req.headers.authorization === "Bearer test-key") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-model-a" }] }));
    } else {
      res.writeHead(401);
      res.end();
    }
  });
  try {
    const t = tempTree();
    try {
      t.writeRepo(discoverProviderConfig(server.url));
      const r = await runAsync(["test-connection", "local-oai"], { HOME: t.home, LOCAL_OAI_KEY: "test-key" }, t.cwd);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.includes("test-connection: OK"));
    } finally {
      t.cleanup();
    }
  } finally {
    await server.close();
  }
});

test("cli test-connection: exit 1 with auth diagnostic on wrong key", async () => {
  const server = await startFakeHttpServer((req, res) => {
    if (req.headers.authorization === "Bearer test-key") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-model-a" }] }));
    } else {
      res.writeHead(401);
      res.end();
    }
  });
  try {
    const t = tempTree();
    try {
      t.writeRepo(discoverProviderConfig(server.url));
      const r = await runAsync(["test-connection", "local-oai"], { HOME: t.home, LOCAL_OAI_KEY: "wrong-key" }, t.cwd);
      assert.equal(r.status, 1);
      assert.ok(r.stdout.includes("auth rejected") || r.stderr.includes("auth rejected"));
    } finally {
      t.cleanup();
    }
  } finally {
    await server.close();
  }
});

test("cli test-connection: exit 1 with unreachable diagnostic against a closed port", async () => {
  const server = await startFakeHttpServer((_req, res) => res.end());
  const deadUrl = server.url;
  await server.close(); // close immediately so the connect attempt throws (ECONNREFUSED)
  const t = tempTree();
  try {
    t.writeRepo(discoverProviderConfig(deadUrl));
    const r = await runAsync(["test-connection", "local-oai"], { HOME: t.home, LOCAL_OAI_KEY: "test-key" }, t.cwd);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes("unreachable") || r.stderr.includes("unreachable"));
  } finally {
    t.cleanup();
  }
});

test("cli discover: exit 1 with incompatible diagnostic against a non-OpenAI-compatible endpoint", async () => {
  const server = await startFakeHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("hello");
  });
  try {
    const t = tempTree();
    try {
      t.writeRepo(discoverProviderConfig(server.url));
      const r = await runAsync(["discover", "local-oai"], { HOME: t.home, LOCAL_OAI_KEY: "test-key" }, t.cwd);
      assert.equal(r.status, 1);
      assert.ok(r.stdout.includes("not valid JSON") || r.stderr.includes("not valid JSON"));
    } finally {
      t.cleanup();
    }
  } finally {
    await server.close();
  }
});

test("cli discover: unknown provider errors", () => {
  withTree({}, (cwd, env) => {
    const r = run(["discover", "does-not-exist"], env, cwd);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("does-not-exist"));
  });
});

test("cli discover: missing credential exits 1 with a plain-text auth diagnostic", () => {
  withTree({}, (cwd, env) => {
    const t = tempTree();
    try {
      t.writeRepo(discoverProviderConfig("http://127.0.0.1:1"));
      // LOCAL_OAI_KEY intentionally NOT set — credential missing, no network call.
      const r = run(["discover", "local-oai"], { HOME: t.home }, t.cwd);
      assert.equal(r.status, 1);
      assert.ok(r.stderr.includes("LOCAL_OAI_KEY"));
      assert.ok(r.stderr.toLowerCase().includes("auth"));
    } finally {
      t.cleanup();
    }
  });
});

test("cli discover --json: missing credential emits structured {ok:false, errorClass:'auth'}, not a plain-text die() message", () => {
  withTree({}, (cwd, env) => {
    const t = tempTree();
    try {
      t.writeRepo(discoverProviderConfig("http://127.0.0.1:1"));
      // LOCAL_OAI_KEY intentionally NOT set — credential missing, no network call.
      const r = run(["discover", "local-oai", "--json"], { HOME: t.home }, t.cwd);
      assert.equal(r.status, 1);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.errorClass, "auth");
      assert.ok(out.detail.includes("LOCAL_OAI_KEY"));
    } finally {
      t.cleanup();
    }
  });
});

test("cli test-connection: missing <provider> errors", () => {
  withTree({}, (cwd, env) => {
    const r = run(["test-connection"], env, cwd);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("<provider>"));
  });
});

test("cli catalog refresh/status: prints compact metadata without the catalog body", async () => {
  const snapshot = compileCatalog([], { asOf: "2026-07-18T00:00:00.000Z" });
  const server = await startFakeHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json", etag: '"catalog-v1"' });
    res.end(serializeCatalog(snapshot));
  });
  const t = tempTree();
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: `${server.url}/snapshot.json` } });
    const refreshed = await runAsync(["catalog", "refresh", "--json"], { HOME: t.home }, t.cwd);
    assert.equal(refreshed.status, 0, refreshed.stderr);
    const refreshMetadata = JSON.parse(refreshed.stdout);
    assert.equal(refreshMetadata.digest, snapshot.digest);
    assert.equal(refreshMetadata.source.kind, "remote");
    assert.ok(!refreshed.stdout.includes("schemaVersion"));
    await server.close();
    const status = run(["catalog", "status", "--json"], { HOME: t.home }, t.cwd);
    assert.equal(status.status, 0, status.stderr);
    const statusMetadata = JSON.parse(status.stdout);
    assert.equal(statusMetadata.digest, snapshot.digest);
    assert.equal(statusMetadata.source.location, `${server.url}/<redacted>`);
  } finally {
    t.cleanup();
    // close() is idempotent only when the server is still open.
    try { await server.close(); } catch { /* already closed after refresh */ }
  }
});

test("cli catalog --json: hard failures remain machine-readable", () => {
  const t = tempTree();
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: "https://catalog.example/snapshot.json" } });
    const missing = run(["catalog", "status", "--json"], { HOME: t.home }, t.cwd);
    assert.equal(missing.status, 1);
    assert.equal(missing.stderr, "");
    const missingBody = JSON.parse(missing.stdout);
    assert.equal(missingBody.schemaVersion, "datum.catalog.error/v1");
    assert.equal(missingBody.ok, false);
    assert.equal(missingBody.error.code, "CAPABILITY_CATALOG_UNAVAILABLE");
    assert.equal(typeof missingBody.error.message, "string");

    writeFileSync(path.join(t.cwd, "catalog.json"), "not-json");
    t.writeRepo({ capabilityCatalog: { localPath: "catalog.json" } });
    const malformed = run(["catalog", "status", "--json"], { HOME: t.home }, t.cwd);
    assert.equal(malformed.status, 1);
    assert.equal(malformed.stderr, "");
    const malformedBody = JSON.parse(malformed.stdout);
    assert.equal(malformedBody.schemaVersion, "datum.catalog.error/v1");
    assert.equal(malformedBody.ok, false);
    assert.equal(malformedBody.error.code, "CAPABILITY_CATALOG_MALFORMED");
    assert.equal(malformedBody.error.message, "local capability catalog is not a valid Bearing catalog.");
    assert.doesNotMatch(malformed.stdout, /catalog\.json|not-json|Users/);

    t.writeRepo({ capabilityCatalog: { localPath: "private/secret/catalog.json" } });
    const localMissing = run(["catalog", "status", "--json"], { HOME: t.home }, t.cwd);
    assert.equal(localMissing.status, 1);
    assert.equal(localMissing.stderr, "");
    const localMissingBody = JSON.parse(localMissing.stdout);
    assert.equal(localMissingBody.error.code, "CAPABILITY_CATALOG_UNAVAILABLE");
    assert.equal(localMissingBody.error.message, "Local capability catalog is unavailable.");
    assert.doesNotMatch(localMissing.stdout, /private|secret|catalog\.json|Users/);

    t.writeRepo({ capabilityCatalog: { remoteUrl: "http://127.0.0.1:1/snapshot.json" } });
    const unavailable = run(["catalog", "refresh", "--json"], { HOME: t.home }, t.cwd);
    assert.equal(unavailable.status, 1);
    assert.equal(unavailable.stderr, "");
    const unavailableBody = JSON.parse(unavailable.stdout);
    assert.equal(unavailableBody.schemaVersion, "datum.catalog.error/v1");
    assert.equal(unavailableBody.ok, false);
    assert.equal(unavailableBody.error.code, "CAPABILITY_CATALOG_UNAVAILABLE");
  } finally {
    t.cleanup();
  }
});

test("cli catalog --json redacts an unavailable working directory", () => {
  const t = tempTree();
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: "https://93.184.216.34/snapshot.json" } });
    const missing = path.join(t.dir, "private", "missing");
    const r = run([
      "catalog",
      "status",
      "--json",
      "--cwd",
      missing,
      "--repo-config-path",
      path.join(t.cwd, ".datum", "config.json"),
    ], { HOME: t.home }, t.dir);
    assert.equal(r.status, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.error.code, "CAPABILITY_CATALOG_UNAVAILABLE");
    assert.equal(out.error.message, "Datum working directory is unavailable.");
    assert.doesNotMatch(r.stdout + r.stderr, /private|missing|cache\.ts|Node\.js/);
  } finally {
    t.cleanup();
  }
});

// --- --cwd / --repo-config-path / --user-config-path plumbing (issue #4) ---
// These flags are pure CLI plumbing over the library's existing
// ResolveOptions.cwd/repoConfigPath/userConfigPath; the fixtures below run the
// binary from a NEUTRAL directory (the tempTree's parent, which itself has no
// .datum/config.json) and prove the flag alone routes config discovery.

test("cli resolve --cwd: locates repo config from a directory other than the process cwd", () => {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    const r = run(
      ["resolve", "extraction-default", "--json", "--cwd", t.cwd],
      { HOME: t.home, TEST_ZAI_KEY: "x" },
      t.dir, // neutral cwd: no .datum/config.json here
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.provider, "zai");
    assert.equal(out.model, "glm-5.2");
  } finally {
    t.cleanup();
  }
});

test("cli resolve: without --cwd, a neutral process cwd cannot see the repo config (unknown role)", () => {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    const r = run(["resolve", "extraction-default", "--json"], { HOME: t.home, TEST_ZAI_KEY: "x" }, t.dir);
    assert.equal(r.status, 1);
    assert.ok(r.stderr.includes("UNKNOWN_ROLE"));
  } finally {
    t.cleanup();
  }
});

test("cli resolve --repo-config-path: explicit file path overrides --cwd-derived default", () => {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    const explicitPath = path.join(t.cwd, ".datum", "config.json");
    const r = run(
      ["resolve", "extraction-default", "--json", "--repo-config-path", explicitPath],
      { HOME: t.home, TEST_ZAI_KEY: "x" },
      t.dir, // neutral cwd; --cwd is not passed at all
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.provider, "zai");
  } finally {
    t.cleanup();
  }
});

test("cli resolve --user-config-path: explicit user file is read as the base layer", () => {
  const t = tempTree();
  try {
    t.writeUser(SAMPLE);
    const explicitUserPath = path.join(t.home, ".config", "kontour", "datum.json");
    const r = run(
      ["resolve", "worker", "--json", "--user-config-path", explicitUserPath],
      { TEST_ANTHROPIC_KEY: "x" }, // no HOME set — proves the explicit path, not the default, is read
      t.dir,
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.provider, "anthropic");
    assert.equal(out.model, "claude-sonnet-5");
  } finally {
    t.cleanup();
  }
});

test("cli resolve: --cwd works regardless of flag position relative to the positional ref", () => {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    const r = run(
      ["resolve", "--cwd", t.cwd, "extraction-default", "--json"],
      { HOME: t.home, TEST_ZAI_KEY: "x" },
      t.dir,
    );
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.provider, "zai");
  } finally {
    t.cleanup();
  }
});

test("cli doctor --cwd: locates repo config from a directory other than the process cwd", () => {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    const r = run(["doctor", "--cwd", t.cwd], { HOME: t.home, TEST_ZAI_KEY: "x", TEST_ANTHROPIC_KEY: "y" }, t.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("doctor: OK"));
    assert.ok(r.stdout.includes(t.cwd));
  } finally {
    t.cleanup();
  }
});

test("cli doctor --repo-config-path: explicit file path overrides --cwd-derived default", () => {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    const explicitPath = path.join(t.cwd, ".datum", "config.json");
    const r = run(
      ["doctor", "--repo-config-path", explicitPath],
      { HOME: t.home, TEST_ZAI_KEY: "x", TEST_ANTHROPIC_KEY: "y" },
      t.dir,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("doctor: OK"));
  } finally {
    t.cleanup();
  }
});

test("cli doctor --user-config-path: explicit user file is read as the base layer", () => {
  const t = tempTree();
  try {
    t.writeUser(SAMPLE);
    const explicitUserPath = path.join(t.home, ".config", "kontour", "datum.json");
    const r = run(
      ["doctor", "--user-config-path", explicitUserPath],
      { TEST_ZAI_KEY: "x", TEST_ANTHROPIC_KEY: "y" },
      t.dir,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("doctor: OK"));
  } finally {
    t.cleanup();
  }
});

test("cli list --cwd: reports the repo config source path", () => {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    const r = run(["list", "--cwd", t.cwd], { HOME: t.home, TEST_ZAI_KEY: "x" }, t.dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes(path.join(t.cwd, ".datum", "config.json")));
    assert.ok(r.stdout.includes("extraction-default"));
  } finally {
    t.cleanup();
  }
});

test("cli sync opencode --cwd: generates provider block from a non-default cwd", () => {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    const r = run(
      ["sync", "opencode", "--dry-run", "--cwd", t.cwd],
      { HOME: t.home, TEST_ZAI_KEY: "x" },
      t.dir,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("@ai-sdk/anthropic"));
  } finally {
    t.cleanup();
  }
});

test("cli sync claude-code --cwd: resolves the role from a non-default cwd", () => {
  const t = tempTree();
  try {
    t.writeRepo(SAMPLE);
    const r = run(
      ["sync", "claude-code", "--role", "worker", "--dry-run", "--cwd", t.cwd],
      { HOME: t.home, TEST_ANTHROPIC_KEY: "x" },
      t.dir,
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes("claude-sonnet-5"));
  } finally {
    t.cleanup();
  }
});
