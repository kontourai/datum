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
import type { ProviderConfig, ProviderKind, ResolveOptions } from "./types.js";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/**
 * Probe one anthropic-compatible provider with a max_tokens:1 request.
 * 200 => pass; 401/403 => auth fail; other status => fail(status); throw => unreachable.
 */
export async function probeAnthropicCompatible(
  args: { baseUrl?: string; apiKey: string; model: string },
  fetchImpl: FetchLike,
): Promise<DoctorCheck> {
  const base = (args.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${base}/v1/messages`;
  const name = `probe ${args.model} @ ${base}`;
  try {
    const res = await fetchImpl(url, {
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
    });
    if (res.ok) return { name, status: "pass", detail: `HTTP ${res.status}` };
    if (res.status === 401 || res.status === 403) {
      return { name, status: "fail", detail: `auth rejected (HTTP ${res.status})` };
    }
    return { name, status: "fail", detail: `unexpected HTTP ${res.status}` };
  } catch (err) {
    return { name, status: "fail", detail: `unreachable: ${(err as Error).message}` };
  }
}

/**
 * Probe one openai-compatible provider with a max_tokens:1 request against
 * POST {baseUrl}/chat/completions using a Bearer token. Same status mapping as
 * the anthropic-compatible probe.
 */
export async function probeOpenaiCompatible(
  args: { baseUrl?: string; apiKey: string; model: string },
  fetchImpl: FetchLike,
): Promise<DoctorCheck> {
  const base = (args.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const name = `probe ${args.model} @ ${base}`;
  try {
    const res = await fetchImpl(url, {
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
    });
    if (res.ok) return { name, status: "pass", detail: `HTTP ${res.status}` };
    if (res.status === 401 || res.status === 403) {
      return { name, status: "fail", detail: `auth rejected (HTTP ${res.status})` };
    }
    return { name, status: "fail", detail: `unexpected HTTP ${res.status}` };
  } catch (err) {
    return { name, status: "fail", detail: `unreachable: ${(err as Error).message}` };
  }
}

export interface DoctorOptions extends ResolveOptions {
  probe?: boolean;
  fetchImpl?: FetchLike;
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  // 1. Config parse/validate.
  let loaded;
  try {
    loaded = loadConfig(opts);
    const n = Object.keys(loaded.config.providers ?? {}).length;
    const r = Object.keys(loaded.config.roles ?? {}).length;
    checks.push({
      name: "config",
      status: "pass",
      detail: `parsed ${loaded.sources.length} file(s); ${n} provider(s), ${r} role(s)`,
    });
  } catch (err) {
    const detail = err instanceof DatumError ? `${err.code}: ${err.message}` : (err as Error).message;
    checks.push({ name: "config", status: "fail", detail });
    return { ok: false, checks };
  }

  const config = loaded.config;

  // 2. Every role resolves (no secret read).
  for (const role of Object.keys(config.roles ?? {})) {
    try {
      const r = resolveRef(role, opts);
      checks.push({ name: `role ${role}`, status: "pass", detail: `-> ${r.model}@${r.provider}` });
    } catch (err) {
      const detail = err instanceof DatumError ? `${err.code}: ${err.message}` : (err as Error).message;
      checks.push({ name: `role ${role}`, status: "fail", detail });
    }
  }

  // 3. Every provider's key backend is reachable-in-principle — NO secret read.
  const env = { ...process.env, ...(opts.env ?? {}) };
  const runner = opts.secretRunner ?? defaultSecretRunner;
  for (const [id, p] of Object.entries(config.providers ?? {}) as [string, ProviderConfig][]) {
    const auth = describeAuth(p.auth, env, runner);
    if (auth.kind === "env") {
      checks.push({
        name: `key ${id}`,
        status: auth.available ? "pass" : "warn",
        detail: auth.available ? `env ${auth.ref} is set` : `env ${auth.ref} is not set`,
      });
    } else {
      checks.push({
        name: `key ${id}`,
        status: auth.available ? "pass" : "warn",
        detail: auth.available
          ? `${auth.kind} (${auth.ref}) backend available via ${auth.tool}`
          : `${auth.kind} (${auth.ref}) backend tool ${auth.tool} not available (key not read)`,
      });
    }
  }

  // 4. Optional live probe.
  if (opts.probe) {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    for (const [id, p] of Object.entries(config.providers ?? {}) as [string, ProviderConfig][]) {
      const probeFn = probeForKind(p.kind);
      if (!probeFn) {
        checks.push({
          name: `probe ${id}`,
          status: "skip",
          detail: `kind "${p.kind}" has no probe implementation`,
        });
        continue;
      }
      if (!fetchImpl) {
        checks.push({ name: `probe ${id}`, status: "fail", detail: "no fetch implementation available" });
        continue;
      }
      let target;
      try {
        target = resolve(id in (config.roles ?? {}) ? id : (p.models[0] + "@" + id), opts);
      } catch (err) {
        const detail = err instanceof DatumError ? `${err.code}: ${err.message}` : (err as Error).message;
        checks.push({ name: `probe ${id}`, status: "fail", detail });
        continue;
      }
      const check = await probeFn(
        { baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model },
        fetchImpl,
      );
      checks.push({ ...check, name: `probe ${id}` });
    }
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}

type ProbeFn = (
  args: { baseUrl?: string; apiKey: string; model: string },
  fetchImpl: FetchLike,
) => Promise<DoctorCheck>;

function probeForKind(kind: ProviderKind): ProbeFn | undefined {
  if (kind === "anthropic-compatible") return probeAnthropicCompatible;
  if (kind === "openai-compatible") return probeOpenaiCompatible;
  return undefined;
}

