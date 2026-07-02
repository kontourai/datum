import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor, probeAnthropicCompatible } from "../src/index.js";
import type { FetchLike } from "../src/index.js";
import { SAMPLE } from "./helpers.js";

test("doctor offline: config + roles pass, unset key warns (not fail)", async () => {
  const report = await runDoctor({ config: SAMPLE, env: { TEST_ZAI_KEY: "k" } });
  assert.equal(report.ok, true); // a missing key is warn, not fail
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
  assert.equal(byName["config"], "pass");
  assert.equal(byName["role extraction-default"], "pass");
  assert.equal(byName["key zai"], "pass");
  assert.equal(byName["key anthropic"], "warn"); // TEST_ANTHROPIC_KEY unset
});

test("doctor offline: an unresolvable role fails the report", async () => {
  const report = await runDoctor({
    config: { providers: {}, roles: { broken: "ghost@nowhere" } },
  });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => c.name === "role broken" && c.status === "fail"));
});

const okFetch: FetchLike = async () => ({ ok: true, status: 200 });
const authFetch: FetchLike = async () => ({ ok: false, status: 401 });
const downFetch: FetchLike = async () => {
  throw new Error("ECONNREFUSED");
};

test("probe unit: 200 pass, 401 auth fail, throw unreachable", async () => {
  const pass = await probeAnthropicCompatible({ apiKey: "k", model: "m" }, okFetch);
  assert.equal(pass.status, "pass");
  const auth = await probeAnthropicCompatible({ apiKey: "k", model: "m" }, authFetch);
  assert.equal(auth.status, "fail");
  assert.ok(auth.detail.includes("401"));
  const down = await probeAnthropicCompatible({ apiKey: "k", model: "m" }, downFetch);
  assert.equal(down.status, "fail");
  assert.ok(down.detail.includes("unreachable"));
});

test("probe builds /v1/messages with max_tokens 1 and x-api-key", async () => {
  let captured: any;
  const spy: FetchLike = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200 };
  };
  await probeAnthropicCompatible({ baseUrl: "https://api.z.ai/api/anthropic", apiKey: "k", model: "glm-5.2" }, spy);
  assert.equal(captured.url, "https://api.z.ai/api/anthropic/v1/messages");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["x-api-key"], "k");
  assert.equal(captured.init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.max_tokens, 1);
  assert.equal(body.model, "glm-5.2");
});

test("doctor --probe: injected fetch, anthropic-compatible probed, key materialized", async () => {
  const report = await runDoctor({
    config: SAMPLE,
    env: { TEST_ZAI_KEY: "k1", TEST_ANTHROPIC_KEY: "k2" },
    probe: true,
    fetchImpl: okFetch,
  });
  assert.equal(report.ok, true);
  const probes = report.checks.filter((c) => c.name.startsWith("probe "));
  assert.equal(probes.length, 2);
  assert.ok(probes.every((p) => p.status === "pass"));
});

test("doctor --probe: non-anthropic kind is skipped, not failed", async () => {
  const report = await runDoctor({
    config: { providers: { oai: { kind: "openai-compatible", auth: { env: "OAI_KEY" }, models: ["gpt"] } } },
    env: { OAI_KEY: "k" },
    probe: true,
    fetchImpl: okFetch,
  });
  const probe = report.checks.find((c) => c.name === "probe oai");
  assert.equal(probe?.status, "skip");
});
