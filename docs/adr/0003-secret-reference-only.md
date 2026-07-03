> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0003 — Secret-reference-only auth

Status: Accepted (2026-07-02). Original decision record, extracted verbatim
from docs/design.md ("Secret-reference-only") as part of the ADR freeze.
This is the slice-1 snapshot: at the time this decision was recorded, `env`
was the only permitted auth backend. Keychain/1Password backends were added
in slice 2 (ADR 0006) on the same reference-only principle; this file is
frozen history and is not edited to reflect that later extension.

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
