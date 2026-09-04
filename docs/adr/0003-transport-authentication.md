# ADR 0003 — Role-bound mutual HMAC over loopback

Status: accepted (2026-09-04)

## Context

The broker listens on `127.0.0.1`. Loopback is not a trust boundary: any local process, and any web
page in the user's browser, can open a connection to it. A page that could authenticate as an `agent`
could drive the user's signed-in tabs; a process that could authenticate as a `browser` could receive
another session's page content.

## Decision

Reuse the Corsen Hermes handshake, re-implemented in TypeScript.

1. The broker sends `challenge { nonce: serverNonce }` on connect.
2. The client replies `hello { role, id, nonce: clientNonce, proof }` where
   `proof = HMAC-SHA256(secret, "<role>:<id>:<serverNonce>")`.
3. The broker verifies with a constant-time comparison, then replies
   `paired { proof: HMAC-SHA256(secret, "broker:<role>:<id>:<clientNonce>") }`.

Origin is checked as a **precondition, never as the identity**:

- `browser` requires an `Origin` of `chrome-extension://...`.
- `agent` requires **no** `Origin` at all, which an in-browser page cannot achieve.

## Rationale

- Binding the role into the proof means a captured `browser` proof cannot be replayed as an `agent`.
- The server nonce makes each proof single-use, so a replayed handshake fails.
- The broker's answering proof authenticates the broker to the client, so a process squatting on the
  port cannot silently harvest requests.
- The shared secret is never transmitted, only proven.
- Origin alone would be trivially forgeable by a non-browser client, and is therefore used only to
  *exclude* the class of caller that cannot control it.

## Rejected alternatives

- **Bearer token in a query string or header.** The secret would cross the wire on every connection and
  would land in logs; a replayed frame would authenticate.
- **Loopback-only, no authentication.** Any local process and any page's `fetch`/`WebSocket` could
  drive the user's signed-in browser.
- **Chrome native messaging instead of WebSocket.** It binds the transport to one browser process tree,
  cannot serve several DSH processes, and does not survive the extension's service-worker eviction any
  better. It also loses the single-broker property that makes cross-profile ownership decidable.

## Consequences

- The secret is generated once, stored under the DSH home with owner-only permissions, and never logged
  or shown again after pairing.
- The pairing code the user sees is a short display encoding of that secret, entered once.
- Every frame is size-bounded and JSON-validated before dispatch; unknown privileged kinds are rejected
  rather than ignored (`docs/PROTOCOL.md`).
