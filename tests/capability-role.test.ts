import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { compileCatalog, serializeCatalog, type ExecutionProfile, type ObservationInput } from "@kontourai/bearing";
import { refreshCapabilityCatalog, resolveCapabilityRole, validateConfig, type CapabilityRole, type CapabilityRoleRequest, type CapabilityRoleResolveOptions } from "../src/index.js";
import { tempTree } from "./helpers.js";

const execution: ExecutionProfile = {
  runtime: { id: "llama.cpp", version: "1" },
  adapter: null,
  effectiveContextTokens: 8192,
  toolSurface: [],
  hardware: null,
  workflow: null,
};

function candidate(id: string, providerId: string, providerModel: string, locality: "local" | "remote" | "unknown", canonicalModel = providerModel) {
  return {
    id,
    providerId,
    providerModel,
    locality,
    model: { id: canonicalModel, revision: null, quantization: null },
    execution,
  };
}

function catalog() {
  const observations: ObservationInput[] = ["remote", "local"].map((id) => ({
    schemaVersion: "bearing.observation/v1",
    kind: "declaration",
    model: { id, revision: null, quantization: null },
    execution,
    task: { family: "chat", suite: null, taskId: null, evaluator: { id: "fixture", version: "1" } },
    measurements: [{ key: "quality", kind: "fact", value: id === "remote" ? 10 : 5 }],
    outcome: null,
    usage: null,
    sourceClass: "first-party",
    evidence: [{ id: `e-${id}`, kind: "fixture", uri: null, digest: null, observedAt: "2026-07-18T00:00:00.000Z" }],
    freshness: { observedAt: "2026-07-18T00:00:00.000Z", validUntil: null },
    uncertainty: { level: "low", basis: ["fixture"], gaps: [] },
  }));
  return compileCatalog(observations, { asOf: "2026-07-18T00:00:00.000Z" });
}

function options(role: CapabilityRole, extra: Record<string, unknown> = {}): CapabilityRoleResolveOptions {
  const snapshot = catalog();
  return {
    config: {
      providers: {
        cloud: { kind: "openai-compatible", auth: { env: "CLOUD_KEY" }, models: ["remote", "missing"] },
        local: { kind: "openai-compatible", auth: { env: "LOCAL_KEY" }, models: ["local"] },
      },
      roles: { chat: role },
      ...extra,
    },
    env: { CLOUD_KEY: "present", LOCAL_KEY: "present" },
    catalog: { catalog: snapshot, metadata: { source: { kind: "local", location: "<local>", key: "f".repeat(64) }, digest: snapshot.digest, asOf: snapshot.asOf, ageSeconds: 0, fallback: false, notModified: false, diagnostics: [], warnings: [] } },
  };
}

function request(input: Omit<CapabilityRoleRequest, "schemaVersion">): CapabilityRoleRequest {
  return { schemaVersion: "datum.capability-role.request/v1", ...input };
}

test("resolveCapabilityRole: local-only policy filters a higher-ranked remote inventory candidate", () => {
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")],
  }), options({ policy: { requirements: [], preferences: [{ measurementKey: "quality", aggregation: "fact", direction: "maximize", weight: 1 }], locality: "local-only" } }));

  assert.equal(result.target?.id, "local");
  assert.ok(result.exclusions.some((entry) => entry.candidate.id === "remote" && entry.datumReasons.includes("DATUM_LOCALITY_DISALLOWED")));
});

test("resolveCapabilityRole: remote-allowed policy can select the top remote candidate", () => {
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")],
  }), options({ policy: { requirements: [], preferences: [{ measurementKey: "quality", aggregation: "fact", direction: "maximize", weight: 1 }], locality: "remote-allowed" } }));
  assert.equal(result.target?.id, "remote");
  assert.equal(result.alternatives[0]?.id, "local");
  assert.equal(result.target?.rank, 1);
  assert.ok(result.target?.reasons.some((reason) => reason.summary.length > 0));
});

test("resolveCapabilityRole: provider model binding and Bearing canonical identity remain explicit and independent", () => {
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "qwen3-coder:30b", "remote", "remote")],
  }), options({ policy: { requirements: [], preferences: [{ measurementKey: "quality", aggregation: "fact", direction: "maximize", weight: 1 }], locality: "remote-allowed" } }, {
    providers: { cloud: { kind: "openai-compatible", auth: { env: "CLOUD_KEY" }, models: ["qwen3-coder:30b"] } },
  }));
  assert.equal(result.target?.providerModel, "qwen3-coder:30b");
  assert.equal(result.target?.model.id, "remote");
  assert.equal(result.target?.provider, "cloud");
  assert.equal(result.target?.kind, "openai-compatible");
});

test("resolveCapabilityRole: Datum skips a ranked candidate with unavailable auth and records a stable exclusion", () => {
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")],
  }), { ...options({ policy: { requirements: [], preferences: [{ measurementKey: "quality", aggregation: "fact", direction: "maximize", weight: 1 }], locality: "remote-allowed" } }), env: { LOCAL_KEY: "present" } });
  assert.equal(result.target?.id, "local");
  assert.ok(result.exclusions.some((entry) => entry.candidate.id === "remote" && entry.datumReasons.includes("DATUM_AUTH_UNAVAILABLE")));
});

test("resolveCapabilityRole: Datum independently enforces provider and provider-model inventory bindings", () => {
  const role = { policy: { requirements: [], preferences: [{ measurementKey: "quality", aggregation: "fact" as const, direction: "maximize" as const, weight: 1 }], locality: "remote-allowed" as const } };
  const cases = [
    { remote: candidate("remote", "absent", "remote", "remote", "remote"), reason: "DATUM_PROVIDER_MISSING" },
    { remote: candidate("remote", "cloud", "not-configured", "remote", "remote"), reason: "DATUM_PROVIDER_MODEL_UNCONFIGURED" },
  ] as const;
  for (const entry of cases) {
    const result = resolveCapabilityRole("chat", request({
      task: { family: "chat", suite: null },
      inventory: [entry.remote, candidate("local", "local", "local", "local")],
    }), options(role));
    assert.equal(result.target?.id, "local");
    assert.ok(result.exclusions.some((excluded) => excluded.candidate.id === "remote" && excluded.datumReasons.includes(entry.reason)));
  }
});

test("resolveCapabilityRole: caller requirements are additive to durable requirements", () => {
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")],
    requirements: [{ measurementKey: "quality", aggregation: "fact", operator: "lte", value: 5 }],
  }), options({ policy: {
    requirements: [{ measurementKey: "quality", aggregation: "fact", operator: "gte", value: 10 }],
    preferences: [],
    locality: "remote-allowed",
  } }));
  assert.equal(result.target, null);
  assert.deepEqual(result.exclusions.map((entry) => entry.candidate.id).sort(), ["local", "remote"]);
});

test("resolveCapabilityRole: effective base URL honors the existing environment override", () => {
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote")],
  }), {
    ...options("remote@cloud"),
    env: { CLOUD_KEY: "present", DATUM_BASEURL_CLOUD: "http://127.0.0.1:11434/v1" },
  });
  assert.equal(result.target?.baseUrl, "http://127.0.0.1:11434/v1");
});

test("resolveCapabilityRole: fixed durable, session, and environment targets are authoritative but inventory-bounded", () => {
  const inventory = [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")];
  const durable = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory }), options("local@local"));
  assert.equal(durable.target?.id, "local");
  const bareDurable = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory }), options("local"));
  assert.equal(bareDurable.target?.id, "local");
  const session = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory, fixedOverride: "remote@cloud" }), options("local@local"));
  assert.equal(session.target?.id, "remote");
  assert.equal(session.override.source, "session");
  const environment = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory }), { ...options("local@local"), env: { CLOUD_KEY: "present", LOCAL_KEY: "present", DATUM_ROLE_CHAT: "remote@cloud" } });
  assert.equal(environment.target?.id, "remote");
  const absent = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory }), { ...options("local@local"), env: { CLOUD_KEY: "present", LOCAL_KEY: "present", DATUM_ROLE_CHAT: "missing@cloud" } });
  assert.equal(absent.target, null);
  assert.equal(absent.posture, "unavailable");
  assert.equal(absent.diagnostics[0]?.code, "DATUM_OVERRIDE_NOT_IN_INVENTORY");
});

test("resolveCapabilityRole: bare fixed targets never dispatch through colliding role names", () => {
  const inventory = [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")];
  const base = options("local");
  const collisionConfig = { ...base.config!, roles: { chat: "local", local: "remote@cloud" } };
  const durable = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory }), { ...base, config: collisionConfig });
  assert.equal(durable.target?.id, "local");

  const environment = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory }), {
    ...base,
    config: { ...collisionConfig, roles: { chat: "remote@cloud", local: "remote@cloud" } },
    env: { CLOUD_KEY: "present", LOCAL_KEY: "present", DATUM_ROLE_CHAT: "local" },
  });
  assert.equal(environment.target?.id, "local");

  const policy = { policy: { requirements: [], preferences: [], locality: "local-only" as const, fallback: "local" } };
  const fallback = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory }), {
    ...base,
    catalog: undefined,
    config: { ...collisionConfig, roles: { chat: policy, local: "remote@cloud" }, capabilityCatalog: { localPath: "missing.json" } },
  });
  assert.equal(fallback.target?.id, "local");
});

test("resolveCapabilityRole: fixed-result uncertainty is isolated between calls", () => {
  const input = request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")] });
  const first = resolveCapabilityRole("chat", input, options("local@local"));
  first.target!.uncertainty.basis.push("caller mutation");
  const second = resolveCapabilityRole("chat", input, options("local@local"));
  assert.equal(second.target!.uncertainty.basis.includes("caller mutation"), false);
});

test("resolveCapabilityRole: missing or stale catalog uses only explicit inventory-bounded fallback", () => {
  const policy = { policy: { requirements: [], preferences: [], locality: "local-only" as const, fallback: "local@local" } };
  const fallback = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")] }), { ...options(policy), catalog: undefined, config: { ...options(policy).config!, capabilityCatalog: { localPath: "missing.json" } } });
  assert.equal(fallback.posture, "fallback");
  assert.equal(fallback.target?.id, "local");
  const noFallback = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")] }), { ...options({ policy: { requirements: [], preferences: [], locality: "local-only" } }), catalog: undefined, config: { ...options(policy).config!, roles: { chat: { policy: { requirements: [], preferences: [], locality: "local-only" } } }, capabilityCatalog: { localPath: "missing.json" } } });
  assert.equal(noFallback.posture, "unavailable");
  assert.equal(noFallback.target, null);

  const t = tempTree();
  try {
    writeFileSync(path.join(t.cwd, "catalog.json"), serializeCatalog(catalog()));
    const stale = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")] }), {
      ...options(policy), catalog: undefined, cwd: t.cwd, home: t.home,
      config: { ...options(policy).config!, capabilityCatalog: { localPath: "catalog.json", maxAgeSeconds: 1 } }, now: () => new Date("2026-07-18T00:00:02.000Z"),
    });
    assert.equal(stale.posture, "fallback");
    assert.equal(stale.diagnostics[0]?.code, "CAPABILITY_CATALOG_STALE");
    writeFileSync(path.join(t.cwd, "catalog.json"), "{}");
    const malformed = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")] }), {
      ...options(policy), catalog: undefined, cwd: t.cwd, home: t.home,
      config: { ...options(policy).config!, capabilityCatalog: { localPath: "catalog.json" } },
    });
    assert.equal(malformed.posture, "unavailable");
    assert.equal(malformed.target, null);
    assert.equal(malformed.fallback.used, false);
    assert.equal(malformed.diagnostics[0]?.code, "CAPABILITY_CATALOG_UNSUPPORTED_SCHEMA");
  } finally { t.cleanup(); }
});

test("resolveCapabilityRole: result ordering is deterministic and config policy runtime validation rejects unknown keys", () => {
  const role = { policy: { requirements: [], preferences: [], locality: "remote-allowed" as const } };
  const rankedRequest = request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local"), candidate("remote", "cloud", "remote", "remote")] });
  const one = resolveCapabilityRole("chat", rankedRequest, options(role));
  const two = resolveCapabilityRole("chat", rankedRequest, options(role));
  assert.deepEqual([one.target?.id, ...one.alternatives.map((entry) => entry.id)], [two.target?.id, ...two.alternatives.map((entry) => entry.id)]);
  assert.throws(() => validateConfig({ roles: { chat: { policy: { requirements: [], preferences: [], locality: "local-only", unknown: true } } } }), (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG");
  assert.throws(() => validateConfig({ roles: { chat: { policy: { requirements: [{ measurementKey: "quality", aggregation: "fact", operator: "gte", value: "high" }], preferences: [], locality: "local-only" } } } }), (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG");
});

test("resolveCapabilityRole: malformed request envelope, Bearing execution, and criteria are typed INVALID_CONFIG", () => {
  const role = { policy: { requirements: [], preferences: [], locality: "remote-allowed" as const } };
  const base = request({ task: { family: "chat", suite: null }, inventory: [candidate("remote", "cloud", "remote", "remote")] });
  const malformed = [
    { ...base, schemaVersion: "datum.capability-role.request/v0" },
    { ...base, inventory: [{ ...base.inventory[0], execution: { ...execution, runtime: { id: "fixture", version: 1 } } }] },
    { ...base, preferences: [{ measurementKey: "quality", aggregation: "fact", direction: "maximize", weight: 1, unknown: true }] },
  ];
  for (const input of malformed) {
    assert.throws(() => resolveCapabilityRole("chat", input as unknown as CapabilityRoleRequest, options(role)), (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG");
  }
});

test("resolveCapabilityRole: a remote catalog resolves offline from its validated cache", async () => {
  const t = tempTree();
  const cacheRoot = path.join(t.dir, "cache");
  try {
    const role = { policy: { requirements: [], preferences: [], locality: "remote-allowed" as const } };
    const config = { ...options(role).config!, capabilityCatalog: { remoteUrl: "https://93.184.216.34/snapshot.json" } };
    await refreshCapabilityCatalog({ cwd: t.cwd, home: t.home, config, cacheRoot, now: () => new Date("2026-07-18T00:00:00.000Z"), transport: async () => new Response(serializeCatalog(catalog()), { status: 200 }) });
    const result = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")] }), { cwd: t.cwd, home: t.home, config, cacheRoot, env: { CLOUD_KEY: "present", LOCAL_KEY: "present" }, now: () => new Date("2026-07-18T00:00:00.000Z") });
    assert.equal(result.target?.id, "local");
    assert.equal(result.catalog?.metadata.source.kind, "remote");
  } finally { t.cleanup(); }
});

test("resolveCapabilityRole: injected catalogs are validated, freshness-checked, and metadata-bound", () => {
  const policy = { policy: { requirements: [], preferences: [], locality: "local-only" as const, fallback: "local@local" } };
  const input = request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")] });
  const base = options(policy);
  const configured = { ...base.config!, capabilityCatalog: { localPath: "unused.json", maxAgeSeconds: 1 } };

  const stale = resolveCapabilityRole("chat", input, { ...base, config: configured, now: () => new Date("2026-07-18T00:00:02.000Z") });
  assert.equal(stale.posture, "fallback");
  assert.equal(stale.diagnostics[0]?.code, "CAPABILITY_CATALOG_STALE");

  const future = resolveCapabilityRole("chat", input, { ...base, config: configured, now: () => new Date("2026-07-17T23:59:59.000Z") });
  assert.equal(future.posture, "unavailable");
  assert.equal(future.fallback.used, false);
  assert.equal(future.diagnostics[0]?.code, "CAPABILITY_CATALOG_MALFORMED");

  const mismatchCatalog = { ...base.catalog!, metadata: { ...base.catalog!.metadata, digest: "0".repeat(64) } };
  const mismatch = resolveCapabilityRole("chat", input, { ...base, catalog: mismatchCatalog });
  assert.equal(mismatch.posture, "unavailable");
  assert.equal(mismatch.diagnostics[0]?.code, "CAPABILITY_CATALOG_DIGEST_MISMATCH");

  const malformed = resolveCapabilityRole("chat", input, { ...base, catalog: { catalog: {}, metadata: base.catalog!.metadata } as CapabilityRoleResolveOptions["catalog"] });
  assert.equal(malformed.posture, "unavailable");
  assert.equal(malformed.diagnostics[0]?.code, "CAPABILITY_CATALOG_UNSUPPORTED_SCHEMA");

  const oversizedCatalog = { ...base.catalog!, catalog: { ...base.catalog!.catalog, padding: "x".repeat(5 * 1024 * 1024) } };
  const oversized = resolveCapabilityRole("chat", input, { ...base, catalog: oversizedCatalog as CapabilityRoleResolveOptions["catalog"] });
  assert.equal(oversized.posture, "unavailable");
  assert.equal(oversized.diagnostics[0]?.code, "CAPABILITY_CATALOG_LIMIT_EXCEEDED");

  const inheritedCatalog = JSON.parse(`{"__proto__":${JSON.stringify(base.catalog)}}`) as CapabilityRoleResolveOptions["catalog"];
  const inherited = resolveCapabilityRole("chat", input, { ...base, catalog: inheritedCatalog });
  assert.equal(inherited.posture, "unavailable");
  assert.equal(inherited.diagnostics[0]?.code, "CAPABILITY_CATALOG_MALFORMED");
});

test("resolveCapabilityRole: embedded requests bound nested execution complexity", () => {
  const role = { policy: { requirements: [], preferences: [], locality: "local-only" as const } };
  const tooManyTools = candidate("local", "local", "local", "local");
  tooManyTools.execution = { ...execution, toolSurface: Array.from({ length: 129 }, (_, index) => `tool-${index}`) };
  assert.throws(
    () => resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [tooManyTools] }), options(role)),
    (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG",
  );
  const longModel = candidate("local", "local", "local", "local");
  longModel.model.id = "x".repeat(257);
  assert.throws(
    () => resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [longModel] }), options(role)),
    (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG",
  );

  const concealed = request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")] });
  Object.defineProperty(concealed, "toJSON", {
    enumerable: false,
    value: () => ({ schemaVersion: concealed.schemaVersion }),
  });
  assert.throws(
    () => resolveCapabilityRole("chat", concealed, options(role)),
    (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG",
  );

  const inherited = JSON.parse(`{"__proto__":${JSON.stringify(request({
    task: { family: "chat", suite: null },
    inventory: [candidate("local", "local", "local", "local")],
  }))}}`) as CapabilityRoleRequest;
  assert.throws(
    () => resolveCapabilityRole("chat", inherited, options(role)),
    (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG",
  );
});
