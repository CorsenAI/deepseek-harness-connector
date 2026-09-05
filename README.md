# DeepSeek Harness Connector

**Use DeepSeek Harness in the Chrome you already use — with your existing logins — while controlling
exactly which tabs each session may touch.**

You pick a DeepSeek Harness session. You pick the tabs it may operate. That session can read and act
in those tabs, and in nothing else. Every other tab, and every other session, is out of reach.

No headless copy of your browser. No cookie reading. No cloud relay. Nothing leaves your machine
except what your own DeepSeek Harness sends to the model provider you configured.

> An unofficial community project by **Corsen AI**. Not affiliated with, endorsed by, or certified by
> DeepSeek.

---

## Status

**Pre-release, 0.1.0.** The routing core, the transport, the DeepSeek Harness plugin, the Chrome
extension with all twenty browser actions, the installers, and the release packaging work end to
end and are covered by 263 tests: 222 unit and protocol tests, and 41 real-browser end-to-end
cases including multi-session isolation and a page built to leak hidden content. Installer
acceptance runs against a real `dsh` on Windows and Linux. CI is written but has not yet run, and
the Chrome Web Store submission is prepared only on paper.

`docs/TEST-MATRIX.md` lists every release gate and its honest state. Four are still open and three
are partial. Do not treat this as shippable until they are closed.

## What it does

| | |
|---|---|
| **Reads a page** | `browser_snapshot` returns the page as structured text: title, URL, visible text, and a numbered inventory of controls the model can address. Text-first — no screenshots, no vision required. |
| **Acts on a page** | Click, type, press keys, scroll, hover, choose options, drag, find text, and navigate in the tab you attached, addressed by references from the latest snapshot. A session can also open, list, switch, and close its own tabs — and only its own. |
| **Keeps sessions apart** | Each DeepSeek Harness session owns its own set of tabs. Two sessions running at once never see each other's pages. |
| **Fails closed** | A session with no attached tab gets a clear refusal and nothing happens. There is no fallback to "whatever tab is active". |
| **Masks secrets** | Passwords, one-time codes, payment fields, and hidden inputs are masked in the page, before anything leaves the browser. Credential-bearing URL parameters are scrubbed too. |

## How it fits together

```
DeepSeek Harness session
        │  exec.agent.id  (the session is the routing key)
        ▼
connector plugin  ──►  local broker  ──►  Chrome extension  ──►  the tab you attached
   (in your dsh)        127.0.0.1:8781      (your real profile)
```

The broker is a small local process that owns one loopback port. It exists because DeepSeek Harness
runs each profile as its own process — `dsh web`, `dsh --profile headless`, the SDK — and a one-shot
task must not take pairing and tab ownership with it when it exits. See
[ADR 0001](docs/adr/0001-broker-architecture.md).

## Installing

Requires DeepSeek Harness and Node `^22.19 || >=24`.

**1. Install the connector into a DeepSeek Harness profile.**

```bash
dsh plugin --profile web add @corsen-ai/dsh-browser-connector
```

That is the whole local installation. The package declares `dsh.bundle.patch`, so DeepSeek Harness
adds it to the profile's layer stack by itself — no YAML to edit.

**2. Start the broker and read the pairing code.**

```bash
npx dsh-connector-broker --pairing-code
```

**3. Install the Chrome extension** and type that code into its panel once.

> The extension is not on the Chrome Web Store yet. Until it is, load `extension/` unpacked from a
> clone. Note that current Chrome stable refuses `--load-extension` on the command line; use the
> **Load unpacked** button on `chrome://extensions` with Developer mode on.

**4. Use it.** Open the connector panel, pick a session, click **Attach this tab**. That session can
now operate that tab and nothing else.

## Using it

Ask your DeepSeek Harness session to do something in the browser. It has twenty tools, one per
protocol action: reading (`browser_snapshot`, `browser_read_text`, `browser_current_url`,
`browser_find`, `browser_wait`), acting (`browser_click`, `browser_type`, `browser_key`,
`browser_scroll`, `browser_hover`, `browser_select_option`, `browser_drag`), navigation
(`browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`), and the session's own
tabs (`browser_list_tabs`, `browser_open_tab`, `browser_switch_tab`, `browser_close_tab`).

Every tool tells the truth about what happened. A control the user cannot see is never listed and
never acted on; a tab Chrome refused to close is reported as detached-but-open, not as closed; a
navigation that did not finish says so.

The panel always shows the truth:

```
DeepSeek session  →  Chrome profile  →  attached tabs
```

If an action does not run, the panel says why — not paired, no session selected, no tab attached,
connector unreachable, versions mismatched. You should never have to guess what the agent can reach.

## What it never does

- **Never reads your cookies.** The extension does not request the `cookies` permission. Your logins
  are preserved by operating the page you already have open, not by taking your credentials.
- **Never uses the debugger.** No `chrome.debugger`, so no debugging banner on your tabs and no
  scary install warning. See [ADR 0006](docs/adr/0006-permissions-and-no-debugger.md).
- **Never sends anything to Corsen AI.** No analytics, no telemetry, no relay, no crash reporting.
- **Never reads page content from, or acts in, a tab you did not attach.** Explicitly, per
  session. The one thing it learns about other tabs is their title and URL, read locally when you
  open the tab chooser so you can pick one, and never sent to DeepSeek Harness.

Page content does travel from the tab you attached, through the local connector, to your DeepSeek
Harness — and from there to whichever model provider your DeepSeek Harness is configured to use. If
that provider is remote, the content reaches it. The connector adds no destination of its own.

## Security

- The broker binds loopback only, and refuses to start on any other address.
- Both sides prove knowledge of a shared pairing code with a role-bound HMAC over a fresh nonce. The
  code itself never crosses the wire. A proof captured from the browser cannot be replayed as the
  agent, and a proof cannot be replayed at all.
- The broker proves itself back, so a process squatting on the port cannot harvest your pages.
- Ownership is checked before the action **and again when the result returns**, so a tab that moves
  between sessions mid-action cannot deliver its content to the wrong one.
- Page content is treated as untrusted throughout. A page cannot change settings, attach tabs, move
  ownership, or reach the pairing code.

Details in [`docs/SECURITY-MODEL.md`](docs/SECURITY-MODEL.md) and
[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## Documentation

| | |
|---|---|
| [Architecture](docs/ARCHITECTURE.md) | How the pieces fit and why |
| [Protocol](docs/PROTOCOL.md) | The wire format, in full |
| [Security model](docs/SECURITY-MODEL.md) | What is protected, and how |
| [Threat model](docs/THREAT-MODEL.md) | What we defend against, and what we do not |
| [Compatibility](docs/COMPATIBILITY.md) | Which DeepSeek Harness versions are tested |
| [Test matrix](docs/TEST-MATRIX.md) | Every release gate and its state |
| [Test evidence](docs/TEST-EVIDENCE.md) | Runs that actually happened |
| [Decisions](docs/adr/) | Why the architecture is what it is |
| [Provenance](docs/PROVENANCE.md) | What this code descends from |

## Building and testing

```bash
npm install
npm run build        # compile companion/ to lib/
npm run typecheck
npm run test:unit    # 222 tests, no browser needed
npm run test:e2e     # real Chromium with the extension loaded
```

The end-to-end tests need Playwright's Chromium (`npx playwright install chromium`) and run headed,
because MV3 service workers do not start under the headless shell.

## Contributing

Start with the invariants that must never be violated, chiefly
that routing is exact and failure is closed. A change that could let one session reach another
session's tab is not a bug report, it is a release blocker.

Do not copy code from other DeepSeek Harness browser projects into this one.
[`docs/PROVENANCE.md`](docs/PROVENANCE.md) explains why and what the rules are.

## Related work

[`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser) is another open-source project
connecting DeepSeek Harness to a browser, and it got there first. This project is an independent
implementation with different priorities — per-session tab ownership, Chrome Web Store distribution,
and a compatibility layer for DeepSeek Harness's pre-stable APIs. If it suits you better, use it.

## Licence

MIT. See [`LICENSE`](LICENSE) and [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
