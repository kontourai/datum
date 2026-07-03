import { test } from "node:test";
import assert from "node:assert/strict";
import {
  discoverModels,
  testConnection,
  fetchOpenaiCompatibleModels,
} from "../src/index.js";
import type { DiscoverFetchLike, DatumConfig } from "../src/index.js";
import { fakeRunner, MULTI_AUTH } from "./helpers.js";

const OAI_CONFIG: DatumConfig = {
  providers: {
    oai: {
      kind: "openai-compatible",
      baseUrl: "https://proxy.example/v1",
      auth: { env: "OAI_KEY" },
      models: ["gpt-4o"],
    },
  },
};

const ANTHROPIC_CONFIG: DatumConfig = {
  providers: {
    zai: {
      kind: "anthropic-compatible",
      baseUrl: "https://api.z.ai/api/anthropic",
      auth: { env: "TEST_ZAI_KEY" },
      models: ["glm-5.2", "glm-4.6"],
    },
  },
};


const modelsFetch = (ids: string[]): DiscoverFetchLike =>
  async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: ids.map((id) => ({ id })) }),
  });

const authFetch: DiscoverFetchLike = async () => ({
  ok: false,
  status: 401,
  text: async () => "",
});

const downFetch: DiscoverFetchLike = async () => {
  throw new Error("ECONNREFUSED");
};

const nonJsonFetch: DiscoverFetchLike = async () => ({
  ok: true,
  status: 200,
  text: async () => "<html>not json</html>",
});

const wrongShapeFetch: DiscoverFetchLike = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ok: true }),
});

test("discoverModels: success lists model ids from a fake /models response", async () => {
  const result = await discoverModels("oai", {
    config: OAI_CONFIG,
    env: { OAI_KEY: "k" },
    fetchImpl: modelsFetch(["gpt-4o", "gpt-4o-mini"]),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.models, ["gpt-4o", "gpt-4o-mini"]);
});

test("discoverModels: non-openai-compatible provider kind is rejected without a network call", async () => {
  let calls = 0;
  const spy: DiscoverFetchLike = async (...args) => {
    calls++;
    return modelsFetch(["x"])(...args);
  };
  const result = await discoverModels("zai", {
    config: ANTHROPIC_CONFIG,
    env: { TEST_ZAI_KEY: "k" },
    fetchImpl: spy,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "incompatible");
  assert.ok(result.detail.includes("anthropic-compatible"));
  assert.equal(calls, 0);
});

test("discoverModels: unknown provider id", async () => {
  const result = await discoverModels("does-not-exist", { config: OAI_CONFIG });
  assert.equal(result.ok, false);
  assert.ok(result.detail.includes("does-not-exist"));
  assert.ok(result.detail.includes("oai"));
});

test("discoverModels: missing env credential is reported (not thrown), no network call", async () => {
  let calls = 0;
  const spy: DiscoverFetchLike = async (...args) => {
    calls++;
    return modelsFetch(["x"])(...args);
  };
  const result = await discoverModels("oai", {
    config: OAI_CONFIG,
    env: {},
    fetchImpl: spy,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "auth");
  assert.ok(result.detail.includes("OAI_KEY"));
  assert.equal(calls, 0);
});

test("discoverModels: keychain/op auth unavailable short-circuits before any secret read or network call", async () => {
  const runner = fakeRunner({ keychain: false });
  let fetchCalls = 0;
  const spy: DiscoverFetchLike = async (...args) => {
    fetchCalls++;
    return modelsFetch(["x"])(...args);
  };
  const result = await discoverModels("kc", {
    config: {
      providers: {
        kc: {
          kind: "openai-compatible",
          auth: { keychain: { service: "datum-oai", account: "work" } },
          models: ["m"],
        },
      },
    },
    secretRunner: runner,
    fetchImpl: spy,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorClass, "auth");
  assert.ok(!runner.calls.some((c) => c.startsWith("readKeychain")));
  assert.equal(fetchCalls, 0);
});

test("fetchOpenaiCompatibleModels unit: builds GET {base}/models with Bearer auth", async () => {
  let captured: any;
  const spy: DiscoverFetchLike = async (url, init) => {
    captured = { url, init };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: "m" }] }) };
  };
  await fetchOpenaiCompatibleModels({ baseUrl: "https://proxy.example/v1", apiKey: "k" }, spy);
  assert.equal(captured.url, "https://proxy.example/v1/models");
  assert.equal(captured.init.method, "GET");
  assert.equal(captured.init.headers.authorization, "Bearer k");
});

test("testConnection: success (openai-compatible)", async () => {
  const report = await testConnection("oai", {
    config: OAI_CONFIG,
    env: { OAI_KEY: "k" },
    fetchImpl: modelsFetch(["gpt-4o"]),
  });
  assert.equal(report.ok, true);
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.status, "pass");
});

test("testConnection: success (anthropic-compatible, reuses probeAnthropicCompatible)", async () => {
  const okFetch: DiscoverFetchLike = async () => ({
    ok: true,
    status: 200,
    text: async () => "",
  });
  const report = await testConnection("zai", {
    config: ANTHROPIC_CONFIG,
    env: { TEST_ZAI_KEY: "k" },
    fetchImpl: okFetch,
  });
  assert.equal(report.ok, true);
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.status, "pass");
  assert.ok(connect?.detail.includes("HTTP 200"));
});

test("testConnection: anthropic-compatible auth diagnostic — 401 rejects via probeAnthropicCompatible, errorClass 'auth'", async () => {
  const report = await testConnection("zai", {
    config: ANTHROPIC_CONFIG,
    env: { TEST_ZAI_KEY: "k" },
    fetchImpl: authFetch,
  });
  assert.equal(report.ok, false);
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.errorClass, "auth");
  assert.ok(connect?.detail.includes("auth rejected"));
});

test("testConnection: anthropic-compatible unreachable diagnostic — fetch throws, errorClass 'unreachable'", async () => {
  const report = await testConnection("zai", {
    config: ANTHROPIC_CONFIG,
    env: { TEST_ZAI_KEY: "k" },
    fetchImpl: downFetch,
  });
  assert.equal(report.ok, false);
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.errorClass, "unreachable");
  assert.ok(connect?.detail.includes("unreachable"));
});

test("testConnection: anthropic-compatible incompatible diagnostic — non-auth/non-unreachable probe failure, errorClass 'incompatible'", async () => {
  const badStatusFetch: DiscoverFetchLike = async () => ({
    ok: false,
    status: 500,
    text: async () => "",
  });
  const report = await testConnection("zai", {
    config: ANTHROPIC_CONFIG,
    env: { TEST_ZAI_KEY: "k" },
    fetchImpl: badStatusFetch,
  });
  assert.equal(report.ok, false);
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.errorClass, "incompatible");
  assert.ok(connect?.detail.includes("unexpected HTTP 500"));
});

test("testConnection: auth diagnostic — missing env, no network call made", async () => {
  let calls = 0;
  const spy: DiscoverFetchLike = async (...args) => {
    calls++;
    return modelsFetch(["x"])(...args);
  };
  const report = await testConnection("oai", {
    config: OAI_CONFIG,
    env: {},
    fetchImpl: spy,
  });
  assert.equal(report.ok, false);
  const authCheck = report.checks.find((c) => c.errorClass === "auth");
  assert.ok(authCheck);
  assert.equal(calls, 0);
});

test("testConnection: auth diagnostic — 401 from live call", async () => {
  const report = await testConnection("oai", {
    config: OAI_CONFIG,
    env: { OAI_KEY: "k" },
    fetchImpl: authFetch,
  });
  assert.equal(report.ok, false);
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.errorClass, "auth");
  assert.ok(connect?.detail.includes("401"));
});

test("testConnection: unreachable diagnostic — fetch throws", async () => {
  const report = await testConnection("oai", {
    config: OAI_CONFIG,
    env: { OAI_KEY: "k" },
    fetchImpl: downFetch,
  });
  assert.equal(report.ok, false);
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.errorClass, "unreachable");
  assert.ok(connect?.detail.includes("unreachable"));
});

test("testConnection: incompatible diagnostic — 200 with non-JSON body", async () => {
  const report = await testConnection("oai", {
    config: OAI_CONFIG,
    env: { OAI_KEY: "k" },
    fetchImpl: nonJsonFetch,
  });
  assert.equal(report.ok, false);
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.errorClass, "incompatible");
  assert.ok(connect?.detail.includes("not valid JSON"));
});

test("testConnection: incompatible diagnostic — 200 JSON missing data:[{id}] shape", async () => {
  const report = await testConnection("oai", {
    config: OAI_CONFIG,
    env: { OAI_KEY: "k" },
    fetchImpl: wrongShapeFetch,
  });
  assert.equal(report.ok, false);
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.errorClass, "incompatible");
  assert.ok(connect?.detail.includes("{data:[{id}]}"));
});

test("testConnection: keychain/op auth unavailable short-circuits before any secret read or network call", async () => {
  const runner = fakeRunner({ keychain: false });
  let fetchCalls = 0;
  const spy: DiscoverFetchLike = async (...args) => {
    fetchCalls++;
    return modelsFetch(["x"])(...args);
  };
  const report = await testConnection("kc", {
    config: MULTI_AUTH,
    secretRunner: runner,
    fetchImpl: spy,
  });
  assert.equal(report.ok, false);
  const authCheck = report.checks.find((c) => c.errorClass === "auth");
  assert.ok(authCheck);
  assert.ok(!runner.calls.some((c) => c.startsWith("readKeychain")));
  assert.equal(fetchCalls, 0);
});

test("testConnection: unsupported kind is skipped, not failed", async () => {
  const report = await testConnection("weird", {
    config: { providers: { weird: { kind: "mystery-kind", auth: { env: "W_KEY" }, models: ["m"] } } },
    env: { W_KEY: "k" },
    fetchImpl: modelsFetch(["x"]),
  });
  const connect = report.checks.find((c) => c.name === "connect");
  assert.equal(connect?.status, "skip");
  assert.equal(report.ok, true);
});
