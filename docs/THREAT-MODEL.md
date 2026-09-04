# Threat model

Who could attack this connector, what they would want, and what stands in their way. Each threat
names the control that addresses it and the test that proves the control exists. A threat with no
test is listed as such.

## Assets

1. **The user's signed-in browser.** The ability to act as the user on any site they are logged
   into. This is the asset that justifies every other control.
2. **Page content.** What the user is looking at, which may be private.
3. **Credentials in pages.** Passwords, one-time codes, payment details, session tokens in URLs.
4. **The pairing secret.** Knowledge of it is the ability to become either role.
5. **Session-to-tab ownership.** Which session may act where. Corrupting it is a routing leak.

## Actors

| Actor | Position | Capability |
|---|---|---|
| **Hostile page** | Loaded in an attached tab, or any tab | Runs script in its own origin; can open sockets to loopback; can craft DOM, labels, and text; can attempt to persuade the model |
| **Unrelated local process** | Same machine, same user | Can open sockets to loopback; can read the user's files, including the secret |
| **Stale peer** | An older extension or package after a partial update | Speaks an older protocol; may hold stale ownership state |
| **Second DeepSeek Harness session** | Legitimate, concurrent | Should never see another session's tabs |
| **Second Chrome profile** | Legitimate, concurrent | Should never be confused with the first |
| **Another extension** | Same browser | Whatever its own permissions allow |

## Threats and controls

### T1 — A page drives the browser through the broker

*A page opens a WebSocket to `127.0.0.1:8781` and tries to authenticate as an agent.*

- **Control.** The `agent` role requires **no** `Origin` header. A page's WebSocket always carries
  one, and cannot remove it. Even with a correct proof the connection is refused.
- **Control.** Without the secret, no proof verifies.
- **Test.** `broker.test.ts` "refuses an agent role from any origin"; `integration.test.ts` "refuses
  a web page origin claiming the browser role" and "refuses a client that does not know the secret".

### T2 — A page impersonates the extension

*A page tries to authenticate as `browser` to receive routed actions and page content.*

- **Control.** The `browser` role requires a `chrome-extension://` origin, which a page cannot set.
- **Control.** The proof is role-bound; a captured browser proof presented as an agent, or the
  reverse, fails.
- **Test.** `auth.test.ts` role-binding cases; `broker.test.ts` "refuses a browser proof replayed as
  an agent".

### T3 — Replay of a captured handshake

*A local process records a valid handshake and replays it.*

- **Control.** The broker's challenge nonce is fresh per connection and signed into the proof. A
  proof for one challenge fails against every other.
- **Test.** `auth.test.ts` "refuses a proof replayed against a new challenge"; `broker.test.ts`
  "refuses a proof minted against another connection challenge".

### T4 — Port squatting

*The real broker exits; a hostile process binds 8781 and waits for the extension and plugins to
connect.*

- **Control.** Clients verify the broker's answering proof, which requires the secret. A squatter
  without it is disconnected before any action or content is sent.
- **Test.** `integration.test.ts` verifies the broker proof on every pairing; the `AgentClient`
  refuses a paired frame whose proof does not verify (`agent-client.ts`, `#onPaired`).

### T5 — Cross-session routing

*Session B's request is answered from session A's tab, or A's result is delivered to B.*

- **Control.** Every request carries `(profileId, sessionId)`; the broker resolves it to one binding
  or refuses. The extension re-checks against its own registry before acting. Ownership is
  revalidated when the result returns.
- **Control.** One tab has one owner, enforced in both the extension and the broker.
- **Test.** `isolation.test.ts` A–E in a real browser; `broker.test.ts` "returns each result to the
  session that asked, under interleaving", "drops a result whose tab moved to another session while
  it ran", "takes a tab from another session in the same browser".

### T6 — A stale browser reclaims a scope

*Chrome profile 1 held a session, the user attached it in profile 2, then profile 1 reconnects and
re-announces its old bindings.*

- **Control.** `binding_sync` is restoration, never a claim: a scope owned elsewhere is refused and
  revoked locally. Only an explicit `binding_update` transfers ownership.
- **Test.** `broker.test.ts` "refuses a reconnect sync that would reclaim a scope owned elsewhere".

### T7 — Forged or duplicated action results

*A browser sends a result for a request it never received, or sends one result twice.*

- **Control.** A result is accepted only from the browser that holds the pending request, only
  once; the pending record is deleted on settlement.
- **Test.** `broker.test.ts` "ignores a result from a browser that never held the request", "ignores
  a duplicate result for an already settled request".

### T8 — Credential disclosure through a snapshot

*A password, one-time code, card number, or hidden field value reaches the model.*

- **Control.** Redaction in the page, before data leaves it, by type, `autocomplete`, name, id,
  label, placeholder, and numeric-pattern rules. Fixed-width mask.
- **Control.** `type` results never echo the typed text.
- **Test.** `redaction.test.ts` (28 cases); `slice.test.ts` "never reports a password, one-time
  code, card number, or hidden value" against a real page; `tools.test.ts` "never echoes typed text
  back into the transcript".
- **Residual risk.** A field with no telling signal is not detectable. Stated in
  `store/DATA-DISCLOSURES.md`.

### T9 — Credential disclosure through a URL

*An OAuth callback or a signed link carries a token in the query or fragment.*

- **Control.** Query and fragment parameters with credential-like names are masked; userinfo is
  removed; opaque-payload schemes are reported as the scheme alone.
- **Test.** `redaction.test.ts` URL cases; `slice.test.ts` "scrubs a credential out of the reported
  URL".

### T10 — Prompt injection through page text

*A page contains text instructing the model to attach more tabs, exfiltrate content, or change
settings.*

- **Control (structural).** The model has no tool that changes settings, attaches tabs, or moves
  ownership. Those exist only on the panel, over `chrome.runtime`, which neither a page nor the
  model can reach. The blast radius is bounded to the session's own tabs.
- **Control (structural).** The pairing code is never in any tool result.
- **Residual risk.** The model can still be persuaded to act unwisely *within* its own tabs — for
  example, to click a control the page mislabels. The connector cannot read intent. DeepSeek
  Harness's own approval mechanisms are the right place for that, and integrating with them is
  tracked as future work rather than reinvented here.
- **Test.** Structural: `tools.test.ts` "registers exactly the browser tools this version
  implements" proves no such tool exists. Hostile fixtures (`TEST-MATRIX.md` gate AI) are open.

### T11 — Denial of service through hostile input

*A page or process sends enormous frames, deeply nested DOMs, thousands of bindings, or a flood of
requests.*

- **Control.** Frame size cap before parsing; caps on bindings, tabs, sessions, and in-flight
  requests; iterative node-capped page walk; per-action deadline.
- **Test.** `broker.test.ts` "hostile frames" suite; `frames.ts` bounds. Giant-DOM fixtures are
  gate AI, open.

### T12 — Protocol skew after an auto-update

*Chrome updates the extension; the local package is older, or the reverse.*

- **Control.** Protocol version equality checked in the handshake, before the proof, with a message
  naming which side is older. The extension shows an "update required" state and stops retrying.
- **Test.** `broker.test.ts` "refuses a mismatched protocol and names which side is older", "checks
  the protocol before the proof"; `panel-state.test.ts` "lets an update requirement outrank every
  other state".

### T13 — Two Chrome profiles confused for one

- **Control.** Each installation mints its own random identity; the broker keys browsers by it.
- **Test.** `isolation.test.ts` E, two real persistent contexts.

### T14 — Broker exposed on the network

*A configuration error binds the broker to `0.0.0.0`.*

- **Control.** `requireLoopback` refuses to start on any non-loopback address. This is checked, not
  defaulted.
- **Test.** `integration.test.ts` "refuses every non-loopback bind address".

### T15 — A tab id is reused after a restart

*Chrome restarts, assigns an old tab id to a new page, and a restored binding points at it.*

- **Control.** Restored bindings are validated against live tabs on every worker wake; a tab that
  cannot be proven live is dropped. This does not distinguish a *reused* id from a *surviving* one
  when both are live.
- **Residual risk.** A restored binding can point at a different page that happens to hold the same
  id after a full Chrome restart. The panel shows the current title and URL of every attached tab so
  the user can see it. Full-restart validation against stored URLs is future work.
- **Test.** `bindings.test.ts` "are dropped from a restored registry when the browser no longer has
  them". Restart scenarios are gate AB, open.

## Out of scope

- **A compromised user account or machine.** The secret is a user-readable file. An attacker
  running as the user is the user.
- **Another extension in the same browser.** Chrome's isolation is the boundary.
- **DeepSeek Harness itself and the model provider.** Once content reaches the user's DeepSeek
  Harness it goes where that installation sends it.
- **Physical access, screen recording, shoulder-surfing.**

## Open items

Gates AA, AB, AI, and the residual risks in T10 and T15 are the threat-model items without full
evidence. They are listed in `docs/TEST-MATRIX.md` so they cannot be forgotten.
