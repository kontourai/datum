import { test } from "node:test";
import assert from "node:assert/strict";
import { runDoctor, probeAnthropicCompatible, probeOpenaiCompatible } from "../src/index.js";
import type { FetchLike } from "../src/index.js";
import { SAMPLE, MULTI_AUTH, fakeRunner, tempTree } from "./helpers.js";

test("doctor offline: config + roles pass, unset key warns (not fail)", async () => {
  const report = await runDoctor({ config: SAMPLE, env: { TEST_ZAI_KEY: "k" } });
  assert.equal(report.ok, true); // a missing key is warn, not fail
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c.status]));
  assert.equal(byName["config"], "pass");
  assert.equal(byName["role extraction-default"], "pass");
  assert.equal(byName["key zai"], "pass");
  assert.equal(byName["key anthropic"], "warn"); // TEST_ANTHROPIC_KEY unset
});

test("doctor: config check names the discovered .datum/config.json path", async () => {
  const t = tempTree();
  try {
    t.writeRepo({
      providers: { zai: { kind: "anthropic-compatible", auth: { env: "TEST_ZAI_KEY" }, models: ["glm-5.2"] } },
    });
    const report = await runDoctor({ home: t.home, cwd: t.cwd, env: { TEST_ZAI_KEY: "k" } });
    const configCheck = report.checks.find((c) => c.name === "config");
    assert.ok(configCheck);
    assert.ok(configCheck!.detail.includes(".datum/config.json"));
  } finally {
    t.cleanup();
  }
});

test("doctor offline: an unresolvable role fails the report", async () => {
  const report = await runDoctor({
    config: { providers: {}, roles: { broken: "ghost@nowhere" } },
  });
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => c.name === "role broken" && c.status === "fail"));
});

test("doctor offline: a capability policy is validated but runtime resolution is skipped", async () => {
  const report = await runDoctor({
    config: {
      roles: {
        planner: { policy: { requirements: [], preferences: [], locality: "local-only" } },
      },
    },
  });
  assert.equal(report.ok, true);
  const role = report.checks.find((check) => check.name === "role planner");
  assert.equal(role?.status, "skip");
  assert.ok(role?.detail.includes("runtime inventory"));
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

test("doctor --probe: unknown kind is skipped, not failed", async () => {
  const report = await runDoctor({
    config: { providers: { weird: { kind: "mystery-kind", auth: { env: "W_KEY" }, models: ["m"] } } },
    env: { W_KEY: "k" },
    probe: true,
    fetchImpl: okFetch,
  });
  const probe = report.checks.find((c) => c.name === "probe weird");
  assert.equal(probe?.status, "skip");
});

test("probeOpenaiCompatible unit: POST /chat/completions with Bearer + max_tokens 1", async () => {
  let captured: any;
  const spy: FetchLike = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200 };
  };
  const pass = await probeOpenaiCompatible(
    { baseUrl: "https://proxy.example/v1", apiKey: "k", model: "gpt-x" },
    spy,
  );
  assert.equal(pass.status, "pass");
  assert.equal(captured.url, "https://proxy.example/v1/chat/completions");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.headers["authorization"], "Bearer k");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.max_tokens, 1);
  assert.equal(body.model, "gpt-x");
  const auth = await probeOpenaiCompatible({ apiKey: "k", model: "m" }, authFetch);
  assert.equal(auth.status, "fail");
  assert.ok(auth.detail.includes("401"));
});

test("doctor --probe: openai-compatible provider IS probed", async () => {
  const report = await runDoctor({
    config: { providers: { oai: { kind: "openai-compatible", baseUrl: "https://proxy.example/v1", auth: { env: "OAI_KEY" }, models: ["gpt"] } } },
    env: { OAI_KEY: "k" },
    probe: true,
    fetchImpl: okFetch,
  });
  const probe = report.checks.find((c) => c.name === "probe oai");
  assert.equal(probe?.status, "pass");
});

test("doctor: keychain/op key checks report availability, never read the secret", async () => {
  const runner = fakeRunner({ keychain: true, op: false });
  const report = await runDoctor({ config: MULTI_AUTH, env: { TEST_ZAI_KEY: "k" }, secretRunner: runner });
  const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
  assert.equal(byName["key zai"].status, "pass"); // env set
  assert.equal(byName["key kc"].status, "pass"); // keychain available
  assert.ok(byName["key kc"].detail.includes("security"));
  assert.equal(byName["key onepw"].status, "warn"); // op unavailable
  // No secret was read during offline checks.
  assert.ok(!runner.calls.some((c) => c.startsWith("readKeychain") || c.startsWith("readOp")));
  assert.equal(report.ok, true); // warnings do not fail the report
});

// --- HTTPS enforcement policy (datum#9) ---------------------------------

const PROBE_FNS: Array<[string, typeof probeAnthropicCompatible | typeof probeOpenaiCompatible]> = [
  ["probeAnthropicCompatible", probeAnthropicCompatible],
  ["probeOpenaiCompatible", probeOpenaiCompatible],
];

for (const [label, probeFn] of PROBE_FNS) {
  test(`${label}: non-loopback http:// baseUrl is blocked BEFORE fetchImpl is ever called`, async () => {
    let calls = 0;
    const spy: FetchLike = async (...args) => {
      calls++;
      return okFetch(...args);
    };
    const check = await probeFn({ baseUrl: "http://example.com", apiKey: "k", model: "m" }, spy);
    assert.equal(check.status, "fail");
    assert.ok(check.detail.includes("http://example.com"));
    assert.ok(check.detail.includes("https"));
    assert.ok(check.detail.includes("--allow-insecure"));
    assert.equal(calls, 0);
  });

  test(`${label}: loopback http:// baseUrl proceeds, no warning`, async () => {
    let calls = 0;
    const spy: FetchLike = async (...args) => {
      calls++;
      return okFetch(...args);
    };
    const check = await probeFn({ baseUrl: "http://127.0.0.1:4444", apiKey: "k", model: "m" }, spy);
    assert.equal(check.status, "pass");
    assert.equal(calls, 1);
    assert.equal(check.warning, undefined);
  });

  test(`${label}: non-loopback http:// with allowInsecure proceeds and warns`, async () => {
    let calls = 0;
    const spy: FetchLike = async (...args) => {
      calls++;
      return okFetch(...args);
    };
    const check = await probeFn(
      { baseUrl: "http://example.com", apiKey: "k", model: "m", allowInsecure: true },
      spy,
    );
    assert.equal(check.status, "pass");
    assert.equal(calls, 1);
    assert.ok(check.warning);
    assert.ok(check.warning!.includes("http://example.com"));
  });
}

test("runDoctor --probe: non-loopback http:// baseUrl blocks the probe, report is not ok", async () => {
  const report = await runDoctor({
    config: {
      providers: {
        insecure: { kind: "anthropic-compatible", baseUrl: "http://example.com", auth: { env: "I_KEY" }, models: ["m"] },
      },
    },
    env: { I_KEY: "k" },
    probe: true,
    fetchImpl: okFetch,
  });
  assert.equal(report.ok, false);
  const probe = report.checks.find((c) => c.name === "probe insecure");
  assert.equal(probe?.status, "fail");
  assert.ok(probe?.detail.includes("http://example.com"));
  assert.ok(probe?.detail.includes("https"));
  assert.ok(probe?.detail.includes("--allow-insecure"));
  assert.equal(report.warnings.length, 0);
});

test("probe: an https:// baseUrl that redirects to non-loopback http:// is blocked at the redirect hop — the key-bearing request is never re-issued to the insecure host", async () => {
  const seen: string[] = [];
  const redirectToInsecure: FetchLike = async (url) => {
    seen.push(url);
    return {
      ok: false,
      status: 302,
      headers: {
        get: (n) => (n.toLowerCase() === "location" ? "http://evil.example/v1/chat/completions" : null),
      },
    };
  };
  const check = await probeOpenaiCompatible(
    { baseUrl: "https://proxy.example/v1", apiKey: "k", model: "m" },
    redirectToInsecure,
  );
  assert.equal(check.status, "fail");
  assert.ok(check.detail.includes("http://evil.example"));
  assert.ok(check.detail.toLowerCase().includes("redirect"));
  assert.ok(check.detail.includes("--allow-insecure"));
  // The key-bearing request reached only the configured https host, never evil.
  assert.deepEqual(seen, ["https://proxy.example/v1/chat/completions"]);
});

test("probe: an https:// baseUrl that redirects to another https:// host is followed and the probe passes", async () => {
  const seen: string[] = [];
  const redirectToHttps: FetchLike = async (url) => {
    seen.push(url);
    if (seen.length === 1) {
      return {
        ok: false,
        status: 307,
        headers: { get: (n) => (n.toLowerCase() === "location" ? "https://relocated.example/v1/messages" : null) },
      };
    }
    return { ok: true, status: 200 };
  };
  const check = await probeAnthropicCompatible(
    { baseUrl: "https://old.example/v1", apiKey: "k", model: "m" },
    redirectToHttps,
  );
  assert.equal(check.status, "pass");
  assert.deepEqual(seen, ["https://old.example/v1/v1/messages", "https://relocated.example/v1/messages"]);
});

test("runDoctor --probe: allowInsecure lets the non-loopback http:// probe through and records exactly one warning", async () => {
  const report = await runDoctor({
    config: {
      providers: {
        insecure: { kind: "anthropic-compatible", baseUrl: "http://example.com", auth: { env: "I_KEY" }, models: ["m"] },
      },
    },
    env: { I_KEY: "k" },
    probe: true,
    fetchImpl: okFetch,
    allowInsecure: true,
  });
  assert.equal(report.ok, true);
  const probe = report.checks.find((c) => c.name === "probe insecure");
  assert.equal(probe?.status, "pass");
  assert.equal(report.warnings.length, 1);
  assert.ok(report.warnings[0].includes("http://example.com"));
});
