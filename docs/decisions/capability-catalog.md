---
status: current
subject: Capability Catalog
decided: 2026-07-18
evidence:
  - kind: issue
    ref: https://github.com/kontourai/datum/issues/14
  - kind: doc
    ref: CONTEXT.md
---
# Capability Catalog

Datum may declare exactly one Bearing snapshot source in durable config:
`remoteUrl` or `localPath`, plus an optional positive `maxAgeSeconds`. This is
catalog provenance for configuration consumers, not a model invocation path.
Remote URLs must be credential-free HTTP(S) endpoints without userinfo, query
parameters, or fragments; durable config never carries a signed URL or token.
During config overlay, a repo source discriminator replaces the user source
discriminator atomically; other keys retain Datum's normal per-key precedence.

Local paths are repository-relative, may not traverse upward, and must remain
under the real working directory after symlink resolution. Local snapshots are
validated directly. A remote snapshot is fetched only by
the deliberate `catalog refresh` operation; ordinary library load and `catalog
status` never make a request. Refresh uses the shared redirect-aware HTTPS
policy, supports ETag revalidation, caps the response body, validates with
Bearing, and writes immutable digest-addressed snapshots plus immutable
source-keyed state candidates under `.kontourai/datum/bearing`. Datum selects
the deterministic maximum state candidate by catalog `asOf`, so completion
order across processes cannot regress the active catalog. Distinct digests with
the same `asOf` are an explicit conflict rather than an arbitrary winner; a
publisher must advance `asOf` for every revision. The default transport validates
all resolved addresses and pins the connection to those addresses at every
redirect hop, closing the DNS-rebinding gap between policy and I/O. Each hop
also has a bounded overall deadline so a peer cannot hold refresh open by
withholding headers or slowly streaming a sub-limit body. An injected transport
receives the validated addresses and is contractually responsible for using
only those addresses.

When refresh fails, Datum preserves the prior active state. It may return a
valid non-stale cached snapshot only with a typed fallback diagnostic; if there
is no valid cache, or freshness has expired, it raises the typed failure. CLI
and library metadata expose source kind/redacted origin, digest, age, cache
state, and diagnostics without emitting source path/query/userinfo secrets or
the full catalog body by default.
