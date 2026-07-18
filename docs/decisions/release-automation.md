---
status: current
subject: Release automation
decided: 2026-07-18
evidence:
  - kind: adr
    ref: docs/adr/0006-slice-2-additions.md
  - kind: issue
    ref: https://github.com/kontourai/datum/issues/16
  - kind: issue
    ref: https://github.com/kontourai/datum/issues/17
---
# Release automation

Datum releases one exact artifact. The package gate creates a real tarball,
compares every file with an explicit allowlist, installs it with lifecycle
scripts disabled in a clean consumer, imports the public API, and runs the CLI.
`prepublishOnly` applies the full verification gate to local publication.

Workflow authority is staged. A read-only preflight proves that the ref is a
`v*` tag matching `package.json` and that its commit is on main. Verification
and exact-artifact construction run without OIDC, and dependency installation
cannot run lifecycle scripts. The artifact is hashed and transferred between
jobs. Only the final `npm-publish` environment job receives an ID token; it does
not check out or execute repository code, verifies the transferred digest,
accepts only a structured npm `E404` as not-yet-published, fails closed on every
other registry error, and publishes the validated tarball with provenance and
lifecycle scripts disabled.

Actions are pinned to reviewed commits and the Release App token is scoped to
this repository with only contents and pull-request write access. CI, Release
Please, and publication remain manual-only while hosted CI is out of budget.
Restoring automatic triggers and configuring the trusted publisher require
explicit activation rather than being implied by the workflow files.
