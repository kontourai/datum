/**
 * The resolver. Answers "which backend, which model, whose key, what base URL"
 * for a role name or model ref. It NEVER makes a model call.
 *
 * Precedence (highest first):
 *   1. opts.env          - explicit programmatic overrides
 *   2. process.env       - escape hatches: DATUM_ROLE_<NAME>, DATUM_BASEURL_<PROVIDER>
 *   3. repo file         - .datum/config.json
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
 *
 * Secret materialization is LAZY: `resolveRef()` describes the auth backend and
 * whether it is available (no secret read); only `resolve()` reads the value —
 * from the env var, the macOS Keychain, or 1Password, per the provider's auth.
 */

import { describeAuth, authKind } from "./auth.js";
import { loadConfig } from "./config.js";
import {
  ambiguousModel,
  DatumError,
  missingEnv,
  unknownModel,
  unknownProvider,
  unknownRole,
} from "./errors.js";
import { defaultSecretRunner } from "./secrets.js";
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

/** Shared: config lookup + ref dispatch, returning provider/model + effective baseUrl. */
function resolveProvider(ref: string, opts: ResolveOptions): {
  provider: string;
  providerConfig: ProviderConfig;
  model: string;
  baseUrl?: string;
  env: Record<string, string | undefined>;
} {
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
    if (typeof roleTarget === "string") {
      resolved = resolveModelRef(config, roleTarget, (m) => unknownModel(m, allModels(config)));
    } else if (roleTarget !== undefined) {
      throw new DatumError("INVALID_CONFIG", `Role "${ref}" is a capability policy; use resolveCapabilityRole().`);
    } else {
      resolved = resolveModelRef(config, ref, () => unknownRole(ref, Object.keys(config.roles ?? {})));
    }
  }

  const { provider, providerConfig, model } = resolved;
  const baseUrlOverride = env[`DATUM_BASEURL_${envKey(provider)}`];
  const baseUrl = baseUrlOverride ?? providerConfig.baseUrl;
  return { provider, providerConfig, model, baseUrl, env };
}

/**
 * Resolve a ref (role name OR model ref) WITHOUT materializing the secret.
 * Describes the auth backend and whether it is available (env var set, or the
 * keychain/op tool present) — the backing tool is NOT invoked to read a value.
 */
export function resolveRef(ref: string, opts: ResolveOptions = {}): ResolvedRef {
  const { provider, providerConfig, model, baseUrl, env } = resolveProvider(ref, opts);
  const runner = opts.secretRunner ?? defaultSecretRunner;
  const auth = describeAuth(providerConfig.auth, env, runner);

  return {
    provider,
    kind: providerConfig.kind,
    ...(baseUrl ? { baseUrl } : {}),
    model,
    auth,
    ...(auth.kind === "env" ? { apiKeyEnv: auth.envVar } : {}),
    apiKeySet: auth.available,
  };
}

/**
 * Resolve a ref and MATERIALIZE the API key from its backend. For `env` auth,
 * throws MISSING_ENV (naming the var) when unset; for keychain/op, reads the
 * value via the SecretRunner (throwing SECRET_BACKEND_UNAVAILABLE /
 * SECRET_LOOKUP_FAILED on failure). The returned `{ baseUrl, apiKey, model }`
 * lines up 1:1 with traverse's `createAnthropicExtractionProvider` options.
 */
export function resolve(ref: string, opts: ResolveOptions = {}): ResolvedTarget {
  const { provider, providerConfig, model, baseUrl, env } = resolveProvider(ref, opts);
  const runner = opts.secretRunner ?? defaultSecretRunner;
  const auth = providerConfig.auth;

  let apiKey: string;
  const kind = authKind(auth);
  if (kind === "env") {
    const envVar = (auth as { env: string }).env;
    const val = env[envVar];
    if (typeof val !== "string" || val.length === 0) throw missingEnv(envVar, provider);
    apiKey = val;
  } else if (kind === "keychain") {
    apiKey = runner.readKeychain((auth as { keychain: { service: string; account?: string } }).keychain);
  } else {
    apiKey = runner.readOp((auth as { op: string }).op);
  }

  return {
    provider,
    kind: providerConfig.kind,
    ...(baseUrl ? { baseUrl } : {}),
    apiKey,
    model,
  };
}
