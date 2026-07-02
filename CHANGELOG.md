# Changelog

## [0.2.0](https://github.com/kontourai/datum/compare/v0.1.0...v0.2.0)

### Features

- **Keychain / 1Password auth refs.** `auth` now accepts `{ keychain: { service, account? } }`
  (macOS Keychain, resolved via `security find-generic-password -w`, darwin-only)
  and `{ op: "op://vault/item/field" }` (1Password CLI `op read`) in addition to
  `{ env }`. All three stay reference-only and are materialized LAZILY — only
  `resolve()` (and `doctor --probe`) read the value; `resolveRef`, `list`, and
  `sync` never invoke the backing tool, they only report its availability. The
  secret backend is injectable (`SecretRunner`) so nothing spawns in tests.
  New typed errors: `SECRET_BACKEND_UNAVAILABLE`, `SECRET_LOOKUP_FAILED`.
- **`openai-compatible` kind end to end.** `doctor --probe` now probes
  `openai-compatible` providers with a `max_tokens: 1` `POST {baseUrl}/chat/completions`
  (Bearer auth); the opencode generator already maps it to `@ai-sdk/openai-compatible`.
- **`datum sync claude-code --role <name> [--dry-run]`.** Generates the native
  Claude Code `~/.claude/settings.json` `env` block (`ANTHROPIC_BASE_URL` when the
  provider has one, `ANTHROPIC_MODEL`) for a role. The API key is emitted strictly
  as an instruction naming its backend — never written into settings. Live write
  merges only the datum-owned env keys; `--dry-run` is the confirmed path.
- **`AuthStatus` on `ResolvedRef`.** `resolveRef` / `list` / `doctor` now report
  the auth kind (env / keychain / op), a non-secret reference string, and whether
  the backing tool/var is available — computed without reading the secret.

### Documentation

- README provider-kind × consumer support matrix (which kinds opencode, Claude
  Code, and traverse each speak); keychain/op auth docs; install/quickstart.

## [0.1.0](https://github.com/kontourai/datum/releases/tag/v0.1.0)

### Features

- Initial release: provider/model/role registry with a config resolver that
  answers *which backend, which model, whose key, what base URL* for a role or
  `model@provider` ref and returns inert `{ provider, kind, baseUrl?, apiKey, model }`.
- Two-file deep-merge config discovery (`~/.config/kontour/datum.json` base,
  `.kontour/datum.json` overlay) with `DATUM_ROLE_*` / `DATUM_BASEURL_*` escape hatches.
- Secret-reference-only auth (`{ env }`) with a literal-secret-rejecting validator;
  zero runtime dependencies; hand-rolled validation mirroring `datum.schema.json`.
- `datum resolve` / `list` / `doctor` (with opt-in `--probe`) CLI, and
  `datum sync opencode` native provider-block generator.
