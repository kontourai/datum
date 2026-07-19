---
status: current
subject: Runtime dependencies
decided: 2026-07-18
evidence:
  - kind: issue
    ref: https://github.com/kontourai/datum/issues/14
  - kind: adr
    ref: ../adr/0004-zero-deps-validation.md
---
# Runtime dependencies

Datum has no fixed runtime-dependency count target. A dependency is justified
when it preserves the intended product authority, removes duplicate semantics,
or provides a safer and more maintainable implementation than local code after
its security, release, and ownership costs are considered. Dependency avoidance
is not an architectural goal by itself.

Datum therefore consumes an exact version of `@kontourai/bearing`. Bearing owns
the capability-catalog schema semantics, deterministic compilation, parsing,
and canonical serialization. Reimplementing that contract in Datum would create
two authorities and make catalog digests untrustworthy across products.

This living decision supersedes ADR 0004's former zero-runtime-dependency
posture without weakening its reason for hand-rolled Datum config validation.
Datum still imports no AI SDK because model invocation is outside its product
boundary. Its config validator remains hand-rolled while that closed surface is
small enough for direct validation to be clearer; this is a current fitness
decision, not a prohibition on adopting a schema library if the surface grows.
Future dependencies use the same boundary, correctness, maintenance, and
supply-chain analysis rather than a categorical allow or deny rule.

Datum pins Bearing exactly rather than accepting a semver range. A release must
verify the packed artifact in a clean consumer so an undeclared or unavailable
contract package cannot pass repository-local tests and fail for users.
