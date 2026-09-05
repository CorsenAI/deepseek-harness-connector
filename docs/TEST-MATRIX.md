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
| AL | A tab action never reports success for work Chrome refused: a refused close is `ACTION_FAILED` with the tab detached, a vanished tab is `TAB_GONE` with the binding cleaned, a refused foreground is `foregrounded: false` | `companion/tests/tab-actions.test.ts`, 14 cases against a stubbed Chrome whose refusals the test controls | pass |
| AM | Every protocol action has exactly one tool, the registered set cannot drift from the declared list, and the fail-closed rule is proven with schema-valid arguments for every tool | `companion/tests/tools.test.ts`: a per-tool minimal-arguments table proven valid by reaching the broker once per tool with a session present, a negative control showing DeepSeek Harness validation runs first, and the load-time self-check in `registerBrowserTools` | pass |
| AN | The `tabs` permission is not needed, and a tab whose address Chrome withholds is treated as restricted, never as safe | The complete real-browser suite run with the permission (41/41) and without it (41/41); `tests/e2e/restricted.test.ts` for a browser-internal page in the chooser, on attach, and after an attached tab navigates to one | pass |
| AO | All twenty actions perform in a real browser, each proven by the page's own recorded state rather than the extension's report | `tests/e2e/actions.test.ts`, 12 cases over `tests/fixtures/page-c.html` | pass |

### Recovery (added 2026-09-05)

| # | Gate | Proof | State |
|---|---|---|---|
| AA | Service-worker eviction and recovery: an action in flight when the worker dies is reported `INTERRUPTED`, ran exactly once, and the next request after the worker returns succeeds | `tests/e2e/recovery.test.ts` — the worker is stopped through CDP `ServiceWorker.stopWorker` in the middle of a 1.5 s form submission; the page counts one run; an ordinary panel message wakes the worker, which reconnects and restores its bindings from storage | pass |
| AB | Broker, plugin, Chrome, and tab loss recovery: both sides reconnect with bounded backoff and ownership comes back from the broker's state file; a plugin instance that dies is replaced and its late result is dropped by the broker rather than delivered to the successor; a tab closed mid-action is reported gone and leaves the binding; a Chrome relaunch on the same profile keeps pairing and identity but drops every binding, so a reissued tab id is never acted on | `tests/e2e/recovery.test.ts`, six cases each taking one real component away mid-flight, on a persisted profile and state file | pass |
| AP | A destructive action cut off mid-flight is reported as an unknown outcome — never as a refusal, never as a success — and is never replayed by any reconnect | `tests/e2e/recovery.test.ts` (the submission count stays at 1 across a broker restart and a worker kill), `companion/tests/broker.test.ts` (`INTERRUPTED` on browser loss, `NO_BROWSER` only before dispatch), `companion/tests/tools.test.ts` (the model is told the page may or may not have performed it) | pass |

## Gates not yet met

These are release blockers that have no evidence yet. They are listed so the project cannot be
called ready while they are open.

| # | Gate | What will prove it | State |
|---|---|---|---|
| Y | The plugin loads into a real DeepSeek Harness and registers its tools | `npm pack` + `dsh plugin add` + `--dump-config` against dsh 0.1.2-rc.1, plus `companion/tests/tools.test.ts` | partial — applies and registers; a live model turn needs an API key |
| Z | Compatibility across the declared DSH range, plus an upstream lane | `docs/COMPATIBILITY.md` rows with CI evidence | open |
| AC | Installer: fresh, upgrade, reinstall, uninstall, spaces in paths, non-default `DSH_HOME` | `tests/installer/linux-installer.sh` (WSL Ubuntu 24.04, 21/21) and `tests/installer/windows-installer.ps1` (Windows 11, 19/19), each against a real `dsh` through the packaged tarball from a spaced path | **pass on Windows and Linux**; macOS open until its CI lane runs |
| AD | Packaged-artifact tests: the release ZIP, not the source tree | `tests/e2e/packaged.test.ts` builds the ZIP in-process, unpacks its own bytes, and Chromium loads that directory: allowlist match, pair, snapshot, secret masking, click confirmed by the page (4/4). The in-process build is byte-identical to `dist/dsh-browser-connector-extension-0.1.0.zip`, SHA-256 `2a76f138…d2c4`, built from clean commit `5e935d2` | pass |
| AE | Reproducible packaging with a content allowlist | `scripts/package.mjs` + `scripts/verify-package.mjs`: 152 checks; the ZIP is byte-identical across two builds; the allowlist refused a stray `tsconfig.json` on its first run | pass |
| AF | The POSIX credentials-permission case actually runs | Linux installer lane verified `credentials.json` mode 600 in a mode 700 directory on a real filesystem; the unit test runs unskipped in the Linux and macOS CI lanes | pass (property verified on Linux; unit test pending CI) |
| AG | Extension JavaScript typecheck | `tsc -p extension/tsconfig.json --noEmit` with `checkJs`, exit 0; its first run found two unused imports and loose element types | pass |
| AH | Performance measured on representative tasks | Recorded latencies and message sizes, our own methodology | open |
| AI | Malicious-page fixtures: giant DOM, deep nesting, hostile labels, prompt injection, giant attributes | Hidden content and hidden controls are covered by gate AK (`page-hidden.html`). Giant DOM, deep nesting, injection labels, and giant attributes remain: `tests/fixtures/hostile-*.html` through the real pipeline | partial — hidden content covered; bounds under hostile DOMs open |

## Platform coverage

| Platform | Unit | E2E | Installer | State |
|---|---|---|---|---|
| Windows 11 | pass | pass | pass | All three run locally, installer against a real `dsh` |
| Ubuntu 24.04 | — | — | pass | Installer run locally under WSL 2 against a real `dsh`; unit and E2E await the CI lane |
| macOS | — | — | — | Untested; CI lanes configured but not yet run |

No platform is marked supported on the grounds that the code looks portable.
