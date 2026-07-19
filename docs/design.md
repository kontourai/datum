# Datum design notes

The design decisions this document used to hold (slices 1–3: the fixed
principle, config precedence, secret-reference-only auth, the former
zero-dependency validation posture, the generator-not-wrapper pattern, and the
slice 2/3 additions)
have been split verbatim into frozen ADRs and are no longer edited here.
This is a restructuring, not a rewrite — every decision's original prose is
preserved unchanged in its new file.

Those ADRs are history, not active dependency policy. The current policy is
[`Runtime dependencies`](decisions/runtime-dependencies.md): dependencies are
chosen by product boundary and engineering fitness, with no fixed count target.

- **Frozen history**: [`docs/adr/`](adr/index.md) — numbered, immutable
  (see the banner on each file). `docs/adr/0001`–`0007` are docs/design.md's
  slice-1/2/3 content, split one decision per file.
- **Current/living decisions**: [`docs/decisions/`](decisions/index.md) —
  the topic-keyed registry (see [`CONTEXT.md`](../CONTEXT.md#term-glossary)
  for the vocabulary the topic slugs are drawn from). Each frozen ADR's
  subject was seeded there as a `needs-decision` stub carrying the ADR as
  provenance; nothing has been re-decided, only indexed.

## Deferred

Not decisions — open scope notes carried forward unchanged:

- **flow-agents role-routing adoption — DEFERRED.** The owner's other agent
  currently owns that repo (issues #287–#295 in flight); datum adoption there is
  out of scope for this slice.
- **campfit adoption — SEPARATE.** Ships on its own track, not here.
- **Doctor probe breadth.** Richer per-kind reachability classification beyond
  the two implemented probes.
- **Additional generators / consumers** as new tools need native config.
