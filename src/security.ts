/**
 * HTTPS enforcement policy — the SINGLE place datum decides whether a
 * network request to a provider's `baseUrl` is allowed to proceed, plus the
 * `safeFetch` wrapper that is the SINGLE place a key-bearing request is
 * actually issued.
 *
 * All network-touching functions (`probeAnthropicCompatible`,
 * `probeOpenaiCompatible` in `src/doctor.ts`, and
 * `fetchOpenaiCompatibleModels` in `src/discover.ts` — the latter also
 * backing `datum test-connection` — plus Bearing catalog acquisition in
 * `src/catalog.ts`) route their request through `safeFetch()`,
 * which enforces `enforceHttpsPolicy()` on the initial URL AND on every
 * redirect target BEFORE the key-bearing request is (re-)issued to it. A
 * blocked URL — whether the configured `baseUrl` or a `Location:` a server
 * tries to bounce us to — never reaches `fetchImpl`, so the API key is never
 * transmitted to it. This keeps the policy's detection/decision logic in
 * exactly one place instead of copy-pasted across call sites.
 *
 * Policy: `https://` is always allowed. `http://` to a loopback host
 * (`localhost`, `127.0.0.0/8`, `::1`, and the IPv4-mapped IPv6 form
 * `::ffff:127.x.x.x`) is allowed silently — this is the Ollama/LM Studio-style
 * local-provider case. `http://` to any other host is blocked by default with
 * an actionable message; passing `allowInsecure` lets the request proceed but
 * returns a warning the caller must surface.
 *
 * Redirects are handled with `redirect: "manual"` so the platform's `fetch`
 * cannot silently auto-follow an `https://` -> `http://non-loopback` bounce
 * and leak the key: `safeFetch` re-runs the policy per hop instead.
 *
 * Non-goals (explicitly out of scope): TLS certificate verification, proxy
 * support, cross-host `Authorization`-header stripping, and any scheme other
 * than `http:`/`https:` — those are left to `fetchImpl`/the platform.
 *
 * `enforceHttpsPolicy` is pure: no I/O, no `fetch`, no `console`/`process`
 * calls. It returns a structured result rather than throwing a `DatumError`
 * (see `src/errors.ts`) because it is consumed by the same report-not-throw
 * functions that already return `{status:"fail", detail}` /
 * `{ok:false, errorClass, detail}` shapes — callers fold this result into
 * their existing report type instead of catching an exception.
 */

export interface HttpsPolicyOptions {
  allowInsecure?: boolean;
}

export interface HttpsPolicyResult {
  blocked: boolean;
  detail?: string;
  warning?: string;
}

const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
// IPv4-mapped IPv6 loopback, in the form the URL parser normalizes it to:
// `http://[::ffff:127.0.0.1]` -> hostname `[::ffff:7f00:1]`. 127.0.0.0/8 is
// 0x7f000000..0x7fffffff, i.e. the high hextet after `ffff:` is `7f00`..`7fff`
// (always `7f` + two more hex digits — no leading zero to strip); the low
// hextet is 1..4 hex digits. `[::ffff:0:0]` (0.0.0.0 mapped) does not match.
const LOOPBACK_V4_MAPPED = /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i;

/** True iff a URL hostname or resolved address names a loopback address. */
export function isLoopbackHost(hostname: string): boolean {
  // Only bare-word hosts (e.g. "localhost.") need an explicit trailing-dot
  // strip; IPv4/IPv6 literals are already canonicalized by URL itself.
  const withoutDot = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  const host = (withoutDot.startsWith("[") && withoutDot.endsWith("]")
    ? withoutDot.slice(1, -1)
    : withoutDot).toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    LOOPBACK_V4.test(host) ||
    LOOPBACK_V4_MAPPED.test(host)
  );
}

/**
 * Decide whether a request to `url` may proceed. Malformed URLs pass through
 * unblocked (`{ blocked: false }`) — an invalid `baseUrl` is a pre-existing,
 * unrelated failure mode that will surface naturally when the caller's own
 * `fetchImpl`/URL construction runs; this policy does not invent a new error
 * class for it.
 */
export function enforceHttpsPolicy(url: string, opts: HttpsPolicyOptions = {}): HttpsPolicyResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: false };
  }

  if (parsed.protocol !== "http:") {
    // https:// (or any other scheme) is always allowed — out of scope here.
    return { blocked: false };
  }

  if (isLoopbackHost(parsed.hostname)) {
    return { blocked: false };
  }

  if (!opts.allowInsecure) {
    return {
      blocked: true,
      detail: `insecure: refusing plaintext http:// request to ${url}; use https:// or pass --allow-insecure to override`,
    };
  }

  return {
    blocked: false,
    warning: `insecure: proceeding with plaintext http:// request to ${url} because --allow-insecure was passed; the request and its API key will be sent unencrypted`,
  };
}

/**
 * The minimal response shape `safeFetch` needs to make its redirect decision:
 * a numeric `status` and (only consulted on a 3xx) a `headers.get()`. The
 * platform `Response` and the narrower `FetchLike`/`DiscoverFetchLike` doubles
 * all satisfy this structurally; `headers` is optional so the existing
 * non-redirecting test doubles (which return `{ok, status}` only) still fit.
 */
export interface PolicyCheckedResponse {
  status: number;
  headers?: { get(name: string): string | null };
  body?: { cancel(reason?: unknown): Promise<void> } | null;
}

/**
 * Outcome of `safeFetch`. Exactly one of `blocked` / `response` is meaningful:
 * when `blocked` is true the request was refused by policy (`detail` explains
 * why, and no key-bearing request reached the blocked URL); otherwise
 * `response` is the final (post-redirect) response and `warning` is set iff an
 * `--allow-insecure` plaintext hop was traversed.
 */
export interface SafeFetchResult<R> {
  blocked: boolean;
  detail?: string;
  warning?: string;
  response?: R;
}

// HTTP redirect statuses we follow manually. (We re-issue the SAME request —
// method, headers, body — to the target; per-hop method rewriting per RFC 7231
// is out of scope, the security-relevant behavior is the per-hop policy check.)
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 5;

function releaseRedirectBody(response: PolicyCheckedResponse): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch {
    // Cleanup is best effort; redirect policy must not depend on stream behavior.
  }
}

/**
 * Issue a request through the HTTPS policy, following redirects MANUALLY so the
 * policy is re-checked before the key-bearing request is re-sent to each hop.
 *
 * `fetchImpl` is always invoked with `redirect: "manual"` so the platform
 * `fetch` returns 3xx responses (with their `Location`) instead of silently
 * auto-following them — otherwise an `https://` `baseUrl` whose server answers
 * `302 Location: http://evil` would leak the API key to `evil` with no policy
 * check at all. On each hop `safeFetch`:
 *   1. runs `enforceHttpsPolicy(currentUrl)`; a block returns `{blocked:true}`
 *      WITHOUT calling `fetchImpl` for that URL (the key is never sent there);
 *   2. calls `fetchImpl`; a non-3xx (or a 3xx with no `Location`) response is
 *      returned as-is for the caller's own status/body handling;
 *   3. otherwise resolves `Location` against the current URL and loops, up to
 *      `maxRedirects` hops (default 5) after which it throws — callers already
 *      map a thrown error to their "unreachable" class.
 *
 * A single `warning` (the first insecure `--allow-insecure` hop's) is carried
 * through to the result so the caller surfaces it exactly once.
 */
export async function safeFetch<I extends { redirect?: "manual" }, R extends PolicyCheckedResponse>(
  url: string,
  init: I,
  fetchImpl: (url: string, init: I) => Promise<R>,
  opts: HttpsPolicyOptions & { maxRedirects?: number } = {},
): Promise<SafeFetchResult<R>> {
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = url;
  let warning: string | undefined;

  for (let hop = 0; ; hop++) {
    const policy = enforceHttpsPolicy(currentUrl, opts);
    if (policy.blocked) {
      const detail =
        hop === 0 ? policy.detail : `${policy.detail} (reached by following a redirect from ${url})`;
      return { blocked: true, detail };
    }
    if (policy.warning && warning === undefined) warning = policy.warning;

    const res = await fetchImpl(currentUrl, { ...init, redirect: "manual" });

    const location = REDIRECT_STATUSES.has(res.status) ? (res.headers?.get("location") ?? null) : null;
    if (location === null) {
      // Terminal response (non-3xx, or a 3xx with no Location to follow):
      // hand it back for the caller's own status/body mapping.
      return warning === undefined ? { blocked: false, response: res } : { blocked: false, response: res, warning };
    }

    releaseRedirectBody(res);

    if (hop >= maxRedirects) {
      throw new Error(`too many redirects (>${maxRedirects}) starting from ${url}`);
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
}
