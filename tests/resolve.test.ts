import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, resolveRef } from "../src/index.js";
import { SAMPLE } from "./helpers.js";

const base = { config: SAMPLE };

test("resolve: role -> materialized target with 1:1 traverse opts", () => {
  const KEY = "live-key-value";
  const r = resolve("extraction-default", { ...base, env: { TEST_ZAI_KEY: KEY } });
  assert.equal(r.provider, "zai");
  assert.equal(r.kind, "anthropic-compatible");
  assert.equal(r.baseUrl, "https://api.z.ai/api/anthropic");
  assert.equal(r.model, "glm-5.2");
  assert.equal(r.apiKey, KEY);
  // Exactly the traverse createAnthropicExtractionProvider option keys.
  assert.deepEqual(Object.keys(r).sort(), ["apiKey", "baseUrl", "kind", "model", "provider"]);
});

test("resolve: model@provider ref directly", () => {
  const r = resolve("claude-haiku-4-5@anthropic", { ...base, env: { TEST_ANTHROPIC_KEY: "k" } });
  assert.equal(r.provider, "anthropic");
  assert.equal(r.model, "claude-haiku-4-5");
  assert.equal(r.baseUrl, undefined); // no baseUrl configured -> omitted
});

test("resolve: bare model unique across providers", () => {
  const r = resolve("glm-4.6", { ...base, env: { TEST_ZAI_KEY: "k" } });
  assert.equal(r.provider, "zai");
  assert.equal(r.model, "glm-4.6");
});

test("resolveRef: no secret materialization, reports env var + set flag", () => {
  const r = resolveRef("extraction-default", { ...base, env: { TEST_ZAI_KEY: "k" } });
  assert.equal(r.apiKeyEnv, "TEST_ZAI_KEY");
  assert.equal(r.apiKeySet, true);
  assert.ok(!("apiKey" in r));
  const missing = resolveRef("worker", { config: SAMPLE, env: { TEST_ANTHROPIC_KEY: "" } });
  assert.equal(missing.apiKeySet, false);
});

test("error: unknown role", () => {
  assert.throws(
    () => resolveRef("nope", base),
    (e: unknown) => (e as { code: string }).code === "UNKNOWN_ROLE",
  );
});

test("error: unknown provider in model@provider", () => {
  assert.throws(
    () => resolveRef("glm-5.2@ghost", base),
    (e: unknown) => (e as { code: string }).code === "UNKNOWN_PROVIDER",
  );
});

test("error: ambiguous bare model", () => {
  const cfg = {
    providers: {
      a: { kind: "anthropic-compatible", auth: { env: "A_KEY" }, models: ["shared"] },
      b: { kind: "anthropic-compatible", auth: { env: "B_KEY" }, models: ["shared"] },
    },
  };
  assert.throws(
    () => resolveRef("shared", { config: cfg }),
    (e: unknown) => (e as { code: string }).code === "AMBIGUOUS_MODEL",
  );
});

test("error: role target names a nonexistent bare model -> UNKNOWN_MODEL", () => {
  const cfg = {
    providers: { z: { kind: "anthropic-compatible", auth: { env: "Z_KEY" }, models: ["real"] } },
    roles: { broken: "ghost" },
  };
  assert.throws(
    () => resolveRef("broken", { config: cfg }),
    (e: unknown) => (e as { code: string }).code === "UNKNOWN_MODEL",
  );
});

test("error: missing env var names the variable", () => {
  assert.throws(
    () => resolve("worker", { config: SAMPLE, env: { TEST_ANTHROPIC_KEY: "" } }),
    (e: unknown) =>
      (e as { code: string }).code === "MISSING_ENV" &&
      (e as Error).message.includes("TEST_ANTHROPIC_KEY"),
  );
});

test("escape hatch: DATUM_ROLE_<NAME> overrides role target", () => {
  const r = resolve("extraction-default", {
    ...base,
    env: { DATUM_ROLE_EXTRACTION_DEFAULT: "claude-sonnet-5@anthropic", TEST_ANTHROPIC_KEY: "k" },
  });
  assert.equal(r.provider, "anthropic");
  assert.equal(r.model, "claude-sonnet-5");
});

test("escape hatch: DATUM_BASEURL_<PROVIDER> overrides base URL", () => {
  const r = resolve("extraction-default", {
    ...base,
    env: { DATUM_BASEURL_ZAI: "https://proxy.internal", TEST_ZAI_KEY: "k" },
  });
  assert.equal(r.baseUrl, "https://proxy.internal");
});

test("precedence: opts.env wins over process.env", () => {
  process.env.TEST_ZAI_KEY = "from-process";
  try {
    const viaProcess = resolve("extraction-default", base);
    assert.equal(viaProcess.apiKey, "from-process");
    const overridden = resolve("extraction-default", { ...base, env: { TEST_ZAI_KEY: "from-opts" } });
    assert.equal(overridden.apiKey, "from-opts");
  } finally {
    delete process.env.TEST_ZAI_KEY;
  }
});
