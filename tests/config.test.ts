import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deepMerge, loadConfig, repoConfigPath, userConfigPath } from "../src/index.js";
import { tempTree } from "./helpers.js";

test("deepMerge: objects merge per-key, overlay scalars/arrays replace", () => {
  const base = { a: { x: 1, y: 2 }, arr: [1, 2], keep: "base" };
  const overlay = { a: { y: 9, z: 3 }, arr: [3], add: "over" };
  assert.deepEqual(deepMerge(base, overlay), {
    a: { x: 1, y: 9, z: 3 },
    arr: [3],
    keep: "base",
    add: "over",
  });
});

test("loadConfig: repo overlay overrides user per-key (deep)", () => {
  const t = tempTree();
  try {
    t.writeUser({
      providers: {
        zai: { kind: "anthropic-compatible", baseUrl: "https://user", auth: { env: "TEST_ZAI_KEY" }, models: ["glm-4.6"] },
      },
      roles: { worker: "glm-4.6@zai" },
    });
    t.writeRepo({
      providers: {
        zai: { kind: "anthropic-compatible", baseUrl: "https://repo", auth: { env: "TEST_ZAI_KEY" }, models: ["glm-5.2"] },
      },
      roles: { extra: "glm-5.2@zai" },
    });
    const { config, sources } = loadConfig({ home: t.home, cwd: t.cwd });
    assert.equal(sources.length, 2);
    assert.equal(config.providers!.zai.baseUrl, "https://repo");
    assert.deepEqual(config.providers!.zai.models, ["glm-5.2"]);
    assert.deepEqual(Object.keys(config.roles!).sort(), ["extra", "worker"]);
  } finally {
    t.cleanup();
  }
});

test("loadConfig: user-only when repo absent", () => {
  const t = tempTree();
  try {
    t.writeUser({ providers: { zai: { kind: "anthropic-compatible", auth: { env: "TEST_ZAI_KEY" }, models: ["glm-4.6"] } } });
    const { config, sources } = loadConfig({ home: t.home, cwd: t.cwd });
    assert.equal(sources.length, 1);
    assert.ok(config.providers!.zai);
  } finally {
    t.cleanup();
  }
});

test("loadConfig: empty when neither file exists", () => {
  const t = tempTree();
  try {
    const { config, sources } = loadConfig({ home: t.home, cwd: t.cwd });
    assert.equal(sources.length, 0);
    assert.deepEqual(config, { providers: undefined, roles: undefined });
  } finally {
    t.cleanup();
  }
});

test("loadConfig: invalid JSON throws INVALID_CONFIG naming the file", () => {
  const t = tempTree();
  try {
    const p = path.join(t.cwd, ".datum", "config.json");
    writeFileSync(p, "{ not json");
    assert.throws(
      () => loadConfig({ home: t.home, cwd: t.cwd }),
      (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG" && (e as Error).message.includes(p),
    );
  } finally {
    t.cleanup();
  }
});

test("repoConfigPath: defaults to <cwd>/.datum/config.json", () => {
  assert.equal(repoConfigPath({ cwd: "/tmp/some-repo" }), path.join("/tmp/some-repo", ".datum", "config.json"));
});

test("repoConfigPath: explicit override wins over the cwd-derived default", () => {
  assert.equal(repoConfigPath({ cwd: "/tmp/some-repo", repoConfigPath: "/elsewhere/config.json" }), "/elsewhere/config.json");
});

test("userConfigPath: unchanged at <home>/.config/kontour/datum.json", () => {
  assert.equal(userConfigPath({ home: "/tmp/some-home" }), path.join("/tmp/some-home", ".config", "kontour", "datum.json"));
});

test("loadConfig: new .datum/config.json path is discovered", () => {
  const t = tempTree();
  try {
    t.writeRepo({ providers: { zai: { kind: "anthropic-compatible", auth: { env: "TEST_ZAI_KEY" }, models: ["glm-5.2"] } } });
    const { config, sources } = loadConfig({ home: t.home, cwd: t.cwd });
    assert.equal(sources.length, 1);
    assert.equal(sources[0], path.join(t.cwd, ".datum", "config.json"));
    assert.ok(config.providers!.zai);
  } finally {
    t.cleanup();
  }
});

test("loadConfig: the retired .kontour/datum.json path is NOT read (clean cutover, no fallback)", () => {
  const t = tempTree();
  try {
    mkdirSync(path.join(t.cwd, ".kontour"), { recursive: true });
    writeFileSync(
      path.join(t.cwd, ".kontour", "datum.json"),
      JSON.stringify({ providers: { zai: { kind: "anthropic-compatible", auth: { env: "TEST_ZAI_KEY" }, models: ["glm-5.2"] } } }),
    );
    const { config, sources } = loadConfig({ home: t.home, cwd: t.cwd });
    assert.equal(sources.length, 0);
    assert.deepEqual(config, { providers: undefined, roles: undefined });
  } finally {
    t.cleanup();
  }
});

test("loadConfig: when both .datum/config.json and a stray .kontour/datum.json exist, only the new path is used", () => {
  const t = tempTree();
  try {
    mkdirSync(path.join(t.cwd, ".kontour"), { recursive: true });
    writeFileSync(
      path.join(t.cwd, ".kontour", "datum.json"),
      JSON.stringify({ providers: { zai: { kind: "anthropic-compatible", baseUrl: "https://old", auth: { env: "TEST_ZAI_KEY" }, models: ["glm-4.6"] } } }),
    );
    t.writeRepo({
      providers: { zai: { kind: "anthropic-compatible", baseUrl: "https://new", auth: { env: "TEST_ZAI_KEY" }, models: ["glm-5.2"] } },
    });
    const { config, sources } = loadConfig({ home: t.home, cwd: t.cwd });
    assert.equal(sources.length, 1);
    assert.equal(sources[0], path.join(t.cwd, ".datum", "config.json"));
    assert.equal(config.providers!.zai.baseUrl, "https://new");
  } finally {
    t.cleanup();
  }
});
