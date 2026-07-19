/**
 * Hand-rolled structural validation for a datum config.
 *
 * Why hand-rolled (no ajv) in the runtime path: the config surface is tiny and
 * closed, so a direct validator is smaller, faster to load, and has less
 * supply-chain surface than pulling a JSON-schema engine into a CLI that
 * resolves config. `datum.schema.json`
 * remains the normative, human/editor-facing schema; this function mirrors it.
 *
 * It also enforces the SECURITY invariant: auth is by reference only. A literal-
 * secret-looking value in an auth field is rejected (SECRET_LITERAL). The three
 * permitted auth shapes are { env }, { keychain } and { op } — all references,
 * never a key.
 */

import { DatumError } from "./errors.js";
import path from "node:path";
import type { CapabilityCatalogConfig, DatumConfig, ProviderConfig } from "./types.js";

/** Env var NAME shape: uppercase identifier. Real secrets do not look like this. */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
/** Model ref shape: "model" or "model@provider", no whitespace/extra "@". */
const MODEL_REF_RE = /^[^@\s]+(@[^@\s]+)?$/;
/** 1Password secret reference: op://<vault>/<item>/<field>[/...]. */
const OP_URI_RE = /^op:\/\/[^/\s]+\/[^/\s]+\/[^\s]+$/;

/**
 * Heuristic: does a string look like an embedded API key rather than a reference
 * (env var name, keychain identifier, op:// URI)? Long, no spaces, and either not
 * a plain uppercase identifier or carrying a known key prefix. Env var names and
 * op:// URIs pass; pasted keys (sk-ant-...) fail.
 */
export function looksLikeSecretLiteral(value: string): boolean {
  const v = value.trim();
  if (/\s/.test(v)) return false; // has spaces -> not a bare token
  if (/^op:\/\//i.test(v)) return false; // 1Password reference URI -> not a secret
  if (/^(sk|pk|rk|ghp|gho|xox)[-_]/i.test(v)) return true; // separator-delimited key prefixes
  if (/^AKIA[0-9A-Z]{16}$/.test(v)) return true; // AWS access key id (collides with env-name shape)
  if (v.length >= 40) return true; // long opaque token
  // Medium-length token that is NOT a clean env var name (mixed case / hyphens).
  if (v.length >= 20 && !ENV_NAME_RE.test(v)) return true;
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function invalid(msg: string): never {
  throw new DatumError("INVALID_CONFIG", msg);
}

function secretLiteral(msg: string): never {
  throw new DatumError("SECRET_LITERAL", msg);
}

/** Recursively scan an auth object's string values for an embedded secret. */
function scanForSecretLiterals(providerId: string, obj: Record<string, unknown>, keyPath: string): void {
  for (const [k, val] of Object.entries(obj)) {
    const path = keyPath ? `${keyPath}.${k}` : k;
    if (typeof val === "string" && looksLikeSecretLiteral(val)) {
      secretLiteral(
        `provider "${providerId}": auth field "${path}" looks like a literal secret. ` +
          `Auth is by reference only — use { "env": "VAR" }, { "keychain": { "service": "..." } } ` +
          `or { "op": "op://vault/item/field" } and keep the key out of config.`,
      );
    } else if (isRecord(val)) {
      scanForSecretLiterals(providerId, val, path);
    }
  }
}

function validateKeychain(providerId: string, keychain: unknown): void {
  if (!isRecord(keychain)) {
    invalid(`provider "${providerId}": auth.keychain must be an object { service, account? }.`);
  }
  const kc = keychain as Record<string, unknown>;
  for (const k of Object.keys(kc)) {
    if (k !== "service" && k !== "account") {
      invalid(`provider "${providerId}": auth.keychain: unknown key "${k}" (allowed: service, account).`);
    }
  }
  if (typeof kc.service !== "string" || kc.service.length === 0) {
    invalid(`provider "${providerId}": auth.keychain.service must be a non-empty string.`);
  }
  if (kc.account !== undefined && (typeof kc.account !== "string" || kc.account.length === 0)) {
    invalid(`provider "${providerId}": auth.keychain.account must be a non-empty string when present.`);
  }
}

function validateAuth(providerId: string, auth: unknown): void {
  if (!isRecord(auth)) {
    invalid(`provider "${providerId}": "auth" must be an object ({ env } | { keychain } | { op }).`);
  }
  const a = auth as Record<string, unknown>;

  // Scan EVERY auth field value for an embedded secret first, regardless of key.
  scanForSecretLiterals(providerId, a, "");

  const keys = Object.keys(a);
  // Exactly one backend key; it must be one of env / keychain / op.
  const backends = keys.filter((k) => k === "env" || k === "keychain" || k === "op");
  const unknownKeys = keys.filter((k) => k !== "env" && k !== "keychain" && k !== "op");
  if (unknownKeys.length > 0) {
    secretLiteral(
      `provider "${providerId}": auth key "${unknownKeys[0]}" is not allowed. ` +
        `Auth is by reference only: use { "env": "VAR" }, { "keychain": {...} } or { "op": "op://..." }.`,
    );
  }
  if (backends.length !== 1) {
    invalid(
      `provider "${providerId}": auth must name exactly one backend ` +
        `(env | keychain | op); found ${backends.length ? backends.join(", ") : "none"}.`,
    );
  }

  if ("env" in a) {
    const env = a.env;
    if (typeof env !== "string" || env.length === 0) {
      invalid(`provider "${providerId}": auth.env must be a non-empty env var name.`);
    }
    if (!ENV_NAME_RE.test(env as string)) {
      secretLiteral(
        `provider "${providerId}": auth.env "${env}" is not a valid env var name ` +
          `(expected /^[A-Z][A-Z0-9_]*$/). If you pasted a key here, remove it — use a var name.`,
      );
    }
  } else if ("keychain" in a) {
    validateKeychain(providerId, a.keychain);
  } else {
    const op = a.op;
    if (typeof op !== "string" || op.length === 0) {
      invalid(`provider "${providerId}": auth.op must be a non-empty "op://vault/item/field" reference.`);
    }
    if (!OP_URI_RE.test(op as string)) {
      invalid(
        `provider "${providerId}": auth.op "${op}" is not a valid 1Password reference ` +
          `(expected "op://vault/item/field").`,
      );
    }
  }
}

function validateProvider(providerId: string, p: unknown): void {
  if (!isRecord(p)) invalid(`provider "${providerId}" must be an object.`);
  const prov = p as Record<string, unknown>;

  const allowed = new Set(["kind", "baseUrl", "auth", "models"]);
  for (const k of Object.keys(prov)) {
    if (!allowed.has(k)) invalid(`provider "${providerId}": unknown key "${k}".`);
  }

  if (typeof prov.kind !== "string" || prov.kind.length === 0) {
    invalid(`provider "${providerId}": "kind" must be a non-empty string.`);
  }
  if (prov.baseUrl !== undefined) {
    if (typeof prov.baseUrl !== "string") invalid(`provider "${providerId}": "baseUrl" must be a string.`);
    try {
      // eslint-disable-next-line no-new
      new URL(prov.baseUrl as string);
    } catch {
      invalid(`provider "${providerId}": "baseUrl" is not a valid URL: "${prov.baseUrl}".`);
    }
  }
  validateAuth(providerId, prov.auth);
  if (
    !Array.isArray(prov.models) ||
    prov.models.length === 0 ||
    !prov.models.every((m) => typeof m === "string" && m.length > 0)
  ) {
    invalid(`provider "${providerId}": "models" must be a non-empty array of strings.`);
  }
}

function validateCatalogRemoteUrl(value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    invalid('config: capabilityCatalog.remoteUrl must be a non-empty URL string.');
  }
  if (!/^[Hh][Tt][Tt][Pp][Ss]?:\/\/[^/?#@\s]+(?:\/[^?#\s]*)?$/.test(value)) {
    invalid(
      "config: capabilityCatalog.remoteUrl must be a canonical credential-free http(s) URL " +
        "without whitespace, query parameters, or a fragment.",
    );
  }
  let remoteUrl: URL;
  try {
    remoteUrl = new URL(value);
  } catch {
    invalid("config: capabilityCatalog.remoteUrl is not a valid URL.");
  }
  if (remoteUrl.protocol !== "https:" && remoteUrl.protocol !== "http:") {
    invalid("config: capabilityCatalog.remoteUrl must use https (or loopback http for local services).");
  }
  if (remoteUrl.username || remoteUrl.password || remoteUrl.search || remoteUrl.hash) {
    invalid(
      "config: capabilityCatalog.remoteUrl must not embed userinfo, query parameters, or a fragment; " +
        "configure a credential-free snapshot endpoint.",
    );
  }
}

function validateCatalogLocalPath(value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    invalid('config: capabilityCatalog.localPath must be a non-empty path string.');
  }
  const segments = value.split(/[\\/]+/);
  if (path.isAbsolute(value) || segments.includes("..")) {
    invalid('config: capabilityCatalog.localPath must be a repository-relative path without ".." traversal.');
  }
}

function validateCatalogMaxAge(value: unknown): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
    invalid('config: capabilityCatalog.maxAgeSeconds must be a positive number when present.');
  }
}

function validateCapabilityCatalog(value: unknown): CapabilityCatalogConfig {
  if (!isRecord(value)) invalid('config: "capabilityCatalog" must be an object.');
  const catalog = value as Record<string, unknown>;
  const allowed = new Set(["remoteUrl", "localPath", "maxAgeSeconds"]);
  for (const key of Object.keys(catalog)) {
    if (!allowed.has(key)) invalid(`config: capabilityCatalog: unknown key "${key}".`);
  }
  const hasRemote = catalog.remoteUrl !== undefined;
  const hasLocal = catalog.localPath !== undefined;
  if (hasRemote === hasLocal) {
    invalid('config: capabilityCatalog must contain exactly one of "remoteUrl" or "localPath".');
  }
  if (hasRemote) validateCatalogRemoteUrl(catalog.remoteUrl);
  if (hasLocal) validateCatalogLocalPath(catalog.localPath);
  validateCatalogMaxAge(catalog.maxAgeSeconds);
  return catalog as CapabilityCatalogConfig;
}

/**
 * Validate a merged config. Throws DatumError (INVALID_CONFIG / SECRET_LITERAL)
 * on the first problem. Returns the config narrowed to DatumConfig on success.
 */
export function validateConfig(config: unknown): DatumConfig {
  if (!isRecord(config)) invalid("config root must be an object.");
  const c = config as Record<string, unknown>;

  const allowed = new Set(["$schema", "providers", "roles", "capabilityCatalog"]);
  for (const k of Object.keys(c)) {
    if (!allowed.has(k)) invalid(`config: unknown top-level key "${k}".`);
  }

  if (c.providers !== undefined) {
    if (!isRecord(c.providers)) invalid('config: "providers" must be an object.');
    for (const [id, p] of Object.entries(c.providers)) validateProvider(id, p);
  }

  if (c.roles !== undefined) {
    if (!isRecord(c.roles)) invalid('config: "roles" must be an object.');
    for (const [name, ref] of Object.entries(c.roles)) {
      if (typeof ref !== "string" || !MODEL_REF_RE.test(ref)) {
        invalid(`role "${name}": target "${String(ref)}" must be "model" or "model@provider".`);
      }
    }
  }

  const capabilityCatalog = c.capabilityCatalog === undefined ? undefined : validateCapabilityCatalog(c.capabilityCatalog);

  return {
    providers: c.providers as Record<string, ProviderConfig> | undefined,
    roles: c.roles as Record<string, string> | undefined,
    ...(capabilityCatalog === undefined ? {} : { capabilityCatalog }),
  };
}
