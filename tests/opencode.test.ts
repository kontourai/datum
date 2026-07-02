import { test } from "node:test";
import assert from "node:assert/strict";
import { generateOpencodeProviderBlock, mergeIntoOpencodeConfig, npmForKind } from "../src/index.js";
import { SAMPLE } from "./helpers.js";

test("npmForKind maps known kinds, undefined otherwise", () => {
  assert.equal(npmForKind("anthropic-compatible"), "@ai-sdk/anthropic");
  assert.equal(npmForKind("openai-compatible"), "@ai-sdk/openai-compatible");
  assert.equal(npmForKind("something-else"), undefined);
});

test("generate: emits env var NAME, never the secret (options.apiKey absent)", () => {
  const { block } = generateOpencodeProviderBlock(SAMPLE);
  const zai = block.provider.zai;
  assert.equal(zai.npm, "@ai-sdk/anthropic");
  assert.deepEqual(zai.env, ["TEST_ZAI_KEY"]);
  assert.equal(zai.options?.baseURL, "https://api.z.ai/api/anthropic");
  assert.deepEqual(Object.keys(zai.models).sort(), ["glm-4.6", "glm-5.2"]);
  // Secret-reference-only: no apiKey anywhere in the generated block.
  assert.ok(!JSON.stringify(block).includes("apiKey"));
  // Provider without baseUrl -> no options object.
  assert.equal(block.provider.anthropic.options, undefined);
});

test("generate: skips unknown-kind provider with a warning", () => {
  const { block, warnings } = generateOpencodeProviderBlock({
    providers: { weird: { kind: "mystery-kind", auth: { env: "W_KEY" }, models: ["m"] } },
  });
  assert.equal(Object.keys(block.provider).length, 0);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes("mystery-kind"));
});

test("merge: replaces only datum-owned provider ids, preserves the rest", () => {
  const existing = {
    model: "anthropic/claude-sonnet-5",
    provider: { keepme: { npm: "x" }, zai: { npm: "old" } },
  };
  const { block } = generateOpencodeProviderBlock(SAMPLE);
  const merged = mergeIntoOpencodeConfig(existing, block) as Record<string, any>;
  assert.equal(merged.model, "anthropic/claude-sonnet-5");
  assert.ok(merged.provider.keepme); // untouched
  assert.equal(merged.provider.zai.npm, "@ai-sdk/anthropic"); // replaced
  assert.ok(merged.provider.anthropic); // added
});
