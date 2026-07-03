> **FROZEN — immutable history.** Superseding/current decisions live in [`docs/decisions/`](../decisions/index.md). Do not edit.

# ADR 0007 — Repo-level config path corrected to .datum/config.json

Status: Accepted (2026-07-02). Original decision record, extracted verbatim
from docs/design.md ("Slice 3 (0.3.0, shipped)") as part of the ADR freeze.

- **Repo-level config path corrected to `.datum/config.json` — DONE.** Slice 1
  used `.kontour/datum.json`, ahead of the portfolio's `.kontourai/` (ignored) vs
  `.<product>/` (committed) directory convention being settled (precedent:
  `.veritas/` in veritas). Corrected before any external consumer depended on
  the old path (campfit's integration was unmerged and already targeted the new
  path), so this is a **clean cutover, no fallback, no deprecation window**:
  `repoConfigPath()` now defaults to `<cwd>/.datum/config.json`; the old
  `.kontour/datum.json` is simply not read. `datum doctor` and `datum list` now
  name the discovered config file path(s) rather than just a count. User-level
  config (`~/.config/kontour/datum.json`) is unaffected.
