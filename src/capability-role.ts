/** Offline, inventory-bounded capability-role resolution. */
import {
  MAX_RANK_V2_ADVISORIES,
  MAX_RANK_V2_ADVISORY_CELLS,
  rankCatalog,
  validateExecutionProfile,
  validateModelIdentity,
  validateRankRequest,
  type ExecutionProfile,
  type ExcludedCandidateV2,
  type RankAdvisoryProjection,
  type RankAdvisoryRequest,
  type RankedCandidateV2,
  type RankEvidence,
  type RankRequestV2,
  type Uncertainty,
} from "@kontourai/bearing";
import { describeAuth } from "./auth.js";
import { cloneBoundedJson } from "./bounded-json.js";
import { loadConfig } from "./config.js";
import { loadCapabilityCatalog, validateInjectedCapabilityCatalog } from "./catalog.js";
import { DatumError } from "./errors.js";
import { envKey, resolveConfiguredModelRef } from "./resolve.js";
import { defaultSecretRunner } from "./secrets.js";
import { isLoopbackHost } from "./security.js";
import type {
  AuthStatus,
  CapabilityRoleExclusion,
  CapabilityExecutionProfile,
  CapabilityRoleReason,
  CapabilityRoleRequest,
  CapabilityRoleResolveOptions,
  CapabilityRoleResult,
  CapabilityRoleTarget,
  CapabilityRuntimeCandidate,
  DatumConfig,
  PolicyCapabilityRole,
  ProviderConfig,
} from "./types.js";

const MAX_INVENTORY = 128;
const MAX_RULES = 64;
const MAX_STRING = 256;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_TOOL_SURFACE = 128;
const MODEL_REF_RE = /^[^@\s]+(@[^@\s]+)?$/;
const EXPLICIT_MODEL_REF_RE = /^[^@\s]+@[^@\s]+$/;
const fixedUncertainty = (): Uncertainty => ({ level: "unknown", basis: ["Datum fixed resolution bypasses Bearing ranking."], gaps: [] });
const incompleteUncertainty = (candidate: CapabilityRuntimeCandidate): Uncertainty => ({
  level: "unknown",
  basis: ["Datum excluded this launchable candidate before Bearing ranking because its execution profile is incomplete."],
  gaps: [
    ...(candidate.execution.runtime === null ? ["runtime is unknown"] : []),
    ...(candidate.execution.toolSurface === null ? ["tool surface is unknown"] : []),
  ],
});

type RankableCapabilityRuntimeCandidate = Omit<CapabilityRuntimeCandidate, "execution"> & {
  execution: ExecutionProfile;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(message: string): never { throw new DatumError("INVALID_CONFIG", message); }
function bounded(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > MAX_STRING || /[\u0000-\u001f]/.test(value)) invalid(`${label} must be a bounded, trimmed non-control string.`);
}
function boundedNullable(value: string | null, label: string): void {
  if (value !== null) bounded(value, label);
}
function exactRecord(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) invalid(`${label} has unknown key "${key}".`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalid(`${label} must contain "${key}".`);
  }
  return value;
}
function nonnegativeIntegerOrNull(value: unknown, label: string): void {
  if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    invalid(`${label} must be a non-negative safe integer or null.`);
  }
}
function component(value: unknown, label: string): void {
  const item = exactRecord(value, label, ["id", "version"]);
  bounded(item.id, `${label}.id`);
  if (item.version !== null) bounded(item.version, `${label}.version`);
}
function hardware(value: unknown, label: string): void {
  if (value === null) return;
  const item = exactRecord(value, label, ["class", "accelerator", "memoryBytes"]);
  bounded(item.class, `${label}.class`);
  if (item.accelerator !== null) bounded(item.accelerator, `${label}.accelerator`);
  nonnegativeIntegerOrNull(item.memoryBytes, `${label}.memoryBytes`);
}
function workflow(value: unknown, label: string): void {
  if (value === null) return;
  const item = exactRecord(value, label, ["id", "version", "condition"]);
  bounded(item.id, `${label}.id`);
  if (item.version !== null) bounded(item.version, `${label}.version`);
  if (item.condition !== null) bounded(item.condition, `${label}.condition`);
}
function validateCandidateExecution(value: unknown, label: string): asserts value is CapabilityExecutionProfile {
  const item = exactRecord(value, label, [
    "runtime",
    "adapter",
    "effectiveContextTokens",
    "toolSurface",
    "hardware",
    "workflow",
  ]);
  if (item.runtime !== null) component(item.runtime, `${label}.runtime`);
  if (item.adapter !== null) component(item.adapter, `${label}.adapter`);
  nonnegativeIntegerOrNull(item.effectiveContextTokens, `${label}.effectiveContextTokens`);
  if (item.toolSurface !== null) {
    if (!Array.isArray(item.toolSurface) || item.toolSurface.length > MAX_TOOL_SURFACE) {
      invalid(`${label}.toolSurface must be null or contain at most ${MAX_TOOL_SURFACE} entries.`);
    }
    const tools = item.toolSurface as unknown[];
    tools.forEach((tool, index) => bounded(tool, `${label}.toolSurface[${index}]`));
    if (new Set(tools).size !== tools.length) invalid(`${label}.toolSurface must not contain duplicates.`);
  }
  hardware(item.hardware, `${label}.hardware`);
  workflow(item.workflow, `${label}.workflow`);
}
function isRankableCandidate(candidate: CapabilityRuntimeCandidate): candidate is RankableCapabilityRuntimeCandidate {
  return candidate.execution.runtime !== null && candidate.execution.toolSurface !== null;
}
function combinedAdvisories(
  durable: RankAdvisoryRequest[],
  requested: RankAdvisoryRequest[],
  inventorySize: number,
): RankAdvisoryRequest[] {
  const combined = [...durable, ...requested];
  if (combined.length > MAX_RANK_V2_ADVISORIES) {
    invalid(`combined durable and request advisories must contain at most ${MAX_RANK_V2_ADVISORIES} entries.`);
  }
  if (combined.length * inventorySize > MAX_RANK_V2_ADVISORY_CELLS) {
    invalid(`combined durable and request advisories must produce at most ${MAX_RANK_V2_ADVISORY_CELLS} inventory projection cells.`);
  }
  const ids = new Set<string>();
  for (const advisory of combined) {
    if (ids.has(advisory.id)) invalid(`combined durable and request advisories contain duplicate id "${advisory.id}".`);
    ids.add(advisory.id);
  }
  return combined;
}
function effectiveEnv(opts: CapabilityRoleResolveOptions): Record<string, string | undefined> {
  return { ...process.env, ...(opts.env ?? {}) };
}
function policyRole(value: unknown): value is PolicyCapabilityRole {
  return isRecord(value) && isRecord(value.policy);
}

function ownValue<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function cloneRequest(request: CapabilityRoleRequest): CapabilityRoleRequest {
  const cloned = cloneBoundedJson(request, {
    label: "capability role request",
    maxBytes: MAX_REQUEST_BYTES,
    maxDepth: 16,
    maxArrayLength: MAX_INVENTORY,
    maxObjectKeys: 64,
    maxStringBytes: MAX_STRING,
    fail: invalid,
    limit: invalid,
  });
  if (!isRecord(cloned)) invalid("capability role request must be an object.");
  return cloned as unknown as CapabilityRoleRequest;
}

function validateRequestEnvelope(request: CapabilityRoleRequest): void {
  const allowed = ["schemaVersion", "task", "inventory", "requirements", "preferences", "advisories", "fixedOverride"];
  for (const key of Object.keys(request)) if (!allowed.includes(key)) invalid(`capability role request: unknown key "${key}".`);
  if (request.schemaVersion !== "datum.capability-role.request/v1") invalid("capability role request.schemaVersion must be \"datum.capability-role.request/v1\".");
  if (!isRecord(request.task) || Object.keys(request.task).some((key) => key !== "family" && key !== "suite")) invalid("capability role request.task must contain only family and suite.");
  bounded(request.task.family, "capability role request.task.family");
  if (request.task.suite !== null && request.task.suite !== undefined) bounded(request.task.suite, "capability role request.task.suite");
  if (!Array.isArray(request.inventory) || request.inventory.length === 0 || request.inventory.length > MAX_INVENTORY) invalid(`capability role request.inventory must contain 1..${MAX_INVENTORY} candidates.`);
}

function validateCandidateEnvelope(candidate: unknown, index: number, ids: Set<string>): asserts candidate is CapabilityRuntimeCandidate {
  const allowed = ["id", "providerId", "providerModel", "locality", "model", "execution"];
  if (!isRecord(candidate) || Object.keys(candidate).some((key) => !allowed.includes(key))) invalid(`capability role request.inventory[${index}] has an unknown key.`);
  bounded(candidate.id, `capability role request.inventory[${index}].id`);
  bounded(candidate.providerId, `capability role request.inventory[${index}].providerId`);
  bounded(candidate.providerModel, `capability role request.inventory[${index}].providerModel`);
  if (ids.has(candidate.id)) invalid(`capability role request.inventory has duplicate candidate id "${candidate.id}".`);
  ids.add(candidate.id);
  if (candidate.locality !== "local" && candidate.locality !== "remote" && candidate.locality !== "unknown") invalid(`capability role request.inventory[${index}].locality is invalid.`);
  const modelLabel = `capability role request.inventory[${index}].model`;
  try {
    validateModelIdentity(candidate.model, modelLabel);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    invalid(`${modelLabel} must be a Bearing model identity.${detail}`);
  }
  const model = candidate.model as CapabilityRuntimeCandidate["model"];
  bounded(model.id, `${modelLabel}.id`);
  boundedNullable(model.revision, `${modelLabel}.revision`);
  boundedNullable(model.quantization, `${modelLabel}.quantization`);
  const executionLabel = `capability role request.inventory[${index}].execution`;
  validateCandidateExecution(candidate.execution, executionLabel);
  const typedCandidate = candidate as unknown as CapabilityRuntimeCandidate;
  if (!isRankableCandidate(typedCandidate)) return;
  try {
    validateExecutionProfile(typedCandidate.execution, executionLabel);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    invalid(`${executionLabel} must be a concrete Bearing execution profile.${detail}`);
  }
}

function validateCriteria(request: CapabilityRoleRequest): void {
  for (const [key, value] of [["requirements", request.requirements], ["preferences", request.preferences]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.length > MAX_RULES)) invalid(`capability role request.${key} must contain at most ${MAX_RULES} entries.`);
    if (!Array.isArray(value)) continue;
    for (const [index, rule] of value.entries()) {
      if (!isRecord(rule)) continue;
      bounded(rule.measurementKey, `capability role request.${key}[${index}].measurementKey`);
      if (key === "preferences" && typeof rule.weight === "number" && rule.weight > 1_000_000) invalid(`capability role request.preferences[${index}].weight must be no greater than 1000000.`);
    }
  }
  if (request.advisories !== undefined && (!Array.isArray(request.advisories) || request.advisories.length > MAX_RULES)) invalid(`capability role request.advisories must contain at most ${MAX_RULES} entries.`);
  if (request.fixedOverride === undefined) return;
  bounded(request.fixedOverride, "capability role request.fixedOverride");
  if (!EXPLICIT_MODEL_REF_RE.test(request.fixedOverride)) invalid("capability role request.fixedOverride must be an explicit model@provider ref.");
}

function validateBearingRequest(request: CapabilityRoleRequest): RankRequestV2 {
  try {
    return validateRankRequest({
      schemaVersion: "bearing.rank.request/v2",
      task: request.task,
      inventory: request.inventory
        .filter(isRankableCandidate)
        .map(({ id, model, execution }) => ({ id, model, execution })),
      requirements: request.requirements ?? [],
      preferences: request.preferences ?? [],
      advisories: request.advisories ?? [],
    });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    invalid(`capability role request is not a valid bounded Bearing rank request.${detail}`);
  }
}

function validateExecutionFields(inventory: RankRequestV2["inventory"]): void {
  for (const [index, candidate] of inventory.entries()) {
    bounded(candidate.model.id, `capability role request.inventory[${index}].model.id`);
    boundedNullable(candidate.model.revision, `capability role request.inventory[${index}].model.revision`);
    boundedNullable(candidate.model.quantization, `capability role request.inventory[${index}].model.quantization`);
    bounded(candidate.execution.runtime.id, `capability role request.inventory[${index}].execution.runtime.id`);
    boundedNullable(candidate.execution.runtime.version, `capability role request.inventory[${index}].execution.runtime.version`);
    if (candidate.execution.adapter !== null) {
      bounded(candidate.execution.adapter.id, `capability role request.inventory[${index}].execution.adapter.id`);
      boundedNullable(candidate.execution.adapter.version, `capability role request.inventory[${index}].execution.adapter.version`);
    }
    if (candidate.execution.toolSurface.length > MAX_TOOL_SURFACE) invalid(`capability role request.inventory[${index}].execution.toolSurface must contain at most ${MAX_TOOL_SURFACE} entries.`);
    candidate.execution.toolSurface.forEach((tool, toolIndex) => bounded(tool, `capability role request.inventory[${index}].execution.toolSurface[${toolIndex}]`));
    if (candidate.execution.hardware !== null) {
      bounded(candidate.execution.hardware.class, `capability role request.inventory[${index}].execution.hardware.class`);
      boundedNullable(candidate.execution.hardware.accelerator, `capability role request.inventory[${index}].execution.hardware.accelerator`);
    }
    if (candidate.execution.workflow !== null) {
      bounded(candidate.execution.workflow.id, `capability role request.inventory[${index}].execution.workflow.id`);
      boundedNullable(candidate.execution.workflow.version, `capability role request.inventory[${index}].execution.workflow.version`);
      boundedNullable(candidate.execution.workflow.condition, `capability role request.inventory[${index}].execution.workflow.condition`);
    }
  }
}

/** Validate request-owned fields before they enter Bearing; no unknown candidate bindings are accepted. */
function validateRequest(request: CapabilityRoleRequest): CapabilityRoleRequest {
  request = cloneRequest(request);
  validateRequestEnvelope(request);
  const ids = new Set<string>();
  request.inventory.forEach((candidate, index) => validateCandidateEnvelope(candidate, index, ids));
  validateCriteria(request);
  validateExecutionFields(validateBearingRequest(request).inventory);
  return request;
}

interface ResolutionContext {
  config: DatumConfig;
  policy: PolicyCapabilityRole | undefined;
  env: Record<string, string | undefined>;
  opts: CapabilityRoleResolveOptions;
  authByProvider: Map<string, AuthStatus>;
}

function effectiveBaseUrl(candidate: CapabilityRuntimeCandidate, provider: ProviderConfig, env: Record<string, string | undefined>): string | undefined {
  return env[`DATUM_BASEURL_${envKey(candidate.providerId)}`] ?? provider.baseUrl;
}

function binding(candidate: CapabilityRuntimeCandidate, provider: ProviderConfig, auth: CapabilityRoleTarget["auth"], env: Record<string, string | undefined>, rank: number | null, score: number | null, reasons: CapabilityRoleTarget["reasons"], evidence: RankEvidence[], uncertainty: Uncertainty, advisories: RankAdvisoryProjection[], selection: CapabilityRoleTarget["selection"]): CapabilityRoleTarget {
  const baseUrl = effectiveBaseUrl(candidate, provider, env);
  return { ...candidate, provider: candidate.providerId, kind: provider.kind, ...(baseUrl ? { baseUrl } : {}), auth, rank, score, reasons, evidence, uncertainty, advisories, selection };
}
function exclusion(candidate: CapabilityRuntimeCandidate, datumReasons: CapabilityRoleReason[], reasons: CapabilityRoleExclusion["reasons"] = [], evidence: RankEvidence[] = [], uncertainty: Uncertainty = fixedUncertainty(), advisories: RankAdvisoryProjection[] = []): CapabilityRoleExclusion {
  return { candidate, reasons, datumReasons, evidence, uncertainty, advisories };
}
function isTrustedLocalCandidate(candidate: CapabilityRuntimeCandidate, provider: ProviderConfig, env: Record<string, string | undefined>): boolean {
  if (candidate.locality !== "local") return false;
  const baseUrl = effectiveBaseUrl(candidate, provider, env);
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

function providerAuth(candidate: CapabilityRuntimeCandidate, provider: ProviderConfig, context: ResolutionContext): AuthStatus {
  const cached = context.authByProvider.get(candidate.providerId);
  if (cached) return cached;
  const auth = describeAuth(provider.auth, context.env, context.opts.secretRunner ?? defaultSecretRunner);
  context.authByProvider.set(candidate.providerId, auth);
  return auth;
}

function datumEligibility(candidate: CapabilityRuntimeCandidate, context: ResolutionContext): { provider?: ProviderConfig; auth?: CapabilityRoleTarget["auth"]; reasons: CapabilityRoleReason[] } {
  const provider = ownValue(context.config.providers, candidate.providerId);
  if (!provider) return { reasons: ["DATUM_PROVIDER_MISSING"] };
  if (!provider.models.includes(candidate.providerModel)) return { reasons: ["DATUM_PROVIDER_MODEL_UNCONFIGURED"] };
  if (context.policy?.policy.locality === "local-only" && !isTrustedLocalCandidate(candidate, provider, context.env)) return { reasons: ["DATUM_LOCALITY_DISALLOWED"] };
  const auth = providerAuth(candidate, provider, context);
  if (!auth.available) return { reasons: ["DATUM_AUTH_UNAVAILABLE"] };
  return { provider, auth, reasons: [] };
}
function selectRef(ref: string, source: "session" | "env" | "durable" | "fallback", request: CapabilityRoleRequest, context: ResolutionContext): { target: CapabilityRoleTarget | null; exclusions: CapabilityRoleExclusion[]; diagnostics: CapabilityRoleResult["diagnostics"] } {
  let providerId: string;
  let providerModel: string;
  try {
    const resolved = resolveConfiguredModelRef(context.config, ref);
    providerId = resolved.provider;
    providerModel = resolved.model;
  } catch (error) {
    const message = error instanceof Error ? error.message : "fixed target is invalid.";
    return { target: null, exclusions: [], diagnostics: [{ code: "DATUM_OVERRIDE_NOT_IN_INVENTORY", message }] };
  }
  const matches = request.inventory.filter((candidate) => candidate.providerId === providerId && candidate.providerModel === providerModel);
  if (matches.length !== 1) {
    const reason: CapabilityRoleReason = matches.length > 1 ? "DATUM_OVERRIDE_AMBIGUOUS" : "DATUM_OVERRIDE_NOT_IN_INVENTORY";
    return { target: null, exclusions: matches.map((candidate) => exclusion(candidate, [reason])), diagnostics: [{ code: reason, message: `${source} target is not exactly one caller inventory candidate.` }] };
  }
  const eligibility = datumEligibility(matches[0], context);
  if (!eligibility.provider || !eligibility.auth) return { target: null, exclusions: [exclusion(matches[0], eligibility.reasons)], diagnostics: [{ code: eligibility.reasons[0], message: `${source} target failed Datum eligibility checks.` }] };
  const reason = source === "session" ? "DATUM_FIXED_SESSION_OVERRIDE" : source === "env" ? "DATUM_FIXED_ENV_OVERRIDE" : source === "fallback" ? "DATUM_POLICY_FALLBACK" : "DATUM_FIXED_DURABLE";
  const posture = source === "fallback" ? "fallback" : source === "durable" ? "durable" : "override";
  return { target: binding(matches[0], eligibility.provider, eligibility.auth, context.env, null, null, [], [], fixedUncertainty(), [], { posture, reason }), exclusions: [], diagnostics: [] };
}
function catalogError(error: unknown): { code: string; message: string } {
  if (error instanceof DatumError) return { code: error.code, message: error.message };
  return { code: "CAPABILITY_CATALOG_UNAVAILABLE", message: "Capability catalog is unavailable." };
}
function catalogAllowsFallback(error: unknown): boolean {
  return error instanceof DatumError
    && (error.code === "CAPABILITY_CATALOG_UNAVAILABLE" || error.code === "CAPABILITY_CATALOG_STALE");
}

function buildRankRequest(policy: PolicyCapabilityRole, request: CapabilityRoleRequest): RankRequestV2 {
  const advisories = combinedAdvisories(policy.policy.advisories ?? [], request.advisories ?? [], request.inventory.length);
  try {
    return validateRankRequest({
      schemaVersion: "bearing.rank.request/v2",
      task: request.task,
      inventory: request.inventory
        .filter(isRankableCandidate)
        .map(({ id, model, execution }) => ({ id, model, execution })),
      requirements: [...policy.policy.requirements, ...(request.requirements ?? [])],
      preferences: [...policy.policy.preferences, ...(request.preferences ?? [])],
      advisories,
    });
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    invalid(`combined durable and request capability criteria are not a valid Bearing rank request.${detail}`);
  }
}

function loadCatalog(config: DatumConfig, opts: CapabilityRoleResolveOptions) {
  return opts.catalog === undefined
    ? loadCapabilityCatalog(opts)
    : validateInjectedCapabilityCatalog(opts.catalog, {
      maxAgeSeconds: config.capabilityCatalog?.maxAgeSeconds,
      now: opts.now,
    });
}

function fixedResult(request: CapabilityRoleRequest, context: ResolutionContext, ref: string, source: "session" | "env" | "durable"): CapabilityRoleResult {
  bounded(ref, "capability role fixed target");
  if (!MODEL_REF_RE.test(ref)) throw new DatumError("INVALID_CONFIG", "Capability role fixed targets must use model or model@provider.");
  const selected = selectRef(ref, source, request, context);
  const overrideSource = source === "durable" ? null : source;
  return {
    schemaVersion: "datum.capability-role.result/v1",
    mode: "fixed",
    posture: selected.target ? (overrideSource ? "override" : "durable") : "unavailable",
    target: selected.target,
    alternatives: [],
    exclusions: selected.exclusions,
    catalog: null,
    evidence: [],
    advisories: [],
    uncertainty: selected.target?.uncertainty ?? null,
    override: { active: overrideSource !== null, source: overrideSource, ...(overrideSource ? { ref } : {}) },
    fallback: { configured: context.policy?.policy.fallback !== undefined, used: false, ...(context.policy?.policy.fallback ? { ref: context.policy.policy.fallback } : {}) },
    diagnostics: selected.diagnostics,
  };
}

function catalogFailureResult(error: unknown, request: CapabilityRoleRequest, context: ResolutionContext): CapabilityRoleResult {
  const diagnostic = catalogError(error);
  const fallback = context.policy?.policy.fallback;
  const state = { configured: fallback !== undefined, used: false, ...(fallback ? { ref: fallback } : {}) };
  if (fallback && catalogAllowsFallback(error)) {
    const selected = selectRef(fallback, "fallback", request, context);
    return {
      schemaVersion: "datum.capability-role.result/v1", mode: "policy",
      posture: selected.target ? "fallback" : "unavailable",
      target: selected.target, alternatives: [], exclusions: selected.exclusions,
      catalog: null, evidence: [], advisories: [],
      uncertainty: selected.target?.uncertainty ?? null,
      override: { active: false, source: null },
      fallback: { ...state, used: selected.target !== null },
      diagnostics: [diagnostic, ...selected.diagnostics],
    };
  }
  return {
    schemaVersion: "datum.capability-role.result/v1", mode: "policy", posture: "unavailable",
    target: null, alternatives: [], exclusions: [], catalog: null,
    evidence: [], advisories: [], uncertainty: null,
    override: { active: false, source: null }, fallback: state, diagnostics: [diagnostic],
  };
}

function rankedResult(request: CapabilityRoleRequest, context: ResolutionContext, loaded: ReturnType<typeof loadCatalog>, rankRequest: RankRequestV2): CapabilityRoleResult {
  const rank = rankCatalog(loaded.catalog, rankRequest);
  const byId = new Map(request.inventory.map((candidate) => [candidate.id, candidate]));
  const exclusions: CapabilityRoleExclusion[] = request.inventory
    .filter((candidate) => !isRankableCandidate(candidate))
    .map((candidate) => exclusion(
      candidate,
      ["DATUM_EXECUTION_PROFILE_INCOMPLETE"],
      [],
      [],
      incompleteUncertainty(candidate),
    ));
  exclusions.push(...rank.excluded.map((entry: ExcludedCandidateV2) => exclusion(
    byId.get(entry.candidateId)!,
    [],
    entry.reasons,
    entry.evidence,
    entry.uncertainty,
    entry.advisories,
  )));
  const eligible: CapabilityRoleTarget[] = [];
  for (const entry of rank.ranked as RankedCandidateV2[]) {
    const candidate = byId.get(entry.candidateId)!;
    const checked = datumEligibility(candidate, context);
    if (!checked.provider || !checked.auth) {
      exclusions.push(exclusion(candidate, checked.reasons, [], entry.evidence, entry.uncertainty, entry.advisories));
      continue;
    }
    eligible.push(binding(candidate, checked.provider, checked.auth, context.env, entry.rank, entry.score, entry.reasons, entry.evidence, entry.uncertainty, entry.advisories, { posture: "durable", reason: "DATUM_POLICY_RANKED" }));
  }
  exclusions.sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));
  const [target, ...alternatives] = eligible;
  const fallback = context.policy?.policy.fallback;
  return {
    schemaVersion: "datum.capability-role.result/v1", mode: "policy",
    posture: target ? "durable" : "unavailable",
    target: target ?? null, alternatives, exclusions,
    catalog: { digest: rank.catalog.digest, asOf: rank.catalog.asOf, metadata: loaded.metadata },
    evidence: target?.evidence ?? [], advisories: target?.advisories ?? [],
    uncertainty: target?.uncertainty ?? null,
    override: { active: false, source: null },
    fallback: { configured: fallback !== undefined, used: false, ...(fallback ? { ref: fallback } : {}) },
    diagnostics: target ? [] : [{ code: "DATUM_NO_ELIGIBLE_TARGET", message: "No Bearing-ranked inventory candidate passed Datum eligibility checks." }],
  };
}

/**
 * Resolve a fixed or policy role without network access or secret materialization.
 * Bearing v2 supplies rankings, evidence, and caller-declared advisory projections for policy roles.
 */
export function resolveCapabilityRole(role: string, request: CapabilityRoleRequest, opts: CapabilityRoleResolveOptions = {}): CapabilityRoleResult {
  request = validateRequest(request);
  const { config } = loadConfig(opts);
  const durable = ownValue(config.roles, role);
  if (durable === undefined) throw new DatumError("UNKNOWN_ROLE", `Unknown role "${role}".`);
  const env = effectiveEnv(opts);
  const policy = policyRole(durable) ? durable : undefined;
  const context: ResolutionContext = { config, policy, env, opts, authByProvider: new Map() };
  if (request.fixedOverride !== undefined) return fixedResult(request, context, request.fixedOverride, "session");
  const environment = env[`DATUM_ROLE_${envKey(role)}`];
  if (environment !== undefined) return fixedResult(request, context, environment, "env");
  if (typeof durable === "string") return fixedResult(request, context, durable, "durable");
  if (!policy) invalid(`Role "${role}" is not a valid capability policy.`);

  const rankRequest = buildRankRequest(policy, request);
  let loaded: ReturnType<typeof loadCatalog>;
  try {
    loaded = loadCatalog(config, opts);
  } catch (error) {
    return catalogFailureResult(error, request, context);
  }
  return rankedResult(request, context, loaded, rankRequest);
}
