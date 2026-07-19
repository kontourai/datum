/**
 * Bearing capability-catalog public façade.
 *
 * The durable source declaration belongs in `.datum/config.json`; remote
 * snapshots are copied into a disposable, source-keyed cache beneath
 * `.kontourai/datum/bearing`. Loading is deliberately offline. Only
 * `refreshCapabilityCatalog()` calls fetch.
 */

import { Buffer } from "node:buffer";
import { cacheRoot, loadCachedAt, loadLocalCatalog, persistSnapshot } from "./catalog/cache.js";
import {
  DEFAULT_CATALOG_MAX_ENTRIES_PER_OBSERVATION,
  DEFAULT_CATALOG_MAX_MODELS,
  DEFAULT_CATALOG_MAX_OBSERVATIONS,
  DEFAULT_CATALOG_MAX_OBSERVATIONS_PER_MODEL,
  DEFAULT_CATALOG_MAX_RESPONSE_BYTES,
  DEFAULT_CATALOG_REQUEST_TIMEOUT_MS,
  MAX_CATALOG_ETAG_BYTES,
} from "./catalog/limits.js";
import { sourceFromOptions } from "./catalog/source.js";
import { mapCatalogError, parseSnapshot, result } from "./catalog/snapshot.js";
import { datumError } from "./catalog/shared.js";
import {
  acquireRemoteCatalog,
  cancelResponseBodyLimited,
  readResponseLimited,
} from "./catalog/transport.js";
import type {
  CachedCatalog,
  CacheProbe,
  CacheState,
  CapabilityCatalogMetadata,
  CapabilityCatalogOptions,
  CapabilityCatalogResult,
  CatalogAcquisition,
  CatalogFetchResponse,
  CatalogSource,
  RefreshCapabilityCatalogOptions,
} from "./catalog/types.js";

export {
  DEFAULT_CATALOG_MAX_RESPONSE_BYTES,
  DEFAULT_CATALOG_REQUEST_TIMEOUT_MS,
  DEFAULT_CATALOG_MAX_MODELS,
  DEFAULT_CATALOG_MAX_OBSERVATIONS,
  DEFAULT_CATALOG_MAX_OBSERVATIONS_PER_MODEL,
  DEFAULT_CATALOG_MAX_ENTRIES_PER_OBSERVATION,
};
export type {
  CapabilityCatalogDiagnostic,
  CapabilityCatalogMetadata,
  CapabilityCatalogOptions,
  CapabilityCatalogResult,
  CapabilityCatalogSourceMetadata,
  CatalogTransport,
  CatalogFetchInit,
  CatalogFetchResponse,
  CatalogHostResolver,
  ResolvedCatalogTarget,
  RefreshCapabilityCatalogOptions,
} from "./catalog/types.js";

function probeCache(root: string, source: CatalogSource): CacheProbe {
  try {
    return { cached: loadCachedAt(root, source.key) };
  } catch (error) {
    const failure = mapCatalogError(error, "capability catalog cache");
    return failure.code === "CAPABILITY_CATALOG_UNAVAILABLE" ? {} : { error: failure };
  }
}

/** Offline-only load. Local files are read and validated directly; remote sources use only their cache. */
export function loadCapabilityCatalog(opts: CapabilityCatalogOptions = {}): CapabilityCatalogResult {
  const source = sourceFromOptions(opts);
  const now = (opts.now ?? (() => new Date()))();
  if (source.kind === "local") {
    return result(loadLocalCatalog(opts, source), source, now);
  }
  const cached = loadCachedAt(cacheRoot(opts), source.key);
  return result(cached.catalog, source, now, cached.state);
}

function activateNotModified(
  cached: CachedCatalog | undefined,
  conditionalEtag: string | undefined,
  source: CatalogSource,
  root: string,
  now: Date,
  warnings: string[],
): CapabilityCatalogResult {
  if (!cached || conditionalEtag === undefined || cached.state.etag !== conditionalEtag) {
    throw datumError(
      "CAPABILITY_CATALOG_UNAVAILABLE",
      "Capability catalog returned 304 without the matching conditional ETag.",
    );
  }
  let current = cached;
  try {
    current = loadCachedAt(root, source.key);
  } catch {
    // The validated probe remains eligible to repair disposable state.
  }
  const revalidated = current.catalog.digest === cached.catalog.digest && current.state.etag === cached.state.etag;
  const active = revalidated
    ? persistSnapshot(root, source.key, current.catalog, { ...current.state, fetchedAt: now.toISOString() })
    : current;
  return result(active.catalog, source, now, active.state, {
    fallback: false,
    notModified: revalidated,
    diagnostics: [],
    warnings: revalidated
      ? warnings
      : [...warnings, "Ignored a 304 for a superseded ETag and retained the newer active capability catalog."],
  });
}

function responseEtag(response: CatalogFetchResponse): string | undefined {
  const etag = response.headers?.get("etag") ?? undefined;
  if (etag !== undefined && Buffer.byteLength(etag, "utf8") > MAX_CATALOG_ETAG_BYTES) {
    throw datumError("CAPABILITY_CATALOG_LIMIT_EXCEEDED", `Capability catalog ETag exceeds ${MAX_CATALOG_ETAG_BYTES} bytes.`);
  }
  return etag;
}

async function activateFetchedCatalog(
  response: CatalogFetchResponse,
  source: CatalogSource,
  root: string,
  now: Date,
  warnings: string[],
  maxBytes: number,
  deadlineAt: number,
  abort: () => void,
): Promise<CapabilityCatalogResult> {
  if (response.status < 200 || response.status >= 300) {
    await cancelResponseBodyLimited(response, deadlineAt, abort);
    throw datumError("CAPABILITY_CATALOG_UNAVAILABLE", `Capability catalog refresh failed with HTTP ${response.status}.`);
  }
  const catalog = parseSnapshot(
    await readResponseLimited(response, maxBytes, deadlineAt, abort),
    "remote capability catalog",
  );
  const etag = responseEtag(response);
  const state: CacheState = {
    version: 1,
    digest: catalog.digest,
    fetchedAt: now.toISOString(),
    ...(etag === undefined ? {} : { etag }),
  };
  result(catalog, source, now, state);
  const active = persistSnapshot(root, source.key, catalog, state);
  return result(active.catalog, source, now, active.state, {
    fallback: false,
    notModified: false,
    diagnostics: [],
    warnings,
  });
}

async function activateAcquisition(
  acquisition: CatalogAcquisition,
  probe: CacheProbe,
  source: CatalogSource,
  root: string,
  now: Date,
  maxBytes: number,
): Promise<CapabilityCatalogResult> {
  try {
    if (acquisition.response.status === 304) {
      await cancelResponseBodyLimited(
        acquisition.response,
        acquisition.deadlineAt,
        acquisition.abort,
      );
      return activateNotModified(
        probe.cached,
        acquisition.conditionalEtag,
        source,
        root,
        now,
        acquisition.warnings,
      );
    }
    return await activateFetchedCatalog(
      acquisition.response,
      source,
      root,
      now,
      acquisition.warnings,
      maxBytes,
      acquisition.deadlineAt,
      acquisition.abort,
    );
  } finally {
    acquisition.abort();
  }
}

function fallbackOrThrow(
  root: string,
  failure: ReturnType<typeof mapCatalogError>,
  source: CatalogSource,
  now: Date,
  warnings: string[],
): CapabilityCatalogResult {
  const probe = probeCache(root, source);
  if (probe.cached) {
    try {
      return result(probe.cached.catalog, source, now, probe.cached.state, {
        fallback: true,
        notModified: false,
        diagnostics: [{ code: failure.code, message: failure.message }],
        warnings,
      });
    } catch (error) {
      const stale = mapCatalogError(error, "capability catalog cache");
      throw datumError(stale.code, `${stale.message} Refresh also failed: ${failure.code}: ${failure.message}`);
    }
  }
  if (probe.error) {
    throw datumError(
      probe.error.code,
      `${probe.error.message} Refresh also failed: ${failure.code}: ${failure.message}`,
    );
  }
  throw failure;
}

/** Explicit remote operation. On failure, returns a non-stale cached catalog with a typed fallback diagnostic when available. */
export async function refreshCapabilityCatalog(opts: RefreshCapabilityCatalogOptions = {}): Promise<CapabilityCatalogResult> {
  const source = sourceFromOptions(opts);
  if (source.kind !== "remote") return loadCapabilityCatalog(opts);
  const maxBytes = opts.maxResponseBytes ?? DEFAULT_CATALOG_MAX_RESPONSE_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw datumError(
      "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
      "Capability catalog response limit must be a positive finite number.",
    );
  }
  const clock = opts.now ?? (() => new Date());
  const root = cacheRoot(opts);
  const probe = probeCache(root, source);
  let warnings: string[] = [];
  try {
    const acquisition = await acquireRemoteCatalog(source, probe.cached, opts);
    warnings = acquisition.warnings;
    return await activateAcquisition(
      acquisition,
      probe,
      source,
      root,
      clock(),
      maxBytes,
    );
  } catch (error) {
    return fallbackOrThrow(root, mapCatalogError(error, "capability catalog refresh"), source, clock(), warnings);
  }
}
