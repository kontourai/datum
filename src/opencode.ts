/**
 * opencode config generator.
 *
 * GENERATOR, NOT WRAPPER: datum emits the native `provider` block opencode
 * already understands; it does not proxy, wrap, or intercept opencode's model
 * calls. The output is data opencode consumes on its own.
 *
 * Format confirmed against opencode's published schema (https://opencode.ai/config.json,
 * ProviderConfig): a custom provider is
 *   provider.<id> = { npm, name, options: { baseURL? }, env: [KEY_VAR], models: { <id>: { name } } }
 * We emit `env: [<auth.env>]` (the var NAME) rather than `options.apiKey`, keeping
 * datum's secret-reference-only invariant: the literal key never enters generated
 * config — opencode reads it from the environment itself.
 *
 * opencode's provider `env` field is a list of env var NAMES; it has no notion of
 * a macOS Keychain or 1Password reference. Providers whose auth is `keychain`/`op`
 * are therefore skipped with a warning (see the README support matrix).
 */

import { authKind } from "./auth.js";
import type { DatumConfig, ProviderKind } from "./types.js";

/** opencode schema revision this generator was written against (for provenance). */
export const OPENCODE_FORMAT_VERSION = "opencode.ai/config.json @ 2026-07 (ProviderConfig)";

/** ai-sdk npm package opencode loads for a given datum kind. */
export function npmForKind(kind: ProviderKind): string | undefined {
  switch (kind) {
    case "anthropic-compatible":
      return "@ai-sdk/anthropic";
    case "openai-compatible":
      return "@ai-sdk/openai-compatible";
    default:
      return undefined;
  }
}

export interface OpencodeModelEntry {
  name: string;
}
export interface OpencodeProviderEntry {
  npm: string;
  name: string;
  env: string[];
  options?: { baseURL?: string };
  models: Record<string, OpencodeModelEntry>;
}
export interface OpencodeProviderBlock {
  provider: Record<string, OpencodeProviderEntry>;
}

export interface GeneratedOpencode {
  block: OpencodeProviderBlock;
  /** Providers skipped because their kind or auth backend has no opencode mapping. */
  warnings: string[];
}

/**
 * Build the opencode `{ provider: {...} }` block from a datum config. Providers
 * whose kind has no known opencode npm package — or whose auth is not env-var
 * based (keychain/op, which opencode cannot express) — are skipped and reported
 * in `warnings` rather than emitting a broken entry.
 */
export function generateOpencodeProviderBlock(config: DatumConfig): GeneratedOpencode {
  const provider: Record<string, OpencodeProviderEntry> = {};
  const warnings: string[] = [];

  for (const [id, p] of Object.entries(config.providers ?? {})) {
    const npm = npmForKind(p.kind);
    if (!npm) {
      warnings.push(`skipped provider "${id}": kind "${p.kind}" has no known opencode npm mapping.`);
      continue;
    }
    if (authKind(p.auth) !== "env") {
      warnings.push(
        `skipped provider "${id}": auth backend "${authKind(p.auth)}" is not expressible in opencode ` +
          `(opencode reads keys from env var names only). Use an { "env": "VAR" } auth ref for opencode.`,
      );
      continue;
    }
    const models: Record<string, OpencodeModelEntry> = {};
    for (const m of p.models) models[m] = { name: m };

    const entry: OpencodeProviderEntry = {
      npm,
      name: id,
      env: [(p.auth as { env: string }).env],
      models,
    };
    if (p.baseUrl) entry.options = { baseURL: p.baseUrl };
    provider[id] = entry;
  }

  return { block: { provider }, warnings };
}

/**
 * Merge a generated provider block into an existing opencode config object,
 * replacing ONLY the provider ids datum owns and leaving everything else intact.
 * Returns a new object; does not mutate the input.
 */
export function mergeIntoOpencodeConfig(
  existing: Record<string, unknown>,
  block: OpencodeProviderBlock,
): Record<string, unknown> {
  const existingProvider =
    typeof existing.provider === "object" && existing.provider !== null && !Array.isArray(existing.provider)
      ? (existing.provider as Record<string, unknown>)
      : {};
  return {
    ...existing,
    provider: { ...existingProvider, ...block.provider },
  };
}
