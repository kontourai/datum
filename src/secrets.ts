/**
 * Secret backends for keychain / 1Password auth refs.
 *
 * Datum stays secret-reference-only: config names WHERE a key lives, never the
 * key. This module materializes those references — but LAZILY. `resolveRef`,
 * `list`, and `sync` never call `read*`; they only ask `*Available()`, which
 * checks the platform / binary WITHOUT reading any secret. Only `resolve()`
 * (and `doctor --probe`, the opt-in live path) call `readKeychain`/`readOp`.
 *
 * The runner is an interface so tests inject a fake and never touch the real
 * macOS Keychain or 1Password CLI. The default implementation shells out with
 * the built-in node:child_process `spawnSync` implementation.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { secretBackendUnavailable, secretLookupFailed } from "./errors.js";
import type { KeychainRef } from "./types.js";

export interface SecretRunner {
  /**
   * Is the macOS Keychain usable here? True only on darwin with the `security`
   * binary present. Reads NO secret.
   */
  keychainAvailable(): boolean;
  /**
   * Is the 1Password CLI (`op`) usable here? Reads NO secret (a `--version`
   * probe at most).
   */
  opAvailable(): boolean;
  /** Materialize a Keychain generic-password value. Throws DatumError on failure. */
  readKeychain(ref: KeychainRef): string;
  /** Materialize a 1Password secret reference (op://...). Throws DatumError on failure. */
  readOp(uri: string): string;
}

/** macOS path to the `security` binary — stable across macOS installs. */
const SECURITY_BIN = "/usr/bin/security";

/**
 * Default runner: spawn-based using Node built-ins. Keychain is darwin-only; a
 * non-darwin platform yields a typed SECRET_BACKEND_UNAVAILABLE, never a crash.
 */
export const defaultSecretRunner: SecretRunner = {
  keychainAvailable(): boolean {
    return process.platform === "darwin" && existsSync(SECURITY_BIN);
  },

  opAvailable(): boolean {
    try {
      const r = spawnSync("op", ["--version"], { encoding: "utf8", stdio: "ignore", timeout: 2_000 });
      return r.status === 0;
    } catch {
      return false;
    }
  },

  readKeychain(ref: KeychainRef): string {
    if (process.platform !== "darwin") {
      throw secretBackendUnavailable(
        "keychain",
        `macOS Keychain is only available on darwin (current platform: ${process.platform}).`,
      );
    }
    if (!existsSync(SECURITY_BIN)) {
      throw secretBackendUnavailable("keychain", `"${SECURITY_BIN}" not found.`);
    }
    const args = ["find-generic-password", "-s", ref.service];
    if (ref.account) args.push("-a", ref.account);
    args.push("-w");
    const r = spawnSync(SECURITY_BIN, args, { encoding: "utf8" });
    if (r.error) {
      throw secretBackendUnavailable("keychain", `failed to run security: ${r.error.message}`);
    }
    if (r.status !== 0) {
      const where = ref.account ? `service "${ref.service}" account "${ref.account}"` : `service "${ref.service}"`;
      throw secretLookupFailed("keychain", `no Keychain item for ${where} (security exited ${r.status}).`);
    }
    const value = (r.stdout ?? "").replace(/\n$/, "");
    if (value.length === 0) {
      throw secretLookupFailed("keychain", `Keychain item for service "${ref.service}" is empty.`);
    }
    return value;
  },

  readOp(uri: string): string {
    const r = spawnSync("op", ["read", uri], { encoding: "utf8" });
    if (r.error) {
      const enoent = (r.error as NodeJS.ErrnoException).code === "ENOENT";
      throw secretBackendUnavailable(
        "op",
        enoent ? `1Password CLI "op" is not installed or not on PATH.` : `failed to run op: ${r.error.message}`,
      );
    }
    if (r.status !== 0) {
      const stderr = (r.stderr ?? "").trim();
      throw secretLookupFailed("op", `op read "${uri}" failed (exit ${r.status})${stderr ? `: ${stderr}` : ""}.`);
    }
    const value = (r.stdout ?? "").replace(/\n$/, "");
    if (value.length === 0) {
      throw secretLookupFailed("op", `op read "${uri}" returned an empty value.`);
    }
    return value;
  },
};
