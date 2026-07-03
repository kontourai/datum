> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0005 — Generator, not wrapper (opencode sync)

Status: Accepted (2026-07-02). Original decision record, extracted verbatim
from docs/design.md ("Generator, not wrapper (opencode sync)") as part of
the ADR freeze.

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
