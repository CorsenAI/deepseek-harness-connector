# Protocol

Version **1**. Authoritative definition: `companion/src/protocol.ts`. The extension's mirror is
`extension/src/protocol.js`, and `companion/tests/protocol-parity.test.ts` fails when the two
diverge.

## Transport

WebSocket over loopback. The broker owns `ws://127.0.0.1:8781` by default and refuses to bind any
non-loopback address (`requireLoopback`, checked at startup rather than merely defaulted). A plain
HTTP request to the port receives `426 Upgrade Required` and nothing else.

Two authenticated roles share one port:

- `browser` — a Chrome extension installation. Must present an `Origin` of `chrome-extension://…`.
- `agent` — a DeepSeek Harness plugin instance. Must present **no** `Origin`, which an in-browser
  page cannot achieve.

Origin is a precondition on the class of caller. It is never the identity (ADR 0003).

## Handshake

```
broker -> client   challenge { nonce, protocolVersion, brokerVersion }
client -> broker   hello     { role, id, name, nonce, proof, protocolVersion, connectorVersion,
                               capabilities?, profileId? }
broker -> client   paired    { proof, protocolVersion, brokerVersion }
      or           denied    { code, message }        then close
```

- `proof` = `HMAC-SHA256(secret, "<role>:<id>:<serverNonce>")`, lowercase hex.
- The broker's answering `proof` = `HMAC-SHA256(secret, "broker:<role>:<id>:<clientNonce>")`.
- The secret is the pairing code the user typed, normalised. It never crosses the wire; only
  proofs do.
- `protocolVersion` must be **equal**, not merely compatible. A mismatch is refused with
  `PROTOCOL_VERSION` and a message naming which side is older (ADR 0004).
- The version is checked **before** the proof, so a stale peer is told the real reason rather than
  "authentication failed".
- `capabilities` is the action kinds the sender actually implements. The broker refuses a request
  for a kind the owning browser did not declare.
- `profileId` is required from an `agent` and identifies its DeepSeek Harness profile and home.

## Frames after the handshake

### Browser to broker

| Type | Payload | Meaning |
|---|---|---|
| `binding_sync` | `{ bindings: Binding[] }` | The complete binding set after a reconnect. **Restoration, not a claim**: a scope another browser owns is refused and revoked locally. A sync naming one tab under two scopes, or one scope twice, is refused whole. |
| `binding_update` | `Binding` | An explicit user attachment. **Transfers** the scope, revoking it from any other browser, and takes the named tabs from every other scope in this browser. |
| `binding_remove` | `{ profileId, sessionId }` | The user detached a scope entirely. |
| `action_result` | `{ id, ok, data?, error? }` | The outcome of one dispatched action. |
| `pong` | `{ id }` | Liveness answer. |

### Broker to browser

| Type | Payload | Meaning |
|---|---|---|
| `action` | `{ id, scope: { profileId, sessionId }, targetTabId, action: { kind, args } }` | Perform one action in this exact tab. |
| `binding_revoked` | `{ profileId, sessionId, reason }` | Another browser explicitly claimed this scope. |
| `state` | `{ brokerVersion, browsers[], sessions[] }` | Projection for the panel. |
| `ping` | `{ id }` | Liveness probe. |

### Agent to broker

| Type | Payload | Meaning |
|---|---|---|
| `session_announce` | `{ sessions: { sessionId, title }[] }` | The sessions live in this DeepSeek Harness process. Replaces the previous announcement. |
| `session_retire` | `{ sessionId }` | One session ended. |
| `action_request` | `{ id, profileId, sessionId, action: { kind, args } }` | Perform one action for this exact scope. |
| `pong` | `{ id }` | Liveness answer. |

### Broker to agent

| Type | Payload | Meaning |
|---|---|---|
| `action_response` | `{ id, ok, data?, error? }` | The settled outcome of one request. |
| `state`, `ping` | as above | |

A role sending a frame kind belonging to the other role is refused with `MALFORMED`. Unknown kinds
are refused, never ignored. An unauthenticated connection sending anything but `hello` is closed.

## Binding

```
Binding = { profileId, sessionId, tabIds: number[], activeTabId: number }
```

`activeTabId` is always a member of `tabIds`. A binding with no tabs is not an empty binding, it is
an absence, and is dropped. A stored `activeTabId` that is not a member is repaired to the first tab
rather than rejected: the set is the ownership fact, and the active choice is a preference within
it.

## Action kinds

`snapshot`, `read_text`, `current_url`, `click`, `type`, `key`, `scroll`, `hover`, `select_option`,
`drag`, `find`, `navigate`, `back`, `forward`, `reload`, `wait`, `open_tab`, `list_tabs`,
`switch_tab`, `close_tab`, `screenshot`.

The protocol defines all twenty-one. **The extension declares in its handshake only the kinds it
implements**, and the broker refuses the rest with `UNSUPPORTED_ACTION`. At version 0.1.0 the
extension implements all of them (`extension/src/page-actions.js`, `IMPLEMENTED_ACTIONS`, the
page actions and the tab actions as one list). Declaring a kind that is not implemented would turn
a clear refusal into a silent failure, so the declaration is derived from that list.

`open_tab`, `switch_tab`, and `close_tab` change which tabs a scope owns and are authorized
differently when their result returns (see Routing).

### `screenshot`

Takes no arguments and answers with the scope's active tab as pixels:

```
{ url, title, mediaType: "image/jpeg", dataUrl, width, height, foregrounded: boolean }
```

`dataUrl` is a `data:image/jpeg;base64,` URL of the visible viewport, JPEG quality 75, at most
6 MiB; `width` and `height` are read from the bytes, not assumed. Chrome captures only the tab that
is at the front of its window, so a covered tab is brought to the front first and the answer says
so with `foregrounded: true` — the user's window changed, and the result does not hide it. Chrome
copies the tab's compositor surface, and right after a tab is shown (or before a headless renderer
has painted) there is nothing to copy yet — "image readback failed" or "view is invisible"; and
Chrome allows the call twice per second, refusing a third with its quota message. The extension
retries those three answers up to four attempts, 600 ms apart so that the retries stay inside the
quota, then reports Chrome's reason. Any other refusal is reported at once. After the capture the extension checks that the attached tab is still
the one at the front of the same window; if the user switched or moved tabs meanwhile, the picture
may be of another page and is discarded (`ACTION_FAILED`), never reported as the attached tab. The
capture is of the rendered page: **the masking that applies to text results does not apply to
pixels** (a value the page shows on screen is in the picture), which is why the companion's tool
description steers a model to `snapshot` for reading and keeps `screenshot` for layout. `url` is
scrubbed like every other result's. A page Chrome protects is refused with `RESTRICTED_PAGE`
before anything is captured, a tab that no longer exists with `TAB_GONE`, and a capture Chrome
declines with `ACTION_FAILED`.

### Element references

A snapshot mints references of the form `e<index>@<generation>`. The generation is per page and
increments on every snapshot. A reference whose generation is not the current one, or which no
longer resolves to a connected element, is refused with `STALE_REF`. It is never resolved against
whatever element now occupies that index.

## Error codes

Every rejection carries a code. Callers and tests match on the code, never on the message.

| Code | Meaning |
|---|---|
| `NO_SESSION` | The tool call carried no DeepSeek Harness session identity. |
| `NO_BINDING` | The scope has no attached tab. There is no fallback target. |
| `NO_BROWSER` | The browser owning this scope is not connected. |
| `BINDING_CHANGED` | Ownership or the active tab changed while the action ran. |
| `TAB_GONE` | The target tab no longer exists. |
| `ACTION_FAILED` | The page refused or could not perform the action. |
| `STALE_REF` | The element reference came from an earlier snapshot. |
| `RESTRICTED_PAGE` | A Chrome-internal or Web Store page extensions may not script. |
| `UNSUPPORTED_ACTION` | The peer does not implement this kind. |
| `TIMEOUT` | The action did not settle within its deadline. |
| `INTERRUPTED` | The action was dispatched and its outcome is unknown: the browser, the broker, or a connection went away while it ran, and the page may have performed it. Sent by the broker when the owning browser disconnects mid-action; raised locally by a client whose own connection drops with requests in flight. Never a refusal, and never replayed. |
| `PROTOCOL_VERSION` | Protocol generations differ. |
| `UNAUTHENTICATED` | The proof, role, or origin precondition failed. |
| `MALFORMED` | Not valid JSON, not an object, or a field failed validation. |
| `TOO_LARGE` | A frame or collection exceeded its cap. |
| `INTERNAL` | A failure not attributable to the caller. |

## Routing

An `action_request` is answered without contacting any browser unless **all** of these hold:

1. the request's `profileId` is the requesting agent's own;
2. the agent has fewer than `MAX_PENDING_PER_AGENT` requests in flight, and this request id is not
   already in flight;
3. the scope has an owning browser in the broker's ownership table;
4. that browser is connected;
5. that browser holds a binding for the scope;
6. the browser declared the requested action kind.

The dispatched `targetTabId` is the scope's `activeTabId` at dispatch time.

When the `action_result` returns, ownership is checked **again**:

- for a non-mutating action: the same browser must still own the scope, and `targetTabId` must still
  be the scope's active tab and a member of its tabs;
- for `open_tab` / `switch_tab` / `close_tab`: the same browser must still own the scope, except
  that a `close_tab` which removed the scope's last tab is allowed to report its own outcome — close
  metadata only, never page content.

A result that fails revalidation is dropped and the caller receives `BINDING_CHANGED`. This is what
stops a session from receiving a page another session acquired mid-action (ADR 0007). A result from
a browser that does not hold the pending request, or a second result for an already settled request,
is ignored.

The extension performs the same ownership check independently before touching a tab: the
dispatched `targetTabId` must be its registry's active tab for that scope. The broker's mirror and
the extension's authoritative registry must agree, or nothing happens.

## Bounds

Enforced before dispatch, so a hostile peer cannot make the broker allocate without limit.

| Limit | Value |
|---|---|
| `MAX_FRAME_BYTES` | 8 MiB |
| `MAX_TEXT_CHARS` | 1,000,000 |
| `MAX_BINDINGS_PER_BROWSER` | 256 |
| `MAX_TABS_PER_BINDING` | 64 |
| `MAX_SESSIONS_PER_AGENT` | 512 |
| `MAX_PENDING_PER_AGENT` | 64 |
| `ACTION_TIMEOUT_MS` | 30,000 |
| `MAX_ID_CHARS` | 160 |

Identifiers match `^[A-Za-z0-9_.:@-]{1,160}$`. The scope key joins a profile and a session with
`U+001F`, which the identifier alphabet excludes, so two scopes can never collide.

## Changing this protocol

Any change a peer could misread bumps `PROTOCOL_VERSION`, requires a mismatch test proving the older
peer is refused rather than warned, and updates this document, both protocol copies, and
`docs/COMPATIBILITY.md` in the same change.
