import { BearingError, parseCatalog, type CatalogSnapshot } from "@kontourai/bearing";
import { DatumError } from "../errors.js";
import {
  DEFAULT_CATALOG_MAX_ENTRIES_PER_OBSERVATION,
  DEFAULT_CATALOG_MAX_MODELS,
  DEFAULT_CATALOG_MAX_OBSERVATIONS,
  DEFAULT_CATALOG_MAX_OBSERVATIONS_PER_MODEL,
} from "./limits.js";
import { datumError, errorMessage } from "./shared.js";
import type { CacheState, CapabilityCatalogMetadata, CapabilityCatalogResult, CatalogSource } from "./types.js";

export function mapCatalogError(err: unknown, label: string) {
  if (err instanceof DatumError) return err;
  if (err instanceof BearingError) {
    if (err.code === "UNSUPPORTED_CATALOG_SCHEMA") {
      return datumError("CAPABILITY_CATALOG_UNSUPPORTED_SCHEMA", `${label} uses an unsupported Bearing catalog schema.`);
    }
    if (err.code === "INVALID_CATALOG" && /does not match its deterministically recompiled content/.test(err.message)) {
      return datumError("CAPABILITY_CATALOG_DIGEST_MISMATCH", `${label} has a digest that does not match its content.`);
    }
    return datumError("CAPABILITY_CATALOG_MALFORMED", `${label} is not a valid Bearing catalog.`);
  }
  return datumError("CAPABILITY_CATALOG_UNAVAILABLE", `${label} is unavailable: ${errorMessage(err)}`);
}

export function assertCatalogComplexity(text: string): void {
  let root: unknown;
  try {
    root = JSON.parse(text) as unknown;
  } catch {
    return;
  }
  if (root === null || typeof root !== "object" || Array.isArray(root)) return;
  const models = (root as { models?: unknown }).models;
  if (!Array.isArray(models)) return;
  if (models.length > DEFAULT_CATALOG_MAX_MODELS) {
    throw datumError("CAPABILITY_CATALOG_LIMIT_EXCEEDED", `Capability catalog exceeds ${DEFAULT_CATALOG_MAX_MODELS} models.`);
  }
  let observationCount = 0;
  for (const model of models) {
    if (model === null || typeof model !== "object" || Array.isArray(model)) continue;
    const observations = (model as { observations?: unknown }).observations;
    if (!Array.isArray(observations)) continue;
    if (observations.length > DEFAULT_CATALOG_MAX_OBSERVATIONS_PER_MODEL) {
      throw datumError(
        "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
        `Capability catalog exceeds ${DEFAULT_CATALOG_MAX_OBSERVATIONS_PER_MODEL} observations for one model.`,
      );
    }
    observationCount += observations.length;
    if (observationCount > DEFAULT_CATALOG_MAX_OBSERVATIONS) {
      throw datumError(
        "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
        `Capability catalog exceeds ${DEFAULT_CATALOG_MAX_OBSERVATIONS} total observations.`,
      );
    }
    for (const observation of observations) {
      if (observation === null || typeof observation !== "object" || Array.isArray(observation)) continue;
      const candidate = observation as { measurements?: unknown; evidence?: unknown };
      for (const [name, entries] of [["measurements", candidate.measurements], ["evidence", candidate.evidence]] as const) {
        if (Array.isArray(entries) && entries.length > DEFAULT_CATALOG_MAX_ENTRIES_PER_OBSERVATION) {
          throw datumError(
            "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
            `Capability catalog observation exceeds ${DEFAULT_CATALOG_MAX_ENTRIES_PER_OBSERVATION} ${name} entries.`,
          );
        }
      }
    }
  }
}

export function parseSnapshot(text: string, label: string): CatalogSnapshot {
  try {
    assertCatalogComplexity(text);
    return parseCatalog(text);
  } catch (err) {
    throw mapCatalogError(err, label);
  }
}

export function assertFresh(catalog: CatalogSnapshot, maxAgeSeconds: number | undefined, now: Date): number {
  const milliseconds = now.getTime() - new Date(catalog.asOf).getTime();
  if (milliseconds < 0) {
    throw datumError(
      "CAPABILITY_CATALOG_MALFORMED",
      `Capability catalog snapshot ${catalog.digest} is dated in the future (${catalog.asOf}).`,
    );
  }
  const age = milliseconds / 1000;
  if (maxAgeSeconds !== undefined && age > maxAgeSeconds) {
    throw datumError(
      "CAPABILITY_CATALOG_STALE",
      `Capability catalog snapshot ${catalog.digest} is stale (${age.toFixed(3)}s old; maximum ${maxAgeSeconds}s).`,
    );
  }
  return age;
}

export function result(
  catalog: CatalogSnapshot,
  source: CatalogSource,
  now: Date,
  state?: CacheState,
  extra: Pick<CapabilityCatalogMetadata, "fallback" | "notModified" | "diagnostics" | "warnings"> = {
    fallback: false,
    notModified: false,
    diagnostics: [],
    warnings: [],
  },
): CapabilityCatalogResult {
  return {
    catalog,
    metadata: {
      source: {
        kind: source.kind,
        location: source.kind === "local" ? "<local>" : source.location,
        key: source.key,
      },
      digest: catalog.digest,
      asOf: catalog.asOf,
      ageSeconds: assertFresh(catalog, source.maxAgeSeconds, now),
      ...(state?.etag === undefined ? {} : { etag: state.etag }),
      ...(state === undefined ? {} : { fetchedAt: state.fetchedAt }),
      ...extra,
    },
  };
}
