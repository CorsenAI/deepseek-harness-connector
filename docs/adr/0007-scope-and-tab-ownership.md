# ADR 0007 — Scope identity and single-owner tab registry

Status: accepted (2026-09-04)

## Context

The product invariant is that a browser action must reach exactly one intended DSH session's tab, and
must fail rather than guess. That requires an identity that is stable across a service-worker restart,
a DSH restart, and a Chrome restart, and that distinguishes two sessions running at the same time in
two different DSH profiles.

DeepSeek Harness supplies the session half of that identity directly: `exec.agent.id` is a `SessionId`
(`packages/core/agent/src/types.ts`), and profiles are named directories under `$DSH_HOME/profiles/`.

## Decision

A **scope** is the pair `(profileId, sessionId)`, keyed as `profileId  sessionId`.

- `profileId` is the DSH profile the plugin instance was loaded into, plus the DSH home it belongs to,
  so two homes cannot collide.
- `sessionId` is `exec.agent.id`, read at tool-call time and never cached across calls.

A **binding** maps one scope to an ordered set of `tabIds` plus one `activeTabId` drawn from that set.
The extension owns the registry and is authoritative for whether a tab still exists. The broker owns
which *browser* holds each scope.

Three rules make routing decidable:

1. **One tab has exactly one owner.** Attaching a tab to a scope removes it from any other scope
   first. Two sessions can never both believe they control the same signed-in page.
2. **No binding, no action.** A tool call whose scope has no binding, or whose `exec.agent` is absent,
   fails with a typed error. There is no fallback to the globally active tab, the last-used tab, or
   the first controllable tab.
3. **Ownership is revalidated after the action, not only before.** When the result comes back, the
   broker re-checks that the same browser still owns the scope and that the same tab is still the
   scope's active tab. A result that no longer satisfies that is dropped with an error rather than
   returned to the model.

Rule 3 is what stops a race in which the user re-attaches a tab to another session while an action is
in flight; without it, session B would receive page content from a tab it briefly owned.

## Cross-browser transfer

An explicit attachment in a second Chrome profile transfers the whole scope to that browser. The broker
sends `binding_revoked` to the previous browser, which drops its stale local binding. A later full-state
sync from a reconnecting browser is **restoration only** and cannot silently reclaim a scope; the user
must attach it again. This ordering means the old owner loses authority before the new owner gains
effective authority, never the reverse.

## Browser identity

Each extension installation mints one persistent random `browserId` on first run and keeps it in
`storage.local`. Identity is never derived from the Google account, the profile directory, or a window
title — none of which the extension should read, and all of which are unstable.

## Consequences

- Tab ids are Chrome-process-local and are reused after a restart. A restored binding is validated
  against live tabs before use; a tab that cannot be proven to be the same tab must be attached again.
- The registry is pure data with no Chrome API calls, so every ownership rule above is unit-testable
  without a browser (`companion/src/bindings.ts`, `extension/src/bindings.js`).
- Closing a scope's last tab legitimately removes the binding while a `close_tab` result is in flight.
  That single case is allowed to complete, and may report only close metadata, never page content.
