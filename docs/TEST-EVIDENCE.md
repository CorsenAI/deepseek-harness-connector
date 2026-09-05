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
