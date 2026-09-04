# ADR 0004 — Explicit version handshake that fails closed

Status: accepted (2026-09-04)

## Context

The Chrome Web Store updates the extension silently and on Chrome's schedule. The local npm package is
updated by the user running `dsh plugin ... update`. These two events are not ordered, so a browser
running extension `0.2.0` will meet a broker running `0.1.0`, and the reverse happens when a user
installs a newer package before Chrome has rolled the extension out.

A protocol mismatch that is merely *tolerated* produces undefined behavior in a component that drives
a signed-in browser. That is the failure mode this project must never have.

## Decision

The handshake carries, in both directions:

- `protocolVersion` — an integer, bumped on any wire-incompatible change.
- `connectorVersion` — the semantic version of the sending component.
- `brokerVersion` / `extensionVersion` — the concrete peer identity.
- `capabilities` — the action kinds and optional features the sender actually implements.

The broker rejects a client whose `protocolVersion` differs from its own, with a typed
`version_mismatch` close reason naming both versions and which side is older. The extension surfaces
that as a dedicated "update required" panel state naming the exact command to run.

Capability negotiation is separate from version gating: within one protocol version, a peer may
implement a subset of action kinds. The intersection is what the plugin registers as DSH tools, so the
model is never offered a tool the browser cannot perform.

## Rationale

- Equality on `protocolVersion` rather than a range makes the check decidable and testable, and moves
  every compatibility question into an explicit bump plus a migration test.
- Naming which side is older turns an error into an instruction. "Extension 0.2.0 needs connector
  0.2.0; you have 0.1.0. Run `dsh plugin --profile web update @corsen-ai/dsh-browser-connector`" is
  actionable; "handshake failed" is not.
- Registering only the intersection means a capability added to the extension does not appear as a
  broken tool while an older package is installed.

## Consequences

- Every protocol change requires a bump plus a mismatch test proving the older peer is refused, not
  merely warned.
- The panel must have a first-class "update required" state, not a generic error (`docs/ARCHITECTURE.md`).
- The broker's version is checked in both handshake phases, so a stale detached broker left running by
  a previous install cannot serve a newer extension.
