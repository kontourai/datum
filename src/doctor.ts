/**
 * `datum doctor` diagnostics.
 *
 * Without --probe: purely offline — config parses, every role resolves, and each
 * provider's key backend is reachable-in-principle (env var set, or the
 * keychain/op tool present). This touches NO network and reads NO secret: the
 * key-status check reports the auth kind and whether the backing tool is
 * available, never the value.
 *
 * With --probe: the SINGLE place in datum permitted to touch the network. It
 * makes ONE minimal request per provider (max_tokens: 1) against the shape for
 * the provider's kind — anthropic-compatible POST /v1/messages, openai-compatible
 * POST /chat/completions — using plain fetch, to verify endpoint + key + model.
 * `fetchImpl` and `secretRunner` are injectable so this is unit-tested without
 * real network access or a real Keychain / 1Password.
 */

import { describeAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { DatumError } from "./errors.js";
import { resolve, resolveRef } from "./resolve.js";
import { defaultSecretRunner } from "./secrets.js";
import { safeFetch } from "./security.js";
import type { CapabilityRole, DatumConfig, ProviderConfig, ProviderKind, ResolveOptions } from "./types.js";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; redirect?: "manual" },
) => Promise<{ ok: boolean; status: number; headers?: { get(name: string): string | null } }>;

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  warning?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  warnings: string[];
}

/**
 * Probe one anthropic-compatible provider with a max_tokens:1 request.
 * 200 => pass; 401/403 => auth fail; other status => fail(status); throw => unreachable.
 *
 * The request is issued through `safeFetch()`, which enforces the HTTPS policy
 * on `url` AND on every redirect target before the key-bearing request (which
 * carries `args.apiKey` as `x-api-key`) is (re-)issued, so a blocked URL never
 * reaches `fetchImpl` and the key is never sent to it.
 */
export async function probeAnthropicCompatible(
  args: { baseUrl?: string; apiKey: string; model: string; allowInsecure?: boolean },
  fetchImpl: FetchLike,
): Promise<DoctorCheck> {
  const base = (args.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${base}/v1/messages`;
  const name = `probe ${args.model} @ ${base}`;

  let outcome;
  try {
    outcome = await safeFetch(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": args.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: args.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      },
      fetchImpl,
      { allowInsecure: args.allowInsecure },
    );
  } catch (err) {
    return { name, status: "fail", detail: `unreachable: ${(err as Error).message}` };
  }
  if (outcome.blocked) {
    return { name, status: "fail", detail: outcome.detail! };
  }

  const res = outcome.response!;
  let check: DoctorCheck;
  if (res.ok) {
    check = { name, status: "pass", detail: `HTTP ${res.status}` };
  } else if (res.status === 401 || res.status === 403) {
    check = { name, status: "fail", detail: `auth rejected (HTTP ${res.status})` };
  } else {
    check = { name, status: "fail", detail: `unexpected HTTP ${res.status}` };
  }
  return outcome.warning ? { ...check, warning: outcome.warning } : check;
}

/**
 * Probe one openai-compatible provider with a max_tokens:1 request against
 * POST {baseUrl}/chat/completions using a Bearer token. Same status mapping as
 * the anthropic-compatible probe.
 *
 * The request is issued through `safeFetch()`, which enforces the HTTPS policy
 * on `url` AND on every redirect target before the key-bearing request (which
 * carries `args.apiKey` as a Bearer token) is (re-)issued, so a blocked URL
 * never reaches `fetchImpl` and the key is never sent to it.
 */
export async function probeOpenaiCompatible(
  args: { baseUrl?: string; apiKey: string; model: string; allowInsecure?: boolean },
  fetchImpl: FetchLike,
): Promise<DoctorCheck> {
  const base = (args.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const name = `probe ${args.model} @ ${base}`;

  let outcome;
  try {
    outcome = await safeFetch(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${args.apiKey}`,
        },
        body: JSON.stringify({
          model: args.model,
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
      },
      fetchImpl,
      { allowInsecure: args.allowInsecure },
    );
  } catch (err) {
    return { name, status: "fail", detail: `unreachable: ${(err as Error).message}` };
  }
  if (outcome.blocked) {
    return { name, status: "fail", detail: outcome.detail! };
  }

  const res = outcome.response!;
  let check: DoctorCheck;
  if (res.ok) {
    check = { name, status: "pass", detail: `HTTP ${res.status}` };
  } else if (res.status === 401 || res.status === 403) {
    check = { name, status: "fail", detail: `auth rejected (HTTP ${res.status})` };
  } else {
    check = { name, status: "fail", detail: `unexpected HTTP ${res.status}` };
  }
  return outcome.warning ? { ...check, warning: outcome.warning } : check;
}

export interface DoctorOptions extends ResolveOptions {
  probe?: boolean;
  fetchImpl?: FetchLike;
  allowInsecure?: boolean;
}

function errorDetail(error: unknown): string {
  return error instanceof DatumError ? `${error.code}: ${error.message}` : (error as Error).message;
}

function loadDoctorConfig(opts: DoctorOptions, checks: DoctorCheck[]): DatumConfig | null {
  try {
    const loaded = loadConfig(opts);
    const providers = Object.keys(loaded.config.providers ?? {}).length;
    const roles = Object.keys(loaded.config.roles ?? {}).length;
    const files = loaded.sources.length ? loaded.sources.join(", ") : "(none found)";
    checks.push({ name: "config", status: "pass", detail: `parsed ${loaded.sources.length} file(s) [${files}]; ${providers} provider(s), ${roles} role(s)` });
    return loaded.config;
  } catch (error) {
    checks.push({ name: "config", status: "fail", detail: errorDetail(error) });
    return null;
  }
}

function checkRoles(config: DatumConfig, opts: DoctorOptions, checks: DoctorCheck[]): void {
  for (const [role, definition] of Object.entries(config.roles ?? {}) as [string, CapabilityRole][]) {
    if (typeof definition !== "string") {
      checks.push({ name: `role ${role}`, status: "skip", detail: "capability policy requires runtime inventory; use resolve-policy" });
      continue;
    }
    try {
      const resolved = resolveRef(role, opts);
      checks.push({ name: `role ${role}`, status: "pass", detail: `-> ${resolved.model}@${resolved.provider}` });
    } catch (error) {
      checks.push({ name: `role ${role}`, status: "fail", detail: errorDetail(error) });
    }
  }
}

function checkProviderAuth(config: DatumConfig, opts: DoctorOptions, checks: DoctorCheck[]): void {
  const env = { ...process.env, ...(opts.env ?? {}) };
  const runner = opts.secretRunner ?? defaultSecretRunner;
  for (const [id, provider] of Object.entries(config.providers ?? {}) as [string, ProviderConfig][]) {
    const auth = describeAuth(provider.auth, env, runner);
    const detail = auth.kind === "env"
      ? (auth.available ? `env ${auth.ref} is set` : `env ${auth.ref} is not set`)
      : (auth.available
        ? `${auth.kind} (${auth.ref}) backend available via ${auth.tool}`
        : `${auth.kind} (${auth.ref}) backend tool ${auth.tool} not available (key not read)`);
    checks.push({ name: `key ${id}`, status: auth.available ? "pass" : "warn", detail });
  }
}

async function probeProvider(id: string, provider: ProviderConfig, opts: DoctorOptions, fetchImpl: FetchLike | undefined): Promise<DoctorCheck> {
  const probeFn = probeForKind(provider.kind);
  if (!probeFn) return { name: `probe ${id}`, status: "skip", detail: `kind "${provider.kind}" has no probe implementation` };
  if (!fetchImpl) return { name: `probe ${id}`, status: "fail", detail: "no fetch implementation available" };
  let target;
  try {
    target = resolve(`${provider.models[0]}@${id}`, opts);
  } catch (error) {
    return { name: `probe ${id}`, status: "fail", detail: errorDetail(error) };
  }
  const check = await probeFn(
    { baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model, allowInsecure: opts.allowInsecure },
    fetchImpl,
  );
  return { ...check, name: `probe ${id}` };
}

async function checkProbes(config: DatumConfig, opts: DoctorOptions, checks: DoctorCheck[], warnings: string[]): Promise<void> {
  if (!opts.probe) return;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  for (const [id, provider] of Object.entries(config.providers ?? {}) as [string, ProviderConfig][]) {
    const check = await probeProvider(id, provider, opts, fetchImpl);
    checks.push(check);
    if (check.warning) warnings.push(check.warning);
  }
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const warnings: string[] = [];
  const config = loadDoctorConfig(opts, checks);
  if (!config) return { ok: false, checks, warnings };
  checkRoles(config, opts, checks);
  checkProviderAuth(config, opts, checks);
  await checkProbes(config, opts, checks, warnings);
  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks, warnings };
}

type ProbeFn = (
  args: { baseUrl?: string; apiKey: string; model: string; allowInsecure?: boolean },
  fetchImpl: FetchLike,
) => Promise<DoctorCheck>;

function probeForKind(kind: ProviderKind): ProbeFn | undefined {
  if (kind === "anthropic-compatible") return probeAnthropicCompatible;
  if (kind === "openai-compatible") return probeOpenaiCompatible;
  return undefined;
}
