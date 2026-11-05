# ADR 0008 — The side panel routes; DeepSeek Harness owns the conversation

Status: accepted (2026-09-04)

## Context

Two designs were considered for the extension's side panel.

1. **Routing panel.** The panel shows connection state, the list of live DSH sessions, and the tabs
   attached to the selected session, plus a button that opens the real DSH Web UI.
2. **Embedded DSH Web UI.** The panel additionally embeds `http://127.0.0.1:3080` in an iframe so the
   user can converse without leaving the panel.

The community reference project puts a conversation UI in its side panel. The temptation to match it is
real, and it is the wrong instinct if it means reimplementing a chat client: a second, partial chat
surface would drift from DSH's real capabilities, would need its own attachment, streaming, approval,
and history handling, and would multiply the review surface for no product gain.

## Decision

v1 ships design 1: the panel is a **routing and status surface**, not a chat client.

The panel provides: connection and pairing state, DSH detection and version state, the live session
list, session selection, tab attach and detach, the active-tab selector, the running-action indicator,
and an "Open DeepSeek Harness" action.

An embedded DSH Web UI is kept as a **later, gated** option, not a v1 feature. The manifest's CSP
already allows `frame-src http://127.0.0.1:* http://localhost:*` so it can be added without a manifest
change, but nothing is embedded until the questions below are answered with evidence.

## Rationale

- The connector's job is routing, and routing is exactly what no existing surface shows the user. The
  panel earns its place by making "this session controls these tabs" visible, which DSH's own UI cannot
  know.
- Not reimplementing chat keeps every DSH capability — attachments, approvals, slash commands,
  multimodal input, session history — working through DSH's own maintained surface instead of a
  partial copy that silently lags.
- It keeps the Store single purpose narrow and the reviewable surface small. All browser-control logic
  ships inside the package, and there is no remotely loaded code in the extension's control path.
- `dsh web` is only one of four shipped profiles. A panel that assumed a Web UI would exclude
  `headless`, `sdk`, and `acp` users; a routing panel serves all of them, because session discovery is
  push-based from the plugin (ADR 0001).

## Open questions before embedding is reconsidered

- Does the DSH Web UI's own CSP permit framing from a `chrome-extension://` page?
- Does its authentication survive being framed, and on a dynamic port?
- Can the iframe be isolated from every extension API such that no remotely served script can reach
  browser control? The extension's control logic must remain inspectable from the submitted source.
- Does Store review accept a locally served iframe inside the panel?

## Consequences

- The panel needs excellent empty and error states, because it is the only place the user learns why an
  action did not run (`docs/ARCHITECTURE.md`).
- "Open DeepSeek Harness" needs the DSH surface's address. The plugin announces its Web address to the
  broker when it is running under a profile that has one; when it is not, the action is hidden rather
  than broken.

## Amendment (2026-11-05): the layout of Corsen's connectors

The panel's content is unchanged; its layout now follows Corsen's Hermes Connector, so the two
connectors read as one family: a status strip (the dot, the product, the settings gear, the
connection in one line), one compact strip with the session selector and the tab the session acts
in, popovers for the tab list, the access notes and the settings, and a single card in the middle
for whatever the user should know next. The route — session, Chrome profile, attached tabs — is the
card itself once a session is chosen. Nothing is said twice: the strip carries the connection, the
card the task.
