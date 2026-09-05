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

## Gates not yet met

These are release blockers that have no evidence yet. They are listed so the project cannot be
called ready while they are open.

| # | Gate | What will prove it | State |
|---|---|---|---|
| Y | The plugin loads into a real DeepSeek Harness and registers its tools | `npm pack` + `dsh plugin add` + `--dump-config` against dsh 0.1.2-rc.1, plus `companion/tests/tools.test.ts` | partial — applies and registers; a live model turn needs an API key |
| Z | Compatibility across the declared DSH range, plus an upstream lane | `docs/COMPATIBILITY.md` rows with CI evidence | open |
| AA | Service-worker eviction and recovery | Forced worker termination mid-request, then a successful next request | open |
| AB | Broker restart, DSH restart, and Chrome restart recovery | Component-by-component restart with verified recovery | open |
| AC | Installer: fresh, upgrade, reinstall, uninstall, spaces in paths, non-default `DSH_HOME` | `tests/installer/linux-installer.sh` (WSL Ubuntu 24.04, 21/21) and `tests/installer/windows-installer.ps1` (Windows 11, 19/19), each against a real `dsh` through the packaged tarball from a spaced path | **pass on Windows and Linux**; macOS open until its CI lane runs |
| AD | Packaged-artifact tests: the release ZIP, not the source tree | Load the built ZIP in Chromium and re-run the slice | open |
| AE | Reproducible packaging with a content allowlist | `scripts/package.mjs` + `scripts/verify-package.mjs`: 152 checks; the ZIP is byte-identical across two builds; the allowlist refused a stray `tsconfig.json` on its first run | pass |
| AF | The POSIX credentials-permission case actually runs | Linux installer lane verified `credentials.json` mode 600 in a mode 700 directory on a real filesystem; the unit test runs unskipped in the Linux and macOS CI lanes | pass (property verified on Linux; unit test pending CI) |
| AG | Extension JavaScript typecheck | `tsc -p extension/tsconfig.json --noEmit` with `checkJs`, exit 0; its first run found two unused imports and loose element types | pass |
| AH | Performance measured on representative tasks | Recorded latencies and message sizes, our own methodology | open |
| AI | Malicious-page fixtures: giant DOM, deep nesting, hostile labels, prompt injection | `tests/fixtures/hostile-*.html` driven through the real pipeline | open |

## Platform coverage

| Platform | Unit | E2E | Installer | State |
|---|---|---|---|---|
| Windows 11 | pass | pass | pass | All three run locally, installer against a real `dsh` |
| Ubuntu 24.04 | — | — | pass | Installer run locally under WSL 2 against a real `dsh`; unit and E2E await the CI lane |
| macOS | — | — | — | Untested; CI lanes configured but not yet run |

No platform is marked supported on the grounds that the code looks portable.
