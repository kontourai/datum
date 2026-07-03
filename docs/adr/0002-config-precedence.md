> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0002 — Config precedence: file layer, resolution layer, escape hatches, ref dispatch

Status: Accepted (2026-07-02). Original decision record, extracted verbatim
from docs/design.md ("Precedence") as part of the ADR freeze.

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
