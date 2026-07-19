/**
 * Core registry types for @kontourai/datum.
 *
 * Datum is a CONFIGURATION resolver, not a client. These types describe the
 * on-disk registry shape (providers/models/roles) and the resolved answers the
 * library hands back. Nothing here imports an AI SDK or makes a network call.
 */

import type { ExecutionProfile, ModelIdentity, RankEvidence, RankPreference, RankReason, RankRequirement, RankTask, Uncertainty } from "@kontourai/bearing";
import type { CapabilityCatalogMetadata, CapabilityCatalogResult } from "./catalog/types.js";
import type { SecretRunner } from "./secrets.js";

/**
 * Provider "kind" is an OPEN enum: `anthropic-compatible` and `openai-compatible`
 * are implemented; any string is accepted structurally so new kinds can land
 * without a schema bump — consumers switch on it themselves. Not every consumer
 * supports every kind (see the README support matrix): the opencode generator
 * maps both; the Claude Code generator speaks anthropic-compatible only.
 */
export type ProviderKind = "anthropic-compatible" | "openai-compatible" | (string & {});

/**
 * A macOS Keychain reference: the generic-password `service` (and optional
 * `account`) to look up. These are IDENTIFIERS, not the secret; the value is
 * fetched lazily via `security find-generic-password -w` only when `resolve()`
 * materializes.
 */
export interface KeychainRef {
  service: string;
  account?: string;
}

/**
 * Auth is by REFERENCE only — never a literal secret. Exactly one backend:
 *  - `{ env }`      — the NAME of an env var holding the key.
 *  - `{ keychain }` — a macOS Keychain generic-password lookup (darwin-only).
 *  - `{ op }`       — a 1Password secret reference URI, e.g. "op://vault/item/field".
 * All three are materialized LAZILY (only by `resolve()`); `resolveRef`/`list`/
 * `sync` never invoke the backing tool, they only report its availability.
 */
export type AuthRef = { env: string } | { keychain: KeychainRef } | { op: string };

/** Which auth backend a provider uses. */
export type AuthKind = "env" | "keychain" | "op";

export interface ProviderConfig {
  kind: ProviderKind;
  /** Optional. Absent = the SDK default base URL for this kind. */
  baseUrl?: string;
  auth: AuthRef;
  /** Model ids this provider offers. Used to resolve bare model refs. */
  models: string[];
}

export interface DatumConfig {
  providers?: Record<string, ProviderConfig>;
  /** Role name -> fixed model ref or an inventory-ranked capability policy. */
  roles?: Record<string, CapabilityRole>;
  /** Optional validated Bearing capability catalog source. */
  capabilityCatalog?: CapabilityCatalogConfig;
}

/** A durable role remains fixed, or delegates selection to an explicit Bearing policy. */
export type CapabilityRole = string | PolicyCapabilityRole;

export interface PolicyCapabilityRole {
  policy: {
    requirements: RankRequirement[];
    preferences: RankPreference[];
    locality: "local-only" | "remote-allowed";
    /** Explicit emergency target; used only when the catalog is unavailable or stale. */
    fallback?: string;
  };
}

/** A caller-owned launchable candidate. Datum never adds candidates to this list. */
export interface CapabilityRuntimeCandidate {
  /** Opaque, request-scoped id. */
  id: string;
  /** Datum provider id. */
  providerId: string;
  /** Provider model id as configured in Datum. */
  providerModel: string;
  locality: "local" | "remote" | "unknown";
  model: ModelIdentity;
  execution: ExecutionProfile;
}

export interface CapabilityRoleRequest {
  schemaVersion: "datum.capability-role.request/v1";
  task: RankTask;
  inventory: CapabilityRuntimeCandidate[];
  requirements?: RankRequirement[];
  preferences?: RankPreference[];
  /** Highest-precedence, request-scoped fixed model ref. Never persisted. */
  fixedOverride?: string;
}

export type CapabilityRoleReason =
  | "DATUM_LOCALITY_DISALLOWED"
  | "DATUM_PROVIDER_MISSING"
  | "DATUM_PROVIDER_MODEL_UNCONFIGURED"
  | "DATUM_AUTH_UNAVAILABLE"
  | "DATUM_OVERRIDE_NOT_IN_INVENTORY"
  | "DATUM_OVERRIDE_AMBIGUOUS"
  | "DATUM_NO_ELIGIBLE_TARGET"
  | "DATUM_FIXED_DURABLE"
  | "DATUM_FIXED_SESSION_OVERRIDE"
  | "DATUM_FIXED_ENV_OVERRIDE"
  | "DATUM_POLICY_FALLBACK"
  | "DATUM_POLICY_RANKED";

export interface CapabilityRoleTarget extends CapabilityRuntimeCandidate {
  /** The configured Datum provider identity and effective non-secret routing. */
  provider: string;
  kind: ProviderKind;
  baseUrl?: string;
  auth: AuthStatus;
  /** Present for policy ranking; null for fixed, override, and fallback selection. */
  rank: number | null;
  score: number | null;
  /** Full Bearing rank explanations; empty when Bearing ranking was bypassed. */
  reasons: RankReason[];
  evidence: RankEvidence[];
  uncertainty: Uncertainty;
  /** Datum-owned selection reason, distinct from Bearing rank explanations. */
  selection: { posture: "override" | "durable" | "fallback"; reason: CapabilityRoleReason };
}

export interface CapabilityRoleExclusion {
  candidate: CapabilityRuntimeCandidate;
  /** Full Bearing exclusion explanations, including actual/expected/contribution. */
  reasons: RankReason[];
  /** Datum-owned post-ranking eligibility failures. */
  datumReasons: CapabilityRoleReason[];
  evidence: RankEvidence[];
  uncertainty: Uncertainty;
}

export interface CapabilityRoleResult {
  schemaVersion: "datum.capability-role.result/v1";
  mode: "fixed" | "policy";
  posture: "override" | "durable" | "fallback" | "unavailable";
  target: CapabilityRoleTarget | null;
  alternatives: CapabilityRoleTarget[];
  exclusions: CapabilityRoleExclusion[];
  catalog: { digest: string; asOf: string; metadata: CapabilityCatalogMetadata } | null;
  /** Bearing-owned evidence for the selected candidate; no advisory projection is synthesized. */
  evidence: RankEvidence[];
  uncertainty: Uncertainty | null;
  override: { active: boolean; source: "session" | "env" | null; ref?: string };
  fallback: { configured: boolean; used: boolean; ref?: string };
  diagnostics: Array<{ code: CapabilityRoleReason | string; message: string }>;
}

/** Exactly one durable source for a Bearing capability-catalog snapshot. */
export type CapabilityCatalogConfig =
  | { remoteUrl: string; localPath?: never; maxAgeSeconds?: number }
  | { localPath: string; remoteUrl?: never; maxAgeSeconds?: number };

/**
 * Full resolution, WITH the API key materialized. Returned by `resolve()`. The
 * `{ baseUrl, apiKey, model }` triple lines up 1:1 with traverse's
 * `createAnthropicExtractionProvider` options. The key is read from the env var,
 * the macOS Keychain, or 1Password depending on the provider's auth backend.
 */
export interface ResolvedTarget {
  /** Provider id the ref resolved to. */
  provider: string;
  kind: ProviderKind;
  /** Present only when the provider config (or an escape hatch) sets one. */
  baseUrl?: string;
  /** Materialized secret value from the referenced backend. */
  apiKey: string;
  model: string;
}

/**
 * A non-secret description of WHERE a provider's key lives and whether it is
 * obtainable, computed WITHOUT reading the secret. `available` means: for `env`,
 * the var is set; for `keychain`/`op`, the backing tool is present (the value is
 * not fetched).
 */
export interface AuthStatus {
  kind: AuthKind;
  /**
   * Human/tooling-facing reference string:
   *  - env      -> the env var name
   *  - keychain -> "service" or "service/account"
   *  - op       -> the op:// URI
   */
  ref: string;
  /** Env var name — present only when `kind === "env"`. */
  envVar?: string;
  /** True when the secret is obtainable without reading it (see above). */
  available: boolean;
  /**
   * For keychain/op: the backing tool/platform used, for diagnostics
   * (e.g. "security" / "op"). Undefined for env.
   */
  tool?: string;
}

/**
 * Resolution WITHOUT secret materialization. Returned by `resolveRef()`.
 * Describes the auth backend and whether it is available instead of the value —
 * for tooling that only needs to route, list, or generate config.
 */
export interface ResolvedRef {
  provider: string;
  kind: ProviderKind;
  baseUrl?: string;
  model: string;
  /** Non-secret description of the auth backend and its availability. */
  auth: AuthStatus;
  /**
   * Legacy convenience for `env`-kind auth: the var name. Undefined for
   * keychain/op refs (there is no env var). Prefer `auth`.
   */
  apiKeyEnv?: string;
  /**
   * Legacy convenience: whether the key is obtainable (env set, or tool
   * present). Mirrors `auth.available`.
   */
  apiKeySet: boolean;
}

export interface ResolveOptions {
  /** Pre-loaded config; when set, file loading is skipped entirely. */
  config?: DatumConfig;
  /** Working directory used to locate the repo-level `.datum/config.json`. */
  cwd?: string;
  /** Home directory used to locate the user-level `~/.config/kontour/datum.json`. */
  home?: string;
  /** Explicit user config path (overrides the `home`-derived default). */
  userConfigPath?: string;
  /** Explicit repo config path (overrides the `cwd`-derived default). */
  repoConfigPath?: string;
  /**
   * Environment overrides. Merged OVER `process.env` (these win) for BOTH the
   * escape-hatch lookups (DATUM_ROLE_*, DATUM_BASEURL_*) and env-var API-key
   * materialization. Highest precedence input to resolution.
   */
  env?: Record<string, string | undefined>;
  /**
   * Secret backend runner for keychain/op auth. Injectable so tests never touch
   * the real Keychain or 1Password. Defaults to a spawn-based implementation.
   */
  secretRunner?: SecretRunner;
}

export interface CapabilityRoleResolveOptions extends ResolveOptions {
  /** Offline snapshot injection for embedded callers and deterministic tests. */
  catalog?: CapabilityCatalogResult;
  /** Injectable clock/cache options are accepted by the offline catalog loader. */
  cacheRoot?: string;
  now?: () => Date;
}
