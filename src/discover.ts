/**
 * `datum discover` and `datum test-connection` — live model discovery and
 * provider reachability checking.
 *
 * These are the SECOND and THIRD places datum touches the network (after
 * `doctor --probe`), both explicit/opt-in per-provider commands, never run
 * as part of `resolve`/`resolveRef`/`list`/`sync` (those stay pure/offline).
 * Both are routed through the SAME credential-resolution chain `doctor.ts`
 * uses: `loadConfig()` -> `resolveRef()`/`describeAuth()` (non-secret
 * availability check) -> `resolve()` (the only function that materializes an
 * API key, via `defaultSecretRunner` or an injected `secretRunner`). This
 * module shells out to nothing and reads no credential env var directly of
 * its own — see AC4 in the plan — and adds zero new npm dependencies, only
 * Node's global `fetch` and the injectable `DiscoverFetchLike` shape below.
 *
 * `DiscoverFetchLike` is deliberately its own type, not `doctor.ts`'s
 * `FetchLike`: discovery must read the RESPONSE BODY (`.text()`) to inspect
 * the `/models` payload shape, which `doctor.ts`'s probes never do (they only
 * look at `ok`/`status`). Node's global `fetch`'s `Response` satisfies this
 * shape structurally, so the real CLI needs no adapter.
 */

import { describeAuth } from "./auth.js";
import { loadConfig } from "./config.js";
import { probeAnthropicCompatible } from "./doctor.js";
import type { CheckStatus } from "./doctor.js";
import { DatumError } from "./errors.js";
import { resolve } from "./resolve.js";
import { defaultSecretRunner } from "./secrets.js";
import type { ProviderConfig, ResolveOptions } from "./types.js";

export type DiscoverFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Three named diagnosis classes (AC3), each with a visibly distinct detail
 * prefix so a caller can grep/assert.match without parsing free text:
 *  - "auth"         -> credentials unavailable / MISSING_ENV / SECRET_* / auth rejected (HTTP 401|403)
 *  - "unreachable"  -> unreachable: <fetch error>
 *  - "incompatible" -> unexpected HTTP N / not valid JSON / missing expected {data:[{id}]} shape
 */
export type DiagnosisClass = "auth" | "unreachable" | "incompatible";

export interface DiscoverResult {
  ok: boolean;
  models: string[];
  errorClass?: DiagnosisClass;
  detail: string;
}

/**
 * `GET {baseUrl}/models` against an openai-compatible provider's endpoint
 * (base defaults to `https://api.openai.com/v1`, same trailing-slash-strip as
 * `doctor.ts`'s probers) using `authorization: Bearer {apiKey}`. Classifies
 * every failure into one of the three DiagnosisClass values (see the
 * class-mapping table in the plan): try/catch -> "unreachable"; 401/403 ->
 * "auth"; any other non-ok status, a non-JSON body, or a JSON body missing
 * the `{ data: [{ id }] }` shape -> "incompatible".
 */
export async function fetchOpenaiCompatibleModels(
  args: { baseUrl?: string; apiKey: string },
  fetchImpl: DiscoverFetchLike,
): Promise<DiscoverResult> {
  const base = (args.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const url = `${base}/models`;

  let res: { ok: boolean; status: number; text: () => Promise<string> };
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${args.apiKey}` },
    });
  } catch (err) {
    return { ok: false, models: [], errorClass: "unreachable", detail: `unreachable: ${(err as Error).message}` };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, models: [], errorClass: "auth", detail: `auth rejected (HTTP ${res.status})` };
  }
  if (!res.ok) {
    return {
      ok: false,
      models: [],
      errorClass: "incompatible",
      detail: `unexpected HTTP ${res.status} from /models (expected 200)`,
    };
  }

  const bodyText = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, models: [], errorClass: "incompatible", detail: "response from /models is not valid JSON" };
  }

  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || !data.every((d) => d && typeof (d as { id?: unknown }).id === "string")) {
    return {
      ok: false,
      models: [],
      errorClass: "incompatible",
      detail: "response JSON missing expected {data:[{id}]} shape",
    };
  }

  const models = (data as Array<{ id: string }>).map((d) => d.id);
  return { ok: true, models, detail: `found ${models.length} model(s)` };
}

/**
 * The exact synthetic-ref construction `runDoctor`'s `--probe` path already
 * uses (`src/doctor.ts:191-193`) to resolve a provider's FIRST model,
 * reused verbatim: `${model}@${providerId}`.
 */
function firstModelRef(id: string, p: ProviderConfig): string {
  return `${p.models[0]}@${id}`;
}

export interface DiscoverModelsOptions extends ResolveOptions {
  fetchImpl?: DiscoverFetchLike;
}

/**
 * Fetch the live model id list from an `openai-compatible` provider's
 * `/models` endpoint (AC1). Unknown provider id or a non-openai-compatible
 * kind is reported (not thrown) — this is a report, not an exception path.
 */
export async function discoverModels(
  providerId: string,
  opts: DiscoverModelsOptions = {},
): Promise<DiscoverResult> {
  const { config } = loadConfig(opts);
  const p = config.providers?.[providerId];
  if (!p) {
    const known = Object.keys(config.providers ?? {});
    return {
      ok: false,
      models: [],
      errorClass: "incompatible",
      detail: `Unknown provider "${providerId}". Known providers: ${known.length ? known.join(", ") : "(none)"}.`,
    };
  }
  if (p.kind !== "openai-compatible") {
    return {
      ok: false,
      models: [],
      errorClass: "incompatible",
      detail: `provider "${providerId}" is kind "${p.kind}"; discovery only supports "openai-compatible"`,
    };
  }

  // Auth availability — non-secret check, short-circuits BEFORE any network call.
  // Mirrors testConnection()'s steps 3-4 below so a missing/unavailable
  // credential is folded into a DiscoverResult (errorClass:"auth") instead of
  // an uncaught DatumError from resolve() — this stays a report, not a throw.
  const env = { ...process.env, ...(opts.env ?? {}) };
  const runner = opts.secretRunner ?? defaultSecretRunner;
  const auth = describeAuth(p.auth, env, runner);
  if (!auth.available) {
    const detail =
      auth.kind === "env"
        ? `credentials unavailable: env ${auth.ref} is not set`
        : `credentials unavailable: ${auth.kind} (${auth.ref}) backend tool ${auth.tool} not available`;
    return { ok: false, models: [], errorClass: "auth", detail };
  }

  // Materialize the API key (the ONLY place a secret is read). Wrapped in
  // try/catch as a defense-in-depth backstop alongside the availability
  // check above — e.g. a keychain/1Password lookup that fails AFTER
  // reporting available (tool present but the lookup itself errors) still
  // resolves to a reported errorClass:"auth", never an uncaught DatumError.
  let target;
  try {
    target = resolve(firstModelRef(providerId, p), opts);
  } catch (err) {
    const detail = err instanceof DatumError ? `${err.code}: ${err.message}` : (err as Error).message;
    return { ok: false, models: [], errorClass: "auth", detail };
  }

  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as DiscoverFetchLike);
  return fetchOpenaiCompatibleModels({ baseUrl: target.baseUrl, apiKey: target.apiKey }, fetchImpl);
}

export interface TestConnectionCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  errorClass?: DiagnosisClass;
}

export interface TestConnectionReport {
  ok: boolean;
  checks: TestConnectionCheck[];
}

export interface TestConnectionOptions extends ResolveOptions {
  fetchImpl?: DiscoverFetchLike;
}

/**
 * Validate a configured provider's auth + reachability (AC2), any `kind`:
 * `openai-compatible` gets full 3-class diagnosis via
 * `fetchOpenaiCompatibleModels`; `anthropic-compatible` reuses
 * `probeAnthropicCompatible` directly (zero new network code for that kind).
 * Because `probeAnthropicCompatible` never checks a `/models` shape, its
 * failures are classified by string-matching its free-text `detail`: "auth
 * rejected" -> "auth", "unreachable" -> "unreachable", and the reachable
 * else-branch below maps EVERY OTHER probe failure (e.g. an unexpected HTTP
 * status) to "incompatible" — that fallback fires and IS exercised by tests,
 * it is not dead code. Any other kind is reported "skip" (mirrors
 * `runDoctor`'s unsupported-kind handling — skip does not fail the report).
 */
export async function testConnection(
  providerId: string,
  opts: TestConnectionOptions = {},
): Promise<TestConnectionReport> {
  const checks: TestConnectionCheck[] = [];

  // 1. Config parse/validate.
  let loaded;
  try {
    loaded = loadConfig(opts);
  } catch (err) {
    const detail = err instanceof DatumError ? `${err.code}: ${err.message}` : (err as Error).message;
    checks.push({ name: "config", status: "fail", detail });
    return { ok: false, checks };
  }
  checks.push({ name: "config", status: "pass", detail: `parsed ${loaded.sources.length} file(s)` });
  const config = loaded.config;

  // 2. Provider lookup.
  const p = config.providers?.[providerId];
  if (!p) {
    const known = Object.keys(config.providers ?? {});
    checks.push({
      name: "provider",
      status: "fail",
      detail: `Unknown provider "${providerId}". Known providers: ${known.length ? known.join(", ") : "(none)"}.`,
    });
    return { ok: false, checks };
  }
  checks.push({ name: "provider", status: "pass", detail: `${providerId} is kind "${p.kind}"` });

  // 3. Auth availability — non-secret check, short-circuits BEFORE any network call.
  const env = { ...process.env, ...(opts.env ?? {}) };
  const runner = opts.secretRunner ?? defaultSecretRunner;
  const auth = describeAuth(p.auth, env, runner);
  if (!auth.available) {
    const detail =
      auth.kind === "env"
        ? `credentials unavailable: env ${auth.ref} is not set`
        : `credentials unavailable: ${auth.kind} (${auth.ref}) backend tool ${auth.tool} not available`;
    checks.push({ name: "auth", status: "fail", detail, errorClass: "auth" });
    return { ok: false, checks };
  }
  checks.push({
    name: "auth",
    status: "pass",
    detail:
      auth.kind === "env" ? `env ${auth.ref} is set` : `${auth.kind} (${auth.ref}) backend available via ${auth.tool}`,
  });

  // 4. Materialize the API key (the ONLY place a secret is read).
  let target;
  try {
    target = resolve(firstModelRef(providerId, p), opts);
  } catch (err) {
    const detail = err instanceof DatumError ? `${err.code}: ${err.message}` : (err as Error).message;
    checks.push({ name: "auth", status: "fail", detail, errorClass: "auth" });
    return { ok: false, checks };
  }

  // 5. Connectivity check, dispatched by kind.
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as DiscoverFetchLike | undefined);
  let connect: TestConnectionCheck;
  if ((p.kind === "openai-compatible" || p.kind === "anthropic-compatible") && !fetchImpl) {
    // Applies equally to both network-touching kinds — hoisted above the
    // kind switch below to avoid duplicating this fail branch per kind.
    connect = {
      name: "connect",
      status: "fail",
      detail: "no fetch implementation available",
      errorClass: "unreachable",
    };
  } else if (p.kind === "openai-compatible") {
    const r = await fetchOpenaiCompatibleModels({ baseUrl: target.baseUrl, apiKey: target.apiKey }, fetchImpl!);
    connect = {
      name: "connect",
      status: r.ok ? "pass" : "fail",
      detail: r.detail,
      ...(r.errorClass ? { errorClass: r.errorClass } : {}),
    };
  } else if (p.kind === "anthropic-compatible") {
    const probe = await probeAnthropicCompatible(
      { baseUrl: target.baseUrl, apiKey: target.apiKey, model: target.model },
      fetchImpl!,
    );
    let errorClass: DiagnosisClass | undefined;
    if (probe.status === "fail") {
      if (probe.detail.includes("auth rejected")) errorClass = "auth";
      else if (probe.detail.includes("unreachable")) errorClass = "unreachable";
      else errorClass = "incompatible";
    }
    connect = {
      name: "connect",
      status: probe.status,
      detail: probe.detail,
      ...(errorClass ? { errorClass } : {}),
    };
  } else {
    connect = {
      name: "connect",
      status: "skip",
      detail: `kind "${p.kind}" has no test-connection implementation`,
    };
  }
  checks.push(connect);

  const ok = !checks.some((c) => c.status === "fail");
  return { ok, checks };
}
