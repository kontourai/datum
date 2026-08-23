---
status: current
subject: Secret references
decided: 2026-08-23
evidence:
  - kind: adr
    ref: docs/adr/0003-secret-reference-only.md
  - kind: adr
    ref: docs/adr/0006-slice-2-additions.md
---
# Secret references

Datum owns the portable secret-reference grammar, its strict validation, and
explicit lazy materialization. A reference names exactly one supported backend:
`{ env }`, `{ keychain }`, or `{ op }`; it never embeds a secret literal.
`parseAuthRef()` is the shared validation authority for both provider config and
standalone consumers. `materializeAuthRef()` reads only the selected backend and
preserves typed materialization failures. `describeAuth()` remains
non-materializing and reports only a reference and availability.

Consumers own secret storage, authorization grants, audit policy, and invocation.
Datum does not add secret CRUD, grant management, provider networking, or model
calls. This keeps the reusable reference seam narrow: applications may keep
their existing credential stores and authority model while sharing one correct,
secret-reference-only grammar and materialization implementation.

The frozen ADRs remain provenance for the reference-only principle and the
three supported backends; this living decision records their current public
library form.
