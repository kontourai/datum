# @kontourai/datum

Datum is the Kontour portfolio's AI provider/model/role registry. **Define your
providers, models, and roles once; resolve them everywhere; generate the native
config every tool wants.** Datum answers a single question — *which backend,
which model, whose key, what base URL* — for a role name or a `model@provider`
ref, and hands back a plain `{ provider, kind, baseUrl?, apiKey, model }` object.
It abstracts *configuration resolution, not invocation*: it imports no AI SDK,
wraps no runtime, and makes no model calls (with three narrow, opt-in
exceptions: `datum doctor --probe`, `datum discover`, and `datum
test-connection`).

## Install

```bash
npm install @kontourai/datum
```

Node >= 22. Zero runtime dependencies.

> Status: `@kontourai/datum` is published. Hosted release workflows remain
> manual-only while CI is out of budget; local verification is authoritative.

## Config

Two files, deep-merged. User-level `~/.config/kontour/datum.json` is the base;
repo-level `.datum/config.json` overlays it and wins per-key; environment
escape hatches override both.

### The `.kontourai/` vs `.<product>/` convention

Kontour portfolio tools use a consistent repo-level directory split:

- **`.kontourai/`** is what you *ignore* — gitignored, per-machine, disposable
  runtime state (caches, logs, generated scratch output).
- **`.<product>/`** is what you *commit* — a product's durable, tracked config
  directory, owned and versioned like any other source file (precedent:
  `.veritas/` in the veritas repo).

Datum's repo-level config directory is **`.datum/`**, and the file datum reads
is **`.datum/config.json`**. Commit it.

```json
{
  "providers": {
    "zai":       { "kind": "anthropic-compatible", "baseUrl": "https://api.z.ai/api/anthropic", "auth": { "env": "ZAI_API_KEY" }, "models": ["glm-5.2", "glm-4.6"] },
    "anthropic": { "kind": "anthropic-compatible", "auth": { "env": "ANTHROPIC_API_KEY" }, "models": ["claude-sonnet-5", "claude-haiku-4-5"] }
  },
  "roles": {
    "extraction-default": "glm-5.2@zai",
    "worker": "claude-sonnet-5@anthropic"
  }
}
```

- **Auth is by reference only.** Never the key itself — one of three references:
  - `{ "env": "VAR_NAME" }` — the *name* of an environment variable.
  - `{ "keychain": { "service": "…", "account": "…"? } }` — a macOS Keychain
    generic-password lookup (darwin-only).
  - `{ "op": "op://vault/item/field" }` — a 1Password secret reference.

  The validator rejects a key-looking literal in any auth field (long token, no
  spaces → error).
- **`kind` is an open enum.** `anthropic-compatible` and `openai-compatible` are
  implemented; any string is accepted so new kinds can land. `baseUrl` is
  optional (absent = the SDK default for that kind).
- **Model refs** are `model@provider` or bare `model` (an error if a bare model
  is offered by more than one provider).

The normative schema is [`datum.schema.json`](./datum.schema.json).

### Secret backends (keychain / 1Password)

Keychain and 1Password refs stay reference-only and are materialized **lazily**:
only `resolve()` (and `doctor --probe`) reads the value — via
`security find-generic-password -w` or `op read`. `resolveRef`, `datum list`, and
`datum sync` **never** invoke the backing tool; they only report the auth *kind*
and whether the tool/var is *available*, without reading the secret.

```json
{
  "providers": {
    "anthropic": { "kind": "anthropic-compatible", "auth": { "keychain": { "service": "datum-anthropic", "account": "work" } }, "models": ["claude-sonnet-5"] },
    "zai":       { "kind": "anthropic-compatible", "baseUrl": "https://api.z.ai/api/anthropic", "auth": { "op": "op://Private/zai/credential" }, "models": ["glm-5.2"] }
  }
}
```

Missing/unavailable backends surface as typed errors (`SECRET_BACKEND_UNAVAILABLE`
off darwin or when `op` is not installed; `SECRET_LOOKUP_FAILED` when the item is
absent or empty) — only at `resolve()` time.

## The Z.AI walkthrough (canonical example)

With the profile above and `ZAI_API_KEY` exported, resolve the extraction role:

```bash
$ datum resolve extraction-default
ref:       extraction-default
provider:  zai
kind:      anthropic-compatible
baseUrl:   https://api.z.ai/api/anthropic
model:     glm-5.2
auth:      env ZAI_API_KEY (set)
```

The secret is never printed. `--json` gives you the same structure (with an
`auth` descriptor, plus `apiKey` only under `--reveal`); `--env` prints `export`
lines for a shell.

Wire it into [traverse](https://github.com/kontourai/traverse) — datum's
`{ baseUrl, apiKey, model }` lines up 1:1 with traverse's
`createAnthropicExtractionProvider` options:

```ts
import { resolve } from "@kontourai/datum";
import { createAnthropicExtractionProvider } from "@kontourai/traverse/anthropic";

const provider = createAnthropicExtractionProvider({ ...resolve("extraction-default") });
// -> talks to api.z.ai with glm-5.2 and the key from ZAI_API_KEY
```

Need to route only, without materializing the secret? Use `resolveRef` — it
returns an `auth` status (kind + reference + availability) instead of the value.

## CLI

```
datum resolve <ref> [--json|--env] [--reveal] [config flags]      Resolve a role or model ref
datum list [config flags]                                          Providers + roles, with auth status
datum doctor [--probe] [--allow-insecure] [config flags]            Diagnose config; --probe makes ONE live call/provider
datum discover <provider> [--json] [--allow-insecure] [config flags]  Fetch the live model list from an openai-compatible provider
datum test-connection <provider> [--allow-insecure] [config flags]  Validate auth + reachability for one provider; exits non-zero on failure
datum sync opencode [--dry-run] [config flags]                      Generate opencode's provider block from the registry
datum sync claude-code --role <name> [--dry-run] [config flags]     Generate Claude Code's settings env block for a role
```

- No command prints the API key value unless `--reveal` is passed.
- `datum doctor` checks that files parse, every role resolves, and every
  provider's key backend is reachable-in-principle (env var set, or keychain/op
  tool present — **the secret is not read**). `--probe` makes one
  `max_tokens: 1` request per provider — `POST /v1/messages` for
  `anthropic-compatible`, `POST /chat/completions` for `openai-compatible` —
  to confirm endpoint + key + model actually work.
- `datum discover <provider>` fetches the live model ids an
  `openai-compatible` provider's `GET {baseUrl}/models` endpoint actually
  offers and displays them (`--json` for structured output). Not supported for
  other provider kinds.
- `datum test-connection <provider>` validates auth + reachability for any
  configured provider (any `kind`) and exits non-zero on failure, with each
  check's pass/fail printed and the failure distinguished into one of three
  classes: bad/missing credentials, an unreachable endpoint, or a response
  that is not shaped like the expected `openai-compatible` `/models` payload.
- `--allow-insecure` (accepted by `doctor --probe`, `discover`, and
  `test-connection`, the 3 commands that make live requests): `https://` is
  always allowed; loopback `http://` (`localhost`, `127.0.0.0/8`, `::1`,
  `::ffff:127.x.x.x` — Ollama/LM Studio-style local providers) is allowed
  silently; `http://` to any other host is blocked by default with an
  actionable error naming the URL. `--allow-insecure` overrides the block but
  still prints `warning: ...` to stderr every time. Redirects are followed
  manually and the policy is re-checked on each hop, so a server cannot bounce
  a key-bearing request from `https://` to a plaintext `http://` host.
- `datum sync opencode` emits opencode's native `provider` block (confirmed
  against opencode's published `config.json` schema). It writes `env: ["VAR"]`,
  not `options.apiKey` — the key stays in the environment.
- `datum sync claude-code --role <name>` emits Claude Code's native
  `~/.claude/settings.json` `env` block (`ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL`,
  confirmed against docs.claude.com/en/docs/claude-code/settings). The API key is
  **never** written — it is emitted only as an instruction naming its backend.
- Both `sync` targets: live write is experimental and merges only a
  clearly datum-owned block; use `--dry-run` to preview.

### Config-location flags

Every subcommand (`resolve`, `list`, `doctor`, `sync opencode`, `sync claude-code`)
accepts the same three config-location flags, threaded straight into the
library's existing `ResolveOptions`/`loadConfig` parameters — pure plumbing, no
new resolution behavior. Flags may appear anywhere on the command line, before
or after positional arguments.

```
--cwd <dir>               Working dir for the repo-level .datum/config.json
                           (default: the process's own cwd)
--repo-config-path <file> Explicit repo config path; overrides --cwd entirely
--user-config-path <file> Explicit user config path; overrides the
                           ~/.config/kontour/datum.json default
```

Useful for scripting, CI, monorepos, or fixtures where the config isn't in the
process's own working directory:

```bash
$ datum resolve extraction-default --cwd ../other-repo
$ datum doctor --repo-config-path ./fixtures/.datum/config.json
$ datum list --user-config-path ~/.config/kontour/work.json
```

## Provider kinds × consumers

Datum's `kind` is open, but each consumer speaks a subset. What datum can
generate/route for each kind today:

| kind                    | `resolve()` | opencode (`sync opencode`) | Claude Code (`sync claude-code`) | traverse | doctor `--probe`               | `discover`          | `test-connection`                     |
| ----------------------- | :---------: | :------------------------: | :------------------------------: | :------: | ------------------------------ | ------------------- | -------------------------------------- |
| `anthropic-compatible`  |     yes     |  yes (`@ai-sdk/anthropic`) |               yes                |   yes    | `POST /v1/messages`            | not supported        | yes (reuses `doctor --probe`'s check)  |
| `openai-compatible`     |     yes     | yes (`@ai-sdk/openai-compatible`) |         no (Anthropic API only)  |   no     | `POST /chat/completions`       | `GET /models`        | yes (full 3-class diagnosis)           |
| other (open enum)       |     yes     |  skipped (warning)         |         no                       |   n/a    | skipped                        | not supported        | skipped                                |

Auth-backend support per consumer: `resolve()`, Claude Code, and traverse work
with all three auth kinds (env / keychain / op). **opencode expresses env-var
names only**, so providers using `keychain`/`op` are skipped (with a warning) by
`sync opencode` — give such a provider an `{ "env": … }` ref if opencode needs it.
traverse today speaks **anthropic-compatible only**.

## What datum is *not*

- **Not a gateway or proxy.** It never sits in the request path. It resolves
  config and exits; your own SDK makes the call.
- **Not a client or SDK wrapper.** The core imports no AI SDK. The resolved
  object is inert data.
- **Not a secret store.** Auth is by reference; datum reads env var *names* /
  keychain / op references from config and materializes values only when asked.
- **Not a router at call time.** It picks the backend for a ref up front; it
  does not load-balance, retry, or fail over live requests.

The deliberate exceptions are `datum doctor --probe`, `datum discover`, and
`datum test-connection`, each a single minimal opt-in live call made only
when explicitly invoked.

## Design

Design decisions are frozen ADRs at [`docs/adr/`](./docs/adr/index.md)
(precedence rules, the secret-reference-only decision, the
generator-not-wrapper principle, and the slice roadmap — immutable, split one
decision per file). Current/living decisions and their vocabulary are the
topic-keyed registry at [`docs/decisions/`](./docs/decisions/index.md) and
[`CONTEXT.md`](./CONTEXT.md#term-glossary).

## Publishing (maintainers)

Release Please, CI, and npm publication are manual-only while hosted CI is out
of budget. `npm run verify` is the authoritative local gate: it checks the exact
tarball allowlist, installs that tarball in a clean consumer, imports the public
API, and runs `datum --help`. `prepublishOnly` enforces the same gate for local
publication.

The publish workflow first verifies the `vX.Y.Z` ref, package version, and main
ancestry in a read-only job with no OIDC. Only after that and the Node 22/24
verification matrix pass does the `npm-publish` environment grant OIDC. Registry
errors fail closed except for explicit not-found, and the workflow hashes and
publishes the same validated tarball with lifecycle scripts disabled.

Owner activation on npmjs.com: configure a
**trusted publisher** for `@kontourai/datum` (repo `kontourai/datum`, workflow
`.github/workflows/publish-npm.yml`) so future OIDC publishes need no token, and
enable provenance display. Automatic triggers should be restored only with
explicit hosted-budget approval; this is tracked in issue #17.

## License

MIT.
