#!/usr/bin/env node
/**
 * datum CLI. Thin front-end over the resolver library (dist/src/index.js).
 *
 * Secret discipline: no command prints the API key value unless --reveal is
 * given. `resolve` and `list` report the auth BACKEND (env var name, keychain
 * ref, or op:// uri) and whether it is available/set — never the value.
 * Materialization (env read / keychain / 1Password) happens only under --reveal
 * or `sync ... ` never (generators emit references only).
 *
 * Commands:
 *   datum resolve <ref> [--json|--env] [--reveal] [--cwd <dir>] [--repo-config-path <file>] [--user-config-path <file>]
 *   datum list [--cwd <dir>] [--repo-config-path <file>] [--user-config-path <file>]
 *   datum doctor [--probe] [--cwd <dir>] [--repo-config-path <file>] [--user-config-path <file>]
 *   datum sync opencode [--dry-run] [--cwd <dir>] [--repo-config-path <file>] [--user-config-path <file>]
 *   datum sync claude-code --role <name> [--dry-run] [--cwd <dir>] [--repo-config-path <file>] [--user-config-path <file>]
 *
 * Config-location flags (all subcommands): thin plumbing over the library's
 * `ResolveOptions`/`loadConfig` parameters of the same name — no new
 * resolution behavior, just a way to point the existing discovery at a
 * non-default location (scripting, CI, monorepos, fixtures).
 *   --cwd <dir>               Working directory used to locate the repo-level
 *                              `.datum/config.json` (default: process cwd).
 *   --repo-config-path <file> Explicit repo config path, overrides --cwd.
 *   --user-config-path <file> Explicit user config path, overrides the
 *                              `~/.config/kontour/datum.json` default.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolve,
  resolveRef,
  loadConfig,
  describeAuth,
  defaultSecretRunner,
  generateOpencodeProviderBlock,
  mergeIntoOpencodeConfig,
  OPENCODE_FORMAT_VERSION,
  generateClaudeCodeEnv,
  mergeIntoClaudeCodeSettings,
  CLAUDE_CODE_FORMAT_VERSION,
  runDoctor,
  DatumError,
} from "../dist/src/index.js";

const argv = process.argv.slice(2);

// Flags that consume the NEXT argv token as their value. Positional parsing
// below skips both the flag and its value, so flags are order-independent
// relative to positional arguments (e.g. `datum resolve --cwd x ref` and
// `datum resolve ref --cwd x` both resolve `ref` as the positional).
const VALUE_FLAGS = new Set(["--role", "--cwd", "--repo-config-path", "--user-config-path"]);

function has(flag) {
  return argv.includes(flag);
}
function positionals() {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      if (VALUE_FLAGS.has(a)) i++; // skip its value too
      continue;
    }
    out.push(a);
  }
  return out;
}
function optValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * Config-location flags shared by every subcommand, threaded straight into
 * `ResolveOptions`/`loadConfig`/`runDoctor` (the library already supports
 * `cwd`/`repoConfigPath`/`userConfigPath`; this is pure CLI plumbing).
 */
function configOpts() {
  const opts = {};
  const cwd = optValue("--cwd");
  const repoConfigPath = optValue("--repo-config-path");
  const userConfigPath = optValue("--user-config-path");
  if (cwd !== undefined) opts.cwd = cwd;
  if (repoConfigPath !== undefined) opts.repoConfigPath = repoConfigPath;
  if (userConfigPath !== undefined) opts.userConfigPath = userConfigPath;
  return opts;
}

function die(msg, code = 1) {
  process.stderr.write(msg.endsWith("\n") ? msg : msg + "\n");
  process.exit(code);
}

const CONFIG_FLAGS_USAGE =
  "  --cwd <dir>               Working dir for the repo-level .datum/config.json\n" +
  "  --repo-config-path <file> Explicit repo config path (overrides --cwd)\n" +
  "  --user-config-path <file> Explicit user config path\n";

const USAGE = `datum - AI provider/model/role registry resolver

Usage:
  datum resolve <ref> [--json|--env] [--reveal] [config flags]   Resolve a role or model ref
  datum list [config flags]                                       List providers and roles (+ key status)
  datum doctor [--probe] [config flags]                           Diagnose config; --probe makes one live call/provider
  datum sync opencode [--dry-run] [config flags]                  Generate opencode provider config from the registry
  datum sync claude-code --role <name> [--dry-run] [config flags] Generate Claude Code settings env block for a role

Config flags (all subcommands):
${CONFIG_FLAGS_USAGE}
Secrets are never printed unless --reveal is passed.`;

/** Compact, non-secret auth summary for a resolved ref. */
function authSummary(auth) {
  if (auth.kind === "env") return `env ${auth.ref} (${auth.available ? "set" : "MISSING"})`;
  return `${auth.kind} ${auth.ref} (tool ${auth.tool} ${auth.available ? "available" : "UNAVAILABLE"})`;
}

function cmdResolve() {
  const [, ref] = positionals();
  if (!ref) die("resolve: missing <ref>.\n\n" + USAGE);
  const reveal = has("--reveal");
  const asJson = has("--json");
  const asEnv = has("--env");
  const opts = configOpts();

  const r = resolveRef(ref, opts);
  let apiKey;
  if (reveal) apiKey = resolve(ref, opts).apiKey; // materialize (env / keychain / op)

  if (asJson) {
    const out = {
      provider: r.provider,
      kind: r.kind,
      ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
      model: r.model,
      auth: r.auth,
      ...(r.apiKeyEnv ? { apiKeyEnv: r.apiKeyEnv } : {}),
      apiKeySet: r.apiKeySet,
      ...(reveal ? { apiKey } : {}),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    return;
  }

  if (asEnv) {
    const lines = [
      `# datum resolve ${ref} (provider=${r.provider} kind=${r.kind})`,
      `export DATUM_PROVIDER=${JSON.stringify(r.provider)}`,
      `export DATUM_KIND=${JSON.stringify(r.kind)}`,
      ...(r.baseUrl ? [`export DATUM_BASE_URL=${JSON.stringify(r.baseUrl)}`] : []),
      `export DATUM_MODEL=${JSON.stringify(r.model)}`,
      `# auth: ${authSummary(r.auth)}`,
    ];
    if (reveal) {
      if (r.auth.kind === "env") {
        lines.push(`export ${r.auth.envVar}=${JSON.stringify(apiKey)}`);
      } else {
        lines.push(`# key from ${r.auth.kind} (${r.auth.ref}); map it to your downstream key var:`);
        lines.push(`export DATUM_API_KEY=${JSON.stringify(apiKey)}`);
      }
    } else {
      lines.push(
        r.auth.kind === "env"
          ? `# secret: ${r.auth.ref} is ${r.auth.available ? "set" : "NOT set"}; pass --reveal to emit it`
          : `# secret: ${r.auth.kind} backend ${r.auth.available ? "available" : "UNAVAILABLE"}; pass --reveal to read it`,
      );
    }
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }

  // Human-readable.
  const lines = [
    `ref:       ${ref}`,
    `provider:  ${r.provider}`,
    `kind:      ${r.kind}`,
    `baseUrl:   ${r.baseUrl ?? "(SDK default)"}`,
    `model:     ${r.model}`,
    `auth:      ${authSummary(r.auth)}${reveal ? " = " + apiKey : ""}`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

function cmdList() {
  const opts = configOpts();
  const { config, sources } = loadConfig(opts);
  const out = [];
  out.push(`sources: ${sources.length ? sources.join(", ") : "(none found)"}`);
  out.push("");
  out.push("providers:");
  const providers = config.providers ?? {};
  if (Object.keys(providers).length === 0) out.push("  (none)");
  for (const [id, p] of Object.entries(providers)) {
    const env = { ...process.env, ...(opts.env ?? {}) };
    const auth = describeAuth(p.auth, env, defaultSecretRunner);
    out.push(`  ${id}  [${p.kind}]  auth=${authSummary(auth)}  baseUrl=${p.baseUrl ?? "(default)"}`);
    out.push(`      models: ${p.models.join(", ")}`);
  }
  out.push("");
  out.push("roles:");
  const roles = config.roles ?? {};
  if (Object.keys(roles).length === 0) out.push("  (none)");
  for (const [name, target] of Object.entries(roles)) {
    let status;
    try {
      const r = resolveRef(name, opts);
      status = `-> ${r.model}@${r.provider}  auth=${authSummary(r.auth)}`;
    } catch (err) {
      status = `-> ERROR ${err instanceof DatumError ? err.code : ""}: ${err.message}`;
    }
    out.push(`  ${name}  (${target})  ${status}`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

async function cmdDoctor() {
  const opts = configOpts();
  const report = await runDoctor({ probe: has("--probe"), ...opts });
  const symbol = { pass: "ok  ", warn: "warn", fail: "FAIL", skip: "skip" };
  for (const c of report.checks) {
    process.stdout.write(`[${symbol[c.status]}] ${c.name}: ${c.detail}\n`);
  }
  process.stdout.write(report.ok ? "\ndoctor: OK\n" : "\ndoctor: FAILED\n");
  if (!report.ok) process.exit(1);
}

function opencodeConfigPath() {
  return path.join(os.homedir(), ".config", "opencode", "opencode.json");
}
function claudeCodeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function syncOpencode() {
  const dryRun = has("--dry-run");
  const opts = configOpts();
  const { config } = loadConfig(opts);
  const { block, warnings } = generateOpencodeProviderBlock(config);
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);

  if (dryRun) {
    process.stdout.write(`// opencode provider block generated by datum\n`);
    process.stdout.write(`// format: ${OPENCODE_FORMAT_VERSION}\n`);
    process.stdout.write(JSON.stringify(block, null, 2) + "\n");
    return;
  }

  const target = opencodeConfigPath();
  process.stderr.write(
    `warning: live write is EXPERIMENTAL (format: ${OPENCODE_FORMAT_VERSION}). ` +
      `Merging datum providers into ${target}. Use --dry-run to preview.\n`,
  );
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(target, "utf8"));
  } catch (err) {
    if (err && err.code !== "ENOENT") die(`sync: cannot read ${target}: ${err.message}`);
  }
  const merged = mergeIntoOpencodeConfig(existing, block);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(merged, null, 2) + "\n");
  process.stdout.write(`wrote ${Object.keys(block.provider).length} provider(s) to ${target}\n`);
}

function syncClaudeCode() {
  const dryRun = has("--dry-run");
  const role = optValue("--role");
  const opts = configOpts();
  if (!role) die("sync claude-code: missing --role <name>.\n\n" + USAGE);

  const r = resolveRef(role, opts);
  const gen = generateClaudeCodeEnv(role, r);

  if (dryRun) {
    process.stdout.write(`// Claude Code settings env block generated by datum for role "${role}"\n`);
    process.stdout.write(`// surface: ${CLAUDE_CODE_FORMAT_VERSION}\n`);
    process.stdout.write(`// ${gen.apiKeyInstruction}\n`);
    process.stdout.write(JSON.stringify({ env: gen.env }, null, 2) + "\n");
    return;
  }

  const target = claudeCodeSettingsPath();
  process.stderr.write(
    `warning: live write is EXPERIMENTAL (surface: ${CLAUDE_CODE_FORMAT_VERSION}). ` +
      `Merging datum-owned env keys [${gen.ownedKeys.join(", ")}] into ${target}. Use --dry-run to preview.\n`,
  );
  process.stderr.write(`note: ${gen.apiKeyInstruction}\n`);
  let existing = {};
  try {
    existing = JSON.parse(readFileSync(target, "utf8"));
  } catch (err) {
    if (err && err.code !== "ENOENT") die(`sync: cannot read ${target}: ${err.message}`);
  }
  const merged = mergeIntoClaudeCodeSettings(existing, gen.env);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(merged, null, 2) + "\n");
  process.stdout.write(`wrote env keys [${gen.ownedKeys.join(", ")}] for role "${role}" to ${target}\n`);
}

function cmdSync() {
  const [, tool] = positionals();
  if (tool === "opencode") return syncOpencode();
  if (tool === "claude-code") return syncClaudeCode();
  die(`sync: unknown target "${tool ?? ""}". Supported: "opencode", "claude-code".\n\n` + USAGE);
}

async function main() {
  const [cmd] = positionals();
  try {
    switch (cmd) {
      case "resolve":
        cmdResolve();
        break;
      case "list":
        cmdList();
        break;
      case "doctor":
        await cmdDoctor();
        break;
      case "sync":
        cmdSync();
        break;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        process.stdout.write(USAGE + "\n");
        break;
      default:
        die(`unknown command "${cmd}".\n\n` + USAGE);
    }
  } catch (err) {
    if (err instanceof DatumError) die(`${err.code}: ${err.message}`);
    throw err;
  }
}

main();
