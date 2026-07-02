/**
 * Config discovery, deep-merge overlay, and validation.
 *
 * Two files, deep-merged: user-level `~/.config/kontour/datum.json` is the base;
 * repo-level `.kontour/datum.json` is the overlay and wins per-key. Environment
 * escape hatches override BOTH, but that happens later in resolve.ts — this
 * module owns only the file layer. A missing file is not an error (skipped); a
 * present-but-unparseable file is (INVALID_CONFIG, naming the path).
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatumError } from "./errors.js";
import type { DatumConfig, ResolveOptions } from "./types.js";
import { validateConfig } from "./validate.js";

export interface LoadedConfig {
  config: DatumConfig;
  /** Absolute paths actually read, base-first (user, then repo). */
  sources: string[];
}

export function userConfigPath(opts: Pick<ResolveOptions, "home" | "userConfigPath">): string {
  if (opts.userConfigPath) return opts.userConfigPath;
  return path.join(opts.home ?? os.homedir(), ".config", "kontour", "datum.json");
}

export function repoConfigPath(opts: Pick<ResolveOptions, "cwd" | "repoConfigPath">): string {
  if (opts.repoConfigPath) return opts.repoConfigPath;
  return path.join(opts.cwd ?? process.cwd(), ".kontour", "datum.json");
}

function readJsonIfPresent(file: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new DatumError("INVALID_CONFIG", `Failed to read config "${file}": ${(err as Error).message}`);
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new DatumError("INVALID_CONFIG", `Config "${file}" is not valid JSON: ${(err as Error).message}`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge overlay onto base. Objects merge per-key recursively; arrays and
 * scalars from `overlay` REPLACE those in `base`. (A provider's `models` array,
 * for instance, is replaced wholesale by the repo file, not concatenated.)
 */
export function deepMerge(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, ov] of Object.entries(overlay)) {
    const bv = out[k];
    out[k] = isPlainObject(bv) && isPlainObject(ov) ? deepMerge(bv, ov) : ov;
  }
  return out;
}

/**
 * Load and validate the merged config. When `opts.config` is provided, file
 * discovery is skipped and that object is validated directly.
 */
export function loadConfig(opts: ResolveOptions = {}): LoadedConfig {
  if (opts.config) {
    return { config: validateConfig(opts.config), sources: [] };
  }

  const userPath = userConfigPath(opts);
  const repoPath = repoConfigPath(opts);
  const sources: string[] = [];

  const user = readJsonIfPresent(userPath);
  if (user) sources.push(userPath);
  const repo = readJsonIfPresent(repoPath);
  if (repo) sources.push(repoPath);

  const merged = deepMerge(user ?? {}, repo ?? {});
  return { config: validateConfig(merged), sources };
}
