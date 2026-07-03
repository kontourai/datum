> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0001 — Configuration resolution, not invocation

Status: Accepted (2026-07-02). Original decision record for datum's core
identity, extracted verbatim from docs/design.md ("The fixed principle")
as part of the ADR freeze (issue #4 companion, decision-registry adoption).

No AI SDK dependencies. No API calls in the core resolver. No wrapping of
runtimes. The resolver returns inert data (`{ provider, kind, baseUrl?, apiKey,
model }`); the caller's own SDK makes any model call. The single, opt-in
exception is `datum doctor --probe` (below).
