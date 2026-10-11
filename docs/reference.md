# Library API reference

`@kontourai/datum` has one entry point, `import { … } from "@kontourai/datum"`.
This page lists what it exports, grouped by job. The CLI (`datum`, from
`bin/datum.mjs`) is a thin front-end over these functions; its commands are
listed in the [README](../README.md#cli). The config file format is defined by
[`datum.schema.json`](../datum.schema.json).

Nothing on this page makes a network call except the functions marked
**network**, and none of those runs unless you call it.

## Resolve options

Most functions take a `ResolveOptions` object. Every field is optional.

| Field | Meaning |
| --- | --- |
| `config` | A pre-loaded `DatumConfig`. When set, no file is read; the object is validated directly. |
| `cwd` | Directory used to find the repo-level `.datum/config.json`. Default: `process.cwd()`. |
| `home` | Directory used to find the user-level `~/.config/kontour/datum.json`. Default: `os.homedir()`. |
| `userConfigPath` | Explicit user config path. Overrides `home`. |
| `repoConfigPath` | Explicit repo config path. Overrides `cwd`. |
| `env` | Environment overrides, merged over `process.env`. They win for both the escape hatches and `{ env }` key lookups. |
| `secretRunner` | A `SecretRunner` for keychain and 1Password reads. Default: `defaultSecretRunner`. |

The CLI flags `--cwd`, `--repo-config-path`, and `--user-config-path` map to
`cwd`, `repoConfigPath`, and `userConfigPath`.

## Resolving a ref

```ts
import { resolve, resolveRef } from "@kontourai/datum";

const routing = resolveRef("extraction-default"); // no secret read
const target = resolve("extraction-default");     // reads the key
```

- `resolve(ref, opts?) → ResolvedTarget` returns
  `{ provider, kind, baseUrl?, apiKey, model }` and reads the key from the
  provider's auth backend.
- `resolveRef(ref, opts?) → ResolvedRef` returns
  `{ provider, kind, baseUrl?, model, auth, apiKeyEnv?, apiKeySet }` without
  reading the key. `auth` is an `AuthStatus`: `{ kind, ref, envVar?, available, tool? }`.
  For `env`, `available` means the variable is set; for `keychain` and `op`, it
  means the backing tool is present.
- `envKey(name)` returns the escape-hatch suffix for a name: upper-cased, with
  every run of other characters replaced by `_`.

How a ref is resolved:

1. A ref containing `@` is a model ref, `model@provider`. It is never a role.
   An unknown provider throws `UNKNOWN_PROVIDER`.
2. A bare ref is looked up as a role first. `DATUM_ROLE_<NAME>` (from `opts.env`
   or `process.env`) replaces the role's target. A role whose value is a string
   resolves as that model ref. A role whose value is a capability policy throws
   `INVALID_CONFIG`; use `resolveCapabilityRole()` for those.
3. A bare ref that is not a role is a bare model. Exactly one provider must list
   it in `models`: none throws `UNKNOWN_ROLE`, more than one throws
   `AMBIGUOUS_MODEL`.
4. `DATUM_BASEURL_<PROVIDER>` replaces the provider's `baseUrl`. Datum does not
   read a downstream SDK's own variables, such as `ANTHROPIC_BASE_URL`.

## Loading config

- `loadConfig(opts?) → { config, sources }` reads the user file, then the repo
  file, deep-merges them, and validates the result. `sources` lists the paths
  actually read, user first. A missing file is skipped; a file that cannot be
  read or is not valid JSON throws `INVALID_CONFIG` naming the path.
- `deepMerge(base, overlay)` merges objects per key, recursively. Arrays and
  scalars from `overlay` replace those in `base`, so a repo file's `models`
  list replaces the user file's list.
- `userConfigPath(opts)` and `repoConfigPath(opts)` return the paths
  `loadConfig` would read.
- `validateConfig(value) → DatumConfig` validates a config object against the
  schema rules and the secret-literal rule, and throws on the first problem.

For `capabilityCatalog`, a repo-level `remoteUrl` or `localPath` replaces the
user-level source rather than merging into a mixed source; `maxAgeSeconds`
still inherits unless the repo sets it.

## Auth references

- `parseAuthRef(value) → AuthRef` accepts exactly one of `{ env }`,
  `{ keychain: { service, account? } }`, or `{ op }`. It rejects unknown keys
  and values that look like a pasted secret. It reads nothing.
- `materializeAuthRef(ref, { env?, secretRunner? }?) → string` parses the
  reference, then reads that one secret. A missing or empty variable throws
  `MISSING_ENV`.
- `describeAuth(auth, env, runner) → AuthStatus`, `authKind(auth)`, and
  `authRefString(auth)` describe a reference without reading the secret.
- `looksLikeSecretLiteral(value)` is the check the validator uses to reject
  key-looking literals.
- `defaultSecretRunner` reads keychain items with
  `/usr/bin/security find-generic-password -w` (macOS only) and 1Password
  references with `op read`. Implement the `SecretRunner` interface
  (`keychainAvailable`, `opAvailable`, `readKeychain`, `readOp`) to replace it,
  for example in tests.

## Capability roles

`resolveCapabilityRole(role, request, opts?) → CapabilityRoleResult` resolves a
role against a caller-supplied runtime inventory. It is offline: it reads the
catalog from `opts.catalog` or from the local cache, and never fetches one.

- `request` must have `schemaVersion: "datum.capability-role.request/v1"`, a
  Bearing `task`, and an `inventory` of candidates. It may add
  `requirements`, `preferences`, `advisories`, and a `fixedOverride` model ref.
- `opts` extends `ResolveOptions` with `catalog`, `providerBindings`,
  `cacheRoot`, and `now`.
- The result reports `mode` (`fixed` or `policy`), `posture`
  (`override`, `durable`, `fallback`, or `unavailable`), the selected `target`,
  `alternatives`, `exclusions`, catalog provenance, `override` and `fallback`
  state, and `diagnostics`.

The README section [Capability roles](../README.md#capability-roles) explains
the precedence, locality, and `providerBindings` rules. The CLI equivalent is
`datum resolve-policy <role> --request <json-file>`.

## Capability catalog

- `loadCapabilityCatalog(opts?)` is offline. A `localPath` source is read and
  validated directly; a `remoteUrl` source is read only from the cache under
  `<cwd>/.kontourai/datum/bearing` (override with `cacheRoot`).
- `refreshCapabilityCatalog(opts?)` (**network**) fetches a `remoteUrl`
  source, validates it with Bearing, and saves it to the cache. If the fetch
  fails and a cached catalog that is not stale exists, it returns that catalog
  with a fallback diagnostic; otherwise it throws. For a `localPath` source it
  behaves like `loadCapabilityCatalog`. Extra options: `transport`,
  `allowInsecure`, `requestTimeoutMs`, `maxResponseBytes`, and `resolveHost`.
- The `DEFAULT_CATALOG_*` constants are the default size, count, and timeout
  limits.

The CLI equivalents are `datum catalog status` and `datum catalog refresh`.

## Config generators

Generators emit references, never secret values.

- `generateOpencodeProviderBlock(config) → { block, warnings }` builds
  opencode's `provider` block. Providers whose kind has no known opencode
  package, or whose auth is not `{ env }`, are skipped with a warning.
  `npmForKind(kind)` returns the package used for a kind.
- `mergeIntoOpencodeConfig(existing, block)` returns a new config with Datum's
  provider ids replaced and everything else kept.
- `generateClaudeCodeEnv(role, resolvedRef)` builds Claude Code's settings
  `env` block (`ANTHROPIC_MODEL`, plus `ANTHROPIC_BASE_URL` when set) and an
  instruction naming where the key lives. It throws `INVALID_CONFIG` unless the
  provider kind is `anthropic-compatible`.
- `mergeIntoClaudeCodeSettings(existing, env)` returns new settings with only
  `CLAUDE_CODE_MANAGED_ENV_KEYS` replaced.

The CLI equivalents are `datum sync opencode` and `datum sync claude-code`.

## Diagnostics

- `runDoctor({ probe?, fetchImpl?, allowInsecure?, …ResolveOptions })` returns
  `{ ok, checks, warnings }`. It checks that config parses, that every fixed role
  resolves, and that every provider's key backend is available, without reading
  a key. Policy roles are reported as `skip`. With `probe: true` (**network**)
  it also sends one request per provider through
  `probeAnthropicCompatible` or `probeOpenaiCompatible`.
- `discoverModels(providerId, opts?)` (**network**) lists the model ids from an
  `openai-compatible` provider's `GET {baseUrl}/models`. It reports, rather
  than throws, an unknown provider or an unsupported kind.
  `fetchOpenaiCompatibleModels` is the underlying request.
- `testConnection(providerId, opts?)` (**network**) checks one provider's auth
  and reachability. Failures are classified as `auth`, `unreachable`,
  `incompatible`, or `insecure`. Kinds other than the two implemented ones are
  reported as `skip`.
- `enforceHttpsPolicy(url, { allowInsecure? })` and `safeFetch` apply the HTTPS
  policy these functions share: `https://` and loopback `http://` are allowed,
  other `http://` is blocked unless `allowInsecure` is set, and the policy is
  re-checked on every redirect.

## Errors

Every expected failure is a `DatumError` with a stable `code` (type
`DatumErrorCode`). The CLI prints `CODE: message` to stderr and exits `1`.

| Code | When |
| --- | --- |
| `UNKNOWN_ROLE` | A bare ref is neither a role nor a model any provider offers. |
| `UNKNOWN_PROVIDER` | A `model@provider` ref names a provider that is not configured. |
| `UNKNOWN_MODEL` | A role points at a model no provider offers. |
| `AMBIGUOUS_MODEL` | A bare model is offered by more than one provider. Use `model@provider`. |
| `MISSING_ENV` | An `{ env }` key is materialized but the variable is unset or empty. |
| `INVALID_CONFIG` | A config file cannot be read, is not valid JSON, or fails validation. Also raised by `resolve()` on a policy role. |
| `SECRET_LITERAL` | An auth field holds what looks like a pasted secret, or an auth object has a key other than `env`, `keychain`, or `op`. |
| `SECRET_BACKEND_UNAVAILABLE` | A keychain read off macOS, or a 1Password read without `op` installed. |
| `SECRET_LOOKUP_FAILED` | The backend ran but returned no secret (item missing, empty, or a non-zero exit). |
| `CAPABILITY_CATALOG_*` | A catalog load or refresh failed. The suffix names why: `UNAVAILABLE`, `MALFORMED`, `UNSUPPORTED_SCHEMA`, `DIGEST_MISMATCH`, `CONFLICT`, `STALE`, `RESPONSE_TOO_LARGE`, `LIMIT_EXCEEDED`, `INSECURE_URL`, `PATH_OUTSIDE_ROOT`, or `CACHE_CORRUPT`. |
| `INTERNAL_ERROR` | The CLI caught an unexpected, non-Datum error. |
