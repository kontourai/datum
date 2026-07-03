> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0004 — Zero runtime dependencies / hand-rolled validation

Status: Accepted (2026-07-02). Original decision record, extracted verbatim
from docs/design.md ("Zero runtime dependencies / hand-rolled validation")
as part of the ADR freeze.

The runtime path pulls in nothing. The config surface is tiny and closed, so
validation is a direct hand-rolled function (validate.ts) rather than ajv or
another JSON-schema engine: smaller, faster to load, and no supply-chain tail in
a CLI whose whole job is to resolve config. `datum.schema.json` remains the
normative, editor-facing schema; the validator mirrors it and additionally
enforces the secret-literal rule, which a plain schema cannot express.
