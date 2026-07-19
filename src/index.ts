/**
 * @kontourai/datum public entry point.
 *
 * Datum abstracts CONFIGURATION RESOLUTION, not invocation. It answers "which
 * backend, which model, whose key, what base URL" for a role or model ref, and
 * generates native configs for other tools. It imports no AI SDK and makes no
 * model calls (the one narrow exception, a live endpoint probe, lives in
 * `runDoctor({ probe: true })` and is opt-in).
 */

export { resolve, resolveRef, envKey } from "./resolve.js";
export { loadConfig, deepMerge, userConfigPath, repoConfigPath } from "./config.js";
export { validateConfig, looksLikeSecretLiteral } from "./validate.js";
export { authKind, authRefString, describeAuth } from "./auth.js";
export { defaultSecretRunner } from "./secrets.js";
export {
  generateOpencodeProviderBlock,
  mergeIntoOpencodeConfig,
  npmForKind,
  OPENCODE_FORMAT_VERSION,
} from "./opencode.js";
export {
  generateClaudeCodeEnv,
  mergeIntoClaudeCodeSettings,
  CLAUDE_CODE_FORMAT_VERSION,
  CLAUDE_CODE_MANAGED_ENV_KEYS,
} from "./claudecode.js";
export {
  runDoctor,
  probeAnthropicCompatible,
  probeOpenaiCompatible,
} from "./doctor.js";
export {
  discoverModels,
  testConnection,
  fetchOpenaiCompatibleModels,
} from "./discover.js";
export { enforceHttpsPolicy, safeFetch } from "./security.js";
export {
  loadCapabilityCatalog,
  refreshCapabilityCatalog,
  DEFAULT_CATALOG_MAX_RESPONSE_BYTES,
  DEFAULT_CATALOG_REQUEST_TIMEOUT_MS,
  DEFAULT_CATALOG_MAX_MODELS,
  DEFAULT_CATALOG_MAX_OBSERVATIONS,
  DEFAULT_CATALOG_MAX_OBSERVATIONS_PER_MODEL,
  DEFAULT_CATALOG_MAX_ENTRIES_PER_OBSERVATION,
} from "./catalog.js";
export type {
  HttpsPolicyOptions,
  HttpsPolicyResult,
  PolicyCheckedResponse,
  SafeFetchResult,
} from "./security.js";
export { DatumError } from "./errors.js";
export type { DatumErrorCode } from "./errors.js";
export type {
  DatumConfig,
  ProviderConfig,
  ProviderKind,
  AuthRef,
  AuthKind,
  AuthStatus,
  KeychainRef,
  ResolvedTarget,
  ResolvedRef,
  ResolveOptions,
  CapabilityCatalogConfig,
} from "./types.js";
export type {
  CapabilityCatalogDiagnostic,
  CapabilityCatalogMetadata,
  CapabilityCatalogOptions,
  CapabilityCatalogResult,
  CapabilityCatalogSourceMetadata,
  CatalogTransport,
  CatalogHostResolver,
  ResolvedCatalogTarget,
  CatalogFetchInit,
  CatalogFetchResponse,
  RefreshCapabilityCatalogOptions,
} from "./catalog.js";
export type { SecretRunner } from "./secrets.js";
export type { LoadedConfig } from "./config.js";
export type {
  GeneratedOpencode,
  OpencodeProviderBlock,
  OpencodeProviderEntry,
} from "./opencode.js";
export type {
  GeneratedClaudeCode,
  ClaudeCodeEnvBlock,
} from "./claudecode.js";
export type { DoctorReport, DoctorCheck, DoctorOptions, FetchLike, CheckStatus } from "./doctor.js";
export type {
  DiscoverResult,
  DiagnosisClass,
  DiscoverFetchLike,
  DiscoverModelsOptions,
  TestConnectionCheck,
  TestConnectionReport,
  TestConnectionOptions,
} from "./discover.js";
