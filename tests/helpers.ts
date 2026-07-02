import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatumConfig } from "../src/index.js";

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
