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
