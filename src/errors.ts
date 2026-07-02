/**
 * Typed errors for datum. Every failure a caller can reasonably branch on
 * carries a stable `code`; messages name the offending ref/provider/env var so
 * the problem is actionable without a stack trace.
 */

export type DatumErrorCode =
  | "UNKNOWN_ROLE"
  | "UNKNOWN_PROVIDER"
  | "UNKNOWN_MODEL"
  | "AMBIGUOUS_MODEL"
  | "MISSING_ENV"
  | "INVALID_CONFIG"
  | "SECRET_LITERAL";

export class DatumError extends Error {
  readonly code: DatumErrorCode;
  constructor(code: DatumErrorCode, message: string) {
    super(message);
    this.name = "DatumError";
    this.code = code;
  }
}

export const unknownRole = (ref: string, known: string[]): DatumError =>
  new DatumError(
    "UNKNOWN_ROLE",
    `Unknown role "${ref}". Known roles: ${known.length ? known.join(", ") : "(none)"}.`,
  );

export const unknownProvider = (provider: string, ref: string, known: string[]): DatumError =>
  new DatumError(
    "UNKNOWN_PROVIDER",
    `Unknown provider "${provider}" in ref "${ref}". Known providers: ${known.length ? known.join(", ") : "(none)"}.`,
  );

export const unknownModel = (model: string, known: string[]): DatumError =>
  new DatumError(
    "UNKNOWN_MODEL",
    `Model "${model}" is not offered by any configured provider. Known models: ${known.length ? known.join(", ") : "(none)"}.`,
  );

export const ambiguousModel = (model: string, providers: string[]): DatumError =>
  new DatumError(
    "AMBIGUOUS_MODEL",
    `Model "${model}" is ambiguous across providers: ${providers.join(", ")}. Use "${model}@<provider>".`,
  );

export const missingEnv = (envVar: string, provider: string): DatumError =>
  new DatumError(
    "MISSING_ENV",
    `Environment variable "${envVar}" (API key for provider "${provider}") is not set.`,
  );
