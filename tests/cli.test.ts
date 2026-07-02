import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tempTree, SAMPLE } from "./helpers.js";

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
