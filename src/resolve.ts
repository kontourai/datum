/**
 * The resolver. Answers "which backend, which model, whose key, what base URL"
 * for a role name or model ref. It NEVER makes a model call.
 *
 * Precedence (highest first):
 *   1. opts.env          - explicit programmatic overrides
 *   2. process.env       - escape hatches: DATUM_ROLE_<NAME>, DATUM_BASEURL_<PROVIDER>
 *   3. repo file         - .kontour/datum.json
 *   4. user file         - ~/.config/kontour/datum.json
 * (opts.env is merged OVER process.env, so 1 wins over 2; files are merged in
 * config.ts with repo over user, so 3 wins over 4.)
 *
 * Escape hatches (documented in README/design):
 *   DATUM_ROLE_<NAME>       overrides a role's target model ref entirely.
 *   DATUM_BASEURL_<PROVIDER> overrides a provider's base URL.
 * We deliberately do NOT read the downstream SDK's own ANTHROPIC_BASE_URL here:
 * that is the runtime SDK's escape hatch, and consuming it in the resolver too
 * would double-apply it. Datum's base-URL escape hatch is its own namespaced var.
 */

import { loadConfig } from "./config.js";
import {
  ambiguousModel,
  DatumError,
  missingEnv,
  unknownModel,
  unknownProvider,
  unknownRole,
} from "./errors.js";
import type {
  DatumConfig,
  ProviderConfig,
  ResolvedRef,
  ResolvedTarget,
  ResolveOptions,
} from "./types.js";

/** Normalize a ref/provider id into the ENV-var suffix shape. */
export function envKey(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function effectiveEnv(opts: ResolveOptions): Record<string, string | undefined> {
  return { ...process.env, ...(opts.env ?? {}) };
}

interface ResolvedProviderAndModel {
  provider: string;
  providerConfig: ProviderConfig;
  model: string;
}

/** Providers (ids) that offer `model` in their models list. */
function providersOffering(config: DatumConfig, model: string): string[] {
  const out: string[] = [];
  for (const [id, p] of Object.entries(config.providers ?? {})) {
    if (p.models.includes(model)) out.push(id);
  }
  return out;
}

function allModels(config: DatumConfig): string[] {
  const set = new Set<string>();
  for (const p of Object.values(config.providers ?? {})) for (const m of p.models) set.add(m);
  return [...set];
}

/**
 * Resolve a MODEL ref ("model@provider" or bare "model") to a provider+model.
 * `bareZeroMatch` controls which error a zero-match bare model raises so callers
 * can distinguish "user typed an unknown top-level ref" (unknown role) from
 * "a configured role points at a nonexistent model" (unknown model).
 */
function resolveModelRef(
  config: DatumConfig,
  ref: string,
  bareZeroMatch: (model: string) => DatumError,
): ResolvedProviderAndModel {
  const at = ref.indexOf("@");
  if (at !== -1) {
    const model = ref.slice(0, at);
    const provider = ref.slice(at + 1);
    const providerConfig = config.providers?.[provider];
    if (!providerConfig) {
      throw unknownProvider(provider, ref, Object.keys(config.providers ?? {}));
    }
    return { provider, providerConfig, model };
  }

  // Bare model: find the unique provider offering it.
  const matches = providersOffering(config, ref);
  if (matches.length === 1) {
    const provider = matches[0];
    return { provider, providerConfig: config.providers![provider], model: ref };
  }
  if (matches.length > 1) throw ambiguousModel(ref, matches);
  throw bareZeroMatch(ref);
}

/**
 * Resolve a ref (role name OR model ref) WITHOUT materializing the secret.
 * Returns which env var holds the key and whether it is currently set.
 */
export function resolveRef(ref: string, opts: ResolveOptions = {}): ResolvedRef {
  const { config } = loadConfig(opts);
  const env = effectiveEnv(opts);

  let resolved: ResolvedProviderAndModel;

  if (ref.includes("@")) {
    // Explicit model ref — never a role.
    resolved = resolveModelRef(config, ref, (m) => unknownModel(m, allModels(config)));
  } else {
    // Bare ref: role-first. Escape hatch DATUM_ROLE_<NAME> can define/override.
    const override = env[`DATUM_ROLE_${envKey(ref)}`];
    const roleTarget = override ?? config.roles?.[ref];
    if (roleTarget !== undefined) {
      // A role's target that names an unknown bare model is an UNKNOWN_MODEL.
      resolved = resolveModelRef(config, roleTarget, (m) => unknownModel(m, allModels(config)));
    } else {
      // Not a role: allow bare-model convenience; zero match => unknown role.
      resolved = resolveModelRef(config, ref, () => unknownRole(ref, Object.keys(config.roles ?? {})));
    }
  }

  const { provider, providerConfig, model } = resolved;
  const baseUrlOverride = env[`DATUM_BASEURL_${envKey(provider)}`];
  const baseUrl = baseUrlOverride ?? providerConfig.baseUrl;
  const apiKeyEnv = providerConfig.auth.env;
  const keyVal = env[apiKeyEnv];
  const apiKeySet = typeof keyVal === "string" && keyVal.length > 0;

  return {
    provider,
    kind: providerConfig.kind,
    ...(baseUrl ? { baseUrl } : {}),
    apiKeyEnv,
    apiKeySet,
    model,
  };
}

/**
 * Resolve a ref and MATERIALIZE the API key from the environment. Throws
 * MISSING_ENV (naming the var) when the referenced env var is unset/empty.
 * The returned `{ baseUrl, apiKey, model }` lines up 1:1 with traverse's
 * `createAnthropicExtractionProvider` options.
 */
export function resolve(ref: string, opts: ResolveOptions = {}): ResolvedTarget {
  const r = resolveRef(ref, opts);
  const env = effectiveEnv(opts);
  const apiKey = env[r.apiKeyEnv];
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw missingEnv(r.apiKeyEnv, r.provider);
  }
  return {
    provider: r.provider,
    kind: r.kind,
    ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
    apiKey,
    model: r.model,
  };
}
