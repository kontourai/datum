import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { serializeCatalog, type CatalogSnapshot } from "@kontourai/bearing";
import { DatumError, type DatumErrorCode } from "../errors.js";
import { DEFAULT_CATALOG_MAX_RESPONSE_BYTES, MAX_CATALOG_STATE_BYTES, MAX_CATALOG_ETAG_BYTES } from "./limits.js";
import { parseSnapshot } from "./snapshot.js";
import { datumError, sourceKey } from "./shared.js";
import type { CachedCatalog, CacheState, CapabilityCatalogOptions, CatalogSource, SelectedCachedCatalog, StateCandidate } from "./types.js";

function catalogWorkingRoot(opts: CapabilityCatalogOptions): string {
  try {
    return realpathSync(opts.cwd ?? process.cwd());
  } catch {
    throw datumError("CAPABILITY_CATALOG_UNAVAILABLE", "Datum working directory is unavailable.");
  }
}

export function cacheRoot(opts: CapabilityCatalogOptions): string {
  if (opts.cacheRoot !== undefined) return path.resolve(opts.cacheRoot);
  const workingRoot = catalogWorkingRoot(opts);
  let current = workingRoot;
  for (const component of [".kontourai", "datum", "bearing"]) {
    current = path.join(current, component);
    assertSafeDirectory(current, `Capability catalog cache path component "${component}"`);
  }
  return current;
}

export function assertSafeDirectory(directory: string, label: string): void {
  if (!existsSync(directory)) return;
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw datumError("CAPABILITY_CATALOG_CACHE_CORRUPT", `${label} must be a real directory, not a symlink or file.`);
  }
}

function ensureSafeCacheDirectories(root: string): void {
  assertSafeDirectory(root, "Capability catalog cache root");
  mkdirSync(root, { recursive: true });
  assertSafeDirectory(root, "Capability catalog cache root");
  for (const name of ["state", "snapshots"]) {
    const directory = path.join(root, name);
    assertSafeDirectory(directory, `Capability catalog ${name} directory`);
    mkdirSync(directory, { recursive: true });
    assertSafeDirectory(directory, `Capability catalog ${name} directory`);
    const relative = path.relative(realpathSync(root), realpathSync(directory));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw datumError("CAPABILITY_CATALOG_CACHE_CORRUPT", `Capability catalog ${name} directory escapes the cache root.`);
    }
  }
}

function assertSafeExistingCacheDirectories(root: string): void {
  assertSafeDirectory(root, "Capability catalog cache root");
  if (!existsSync(root)) return;
  const realRoot = realpathSync(root);
  for (const name of ["state", "snapshots"]) {
    const directory = path.join(root, name);
    assertSafeDirectory(directory, `Capability catalog ${name} directory`);
    if (!existsSync(directory)) continue;
    const relative = path.relative(realRoot, realpathSync(directory));
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw datumError("CAPABILITY_CATALOG_CACHE_CORRUPT", `Capability catalog ${name} directory escapes the cache root.`);
    }
  }
}

function assertSafeCacheFile(file: string): void {
  if (!existsSync(file)) return;
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw datumError("CAPABILITY_CATALOG_CACHE_CORRUPT", `Capability catalog cache file "${path.basename(file)}" is not a regular file.`);
  }
}

function stateDirectory(root: string, key: string): string {
  return path.join(root, "state", key);
}

function snapshotPath(root: string, digest: string): string {
  return path.join(root, "snapshots", `${digest}.json`);
}

function readStateCandidates(root: string, key: string): {
  candidates: StateCandidate[];
  disappeared: boolean;
  errors: string[];
} {
  const directory = stateDirectory(root, key);
  if (!existsSync(directory)) return { candidates: [], disappeared: false, errors: [] };
  assertSafeDirectory(directory, "Capability catalog source state directory");
  const candidates: StateCandidate[] = [];
  const errors: string[] = [];
  let disappeared = false;
  for (const name of readdirSync(directory).sort()) {
    if (name.startsWith(".")) continue;
    const file = path.join(directory, name);
    try {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error(`unexpected state filename "${name}"`);
      assertSafeCacheFile(file);
      if (statSync(file).size > MAX_CATALOG_STATE_BYTES) throw new Error("state exceeds its size limit");
      const text = readFileSync(file, "utf8");
      if (name !== `${sourceKey(text)}.json`) throw new Error("state filename does not match its content");
      const state = JSON.parse(text) as CacheState;
      if (
        state.version !== 1 ||
        typeof state.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(state.digest) ||
        typeof state.fetchedAt !== "string" ||
        !Number.isFinite(Date.parse(state.fetchedAt)) ||
        (state.etag !== undefined &&
          (typeof state.etag !== "string" || Buffer.byteLength(state.etag, "utf8") > MAX_CATALOG_ETAG_BYTES))
      ) {
        throw new Error("state has an invalid shape");
      }
      candidates.push({ file, state });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") disappeared = true;
      errors.push(`${name}: ${(error as Error).message}`);
    }
  }
  return { candidates, disappeared, errors };
}

type StateProbe = ReturnType<typeof readStateCandidates>;

function loadValidCatalogCandidates(
  root: string,
  probe: StateProbe,
  maxBytes: number,
): { valid: SelectedCachedCatalog[]; errors: string[] } {
  const valid: SelectedCachedCatalog[] = [];
  const errors = [...probe.errors];
  const candidateFiles = probe.candidates.map((entry) => entry.file);
  for (const candidate of probe.candidates) {
    try {
      const file = snapshotPath(root, candidate.state.digest);
      const text = readCatalogFile(file, maxBytes, "CAPABILITY_CATALOG_CACHE_CORRUPT", "Cached capability catalog");
      const catalog = parseSnapshot(text, `cached capability catalog ${candidate.state.digest}`);
      if (catalog.digest !== candidate.state.digest) throw new Error("state digest does not match snapshot content");
      valid.push({
        catalog,
        state: candidate.state,
        stateFile: candidate.file,
        candidateFiles: [...candidateFiles],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") probe.disappeared = true;
      errors.push(`${path.basename(candidate.file)}: ${(error as Error).message}`);
    }
  }
  return { valid, errors };
}

function selectNewestCatalog(candidates: SelectedCachedCatalog[]): SelectedCachedCatalog | undefined {
  let selected: SelectedCachedCatalog | undefined;
  for (const candidate of candidates) {
    if (selected === undefined || compareCatalogState(selected, candidate) < 0) selected = candidate;
  }
  return selected;
}

function assertNoCatalogVersionConflict(
  candidates: SelectedCachedCatalog[],
  selected: SelectedCachedCatalog,
): void {
  const conflict = candidates.find(
    (candidate) =>
      candidate.catalog.asOf === selected.catalog.asOf &&
      candidate.catalog.digest !== selected.catalog.digest,
  );
  if (conflict) {
    throw datumError(
      "CAPABILITY_CATALOG_CONFLICT",
      `Capability catalog source has multiple digests for asOf ${selected.catalog.asOf}; the publisher must advance asOf for every revision.`,
    );
  }
}

export function readCatalogFile(file: string, maxBytes: number, code: DatumErrorCode, label: string): string {
  assertSafeCacheFile(file);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw datumError("CAPABILITY_CATALOG_LIMIT_EXCEEDED", "Capability catalog size limit must be a positive number.");
  }
  if (statSync(file).size > maxBytes) {
    throw datumError(code, `${label} exceeds ${maxBytes} bytes.`);
  }
  return readFileSync(file, "utf8");
}

export function selectCachedAt(
  root: string,
  key: string,
  maxBytes = DEFAULT_CATALOG_MAX_RESPONSE_BYTES,
  retriesRemaining = 2,
): SelectedCachedCatalog {
  assertSafeExistingCacheDirectories(root);
  const probe = readStateCandidates(root, key);
  if (probe.candidates.length === 0 && probe.errors.length === 0) {
    throw datumError("CAPABILITY_CATALOG_UNAVAILABLE", "No cached capability catalog exists; run `datum catalog refresh`.");
  }
  const { valid, errors } = loadValidCatalogCandidates(root, probe, maxBytes);
  const selected = selectNewestCatalog(valid);
  if (selected === undefined) {
    if (probe.disappeared && retriesRemaining > 0) {
      return selectCachedAt(root, key, maxBytes, retriesRemaining - 1);
    }
    throw datumError(
      "CAPABILITY_CATALOG_CACHE_CORRUPT",
      `Capability catalog cache has no valid state: ${errors.join("; ")}`,
    );
  }
  assertNoCatalogVersionConflict(valid, selected);
  selected.candidateFiles.push(...probe.errors.map((entry) => path.join(stateDirectory(root, key), entry.split(":", 1)[0])));
  return selected;
}

export function loadCachedAt(root: string, key: string, maxBytes = DEFAULT_CATALOG_MAX_RESPONSE_BYTES): CachedCatalog {
  const selected = selectCachedAt(root, key, maxBytes);
  return { catalog: selected.catalog, state: selected.state };
}

export function loadLocalCatalog(opts: CapabilityCatalogOptions, source: CatalogSource): CatalogSnapshot {
  const workingRoot = catalogWorkingRoot(opts);
  const configuredPath = path.resolve(workingRoot, source.location);
  let localPath: string;
  let text: string;
  try {
    localPath = realpathSync(configuredPath);
    const relative = path.relative(workingRoot, localPath);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw datumError(
        "CAPABILITY_CATALOG_PATH_OUTSIDE_ROOT",
        "Local capability catalog resolves outside the Datum working directory.",
      );
    }
    text = readCatalogFile(
      localPath,
      DEFAULT_CATALOG_MAX_RESPONSE_BYTES,
      "CAPABILITY_CATALOG_LIMIT_EXCEEDED",
      "Local capability catalog",
    );
  } catch (err) {
    if (err instanceof DatumError) throw err;
    throw datumError("CAPABILITY_CATALOG_UNAVAILABLE", "Local capability catalog is unavailable.");
  }
  return parseSnapshot(text, "local capability catalog");
}

function atomicWrite(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, file);
  } catch (err) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Previously committed state candidates remain intact regardless of temporary cleanup.
    }
    throw err;
  }
}

function compareCatalogState(left: CachedCatalog, right: CachedCatalog): number {
  const leftAsOf = Date.parse(left.catalog.asOf);
  const rightAsOf = Date.parse(right.catalog.asOf);
  if (leftAsOf !== rightAsOf) return leftAsOf < rightAsOf ? -1 : 1;
  const leftFetchedAt = Date.parse(left.state.fetchedAt);
  const rightFetchedAt = Date.parse(right.state.fetchedAt);
  if (leftFetchedAt !== rightFetchedAt) return leftFetchedAt < rightFetchedAt ? -1 : 1;
  if (left.catalog.digest === right.catalog.digest) return 0;
  return left.catalog.digest < right.catalog.digest ? -1 : 1;
}

export function persistSnapshot(root: string, key: string, catalog: CatalogSnapshot, state: CacheState): CachedCatalog {
  ensureSafeCacheDirectories(root);
  const snapshot = snapshotPath(root, catalog.digest);
  // Snapshot is immutable and content-addressed; state moves only after its snapshot exists.
  let writeSnapshot = true;
  if (existsSync(snapshot)) {
    try {
      const existing = parseSnapshot(
        readCatalogFile(
          snapshot,
          DEFAULT_CATALOG_MAX_RESPONSE_BYTES,
          "CAPABILITY_CATALOG_CACHE_CORRUPT",
          "Cached capability catalog",
        ),
        `cached capability catalog ${catalog.digest}`,
      );
      writeSnapshot = existing.digest !== catalog.digest;
    } catch {
      // A newly validated remote copy may repair a corrupt disposable cache file.
      writeSnapshot = true;
    }
  }
  if (writeSnapshot) {
    atomicWrite(snapshot, serializeCatalog(catalog));
  }
  const sourceStateDirectory = stateDirectory(root, key);
  assertSafeDirectory(sourceStateDirectory, "Capability catalog source state directory");
  mkdirSync(sourceStateDirectory, { recursive: true });
  assertSafeDirectory(sourceStateDirectory, "Capability catalog source state directory");
  const stateText = JSON.stringify(state);
  atomicWrite(path.join(sourceStateDirectory, `${sourceKey(stateText)}.json`), stateText);

  const active = selectCachedAt(root, key);
  for (const file of active.candidateFiles) {
    if (file === active.stateFile) continue;
    try {
      assertSafeCacheFile(file);
      unlinkSync(file);
    } catch {
      // Candidate compaction is opportunistic; selection is deterministic even if a loser remains.
    }
  }
  return { catalog: active.catalog, state: active.state };
}
