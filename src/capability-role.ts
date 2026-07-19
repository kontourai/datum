/** Offline, inventory-bounded capability-role resolution. */
import { rankCatalog, validateRankRequest, type ExcludedCandidate, type RankedCandidate, type RankEvidence, type Uncertainty } from "@kontourai/bearing";
import { describeAuth } from "./auth.js";
import { cloneBoundedJson } from "./bounded-json.js";
import { loadConfig } from "./config.js";
import { loadCapabilityCatalog, validateInjectedCapabilityCatalog } from "./catalog.js";
import { DatumError } from "./errors.js";
import { envKey, resolveConfiguredModelRef } from "./resolve.js";
import { defaultSecretRunner } from "./secrets.js";
import type {
  CapabilityRoleExclusion,
  CapabilityRoleReason,
  CapabilityRoleRequest,
  CapabilityRoleResolveOptions,
  CapabilityRoleResult,
  CapabilityRoleTarget,
  CapabilityRuntimeCandidate,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function invalid(message: string): never { throw new DatumError("INVALID_CONFIG", message); }
function bounded(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_STRING || /[\u0000-\u001f]/.test(value)) invalid(`${label} must be a bounded non-control string.`);
}
function boundedNullable(value: string | null, label: string): void {
  if (value !== null) bounded(value, label);
}
function effectiveEnv(opts: CapabilityRoleResolveOptions): Record<string, string | undefined> {
  return { ...process.env, ...(opts.env ?? {}) };
}
function policyRole(value: unknown): value is PolicyCapabilityRole {
  return isRecord(value) && isRecord(value.policy);
}

/** Validate request-owned fields before they enter Bearing; no unknown candidate bindings are accepted. */
function validateRequest(request: CapabilityRoleRequest): CapabilityRoleRequest {
  request = cloneBoundedJson(request, {
    label: "capability role request",
    maxBytes: MAX_REQUEST_BYTES,
    maxDepth: 16,
    maxArrayLength: MAX_INVENTORY,
    maxObjectKeys: 64,
    maxStringBytes: MAX_STRING,
    fail: invalid,
    limit: invalid,
  }) as CapabilityRoleRequest;
  if (!isRecord(request)) invalid("capability role request must be an object.");
  for (const key of Object.keys(request)) if (!["schemaVersion", "task", "inventory", "requirements", "preferences", "fixedOverride"].includes(key)) invalid(`capability role request: unknown key "${key}".`);
  if (request.schemaVersion !== "datum.capability-role.request/v1") invalid("capability role request.schemaVersion must be \"datum.capability-role.request/v1\".");
  if (!isRecord(request.task) || Object.keys(request.task).some((key) => key !== "family" && key !== "suite")) invalid("capability role request.task must contain only family and suite.");
  bounded(request.task.family, "capability role request.task.family");
  if (request.task.suite !== null && request.task.suite !== undefined) bounded(request.task.suite, "capability role request.task.suite");
  if (!Array.isArray(request.inventory) || request.inventory.length === 0 || request.inventory.length > MAX_INVENTORY) invalid(`capability role request.inventory must contain 1..${MAX_INVENTORY} candidates.`);
  const ids = new Set<string>();
  for (const [index, candidate] of request.inventory.entries()) {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !["id", "providerId", "providerModel", "locality", "model", "execution"].includes(key))) invalid(`capability role request.inventory[${index}] has an unknown key.`);
    bounded(candidate.id, `capability role request.inventory[${index}].id`);
    bounded(candidate.providerId, `capability role request.inventory[${index}].providerId`);
    bounded(candidate.providerModel, `capability role request.inventory[${index}].providerModel`);
    if (ids.has(candidate.id)) invalid(`capability role request.inventory has duplicate candidate id "${candidate.id}".`);
    ids.add(candidate.id);
    if (candidate.locality !== "local" && candidate.locality !== "remote" && candidate.locality !== "unknown") invalid(`capability role request.inventory[${index}].locality is invalid.`);
    if (!isRecord(candidate.model)) invalid(`capability role request.inventory[${index}].model must be a Bearing model identity.`);
  }
  for (const [key, value] of [["requirements", request.requirements], ["preferences", request.preferences]] as const) {
    if (value !== undefined && (!Array.isArray(value) || value.length > MAX_RULES)) invalid(`capability role request.${key} must contain at most ${MAX_RULES} entries.`);
    if (Array.isArray(value)) {
      for (const [index, rule] of value.entries()) {
        if (!isRecord(rule)) continue;
        bounded(rule.measurementKey, `capability role request.${key}[${index}].measurementKey`);
        if (key === "preferences" && typeof rule.weight === "number" && rule.weight > 1_000_000) {
          invalid(`capability role request.preferences[${index}].weight must be no greater than 1000000.`);
        }
      }
    }
  }
  if (request.fixedOverride !== undefined) {
    bounded(request.fixedOverride, "capability role request.fixedOverride");
    if (!EXPLICIT_MODEL_REF_RE.test(request.fixedOverride)) invalid("capability role request.fixedOverride must be an explicit model@provider ref.");
  }
  let validated: ReturnType<typeof validateRankRequest>;
  try {
    validated = validateRankRequest({
      schemaVersion: "bearing.rank.request/v1",
      task: request.task,
      inventory: request.inventory.map(({ id, model, execution }) => ({ id, model, execution })),
      requirements: request.requirements ?? [],
      preferences: request.preferences ?? [],
    });
  } catch {
    invalid("capability role request is not a valid bounded Bearing rank request.");
  }
  for (const [index, candidate] of validated.inventory.entries()) {
    bounded(candidate.model.id, `capability role request.inventory[${index}].model.id`);
    boundedNullable(candidate.model.revision, `capability role request.inventory[${index}].model.revision`);
    boundedNullable(candidate.model.quantization, `capability role request.inventory[${index}].model.quantization`);
    bounded(candidate.execution.runtime.id, `capability role request.inventory[${index}].execution.runtime.id`);
    boundedNullable(candidate.execution.runtime.version, `capability role request.inventory[${index}].execution.runtime.version`);
    if (candidate.execution.adapter !== null) {
      bounded(candidate.execution.adapter.id, `capability role request.inventory[${index}].execution.adapter.id`);
      boundedNullable(candidate.execution.adapter.version, `capability role request.inventory[${index}].execution.adapter.version`);
    }
    if (candidate.execution.toolSurface.length > MAX_TOOL_SURFACE) {
      invalid(`capability role request.inventory[${index}].execution.toolSurface must contain at most ${MAX_TOOL_SURFACE} entries.`);
    }
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
  return request;
}

function binding(candidate: CapabilityRuntimeCandidate, provider: ProviderConfig, auth: CapabilityRoleTarget["auth"], env: Record<string, string | undefined>, rank: number | null, score: number | null, reasons: CapabilityRoleTarget["reasons"], evidence: RankEvidence[], uncertainty: Uncertainty, selection: CapabilityRoleTarget["selection"]): CapabilityRoleTarget {
  const baseUrl = env[`DATUM_BASEURL_${envKey(candidate.providerId)}`] ?? provider.baseUrl;
  return { ...candidate, provider: candidate.providerId, kind: provider.kind, ...(baseUrl ? { baseUrl } : {}), auth, rank, score, reasons, evidence, uncertainty, selection };
}
function exclusion(candidate: CapabilityRuntimeCandidate, datumReasons: CapabilityRoleReason[], reasons: CapabilityRoleExclusion["reasons"] = [], evidence: RankEvidence[] = [], uncertainty: Uncertainty = fixedUncertainty()): CapabilityRoleExclusion {
  return { candidate, reasons, datumReasons, evidence, uncertainty };
}
function datumEligibility(candidate: CapabilityRuntimeCandidate, config: NonNullable<ReturnType<typeof loadConfig>["config"]>, policy: PolicyCapabilityRole | undefined, env: Record<string, string | undefined>, opts: CapabilityRoleResolveOptions): { provider?: ProviderConfig; auth?: CapabilityRoleTarget["auth"]; reasons: CapabilityRoleReason[] } {
  const provider = config.providers?.[candidate.providerId];
  if (!provider) return { reasons: ["DATUM_PROVIDER_MISSING"] };
  if (!provider.models.includes(candidate.providerModel)) return { reasons: ["DATUM_PROVIDER_MODEL_UNCONFIGURED"] };
  if (policy?.policy.locality === "local-only" && candidate.locality !== "local") return { reasons: ["DATUM_LOCALITY_DISALLOWED"] };
  const auth = describeAuth(provider.auth, env, opts.secretRunner ?? defaultSecretRunner);
  if (!auth.available) return { reasons: ["DATUM_AUTH_UNAVAILABLE"] };
  return { provider, auth, reasons: [] };
}
function selectRef(ref: string, source: "session" | "env" | "durable" | "fallback", request: CapabilityRoleRequest, config: ReturnType<typeof loadConfig>["config"], policy: PolicyCapabilityRole | undefined, env: Record<string, string | undefined>, opts: CapabilityRoleResolveOptions): { target: CapabilityRoleTarget | null; exclusions: CapabilityRoleExclusion[]; diagnostics: CapabilityRoleResult["diagnostics"] } {
  let providerId: string;
  let providerModel: string;
  try {
    const resolved = resolveConfiguredModelRef(config, ref);
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
  const eligibility = datumEligibility(matches[0], config, policy, env, opts);
  if (!eligibility.provider || !eligibility.auth) return { target: null, exclusions: [exclusion(matches[0], eligibility.reasons)], diagnostics: [{ code: eligibility.reasons[0], message: `${source} target failed Datum eligibility checks.` }] };
  const reason = source === "session" ? "DATUM_FIXED_SESSION_OVERRIDE" : source === "env" ? "DATUM_FIXED_ENV_OVERRIDE" : source === "fallback" ? "DATUM_POLICY_FALLBACK" : "DATUM_FIXED_DURABLE";
  const posture = source === "fallback" ? "fallback" : source === "durable" ? "durable" : "override";
  return { target: binding(matches[0], eligibility.provider, eligibility.auth, env, null, null, [], [], fixedUncertainty(), { posture, reason }), exclusions: [], diagnostics: [] };
}
function catalogError(error: unknown): { code: string; message: string } {
  if (error instanceof DatumError) return { code: error.code, message: error.message };
  return { code: "CAPABILITY_CATALOG_UNAVAILABLE", message: "Capability catalog is unavailable." };
}
function catalogAllowsFallback(error: unknown): boolean {
  return error instanceof DatumError
    && (error.code === "CAPABILITY_CATALOG_UNAVAILABLE" || error.code === "CAPABILITY_CATALOG_STALE");
}

/**
 * Resolve a fixed or policy role without network access or secret materialization.
 * Bearing v1 supplies rankings/evidence only; advisory projection is deliberately absent (Bearing#22).
 */
export function resolveCapabilityRole(role: string, request: CapabilityRoleRequest, opts: CapabilityRoleResolveOptions = {}): CapabilityRoleResult {
  request = validateRequest(request);
  const { config } = loadConfig(opts);
  const durable = config.roles?.[role];
  if (durable === undefined) throw new DatumError("UNKNOWN_ROLE", `Unknown role "${role}".`);
  const env = effectiveEnv(opts);
  const session = request.fixedOverride;
  const environment = env[`DATUM_ROLE_${envKey(role)}`];
  const policy = policyRole(durable) ? durable : undefined;
  const fixed = session ?? environment ?? (typeof durable === "string" ? durable : undefined);
  const overrideSource = session ? "session" : environment ? "env" : null;
  const fallbackState = { configured: policy?.policy.fallback !== undefined, used: false, ...(policy?.policy.fallback ? { ref: policy.policy.fallback } : {}) };
  if (fixed !== undefined) {
    bounded(fixed, "capability role fixed target");
    if (!MODEL_REF_RE.test(fixed)) throw new DatumError("INVALID_CONFIG", "Capability role fixed targets must use model or model@provider.");
    const selected = selectRef(fixed, session ? "session" : environment ? "env" : "durable", request, config, policy, env, opts);
    return { schemaVersion: "datum.capability-role.result/v1", mode: "fixed", posture: selected.target ? (overrideSource ? "override" : "durable") : "unavailable", target: selected.target, alternatives: [], exclusions: selected.exclusions, catalog: null, evidence: [], uncertainty: selected.target?.uncertainty ?? null, override: { active: overrideSource !== null, source: overrideSource, ...(overrideSource ? { ref: fixed } : {}) }, fallback: fallbackState, diagnostics: selected.diagnostics };
  }

  let loaded;
  try {
    loaded = opts.catalog === undefined
      ? loadCapabilityCatalog(opts)
      : validateInjectedCapabilityCatalog(opts.catalog, {
        maxAgeSeconds: config.capabilityCatalog?.maxAgeSeconds,
        now: opts.now,
      });
  } catch (error) {
    const diagnostic = catalogError(error);
    if (policy?.policy.fallback && catalogAllowsFallback(error)) {
      const selected = selectRef(policy.policy.fallback, "fallback", request, config, policy, env, opts);
      return { schemaVersion: "datum.capability-role.result/v1", mode: "policy", posture: selected.target ? "fallback" : "unavailable", target: selected.target, alternatives: [], exclusions: selected.exclusions, catalog: null, evidence: [], uncertainty: selected.target?.uncertainty ?? null, override: { active: false, source: null }, fallback: { ...fallbackState, used: selected.target !== null }, diagnostics: [diagnostic, ...selected.diagnostics] };
    }
    return { schemaVersion: "datum.capability-role.result/v1", mode: "policy", posture: "unavailable", target: null, alternatives: [], exclusions: [], catalog: null, evidence: [], uncertainty: null, override: { active: false, source: null }, fallback: fallbackState, diagnostics: [diagnostic] };
  }
  let rankRequest: ReturnType<typeof validateRankRequest>;
  try {
    rankRequest = validateRankRequest({
      schemaVersion: "bearing.rank.request/v1",
      task: request.task,
      inventory: request.inventory.map(({ id, model, execution }) => ({ id, model, execution })),
      requirements: [...policy!.policy.requirements, ...(request.requirements ?? [])],
      preferences: [...policy!.policy.preferences, ...(request.preferences ?? [])],
    });
  } catch {
    invalid("combined durable and request capability criteria are not a valid Bearing rank request.");
  }
  const rank = rankCatalog(loaded.catalog, rankRequest);
  const byId = new Map(request.inventory.map((candidate) => [candidate.id, candidate]));
  const exclusions: CapabilityRoleExclusion[] = rank.excluded.map((entry: ExcludedCandidate) => exclusion(byId.get(entry.candidateId)!, [], entry.reasons, entry.evidence, entry.uncertainty));
  const eligible: CapabilityRoleTarget[] = [];
  for (const entry of rank.ranked as RankedCandidate[]) {
    const candidate = byId.get(entry.candidateId)!;
    const checked = datumEligibility(candidate, config, policy, env, opts);
    if (!checked.provider || !checked.auth) { exclusions.push(exclusion(candidate, checked.reasons, [], entry.evidence, entry.uncertainty)); continue; }
    eligible.push(binding(candidate, checked.provider, checked.auth, env, entry.rank, entry.score, entry.reasons, entry.evidence, entry.uncertainty, { posture: "durable", reason: "DATUM_POLICY_RANKED" }));
  }
  const [target, ...alternatives] = eligible;
  return { schemaVersion: "datum.capability-role.result/v1", mode: "policy", posture: target ? "durable" : "unavailable", target: target ?? null, alternatives, exclusions, catalog: { digest: rank.catalog.digest, asOf: rank.catalog.asOf, metadata: loaded.metadata }, evidence: target?.evidence ?? [], uncertainty: target?.uncertainty ?? null, override: { active: false, source: null }, fallback: fallbackState, diagnostics: target ? [] : [{ code: "DATUM_NO_ELIGIBLE_TARGET", message: "No Bearing-ranked inventory candidate passed Datum eligibility checks." }] };
}
