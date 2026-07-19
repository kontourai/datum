import assert from "node:assert/strict";
import { test } from "node:test";
import { compileCatalog, serializeCatalog } from "@kontourai/bearing";
import {
  DatumError,
  refreshCapabilityCatalog,
} from "../src/index.js";
import { tempTree } from "./helpers.js";

const REMOTE_URL = "https://93.184.216.34/snapshot.json";

async function rejectsUnavailable(work: () => Promise<unknown>): Promise<void> {
  await assert.rejects(
    work,
    (error: unknown) =>
      error instanceof DatumError &&
      error.code === "CAPABILITY_CATALOG_UNAVAILABLE",
  );
}

async function rejectsWithCode(work: () => Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    work,
    (error: unknown) => error instanceof DatumError && error.code === code,
  );
}

test("injected transport deadline covers a stalled response body", async () => {
  const t = tempTree();
  let aborted = false;
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    const startedAt = Date.now();
    await rejectsUnavailable(() => refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: `${t.dir}/cache`,
      requestTimeoutMs: 20,
      transport: async (_url, init) => {
        init.signal?.addEventListener("abort", () => { aborted = true; });
        return new Response(new ReadableStream({
          pull() {
            // Headers arrive, but the body never produces a chunk.
          },
        }), { status: 200 });
      },
    }));
    assert.equal(aborted, true);
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    t.cleanup();
  }
});

test("a response arriving after the injected transport deadline is canceled", async () => {
  const t = tempTree();
  let aborted = false;
  let canceled = false;
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    await rejectsUnavailable(() => refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: `${t.dir}/cache`,
      requestTimeoutMs: 10,
      transport: async (_url, init) => {
        init.signal?.addEventListener("abort", () => { aborted = true; });
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(new ReadableStream({
          cancel() {
            canceled = true;
          },
        }), { status: 200 });
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(aborted, true);
    assert.equal(canceled, true);
  } finally {
    t.cleanup();
  }
});

test("redirect-body cleanup remains inside the injected transport deadline", async () => {
  const t = tempTree();
  let aborted = false;
  let cancellationStarted = false;
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    await rejectsUnavailable(() => refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: `${t.dir}/cache`,
      requestTimeoutMs: 20,
      transport: async (_url, init) => {
        init.signal?.addEventListener("abort", () => { aborted = true; });
        return new Response(new ReadableStream({
          cancel() {
            cancellationStarted = true;
            return new Promise<void>(() => {});
          },
        }), {
          status: 302,
          headers: { location: "/next.json" },
        });
      },
    }));
    assert.equal(cancellationStarted, true);
    assert.equal(aborted, true);
  } finally {
    t.cleanup();
  }
});

test("304 body cleanup remains inside the injected transport deadline", async () => {
  const t = tempTree();
  const snapshot = compileCatalog([], { asOf: "2026-07-18T00:00:00.000Z" });
  let call = 0;
  let aborted = false;
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    const options = {
      cwd: t.cwd,
      home: t.home,
      cacheRoot: `${t.dir}/cache`,
      requestTimeoutMs: 20,
      transport: async (_url: string, init: { signal?: AbortSignal }) => {
        call += 1;
        if (call === 1) return new Response(serializeCatalog(snapshot), { status: 200 });
        init.signal?.addEventListener("abort", () => { aborted = true; });
        return {
          status: 304,
          headers: { get: () => null },
          body: new ReadableStream({
            cancel() {
              return new Promise<void>(() => {});
            },
          }),
          text: async () => "",
        };
      },
    };
    await refreshCapabilityCatalog(options);
    const fallback = await refreshCapabilityCatalog(options);
    assert.equal(fallback.metadata.fallback, true);
    assert.equal(fallback.metadata.diagnostics[0]?.code, "CAPABILITY_CATALOG_UNAVAILABLE");
    assert.equal(aborted, true);
  } finally {
    t.cleanup();
  }
});

test("oversized advertised bodies keep their typed failure when cancellation stalls", async () => {
  const t = tempTree();
  let aborted = false;
  let cancellationStarted = false;
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    await rejectsWithCode(() => refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: `${t.dir}/cache`,
      maxResponseBytes: 1,
      requestTimeoutMs: 100,
      transport: async (_url, init) => {
        init.signal?.addEventListener("abort", () => { aborted = true; });
        return new Response(new ReadableStream({
          cancel() {
            cancellationStarted = true;
            return new Promise<void>(() => {});
          },
        }), {
          status: 200,
          headers: { "content-length": "2" },
        });
      },
    }), "CAPABILITY_CATALOG_RESPONSE_TOO_LARGE");
    assert.equal(aborted, true);
    assert.equal(cancellationStarted, true);
  } finally {
    t.cleanup();
  }
});

test("injected transport still activates a complete body before its deadline", async () => {
  const t = tempTree();
  const snapshot = compileCatalog([], { asOf: "2026-07-18T00:00:00.000Z" });
  try {
    t.writeRepo({ capabilityCatalog: { remoteUrl: REMOTE_URL } });
    const result = await refreshCapabilityCatalog({
      cwd: t.cwd,
      home: t.home,
      cacheRoot: `${t.dir}/cache`,
      now: () => new Date("2026-07-18T00:01:00.000Z"),
      requestTimeoutMs: 100,
      transport: async () => new Response(serializeCatalog(snapshot), { status: 200 }),
    });
    assert.equal(result.catalog.digest, snapshot.digest);
  } finally {
    t.cleanup();
  }
});
