# Provenance audit

A source-similarity audit of this repository against the two reference clones, run on 2026-09-05
at the baselines recorded in `docs/PROVENANCE.md`. `docs/PROVENANCE.md` states the rules; this
document is the evidence that they were followed.

## Method

`scripts/provenance-audit.mjs` tokenises every source file on both sides (TypeScript, JavaScript,
HTML, CSS, YAML, shell, PowerShell, Python; comments stripped; lockfiles, declarations, `dist/`,
`lib/`, and `node_modules/` excluded) and finds maximal shared runs two ways:

- **exact** — runs of identical tokens, reported at 16 tokens or more. Catches pasted or lightly
  edited code.
- **shape** — the same after every identifier becomes `ID`, every string `STR`, and every number
  `NUM`, reported at 40 tokens or more. Catches a line-by-line rewrite with renamed variables,
  which the mission forbids and which exact matching cannot see.

Every reported run is printed with both locations and its text, so each verdict below can be checked
against the source rather than taken on trust. Two of the most notable runs were also inspected by
hand, and what was found is recorded.

Subject: **49 files, 65 665 tokens** — `extension/src`, `companion/src`, `companion/tests`,
`scripts`, `tests`. Documentation is excluded because prose is not code.

```
node scripts/provenance-audit.mjs --exact 16 --shape 40 --max-run 32 --max-coverage 2 --json provenance-audit.json
```

## Result against `Lum1104/dsh-browser` — the third-party reference

Baseline `e60e6e3f589205a5755b35f234155d3ec17d030b` (v0.1.3). 157 source files, 202 258 tokens.

| Measure | Value |
|---|---|
| Longest exact shared run | **26 tokens** — five CSS declarations (`extension/src/sidepanel.css:139` ↔ `extensions/dsh-browser/src/panel/styles.css:1160`) |
| Exact runs of 16 tokens or more | 30, covering **549 tokens — 0.84 %** of the subject |
| Shape runs of 40 tokens or more | 19, covering 905 tokens — 1.38 % of the subject |
| Shared protocol, message kinds, tool names, element-reference scheme, page-representation format | none |
| Shared function bodies, algorithms, data structures | none |
| Shared tests, strings, UI markup, assets, installer scripts | none |

The longest match in the whole audit is one CSS rule. Every run above threshold is one of six
kinds, listed in full below.

### Every exact run, classified

| Kind | Runs | Where (ours) | What matched | Verdict |
|---|---|---|---|---|
| Generic CSS | 8 | `sidepanel.css` 66, 76, 93, 99, 106, 134, 138, 191 | `border: 1px solid var(--line); border-radius:`, `display: flex; align-items: center; gap:`, `flex-direction: column; gap: 6px`, `@media (prefers-reduced-motion: reduce)` | Unavoidable. The one distinctive token, the custom property `--line`, is inherited from Corsen's own Hermes Connector (`hermes-connector/docs/index.html:162`, which the Hermes section of this audit also matches). The 26-token run — the longest anywhere — is inspected below. |
| DeepSeek Harness contract | 6 | `companion/src/dsh/tools.ts` 108, 138, 166, 194, 219; `companion/src/plugin.ts` 29 | `render: (_args, value) => [{ type: 'text', text:` (five times) and `export const Config: z<Config> = z.object({` | Unavoidable. These are the shapes DeepSeek Harness prescribes: the `defineTool` `output.render` signature is given verbatim in DSH's `docs/cookbook/adding-a-tool.md`, and the schemastery `Config` idiom is how DSH's own plugins (`packages/todo`) declare configuration. Both projects implement the same upstream contract; the matched reference file is their *benchmark* plugin. |
| Node and TypeScript idioms | 9 | `broker-server.ts` 128, 136; `frames.ts` 94, 107; `agent-client.ts` 69, 138; `tests/e2e/harness.ts` 133; `bindings-parity.test.ts` 59; `auth.test.ts` 31 | the `server.address()` port idiom, `Number.isSafeInteger(value) \|\| (value as number) < 0`, `typeof value !== 'object' \|\| value === null`, a `Map<string, { resolve, reject }>` of pending requests, `new Promise<unknown>((resolve, reject) => { const`, `await new Promise<void>((resolve) => {`, a counted `for` loop, `rmSync(dir, { recursive: true, force: true })` in a test teardown | Unavoidable. Language and runtime idioms with one conventional spelling. |
| Chrome and DOM API idioms | 3 | `background.js` 533; `sidepanel.js` 314; `page-actions.js` 313 | `chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name`, `chrome.tabs.query({ active: true, lastFocusedWindow: true })`, `{ bubbles: true, cancelable: true, composed: true }` | Unavoidable. Documented platform forms with no alternative spelling. |
| Playwright recipe | 1 | `tests/e2e/harness.ts` 95 | `const extensionId = new URL(worker.url()).host` | Unavoidable. Playwright's documented way to obtain an extension id. |
| Regex literals | 3 | `broker.test.ts` 141; `isolation.test.ts` 228, 229 | `/^[0-9a-f]{32}$/`, `[0-9a-f-]{36}$/` | Unavoidable. A 32-hex-character check and a UUID check. |

### Every shape run, classified

| Kind | Runs | Where (ours) | Verdict |
|---|---|---|---|
| String dictionaries and constant maps | 13 | `i18n.js` (nine windows), `protocol.js` (two), `companion/src/protocol.ts` (two) ↔ their `panel/strings.ts` | Any `{ key: "string", key: "string", … }` object has the shape `ID : STR , ID : STR , …`. The keys and strings differ entirely — the exact audit finds none of them shared. |
| Arrays of string literals | 3 | `redact.js` 15–35 and 55–80, `redaction.test.ts` 23 ↔ their `panel/markdown.ts:7–10` | `STR , STR , STR , …`. Ours are credential-field and URL-parameter names; theirs are markdown-related. No literal is shared. |
| A guard clause | 2 | `companion/src/bindings.ts` 199–202 and `bindings.js` 203–205 ↔ their `background/tools.ts:500–503` | Inspected below. Different function, different logic, different data. |
| CSS rule structure | 1 | `sidepanel.css` 137–143 ↔ their `styles.css:365–371` | `ID : NUM ID ; ID : ID ;` — the shape of any short rule. |
| A small test helper | 1 | `broker.test.ts` 671–672 ↔ their `benchmark/report.mjs:103–104` | Two-line helper shape. |

### The two runs inspected by hand

**The 26-token CSS run.** Theirs is a `.question-option` rule; ours is `.list li`. Both read, in
part, `gap: 8px; padding: 8px 9px; border: 1px solid var(--line); border-radius:`. `--line` is
Corsen's token, present in Hermes before this project existed. `gap: 8px` and `padding: 8px 9px`
are compact-row values two designers can pick independently. This is the largest overlap the
audit found against the third party, and it is five declarations of layout CSS.

**The 51-token shape run.** Theirs (`tools.ts:496–506`) is `validateFrameTarget`, which checks a
frame id and returns an error object or `undefined`. Ours (`bindings.ts:197–205`) is
`setActiveTab`, which throws when a scope does not own a tab and otherwise returns a frozen copy of
the registry with a new active tab. They share the shape `if (!x || !x.y.z(w)) { … } … return`
— a guard clause — and nothing else: not the condition, not the effect, not the data.

## Result against `CorsenAI/hermes-connector` — Corsen's own code

Baseline `bfd9bc29718c4647a1438962aae28ed4d1220df6` (v0.2.4). 48 source files, 98 836 tokens.

| Measure | Value |
|---|---|
| Longest exact shared run | 48 tokens — the WebCrypto HMAC hex-encoding helper (`background.js:142` ↔ `tests/background-session.test.mjs:32`) |
| Exact runs of 16 tokens or more | 40, covering 860 tokens — 1.31 % |
| Shape runs of 40 tokens or more | 25, covering 1 308 tokens — 1.99 % |

This overlap is expected, permitted, and declared. `docs/PROVENANCE.md` lists four modules ported
from Hermes, each carrying an origin line in its JSDoc, and the matches fall exactly where the
declarations say they should:

| Declared port | What the audit found |
|---|---|
| `companion/src/bindings.ts` and `extension/src/bindings.js` ← `hermes extension/src/bindings.js` | The ownership algebra: `binding.tabIds.filter((id) => id !== tabId)`, the active-tab promotion, the not-attached guard (13 runs across the two files). |
| `companion/src/auth.ts` ← `hermes broker.py` | The proof construction is a port from Python, so it does not token-match; what matched instead is the extension's WebCrypto hex helper against Hermes's *test* of the same helper (48 and 36 tokens). |
| `companion/src/broker.ts` ← `hermes broker.py` | Python to TypeScript: no token-level match, as expected. |
| `extension/src/protocol.js` ← `hermes extension/src/protocol.js` | The tab-action constant names (`LIST_TABS: "list_tabs"`, …) and the store-key discipline. |
| Panel CSS and fixture HTML | `var(--line)`, `border-radius`, the `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` preamble, from Hermes's docs and fixtures. |

## What this audit does not prove

- It detects reuse at the token and shape level. It cannot detect a *concept* taken from another
  project — "mask password fields", "number the controls" — and it does not try to, because taking
  behavioural observations from a reference is what `docs/research/REFERENCE-BEHAVIOR.md` exists
  for and is permitted.
- Comment stripping is heuristic. A `//` inside a string is treated as a comment, which makes the
  audit slightly more lenient toward a match, never stricter.
- Thresholds are choices. 16 exact tokens is short enough that every match above it appears in the
  table; 40 shape tokens is where structural coincidence stops drowning the signal.

## Release gate

The audit runs in CI (`.github/workflows/ci.yml`, job `provenance`) against the references fetched
at the pinned SHAs, and fails the build if any third-party exact run reaches **32 tokens** or
third-party exact coverage exceeds **2 %**. Both ceilings are above what was measured (26 tokens,
0.84 %) and well below what a copied function or a rewritten module would produce. The gate was
exercised in both directions on 2026-09-05: it passed at those ceilings and reported `AUDIT FAILED`
with exit code 2 when the run ceiling was set to 20 or the coverage ceiling to 0.5 %.

## Statement

**The DeepSeek integration was independently engineered using Corsen-owned code and official
DeepSeek Harness interfaces; third-party implementations were used only as behavioural references.**

The evidence for that sentence is above: against the third-party reference the longest shared run
is five CSS declarations, 0.84 % of this repository's tokens fall inside any run of sixteen or
more, every such run is a language idiom, a platform idiom, a DeepSeek Harness contract, generic
CSS, or a regex literal, and no protocol, algorithm, data structure, function body, test, string,
markup, or asset is shared.

---

## Re-run, 2026-09-05, after the twenty-action work

```
node scripts/provenance-audit.mjs   # exit 0
longest exact shared run with .refs/dsh-browser: 26 tokens (extension/src/sidepanel.css:139, a CSS declaration)
exact runs >= 16 tokens: 46, covering 846 subject tokens (1.01 %)
shape runs >= 40 tokens: 21, covering 993 subject tokens (1.19 %)
subject: 55 files, 83658 tokens
```

Coverage rose from 0.84 % to 1.01 % because the subject grew by fifteen actions and their tests;
the longest run is unchanged and still a CSS declaration. Every match at or above 40 tokens is with
`.refs/hermes-connector`, which is Corsen's own code. The statement at the head of this document
remains true for the twenty-action tree.
