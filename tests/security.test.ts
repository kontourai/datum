import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceHttpsPolicy, safeFetch } from "../src/index.js";

test("enforceHttpsPolicy: https:// is always allowed, incl. non-loopback hosts", () => {
  for (const url of ["https://api.anthropic.com/v1/messages", "https://example.com", "https://127.0.0.1:9999"]) {
    const result = enforceHttpsPolicy(url);
    assert.equal(result.blocked, false, url);
    assert.equal(result.warning, undefined, url);
  }
});

test("enforceHttpsPolicy: http:// to loopback hosts is allowed silently (full 127.0.0.0/8, ::1, with/without port)", () => {
  const loopbackUrls = [
    "http://localhost",
    "http://localhost:8080",
    "http://127.0.0.1",
    "http://127.0.0.1:11434",
    "http://127.5.6.7",
    "http://127.5.6.7:1234",
    "http://[::1]",
    "http://[::1]:8080",
    // IPv4-mapped IPv6 loopback (127.0.0.0/8 mapped into ::ffff:...). The URL
    // parser normalizes these to `[::ffff:7f..:..]`; they must NOT be blocked.
    "http://[::ffff:127.0.0.1]",
    "http://[::ffff:127.0.0.1]:11434",
    "http://[::ffff:127.5.6.7]",
    "http://[0:0:0:0:0:ffff:127.0.0.1]",
  ];
  for (const url of loopbackUrls) {
    const result = enforceHttpsPolicy(url);
    assert.equal(result.blocked, false, url);
    assert.equal(result.warning, undefined, url);
  }
});

test("enforceHttpsPolicy: IPv4-mapped IPv6 for a NON-loopback address is still blocked (::ffff:0.0.0.0)", () => {
  // Guards the ::ffff loopback exemption from being over-broad: 0.0.0.0 mapped
  // (`[::ffff:0:0]`) is not loopback and must stay blocked.
  const result = enforceHttpsPolicy("http://[::ffff:0.0.0.0]");
  assert.equal(result.blocked, true);
});

test("enforceHttpsPolicy: http:// to a non-loopback host is blocked with an actionable detail", () => {
  const url = "http://example.com";
  const result = enforceHttpsPolicy(url);
  assert.equal(result.blocked, true);
  assert.ok(result.detail);
  assert.ok(result.detail!.includes(url));
  assert.ok(result.detail!.includes("https"));
  assert.ok(result.detail!.includes("--allow-insecure"));
});

test("enforceHttpsPolicy: allowInsecure lets a non-loopback http:// request proceed but warns", () => {
  const url = "http://example.com";
  const result = enforceHttpsPolicy(url, { allowInsecure: true });
  assert.equal(result.blocked, false);
  assert.ok(result.warning);
  assert.ok(result.warning!.includes(url));
});

test("enforceHttpsPolicy: edge cases — uppercase scheme, trailing dot, malformed url", () => {
  const uppercase = enforceHttpsPolicy("HTTP://EXAMPLE.com");
  assert.equal(uppercase.blocked, true);
  assert.ok(uppercase.detail);

  const trailingDot = enforceHttpsPolicy("http://localhost.");
  assert.equal(trailingDot.blocked, false);
  assert.equal(trailingDot.warning, undefined);

  const malformed = enforceHttpsPolicy("not a url");
  assert.equal(malformed.blocked, false);
});

test("enforceHttpsPolicy: 0.0.0.0 is NOT exempted as loopback (negative-space test for the 127.0.0.0/8 regex)", () => {
  const result = enforceHttpsPolicy("http://0.0.0.0");
  assert.equal(result.blocked, true);
});

// --- safeFetch: per-hop redirect policy re-check (datum#9) ----------------

interface Step {
  status: number;
  location?: string;
  ok?: boolean;
}

/**
 * A fetch double scripted as an ordered list of responses. Records every URL
 * it is asked to fetch (i.e. every URL the key-bearing request actually
 * reached) in `seen`, so tests can assert an insecure hop was NEVER contacted.
 */
function scriptedFetch(steps: Step[]) {
  const seen: string[] = [];
  let i = 0;
  const impl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; redirect?: "manual" },
  ) => {
    seen.push(url);
    // safeFetch must always request manual redirect handling.
    assert.equal(init.redirect, "manual", "safeFetch must pass redirect: 'manual'");
    const step = steps[Math.min(i, steps.length - 1)];
    i++;
    return {
      ok: step.ok ?? (step.status >= 200 && step.status < 300),
      status: step.status,
      headers: {
        get: (name: string) => (name.toLowerCase() === "location" ? (step.location ?? null) : null),
      },
      text: async () => "{}",
    };
  };
  return { impl, seen };
}

const GET_INIT = { method: "GET", headers: { authorization: "Bearer k" } };

test("safeFetch: a terminal (non-3xx) response is returned as-is, one fetch call", async () => {
  const { impl, seen } = scriptedFetch([{ status: 200 }]);
  const out = await safeFetch("https://api.example/v1", GET_INIT, impl);
  assert.equal(out.blocked, false);
  assert.equal(out.response?.status, 200);
  assert.equal(out.warning, undefined);
  assert.deepEqual(seen, ["https://api.example/v1"]);
});

test("safeFetch: follows an https->https redirect and re-issues the key-bearing request to the new host", async () => {
  const { impl, seen } = scriptedFetch([
    { status: 302, location: "https://new.example/v1" },
    { status: 200 },
  ]);
  const out = await safeFetch("https://old.example/v1", GET_INIT, impl);
  assert.equal(out.blocked, false);
  assert.equal(out.response?.status, 200);
  assert.deepEqual(seen, ["https://old.example/v1", "https://new.example/v1"]);
});

test("safeFetch: redirect cleanup cannot block progress or leak a rejection", async () => {
  for (const cancel of [
    () => new Promise<void>(() => {}),
    () => Promise.reject(new Error("cleanup rejected")),
  ]) {
    let calls = 0;
    const output = await safeFetch(
      "https://old.example/v1",
      GET_INIT as typeof GET_INIT & { redirect?: "manual" },
      async (_url, _init: typeof GET_INIT & { redirect?: "manual" }) => {
        calls += 1;
        if (calls === 1) {
          return {
            status: 302,
            headers: { get: () => "https://new.example/v1" },
            body: { cancel },
          };
        }
        return { status: 200 };
      },
    );
    assert.equal(output.response?.status, 200);
    assert.equal(calls, 2);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test("safeFetch: BLOCKS an https->http non-loopback redirect BEFORE re-issuing — key never reaches the insecure host", async () => {
  const { impl, seen } = scriptedFetch([{ status: 302, location: "http://evil.example/steal" }]);
  const out = await safeFetch("https://api.example/v1", GET_INIT, impl);
  assert.equal(out.blocked, true);
  assert.ok(out.detail);
  assert.ok(out.detail!.includes("http://evil.example/steal"));
  assert.ok(out.detail!.toLowerCase().includes("redirect"));
  // Only the original https host was ever contacted; the insecure hop was not.
  assert.deepEqual(seen, ["https://api.example/v1"]);
  assert.ok(!seen.some((u) => u.startsWith("http://evil")));
});

test("safeFetch: allowInsecure lets an https->http non-loopback redirect proceed, with a single warning", async () => {
  const { impl, seen } = scriptedFetch([
    { status: 302, location: "http://insecure.example/v1" },
    { status: 200 },
  ]);
  const out = await safeFetch("https://api.example/v1", GET_INIT, impl, { allowInsecure: true });
  assert.equal(out.blocked, false);
  assert.equal(out.response?.status, 200);
  assert.ok(out.warning);
  assert.ok(out.warning!.includes("http://insecure.example/v1"));
  assert.deepEqual(seen, ["https://api.example/v1", "http://insecure.example/v1"]);
});

test("safeFetch: an https->http LOOPBACK redirect is followed silently (no warning)", async () => {
  const { impl, seen } = scriptedFetch([
    { status: 307, location: "http://127.0.0.1:11434/v1" },
    { status: 200 },
  ]);
  const out = await safeFetch("https://gateway.example/v1", GET_INIT, impl);
  assert.equal(out.blocked, false);
  assert.equal(out.warning, undefined);
  assert.deepEqual(seen, ["https://gateway.example/v1", "http://127.0.0.1:11434/v1"]);
});

test("safeFetch: a 3xx with no Location header is treated as a terminal response", async () => {
  const { impl, seen } = scriptedFetch([{ status: 302 }]);
  const out = await safeFetch("https://api.example/v1", GET_INIT, impl);
  assert.equal(out.blocked, false);
  assert.equal(out.response?.status, 302);
  assert.deepEqual(seen, ["https://api.example/v1"]);
});

test("safeFetch: too many redirects throws (callers map this to 'unreachable')", async () => {
  // A self-referential redirect that never terminates.
  const { impl } = scriptedFetch([{ status: 302, location: "https://loop.example/v1" }]);
  await assert.rejects(
    () => safeFetch("https://loop.example/v1", GET_INIT, impl, { maxRedirects: 3 }),
    /too many redirects/,
  );
});

test("safeFetch: a relative Location is resolved against the current URL", async () => {
  const { impl, seen } = scriptedFetch([{ status: 308, location: "/v2/models" }, { status: 200 }]);
  const out = await safeFetch("https://api.example/v1/models", GET_INIT, impl);
  assert.equal(out.blocked, false);
  assert.deepEqual(seen, ["https://api.example/v1/models", "https://api.example/v2/models"]);
});
