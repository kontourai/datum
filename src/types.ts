/**
 * Core registry types for @kontourai/datum.
 *
 * Datum is a CONFIGURATION resolver, not a client. These types describe the
 * on-disk registry shape (providers/models/roles) and the resolved answers the
 * library hands back. Nothing here imports an AI SDK or makes a network call.
 */

/**
 * Provider "kind" is an OPEN enum: `anthropic-compatible` is implemented in this
 * slice; `openai-compatible` is reserved. Any string is accepted structurally so
 * new kinds can land without a schema bump — consumers switch on it themselves.
 */
export type ProviderKind = "anthropic-compatible" | "openai-compatible" | (string & {});

/** Auth is by REFERENCE only in this slice: the NAME of an env var, never a secret. */
export interface AuthRef {
  /** Environment variable name that holds the API key (e.g. "ZAI_API_KEY"). */
  env: string;
}

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
  /** Role name -> model ref ("model@provider" or bare "model"). */
  roles?: Record<string, string>;
}

/**
 * Full resolution, WITH the API key materialized from the environment.
 * Returned by `resolve()`. The `{ baseUrl, apiKey, model }` triple lines up 1:1
 * with traverse's `createAnthropicExtractionProvider` options.
 */
export interface ResolvedTarget {
  /** Provider id the ref resolved to. */
  provider: string;
  kind: ProviderKind;
  /** Present only when the provider config (or an escape hatch) sets one. */
  baseUrl?: string;
  /** Materialized secret value from the referenced env var. */
  apiKey: string;
  model: string;
}

/**
 * Resolution WITHOUT secret materialization. Returned by `resolveRef()`.
 * Reports WHICH env var holds the key (and whether it is currently set) instead
 * of the value — for tooling that only needs to route, list, or generate config.
 */
export interface ResolvedRef {
  provider: string;
  kind: ProviderKind;
  baseUrl?: string;
  /** Name of the env var that holds the API key. */
  apiKeyEnv: string;
  /** Whether that env var is currently set in the effective environment. */
  apiKeySet: boolean;
  model: string;
}

export interface ResolveOptions {
  /** Pre-loaded config; when set, file loading is skipped entirely. */
  config?: DatumConfig;
  /** Working directory used to locate the repo-level `.kontour/datum.json`. */
  cwd?: string;
  /** Home directory used to locate the user-level `~/.config/kontour/datum.json`. */
  home?: string;
  /** Explicit user config path (overrides the `home`-derived default). */
  userConfigPath?: string;
  /** Explicit repo config path (overrides the `cwd`-derived default). */
  repoConfigPath?: string;
  /**
   * Environment overrides. Merged OVER `process.env` (these win) for BOTH the
   * escape-hatch lookups (DATUM_ROLE_*, DATUM_BASEURL_*) and API-key
   * materialization. Highest precedence input to resolution.
   */
  env?: Record<string, string | undefined>;
}
