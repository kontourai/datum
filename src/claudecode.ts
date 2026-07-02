/**
 * Claude Code settings generator (`datum sync claude-code`).
 *
 * GENERATOR, NOT WRAPPER — same discipline as the opencode target: datum emits
 * the native settings shape Claude Code already reads and stops. It does not
 * proxy or intercept Claude Code's calls.
 *
 * Confirmed surface (docs.claude.com/en/docs/claude-code/settings and
 * .../env-vars, checked 2026-07): `~/.claude/settings.json` has an `env` object
 * whose entries are exported into every Claude Code session. The recognized vars
 * datum sets are:
 *   - ANTHROPIC_BASE_URL — "Override the API endpoint to route requests through a
 *     proxy or gateway." Emitted only when the resolved provider has a baseUrl.
 *   - ANTHROPIC_MODEL    — overrides the default model for the session.
 *
 * The API KEY is NEVER written to settings.json. Claude Code reads it from the
 * environment (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN); datum only prints an
 * instruction naming the var / backend where the key lives.
 *
 * Claude Code speaks the Anthropic API only, so this target supports
 * `anthropic-compatible` providers only (see the README support matrix). A role
 * resolving to another kind is rejected with a clear error.
 */

import { DatumError } from "./errors.js";
import type { AuthStatus, ProviderKind, ResolvedRef } from "./types.js";

/** Settings surface + docs revision this generator was written against. */
export const CLAUDE_CODE_FORMAT_VERSION =
  "docs.claude.com/en/docs/claude-code/settings — ~/.claude/settings.json env block " +
  "(ANTHROPIC_BASE_URL, ANTHROPIC_MODEL), confirmed 2026-07";

/**
 * The env-block keys datum manages. A scoped merge clears exactly these before
 * writing the current block, so a re-sync to a provider without a baseUrl also
 * removes a stale ANTHROPIC_BASE_URL and never touches other env entries.
 */
export const CLAUDE_CODE_MANAGED_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"] as const;

export interface ClaudeCodeEnvBlock {
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL: string;
}

export interface GeneratedClaudeCode {
  role: string;
  provider: string;
  kind: ProviderKind;
  /** The env entries datum writes into settings.json `env` (no secret). */
  env: ClaudeCodeEnvBlock;
  /** Keys actually present in `env` (subset of CLAUDE_CODE_MANAGED_ENV_KEYS). */
  ownedKeys: string[];
  /** Non-secret guidance naming where the API key lives; NEVER the key itself. */
  apiKeyInstruction: string;
}

function apiKeyInstruction(auth: AuthStatus): string {
  const tail =
    "Claude Code reads the key from the environment (ANTHROPIC_API_KEY, or " +
    "ANTHROPIC_AUTH_TOKEN for a gateway). The key is NEVER written to settings.json.";
  switch (auth.kind) {
    case "env":
      return `API key: export it from env var "${auth.envVar}" before launching Claude Code. ${tail}`;
    case "keychain":
      return (
        `API key: stored in the macOS Keychain (${auth.ref}). Export it before launching, e.g. ` +
        `ANTHROPIC_AUTH_TOKEN=$(security find-generic-password -s ${auth.ref.split("/")[0]} -w). ${tail}`
      );
    default:
      return (
        `API key: stored in 1Password (${auth.ref}). Export it before launching, e.g. ` +
        `ANTHROPIC_AUTH_TOKEN=$(op read "${auth.ref}"). ${tail}`
      );
  }
}

/**
 * Build the Claude Code settings `env` block for a resolved role/ref. Throws
 * INVALID_CONFIG when the provider's kind is not anthropic-compatible (Claude
 * Code cannot talk to it). No secret is read or emitted.
 */
export function generateClaudeCodeEnv(role: string, resolved: ResolvedRef): GeneratedClaudeCode {
  if (resolved.kind !== "anthropic-compatible") {
    throw new DatumError(
      "INVALID_CONFIG",
      `sync claude-code: role "${role}" resolves to provider "${resolved.provider}" of kind ` +
        `"${resolved.kind}", but Claude Code speaks the Anthropic API only. Use an ` +
        `anthropic-compatible provider for this target.`,
    );
  }

  const env: ClaudeCodeEnvBlock = { ANTHROPIC_MODEL: resolved.model };
  if (resolved.baseUrl) env.ANTHROPIC_BASE_URL = resolved.baseUrl;

  return {
    role,
    provider: resolved.provider,
    kind: resolved.kind,
    env,
    ownedKeys: Object.keys(env),
    apiKeyInstruction: apiKeyInstruction(resolved.auth),
  };
}

function plainRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Merge a generated env block into an existing Claude Code settings object.
 * Clears exactly the datum-managed keys from `settings.env`, then applies the
 * current block, leaving all other settings and env entries untouched. Returns a
 * new object; does not mutate the input.
 */
export function mergeIntoClaudeCodeSettings(
  existing: Record<string, unknown>,
  env: ClaudeCodeEnvBlock,
): Record<string, unknown> {
  const existingEnv = { ...plainRecord(existing.env) };
  for (const k of CLAUDE_CODE_MANAGED_ENV_KEYS) delete existingEnv[k];
  for (const [k, v] of Object.entries(env)) existingEnv[k] = v;
  return { ...existing, env: existingEnv };
}
