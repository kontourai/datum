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
npm install @kontourai/datum   # once the name is ratified; private for now
```

Node >= 22. Zero runtime dependencies.

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

- **Auth is by reference only.** `auth` is `{ "env": "VAR_NAME" }` — the *name*
  of an environment variable, never the key itself. The validator rejects a
  key-looking literal in any auth field (long token, no spaces → error).
- **`kind` is an open enum.** `anthropic-compatible` is implemented today;
  `openai-compatible` is reserved. `baseUrl` is optional (absent = the SDK
  default for that kind).
- **Model refs** are `model@provider` or bare `model` (an error if a bare model
  is offered by more than one provider).

The normative schema is [`datum.schema.json`](./datum.schema.json).

## The Z.AI walkthrough (canonical example)

With the profile above and `ZAI_API_KEY` exported, resolve the extraction role:

```bash
$ datum resolve extraction-default
ref:       extraction-default
provider:  zai
kind:      anthropic-compatible
baseUrl:   https://api.z.ai/api/anthropic
model:     glm-5.2
apiKey:    ZAI_API_KEY (set)
```

The secret is never printed. `--json` gives you the same structure (with
`apiKeyEnv`/`apiKeySet`, and `apiKey` only under `--reveal`); `--env` prints
`export` lines for a shell.

Wire it into [traverse](https://github.com/kontourai/traverse) — datum's
`{ baseUrl, apiKey, model }` lines up 1:1 with traverse 0.2.0's
`createAnthropicExtractionProvider` options:

```ts
import { resolve } from "@kontourai/datum";
import { createAnthropicExtractionProvider } from "@kontourai/traverse/anthropic";

const provider = createAnthropicExtractionProvider({ ...resolve("extraction-default") });
// -> talks to api.z.ai with glm-5.2 and the key from ZAI_API_KEY
```

Need to route only, without materializing the secret? Use `resolveRef` — it
returns `apiKeyEnv` (the var name) and `apiKeySet` instead of the value.

## CLI

```
datum resolve <ref> [--json|--env] [--reveal]   Resolve a role or model ref
datum list                                       Providers + roles, with key-set status
datum doctor [--probe]                           Diagnose config; --probe makes ONE live call/provider
datum sync opencode [--dry-run]                  Generate opencode's provider block from the registry
```

- No command prints the API key value unless `--reveal` is passed.
- `datum doctor` checks that files parse, every role resolves, and every
  provider's key env var is set. `--probe` is the **single** place datum touches
  the network: one `max_tokens: 1` request per provider against the
  anthropic-compatible `/v1/messages` shape, to confirm endpoint + key + model
  actually work.
- `datum sync opencode` emits opencode's native `provider` block (confirmed
  against opencode's published `config.json` schema). It writes `env: ["VAR"]`,
  not `options.apiKey` — the key stays in the environment. Live write is
  experimental; use `--dry-run` to preview.

## What datum is *not*

- **Not a gateway or proxy.** It never sits in the request path. It resolves
  config and exits; your own SDK makes the call.
- **Not a client or SDK wrapper.** The core imports no AI SDK. The resolved
  object is inert data.
- **Not a secret store.** Auth is by reference; datum reads env var *names* from
  config and materializes values from the environment only when asked.
- **Not a router at call time.** It picks the backend for a ref up front; it
  does not load-balance, retry, or fail over live requests.

The one deliberate exception is `datum doctor --probe`, which makes a single
minimal live call purely to verify a provider is reachable.

## Design

See [`docs/design.md`](./docs/design.md) for precedence rules, the
secret-reference-only decision, the generator-not-wrapper principle, and the
slice-2+ roadmap.

## License

MIT.
