import { createHash } from "node:crypto";
import { DatumError, type DatumErrorCode } from "../errors.js";

export function datumError(code: DatumErrorCode, message: string): DatumError {
  return new DatumError(code, message);
}

export function sourceKey(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

export function redactRemoteLocation(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}/<redacted>`;
}

export function redactUrls(message: string): string {
  return message.replace(/https?:\/\/\S+/gi, (candidate) =>
    candidate.toLowerCase().startsWith("https:")
      ? "https://<redacted>"
      : "http://<redacted>");
}

export function errorMessage(error: unknown): string {
  return redactUrls(error instanceof Error ? error.message : String(error));
}
