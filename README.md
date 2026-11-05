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

**Release candidate, 0.1.0.** The routing core, the transport, the DeepSeek Harness plugin, the
Chrome extension with all twenty-one browser actions, the installers, and the release packaging work
end to end and are covered by 389 tests: 295 unit and protocol tests, 17 cases running the shipped
page module in a real Chrome, and 77 real-browser end-to-end cases — multi-session isolation, a
page built to leak hidden content, a page built to give a model instructions, an attached tab that
changes origin mid-task, recovery from a killed service worker, a restarted broker, a replaced
agent connection, a closed tab and a relaunched Chrome, the released pair installed into a real
`dsh` with its broker killed and restarted as a process, DeepSeek Harness's own compatibility rule
and display-metadata reader run against the installed package, and three live turns of a real
`dsh` process whose model — DeepSeek Harness's own scripted mock provider — calls
`browser_snapshot` and `browser_screenshot` on the attached tab (the screenshot reaching a vision
model as pixels and a text-only model as DeepSeek Harness's placeholder), a real `dsh` process
starting the packaged broker it found missing, the panel's setup card against a real broker, a
silent port and another program, and web components read and clicked through open shadow roots.

**Tested with DeepSeek Harness 0.1.2-rc.1, 0.1.5-rc.2, 0.2.1-rc.5 (npm `latest`) and 0.2.2-rc.1
(npm `next`)**, on Linux, macOS and Windows; see [`docs/COMPATIBILITY.md`](docs/COMPATIBILITY.md)
for the evidence per version and platform. The release artifacts build byte-identically on the
three platforms with the official Node.js builds. The Store listing, screenshots and privacy page are in `store/`.

`docs/TEST-MATRIX.md` lists every release gate and its honest state. What remains needs the owner:
a GitHub remote for the CI lanes and the privacy page's public URL, the npm publication, and the
Store submission itself. A turn with a real provider key instead of the scripted one is a one-line
change of the provider endpoint.

## What it does

| | |
|---|---|
| **Reads a page** | `browser_snapshot` returns the page as structured text: title, URL, visible text, and a numbered inventory of controls the model can address. Text-first — no vision required — and `browser_screenshot` adds the pixels, through DeepSeek Harness's own attachment service, when the model can see. |
| **Acts on a page** | Click, type, press keys, scroll, hover, choose options, drag, find text, and navigate in the tab you attached, addressed by references from the latest snapshot. A session can also open, list, switch, and close its own tabs — and only its own. |
| **Keeps sessions apart** | Each DeepSeek Harness session owns its own set of tabs. Two sessions running at once never see each other's pages. |
| **Fails closed** | A session with no attached tab gets a clear refusal and nothing happens. There is no fallback to "whatever tab is active". |
| **Masks secrets** | Passwords, one-time codes, payment fields, and hidden inputs are masked in the page, before anything leaves the browser. Masking follows the control, not one field: a masked textarea’s content stays out of the page text, and a masked menu’s options are not listed. Credential-bearing URL parameters are scrubbed too. |

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

Requires DeepSeek Harness, Node `^22.19 || >=24`, and pnpm on `PATH` — DeepSeek Harness's
`dsh plugin` command forwards to pnpm and does not install it (`npm install -g pnpm` does). The
installers check for all three before creating anything.

**1. Install the connector into a DeepSeek Harness profile.**

```bash
dsh plugin --profile web add @corsen-ai/dsh-browser-connector
```

That is the whole local installation. The package declares `dsh.bundle.patch`, so DeepSeek Harness
adds it to the profile's layer stack by itself — no YAML to edit. It also declares the DeepSeek
Harness versions it supports (`engines.dsh`), so DeepSeek Harness 0.2.1 and later refuse an
incompatible pairing at this step, with their own message, instead of failing later; and it shows in
DeepSeek Harness's Plugins page under its own name, description and icon.

**2. Start DeepSeek Harness** (`dsh web`, or any profile the connector is installed in). The
connector starts its local broker by itself when nothing is listening on the port, as a detached
process that outlives the DeepSeek Harness session. Then read the pairing code — `dsh plugin`
forwards `exec` to pnpm in the profile directory, where the package's own command is on the path:

```bash
dsh plugin --profile web exec dsh-connector-broker --pairing-code
```

(The same command without `--pairing-code` runs the broker in the foreground, if you would rather
start it yourself; `autoStartBroker: false` in the profile's `cordis.yml` turns the automatic
start off.)

**3. Install the Chrome extension** and type that code into its panel once. Its setup card says
whether the connector is reachable and shows these commands for your system.

> The extension is not on the Chrome Web Store yet. Until it is, load `extension/` unpacked from a
> clone. Note that current Chrome stable refuses `--load-extension` on the command line; use the
> **Load unpacked** button on `chrome://extensions` with Developer mode on.

**4. Use it.** Open the connector panel, pick a session, click **Attach** on the tab it should use. That session can
now operate that tab and nothing else.

## Using it

Ask your DeepSeek Harness session to do something in the browser. It has twenty-one tools, one
per protocol action: reading (`browser_snapshot`, `browser_screenshot`, `browser_read_text`,
`browser_current_url`, `browser_find`, `browser_wait`), acting (`browser_click`, `browser_type`, `browser_key`,
`browser_scroll`, `browser_hover`, `browser_select_option`, `browser_drag`), navigation
(`browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`), and the session's own
tabs (`browser_list_tabs`, `browser_open_tab`, `browser_switch_tab`, `browser_close_tab`).

`browser_screenshot` gives the model the attached tab's viewport as a JPEG through DeepSeek
Harness's own attachment service: a model catalogued as accepting images receives the pixels, a
text-only model receives DeepSeek Harness's placeholder naming the stored file. Chrome captures
only the tab at the front of its window, so a covered tab is brought to the front first and the
result says so. **Pixels are not masked** — the text redaction below does not apply to a picture —
so the tool's description steers the model to `browser_snapshot` for reading.

Every tool tells the truth about what happened. A control the user cannot see is never listed and
never acted on; a tab Chrome refused to close is reported as detached-but-open, not as closed; a
navigation that did not finish says so; an action cut off by a lost connection is reported as an
unknown outcome, and nothing is ever replayed on reconnect. A form the browser refuses as invalid
is reported as not submitted, with the reason, while the typing that did happen is still reported
as done.

The panel always shows the truth:

```
DeepSeek session  →  Chrome profile  →  attached tabs
```

If an action does not run, the panel says why — not paired, no session selected, no tab attached,
connector unreachable, versions mismatched. You should never have to guess what the agent can reach.

## What it does not do yet

DeepSeek Harness Desktop keeps its own `desktop` profile; installing there
(`dsh plugin --profile desktop add …`, with Desktop opened once and then quit) has not been tested
yet, and is not claimed.

Content inside iframes is neither read nor acted on: the page code runs in the tab's top document
and does not descend into frames. (Open shadow DOM — web components, most design systems — is
read and acted on as the user sees it, through slots and nested roots; a closed shadow root cannot
be reached by any script and is not claimed.) There is no trusted-input mode
(`chrome.debugger`) for sites that ignore synthetic events — ADR 0006 keeps it out of this version
on purpose, and says what adding it would cost.

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
npm run test:unit    # 295 tests, no browser needed
npm run test:page    # 17 tests, the shipped page module in a real Chrome for Testing
npm run test:e2e     # 77 tests, real Chrome with the extension loaded
```

The browser suites need Playwright's Chrome for Testing (`npx playwright install chromium`). The
end-to-end suites run headed by default, which is how users run the extension; on a machine with
no display, `DSH_E2E_HEADLESS=1` runs the full browser in its new headless mode instead, or
`xvfb-run --auto-servernum -- npm run test:e2e` keeps them headed. The released-pair suite needs
`dist/` from `node scripts/package.mjs --out dist` and a real `dsh` (`DSH_BIN_DIR` names its
bin directory; otherwise the first `~/dsh-int/<lane>/node_modules/.bin/dsh` is used); without
them it skips and says so. The live-turn suite also needs `@deepseek-ai/dsh-llm-mock-server`, at
the same version as that `dsh`, installed beside it. [`CONTRIBUTING.md`](CONTRIBUTING.md) has the
commands.

`node --experimental-strip-types tests/perf/measure.ts` measures what each action costs
(`docs/PERFORMANCE.md`), and `node --experimental-strip-types scripts/capture-screenshots.ts`
regenerates the Store screenshots from the real extension.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first: it states the
invariants that must never be violated, chiefly that routing is exact and failure is closed. A
change that could let one session reach another session's tab is not a bug report, it is a release
blocker. Security reports go through a private advisory ([`SECURITY.md`](SECURITY.md)).

Do not copy code from other DeepSeek Harness browser projects into this one.
[`docs/PROVENANCE.md`](docs/PROVENANCE.md) explains why and what the rules are.

## How it compares

Several projects connect DeepSeek Harness to a browser; they make different choices, and the right
one depends on what you need. As of 2026-11-05, from each project's own public listing or README:

| | This connector | [`Lum1104/dsh-browser`](https://github.com/Lum1104/dsh-browser) | "Deepseek Harness APP" ([Store listing](https://chromewebstore.google.com/detail/kgjjicancjnedmappjhefngdjaommpop)) | "DSH Browser Extension (All Platforms)" ([Store listing](https://chromewebstore.google.com/detail/agpipnjijkpomaannkijkilggoffdiaf)) |
|---|---|---|---|---|
| How it drives Chrome | scripts in the tabs you attach; no `debugger` | scripts in the tab it controls | the Chrome DevTools Protocol | not stated; page text and numbered controls |
| Which tab a session acts in | only tabs you attached to that exact session; one owner per tab; a call without a session fails | binds to the active tab when work begins; pauses and asks when you switch tabs | the tabs you direct it to | the tab you selected |
| DeepSeek Harness surfaces | any profile it is installed in — `web`, `headless`, `sdk`, `acp` — through its own local broker (live turns tested with the one-shot `headless`) | `dsh web` (the bridge rides the Web host) | `dsh web` with its companion plugin | the DeepSeek Harness desktop app |
| Installation | `dsh plugin add` from npm; DeepSeek Harness checks `engines.dsh` | an installer script that builds the repository | a separate DeepSeek Harness plugin, then the Store extension | the full GitHub project, then the extension |
| Chat in the browser | no — you talk to DeepSeek Harness where you run it | yes, side panel | yes, side panel | yes, side panel |
| Approving actions | attaching a tab to a session is the consent; no per-action prompt of its own | per action, with per-origin trust | not stated | optional ("act directly" is on by default) |
| Screenshots | yes, to a vision model, through DeepSeek Harness's attachment service | no, text only | yes | no, text only |
| Firefox | no | yes, from a source build | not stated | yes |

`Lum1104/dsh-browser` got there first and is a good fit if you want a chat panel in the browser or
Firefox. This connector is for keeping several sessions — or several DeepSeek Harness processes —
strictly apart, from any DeepSeek Harness surface, with the permission set and the provenance a
Chrome Web Store item needs. If another one suits you better, use it.

## Licence

MIT. See [`LICENSE`](LICENSE) and [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
