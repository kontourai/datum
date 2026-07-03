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
