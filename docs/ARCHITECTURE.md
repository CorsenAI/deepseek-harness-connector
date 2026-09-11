# Architecture

How the pieces fit, and why each one exists. Decisions are recorded in [`adr/`](adr/); this document
is the map.

## The route

```
  DeepSeek Harness session
        │
        │  a tool call arrives with exec.agent.id — the SessionId
        ▼
  connector plugin                      companion/src/plugin.ts
        │                               companion/src/dsh/         the only place DSH types appear
        │  action_request { profileId, sessionId, action }
        ▼
  local broker                          companion/src/broker.ts    routing, ownership, revalidation
        │                               companion/src/broker-server.ts   sockets only
        │  action { scope, targetTabId, action }
        ▼
  Chrome service worker                 extension/src/background.js
        │                               checks ownership again, independently
        │  chrome.scripting.executeScript
        ▼
  the attached tab                      extension/src/page-actions.js    one self-contained function
        │                               extension/src/redact.js          rules, as data
        │  { ok, data } — already redacted, in the page
        ▼
  back along the same route, to the session that asked
```

No step chooses a target. Every step verifies one.

## The four components

### The DeepSeek Harness plugin

An ordinary npm package that declares `dsh.bundle.patch`, so
`dsh plugin --profile <name> add @corsen-ai/dsh-browser-connector` installs it and DeepSeek Harness
adds it to the profile's layer stack by itself ([ADR 0002](adr/0002-npm-package-installation.md)).

On `apply()` it checks the DeepSeek Harness version, connects to the broker as an `agent`, subscribes
to `agent/created` and `agent/disposed` to announce the sessions live in this process, and registers
its tools. Registration goes through `ctx.effect()`, so unloading the plugin closes the socket and
removes the tools.

**Everything that touches DeepSeek Harness lives in `companion/src/dsh/`**
([ADR 0005](adr/0005-dsh-compatibility-adapter.md)). DeepSeek Harness states that its APIs are
pre-stable; confining contact to one directory means an upstream change lands in one place with one
set of tests, instead of rippling through every tool handler.

### The broker

One detached process per DeepSeek Harness home, owning `127.0.0.1:8781`. It authenticates both
roles, holds which browser owns each scope, forwards actions, and revalidates ownership when results
return. It never executes a browser action and never picks a target for a scope that has none.

It exists because **DeepSeek Harness runs each profile as its own OS process**, and
`dsh --profile headless "task"` is a one-shot that exits when the task ends. Pairing, browser
identity, and tab ownership have to outlive it, and only one process can hold a port
([ADR 0001](adr/0001-broker-architecture.md)).

It is started by the installers, and by any plugin instance that finds nothing listening
(`broker-launch.ts`): the same entry, detached, standard error kept in
`connector/broker.stderr.log`, under a launch lock (`connector/broker.launch.json`, fifteen
seconds) so several DeepSeek Harness processes starting together start one broker between them.
The broker records its own process id in `connector/broker.pid` once it listens, which is what the
installers stop before starting a newer one. The package's `bin`, `dsh-connector-broker`, is the
same entry; `dsh plugin --profile <name> exec dsh-connector-broker --pairing-code` runs it in the
profile where DeepSeek Harness installed it.

Routing logic is separated from sockets behind a `PeerSocket` interface, so every ownership and
authorization rule is unit-testable without a network. `broker-server.ts` owns sockets and nothing
else.

### The Chrome extension

Manifest V3. The service worker holds the browser's persistent identity, the broker connection, the
authoritative tab registry, and the action dispatcher.

**MV3 eviction is the design, not an obstacle.** Chrome terminates the worker whenever it likes, so
nothing may depend on staying alive: every piece of state is rebuilt from `chrome.storage.local` on
each wake, stored bindings are validated against live tabs, and the connection is re-established
rather than assumed. An alarm brings the worker back when it is not connected.

The side panel is a **routing and status surface, not a chat client**
([ADR 0008](adr/0008-side-panel-scope.md)). It shows which session controls which tabs and why an
action would not run. DeepSeek Harness keeps the conversation, so every capability it has —
attachments, approvals, slash commands, history — keeps working instead of being partially
reimplemented here.

### The page interface

One self-contained function, serialised into the tab by `chrome.scripting.executeScript` in the
`ISOLATED` world. It receives the redaction rules as a JSON argument, so the tested rules and the
applied rules are the same rules.

Element references carry the snapshot generation that minted them. A reference from an earlier
snapshot is refused, never resolved against whatever element now sits at that index — silently
acting on a reused index is how an agent clicks the wrong control.

## Identity

| | |
|---|---|
| **Session** | `exec.agent.id`, a `SessionId` from DeepSeek Harness. Read per call, never cached. **Optional** on a tool execution, so its absence must fail closed. |
| **Profile** | The profile directory name plus a digest of the DeepSeek Harness home, so two installations cannot collide. Derived from the plugin's own installation path, which a normal `dsh plugin` install makes correct without configuration. |
| **Browser** | A random id minted once per extension installation. Never derived from the Google account, the profile directory, or a window title — two of those are unstable and all three are none of this extension's business. |
| **Tab** | Chrome's tab id, which is reused after a restart. A restored binding is therefore a claim to verify against live tabs, not a fact. |

## Ownership

A **scope** is `(profileId, sessionId)`. A **binding** maps a scope to an ordered set of tabs plus
one active tab drawn from that set. The extension is authoritative; the broker holds a mirror; both
use the same code (`bindings.ts` and its mirror `bindings.js`), and a parity test runs 300
randomised operations through both and compares after every step.

The rules, and the reasoning, are in [ADR 0007](adr/0007-scope-and-tab-ownership.md).

## Two copies of two modules

The extension ships as its own Chrome Web Store package and cannot import the npm package, so the
protocol and the ownership registry exist twice. Duplication is only safe while something proves the
copies agree:

- `protocol-parity.test.ts` compares every shared constant, map, and pattern;
- `bindings-parity.test.ts` compares behaviour, not names, across randomised sequences.

Without those, two peers could disagree while both still claiming protocol 1 — a divergence the
version handshake cannot catch.

## Versions

Three numbers, deliberately separate:

- **Protocol version** — the wire generation. Peers must match **exactly**; a mismatch fails closed
  with a message naming which side is older ([ADR 0004](adr/0004-version-handshake.md)).
- **Product version** — the connector's semantic version, moving on its own line. It does not
  inherit Hermes Connector's numbering.
- **Supported DeepSeek Harness range** — declared in `companion/src/dsh/version.ts`, evidenced in
  `docs/COMPATIBILITY.md`, and refused at load when the runtime falls outside it.

## Repository layout

```
extension/     Chrome MV3 extension — the Store package
  src/           protocol mirror, ownership mirror, redaction, page interface, worker, panel
companion/     @corsen-ai/dsh-browser-connector — the npm package
  src/dsh/       the ONLY place DeepSeek Harness APIs appear
  src/           protocol, auth, bindings, frames, broker, transport, plugin
tests/e2e/     real Chromium with the real extension
scripts/       icon generation, installers, packaging
docs/          this map, the protocol, security, compatibility, evidence, decisions
store/         Chrome Web Store submission material
.refs/         read-only reference clones (gitignored, never shipped)
```

## Deliberately not built

- **A second chat UI.** DeepSeek Harness has one, and a partial copy would drift.
- **`chrome.debugger`.** Not required for v1's interaction set, and the cost is a permanent
  debugging banner plus a scary install warning for every user ([ADR 0006](adr/0006-permissions-and-no-debugger.md)).
- **Network capture.** A different privacy surface entirely, and not what the single purpose
  describes.
- **A cloud relay.** There is nothing for it to do. Local-first is the product.
