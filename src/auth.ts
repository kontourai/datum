/**
 * Auth-ref helpers shared by the resolver, doctor, and generators.
 *
 * These are pure, secret-free operations over a provider's `auth` reference:
 * which backend it names, a human-facing reference string, and — given a
 * SecretRunner — whether the backend is currently available. None of these read
 * the secret; availability is a platform/binary check only.
 */

import type { AuthKind, AuthRef, AuthStatus, KeychainRef } from "./types.js";
import type { SecretRunner } from "./secrets.js";

/** Which backend an auth ref names. */
export function authKind(auth: AuthRef): AuthKind {
  if ("env" in auth) return "env";
  if ("keychain" in auth) return "keychain";
  return "op";
}

/** Human/tooling-facing reference string for an auth ref (never the secret). */
export function authRefString(auth: AuthRef): string {
  if ("env" in auth) return auth.env;
  if ("keychain" in auth) {
    const k: KeychainRef = auth.keychain;
    return k.account ? `${k.service}/${k.account}` : k.service;
  }
  return auth.op;
}

/**
 * Build a non-secret AuthStatus for an auth ref. `available` is computed WITHOUT
 * reading the secret: env -> var set in `env`; keychain/op -> backing tool present.
 */
export function describeAuth(
  auth: AuthRef,
  env: Record<string, string | undefined>,
  runner: SecretRunner,
): AuthStatus {
  const kind = authKind(auth);
  const ref = authRefString(auth);
  if (kind === "env") {
    const envVar = (auth as { env: string }).env;
    const val = env[envVar];
    return { kind, ref, envVar, available: typeof val === "string" && val.length > 0 };
  }
  if (kind === "keychain") {
    return { kind, ref, available: runner.keychainAvailable(), tool: "security" };
  }
  return { kind, ref, available: runner.opAvailable(), tool: "op" };
}
