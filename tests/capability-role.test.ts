import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileCatalog, serializeCatalog, type ExecutionProfile, type ObservationInput } from "@kontourai/bearing";
import { refreshCapabilityCatalog, resolveCapabilityRole, validateConfig, type CapabilityProviderBinding, type CapabilityRole, type CapabilityRoleRequest, type CapabilityRoleResolveOptions, type CapabilityRuntimeCandidate } from "../src/index.js";
import { fakeRunner, tempTree } from "./helpers.js";

const execution: ExecutionProfile = {
  runtime: { id: "llama.cpp", version: "1" },
  adapter: null,
  effectiveContextTokens: 8192,
  toolSurface: [],
  hardware: null,
  workflow: null,
};

function candidate(id: string, providerId: string, providerModel: string, locality: "local" | "remote" | "unknown", canonicalModel = providerModel): CapabilityRuntimeCandidate {
  return {
    id,
    providerId,
    providerModel,
    locality,
    model: { id: canonicalModel, revision: null, quantization: null },
    execution,
  };
}

interface StationModelFixture {
  schemaVersion: "station.model-inventory/v2";
  models: Array<{
    id: string;
    providerId: string;
    providerModel: string;
    locality: "local" | "remote" | "unknown";
    model: CapabilityRuntimeCandidate["model"];
    runtime: CapabilityRuntimeCandidate["execution"]["runtime"];
    adapter: CapabilityRuntimeCandidate["execution"]["adapter"];
    effectiveContextTokens: number | null;
    toolSurface: string[] | null;
  }>;
}

function stationFixtureCandidates(): CapabilityRuntimeCandidate[] {
  const fixture = JSON.parse(
    readFileSync(path.join(process.cwd(), "tests/fixtures/station-model-inventory-v2.json"), "utf8"),
  ) as StationModelFixture;
  assert.equal(fixture.schemaVersion, "station.model-inventory/v2");
  return fixture.models.map((model) => ({
    id: model.id,
    providerId: model.providerId,
    providerModel: model.providerModel,
    locality: model.locality,
    model: model.model,
    execution: {
      runtime: model.runtime,
      adapter: model.adapter,
      effectiveContextTokens: model.effectiveContextTokens,
      toolSurface: model.toolSurface,
      hardware: null,
      workflow: null,
    },
  }));
}

function catalog() {
  const observations: ObservationInput[] = ["remote", "local"].map((id) => ({
    schemaVersion: "bearing.observation/v2",
    kind: "declaration",
    model: { id, revision: null, quantization: null },
    execution: { kind: "exact", ...execution },
    task: { family: "chat", suite: null, taskId: null, evaluator: { id: "fixture", version: "1" } },
    measurements: [
      { key: "quality", kind: "fact", value: id === "remote" ? 10 : 5 },
      { key: "context.projection", kind: "fact", value: id === "remote" ? "full" : "focused" },
    ],
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
        local: { kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434", auth: { env: "LOCAL_KEY" }, models: ["local"] },
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

function hostBindings(available = true): Record<string, CapabilityProviderBinding> {
  return {
    cloud: {
      kind: "openai-compatible",
      baseUrl: "https://cloud.example/v1",
      models: ["remote", "missing"],
      auth: { kind: "host", ref: "station", available },
    },
    local: {
      kind: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434",
      models: ["local"],
      auth: { kind: "host", ref: "station", available: true },
    },
  };
}

test("resolveCapabilityRole: local-only policy filters a higher-ranked remote inventory candidate", () => {
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")],
  }), options({ policy: { requirements: [], preferences: [{ measurementKey: "quality", aggregation: "fact", direction: "maximize", weight: 1 }], locality: "local-only" } }));

  assert.equal(result.target?.id, "local");
  assert.ok(result.exclusions.some((entry) => entry.candidate.id === "remote" && entry.datumReasons.includes("DATUM_LOCALITY_DISALLOWED")));
});

test("resolveCapabilityRole: local-only requires both caller locality and a configured loopback endpoint", () => {
  const policy = { policy: { requirements: [], preferences: [{ measurementKey: "quality", aggregation: "fact" as const, direction: "maximize" as const, weight: 1 }], locality: "local-only" as const } };
  const spoofed = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "local"), candidate("local", "local", "local", "local")],
  }), options(policy));
  assert.equal(spoofed.target?.id, "local");
  assert.ok(spoofed.exclusions.some((entry) => entry.candidate.id === "remote" && entry.datumReasons.includes("DATUM_LOCALITY_DISALLOWED")));

  const overridden = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")],
  }), { ...options(policy), env: { LOCAL_KEY: "present", DATUM_BASEURL_LOCAL: "https://remote.example/v1" } });
  assert.equal(overridden.target, null);
  assert.ok(overridden.exclusions[0].datumReasons.includes("DATUM_LOCALITY_DISALLOWED"));
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

test("resolveCapabilityRole: preserves Station-shaped unknown execution without lossy coercion", () => {
  const inventory = stationFixtureCandidates();
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory,
  }), options({ policy: {
    requirements: [],
    preferences: [{ measurementKey: "quality", aggregation: "fact", direction: "maximize", weight: 1 }],
    locality: "remote-allowed",
  } }));

  assert.equal(result.target?.id, "local");
  assert.deepEqual(result.target?.execution.toolSurface, []);
  const unknown = result.exclusions.find((entry) => entry.candidate.id === "remote");
  assert.ok(unknown);
  assert.equal(unknown.candidate.execution.runtime, null);
  assert.equal(unknown.candidate.execution.toolSurface, null);
  assert.deepEqual(unknown.datumReasons, ["DATUM_EXECUTION_PROFILE_INCOMPLETE"]);
  assert.deepEqual(unknown.uncertainty.gaps, ["runtime is unknown", "tool surface is unknown"]);
});

test("resolveCapabilityRole: preserves all runtime and tool-surface completeness states", () => {
  const states = [
    { id: "both-unknown", runtime: null, toolSurface: null, gaps: ["runtime is unknown", "tool surface is unknown"] },
    { id: "runtime-unknown", runtime: null, toolSurface: [], gaps: ["runtime is unknown"] },
    { id: "tools-unknown", runtime: execution.runtime, toolSurface: null, gaps: ["tool surface is unknown"] },
    { id: "complete", runtime: execution.runtime, toolSurface: [], gaps: [] },
  ];
  const inventory = states.map(({ id, runtime, toolSurface }) => ({
    ...candidate(id, "local", "local", "local", "local"),
    execution: { ...execution, runtime, toolSurface },
  }));

  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory,
  }), options({ policy: { requirements: [], preferences: [], locality: "remote-allowed" } }));

  assert.equal(result.target?.id, "complete");
  for (const state of states.slice(0, -1)) {
    const excluded = result.exclusions.find((entry) => entry.candidate.id === state.id);
    assert.ok(excluded);
    assert.deepEqual(excluded.candidate.execution.runtime, state.runtime);
    assert.deepEqual(excluded.candidate.execution.toolSurface, state.toolSurface);
    assert.deepEqual(excluded.uncertainty.gaps, state.gaps);
  }
});

test("resolveCapabilityRole: advisory bounds apply to the rankable partition", () => {
  const rankable = candidate("rankable", "local", "local", "local", "local");
  const incomplete = Array.from({ length: 127 }, (_, index) => ({
    ...candidate(`incomplete-${index}`, "cloud", "remote", "remote", "remote"),
    execution: { ...execution, runtime: null },
  }));
  const advisories = Array.from({ length: 9 }, (_, index) => ({
    id: `advisory-${index}`,
    measurementKey: "quality",
    aggregation: "fact" as const,
  }));

  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [rankable, ...incomplete],
  }), options({ policy: { requirements: [], preferences: [], advisories, locality: "remote-allowed" } }));

  assert.equal(result.target?.id, "rankable");
  assert.equal(result.exclusions.length, 127);
  assert.ok(result.exclusions.every((entry) => entry.datumReasons.includes("DATUM_EXECUTION_PROFILE_INCOMPLETE")));
});

test("resolveCapabilityRole: fixed overrides can select launchable candidates with incomplete execution", () => {
  const [unknown] = stationFixtureCandidates();
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [unknown],
    fixedOverride: "remote@cloud",
  }), options({ policy: { requirements: [], preferences: [], locality: "remote-allowed" } }));

  assert.equal(result.posture, "override");
  assert.equal(result.target?.id, "remote");
  assert.equal(result.target?.execution.runtime, null);
  assert.equal(result.target?.execution.toolSurface, null);
  assert.equal(result.target?.selection.reason, "DATUM_FIXED_SESSION_OVERRIDE");
});

test("resolveCapabilityRole: emergency fallback can select incomplete execution without invention", () => {
  const [unknown] = stationFixtureCandidates();
  const configured = options({ policy: {
    requirements: [],
    preferences: [],
    locality: "remote-allowed",
    fallback: "remote@cloud",
  } });
  configured.catalog = undefined;

  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [unknown],
  }), configured);

  assert.equal(result.posture, "fallback");
  assert.equal(result.target?.id, "remote");
  assert.equal(result.target?.execution.runtime, null);
  assert.equal(result.fallback.used, true);
  assert.equal(result.diagnostics[0]?.code, "CAPABILITY_CATALOG_UNAVAILABLE");
});

test("resolveCapabilityRole: all-incomplete policy inventory remains explicit and Bearing-validates criteria", () => {
  const [unknown] = stationFixtureCandidates();
  const role = { policy: { requirements: [], preferences: [], locality: "remote-allowed" as const } };
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [unknown],
  }), options(role));

  assert.equal(result.posture, "unavailable");
  assert.equal(result.target, null);
  assert.equal(result.catalog?.digest, catalog().digest);
  assert.deepEqual(result.exclusions.map((entry) => entry.datumReasons), [["DATUM_EXECUTION_PROFILE_INCOMPLETE"]]);
  assert.equal(result.diagnostics[0]?.code, "DATUM_NO_ELIGIBLE_TARGET");

  assert.throws(
    () => resolveCapabilityRole("chat", request({
      task: { family: "chat", suite: null },
      inventory: [unknown],
      requirements: [{
        measurementKey: "quality",
        aggregation: "fact",
        operator: "gte",
        value: "not-numeric",
      }],
    }), options(role)),
    (error: unknown) => (error as { code?: string; message?: string }).code === "INVALID_CONFIG"
      && (error as { message: string }).message.includes("must be numeric"),
  );
});

test("resolveCapabilityRole: partial runtime evidence applies only to matching inventory candidates", () => {
  const sharedModel = "example/shared-model";
  const partial: ObservationInput = {
    schemaVersion: "bearing.observation/v2",
    kind: "declaration",
    model: { id: sharedModel, revision: null, quantization: null },
    execution: {
      kind: "partial",
      runtime: { id: "openrouter", version: null },
      adapter: null,
      effectiveContextTokens: null,
      toolSurface: null,
      hardware: null,
      workflow: null,
    },
    task: null,
    measurements: [{ key: "model.context.max_tokens", kind: "fact", value: 1_050_000 }],
    outcome: null,
    usage: null,
    sourceClass: "external",
    evidence: [{ id: "runtime-scoped-context", kind: "source", uri: null, digest: null, observedAt: "2026-07-18T00:00:00.000Z" }],
    freshness: { observedAt: "2026-07-18T00:00:00.000Z", validUntil: null },
    uncertainty: { level: "moderate", basis: ["provider declaration"], gaps: [] },
  };
  const snapshot = compileCatalog([partial], { asOf: "2026-07-18T00:00:00.000Z" });
  const policy: CapabilityRole = { policy: {
    requirements: [{ measurementKey: "model.context.max_tokens", aggregation: "fact", operator: "gte", value: 1_000_000 }],
    preferences: [],
    locality: "remote-allowed",
  } };
  const openrouter = {
    ...candidate("remote", "cloud", "remote", "remote", sharedModel),
    execution: { ...execution, runtime: { id: "openrouter", version: "2026-07-18" } },
  };
  const local = candidate("local", "local", "local", "local", sharedModel);
  const configured = options(policy);
  configured.catalog = {
    catalog: snapshot,
    metadata: { source: { kind: "local", location: "<local>", key: "f".repeat(64) }, digest: snapshot.digest, asOf: snapshot.asOf, ageSeconds: 0, fallback: false, notModified: false, diagnostics: [], warnings: [] },
  };

  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [local, openrouter],
  }), configured);

  assert.equal(result.target?.id, "remote");
  assert.deepEqual(result.target?.reasons[0].executionApplicability.matchedKinds, ["partial"]);
  const excluded = result.exclusions.find((entry) => entry.candidate.id === "local");
  assert.equal(excluded?.reasons[0].code, "INCOMPARABLE_EVIDENCE");
  assert.deepEqual(excluded?.reasons[0].executionApplicability.mismatchedDimensions, ["runtime.id"]);
});

test("resolveCapabilityRole: passes generic Bearing advisories through without interpreting them", () => {
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")],
    advisories: [{ id: "quality-fact", measurementKey: "quality", aggregation: "fact" }],
  }), options({ policy: {
    requirements: [],
    preferences: [{ measurementKey: "quality", aggregation: "fact", direction: "maximize", weight: 1 }],
    advisories: [{ id: "context-projection", measurementKey: "context.projection", aggregation: "fact" }],
    locality: "remote-allowed",
  } }));

  assert.equal(result.target?.advisories.find((item) => item.id === "context-projection")?.value, "full");
  assert.equal(result.target?.advisories.find((item) => item.id === "quality-fact")?.value, 10);
  assert.equal(result.alternatives[0]?.advisories.find((item) => item.id === "context-projection")?.value, "focused");
  assert.deepEqual(result.advisories, result.target?.advisories);
  assert.ok(result.advisories.every((item) => item.evidence.evidenceIds.length > 0));
});

test("resolveCapabilityRole: preserves non-present advisories on Bearing exclusions", () => {
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")],
    requirements: [{ measurementKey: "quality", aggregation: "fact", operator: "gte", value: 8 }],
    advisories: [{ id: "missing-fact", measurementKey: "not.observed", aggregation: "fact" }],
  }), options({ policy: {
    requirements: [],
    preferences: [],
    advisories: [{ id: "context-projection", measurementKey: "context.projection", aggregation: "fact" }],
    locality: "remote-allowed",
  } }));

  const excluded = result.exclusions.find((entry) => entry.candidate.id === "local");
  assert.ok(excluded);
  assert.equal(excluded.advisories.find((item) => item.id === "missing-fact")?.status, "missing");
  assert.equal(excluded.advisories.find((item) => item.id === "context-projection")?.value, "focused");
});

test("resolveCapabilityRole: rejects invalid durable and request advisory composition before ranking", () => {
  const input = request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote")],
    advisories: [{ id: "same", measurementKey: "quality", aggregation: "fact" }],
  });
  assert.throws(
    () => resolveCapabilityRole("chat", input, options({ policy: {
      requirements: [], preferences: [],
      advisories: [{ id: "same", measurementKey: "context.projection", aggregation: "fact" }],
      locality: "remote-allowed",
    } })),
    (error: unknown) => (error as { code?: string; message?: string }).code === "INVALID_CONFIG"
      && (error as { message: string }).message.includes('duplicate id "same"'),
  );

  const sixtyFour = Array.from({ length: 64 }, (_, index) => ({ id: `durable-${index}`, measurementKey: "quality", aggregation: "fact" as const }));
  assert.throws(
    () => resolveCapabilityRole("chat", request({
      ...input,
      advisories: [{ id: "requested", measurementKey: "quality", aggregation: "fact" }],
    }), options({ policy: { requirements: [], preferences: [], advisories: sixtyFour, locality: "remote-allowed" } })),
    (error: unknown) => (error as { message?: string }).message?.includes("at most 64 entries") === true,
  );

  const inventory = Array.from({ length: 17 }, (_, index) => candidate(`remote-${index}`, "cloud", "remote", "remote", "remote"));
  const sixty = sixtyFour.slice(0, 60);
  assert.throws(
    () => resolveCapabilityRole("chat", request({
      task: { family: "chat", suite: null }, inventory,
      advisories: [{ id: "requested", measurementKey: "quality", aggregation: "fact" }],
    }), options({ policy: { requirements: [], preferences: [], advisories: sixty, locality: "remote-allowed" } })),
    (error: unknown) => (error as { message?: string }).message?.includes("at most 1024 projection cells") === true,
  );
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

test("resolveCapabilityRole: auth availability is evaluated once per configured provider", () => {
  const runner = fakeRunner({ op: true });
  const role = { policy: { requirements: [], preferences: [], locality: "remote-allowed" as const } };
  const configured = options(role, {
    providers: {
      shared: { kind: "openai-compatible", auth: { op: "op://vault/item/key" }, models: ["remote", "local"] },
    },
  });
  configured.secretRunner = runner;
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "shared", "remote", "remote"), candidate("local", "shared", "local", "remote")],
  }), configured);
  assert.ok(result.target);
  assert.equal(runner.calls.filter((call) => call === "opAvailable").length, 1);
});

test("resolveCapabilityRole: inherited role and provider names are never treated as configuration", () => {
  const role = { policy: { requirements: [], preferences: [], locality: "remote-allowed" as const } };
  const input = request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")] });
  assert.throws(
    () => resolveCapabilityRole("constructor", input, options(role)),
    (error: unknown) => (error as { code?: string }).code === "UNKNOWN_ROLE",
  );

  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "constructor", "remote", "remote"), candidate("local", "local", "local", "local")],
  }), options(role));
  assert.equal(result.target?.id, "local");
  assert.ok(result.exclusions.some((entry) => entry.candidate.providerId === "constructor" && entry.datumReasons.includes("DATUM_PROVIDER_MISSING")));
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

test("resolveCapabilityRole: host bindings supply authoritative non-secret provider readiness", () => {
  const role = { policy: { requirements: [], preferences: [{ measurementKey: "quality", aggregation: "fact" as const, direction: "maximize" as const, weight: 1 }], locality: "remote-allowed" as const } };
  const base = options(role);
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")],
  }), {
    ...base,
    config: { roles: base.config!.roles, capabilityCatalog: base.config!.capabilityCatalog },
    providerBindings: hostBindings(),
  });

  assert.equal(result.target?.id, "remote");
  assert.deepEqual(result.target?.auth, { kind: "host", ref: "station", available: true });
  assert.equal(JSON.stringify(result).includes("CLOUD_KEY"), false);
});

test("resolveCapabilityRole: host binding authority ids allow descriptive namespaces", () => {
  const base = options("local@local");
  const providerBindings = hostBindings();
  providerBindings.local.auth.ref = "station-provider-inventory";
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [candidate("local", "local", "local", "local")],
  }), { ...base, providerBindings });

  assert.equal(result.target?.auth.ref, "station-provider-inventory");
});

test("resolveCapabilityRole: host bindings fail closed for unavailable, absent, and mismatched providers", () => {
  const role = { policy: { requirements: [], preferences: [{ measurementKey: "quality", aggregation: "fact" as const, direction: "maximize" as const, weight: 1 }], locality: "remote-allowed" as const } };
  const base = options(role);
  const bindings = hostBindings(false);
  delete bindings.local;
  const result = resolveCapabilityRole("chat", request({
    task: { family: "chat", suite: null },
    inventory: [
      candidate("remote", "cloud", "remote", "remote"),
      candidate("absent", "local", "local", "local"),
      candidate("mismatch", "cloud", "not-configured", "remote", "remote"),
    ],
  }), { ...base, providerBindings: bindings });

  assert.equal(result.target, null);
  assert.ok(result.exclusions.some((entry) => entry.candidate.id === "remote" && entry.datumReasons.includes("DATUM_AUTH_UNAVAILABLE")));
  assert.ok(result.exclusions.some((entry) => entry.candidate.id === "absent" && entry.datumReasons.includes("DATUM_PROVIDER_MISSING")));
  assert.ok(result.exclusions.some((entry) => entry.candidate.id === "mismatch" && entry.datumReasons.includes("DATUM_PROVIDER_MODEL_UNCONFIGURED")));
});

test("resolveCapabilityRole: host bindings cover fixed, fallback, and local-only paths", () => {
  const inventory = [candidate("remote", "cloud", "remote", "remote"), candidate("local", "local", "local", "local")];
  const fixedBase = options("local@local");
  const fixed = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory, fixedOverride: "remote@cloud" }), {
    ...fixedBase,
    config: { roles: fixedBase.config!.roles },
    providerBindings: hostBindings(),
  });
  assert.equal(fixed.target?.id, "remote");
  assert.equal(fixed.target?.auth.kind, "host");

  const policy = { policy: { requirements: [], preferences: [], locality: "local-only" as const, fallback: "local@local" } };
  const policyBase = options(policy);
  const fallback = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory }), {
    ...policyBase,
    catalog: undefined,
    config: { roles: policyBase.config!.roles, capabilityCatalog: { localPath: "missing.json" } },
    providerBindings: hostBindings(),
  });
  assert.equal(fallback.posture, "fallback");
  assert.equal(fallback.target?.id, "local");

  const ambientOverride = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [inventory[1]] }), {
    ...policyBase,
    providerBindings: hostBindings(),
    env: { DATUM_BASEURL_LOCAL: "https://remote.example/v1" },
  });
  assert.equal(ambientOverride.target?.id, "local");
  assert.equal(ambientOverride.target?.baseUrl, "http://127.0.0.1:11434");

  const remoteLocal = hostBindings();
  remoteLocal.local.baseUrl = "https://remote.example/v1";
  const rejected = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [inventory[1]] }), {
    ...policyBase,
    providerBindings: remoteLocal,
  });
  assert.equal(rejected.target, null);
  assert.ok(rejected.exclusions[0].datumReasons.includes("DATUM_LOCALITY_DISALLOWED"));
});

test("resolveCapabilityRole: malformed host bindings and secret-looking refs are rejected", () => {
  const input = request({ task: { family: "chat", suite: null }, inventory: [candidate("local", "local", "local", "local")] });
  const base = options("local@local");
  const malformed: unknown[] = [
    { local: { ...hostBindings().local, unknown: true } },
    { local: { ...hostBindings().local, models: [] } },
    { local: { ...hostBindings().local, models: ["local", "local"] } },
    { local: { ...hostBindings().local, auth: { kind: "env", ref: "LOCAL_KEY", available: true } } },
    { local: { ...hostBindings().local, auth: { kind: "host", ref: ["sk", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-"), available: true } } },
    { local: { ...hostBindings().local, auth: { kind: "host", ref: "abcdefghijklmnopqrstuvwxyz0123456789", available: true } } },
    { local: { ...hostBindings().local, baseUrl: "https://user:secret@example.test/v1" } },
    { local: { ...hostBindings().local, baseUrl: "https://example.test/v1?api_key=secret" } },
    JSON.parse(`{"__proto__":${JSON.stringify(hostBindings())}}`),
  ];
  for (const providerBindings of malformed) {
    assert.throws(
      () => resolveCapabilityRole("chat", input, { ...base, providerBindings: providerBindings as Record<string, CapabilityProviderBinding> }),
      (error: unknown) => ["INVALID_CONFIG", "SECRET_LITERAL"].includes((error as { code?: string }).code ?? ""),
    );
  }
});

test("resolveCapabilityRole: explicitly undefined host bindings fail closed", () => {
  const input = request({
    task: { family: "chat", suite: null },
    inventory: [candidate("local", "local", "local", "local")],
  });
  const base = options("local@local");

  assert.throws(
    () => resolveCapabilityRole("chat", input, {
      ...base,
      providerBindings: undefined,
    }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG",
  );
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
  assert.deepEqual(durable.advisories, []);
  assert.deepEqual(durable.target?.advisories, []);
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
  assert.deepEqual(fallback.advisories, []);
  assert.deepEqual(fallback.target?.advisories, []);
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

test("resolveCapabilityRole: combined policy validation precedes missing-catalog fallback", () => {
  const policy = { policy: {
    requirements: [], preferences: [], locality: "local-only" as const, fallback: "local@local",
    advisories: [{ id: "same", measurementKey: "quality", aggregation: "fact" as const }],
  } };
  const base = options(policy);
  assert.throws(
    () => resolveCapabilityRole("chat", request({
      task: { family: "chat", suite: null },
      inventory: [candidate("local", "local", "local", "local")],
      advisories: [{ id: "same", measurementKey: "context.projection", aggregation: "fact" }],
    }), { ...base, catalog: undefined, config: { ...base.config!, capabilityCatalog: { localPath: "missing.json" } } }),
    (error: unknown) => (error as { code?: string; message?: string }).code === "INVALID_CONFIG"
      && (error as { message: string }).message.includes('duplicate id "same"'),
  );
});

test("resolveCapabilityRole: result ordering is deterministic and config policy runtime validation rejects unknown keys", () => {
  const role = { policy: { requirements: [], preferences: [], locality: "remote-allowed" as const } };
  const incomplete = ["z", "ä"].map((id) => {
    const value = candidate(id, "cloud", "remote", "remote", "remote");
    value.execution = { ...execution, toolSurface: null };
    return value;
  });
  const inventory = [candidate("local", "local", "local", "local"), ...incomplete, candidate("remote", "cloud", "remote", "remote")];
  const resolveOptions = { ...options(role), now: () => new Date("2026-07-18T00:00:00.000Z") };
  const one = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory }), resolveOptions);
  const two = resolveCapabilityRole("chat", request({ task: { family: "chat", suite: null }, inventory: [...inventory].reverse() }), resolveOptions);
  assert.deepEqual(one, two);
  assert.deepEqual(one.exclusions.map((entry) => entry.candidate.id), ["z", "ä"]);
  assert.throws(() => validateConfig({ roles: { chat: { policy: { requirements: [], preferences: [], locality: "local-only", unknown: true } } } }), (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG");
  assert.throws(() => validateConfig({ roles: { chat: { policy: { requirements: [{ measurementKey: "quality", aggregation: "fact", operator: "gte", value: "high" }], preferences: [], locality: "local-only" } } } }), (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG");
  assert.throws(() => validateConfig({ roles: { chat: { policy: { requirements: [], preferences: [], advisories: [
    { id: "same", measurementKey: "quality", aggregation: "fact" },
    { id: "same", measurementKey: "context.projection", aggregation: "fact" },
  ], locality: "local-only" } } } }), (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG");
  assert.throws(() => validateConfig({ roles: { chat: { policy: { requirements: [], preferences: [], advisories: [
    { id: "é".repeat(129), measurementKey: "quality", aggregation: "fact" },
  ], locality: "local-only" } } } }), (error: unknown) => (error as { code?: string; message?: string }).code === "INVALID_CONFIG"
    && (error as { message: string }).message.includes("256 UTF-8 bytes"));
  for (const value of ["", " padded ", "é".repeat(129)]) {
    assert.throws(() => validateConfig({ roles: { chat: { policy: {
      requirements: [{ measurementKey: "quality", aggregation: "fact", operator: "eq", value }],
      preferences: [], locality: "local-only",
    } } } }), (error: unknown) => (error as { code?: string }).code === "INVALID_CONFIG");
  }
});

test("resolveCapabilityRole: malformed request envelope, Bearing execution, and criteria are typed INVALID_CONFIG", () => {
  const role = { policy: { requirements: [], preferences: [], locality: "remote-allowed" as const } };
  const base = request({ task: { family: "chat", suite: null }, inventory: [candidate("remote", "cloud", "remote", "remote")] });
  const malformed = [
    { ...base, schemaVersion: "datum.capability-role.request/v0" },
    { ...base, inventory: null },
    { ...base, inventory: [] },
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

  const invalidDiagnostic = {
    ...base.catalog!,
    metadata: {
      ...base.catalog!.metadata,
      diagnostics: [{ code: "NOT_A_DATUM_CODE", message: "invalid" }],
    },
  };
  const rejectedDiagnostic = resolveCapabilityRole("chat", input, {
    ...base,
    catalog: invalidDiagnostic as CapabilityRoleResolveOptions["catalog"],
  });
  assert.equal(rejectedDiagnostic.posture, "unavailable");
  assert.equal(rejectedDiagnostic.diagnostics[0]?.code, "CAPABILITY_CATALOG_MALFORMED");

  const invalidFetchedAt = {
    ...base.catalog!,
    metadata: { ...base.catalog!.metadata, fetchedAt: "not-a-date" },
  };
  const rejectedFetchedAt = resolveCapabilityRole("chat", input, {
    ...base,
    catalog: invalidFetchedAt,
  });
  assert.equal(rejectedFetchedAt.posture, "unavailable");
  assert.equal(rejectedFetchedAt.diagnostics[0]?.code, "CAPABILITY_CATALOG_MALFORMED");
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
