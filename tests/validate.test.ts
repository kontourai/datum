import { test } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, looksLikeSecretLiteral } from "../src/index.js";

// Secret-SHAPED fixtures are assembled from fragments so scanners never see a
// contiguous credential literal in source — the strings only take their
// key-like shape at runtime, which is exactly what the heuristic must catch.
const join = (...p: string[]) => p.join("");
const SK_KEY = join("sk", "-ant-api03-", "abcdefgh"); // sk-prefixed key shape
const AWS_KEY = join("AKIA", "IOSFODNN7", "EXAMPLE"); // AWS access key id shape (20 chars)
const LONG_OPAQUE = "a".repeat(45); // long opaque token
const SK_IN_ENV = join("sk", "-ant-api03-", "secretvalue123456");
const SK_IN_FIELD = join("sk", "-ant-", "longsecretvaluehere1234567890");

test("looksLikeSecretLiteral: keys flagged, env names allowed", () => {
  assert.equal(looksLikeSecretLiteral(SK_KEY), true);
  assert.equal(looksLikeSecretLiteral(AWS_KEY), true);
  assert.equal(looksLikeSecretLiteral(LONG_OPAQUE), true);
  assert.equal(looksLikeSecretLiteral("ANTHROPIC_API_KEY"), false);
  assert.equal(looksLikeSecretLiteral("ZAI_API_KEY"), false);
  assert.equal(looksLikeSecretLiteral("some words here"), false);
});

test("validate: accepts a well-formed config", () => {
  const cfg = validateConfig({
    providers: { zai: { kind: "anthropic-compatible", baseUrl: "https://api.z.ai", auth: { env: "ZAI_API_KEY" }, models: ["glm-5.2"] } },
    roles: { r: "glm-5.2@zai" },
  });
  assert.ok(cfg.providers!.zai);
});

test("validate: rejects auth key that is not 'env' (embedded secret attempt)", () => {
  assert.throws(
    () => validateConfig({ providers: { p: { kind: "anthropic-compatible", auth: { ["api" + "Key"]: "x" }, models: ["m"] } } }),
    (e: unknown) => (e as { code: string }).code === "SECRET_LITERAL",
  );
});

test("validate: rejects a key-looking literal in auth.env value", () => {
  assert.throws(
    () => validateConfig({ providers: { p: { kind: "anthropic-compatible", auth: { env: SK_IN_ENV }, models: ["m"] } } }),
    (e: unknown) => (e as { code: string }).code === "SECRET_LITERAL",
  );
});

test("validate: rejects a secret literal in ANY auth field", () => {
  assert.throws(
    () => validateConfig({ providers: { p: { kind: "anthropic-compatible", auth: { env: "OK_KEY", token: SK_IN_FIELD }, models: ["m"] } } }),
    (e: unknown) => (e as { code: string }).code === "SECRET_LITERAL",
  );
});

test("validate: rejects missing kind / models / bad baseUrl", () => {
  assert.throws(() => validateConfig({ providers: { p: { auth: { env: "K" }, models: ["m"] } } }), (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG");
  assert.throws(() => validateConfig({ providers: { p: { kind: "anthropic-compatible", auth: { env: "K" }, models: [] } } }), (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG");
  assert.throws(() => validateConfig({ providers: { p: { kind: "anthropic-compatible", baseUrl: "not a url", auth: { env: "K" }, models: ["m"] } } }), (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG");
});

test("validate: rejects unknown top-level and provider keys", () => {
  assert.throws(() => validateConfig({ bogus: 1 }), (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG");
  assert.throws(() => validateConfig({ providers: { p: { kind: "anthropic-compatible", auth: { env: "K" }, models: ["m"], extra: 1 } } }), (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG");
});

test("validate: rejects malformed role ref", () => {
  assert.throws(
    () => validateConfig({ roles: { r: "a@b@c" } }),
    (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG",
  );
});

test("validate: accepts keychain auth ref", () => {
  const cfg = validateConfig({
    providers: { p: { kind: "anthropic-compatible", auth: { keychain: { service: "svc", account: "acct" } }, models: ["m"] } },
  });
  assert.ok(cfg.providers!.p);
});

test("validate: accepts op:// auth ref", () => {
  const cfg = validateConfig({
    providers: { p: { kind: "anthropic-compatible", auth: { op: "op://Private/anthropic/credential" }, models: ["m"] } },
  });
  assert.ok(cfg.providers!.p);
});

test("validate: rejects malformed op:// ref (INVALID_CONFIG)", () => {
  assert.throws(
    () => validateConfig({ providers: { p: { kind: "anthropic-compatible", auth: { op: "op://only-two/parts" }, models: ["m"] } } }),
    (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG",
  );
});

test("validate: rejects more than one auth backend", () => {
  assert.throws(
    () => validateConfig({ providers: { p: { kind: "anthropic-compatible", auth: { env: "K", op: "op://a/b/c" }, models: ["m"] } } }),
    (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG",
  );
});

test("validate: rejects keychain with unknown sub-key", () => {
  assert.throws(
    () => validateConfig({ providers: { p: { kind: "anthropic-compatible", auth: { keychain: { service: "s", bogus: 1 } }, models: ["m"] } } }),
    (e: unknown) => (e as { code: string }).code === "INVALID_CONFIG",
  );
});

test("validate: rejects secret literal hidden in a keychain field", () => {
  const SK = ["sk", "-ant-", "longsecretvaluehere1234567890"].join("");
  assert.throws(
    () => validateConfig({ providers: { p: { kind: "anthropic-compatible", auth: { keychain: { service: SK } }, models: ["m"] } } }),
    (e: unknown) => (e as { code: string }).code === "SECRET_LITERAL",
  );
});

test("looksLikeSecretLiteral: op:// reference is not a secret", () => {
  assert.equal(looksLikeSecretLiteral("op://Private/anthropic/credential"), false);
});
