# Security model

What this connector protects, how, and what it does not claim.

The product's premise is unusual: it gives a language model the ability to act inside a browser that
is already signed in to the user's accounts. That premise sets the standard. A defect that lets one
session reach another session's tab, or that puts a credential into a model request, is not a bug to
triage — it is a release blocker.

## Trust boundaries

```
  the user                                    trusted
      │  types the pairing code once
      ▼
  the Chrome extension                        trusted code, hostile input
      │  ▲                                    (pages it reads are untrusted)
      │  │  authenticated loopback WebSocket
      ▼  │
  the local broker                            trusted
      │  ▲
      │  │  authenticated loopback WebSocket
      ▼  │
  the DeepSeek Harness plugin                 trusted
      │
      ▼
  DeepSeek Harness, then the model provider   outside this project's control
```

Everything the extension reads from a page crosses from **untrusted** to **trusted** at the moment
it leaves the page. That is precisely where redaction happens.

## What is protected

### 1. One session reaches only its own tabs

The routing key is `(profileId, sessionId)` where `sessionId` is `exec.agent.id`, read from
DeepSeek Harness on every call and never cached. A scope owns a set of tabs and one active tab
within it.

Three rules make this decidable:

- **One tab has exactly one owner.** Attaching a tab removes it from any other scope first, both in
  the extension and, independently, in the broker.
- **No binding, no action.** A scope with no tabs, or a call with no `exec.agent`, fails. There is
  no fallback to the active tab, the last-used tab, or the first controllable tab.
- **Ownership is revalidated when the result returns**, not only before the action. Between dispatch
  and result the user may have moved the tab to another session or another Chrome profile; a result
  that no longer satisfies its original routing is dropped and the caller is told
  `BINDING_CHANGED` rather than handed the page.

The broker and the extension each check ownership independently. They must agree, or nothing
happens.

Proven by tests A–H in `docs/TEST-MATRIX.md`, including real-browser runs with 24 interleaved
requests across two sessions and a second Chrome profile.

### 2. Only the paired browser can drive anything

The broker listens on loopback, which is not a trust boundary: any local process, and any web page
in the user's own browser, can open a socket to it.

Authentication is a role-bound mutual HMAC:

1. The broker challenges with a fresh nonce.
2. The client answers `HMAC(secret, "<role>:<id>:<serverNonce>")`.
3. The broker answers `HMAC(secret, "broker:<role>:<id>:<clientNonce>")`.

- The **role is signed into the proof**, so a proof captured from the extension cannot be presented
  as an agent, which is what would let a page drive the browser.
- The **server nonce** makes every proof single-use, so a captured handshake cannot be replayed.
- The **broker proves itself back**, so a process that squats on the port after the real broker
  exits cannot silently collect routed actions and page content.
- The **secret never crosses the wire**. Only proofs do.

`Origin` is a precondition, never the identity: a `browser` must present a `chrome-extension://`
origin, an `agent` must present none. Origin alone would be trivially forged by a non-browser
client, so it is used only to exclude the class of caller that cannot control it.

### 3. Credentials do not reach the model

Redaction runs **in the page**, before data crosses into the extension. The tested rules in
`extension/src/redact.js` are handed to the injected code as data, so the rules that are tested are
the rules that are applied — there is no second copy to drift.

Masked always:

- `type="password"` and `type="hidden"` inputs;
- anything the page itself declares through `autocomplete`: `current-password`, `new-password`,
  `one-time-code`, and every `cc-*` payment value;
- fields whose name, id, placeholder, ARIA label, or visible label contains a credential word
  (password, secret, token, api key, otp, totp, mfa, cvv/cvc/csc, card number, iban, ssn, pin, …);
- short numeric fields the page declares digit-by-digit, which are one-time codes in practice.

The mask is fixed-width, so it does not leak the value's length. The field itself still appears in
the snapshot, so the model can act on it — it just cannot read it.

A **screenshot** is the one result this does not cover: it is the rendered viewport, and what the
page shows on screen is in the picture. It is taken only of an attached tab on its session's
request, the tool description steers the model to the text snapshot for reading, and the
disclosures say so plainly (`docs/THREAT-MODEL.md`, T8a).

URLs are scrubbed for credential-bearing query and fragment parameters and for userinfo in the
authority. Schemes whose payload is opaque — `javascript:`, `data:`, `blob:` — are reported as the
scheme alone, because their payload cannot be scrubbed and may embed anything. (`new URL()` parses
all three without complaint, so this has to be an allowlist rather than a parse attempt.)

### 4. A page cannot escalate

Page content is untrusted input, never instruction. A page cannot:

- change connector settings, attach a tab, or move ownership — those come only from the panel, over
  `chrome.runtime` messaging, which a page cannot reach;
- read the pairing code — it lives in extension storage, which is not exposed to page scripts;
- authenticate to the broker — the `agent` role requires no `Origin`, which a page cannot achieve,
  and the `browser` role requires the extension's own origin plus the secret;
- reach the injected code — it runs in the `ISOLATED` world, so page script cannot redefine the DOM
  methods it uses.

The model may still be *persuaded* by page text. That is a prompt-injection risk this connector
bounds but does not eliminate; see `docs/THREAT-MODEL.md`.

### 5. Nothing is claimed that was not performed

If Chrome refuses an injection, if a control is disabled, if a reference is stale, if the page is a
`chrome://` page — the result is a typed failure with a reason the model can act on. The connector
never returns success for work that did not happen, and the end-to-end tests read the *page's own
state* to confirm an action occurred rather than trusting the extension's report.

### 6. Version mismatch fails closed

Chrome updates the extension on its own schedule; the local package is updated by the user. A
mismatch is refused at the handshake with a message naming which side is older, and the panel shows
an "update required" state. Undefined behaviour in a component that drives a signed-in browser is
not acceptable, so equality is required rather than tolerated.

## Permissions

`storage`, `sidePanel`, `scripting`, `alarms`, and `<all_urls>`.

Deliberately absent: `tabs`, `cookies`, `debugger`, `webRequest`, `downloads`, `nativeMessaging`,
`declarativeNetRequest`.

`<all_urls>` is a broad grant, and the narrowing is enforced by the extension itself: a content
script is injected only into a tab the user explicitly attached, only for the session that owns it.
The reasoning, and the rejected alternative of optional per-origin permissions, is in
[ADR 0006](adr/0006-permissions-and-no-debugger.md) and stated plainly in
`store/PERMISSION-JUSTIFICATIONS.md` rather than hidden.

## Bounded by construction

Every frame is size-capped before parsing, every collection has a maximum, every identifier matches
a narrow pattern, and every action has a deadline. The page walk is iterative and node-capped rather
than recursive, so a pathological DOM cannot exhaust the stack or run unbounded.

## What this does not protect against

Stated plainly, because a security model that claims completeness is not one.

- **A compromised machine.** The pairing secret is a file readable by the user's own account. A
  process running as the user can read it, and can then drive the browser as the connector would.
  There is no defence against an attacker who is already you.
- **Prompt injection changing the model's mind.** Page text reaches the model. The connector bounds
  what the model *can do* — its own tabs, its own session — but cannot stop a page from persuading
  it to do something ill-advised within those bounds.
- **Perfect secret detection.** The field rules are conservative and cover the signals pages
  actually give. A field with no type, no `autocomplete`, no telling name, and no telling label is
  indistinguishable from an ordinary one. `store/DATA-DISCLOSURES.md` says so.
- **What DeepSeek Harness does next.** Once page content reaches the user's own DeepSeek Harness, it
  goes wherever that installation is configured to send it. The connector adds no destination, and
  removes none.
- **A malicious extension in the same browser.** Another extension with its own permissions can read
  the same pages. Chrome's extension isolation is the boundary there, not this project's.
- **`isTrusted` gating.** Without `chrome.debugger`, synthetic events are not indistinguishable from
  real input. Sites that check may not respond. That is reported as a failed action, never hidden.

## Reporting a vulnerability

Open a security advisory on the GitHub repository rather than a public issue. A routing or redaction
defect will be treated as a release blocker, not a feature request.
