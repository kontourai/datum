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

`datum doctor --probe`, `datum discover`, and `datum test-connection` are the
only commands that make a live network request (per `CONTEXT.md`'s
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
endpoint). All three network-touching functions (`probeAnthropicCompatible`,
`probeOpenaiCompatible` in `src/doctor.ts`, and `fetchOpenaiCompatibleModels`
in `src/discover.ts`) route through `safeFetch()` rather than copy-pasting the
policy per command — `datum test-connection` reuses those same functions, so it
inherits the policy for free. This uses only the built-in `URL`/`fetch`
globals; it adds zero new runtime dependencies.

Non-goals: TLS verification options (e.g. disabling certificate checks), proxy
support, and cross-host `Authorization`-header stripping on redirect are
explicitly out of scope for this decision.
