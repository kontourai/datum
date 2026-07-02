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
} from "./types.js";
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
