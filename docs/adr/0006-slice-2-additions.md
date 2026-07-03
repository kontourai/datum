> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0006 — Slice 2: keychain/1Password auth, openai-compatible kind, claude-code sync, publish scaffolding

Status: Accepted (2026-07-02). Original decision record, extracted verbatim
from docs/design.md ("Slice 2 (shipped)") as part of the ADR freeze.

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
