# Datum Context

Datum is `@kontourai/datum`, the Kontour portfolio's AI provider/model/role
registry. It abstracts CONFIGURATION RESOLUTION, not invocation — it answers
"which backend, which model, whose key, what base URL" for a role or
`model@provider` ref and returns inert `{ provider, kind, baseUrl?, apiKey,
model }` data. It imports no AI SDK and makes no model calls. The deliberate
exceptions are `datum doctor --probe` (a single opt-in live reachability call
per provider), `datum discover` (fetches an openai-compatible provider's live
model list), `datum test-connection` (validates auth + reachability for one
provider), and `datum catalog refresh` (fetches a declared Bearing snapshot) —
all are explicit, opt-in commands.

## Term Glossary

- **Configuration Resolution**: datum's whole job, and the one thing it is
  not — invocation. Given a role name or a `model@provider` ref, datum
  answers *which backend, which model, whose key, what base URL* and stops;
  the caller's own SDK makes any model call. No AI SDK dependency, no API
  call, no runtime wrapping lives in the resolver itself. The deliberate,
  opt-in exceptions are `datum doctor --probe`, `datum discover`, `datum
  test-connection`, and `datum catalog refresh`.
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
  the secret-literal rule a plain JSON Schema cannot express. No ajv or other
  schema engine ships in the resolver's runtime path.
- **Runtime Dependencies**: libraries selected by product ownership and
  engineering fitness, not by a fixed dependency-count target. The exact
  `@kontourai/bearing` package currently owns compilation, parsing, and
  canonical serialization of Bearing catalog contracts. Datum does not
  duplicate those semantics. It imports no AI SDK because model invocation is
  outside Datum's boundary, not because dependencies are categorically
  forbidden. Frozen ADR 0004 records the former zero-dependency posture; the
  living decision registry carries the current policy.
- **Capability Catalog**: an optional, validated `capabilityCatalog` declaration
  in durable datum config that points to exactly one Bearing snapshot: either a
  `remoteUrl` or a `localPath`, with an optional positive `maxAgeSeconds`.
  Remote URLs are credential-free endpoints; embedded userinfo, query
  parameters, and fragments are rejected from durable config.
  Remote snapshots are validated before they enter the disposable,
  source-keyed cache at `.kontourai/datum/bearing`; the catalog digest names the
  immutable snapshot. Immutable state candidates are ordered by catalog
  `asOf`; distinct digests at one `asOf` are a typed source conflict. This
  prevents out-of-order processes from regressing active state without a lock
  or silently choosing between incompatible revisions. The
  default remote transport binds DNS validation to the actual connection and
  applies a bounded overall deadline to every hop. Injected transports receive
  the validated address set and own the matching pinned connection.
  Config precedence remains per-key: a repo source discriminator replaces the
  user source discriminator atomically while unrelated catalog keys such as
  `maxAgeSeconds` still inherit unless the repo overrides them.
  `catalog status` and library load are offline-only; `catalog refresh` alone
  fetches, conditionally revalidates with ETags, and can report a typed fallback
  to a still-fresh cache. Metadata is catalog provenance, never catalog body or
  source path, query, or userinfo secrets.
- **Capability Role Resolution**: the versioned, offline
  `resolveCapabilityRole(role, request, opts)` API. A durable role is either a
  legacy fixed model ref or a closed policy with Bearing rank requirements,
  preferences, locality, and an optional explicit fallback. The request owns
  the normalized, versioned (`datum.capability-role.request/v1`) inventory and binds each opaque candidate id to a Datum
  provider/model and a concrete Bearing model/execution profile. Datum passes
  the complete inventory to Bearing first, retains Bearing exclusions/evidence/
  uncertainty/advisory projections, and then enforces configured provider-model membership,
  non-materializing auth availability, and locality. Caller-declared local
  candidates satisfy `local-only` only when the provider's effective configured
  base URL is also a loopback endpoint; an absent or remote route is not proven
  local. Overrides and fallback
  never escape that inventory. Resolution loads only a local snapshot or remote
  cache and never fetches. Datum uses Bearing rank v2 for policy/request-declared
  generic advisories and passes each candidate's projections through unchanged;
  it does not interpret or synthesize them from catalog observations.
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
- **Release Automation**: Datum's authority-separated package pipeline. Local
  verification builds one exact-allowlisted tarball and proves its root import
  and CLI in a clean consumer. A read-only workflow preflight proves the tag,
  package version, and main ancestry. A separate no-OIDC job builds, validates,
  hashes, and transfers the exact artifact. Only then does the
  environment-protected publish job receive OIDC; it checks the transferred
  digest, fails closed on registry errors, and publishes without checking out
  or executing repository code. CI, Release Please, and publication are
  manual-only while hosted CI is out of budget.
- **HTTPS Enforcement**: the policy `datum doctor --probe`, `datum
  discover`, `datum test-connection`, and `datum catalog refresh` apply to every outbound request
  before it is sent. `https://` is always allowed; loopback `http://`
  (`localhost`, the `127.0.0.0/8` range, `::1`) is allowed silently, since
  that is how Ollama/LM Studio-style local providers are typically
  configured. A non-loopback `http://` `baseUrl` is blocked by default with
  an actionable error; passing `--allow-insecure` proceeds anyway but still
  emits a warning. Enforced once via `enforceHttpsPolicy()` in
  `src/security.ts`, consumed by all network-touching functions
  rather than re-implemented per command.

## Decision Registry

Frozen design history lives in numbered ADRs under
[`docs/adr/`](docs/adr/index.md) (immutable — see the banner on each file).
Current and superseding decisions for the terms above live in the
topic-keyed registry at [`docs/decisions/`](docs/decisions/index.md); consult
that index before recording a new decision (revise an existing topic file, or
create one keyed to a term in this glossary — add the term here first if it
is missing).
