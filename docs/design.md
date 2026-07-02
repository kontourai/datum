# Datum design notes (slices 1–2)

Datum abstracts **configuration resolution, not invocation**. It answers *which
backend, which model, whose key, what base URL* and stops. This document records
the decisions taken in slice 1 and what is deferred.

## The fixed principle

No AI SDK dependencies. No API calls in the core resolver. No wrapping of
runtimes. The resolver returns inert data (`{ provider, kind, baseUrl?, apiKey,
model }`); the caller's own SDK makes any model call. The single, opt-in
exception is `datum doctor --probe` (below).

## Precedence

Resolution composes two independent layers.

**File layer (config.ts).** Two files are deep-merged:

1. repo-level `.datum/config.json` — overlay, wins per-key
2. user-level `~/.config/kontour/datum.json` — base

Deep-merge means objects merge recursively; arrays and scalars from the overlay
*replace* (a provider's `models` array is replaced wholesale by the repo file,
not concatenated). A missing file is skipped; a present-but-unparseable file is a
hard `INVALID_CONFIG` error naming the path.

**Repo-level directory convention.** Kontour portfolio tools split repo-level
state into `.kontourai/` — gitignored, per-machine runtime state you *ignore*
— and `.<product>/` — the product's durable, tracked config directory you
*commit* (precedent: `.veritas/` in the veritas repo). Datum's repo-level
config directory is `.datum/`, and the config file is `.datum/config.json`.
An earlier slice used `.kontour/datum.json`; that path was corrected to
`.datum/config.json` in 0.3.0 before any external consumer depended on it, so
there is no fallback or deprecation period — `.kontour/datum.json` is simply
not read.

**Resolution layer (resolve.ts).** Highest precedence first:

1. `opts.env` — explicit programmatic overrides
2. `process.env` — the environment escape hatches
3. repo file
4. user file

`opts.env` is merged *over* `process.env` (so 1 beats 2); the files are merged
with repo over user (3 beats 4).

### Environment escape hatches

- `DATUM_ROLE_<NAME>` — overrides a role's target model ref entirely
  (`DATUM_ROLE_EXTRACTION_DEFAULT=claude-sonnet-5@anthropic`). `<NAME>` is the
  role name uppercased with non-alphanumerics collapsed to `_`.
- `DATUM_BASEURL_<PROVIDER>` — overrides a provider's base URL
  (`DATUM_BASEURL_ZAI=https://proxy.internal`).
- The API key value always comes from the provider's referenced env var (or
  `opts.env`), never from the file.

**We deliberately do NOT read the downstream SDK's own `ANTHROPIC_BASE_URL` in
the resolver.** That variable is the runtime Anthropic SDK's escape hatch;
consuming it here as well would double-apply it (datum would bake a base URL into
its output *and* the SDK would read the same var). Datum owns a namespaced
`DATUM_BASEURL_<PROVIDER>` instead, and leaves `ANTHROPIC_BASE_URL` to the layer
that actually makes the call. This mirrors traverse's Anthropic adapter, which
also refuses to read `ANTHROPIC_BASE_URL` itself.

### Ref dispatch

- A ref containing `@` is always a `model@provider` ref, never a role.
- A bare ref is resolved **role-first**: if it is a known role (or a
  `DATUM_ROLE_<NAME>` override exists) it resolves as a role; otherwise it is
  tried as a bare model for convenience.
- Bare-model resolution finds the unique provider offering the model. Zero
  matches at the top level → `UNKNOWN_ROLE` (the ref named nothing resolvable);
  a *role whose target* names a nonexistent bare model → `UNKNOWN_MODEL`; two or
  more providers offering the same bare model → `AMBIGUOUS_MODEL` (use
  `model@provider`).

Typed errors carry a stable `code`: `UNKNOWN_ROLE`, `UNKNOWN_PROVIDER`,
`UNKNOWN_MODEL`, `AMBIGUOUS_MODEL`, `MISSING_ENV` (names the variable),
`INVALID_CONFIG`, `SECRET_LITERAL`.

## Secret-reference-only

Auth is `{ env: "VAR_NAME" }` — a reference, never a literal. Rationale: config
files land in repos, dotfiles, and screen shares; a resolver has no business
holding secrets at rest. The validator enforces this two ways:

1. The only permitted auth key in this slice is `env`; a `key`/`apiKey`/`token`
   key is a structural attempt to embed a secret and is rejected
   (`SECRET_LITERAL`).
2. Every auth field *value* is run through a heuristic — a long, space-free token
   (known key prefixes like `sk-`, an AWS `AKIA…` id, length ≥ 40, or a
   medium-length value that is not a clean `^[A-Z][A-Z0-9_]*$` env-var name) is
   flagged. Env var names pass; pasted keys do not.

Materialization is explicit: `resolve()` reads the value from the environment;
`resolveRef()` never does and returns the variable name plus a set/unset flag.
The CLI prints the value only under `--reveal`.

## Zero runtime dependencies / hand-rolled validation

The runtime path pulls in nothing. The config surface is tiny and closed, so
validation is a direct hand-rolled function (validate.ts) rather than ajv or
another JSON-schema engine: smaller, faster to load, and no supply-chain tail in
a CLI whose whole job is to resolve config. `datum.schema.json` remains the
normative, editor-facing schema; the validator mirrors it and additionally
enforces the secret-literal rule, which a plain schema cannot express.

## Generator, not wrapper (opencode sync)

`datum sync opencode` emits opencode's *native* `provider` block and stops.
Datum does not proxy or intercept opencode's calls — it generates data opencode
consumes on its own. The mapping (confirmed against opencode's published
`config.json` schema, `ProviderConfig`):

- `provider.<id>.npm` — `@ai-sdk/anthropic` for `anthropic-compatible`,
  `@ai-sdk/openai-compatible` for `openai-compatible`
- `provider.<id>.options.baseURL` ← datum `baseUrl` (omitted when absent)
- `provider.<id>.env` ← `[auth.env]` — the var *name*, so the secret never
  enters generated config; opencode reads it from the environment
- `provider.<id>.models` ← `{ <modelId>: { name: <modelId> } }`

Providers whose `kind` has no known opencode npm mapping are skipped with a
warning rather than emitting a broken entry. Live write merges only
datum-owned provider ids into an existing opencode config and is marked
experimental; `--dry-run` prints the block for review.

## Slice 2 (shipped)

- **Keychain / 1Password auth refs — DONE.** `auth` accepts `{ keychain: {
  service, account? } }` (macOS `security find-generic-password -w`, darwin-only,
  typed `SECRET_BACKEND_UNAVAILABLE` elsewhere) and `{ op: "op://vault/item/field"
  }` (1Password `op read`, typed error if `op` is absent), alongside `{ env }`.
  Materialization is LAZY: only `resolve()` (and the opt-in `doctor --probe`)
  reads a value; `resolveRef`/`list`/`sync` only probe *availability* (platform /
  binary presence — `op --version` at most) and never read the secret. The
  backend is an injectable `SecretRunner`, so tests never touch a real Keychain
  or 1Password. `ResolvedRef` carries a non-secret `AuthStatus` (kind, reference
  string, availability); the legacy `apiKeyEnv`/`apiKeySet` fields remain for the
  env case. The validator accepts exactly one of env/keychain/op and still
  rejects literal secrets in any field (op:// URIs are recognized as references,
  not secrets).
- **`openai-compatible` kind — DONE.** The resolver already accepted it (open
  enum); slice 2 adds the `doctor --probe` path (`POST {baseUrl}/chat/completions`,
  `max_tokens: 1`, Bearer auth, injectable fetch) and documents the opencode
  mapping (`@ai-sdk/openai-compatible`). The README support matrix records which
  kinds each consumer speaks; **traverse speaks anthropic-compatible only.**
- **`datum sync claude-code` — DONE.** Generator for Claude Code's native
  `~/.claude/settings.json` `env` block. Surface **confirmed** against
  docs.claude.com/en/docs/claude-code/settings and .../env-vars (checked 2026-07):
  `settings.json` has an `env` object exported into every session; `ANTHROPIC_BASE_URL`
  ("Override the API endpoint…") and `ANTHROPIC_MODEL` are recognized. Datum sets
  those two for a chosen `--role`; the API key is emitted **only** as an
  instruction naming its backend — never written into settings. Live write merges
  exactly the datum-owned env keys (clearing stale ones on re-sync) and is
  experimental; `--dry-run` is the confirmed path. Claude Code speaks the Anthropic
  API only, so this target rejects non-anthropic-compatible roles.
- **npm publish + release automation — STAGED.** `private` removed; `publishConfig`,
  `files` whitelist, repository/homepage set; `check:pack` gate; release-please
  config + manifest (0.2.0) and the `publish-npm.yml` / `release-please.yml`
  workflows mirror traverse (tag-triggered, verify matrix, tag-matches-version
  and tag-on-main guards, already-published skip, OIDC `--provenance`, plus the
  workflow-dispatch fallback since datum may not yet be in the release app's repo
  list). **Held before external release** pending owner ratification: the repo is
  NOT flipped public, no tag is pushed, nothing is published yet.

## Slice 3 (0.3.0, shipped)

- **Repo-level config path corrected to `.datum/config.json` — DONE.** Slice 1
  used `.kontour/datum.json`, ahead of the portfolio's `.kontourai/` (ignored) vs
  `.<product>/` (committed) directory convention being settled (precedent:
  `.veritas/` in veritas). Corrected before any external consumer depended on
  the old path (campfit's integration was unmerged and already targeted the new
  path), so this is a **clean cutover, no fallback, no deprecation window**:
  `repoConfigPath()` now defaults to `<cwd>/.datum/config.json`; the old
  `.kontour/datum.json` is simply not read. `datum doctor` and `datum list` now
  name the discovered config file path(s) rather than just a count. User-level
  config (`~/.config/kontour/datum.json`) is unaffected.

## Deferred

- **flow-agents role-routing adoption — DEFERRED.** The owner's other agent
  currently owns that repo (issues #287–#295 in flight); datum adoption there is
  out of scope for this slice.
- **campfit adoption — SEPARATE.** Ships on its own track, not here.
- **Doctor probe breadth.** Richer per-kind reachability classification beyond
  the two implemented probes.
- **Additional generators / consumers** as new tools need native config.
