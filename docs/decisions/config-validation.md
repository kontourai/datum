---
status: current
subject: Config validation
decided: 2026-07-18
evidence:
  - kind: adr
    ref: docs/adr/0004-zero-deps-validation.md
  - kind: issue
    ref: https://github.com/kontourai/datum/issues/14
---
# Config validation

Datum directly validates its closed configuration shape and mirrors the
normative `datum.schema.json`. Direct validation remains a good fit while the
surface is small: it keeps typed secret-reference checks explicit and makes
runtime/schema parity testable without a general schema engine.

The schema documents, and runtime validation enforces, semantic constraints
that draft 2020-12 cannot express directly: uniqueness by one object property,
limits after durable and request arrays are composed, and UTF-8 byte limits
owned by an imported Bearing contract. These are not independent Datum
reinterpretations of ranking semantics.

This does not preserve ADR 0004 as a blanket zero-dependency rule. If the config
surface grows enough that a maintained validator is safer or clearer, Datum may
adopt one under the current
[`Runtime dependencies`](./runtime-dependencies.md) decision. Config validation
owns Datum config only; Bearing remains authoritative for Bearing catalog
validation rather than being reimplemented here.
