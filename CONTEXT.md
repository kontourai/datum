# Datum Context

Datum is `@kontourai/datum`, the Kontour portfolio's AI provider/model/role
registry. It abstracts CONFIGURATION RESOLUTION, not invocation — it answers
"which backend, which model, whose key, what base URL" for a role or
`model@provider` ref and returns inert `{ provider, kind, baseUrl?, apiKey,
model }` data. It imports no AI SDK and makes no model calls. The one narrow
exception is `datum doctor --probe` (a single opt-in live reachability call
per provider).

## Term Glossary

- **Configuration Resolution**: datum's whole job, and the one thing it is
  not — invocation. Given a role name or a `model@provider` ref, datum
  answers *which backend, which model, whose key, what base URL* and stops;
  the caller's own SDK makes any model call. No AI SDK dependency, no API
  call, no runtime wrapping lives in the resolver itself. The single, opt-in
  exception is `datum doctor --probe`.
- **Config Precedence**: the two independent layers datum composes to answer
  a ref. The FILE layer deep-merges user-level
  `~/.config/kontour/datum.json` (base) under repo-level `.datum/config.json`
  (overlay, wins per-key). The RESOLUTION layer then applies, highest
  precedence first: `opts.env` (explicit programmatic overrides), then
  `process.env` (the `DATUM_ROLE_<NAME>` / `DATUM_BASEURL_<PROVIDER>` escape
  hatches), then the repo file, then the user file. `.datum/` is the
  product's durable, committed config directory (portfolio convention:
  `.kontourai/` is gitignored per-machine state you ignore; `.<product>/` is
  what you commit).
- **Secret References**: datum's auth model — a reference to a secret,
  never the secret's literal value. Exactly one backend per provider: `{ env
  }` (an environment variable NAME), `{ keychain }` (a macOS Keychain
  generic-password lookup), or `{ op }` (a 1Password `op://` URI).
  Materialization is LAZY and explicit: only `resolve()` (and the opt-in
  `doctor --probe`) reads a value; `resolveRef`/`list`/`sync` only report
  whether the backend is available, never the value. The validator rejects
  any auth field that looks like a pasted secret literal rather than a
  reference.
- **Config Validation**: datum's hand-rolled validator (`src/validate.ts`)
  that mirrors the normative `datum.schema.json` and additionally enforces
  the secret-literal rule a plain JSON Schema cannot express. Zero runtime
  dependencies — no ajv or other schema engine ships in the resolver's
  runtime path.
- **Config Generators**: datum's `sync` commands, which emit a target tool's
  OWN native config format and stop — datum never proxies or intercepts that
  tool's calls. `datum sync opencode` emits opencode's `provider` block;
  `datum sync claude-code --role <name>` emits Claude Code's
  `~/.claude/settings.json` `env` block. Both write auth as an environment
  variable NAME or an instruction naming the secret's backend, never the
  value; live writes merge only datum-owned keys and are experimental,
  `--dry-run` is the confirmed path.
- **Provider Kinds**: the open-enum `kind` on a `ProviderConfig`.
  `anthropic-compatible` and `openai-compatible` are implemented; any other
  string is accepted structurally so a new kind can land without a schema
  bump. Not every consumer supports every kind (see the README support
  matrix) — each Config Generator and `doctor --probe` switch on `kind`
  themselves and skip (with a warning) a kind they do not speak.
- **Release Automation**: datum's npm publish pipeline, mirrored from
  traverse — release-please opens/refreshes a release PR from conventional
  commits, merging it tags `vX.Y.Z`, and the tag (or a `workflow_dispatch`
  fallback) runs `publish-npm.yml`, which verifies, guards (tag matches
  `package.json`, tagged commit on `main`, skip if already published), and
  publishes over OIDC with `--provenance`.

## Decision Registry

Frozen design history lives in numbered ADRs under
[`docs/adr/`](docs/adr/index.md) (immutable — see the banner on each file).
Current and superseding decisions for the terms above live in the
topic-keyed registry at [`docs/decisions/`](docs/decisions/index.md); consult
that index before recording a new decision (revise an existing topic file, or
create one keyed to a term in this glossary — add the term here first if it
is missing).
