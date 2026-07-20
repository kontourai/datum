# @kontourai/datum

Datum is the Kontour portfolio's AI provider/model/role registry. **Define your
providers, models, and roles once; resolve them everywhere; generate the native
config every tool wants.** Datum answers a single question — *which backend,
which model, whose key, what base URL* — for a role name or a `model@provider`
ref, and hands back a plain `{ provider, kind, baseUrl?, apiKey, model }` object.
It abstracts *configuration resolution, not invocation*: it imports no AI SDK,
wraps no runtime, and makes no model calls (with four narrow, opt-in
exceptions: `datum doctor --probe`, `datum discover`, `datum test-connection`,
and `datum catalog refresh`).

## Install

```bash
npm install @kontourai/datum
```

Node >= 22. The only runtime dependency is the exact `@kontourai/bearing`
contract package; Datum imports no AI SDK or schema engine.

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

### Capability roles

A role can instead be a closed policy object. Datum gives Bearing the concrete,
rankable partition of the caller-supplied runtime inventory and combines durable
requirements/preferences with per-request additions. It then applies Datum's
provider-model, auth, and locality checks to Bearing's deterministic ranking. No
candidate outside the complete caller inventory can be selected.

```json
{
  "roles": {
    "interactive": {
      "policy": {
        "requirements": [{ "measurementKey": "model.context.max_tokens", "aggregation": "fact", "operator": "gte", "value": 32768 }],
        "preferences": [{ "measurementKey": "quality", "aggregation": "mean", "direction": "maximize", "weight": 1 }],
        "advisories": [{ "id": "context-projection", "measurementKey": "context.projection", "aggregation": "fact" }],
        "locality": "local-only",
        "fallback": "qwen3@ollama"
      }
    }
  }
}
```

Use the offline API `resolveCapabilityRole(role, request, opts)` or
`datum resolve-policy <role> --request request.json --json`. A request binds
an exact `schemaVersion: "datum.capability-role.request/v1"` and binds each
opaque candidate id to its Datum provider id, provider model id, locality,
Bearing model identity, and caller-observed execution profile. Unknown runtime
or tool surface is preserved as `null`; `toolSurface: []` remains
known-empty. Datum sends only candidates with a concrete runtime and tool
surface to Bearing. Other launchable candidates remain in the result with
`DATUM_EXECUTION_PROFILE_INCOMPLETE` rather than being discarded or coerced.
Session fixed overrides,
then `DATUM_ROLE_<NAME>`, then a durable fixed role take precedence and bypass
Bearing ranking, but still must match exactly one supplied candidate and pass
Datum checks. Request locality is a caller claim, not sufficient evidence by
itself: `local-only` also requires the provider's effective configured base URL,
including `DATUM_BASEURL_<PROVIDER>`, to name a loopback endpoint. Providers
without an explicit loopback route cannot be proven local. Those fixed paths may
explicitly select an incomplete execution profile without inventing capability.
A policy fallback is considered only for missing/stale catalog
state and is subject to the same inventory boundary. Results include catalog
provenance, evidence, uncertainty, exclusions, and explicit override/fallback
state; they never materialize secrets or fetch a catalog. Policy and request
advisories are additive. Datum asks Bearing rank v2 to project them for every
ranked or excluded candidate and passes the resulting status, value/unit,
evidence, and uncertainty through unchanged. It does not infer advisory ids,
measurement keys, or recommendation meaning from model names or catalog
internals. Fixed, override, and fallback resolution return no advisories because
they bypass Bearing. The combined durable and request set must use unique ids,
contain at most 64 advisories, and produce at most 1,024 inventory projection
cells over the concrete rankable partition sent to Bearing. Rank reasons retain Bearing's execution applicability, so partial facts
apply only to candidates matching the dimensions their source actually asserts.

Embedding runtimes that already own provider credentials may pass
`providerBindings` in the resolve options. This bounded, per-call map is the
authoritative provider universe for that call and contains only provider kind,
an optional credential-free base URL, allowed model ids, and
`auth: { kind: "host", ref: "<authority>", available: boolean }`. It never
contains a credential value. Durable Datum roles and catalog configuration
still supply policy, while Datum still enforces provider/model membership,
host-reported auth readiness, fixed/override/fallback bounds, and locality. An
ambient `DATUM_BASEURL_*` override cannot rewrite a host-owned binding. When
`providerBindings` is omitted, existing Datum provider config and secret-ref
availability behavior are unchanged.

### Capability catalog snapshots

Datum can retain one validated [Bearing](https://github.com/kontourai/bearing)
capability-catalog snapshot alongside its provider registry. Declare exactly one
source — a remote snapshot URL or a local snapshot path — and optionally bound
its age:

```json
{
  "capabilityCatalog": {
    "remoteUrl": "https://catalog.example/snapshot.json",
    "maxAgeSeconds": 86400
  }
}
```

Remote URLs must be credential-free `http(s)` endpoints without userinfo,
query parameters, or fragments. Use a separately controlled endpoint rather
than committing a signed URL or token to durable config.
Config precedence remains per-key: a repo-level `remoteUrl` or `localPath`
replaces the user-level source discriminator without creating an invalid mixed
source, while `maxAgeSeconds` inherits unless the repo overrides it.

`localPath` must be repository-relative and remain under the real Datum working
directory after symlink resolution. Local snapshots are read and validated
directly. Remote snapshots are fetched only by explicit
refresh, then validated with Bearing and saved under the disposable,
source-keyed cache `<cwd>/.kontourai/datum/bearing`. Snapshots are immutable and
content-addressed by their Bearing digest. State candidates are also immutable;
Datum selects the greatest catalog `asOf`, so concurrent refresh processes
cannot regress the active catalog by finishing out of order. Different digests
at one `asOf` are a typed conflict; publishers must advance `asOf` for every
revision.
The default remote transport resolves and validates every address, then pins
the actual connection to those validated results at each redirect hop. Each
hop has a 30-second overall deadline; library callers may set
`requestTimeoutMs` explicitly. An injected `transport` receives the validated
address set and must connect only to those addresses. Remote source metadata
exposes only the origin plus a redacted path marker.
`catalog status` and library loading never use the network. If refresh fails, a
valid non-stale cache is returned with a typed fallback diagnostic; otherwise
the typed failure is raised.

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
datum resolve-policy <role> --request <json-file> [--json] [config flags] Resolve a capability role offline
datum list [config flags]                                          Providers + roles, with auth status
datum doctor [--probe] [--allow-insecure] [config flags]            Diagnose config; --probe makes ONE live call/provider
datum discover <provider> [--json] [--allow-insecure] [config flags]  Fetch the live model list from an openai-compatible provider
datum test-connection <provider> [--allow-insecure] [config flags]  Validate auth + reachability for one provider; exits non-zero on failure
datum catalog status|refresh [--json] [--allow-insecure] [config flags]  Show catalog metadata or explicitly refresh it
datum sync opencode [--dry-run] [config flags]                      Generate opencode's provider block from the registry
datum sync claude-code --role <name> [--dry-run] [config flags]     Generate Claude Code's settings env block for a role
```

- No command prints the API key value unless `--reveal` is passed.
- `datum doctor` checks that files parse, every fixed role resolves, records
  policy roles as inventory-required, and checks every
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
- `--allow-insecure` (accepted by `doctor --probe`, `discover`,
  `test-connection`, and explicit `catalog refresh`, the commands that make
  live requests): `https://` is
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

Every subcommand (including `catalog status` and `catalog refresh`)
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

The deliberate exceptions are `datum doctor --probe`, `datum discover`,
`datum test-connection`, and `datum catalog refresh`, each a minimal opt-in
live call made only when explicitly invoked.

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
ancestry in a read-only job. After the Node 22/24 matrix passes, a no-OIDC job
builds, validates, hashes, and uploads the exact tarball. The protected publish
job does not check out or execute repository code: it downloads and verifies
that artifact, fails closed on registry errors except for a structured npm
`E404`, and publishes it with provenance and lifecycle scripts disabled.

Owner activation on npmjs.com: configure a **trusted publisher** for
`@kontourai/datum` with organization `kontourai`, repository `datum`, workflow
filename `publish-npm.yml`, environment `npm-publish`, and only the `npm
publish` allowed action. Enable provenance display. Automatic triggers should
be restored only with explicit hosted-budget approval; this is tracked in
issue #17.

## License

MIT.
