# Test evidence

Only runs that actually happened, with the command, the environment, and the real result. A gate in
`docs/TEST-MATRIX.md` is passing only when it appears here.

---

## 2026-09-04 — vertical slice and multi-session isolation

**Commit under test.** `6417915` plus the test-only fixes made while recording this evidence; the
run below is the state committed immediately after.

**Environment.**

| | |
|---|---|
| OS | Windows 11 Pro for Workstations, 10.0.26200 |
| Node | v24.12.0 |
| Playwright | 1.49.1 |
| Browser | Playwright Chromium, headed, extension loaded unpacked from `extension/` |
| DeepSeek Harness packages | `@deepseek-ai/dsh-tools` 0.1.2-rc.1, `@deepseek-ai/cordis` 4.0.2, `@deepseek-ai/schemastery` 3.18.2 |
| Timestamp | 2026-09-04T20:36:59Z |

### Unit, protocol, security, and parity suites

```
node --test --experimental-strip-types "companion/tests/*.test.ts"
```

```
ℹ tests 181
ℹ suites 33
ℹ pass 180
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 982.5252
```

The single skip is `restricts the secret to the owner on POSIX`, which asserts mode `0600` and does
not apply on Windows. Gate AF stays open until CI runs it on Linux and macOS.

### Real-browser end-to-end

```
node --test --test-concurrency=1 --experimental-strip-types "tests/e2e/*.test.ts"
```

```
ℹ tests 15
ℹ suites 7
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9268.4429
```

Covering, in a real browser with the real extension:

- the vertical slice: pair, attach, snapshot, click, type, current URL, stale reference, disabled
  control, URL scrubbing, unbound session, closed tab (9 cases);
- multi-session isolation tests A to E (6 cases), including two Chrome profiles on one broker.

### Type checking

```
node companion/node_modules/typescript/bin/tsc -p companion/tsconfig.json --noEmit
```

Clean, under `strict`, `noImplicitAny`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `noFallthroughCasesInSwitch`, `isolatedModules`, and `erasableSyntaxOnly`.

### Built artifact

```
node companion/node_modules/typescript/bin/tsc -p companion/tsconfig.build.json
node companion/lib/broker-main.js --help
node companion/lib/broker-main.js --pairing-code --home <temporary>
```

The build emitted `lib/` with `.ts` imports rewritten to `.js`. The compiled broker printed its
usage text and generated a real pairing code (`VT6F-C6T9-6RK9-9D7W`, from a throwaway home that was
deleted afterwards). This is the compiled output running, not the source tree.

### Gates this run closes

A, B, C, D, E, F, G, H, I, J, K, L, M, N, O, P, Q, R, S, T, U, V, W, X.

### Gates still open

Y, Z, AA, AB, AC, AD, AE, AF, AG, AH, AI. See `docs/TEST-MATRIX.md`.

---

## 2026-09-04 — the plugin loads into a real DeepSeek Harness (gate Y)

**Environment.** Windows 11, Node v24.12.0, `@deepseek-ai/dsh` 0.1.2-rc.1 installed from npm into a
throwaway `DSH_HOME`, pnpm 11.5.2.

### The published artifact, not the source tree

```
npm pack                 # companion/ -> corsen-ai-dsh-browser-connector-0.1.0.tgz, 32 files, 50909 bytes
dsh plugin --profile headless add ./corsen-ai-dsh-browser-connector-0.1.0.tgz
```

DeepSeek Harness initialised the profile and, without any YAML being edited, appended the package to
the profile layer stack because its manifest declares `dsh.bundle.patch`:

```json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "@corsen-ai/dsh-browser-connector"
] } }
```

This is ADR 0002 confirmed against the shipped CLI rather than against its source.

### The composed Cordis tree

```
dsh --profile headless --dump-config
```

```yaml
# == @corsen-ai/dsh-browser-connector
- id: corsen-browser-connector
  name: "@corsen-ai/dsh-browser-connector"
  inject:
    - tools
  config:
    port: 8781
    profileName: ""
    requireSupportedHarness: true
```

### The plugin applies

```
dsh --profile headless "say hi"
```

```
dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"
```

The only failure is the absent API key. The connector produced no error, which means its version
gate resolved `@deepseek-ai/dsh-tools` and accepted the runtime, and `ctx.effect`,
`observeSessions`, and `registerBrowserTools` all ran. Had the gate rejected the runtime it would
have thrown `corsen-browser-connector: ...` naming the supported range.

### Tool registration, automated

```
node --test --experimental-strip-types companion/tests/tools.test.ts
```

```
ℹ tests 20
ℹ pass 20
ℹ fail 0
```

Run against the real published `defineTool`, so the schemas and renderers are exercised by
DeepSeek Harness code. Proves the five implemented tools register, that a call with no `exec.agent`
refuses and contacts no browser, that the session is read per call rather than cached, and that
typed text is never echoed back into the transcript.

### What this does not yet prove

A model actually calling these tools end to end needs a `DEEPSEEK_API_KEY`, which this environment
does not have. Gate Y is therefore proven up to plugin application and tool registration, not up to
a live model turn. That remains recorded as partial rather than claimed as complete.

---

## 2026-09-04 — packaging, reproducibility, leak scan, and the extension typecheck (gates AE, AG)

**Environment.** Windows 11, Node v24.12.0. Working tree not yet clean at the time of the run, so
`release-manifest.json` records `cleanTree: false` — this is a gate rehearsal, not a release build.

### Deterministic extension ZIP

```
node scripts/package.mjs --out dist
```

```
wrote dsh-browser-connector-extension-0.1.0.zip (35464 bytes, 14 files)
sha256 889c3bd433c272079387a0e0e113adda46a01e270f0298161125b5b082ef5e25
```

The archive is produced by an in-repo encoder: sorted entries, fixed 1980-01-01 timestamps, no extra
fields, no external attributes. Building twice from the same tree and comparing with `cmp`:

```
BYTE-IDENTICAL across two builds
```

### The allowlist refusing a stray file

The first packaging attempt failed with
`refusing to package: unexpected files in extension/: tsconfig.json` — a tooling file added minutes
earlier. That is the gate working: a file enters the Store package only by being named in
`EXTENSION_ALLOWLIST` or `EXTENSION_TOOLING`, never by existing.

### Verification

```
node scripts/verify-package.mjs --dist dist
```

```
152 checks, 0 failures — all checks passed
```

Covering: the ZIP contains exactly the fourteen allowlisted files; every text file is scanned for
personal paths, private emails, token literals, pairing-code-shaped literals, AWS keys, private-key
blocks, machine names, and dotenv references; no dynamic code evaluation or construction; no remote
host other than loopback and the project page; the manifest is MV3 with no `cookies`, `debugger`,
or `webRequest`; rebuilding in-process yields identical bytes; `SHA256SUMS` matches both artifacts;
the tarball (parsed in-process, 32 entries) is rooted at `package/`, ships `lib/` and not `src/`
or `tests/`, and carries `cordis.patch.yml` and the broker entry.

The scanner caught one real finding on its first run: the panel's pairing-code placeholder
`XXXX-XXXX-XXXX-XXXX-XXXX` matched the pairing-code pattern, because `X` is in the alphabet. The
placeholder now uses zeros, which the alphabet excludes; the scanner stays strict.

### Extension typecheck

```
node companion/node_modules/typescript/bin/tsc -p extension/tsconfig.json --noEmit
```

Exit 0 under `checkJs` with `noUnusedLocals`, `noImplicitThis`, `strictBindCallApply`, and the
Chrome type declarations. Its first run found two unused imports in the service worker and a set of
loose element types in the page interface, all corrected. The correction to `resolve()` in the
injected function was a real code change, so the end-to-end suite was re-run afterwards: 15/15.

### Gates this run closes

AE (reproducible packaging with a content allowlist), AG (extension JavaScript typecheck).

---

## 2026-09-04 — installer acceptance on Windows and Linux (gates AC, AF)

Each lane runs the real installer against a real `@deepseek-ai/dsh` 0.1.2-rc.1 and a throwaway
`DSH_HOME`, through the packaged tarball, in three phases: fresh install, install over an existing
install, uninstall. The tarball sits under `…/DeepSeek Harness connector/dist/`, so every lane also
exercises a path containing a space. Pairing codes were generated in throwaway homes that were
deleted afterwards and are shown redacted.

The acceptance scripts are repository artifacts, not one-off shell sessions:
`tests/installer/linux-installer.sh` and `tests/installer/windows-installer.ps1`. Each prints one
line per expectation checked and exits non-zero on any failure, and `.github/workflows/ci.yml` runs
them per platform.

### Ubuntu 24.04 (WSL 2) — `scripts/install.sh`

```
tests/installer/linux-installer.sh <tarball> ~/dsh-int/node_modules/.bin
```

Node v22.22.2, pnpm 11.5.2. **21 of 21 expectations met, exit 0.**

| Phase | Observed |
|---|---|
| Fresh install | Spaced tarball path accepted unmodified by `dsh plugin add` (no shell is involved on Linux); profile initialised; bundle appended by DeepSeek Harness; broker started and answering **426** on `127.0.0.1:18782`; `credentials.json` written with mode **600** inside a **700** directory; pairing code `AV3K-…-7RJ4` in the expected shape. |
| Upgrade | Previous broker (pid 781032) stopped, new broker (pid 781350) alive, one listener on the port, **pairing code unchanged** — paired browsers stay paired across an upgrade. |
| Uninstall | `pnpm remove` succeeded; bundle list back to `dsh-base, dsh-headless`; broker stopped; credentials kept for re-pair. |

The mode checks close gate AF's property on a real POSIX filesystem. The unit test that asserts the
same mode (`auth.test.ts`, skipped on Windows) runs unskipped in the Linux and macOS CI lanes.

### Windows 11 — `scripts/install.ps1` under Windows PowerShell 5.1

```
tests\installer\windows-installer.ps1 -Tarball .\dist\corsen-ai-dsh-browser-connector-0.1.0.tgz -DshBin <dsh .bin dir>
```

Node v24.12.0, `dsh` resolved to npm's `dsh.ps1` shim. **19 of 19 expectations met, exit 0.**

| Phase | Observed |
|---|---|
| Fresh install | Short path `CHROME~1\DEEPSE~1\dist\CORSEN~1.TGZ` handed to `dsh plugin add`; profile initialised; bundle appended; broker started and answering **426** on `127.0.0.1:18781`; `credentials.json` and `broker.pid` written; pairing code `MF6R-…-CVN7` in the expected shape. Fresh install completes in about 2 s. |
| Upgrade | Previous broker stopped, new broker alive, one listener on the port, **pairing code unchanged**. |
| Uninstall | `pnpm remove` succeeded; bundle list back to `dsh-base, dsh-headless`; broker stopped; credentials kept for re-pair. |

### Defects the Windows lane found before passing

Recorded because a test that never failed anything is weak evidence. Each was diagnosed by
observation, not guessed at, and fixed in the installer rather than in the test.

1. **The version check refused every valid Node.** Windows PowerShell strips inner double quotes on
   the way to a native executable, so `node -p 'process.versions.node.split(".")[0]'` reached node
   as `split(.)` and threw; the installer then reported "22.19 or newer required; found v24.12.0".
   Fixed with `parseInt(process.versions.node)`, which needs no quoting on either shell.
2. **A descending-range slice injected a null argument.** `@("dsh")[1..0]` is `@($null, "dsh")` in
   PowerShell, so the common case — `dsh` directly on PATH — was the broken one. Fixed by keeping
   the executable and its fixed arguments apart.
3. **An array expression is not a splat.** `& $exe @($a + $b)` binds to npm's `dsh.ps1` shim as a
   single `$args[0]`, and the shim hands node one space-joined token, so `dsh` reported
   `--profile` missing. Proven with an argv-echo probe under PowerShell 5.1 (the `.cmd` shim and
   `@variable` splatting both deliver arguments correctly; the `.ps1` shim with an array value does
   not). Fixed with `@variable` splatting.
4. **Upstream: `dsh plugin` splits a spaced path on Windows.** `spawnSync("pnpm", args,
   { shell: process.platform === "win32" })` lets `cmd.exe` re-tokenize the command line. Confirmed
   A/B on 2026-09-04: identical bytes install from a space-free copy and fail from the spaced path
   with `ENOENT …\connector\dist\…` plus a fetch of a package named `Harness`. Worked around with
   the file's Windows 8.3 short name — no copy, works wherever the file lives, and stops with an
   explanation when short names are disabled on the volume. Recorded in `docs/COMPATIBILITY.md`.

### Not covered by this run

macOS. The POSIX script is expected to work there, but "expected" is not evidence; the macOS CI
lane exists for that and has not yet run. The Windows 8.3 workaround is exercised only locally,
because GitHub runner paths contain no spaces.

### Gates this run closes

AC on Windows and Linux; AF by real-filesystem verification. AC on macOS stays open.

---

## 2026-09-05 — the packaged ZIP in a real browser (gate AD)

```
node --test --test-concurrency=1 --experimental-strip-types tests/e2e/packaged.test.ts
```

The test calls `buildExtensionZip()` from `scripts/package.mjs`, so it exercises the exact encoder
the release uses, then unpacks the archive's own bytes with the matching `readZip()` into a fresh
temporary directory and points the E2E harness at that directory instead of `extension/`.

```
packaged zip: 35464 bytes, sha256 889c3bd433c272079387a0e0e113adda46a01e270f0298161125b5b082ef5e25
✔ unpacks to exactly the allowlisted files and nothing else
✔ loads, pairs, and reaches an attached tab from the packaged bytes
✔ masks secrets from the packaged page interface
✔ clicks, and the page confirms it, from the packaged bytes
ℹ pass 4  fail 0
```

The SHA-256 is identical to the `dist/` artifact verified by `verify-package.mjs` (152/152 after
`readZip` moved into the packager), so the bytes tested here are the bytes that would ship.

### Gate this run closes

AD.

---

## 2026-09-05 — provenance audit (gate AJ)

```
node scripts/provenance-audit.mjs --exact 16 --shape 40 --max-run 32 --max-coverage 2 --json provenance-audit.json
```

References at the baselines in `docs/PROVENANCE.md`: `dsh-browser` `e60e6e3f` (157 files,
202 258 tokens) and `hermes-connector` `bfd9bc29` (48 files, 98 836 tokens). Subject: 49 files,
65 665 tokens. Runtime about one second.

```
== dsh-browser (third-party: boilerplate only) ==
longest exact shared run: 26 tokens — ours extension/src/sidepanel.css:139, theirs …/panel/styles.css:1160
exact runs >= 16 tokens: 30, covering 549 subject tokens (0.84%)
shape runs >= 40 tokens: 19, covering 905 subject tokens (1.38%)
== hermes-connector (Corsen-owned: overlap expected) ==
longest exact shared run: 48 tokens — ours extension/src/background.js:142, theirs …/tests/background-session.test.mjs:32
exact runs >= 16 tokens: 40, covering 860 subject tokens (1.31%)
shape runs >= 40 tokens: 25, covering 1308 subject tokens (1.99%)
audit gate passed: no third-party exact run >= 32 tokens, coverage <= 2%
```

Every run is classified in `docs/PROVENANCE-AUDIT.md`; the two most notable were inspected by hand
and their source excerpts compared. The gate was also shown to reject an invalid case: with
`--max-run 20` (below the measured 26) and separately with `--max-coverage 0.5` (below the
measured 0.84 %) it printed `AUDIT FAILED` and exited 2.

### Gate this run closes

AJ.

## Findings this evidence run produced

Three defects were found by these tests and fixed in the implementation, not worked around in the
tests. They are recorded here because a test suite that never fails anything is not evidence of
much.

1. **Two sessions could co-own one tab inside one browser.** `binding_update` assigned the incoming
   binding directly, so a browser reporting one tab under two scopes left the broker willing to
   route both sessions to the same signed-in page. Found by `broker.test.ts`; fixed by stripping the
   claimed tabs from every other scope and refusing a `binding_sync` that claims one tab twice.
2. **Opaque-payload URLs were reported verbatim.** `new URL()` parses `javascript:`, `data:`, and
   `blob:` without error, so `scrubUrl` returned them unchanged and an inline program or base64
   document would have reached a model request. Found by `redaction.test.ts`; fixed with a
   reportable-scheme allowlist.
3. **The pairing code could never have worked.** It was a digest of the secret, which the extension
   cannot invert, so no proof it computed could ever verify. Found while wiring the service worker;
   fixed by making the code the secret itself, 20 characters of a confusion-free alphabet drawn by
   rejection sampling.

## Notes for whoever runs this next

- Chrome stable refuses `--load-extension`, so the extension silently never loads and no service
  worker appears. The E2E harness uses Playwright's own Chromium deliberately; do not "fix" it to
  use the installed Chrome.
- MV3 service workers do not start under the old headless shell. The harness runs headed.
- A service worker cannot `sendMessage` to its own listener. The harness drives the extension
  through a page at the extension origin, which is how the side panel does it in production.
- `node:test` runs top-level suites concurrently. The isolation suites share one browser, so they
  are nested under a single suite to run in order; splitting them back out reintroduces
  cross-test interference that looks exactly like a routing leak.

---

## 2026-09-05 — hardening gate: twenty actions, one visibility policy, honest tab results, `tabs` dropped

**Trigger.** An independent review of the working tree found two unit regressions, a visibility
leak, and a false-success path, and required a clean, evidenced checkpoint before any Store work.

**Commits under test.** `9f92cd0` (feature, visibility, honesty), `522c581` (`tabs` removed),
`5e935d2` (disclosures). The memory-and-evidence commit that carries this section follows them and
changes no code.

**Environment.**

| | |
|---|---|
| OS | Windows 11 Pro for Workstations, 10.0.26200 |
| Node | v24.12.0 |
| Playwright | 1.49.1, its own Chromium, headed |
| DeepSeek Harness packages | `@deepseek-ai/dsh-tools` 0.1.2-rc.1, `@deepseek-ai/cordis` 4.0.2, `@deepseek-ai/schemastery` 3.18.2 |

### Unit, protocol, security, parity, tools, tab actions

```
node --test --experimental-strip-types "companion/tests/*.test.ts"
```

```
ℹ tests 222
ℹ suites 43
ℹ pass 221
ℹ fail 0
ℹ skipped 1
```

The skip is the POSIX `0600` check on Windows, as before. New this session: `tools.test.ts`
rewritten around the authoritative `BROWSER_TOOL_NAMES` list, a per-tool `MINIMAL_ARGS` table, a
validity proof (every tool reaches the broker exactly once with a session present; the twenty
requests cover the twenty protocol actions), and a negative control (`browser_key` with no `key`
is refused by DeepSeek Harness validation, not by our session rule); `tab-actions.test.ts`, 14
cases against a stubbed Chrome whose refusals the test controls.

### Type checking

```
node companion/node_modules/typescript/bin/tsc -p companion/tsconfig.json --noEmit   # exit 0
node companion/node_modules/typescript/bin/tsc -p extension/tsconfig.json --noEmit   # exit 0 (checkJs)
```

### Real-browser end-to-end — first full run after the visibility rewrite

```
ℹ tests 39   pass 34   fail 5
```

Recorded because a suite that never fails proves little. The three visibility suites passed on the
first run; the five failures were all in `actions.test.ts`, which had been written but never
run. Each was diagnosed by measurement, not guesswork:

- **drag**: "Drop here" is a `div` with `ondrop`/`ondragover` and nothing else, so it was never
  interactive — a drop target that declares itself now is. Then a second failure: the test took two
  snapshots, so its second ref was stale, which is the security property working; both refs now come
  from one snapshot.
- **wait**: the fixture's mutation fired at 400 ms against a 300 ms quiet window, a race by
  construction. The quiet window is now 500 ms (the `networkidle` heuristic), and the test asserts
  the wait was actually extended.
- **scroll**: `rect.bottom` 720.075 against `innerHeight` 720 — sub-pixel layout, the element was in
  the viewport. One pixel of tolerance, documented.
- **back with no history**: a Playwright tab keeps its initial `about:blank` entry
  (`history.length` 2 after the first `goto`), so its history is never empty. The case now uses a tab
  the session opened itself, which has one entry and whose `back` Chrome refuses.
- **navigate then back landed on `about:blank`**: reproducible only when `back` followed `navigate`
  within a few milliseconds in a tab Playwright had just loaded. A probe at 0, 50, and 200 ms
  passed 4/4 in isolation; inside the suite the difference was that Playwright's `load` resolves
  slightly before Chrome marks the tab `complete`, and a navigation issued in that gap replaces the
  loading entry. Two fixes, both kept: every navigation action now waits for a tab Chrome says is
  complete NOW at a new address, and the fixture waits for Chrome's own `complete` before handing a
  tab to a case. The three top-level suites also ran concurrently on one browser and are now nested
  under one suite, the same trap `isolation.test.ts` documented.

### Real-browser end-to-end — the committed code, `tabs` permission present

```
node --test --test-concurrency=1 --experimental-strip-types "tests/e2e/*.test.ts"
```

```
ℹ tests 41   suites 16   pass 41   fail 0   duration_ms 22754
```

### The same suite with `tabs` removed — the shipped manifest

```
ℹ tests 41   suites 16   pass 41   fail 0   duration_ms 22712
```

Suites: browser actions (12), multi-session isolation A–E (6), the packaged extension (4), pages
Chrome protects (2), the vertical slice (9), hidden content never leaves the page (4), visible
content still gets through (3), an action on a control the user can no longer see (1).

The restricted-page cases pass in both runs by different routes: with `tabs`, the internal page
reports a `chrome://` address; without it, Chrome withholds the address and the extension treats a
tab with no address as restricted. Both are refused on attach, and an attached tab that navigates
to an internal page fails `RESTRICTED_PAGE` rather than being injected into.

### Release artifacts, from clean commit `5e935d2`

```
npm run build && node scripts/package.mjs --out dist && node scripts/verify-package.mjs --dist dist
```

```
wrote dsh-browser-connector-extension-0.1.0.zip (44999 bytes, 14 files)
all checks passed
"commit": "5e935d275a1670d97d227363780bbd0063188953", "cleanTree": true
```

| Artifact | SHA-256 | Bytes |
|---|---|---|
| `dsh-browser-connector-extension-0.1.0.zip` | `2a76f13800a42a2b1476a213523b619e6027772ad0fa5d766bea44b9b525d2c4` | 44999 |
| `corsen-ai-dsh-browser-connector-0.1.0.tgz` | `bcc6ca6c114d08631137b5a3a445b3a9323404ecbdd0701cd9e3f99e0095344d` | 50918 |

The packaged E2E's in-process build was hashed and compared with the dist ZIP before the run:

```
in-process build  : 2a76f13800a42a2b1476a213523b619e6027772ad0fa5d766bea44b9b525d2c4
dist ZIP on disk  : 2a76f13800a42a2b1476a213523b619e6027772ad0fa5d766bea44b9b525d2c4
IDENTICAL
tests/e2e/packaged.test.ts: 4/4
```

So the packaged cases ran against the exact bytes in `dist/`, not a re-build that merely ought to
match. The earlier `dist/` from the five-action tree (`889c3bd4…`) is superseded and must not be
cited for this code.

### Provenance audit, re-run on the twenty-action tree

```
node scripts/provenance-audit.mjs   # exit 0
== dsh-browser (third-party: boilerplate only) ==
longest exact shared run: 26 tokens (CSS)
exact runs >= 16 tokens: 46, covering 846 subject tokens (1.01%)
```

Within the release threshold (32 tokens, 2 %). Every longer match is with `.refs/hermes-connector`,
which is Corsen's own code and expected.

### Gates this run closes

AK, AL, AM, AN, AO (new); AD re-established on the new bytes; AJ re-run.

### What this does not prove

A live model turn (needs an API key). Recovery after a worker, broker, DSH, or Chrome restart (gate
AA/AB). Bounded behaviour on giant or deeply nested hostile DOMs (the rest of AI). Anything on
macOS. CI has still never run.

## 2026-09-05 — recovery gate, and the stale tarball the packager had been recording (gates AA, AB, AP; AD and AE re-established)

Environment: Windows 11 Pro for Workstations, Node v24.12.0, Playwright Chromium headed, one broker
per harness on `127.0.0.1` with an ephemeral port, a persisted Chrome profile and broker state file
for the recovery cases. Code under test: commit `798d648`, whose `extension/` and `companion/`
trees are byte-identical to `1bc71c6` (`git diff --stat 1bc71c6 798d648 -- extension companion`
prints nothing); the commits between touch scripts, CI, and documents only.

### Recovery, in a real browser — run at `1bc71c6`

```
node --test --test-concurrency=1 --experimental-strip-types "tests/e2e/*.test.ts"   # 47/47
node --test --experimental-strip-types tests/e2e/recovery.test.ts                     # 6/6
```

Each case takes one real component away in the middle of a request and asserts what the page and
the registry say afterwards, never what the extension reports about itself.

| Case | Taken away, mid-flight | Asserted |
|---|---|---|
| Broker restart | the broker process; ownership exists only in its state file | after the restart, the same session reaches the same tab, restored from the state file |
| Broker restart, destructive action in flight | the broker, during a 1.5 s form submission the page counts | the request settles `INTERRUPTED`; after reconnect the page's submission counter is still **1** — nothing was replayed |
| Worker killed | the extension service worker, stopped through CDP `ServiceWorker.stopWorker` during the same submission | `INTERRUPTED`; counter **1**; an ordinary panel message wakes the worker, which reconnects and restores its bindings from storage; the next request succeeds |
| Plugin instance restart | the agent connection, with a result still to come | the successor never receives the predecessor's result — the broker drops it as unsolicited — and the successor's own request succeeds |
| Tab closed | the bound tab, during an action | `TAB_GONE` or `BINDING_CHANGED`, and the binding is gone from the registry |
| Chrome relaunch | the whole browser, same profile, same user data directory | identity and pairing survive; every binding is dropped; a new tab that reuses the old tab id is refused, not acted on |

The first run of this suite failed 4 of 6 for two reasons that were fixed in the implementation and
the test method, not the assertions: `forgetPreviousBrowserSession()` crashed on a missing import,
which cascaded into `NO_BINDING` everywhere, and the in-flight request's rejection was unhandled
once its component had been torn down. The second run passed 6/6, and the complete suite 47/47.

### Unit, protocol, security, parity, tools, tab actions — run at `798d648`

```
npm run test:unit
# 224 tests, 223 pass, 1 skipped (the POSIX mode check, on Windows), 0 fail
```

### Type checking — run at `798d648`

```
node companion/node_modules/typescript/bin/tsc -p companion/tsconfig.json --noEmit   # clean
node companion/node_modules/typescript/bin/tsc -p extension/tsconfig.json --noEmit   # clean
```

### The tarball the packager had been recording was stale

Found while rebuilding the artifacts for this gate. `dist/corsen-ai-dsh-browser-connector-0.1.0.tgz`
contained no `INTERRUPTED`, which `companion/src/protocol.ts` has carried since `1bc71c6`:

```
tar -xOzf dist/corsen-ai-dsh-browser-connector-0.1.0.tgz package/lib/protocol.js | grep -c INTERRUPTED
0
```

`scripts/package.mjs` never built the tarball. It hashed whatever already sat in `dist/`, and the
verifier only checked the tarball's entry names. The tarball rows in the two earlier "Release
artifacts" tables in this file (`bcc6ca6c…`) therefore record a file whose freshness was never
proven. They are superseded and must not be cited.

Fixed in `221b04f`. The packager now removes `lib/`, compiles it, and packs it with `npm-cli.js`
under the running Node, with no shell in between. The verifier parses the tarball's contents and
requires every `lib/` file inside it to be byte-identical to the fresh build, names each file that
is not, and also requires `cordis.patch.yml` byte-identical to the source and the release version in
the packed `package.json`. The verifier's own first version compared keys with mismatched prefixes
and reported all 30 files missing; that was a verifier bug, fixed before anything was committed.

The tarball is deterministic: two consecutive packs produced identical bytes.

```
sha256 corsen-ai-dsh-browser-connector-0.1.0.tgz   # pack 1: 935a4988f4c89ab2…   pack 2: 935a4988f4c89ab2…
```

### Release artifacts, from clean commit `798d648`

```
node scripts/package.mjs --out dist && node scripts/verify-package.mjs --dist dist
```

```
wrote dsh-browser-connector-extension-0.1.0.zip (45497 bytes, 14 files)
wrote corsen-ai-dsh-browser-connector-0.1.0.tgz (55252 bytes, built from source)
all checks passed                                   # 187 checks
"commit": "798d6484bb60706dabfd4159403e21e1f5146310", "cleanTree": true, "builtAt": "2026-09-05T18:17:04.959Z"
```

| Artifact | SHA-256 | Bytes |
|---|---|---|
| `dsh-browser-connector-extension-0.1.0.zip` | `343a7effc6ebbad92fa7af7de21bdd4c94811386d5b0dab249afb065c32d4c55` | 45497 |
| `corsen-ai-dsh-browser-connector-0.1.0.tgz` | `935a4988f4c89ab2ceb0fcc1bf7acdda9a10984c30ee916d40cb3adbb23b6034` | 55252 |

The extension ZIP is unchanged since the `1bc71c6` build, as it should be: no extension file changed.
The packaged E2E ran against the exact bytes in `dist/`:

```
in-process build  : 343a7effc6ebbad92fa7af7de21bdd4c94811386d5b0dab249afb065c32d4c55
dist ZIP on disk  : 343a7effc6ebbad92fa7af7de21bdd4c94811386d5b0dab249afb065c32d4c55
IDENTICAL
tests/e2e/packaged.test.ts: 4/4
```

### Provenance audit, re-run at `798d648`

```
node scripts/provenance-audit.mjs   # exit 0
== dsh-browser (third-party: boilerplate only) ==
longest exact shared run: 26 tokens (CSS)
exact runs >= 16 tokens: 47, covering 862 subject tokens (0.98%)
```

### Gates this run closes

AA, AB, AP (new). AD re-established on the new bytes. AE re-established, now including the proof
that the tarball is fresh. AJ re-run.

### What this does not prove

A live model turn (needs an API key). Bounded behaviour on giant or deeply nested hostile DOMs
(the rest of AI). Anything on macOS. CI has still never run. The complete real-browser suite was
not re-run at `798d648` itself; that claim rests on the byte-identical `extension/` and
`companion/` trees, plus the packaged cases that did run on the new artifacts.

## 2026-09-05 — an external review's findings, reproduced and closed (gates AK extended, AI, AE, AQ named)

An independent review of commit `306cf98` confirmed the tarball fix of the previous section and then
reported new defects in confidentiality, in how much work a page can cause, in what a submission
claims, in what an ambiguous outcome says, and in what the release verifier accepts. Its own
environment ran Node 22.16.0, below this project's declared minimum, and could not run the
end-to-end suite. **Every finding below was therefore reproduced here first, against the shipped
code, before anything was changed** — the measurements are this project's own.

Environment: Windows 11 Pro for Workstations, Node v24.12.0, Playwright Chromium.

### What was reproduced, and what it measures now

The probe ran the shipped `extension/src/page-actions.js` in Chromium with the shipped
`redact.js` configuration, and counted tree-walker filter calls through the browser's own interface
rather than trusting the module's numbers.

| What the review reported | Measured before | Measured after |
|---|---|---|
| A masked textarea's content in the snapshot text and `read_text` | present in both | absent from both, and `find` no longer locates it |
| A masked select's option values in the clear | `4111111111111111` in `options[].value` | every option value and label masked; count and selection still reported |
| A 2 MB `role` attribute | result 2,097,314 bytes, `ok: true`, `truncated: false` | result 202 bytes, role bounded to 40 characters |
| Node budgets of 6,000 and 24,000 on 30,000 flat siblings | 30,002 and 30,003 filter calls | 6,001 and 24,001 |
| Typing then submitting an invalid form | connector `submitted: true`, page received **0** submit events | `submitted: false` with the reason, the typing still reported as done, page still shows the typed text |

The two verifier controls were reproduced the same way, on copies, leaving `dist/` untouched:

| Control | Before | After |
|---|---|---|
| `package/telemetry.js` added to the tarball with its checksum refreshed | 187 checks passed, exit 0 | refused twice: not in the allowlist, and its `https://evil.test/collect` is a foreign host |
| A manifest naming commit `000…0`, false hashes and `cleanTree: false`, with the tarball's line deleted from `SHA256SUMS` | 186 checks passed, exit 0 | refused: the commit is not HEAD, the tree is not clean, both hashes disagree, and the missing line is named |

The version adapter was run directly: `0.1.2-rc.1`, `1.0.0` and `999.0.0` all reported
`supported: true`. It now classifies `tested`, `untested` and `incompatible`, and `999.0.0` is
refused.

### What was corrected in the review's account

Two claims did not survive measurement here, and are recorded so the record is complete:

- The review reported a masked select's **label** reaching the snapshot text. It did not: an
  `<option>` inside a closed `<select>` is not visible, so the text walk never reached it. The
  values in `options[].value` were the real leak, and they were real.
- Its brief asked for 5,000-deep nesting. On this machine Chromium crashes building a document
  nested 500 deep, before any connector code runs, and hangs laying one out at 300. The regression
  case therefore asserts what this project owns — a deep chain costs nodes, not recursion — at a
  depth the browser handles, and `docs/TEST-MATRIX.md` records the browser's limit rather than
  claiming a number nobody can reach.

### The fixes, and why they are shaped that way

Masking became a property of the control rather than of one field: a secret control's subtree is
pruned from every text walk, its options are masked, and a failed `select_option` no longer prints
them. A label's text no longer includes the value of the control it wraps, which also breaks the
cycle that classification and text extraction would otherwise form; a re-entrant question is
answered from attributes alone.

A budget that rejects nodes past its cap does not stop a walk: `nextNode()` keeps scanning to the
end of the document before returning null. Accepting instead returns at once and lets the loop
break. Each action also carries a wall-clock deadline, because a visibility query costs whatever
the browser's layout costs, and no node count bounds that.

`requestSubmit()` runs constraint validation and dispatches nothing when a form is invalid. The
submit event is now observed rather than assumed, and reported for what it is — the browser
dispatched the form's submit event — which is not a claim that a server accepted anything.

`CANCELLED` is new and means the one thing that can honestly be called cancelled: the call was
abandoned before its frame left. A cancellation after dispatch is `INTERRUPTED`, and the broker's
deadline, which arms only after the action has been sent, now says the browser may have performed
it.

### Runs

```
npm run typecheck                                    # companion, clean
tsc -p extension/tsconfig.json --noEmit              # extension, clean
npm run test:unit    # 240 tests, 239 pass, 1 skipped (POSIX mode check, on Windows), 0 fail
npm run test:page    # 12 tests, 12 pass, 0 fail — the shipped module in Chromium
npm run test:e2e     # 47 tests, 47 pass, 0 fail
node scripts/provenance-audit.mjs                    # exit 0, longest exact run 26 tokens (CSS), 1.00 %
```

`tests/page/` is new. It exists because the questions this review raised cannot be asked through the
extension: a service worker's isolated world is not reachable from a test, so the cost of a walk
cannot be counted there. The module under test is the shipped file, imported by the page over
loopback; only the surroundings are simpler.

### Release artifacts, from clean commit `4f1c59b`

```
node scripts/package.mjs --out dist && node scripts/verify-package.mjs --dist dist
```

```
wrote dsh-browser-connector-extension-0.1.0.zip (48603 bytes, 14 files)
wrote corsen-ai-dsh-browser-connector-0.1.0.tgz (58791 bytes, built from source)
all checks passed                                    # 579 checks, up from 187
"commit": "4f1c59b346cac0f79a2feea5385f0cf3bb7c5678", "cleanTree": true
```

| Artifact | SHA-256 | Bytes |
|---|---|---|
| `dsh-browser-connector-extension-0.1.0.zip` | `8196873e4147ff0a0a8ebfdea82029cfc4946669e779e57b818a703d82bf6952` | 48603 |
| `corsen-ai-dsh-browser-connector-0.1.0.tgz` | `813890bd743be34a7b8803fa2bffefa82ec965998c84e4c25bd49b1c680a37e7` | 58791 |

The tarball now carries `LICENSE` and `README.md`. It had carried neither: `files` named a README
that did not exist, and `"license": "MIT"` in `package.json` is a label, not the notice the licence
asks to travel with copies. `tests/e2e/packaged.test.ts` ran 4/4 against these ZIP bytes.

### Gates

AK extends to every representation of a masked control, not only its `value`. AI moves to bounds
covered, injection fixtures still open. AE now includes the two negative controls. AB and AD have
their scope stated rather than implied, and **AQ is new and open**: the released pair installed the
way a user installs it, with the broker as its own process.

### What this does not prove

A live model turn. Injection fixtures through the whole pipeline. The released pair installed
together. Anything on macOS, including whether a downloaded installer runs from a quarantined file.
CI has still never run. And the review's own runs were on Node 22.16.0, below the declared minimum,
so its passing results are corroboration and not a substitute for the supported runtimes.
