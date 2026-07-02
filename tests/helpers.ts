import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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
  mkdirSync(path.join(cwd, ".kontour"), { recursive: true });
  return {
    dir,
    home,
    cwd,
    writeUser(cfg: unknown) {
      writeFileSync(path.join(home, ".config", "kontour", "datum.json"), JSON.stringify(cfg));
    },
    writeRepo(cfg: unknown) {
      writeFileSync(path.join(cwd, ".kontour", "datum.json"), JSON.stringify(cfg));
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
