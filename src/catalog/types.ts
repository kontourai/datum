import type { CatalogSnapshot } from "@kontourai/bearing";
import type { DatumError, DatumErrorCode } from "../errors.js";
import type { ResolveOptions } from "../types.js";

export interface CapabilityCatalogSourceMetadata {
  kind: "remote" | "local";
  /** Redacted remote location (query/userinfo stripped) or configured local path. */
  location: string;
  /** SHA-256 source identity used for remote cache isolation. */
  key: string;
}

export interface CapabilityCatalogDiagnostic {
  code: DatumErrorCode;
  message: string;
}

export interface CapabilityCatalogMetadata {
  source: CapabilityCatalogSourceMetadata;
  digest: string;
  asOf: string;
  ageSeconds: number;
  etag?: string;
  fetchedAt?: string;
  fallback: boolean;
  notModified: boolean;
  diagnostics: CapabilityCatalogDiagnostic[];
  warnings: string[];
}

export interface CapabilityCatalogResult {
  catalog: CatalogSnapshot;
  metadata: CapabilityCatalogMetadata;
}

export interface CatalogFetchInit {
  headers?: Record<string, string>;
  redirect?: "manual";
  signal?: AbortSignal;
}

export interface CatalogFetchResponse {
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  /** Required and streamed for successful 2xx responses; may be absent for redirects and 304. */
  body?: ReadableStream<Uint8Array> | null;
}

export type CatalogTransport = (
  url: string,
  init: CatalogFetchInit,
  target: ResolvedCatalogTarget,
) => Promise<CatalogFetchResponse>;
export type CatalogHostResolver = (hostname: string) => Promise<string[]>;

export interface CapabilityCatalogOptions extends ResolveOptions {
  /** Disposable cache root. Default: `<cwd>/.kontourai/datum/bearing`. */
  cacheRoot?: string;
  /** Injectable clock for deterministic freshness tests. */
  now?: () => Date;
  /** Maximum accepted remote body size in bytes. */
  maxResponseBytes?: number;
  /** Injectable DNS resolver used before every transport hop. */
  resolveHost?: CatalogHostResolver;
}

export interface RefreshCapabilityCatalogOptions extends CapabilityCatalogOptions {
  /** Trusted injectable transport; it must connect only to validated addresses and stream 2xx bodies. */
  transport?: CatalogTransport;
  /** Permit non-loopback plaintext HTTP for this explicit refresh only. */
  allowInsecure?: boolean;
  /** Overall deadline for each request hop. */
  requestTimeoutMs?: number;
}

export interface CatalogSource {
  kind: "remote" | "local";
  location: string;
  key: string;
  maxAgeSeconds?: number;
  requestUrl?: string;
}

export interface CacheState {
  version: 1;
  digest: string;
  etag?: string;
  fetchedAt: string;
}

export interface CachedCatalog {
  catalog: CatalogSnapshot;
  state: CacheState;
}

export interface CacheProbe {
  cached?: CachedCatalog;
  error?: DatumError;
}

export interface StateCandidate {
  file: string;
  state: CacheState;
}

export interface SelectedCachedCatalog extends CachedCatalog {
  candidateFiles: string[];
  stateFile: string;
}

export interface CatalogAcquisition {
  response: CatalogFetchResponse;
  warnings: string[];
  conditionalEtag?: string;
  deadlineAt: number;
  abort(): void;
}

export interface ResolvedCatalogTarget {
  addresses: Array<{ address: string; family: 4 | 6 }>;
}
