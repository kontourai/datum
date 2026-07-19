import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { compileCatalog, serializeCatalog, type ObservationInput } from "@kontourai/bearing";
import { DatumError, refreshCapabilityCatalog } from "../src/index.js";
import { tempTree } from "./helpers.js";

export const REMOTE_URL = "https://93.184.216.34/snapshot.json";
export const NOW = "2026-07-18T00:01:00.000Z";
export const clock = () => new Date(NOW);

export function catalog(asOf = "2026-07-18T00:00:00.000Z") {
  return compileCatalog([], { asOf });
}

export function catalogVariant(asOf: string, modelId: string) {
  const observation: ObservationInput = {
    schemaVersion: "bearing.observation/v1",
    kind: "declaration",
    model: { id: modelId, revision: null, quantization: null },
    execution: null,
    task: null,
    measurements: [{ key: "model.context.max_tokens", kind: "fact", value: 8192 }],
    outcome: null,
    usage: null,
    sourceClass: "external",
    evidence: [{
      id: `source-${modelId}`,
      kind: "benchmark-source",
      uri: `https://catalog.example/${modelId}`,
      digest: null,
      observedAt: "2026-07-17T00:00:00.000Z",
    }],
    freshness: { observedAt: "2026-07-17T00:00:00.000Z", validUntil: null },
    uncertainty: { level: "low", basis: ["source declaration"], gaps: [] },
  };
  return compileCatalog([observation], { asOf });
}

export function config(remoteUrl = REMOTE_URL, maxAgeSeconds?: number) {
  return {
    capabilityCatalog: {
      remoteUrl,
      ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
    },
  };
}

export function stateFiles(cacheRoot: string, key: string): string[] {
  const directory = path.join(cacheRoot, "state", key);
  return readdirSync(directory)
    .filter((name) => !name.startsWith("."))
    .map((name) => path.join(directory, name))
    .sort();
}

export function seed(
  t: ReturnType<typeof tempTree>,
  cacheRoot: string,
  snapshot = catalog(),
) {
  t.writeRepo(config());
  return refreshCapabilityCatalog({
    cwd: t.cwd,
    home: t.home,
    cacheRoot,
    now: clock,
    transport: async () => new Response(serializeCatalog(snapshot), {
      status: 200,
      headers: { etag: '"v1"' },
    }),
  });
}

export function rejectsCode(
  work: () => Promise<unknown> | unknown,
  code: string,
): Promise<void> {
  return assert.rejects(
    async () => work(),
    (error: unknown) => error instanceof DatumError && error.code === code,
  ).then(() => undefined);
}
