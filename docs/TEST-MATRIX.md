# Test matrix

Every release gate, what proves it, and its current state. A gate is **passing** only when
`docs/TEST-EVIDENCE.md` records a run of the named command against the named artifact. Code
inspection is never evidence.

Legend: **pass** — evidence recorded. **open** — not yet implemented or not yet run.

## Release-blocking gates

### Routing and isolation

| # | Gate | Proof | State |
|---|---|---|---|
| A | Two sessions never act in each other's tabs under aggressive interleaving | `tests/e2e/isolation.test.ts` — 24 interleaved in-flight requests across two sessions, plus a cross-session click check | pass |
| B | A session sees and targets only its own tabs | `tests/e2e/isolation.test.ts` — three attached tabs, active-tab selection, and a refused attempt to point the session at a tab it does not own | pass |
| C | An unbound session fails and changes nothing | `tests/e2e/isolation.test.ts` — `NO_BINDING` for snapshot and click, with the page verified unchanged | pass |
| D | A transfer removes the old authority before the new one gains it | `tests/e2e/isolation.test.ts` — the previous session is refused after the transfer, the new one succeeds | pass |
| E | Two Chrome profiles keep distinct identities and scopes | `tests/e2e/isolation.test.ts` — two persistent contexts on one broker, distinct `browserId`, no cross-profile answer | pass |
| F | Ownership is revalidated after the action, not only before | `companion/tests/broker.test.ts` — results dropped when the tab moved session, moved browser, or is no longer active | pass |
| G | One tab has exactly one owner, inside one browser and across browsers | `companion/tests/bindings.test.ts`, `companion/tests/broker.test.ts` | pass |
| H | A forged or duplicated action result cannot settle a request | `companion/tests/broker.test.ts` | pass |

### Transport security

| # | Gate | Proof | State |
|---|---|---|---|
| I | A captured proof cannot be replayed as another role or against a new challenge | `companion/tests/auth.test.ts` | pass |
| J | A web-page origin cannot authenticate as either role | `companion/tests/broker.test.ts`, `companion/tests/integration.test.ts` | pass |
| K | A client without the secret is refused | `companion/tests/integration.test.ts` | pass |
| L | The broker binds only loopback | `companion/tests/integration.test.ts` — `requireLoopback` rejects every non-loopback address | pass |
| M | Malformed, oversized, and out-of-role frames are refused without affecting other clients | `companion/tests/broker.test.ts`, `companion/tests/integration.test.ts` | pass |
| N | A protocol mismatch fails closed and names which side is older | `companion/tests/broker.test.ts` | pass |

### Data protection

| # | Gate | Proof | State |
|---|---|---|---|
| O | Passwords, one-time codes, payment fields, and hidden values never reach a model | `companion/tests/redaction.test.ts`, `tests/e2e/slice.test.ts` — real page with real secret values, asserted absent from the snapshot | pass |
| P | Secret-bearing URL parameters and userinfo are scrubbed | `companion/tests/redaction.test.ts`, `tests/e2e/slice.test.ts` | pass |
| Q | Opaque-payload URLs are not reported verbatim | `companion/tests/redaction.test.ts` | pass |
| R | A stale element reference fails rather than acting on a reused element | `tests/e2e/slice.test.ts` | pass |
| S | Redaction happens in the page, before data crosses the extension boundary | `extension/src/page-actions.js` applies the config `redact.js` produces; `companion/tests/redaction.test.ts` proves the config carries every rule | pass |

### Honest reporting

| # | Gate | Proof | State |
|---|---|---|---|
| T | A refused or impossible action reports a failure, never `ok` | `tests/e2e/slice.test.ts` — disabled control, closed tab, restricted page | pass |
| U | The page, not the extension, is the authority on whether an action happened | `tests/e2e/slice.test.ts` — the click and type assertions read the page's own state | pass |

### Consistency

| # | Gate | Proof | State |
|---|---|---|---|
| V | The companion and extension protocol copies cannot diverge | `companion/tests/protocol-parity.test.ts` | pass |
| W | The companion and extension ownership registries behave identically | `companion/tests/bindings-parity.test.ts` — 300 randomised operations compared after every step | pass |
| X | Every panel state is reachable and has copy in every shipped locale | `companion/tests/panel-state.test.ts` | pass |
| AJ | No substantial source overlap with the third-party reference | `scripts/provenance-audit.mjs` at the pinned baselines: longest exact run 26 tokens (CSS), 1.01 % coverage after the twenty-action work, every run classified in `docs/PROVENANCE-AUDIT.md`; CI fails at 32 tokens or 2 % | pass |

### Visibility and honesty (added 2026-09-05 after an independent review)

| # | Gate | Proof | State |
|---|---|---|---|
| AK | Content the user cannot see never leaves the page: `opacity: 0`, `display: none`, `visibility: hidden`, and `content-visibility: hidden` ancestors, a closed `<details>`, hidden form controls, `aria-hidden`, `<template>`, `<noscript>`; and content re-shown inside a hidden ancestor still appears | `tests/fixtures/page-hidden.html` with deliberately non-secret `LEAK_ME_*` sentinels (so masking cannot hide a visibility bug) and `*_OK` sentinels (so over-hiding fails too), driven by `tests/e2e/visibility.test.ts`: snapshot text, names, and values; `read_text`; `find`; a name built from visible text only; a control hidden after the snapshot refused as `STALE_REF` | pass |
| AL | A tab action never reports success for work Chrome refused: a refused close is `ACTION_FAILED` with the tab detached, a vanished tab is `TAB_GONE` with the binding cleaned, a refused foreground is `foregrounded: false`; a screenshot is retried only for Chrome's two no-frame-yet answers and its two-per-second quota refusal, spaced inside that quota and bounded to four attempts, is discarded when the active tab changed during the capture, is `TAB_GONE` when the tab closed during it, and is refused before capture on a protected page or after it when larger than the connector carries | `companion/tests/tab-actions.test.ts`, 23 cases against a stubbed Chrome whose refusals the test controls | pass |
| AM | Every protocol action has exactly one tool, the registered set cannot drift from the declared list, and the fail-closed rule is proven with schema-valid arguments for every tool | `companion/tests/tools.test.ts`: a per-tool minimal-arguments table proven valid by reaching the broker once per tool with a session present, a negative control showing DeepSeek Harness validation runs first, and the load-time self-check in `registerBrowserTools` | pass |
| AN | The `tabs` permission is not needed, and a tab whose address Chrome withholds is treated as restricted, never as safe | The complete real-browser suite run with the permission (41/41) and without it (41/41); `tests/e2e/restricted.test.ts` for a browser-internal page in the chooser, on attach, and after an attached tab navigates to one | pass |
| AO | All twenty page and tab actions perform in a real browser, each proven by the page's own recorded state rather than the extension's report | `tests/e2e/actions.test.ts`, 12 cases over `tests/fixtures/page-c.html`; the twenty-first action, the screenshot, is gate AS | pass |

### Recovery (added 2026-09-05)

| # | Gate | Proof | State |
|---|---|---|---|
| AA | Service-worker eviction and recovery: an action in flight when the worker dies is reported `INTERRUPTED`, ran exactly once, and the next request after the worker returns succeeds | `tests/e2e/recovery.test.ts` — the worker is stopped through CDP `ServiceWorker.stopWorker` in the middle of a 1.5 s form submission; the page counts one run; an ordinary panel message wakes the worker, which reconnects and restores its bindings from storage | pass |
| AB | Broker, agent, Chrome, and tab loss recovery: both sides reconnect with bounded backoff and ownership comes back from the broker's state file; an agent connection that dies is replaced and its late result is dropped by the broker rather than delivered to the successor; a tab closed mid-action is reported gone — at once, from Chrome's tab-removed event, never as "the binding changed" after a slow injection (fixed 2026-09-11 after the macOS lane saw the slower path) — and leaves the binding; a Chrome relaunch on the same profile keeps pairing and identity but drops every binding, so a reissued tab id is never acted on | `tests/e2e/recovery.test.ts`, six cases on a persisted profile and state file. **Scope, stated precisely after a 2026-09-05 review:** Chrome, its service worker and the tab are real and are really taken away; the broker is an in-process instance that is closed and restarted on the same port, reloading its state file, not a killed `broker-main.js` process; the "plugin instance" is a raw agent socket, not a DeepSeek Harness process running the Cordis plugin. Gate AQ covers the process form | pass, within that scope |
| AP | A destructive action cut off mid-flight is reported as an unknown outcome — never as a refusal, never as a success — and is never replayed by any reconnect | `tests/e2e/recovery.test.ts` (the submission count stays at 1 across a broker restart and a worker kill), `companion/tests/broker.test.ts` (`INTERRUPTED` on browser loss, `NO_BROWSER` only before dispatch), `companion/tests/tools.test.ts` (the model is told the page may or may not have performed it) | pass |

### The released pair, hostile pages, cross-origin authority, performance (added 2026-09-11)

| # | Gate | Proof | State |
|---|---|---|---|
| AQ | The released **pair** works when installed as a user installs it: the tarball into a real `dsh`, the ZIP into a real Chrome, with nothing imported from the source tree; the broker as its own process, killed and restarted | `tests/e2e/released-pair.test.ts`, 5 cases: `dsh plugin add` of `dist/*.tgz` into a scratch home, `--dump-config`, the plugin applied by a real `dsh` process (only the missing API key stops it), `dist/*.zip` unpacked into Chromium, pairing with the code the installed `broker-main.js` prints, one action through the installed tool layer whose `defineTool` DeepSeek Harness linked for it, then SIGKILL and restart of the broker process with the next action succeeding from the ownership file. Run against `dsh` 0.1.2-rc.1, 0.1.5-rc.1 (npm `latest`) and 0.1.5-rc.2 (npm `next`), on Ubuntu 26.04, macOS 26.6 and Windows 11 | pass |
| AI | Malicious-page fixtures: giant DOM, deep nesting, hostile labels, prompt injection, giant attributes | Hidden content: gate AK. Bounds: `tests/page/page-actions.test.ts` (30,000 siblings cost 6,001 and 24,001 filter calls against budgets of 6,000 and 24,000; a 2 MB `role` bounded to 40 characters; a payload past 512 KB trimmed and reported `truncated`; a 200-deep chain walked without recursion — the browser itself dies building a deeper one, at about 500 for Chromium 131 and at 200 for the Chrome 153 headless shell on Windows). Injection: `tests/e2e/hostile.test.ts`, 7 cases through the shipped extension, the broker, and the real `defineTool`, asserted against the broker's registry, the panel's state, and every byte on the wire via a recording relay: instructions in text, values and attributes arrive as content; frame-shaped text makes no frame; the registry and session set are unchanged; the secret and the pairing code never cross; no registered tool attaches, pairs or reads a secret; `list_tabs` shows the session's one tab; `chrome.runtime` is absent from the page and a well-formed hello from a web origin is refused for its origin. Also found and fixed: a `title` attribute renaming a control that shows its own text | pass |
| AR | An attached session keeps its tab across a cross-origin navigation, whether the model navigates, follows a link, or the page moves itself (ADR 0009) | `tests/e2e/cross-origin.test.ts`, 3 cases with a second fixture origin on its own port; the registry is read from the broker after each. An action whose page navigated is reported as a navigation (`navigated: true`, new address), a read cut off by a navigation is answered from the page that arrived, never "Chrome refused" | pass |
| AH | Performance measured on representative tasks | `tests/perf/measure.ts`, `docs/PERFORMANCE.md`: median and p95 over 30 runs for snapshot, read, click, find and current_url on `page-a`, `page-c` and a generated large page, with the exact bytes of both answer frames read off the relay, plus the walk deadline's clock cost, on a named machine in both modes | pass |
| Y | The plugin loads into a real DeepSeek Harness, registers its tools, and a live turn of that DeepSeek Harness executes one of them through the released pair | `tests/e2e/live-turn.test.ts`: `dsh --profile headless "<task>"` — the real process, profile, session and agent loop — with its provider answered by DeepSeek Harness's own `@deepseek-ai/dsh-llm-mock-server` over real HTTP (a rate limit, then one tool call, then a sentence), three turns each in its own process. Every agent request offered the twenty-one browser tools beside DeepSeek Harness's own; the session the process announced is the one the panel attached the tab to; the `browser_snapshot` result that went back to the provider carries the attached page and its controls with the password field masked; the process printed the provider's sentence and exited 0. Run against `dsh` 0.1.2-rc.1, 0.1.5-rc.1 and 0.1.5-rc.2. **The model's judgment is scripted, and that is the one thing this does not test**; a run with a real provider key is a one-line change of the provider endpoint and belongs to the owner | pass |
| AS | A screenshot is of the attached tab, as bytes; a covered tab is brought to the front and the result says so; a protected page is refused; and through a real DeepSeek Harness the image reaches a model that accepts images as pixels, and a text-only model as DeepSeek Harness's own placeholder naming the stored file | `tests/e2e/screenshot.test.ts`, 3 cases: the JPEG's own start-of-frame dimensions equal the reported ones and the capture is the attached tab even when another tab covered it (`foregrounded: true`, and the tab is active afterwards); `chrome://version/` refused `RESTRICTED_PAGE`. `tests/e2e/live-turn.test.ts`, two turns: with `deepseek-v4-flash-vision-exp` the final request carries the connector's caption and DeepSeek Harness's image handle in the `tool` message and the JPEG itself, inline base64 in the user message the adapter appends, at exactly the preview size the handle announced (1280×720 fitted to 1066×600 by DeepSeek Harness's request budget), with the 1280×720 durable copy under `attachments/v1/objects/`; with `deepseek-v4-flash` the tool message is `[image omitted because this model accepts text only; attachment sha256:…]` followed by the caption, no image part anywhere, and the same durable copy saved. Run against `dsh` 0.1.2-rc.1, 0.1.5-rc.1 and 0.1.5-rc.2 | pass |

## Gates not yet met

These are release blockers that have no evidence yet, or only partial evidence. They are listed so
the project cannot be called ready while they are open.

| # | Gate | What will prove it | State |
|---|---|---|---|
| Z | Compatibility across the declared DSH range, plus an upstream lane | `docs/COMPATIBILITY.md` rows: 0.1.2-rc.1, 0.1.5-rc.1 (`latest`) and 0.1.5-rc.2 (`next`) each with the released lane's commands run by hand on 2026-09-11 and gate AQ; the CI jobs `dsh-integration` and `released-pair` exist | partial — every lane has run by hand; **none has run on GitHub** because no remote exists, and the upstream lane is CI-only |
| AC | Installer: fresh, upgrade, reinstall, uninstall, spaces in paths, a relative package path and a path that names nothing, non-default `DSH_HOME`, a machine without pnpm, files arriving from a browser | `tests/installer/linux-installer.sh` 23/23 on Ubuntu 26.04 (native, against `dsh` 0.1.2-rc.1, 0.1.5-rc.1 and 0.1.5-rc.2) and macOS 26.6; `tests/installer/windows-installer.ps1` 21/21 on a Windows 11 machine that had never seen the project; each against a real `dsh` 0.1.5-rc.1 through the packaged tarball from a spaced path, the reinstall from the tarball's directory by bare file name (2026-09-12: a relative path had reached pnpm, which read it as a GitHub shorthand). Without pnpm both installers stop before creating anything and name the fix. Arrival: on macOS a quarantined `install.sh` runs through `bash` and directly; on Windows a marked `install.ps1` is refused by the user's `RemoteSigned` policy and 0 files are created, the marked `Install Connector.cmd` wrapper runs, and `Unblock-File` makes the direct run work — see `docs/RELEASE.md` | pass on Linux, macOS and Windows; the Explorer double-click of the marked `.cmd` (SmartScreen) is the one path no lane over SSH can exercise |
| AD | Packaged-artifact tests: the release **extension ZIP**, not the extension source tree | `tests/e2e/packaged.test.ts` builds the ZIP in-process, unpacks its own bytes, and Chromium loads that directory (4/4); the in-process build is byte-identical to `dist/`. The companion side of that run is the source tree; gate AQ covers the packaged pair | pass |
| AE | Reproducible packaging with a content allowlist, a companion tarball proven fresh, and a frozen permission set | `scripts/package.mjs` + `scripts/verify-package.mjs`: 582 checks, including the frozen permission set (ADR 0009); the same commit built on Ubuntu, macOS and Windows produced byte-identical ZIP and tarball (2026-09-11) | pass |
| AF | The POSIX credentials-permission case actually runs | The unit test ran unskipped on Ubuntu 26.04 and macOS 26.6 (258/258 on 2026-09-12); the Linux and macOS installer lanes verified mode 600 in a mode 700 directory on real filesystems | pass |

## Platform coverage

Every row was run on 2026-09-12 at the commit `docs/TEST-EVIDENCE.md` names, on real machines
reached over the project's own tailnet where they are not the development machine.

| Platform | Typecheck, build | Unit | Page module | E2E (68: released pair, three live turns and the screenshot included) | Installer | Package hashes | State |
|---|---|---|---|---|---|---|---|
| Ubuntu 26.04.1 (native, x86-64, Node 26.8) | pass | 258/258, POSIX case unskipped | 14/14 | 68/68 headed under Xvfb **and** 68/68 new headless | 23/23 against `dsh` 0.1.2-rc.1, 0.1.5-rc.1 and 0.1.5-rc.2 | reference | supported |
| macOS 26.6.2 (arm64, Node 26.7) | pass | 258/258, POSIX case unskipped | 14/14 | 68/68 new headless, plus the vertical slice headed (9/9) | 23/23 against `dsh` 0.1.5-rc.1, quarantined arrival rehearsed | identical to Linux | supported |
| Windows 11 Pro 10.0.26200 (x86-64, Node 24.14, Windows PowerShell 5.1) | pass | 258 with the POSIX case skipped | 14/14 | 68/68 new headless | 21/21 against `dsh` 0.1.5-rc.1, Mark-of-the-Web arrival rehearsed | identical to Linux | supported |
| WSL 2 Ubuntu 24.04 | — | — | — | — | 21/21 on 2026-09-05 | — | historical; superseded by the native rows |

No platform is marked supported on the grounds that the code looks portable. Headed runs on
Windows over SSH have no desktop session to draw on and were not attempted; the headed mode is
covered on Linux and macOS.

