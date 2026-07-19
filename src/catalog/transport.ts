import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { enforceHttpsPolicy, isLoopbackHost, safeFetch } from "../security.js";
import { DEFAULT_CATALOG_REQUEST_TIMEOUT_MS } from "./limits.js";
import { datumError, redactRemoteLocation, redactUrls } from "./shared.js";
import type { CachedCatalog, CatalogAcquisition, CatalogFetchInit, CatalogFetchResponse, CatalogHostResolver, RefreshCapabilityCatalogOptions, ResolvedCatalogTarget, CatalogSource } from "./types.js";

export async function readResponseLimited(
  response: CatalogFetchResponse,
  maxBytes: number,
  deadlineAt?: number,
  abort: () => void = () => {},
): Promise<string> {
  const beforeDeadline = <T>(work: Promise<T>, cancel: () => void): Promise<T> => {
    if (deadlineAt === undefined) return work;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      cancel();
      return Promise.reject(new Error("Capability catalog request exceeded its deadline."));
    }
    return withinDeadline(work, remainingMs, cancel);
  };
  const advertised = response.headers?.get("content-length");
  if (advertised && Number(advertised) > maxBytes) {
    abort();
    void response.body?.cancel().catch(() => {});
    throw datumError("CAPABILITY_CATALOG_RESPONSE_TOO_LARGE", `Capability catalog response exceeds ${maxBytes} bytes.`);
  }
  if (!response.body) {
    throw datumError(
      "CAPABILITY_CATALOG_UNAVAILABLE",
      "Capability catalog transport returned a successful response without a readable body stream.",
    );
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await beforeDeadline(reader.read(), () => {
        abort();
        void reader.cancel();
      });
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        abort();
        void reader.cancel().catch(() => {});
        throw datumError("CAPABILITY_CATALOG_RESPONSE_TOO_LARGE", `Capability catalog response exceeds ${maxBytes} bytes.`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export async function cancelResponseBodyLimited(
  response: CatalogFetchResponse,
  deadlineAt: number,
  abort: () => void,
): Promise<void> {
  if (!response.body) return;
  const cancellation = response.body.cancel();
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    abort();
    void cancellation.catch(() => {});
    throw new Error("Capability catalog request exceeded its deadline.");
  }
  await withinDeadline(cancellation, remainingMs, abort);
}

async function closeRedirectBody(
  response: CatalogFetchResponse,
  deadlineAt: number,
  abort: () => void,
): Promise<CatalogFetchResponse> {
  const redirects = new Set([301, 302, 303, 307, 308]);
  if (redirects.has(response.status) && response.headers?.get("location")) {
    await cancelResponseBodyLimited(response, deadlineAt, abort);
    return {
      status: response.status,
      headers: response.headers,
      body: null,
      text: () => response.text(),
    };
  }
  return response;
}

function assertCatalogTransportUrl(url: string, allowInsecure: boolean | undefined): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw datumError("CAPABILITY_CATALOG_INSECURE_URL", `Capability catalog URL is invalid: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw datumError("CAPABILITY_CATALOG_INSECURE_URL", `Capability catalog URL must use https (or loopback http): ${redactRemoteLocation(url)}`);
  }
  const policy = enforceHttpsPolicy(url, { allowInsecure });
  if (policy.blocked) {
    throw datumError(
      "CAPABILITY_CATALOG_INSECURE_URL",
      redactUrls(policy.detail ?? "Insecure capability catalog URL."),
    );
  }
  return policy.warning === undefined ? undefined : redactUrls(policy.warning);
}

function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function ipv4Number(address: string): number {
  return address.split(".").reduce((value, octet) => ((value << 8) | Number(octet)) >>> 0, 0);
}

function isPublicAddress(address: string): boolean {
  const host = bareHostname(address).toLowerCase();
  if (isIP(host) === 4) {
    const value = ipv4Number(host);
    const blocked = [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
      ["224.0.0.0", 4], ["240.0.0.0", 4],
    ] as const;
    return !blocked.some(([network, prefix]) => {
      const mask = (0xffffffff << (32 - prefix)) >>> 0;
      return (value & mask) === (ipv4Number(network) & mask);
    });
  }
  if (isIP(host) === 6) {
    if (host.startsWith("::ffff:")) {
      const mapped = host.slice("::ffff:".length);
      return isIP(mapped) === 4 && isPublicAddress(mapped);
    }
    if (host === "::" || host === "::1" || host.startsWith("2001:db8:")) return false;
    const first = Number.parseInt(host.split(":", 1)[0] || "0", 16);
    return first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}

function isExplicitLocalSource(url: URL): boolean {
  return isLoopbackHost(url.hostname);
}

const defaultHostResolver: CatalogHostResolver = async (hostname) =>
  (await lookup(bareHostname(hostname), { all: true, verbatim: true })).map((entry) => entry.address);

async function assertCatalogRequestTarget(
  configuredUrl: URL,
  requestUrl: string,
  opts: RefreshCapabilityCatalogOptions,
): Promise<ResolvedCatalogTarget> {
  const target = new URL(requestUrl);
  if (target.origin !== configuredUrl.origin) {
    throw datumError(
      "CAPABILITY_CATALOG_INSECURE_URL",
      `Capability catalog redirects must remain on configured origin ${configuredUrl.origin}.`,
    );
  }
  if (target.username || target.password || target.search || target.hash) {
    throw datumError(
      "CAPABILITY_CATALOG_INSECURE_URL",
      "Capability catalog redirect targets must not contain userinfo, query parameters, or fragments.",
    );
  }
  assertCatalogTransportUrl(target.toString(), opts.allowInsecure);

  const resolver = opts.resolveHost ?? defaultHostResolver;
  const addresses = await resolver(target.hostname);
  if (addresses.length === 0) {
    throw datumError("CAPABILITY_CATALOG_UNAVAILABLE", "Capability catalog host did not resolve to an address.");
  }
  const explicitLocal = isExplicitLocalSource(configuredUrl);
  const resolved: ResolvedCatalogTarget["addresses"] = [];
  for (const address of addresses) {
    const family = isIP(bareHostname(address));
    const allowedAddress = explicitLocal
      ? isLoopbackHost(address)
      : isPublicAddress(address);
    if ((family !== 4 && family !== 6) || !allowedAddress) {
      throw datumError(
        "CAPABILITY_CATALOG_INSECURE_URL",
        `Capability catalog host resolved to a disallowed address (${address}).`,
      );
    }
    resolved.push({ address: bareHostname(address), family });
  }
  return { addresses: resolved };
}

function pinnedCatalogFetch(
  requestUrl: string,
  init: CatalogFetchInit,
  target: ResolvedCatalogTarget,
  timeoutMs: number,
): Promise<CatalogFetchResponse> {
  const url = new URL(requestUrl);
  const request = url.protocol === "https:" ? requestHttps : requestHttp;
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, target.addresses);
      return;
    }
    const selected = target.addresses[0];
    callback(null, selected.address, selected.family);
  };
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const outgoing = request(
      url,
      {
        method: "GET",
        headers: init.headers,
        lookup: pinnedLookup,
      },
      (incoming) => {
        settled = true;
        incoming.once("end", clearDeadline);
        incoming.once("close", clearDeadline);
        incoming.once("error", clearDeadline);
        const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
        resolvePromise({
          status: incoming.statusCode ?? 0,
          headers: {
            get(name: string): string | null {
              const value = incoming.headers[name.toLowerCase()];
              if (value === undefined) return null;
              return Array.isArray(value) ? value.join(", ") : value;
            },
          },
          body,
          text: () => new Response(body).text(),
        });
      },
    );
    const timeout = setTimeout(() => {
      outgoing.destroy(new Error(`Capability catalog request exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    timeout.unref();
    const clearDeadline = () => clearTimeout(timeout);
    outgoing.once("error", (error) => {
      clearDeadline();
      if (!settled) rejectPromise(error);
    });
    outgoing.once("close", () => {
      if (!settled) clearDeadline();
    });
    outgoing.end();
  });
}

function withinDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void = () => {},
  onLateValue: (value: T) => void = () => {},
): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      onTimeout();
      rejectPromise(new Error(`Capability catalog request exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timeout);
        if (timedOut) {
          onLateValue(value);
          return;
        }
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timeout);
        rejectPromise(error);
      },
    );
  });
}

interface CatalogResponseContext {
  deadlineAt: number;
  abort(): void;
}

async function acquireCatalogHop(
  configuredUrl: URL,
  requestUrl: string,
  init: CatalogFetchInit,
  opts: RefreshCapabilityCatalogOptions,
  timeoutMs: number,
  contexts: WeakMap<object, CatalogResponseContext>,
): Promise<CatalogFetchResponse> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + timeoutMs;
  const target = await withinDeadline(
    assertCatalogRequestTarget(configuredUrl, requestUrl, opts),
    timeoutMs,
  );
  const remainingMs = Math.max(1, deadlineAt - Date.now());
  if (opts.transport === undefined) {
    const response = await pinnedCatalogFetch(requestUrl, init, target, remainingMs);
    contexts.set(response, { deadlineAt, abort: () => {} });
    return closeRedirectBody(response, deadlineAt, () => {});
  }

  const controller = new AbortController();
  const response = await withinDeadline(
    opts.transport(requestUrl, { ...init, signal: controller.signal }, target),
    remainingMs,
    () => controller.abort(),
    (late) => { void late.body?.cancel(); },
  );
  const abort = () => controller.abort();
  contexts.set(response, { deadlineAt, abort });
  return closeRedirectBody(response, deadlineAt, abort);
}

function acquisitionFromResponse(
  response: CatalogFetchResponse,
  context: CatalogResponseContext | undefined,
  warning: string | undefined,
  conditionalEtag: string | undefined,
  timeoutMs: number,
): CatalogAcquisition {
  return {
    response,
    warnings: warning === undefined ? [] : [warning],
    ...(conditionalEtag === undefined ? {} : { conditionalEtag }),
    deadlineAt: context?.deadlineAt ?? Date.now() + timeoutMs,
    abort: context?.abort ?? (() => {}),
  };
}

export async function acquireRemoteCatalog(
  source: CatalogSource,
  cached: CachedCatalog | undefined,
  opts: RefreshCapabilityCatalogOptions,
): Promise<CatalogAcquisition> {
  if (source.requestUrl === undefined) {
    throw datumError("CAPABILITY_CATALOG_UNAVAILABLE", "No remote capabilityCatalog source is configured.");
  }
  const configuredUrl = new URL(source.requestUrl);
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_CATALOG_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw datumError("CAPABILITY_CATALOG_LIMIT_EXCEEDED", "Capability catalog request timeout must be a positive number.");
  }
  const initialWarning = assertCatalogTransportUrl(source.requestUrl, opts.allowInsecure);
  const contexts = new WeakMap<object, CatalogResponseContext>();
  const headers: Record<string, string> = {};
  if (cached?.state.etag !== undefined) headers["if-none-match"] = cached.state.etag;
  const safe = await safeFetch<CatalogFetchInit, CatalogFetchResponse>(
    source.requestUrl,
    { headers },
    (requestUrl, init) => acquireCatalogHop(configuredUrl, requestUrl, init, opts, timeoutMs, contexts),
    { allowInsecure: opts.allowInsecure },
  );
  if (safe.blocked) {
    throw datumError("CAPABILITY_CATALOG_INSECURE_URL", redactUrls(safe.detail ?? "Insecure capability catalog URL."));
  }
  if (!safe.response) {
    throw datumError("CAPABILITY_CATALOG_UNAVAILABLE", "Capability catalog refresh received no response.");
  }
  const warning = safe.warning === undefined ? initialWarning : redactUrls(safe.warning);
  return acquisitionFromResponse(
    safe.response,
    contexts.get(safe.response),
    warning,
    cached?.state.etag,
    timeoutMs,
  );
}
