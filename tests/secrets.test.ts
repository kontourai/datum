import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, resolveRef, describeAuth, DatumError } from "../src/index.js";
import { MULTI_AUTH, fakeRunner } from "./helpers.js";

const base = { config: MULTI_AUTH };

test("resolveRef: keychain/op describe auth WITHOUT reading the secret", () => {
  const runner = fakeRunner({ keychain: true, op: true });
  const kc = resolveRef("kc-role", { ...base, secretRunner: runner });
  assert.equal(kc.auth.kind, "keychain");
  assert.equal(kc.auth.ref, "datum-anthropic/work");
  assert.equal(kc.auth.available, true);
  assert.equal(kc.auth.tool, "security");
  assert.equal(kc.apiKeyEnv, undefined); // no env var for keychain
  assert.equal(kc.apiKeySet, true); // mirrors availability

  const op = resolveRef("op-role", { ...base, secretRunner: runner });
  assert.equal(op.auth.kind, "op");
  assert.equal(op.auth.ref, "op://Private/anthropic/credential");
  assert.equal(op.auth.available, true);

  // Availability probes only — no read* was called.
  assert.ok(!runner.calls.some((c) => c.startsWith("readKeychain")));
  assert.ok(!runner.calls.some((c) => c.startsWith("readOp")));
});

test("resolveRef: reports backend UNAVAILABLE without throwing", () => {
  const runner = fakeRunner({ keychain: false, op: false });
  const kc = resolveRef("kc-role", { ...base, secretRunner: runner });
  assert.equal(kc.auth.available, false);
  assert.equal(kc.apiKeySet, false);
});

test("resolve: keychain materializes via runner.readKeychain", () => {
  const runner = fakeRunner({ keychainValue: "kc-live-key" });
  const r = resolve("kc-role", { ...base, secretRunner: runner });
  assert.equal(r.apiKey, "kc-live-key");
  assert.equal(r.provider, "kc");
  assert.equal(r.model, "claude-sonnet-5");
  assert.ok(runner.calls.includes("readKeychain:datum-anthropic/work"));
});

test("resolve: op materializes via runner.readOp", () => {
  const runner = fakeRunner({ opValue: "op-live-key" });
  const r = resolve("op-role", { ...base, secretRunner: runner });
  assert.equal(r.apiKey, "op-live-key");
  assert.ok(runner.calls.includes("readOp:op://Private/anthropic/credential"));
});

test("resolve: keychain lookup failure surfaces the typed DatumError", () => {
  const runner = fakeRunner({
    keychainThrows: () => {
      throw new DatumError("SECRET_LOOKUP_FAILED", "no Keychain item");
    },
  });
  assert.throws(
    () => resolve("kc-role", { ...base, secretRunner: runner }),
    (e: unknown) => (e as { code: string }).code === "SECRET_LOOKUP_FAILED",
  );
});

test("resolve: op backend unavailable surfaces typed DatumError", () => {
  const runner = fakeRunner({
    opThrows: () => {
      throw new DatumError("SECRET_BACKEND_UNAVAILABLE", "op not installed");
    },
  });
  assert.throws(
    () => resolve("op-role", { ...base, secretRunner: runner }),
    (e: unknown) => (e as { code: string }).code === "SECRET_BACKEND_UNAVAILABLE",
  );
});

test("describeAuth: env kind reflects env var set/unset, no runner calls", () => {
  const runner = fakeRunner();
  const set = describeAuth({ env: "SOME_KEY" }, { SOME_KEY: "v" }, runner);
  assert.equal(set.kind, "env");
  assert.equal(set.available, true);
  const unset = describeAuth({ env: "SOME_KEY" }, {}, runner);
  assert.equal(unset.available, false);
  assert.equal(runner.calls.length, 0);
});

test("resolve: env-kind auth still reads from env (unchanged path)", () => {
  const r = resolve("glm-5.2@zai", { ...base, env: { TEST_ZAI_KEY: "envkey" }, secretRunner: fakeRunner() });
  assert.equal(r.apiKey, "envkey");
});
