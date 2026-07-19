---
status: current
subject: HTTPS enforcement
decided: 2026-07-03
evidence:
  - kind: issue
    ref: https://github.com/kontourai/datum/issues/9
  - kind: session-archive
    ref: .kontourai/flow-agents/i9-https-policy/i9-https-policy--deliver.md
---
# HTTPS enforcement

`datum doctor --probe`, `datum discover`, `datum test-connection`, and explicit
`datum catalog refresh` are the only commands that make a live network request
(per `CONTEXT.md`'s
Configuration Resolution term — `resolve`/`resolveRef`/`list`/`sync` stay
pure/offline). Each of these commands enforces the same HTTPS policy before
any request is attempted:

- `https://` is always allowed, to any host.
- Loopback `http://` — `localhost`, the full `127.0.0.0/8` range, `::1`, and
  the IPv4-mapped IPv6 form `::ffff:127.x.x.x` — is allowed silently, since
  that is how Ollama/LM Studio-style local providers are typically configured.
- Any other (non-loopback) `http://` `baseUrl` is blocked by default, with an
  actionable error naming the offending URL and telling the user to use
  `https://` or pass `--allow-insecure`.
- `--allow-insecure` overrides the block and lets the request proceed, but a
  warning is still printed to stderr every time, since the request (and its
  API key) travels unencrypted.

The policy lives in exactly one place, `src/security.ts`. `enforceHttpsPolicy()`
makes the allow/block/warn decision for a single URL; `safeFetch()` is the one
wrapper that actually issues a key-bearing request, and it enforces the policy
on the initial URL **and re-enforces it on every redirect target** before
re-issuing the request. `safeFetch()` calls `fetch` with `redirect: "manual"`
precisely so the platform cannot silently auto-follow an
`https://` → `http://non-loopback` bounce and leak the key past the check;
instead it resolves each `Location` itself, re-runs the policy, and only then
re-sends (up to a redirect cap, after which it errors like any unreachable
endpoint). All network-touching functions (`probeAnthropicCompatible`,
`probeOpenaiCompatible` in `src/doctor.ts`, and `fetchOpenaiCompatibleModels`
in `src/discover.ts`, plus Bearing catalog acquisition in `src/catalog.ts`)
route through `safeFetch()` rather than copy-pasting the redirect policy per
command — `datum test-connection` reuses the doctor functions, so it inherits
the policy for free. Bearing catalog refresh additionally resolves and validates
the target addresses, then uses Node's HTTP(S) transport with a pinned lookup so
the actual connection cannot perform a second, unvalidated DNS resolution.
These paths use built-in Node URL, DNS, fetch, and HTTP(S) surfaces; they add no
transport dependency.

Non-goals: TLS verification options (e.g. disabling certificate checks), proxy
support, and cross-host `Authorization`-header stripping on redirect are
explicitly out of scope for this decision.
