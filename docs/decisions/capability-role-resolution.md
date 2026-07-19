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
evidence/uncertainty, exclusions, and override/fallback state. Bearing rank v1
does not provide advisory projection recommendations. Datum must not infer them
from model names or observations; Bearing#22 owns that future generic feature.
