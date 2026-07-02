import { test } from "node:test";
import assert from "node:assert/strict";
import {
  generateClaudeCodeEnv,
  mergeIntoClaudeCodeSettings,
  resolveRef,
  CLAUDE_CODE_MANAGED_ENV_KEYS,
} from "../src/index.js";
import { SAMPLE, MULTI_AUTH, fakeRunner } from "./helpers.js";

test("generate: emits ANTHROPIC_BASE_URL + ANTHROPIC_MODEL, never a key", () => {
  const r = resolveRef("extraction-default", { config: SAMPLE, env: { TEST_ZAI_KEY: "k" } });
  const gen = generateClaudeCodeEnv("extraction-default", r);
  assert.equal(gen.env.ANTHROPIC_MODEL, "glm-5.2");
  assert.equal(gen.env.ANTHROPIC_BASE_URL, "https://api.z.ai/api/anthropic");
  assert.deepEqual(gen.ownedKeys.sort(), ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]);
  // No secret anywhere in the generated env or instruction value.
  assert.ok(!JSON.stringify(gen.env).includes("k"));
  assert.ok(gen.apiKeyInstruction.includes("TEST_ZAI_KEY"));
  assert.ok(gen.apiKeyInstruction.includes("NEVER"));
});

test("generate: provider without baseUrl omits ANTHROPIC_BASE_URL", () => {
  const r = resolveRef("worker", { config: SAMPLE, env: { TEST_ANTHROPIC_KEY: "k" } });
  const gen = generateClaudeCodeEnv("worker", r);
  assert.equal(gen.env.ANTHROPIC_BASE_URL, undefined);
  assert.deepEqual(gen.ownedKeys, ["ANTHROPIC_MODEL"]);
});

test("generate: rejects non-anthropic-compatible kind", () => {
  const cfg = {
    providers: { oai: { kind: "openai-compatible", baseUrl: "https://x/v1", auth: { env: "OAI_KEY" }, models: ["gpt"] } },
    roles: { r: "gpt@oai" },
  };
  const r = resolveRef("r", { config: cfg, env: { OAI_KEY: "k" } });
  assert.throws(
    () => generateClaudeCodeEnv("r", r),
    (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG",
  );
});

test("generate: keychain/op instruction names the backend, no secret", () => {
  const runner = fakeRunner();
  const kc = generateClaudeCodeEnv("kc-role", resolveRef("kc-role", { config: MULTI_AUTH, secretRunner: runner }));
  assert.ok(kc.apiKeyInstruction.includes("Keychain"));
  assert.ok(kc.apiKeyInstruction.includes("datum-anthropic"));
  const op = generateClaudeCodeEnv("op-role", resolveRef("op-role", { config: MULTI_AUTH, secretRunner: runner }));
  assert.ok(op.apiKeyInstruction.includes("1Password"));
  assert.ok(op.apiKeyInstruction.includes("op://Private/anthropic/credential"));
});

test("merge: sets datum-owned env keys, preserves other settings/env", () => {
  const existing = {
    permissions: { deny: ["Read(./.env)"] },
    env: { CLAUDE_CODE_ENABLE_TELEMETRY: "1", ANTHROPIC_BASE_URL: "https://stale" },
  };
  const merged = mergeIntoClaudeCodeSettings(existing, { ANTHROPIC_MODEL: "glm-5.2", ANTHROPIC_BASE_URL: "https://new" }) as Record<string, any>;
  assert.deepEqual(merged.permissions, existing.permissions); // untouched
  assert.equal(merged.env.CLAUDE_CODE_ENABLE_TELEMETRY, "1"); // preserved
  assert.equal(merged.env.ANTHROPIC_BASE_URL, "https://new"); // replaced
  assert.equal(merged.env.ANTHROPIC_MODEL, "glm-5.2");
});

test("merge: re-sync to a baseUrl-less provider clears stale ANTHROPIC_BASE_URL", () => {
  const existing = { env: { ANTHROPIC_BASE_URL: "https://old", ANTHROPIC_MODEL: "old", KEEP: "yes" } };
  const merged = mergeIntoClaudeCodeSettings(existing, { ANTHROPIC_MODEL: "claude-sonnet-5" }) as Record<string, any>;
  assert.equal(merged.env.ANTHROPIC_BASE_URL, undefined); // stale managed key cleared
  assert.equal(merged.env.ANTHROPIC_MODEL, "claude-sonnet-5");
  assert.equal(merged.env.KEEP, "yes"); // non-managed key preserved
});

test("managed keys are exactly BASE_URL + MODEL", () => {
  assert.deepEqual([...CLAUDE_CODE_MANAGED_ENV_KEYS], ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]);
});
