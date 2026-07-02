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
export {
  generateOpencodeProviderBlock,
  mergeIntoOpencodeConfig,
  npmForKind,
  OPENCODE_FORMAT_VERSION,
} from "./opencode.js";
export { runDoctor, probeAnthropicCompatible } from "./doctor.js";
export { DatumError } from "./errors.js";
export type { DatumErrorCode } from "./errors.js";
export type {
  DatumConfig,
  ProviderConfig,
  ProviderKind,
  AuthRef,
  ResolvedTarget,
  ResolvedRef,
  ResolveOptions,
} from "./types.js";
export type { LoadedConfig } from "./config.js";
export type {
  GeneratedOpencode,
  OpencodeProviderBlock,
  OpencodeProviderEntry,
} from "./opencode.js";
export type { DoctorReport, DoctorCheck, DoctorOptions, FetchLike, CheckStatus } from "./doctor.js";
