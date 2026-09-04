# ADR 0006 — Minimal permissions; no `debugger`, no `cookies` in v1

Status: accepted (2026-09-04)

## Context

Chrome Web Store review weighs each permission against the declared single purpose, and users see the
permission warning at install time. Two permissions dominate the decision.

`chrome.debugger` gives real OS-level input events (`isTrusted`) and native dialog handling. Hermes
Connector ships it because Chrome does not allow `debugger` as an *optional* permission, so the only
way to offer it as a user choice is to declare it in the manifest and attach it only when the user
turns on a setting. The cost is a permanent install-time warning and a visible debugging banner on
every attached tab.

`cookies` is not needed at all: the product preserves logins by operating the page the user already has
open, not by reading credentials.

## Decision

v1 ships:

```json
"permissions": ["storage", "sidePanel", "scripting", "tabs", "alarms"],
"host_permissions": ["<all_urls>"]
```

No `debugger`. No `cookies`. No `webRequest`. No network capture.

Page interaction uses `chrome.scripting` with synthetic events: native property setters plus
`input`/`change` dispatch for React and Vue controlled inputs, and `PointerEvent`/`MouseEvent`
sequences for clicks.

## Rationale

- **`debugger` is not required for v1 reliability.** The interaction surface we ship — click, type,
  scroll, keys, select, hover, drag, navigation — is achievable with synthetic events. Sites that
  require `isTrusted` are a real but bounded class, and shipping a permanent debugging banner and a
  scary install warning to every user to serve that class is the wrong trade for a first release. The
  protocol reserves a `trusted_input` capability flag so it can be added later without a protocol
  break (ADR 0004 capability negotiation).
- **`cookies` would contradict the privacy claim.** Not requesting it is what makes "the extension
  never reads your cookies" a checkable fact rather than a promise.
- **`tabs` is required, not optional.** Listing a session's own tabs with their titles and URLs, and
  proving a stored `tabId` still exists after a service-worker restart, both need it.

## The `<all_urls>` decision

Optional per-origin host permissions were evaluated and rejected for v1.

The product's core gesture is "attach this tab I am looking at". With optional host permissions, every
first attachment on a new origin raises a Chrome permission prompt, and a session that follows a link
to another origin loses its own attached tab mid-task until the user answers a second prompt. That
turns the central interaction into a prompt sequence and makes fail-closed routing indistinguishable
from a missing grant, which is precisely the confusion this product exists to remove.

`<all_urls>` is declared, but the *effective* access is narrower than the grant and is enforced by the
extension itself: a content script is injected only into a tab the user explicitly attached, only for
the session that owns it. This is stated plainly in `store/PERMISSION-JUSTIFICATIONS.md` rather than
hidden.

This decision is revisited if Store review or user evidence shows the prompt cost is acceptable.

## Consequences

- Sites that gate on `isTrusted` may not respond to synthetic clicks. The failure must be reported
  honestly as a failed action, never as a success (`docs/TEST-MATRIX.md`).
- Native dialogs (`alert`, `confirm`, `beforeunload`) cannot be dismissed without `debugger`. The
  snapshot reports a blocking dialog as an explicit state so the model does not retry blindly.
- `chrome://` and Web Store pages cannot be scripted. Attaching one fails with a clear reason.
