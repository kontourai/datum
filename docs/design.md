# Datum design notes (slice 1)

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

1. repo-level `.kontour/datum.json` — overlay, wins per-key
2. user-level `~/.config/kontour/datum.json` — base

Deep-merge means objects merge recursively; arrays and scalars from the overlay
*replace* (a provider's `models` array is replaced wholesale by the repo file,
not concatenated). A missing file is skipped; a present-but-unparseable file is a
hard `INVALID_CONFIG` error naming the path.

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

## Slice 2+ candidates

- **Keychain / secret-manager auth refs** — extend `auth` beyond `{ env }` to
  `{ keychain: "…" }` / `{ op: "…" }` (1Password, macOS Keychain), still
  reference-only, materialized on demand.
- **`openai-compatible` kind** — resolver + probe + opencode `npm` mapping (the
  enum and generator already reserve it).
- **Claude Code settings generator** — a `sync claude-code` target emitting
  Claude Code's native settings shape, same generator-not-wrapper discipline.
- **flow-agents role-routing adoption** — have flow-agents resolve its model
  roles through datum instead of bespoke config.
- **npm publish + release automation** — flip `private:false` and add the
  release-please + publish workflows (as in traverse) *after* the `@kontourai/datum`
  name is ratified for npm. Intentionally omitted from slice 1.
- **Doctor probe breadth** — per-kind probe implementations and richer
  reachability classification beyond the anthropic-compatible `/v1/messages` path.
