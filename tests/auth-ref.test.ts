import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DatumError,
  describeAuth,
  materializeAuthRef,
  parseAuthRef,
  resolve,
  validateConfig,
  type SecretRunner,
} from "../src/index.js";
import { MULTI_AUTH } from "./helpers.js";

function runner(): SecretRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    keychainAvailable: () => {
      calls.push("keychainAvailable");
      return true;
    },
    opAvailable: () => {
      calls.push("opAvailable");
      return true;
    },
    readKeychain: (ref) => {
      calls.push(`readKeychain:${ref.service}/${ref.account ?? ""}`);
      return "keychain-value";
    },
    readOp: (ref) => {
      calls.push(`readOp:${ref}`);
      return "op-value";
    },
  };
}

function datumErrorFrom(call: () => void): DatumError {
  let caught: unknown;
  try {
    call();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof DatumError, "expected a DatumError");
  return caught;
}

test("parseAuthRef: accepts only one complete, inert backend reference", () => {
  assert.deepEqual(parseAuthRef({ env: "STATION_PROVIDER_KEY" }), { env: "STATION_PROVIDER_KEY" });
  assert.deepEqual(parseAuthRef({ keychain: { service: "station", account: "provider" } }), {
    keychain: { service: "station", account: "provider" },
  });
  assert.deepEqual(parseAuthRef({ op: "op://Private/station/provider" }), {
    op: "op://Private/station/provider",
  });
});

test("parseAuthRef: rejects unknown, zero, and multiple backend keys", () => {
  for (const [value, code] of [
    [{ unsupported: "not-a-reference" }, "SECRET_LITERAL"],
    [{}, "INVALID_CONFIG"],
    [{ env: "ONE_KEY", op: "op://Private/station/provider" }, "INVALID_CONFIG"],
  ] as const) {
    assert.throws(
      () => parseAuthRef(value),
      (error: unknown) => error instanceof DatumError && error.code === code,
    );
  }
});

test("parseAuthRef: rejects a pasted secret literal before it can become a reference", () => {
  const secretLookingValue = ["sk", "-", "not-a-real-secret-but-shaped-like-one-1234567890"].join("");
  assert.throws(
    () => parseAuthRef({ env: secretLookingValue }),
    (error: unknown) => error instanceof DatumError && error.code === "SECRET_LITERAL",
  );
});

test("materializeAuthRef: dispatches exactly one backend", () => {
  const envRunner = runner();
  assert.equal(materializeAuthRef({ env: "STATION_PROVIDER_KEY" }, { env: { STATION_PROVIDER_KEY: "env-value" }, secretRunner: envRunner }), "env-value");
  assert.deepEqual(envRunner.calls, []);

  const keychainRunner = runner();
  assert.equal(materializeAuthRef({ keychain: { service: "station", account: "provider" } }, { secretRunner: keychainRunner }), "keychain-value");
  assert.deepEqual(keychainRunner.calls, ["readKeychain:station/provider"]);

  const opRunner = runner();
  assert.equal(materializeAuthRef({ op: "op://Private/station/provider" }, { secretRunner: opRunner }), "op-value");
  assert.deepEqual(opRunner.calls, ["readOp:op://Private/station/provider"]);
});

test("materializeAuthRef: rejects invalid runtime input before any backend read", () => {
  for (const [value, code] of [
    [{ unsupported: "not-a-reference" }, "SECRET_LITERAL"],
    [{}, "INVALID_CONFIG"],
    [{ env: "ONE_KEY", op: "op://Private/station/provider" }, "INVALID_CONFIG"],
    [{ env: "not-an-env-var" }, "SECRET_LITERAL"],
  ] as const) {
    const r = runner();
    assert.throws(
      () => materializeAuthRef(value, { secretRunner: r }),
      (error: unknown) => error instanceof DatumError && error.code === code,
    );
    assert.deepEqual(r.calls, []);
  }
});

test("describeAuth: describes availability without materializing any secret", () => {
  const r = runner();
  assert.equal(describeAuth({ keychain: { service: "station" } }, {}, r).available, true);
  assert.equal(describeAuth({ op: "op://Private/station/provider" }, {}, r).available, true);
  assert.deepEqual(r.calls, ["keychainAvailable", "opAvailable"]);
});

test("materializeAuthRef: preserves typed missing and backend errors by identity", () => {
  assert.throws(
    () => materializeAuthRef({ env: "MISSING_STATION_KEY" }, { env: {} }),
    (error: unknown) => error instanceof DatumError && error.code === "MISSING_ENV",
  );

  const unavailable = new DatumError("SECRET_BACKEND_UNAVAILABLE", "test keychain unavailable");
  const unavailableRunner = runner();
  unavailableRunner.readKeychain = () => { throw unavailable; };
  assert.throws(
    () => materializeAuthRef({ keychain: { service: "station" } }, { secretRunner: unavailableRunner }),
    (error: unknown) => error === unavailable,
  );

  const failed = new DatumError("SECRET_LOOKUP_FAILED", "test op lookup failed");
  const failedRunner = runner();
  failedRunner.readOp = () => { throw failed; };
  assert.throws(
    () => materializeAuthRef({ op: "op://Private/station/provider" }, { secretRunner: failedRunner }),
    (error: unknown) => error === failed,
  );
});

test("provider config keeps its established auth diagnostic wording", () => {
  const error = datumErrorFrom(
    () => validateConfig({
      providers: { p: { kind: "anthropic-compatible", auth: null, models: ["m"] } },
    }),
  );
  assert.equal(error.code, "INVALID_CONFIG");
  assert.equal(error.message, 'provider "p": "auth" must be an object ({ env } | { keychain } | { op }).');
});

test("resolve: preserves provider-qualified missing-env diagnostics and runner error identity", () => {
  const missing = datumErrorFrom(
    () => resolve("glm-5.2@zai", { config: MULTI_AUTH, env: { TEST_ZAI_KEY: undefined } }),
  );
  assert.equal(missing.code, "MISSING_ENV");
  assert.equal(missing.message, 'Environment variable "TEST_ZAI_KEY" (API key for provider "zai") is not set.');

  const lookup = new DatumError("SECRET_LOOKUP_FAILED", "test keychain lookup failed");
  const r = runner();
  r.readKeychain = () => { throw lookup; };
  assert.throws(
    () => resolve("kc-role", { config: MULTI_AUTH, secretRunner: r }),
    (error: unknown) => error === lookup,
  );
});
