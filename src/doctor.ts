/**
 * `datum doctor` diagnostics.
 *
 * Without --probe: purely offline — config parses, every role resolves, every
 * provider's API-key env var is present. This touches no network.
 *
 * With --probe: the SINGLE place in datum permitted to touch the network. It
 * makes ONE minimal request per provider (max_tokens: 1) against the
 * anthropic-compatible /v1/messages shape using plain fetch, to verify the
 * endpoint + key + model actually work. `fetchImpl` is injectable so this is
 * unit-tested without real network access.
 */

import { loadConfig } from "./config.js";
import { DatumError } from "./errors.js";
import { resolve, resolveRef } from "./resolve.js";
import type { ProviderConfig, ResolveOptions } from "./types.js";

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

  // 2. Every role resolves.
  for (const role of Object.keys(config.roles ?? {})) {
    try {
      const r = resolveRef(role, opts);
      checks.push({ name: `role ${role}`, status: "pass", detail: `-> ${r.model}@${r.provider}` });
    } catch (err) {
      const detail = err instanceof DatumError ? `${err.code}: ${err.message}` : (err as Error).message;
      checks.push({ name: `role ${role}`, status: "fail", detail });
    }
  }

  // 3. Every provider's API-key env var is present.
  const env = { ...process.env, ...(opts.env ?? {}) };
  for (const [id, p] of Object.entries(config.providers ?? {}) as [string, ProviderConfig][]) {
    const keyVal = env[p.auth.env];
    const set = typeof keyVal === "string" && keyVal.length > 0;
    checks.push({
      name: `key ${id}`,
      status: set ? "pass" : "warn",
      detail: set ? `${p.auth.env} is set` : `${p.auth.env} is not set`,
    });
  }

  // 4. Optional live probe.
  if (opts.probe) {
    const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    for (const [id, p] of Object.entries(config.providers ?? {}) as [string, ProviderConfig][]) {
      if (p.kind !== "anthropic-compatible") {
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
      const check = await probeAnthropicCompatible(
        { baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model },
        fetchImpl,
      );
      checks.push({ ...check, name: `probe ${id}` });
    }
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}
