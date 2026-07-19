---
status: current
subject: Capability role resolution
decided: 2026-07-18
evidence:
  - kind: issue
    ref: https://github.com/kontourai/datum/issues/15
  - kind: issue
    ref: https://github.com/kontourai/bearing/issues/22
---
# Capability role resolution

Datum retains fixed model-ref roles and adds a closed policy role shape for
offline, inventory-bounded selection. Callers supply launchable candidate
bindings; Datum never discovers or invents candidates. Bearing ranks the full
caller inventory against the durable plus additive policy rules. Datum then
enforces its own provider configuration, model membership, secret-backend
availability without materialization, and locality policy.

Session fixed overrides, then `DATUM_ROLE_<NAME>`, then durable fixed refs are
authoritative only when they identify exactly one inventory candidate that
passes those Datum checks. Missing or stale catalog state can use only an
explicit policy fallback under the same boundary; otherwise the API returns a
typed no-target result with diagnostics. Ordinary resolution is offline.

The result carries Bearing digest/as-of, Datum catalog metadata, ranking
evidence/uncertainty, exclusions, and override/fallback state. Durable policy
and request advisories are additive and use Bearing rank v2. Datum passes the
exact per-candidate projection status, scalar value/unit, evidence, and
uncertainty through to ranked targets and exclusions, with selected-target
advisories mirrored at the result root. Datum does not inspect catalog internals
or infer advisory identity or meaning from model names. Fixed, override, and
fallback paths carry empty advisory lists because they bypass Bearing. The
composed durable and request advisory set retains Bearing's unique-id, count,
UTF-8 text, and candidate-projection-cell limits.
