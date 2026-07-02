# @kontourai/datum

Datum is the Kontour portfolio's AI provider/model/role registry. **Define your
providers, models, and roles once; resolve them everywhere; generate the native
config every tool wants.** Datum answers a single question — *which backend,
which model, whose key, what base URL* — for a role name or a `model@provider`
ref, and hands back a plain `{ provider, kind, baseUrl?, apiKey, model }` object.
It abstracts *configuration resolution, not invocation*: it imports no AI SDK,
wraps no runtime, and makes no model calls (with one narrow, opt-in exception:
`datum doctor --probe`).

## Install

```bash
npm install @kontourai/datum
```

Node >= 22. Zero runtime dependencies.

> Status: publishing is staged (workflows, provenance, release automation are in
> the repo) but the first `@kontourai/datum` release is **on hold pending owner
> ratification**. Until then, consume it from the repo.

## Config

Two files, deep-merged. User-level `~/.config/kontour/datum.json` is the base;
repo-level `.kontour/datum.json` overlays it and wins per-key; environment
escape hatches override both.

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
datum resolve <ref> [--json|--env] [--reveal]      Resolve a role or model ref
datum list                                          Providers + roles, with auth status
datum doctor [--probe]                              Diagnose config; --probe makes ONE live call/provider
datum sync opencode [--dry-run]                     Generate opencode's provider block from the registry
datum sync claude-code --role <name> [--dry-run]    Generate Claude Code's settings env block for a role
```

- No command prints the API key value unless `--reveal` is passed.
- `datum doctor` checks that files parse, every role resolves, and every
  provider's key backend is reachable-in-principle (env var set, or keychain/op
  tool present — **the secret is not read**). `--probe` is the **single** place
  datum touches the network: one `max_tokens: 1` request per provider —
  `POST /v1/messages` for `anthropic-compatible`, `POST /chat/completions` for
  `openai-compatible` — to confirm endpoint + key + model actually work.
- `datum sync opencode` emits opencode's native `provider` block (confirmed
  against opencode's published `config.json` schema). It writes `env: ["VAR"]`,
  not `options.apiKey` — the key stays in the environment.
- `datum sync claude-code --role <name>` emits Claude Code's native
  `~/.claude/settings.json` `env` block (`ANTHROPIC_BASE_URL` + `ANTHROPIC_MODEL`,
  confirmed against docs.claude.com/en/docs/claude-code/settings). The API key is
  **never** written — it is emitted only as an instruction naming its backend.
- Both `sync` targets: live write is experimental and merges only a
  clearly datum-owned block; use `--dry-run` to preview.

## Provider kinds × consumers

Datum's `kind` is open, but each consumer speaks a subset. What datum can
generate/route for each kind today:

| kind                    | `resolve()` | opencode (`sync opencode`) | Claude Code (`sync claude-code`) | traverse | doctor `--probe`               |
| ----------------------- | :---------: | :------------------------: | :------------------------------: | :------: | ------------------------------ |
| `anthropic-compatible`  |     yes     |  yes (`@ai-sdk/anthropic`) |               yes                |   yes    | `POST /v1/messages`            |
| `openai-compatible`     |     yes     | yes (`@ai-sdk/openai-compatible`) |         no (Anthropic API only)  |   no     | `POST /chat/completions`       |
| other (open enum)       |     yes     |  skipped (warning)         |         no                       |   n/a    | skipped                        |

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

The one deliberate exception is `datum doctor --probe`, which makes a single
minimal live call purely to verify a provider is reachable.

## Design

See [`docs/design.md`](./docs/design.md) for precedence rules, the
secret-reference-only decision, the generator-not-wrapper principle, and the
slice roadmap.

## Publishing (maintainers)

Release automation mirrors traverse: release-please opens/refreshes a release PR
from conventional commits; merging it tags `vX.Y.Z`; the tag (or the
release-please `workflow_dispatch` fallback) runs `publish-npm.yml`, which
verifies, guards (tag matches `package.json`, tagged commit on `main`, skip if
already published), and runs `npm publish --access public --provenance` over
OIDC.

One-time owner setup on npmjs.com after the first successful publish: configure a
**trusted publisher** for `@kontourai/datum` (repo `kontourai/datum`, workflow
`.github/workflows/publish-npm.yml`) so future OIDC publishes need no token, and
enable provenance display. See the same step in traverse's package settings.

## License

MIT.
