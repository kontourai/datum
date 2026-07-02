import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { deepMerge, loadConfig } from "../src/index.js";
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
    const p = path.join(t.cwd, ".kontour", "datum.json");
    writeFileSync(p, "{ not json");
    assert.throws(
      () => loadConfig({ home: t.home, cwd: t.cwd }),
      (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG" && (e as Error).message.includes(p),
    );
  } finally {
    t.cleanup();
  }
});
