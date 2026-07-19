import path from "node:path";
import { loadConfig } from "../config.js";
import type { CapabilityCatalogOptions, CatalogSource } from "./types.js";
import { datumError, redactRemoteLocation, sourceKey } from "./shared.js";

export function sourceFromOptions(opts: CapabilityCatalogOptions): CatalogSource {
  const { config } = loadConfig(opts);
  const source = config.capabilityCatalog;
  if (!source) {
    throw datumError("CAPABILITY_CATALOG_UNAVAILABLE", "No capabilityCatalog source is configured.");
  }
  if (typeof source.remoteUrl === "string") {
    const canonicalUrl = new URL(source.remoteUrl).href;
    return {
      kind: "remote",
      location: redactRemoteLocation(canonicalUrl),
      key: sourceKey(`remote:${canonicalUrl}`),
      maxAgeSeconds: source.maxAgeSeconds,
      requestUrl: canonicalUrl,
    };
  }
  return {
    kind: "local",
    location: source.localPath,
    key: sourceKey(`local:${path.resolve(opts.cwd ?? process.cwd(), source.localPath)}`),
    maxAgeSeconds: source.maxAgeSeconds,
  };
}
