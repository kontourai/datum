import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import type { DatumConfig, SecretRunner, KeychainRef } from "../src/index.js";

/** A canonical two-provider / two-role config used across tests. */
export const SAMPLE: DatumConfig = {
  providers: {
    zai: {
      kind: "anthropic-compatible",
      baseUrl: "https://api.z.ai/api/anthropic",
      auth: { env: "TEST_ZAI_KEY" },
      models: ["glm-5.2", "glm-4.6"],
    },
    anthropic: {
      kind: "anthropic-compatible",
      auth: { env: "TEST_ANTHROPIC_KEY" },
      models: ["claude-sonnet-5", "claude-haiku-4-5"],
    },
  },
  roles: {
    "extraction-default": "glm-5.2@zai",
    worker: "claude-sonnet-5@anthropic",
  },
};

export interface TempTree {
  dir: string;
  home: string;
  cwd: string;
  writeUser(cfg: unknown): void;
  writeRepo(cfg: unknown): void;
  cleanup(): void;
}

/** Build a temp home + repo dir pair for loadConfig discovery tests. */
export function tempTree(): TempTree {
  const dir = mkdtempSync(path.join(os.tmpdir(), "datum-test-"));
  const home = path.join(dir, "home");
  const cwd = path.join(dir, "repo");
  mkdirSync(path.join(home, ".config", "kontour"), { recursive: true });
  mkdirSync(path.join(cwd, ".datum"), { recursive: true });
  return {
    dir,
    home,
    cwd,
    writeUser(cfg: unknown) {
      writeFileSync(path.join(home, ".config", "kontour", "datum.json"), JSON.stringify(cfg));
    },
    writeRepo(cfg: unknown) {
      writeFileSync(path.join(cwd, ".datum", "config.json"), JSON.stringify(cfg));
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}


/** A config exercising all three auth backends (env / keychain / op). */
export const MULTI_AUTH: DatumConfig = {
  providers: {
    zai: {
      kind: "anthropic-compatible",
      baseUrl: "https://api.z.ai/api/anthropic",
      auth: { env: "TEST_ZAI_KEY" },
      models: ["glm-5.2"],
    },
    kc: {
      kind: "anthropic-compatible",
      auth: { keychain: { service: "datum-anthropic", account: "work" } },
      models: ["claude-sonnet-5"],
    },
    onepw: {
      kind: "anthropic-compatible",
      auth: { op: "op://Private/anthropic/credential" },
      models: ["claude-haiku-4-5"],
    },
  },
  roles: {
    "kc-role": "claude-sonnet-5@kc",
    "op-role": "claude-haiku-4-5@onepw",
  },
};

export interface FakeRunnerOptions {
  keychain?: boolean;
  op?: boolean;
  keychainValue?: string;
  opValue?: string;
  keychainThrows?: () => never;
  opThrows?: () => never;
}

/** A SecretRunner that records calls and returns canned values — never spawns. */
export function fakeRunner(o: FakeRunnerOptions = {}): SecretRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    keychainAvailable() {
      calls.push("keychainAvailable");
      return o.keychain ?? true;
    },
    opAvailable() {
      calls.push("opAvailable");
      return o.op ?? true;
    },
    readKeychain(ref: KeychainRef) {
      calls.push(`readKeychain:${ref.service}/${ref.account ?? ""}`);
      if (o.keychainThrows) o.keychainThrows();
      return o.keychainValue ?? "keychain-secret";
    },
    readOp(uri: string) {
      calls.push(`readOp:${uri}`);
      if (o.opThrows) o.opThrows();
      return o.opValue ?? "op-secret";
    },
  };
}
export interface FakeHttpServer {
  url: string;
  close(): Promise<void>;
}

/**
 * A local `node:http` server bound to `127.0.0.1:0` (ephemeral port), used
 * ONLY by `tests/cli.test.ts`'s end-to-end cases (unit-level
 * `tests/discover.test.ts` cases use plain injected `DiscoverFetchLike`
 * fakes, same style as `doctor.test.ts`'s `okFetch`/`authFetch`/`downFetch` —
 * no HTTP server there, keep those fast and dependency-free). `close()`
 * wraps `server.close()` in a Promise so callers can `await` cleanup in a
 * `finally` block (mirrors `tempTree()`'s `cleanup()` pattern above).
 */
export function startFakeHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<FakeHttpServer> {
  // NOTE: the underlying `net.Server#address()` is `null` until the
  // `"listening"` event fires (verified: immediately after calling
  // `listen()`, `address()` returns null) — so this cannot be synchronous
  // and still report a correct `url`. Async (awaited by callers in
  // tests/cli.test.ts) is the smallest correct fix.
  const server = createServer(handler);
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("startFakeHttpServer: failed to bind an ephemeral TCP port"));
        return;
      }
      const url = `http://127.0.0.1:${address.port}`;
      resolvePromise({
        url,
        close(): Promise<void> {
          return new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          });
        },
      });
    });
  });
}
