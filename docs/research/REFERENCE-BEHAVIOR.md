# Reference behavior: Lum1104/dsh-browser

Behavioral observations only, from the public README and repository layout at baseline
`e60e6e3f589205a5755b35f234155d3ec17d030b` (v0.1.3, 2026-09-04). No implementation source was read
for transplantation and none was copied. This file exists so our capability set is informed by what
the community already expects, and so the gaps we intend to close are written down before we build.

## Observed capability surface

| Capability | Their tool name | Observed behavior | Our independently chosen solution |
|---|---|---|---|
| Read page | `browser_snapshot` | Structured text: title, URL, main text, numbered controls, masked form fields; optional delta mode | Our own accessibility-derived snapshot with opaque stable refs, deterministic ordering, and hard node/byte budgets (`docs/PROTOCOL.md`) |
| Click | `browser_click` | Click by inventory number | Click by opaque `ref` minted per snapshot; stale refs fail loudly rather than clicking a reused index |
| Fill forms | `browser_type` | React/Vue-compatible input, `replace` clears first | Native setter + `input`/`change` dispatch, with an explicit `replace` flag |
| Keys | `browser_press` | Enter/Tab/Escape/arrows | Same key vocabulary, validated against an allowlist |
| Scroll | `browser_scroll` | up/down/top/bottom | Same, plus element-relative scrolling |
| Navigate | `browser_navigate`, `browser_open_tab`, `browser_back`, `browser_forward`, `browser_reload` | Navigation within the controlled tab | Same set, but every one is scoped to the calling session's own tabs |
| Read region | `browser_get_text` | Lazy/partial page text | `read_text` with a byte budget |
| Wait | `browser_wait` | Load and render-settle detection | Same, with a bounded deadline |
| Images | side-panel attachments | Host-capability-gated image drafts | Out of scope for v1: we do not add a second chat surface |
| Quote selection | side-panel composer | Highlighted text is quoted into the composer | Out of scope for v1 |

Their browser tools never capture screenshots; page operation is text-first. We reached the same
conclusion independently and for the same reason: DeepSeek models must operate pages without vision.

## Observed limitations we intend to solve

| Limitation | Why it matters | Our approach |
|---|---|---|
| "the extension binds tools to one user-controlled tab" | One tab per browser means concurrent DSH sessions cannot each own their own pages, and a session cannot hold a set of related tabs | Exact `profileId + sessionId` scope owning a *set* of tabs, with one active tab per scope and single-owner enforcement per tab |
| No per-session routing described | With one global controlled tab, two sessions acting at once can act in each other's page | Fail-closed routing keyed on `exec.agent.id`; an unbound session errors and changes nothing |
| "The standard `dsh plugin` command alone cannot install this project" | Users must run a piped shell installer | Ship the plugin *and* its broker in one npm package so plain `dsh plugin ... add` is sufficient |
| "This project is not currently published as an npm package" | Installation depends on `curl \| bash` from a branch | Published, versioned npm package with checksums |
| Extension loaded unpacked via `chrome://extensions` | No auto-update, no Store review, reload required after updates | Chrome Web Store distribution, designed for review from day one |
| Extension update and plugin update are manually coupled | An auto-updating extension can outrun a stale local plugin | Explicit version/capability handshake that fails closed with actionable UI |
| Supports one primary dsh release plus one via a compatibility adapter | Narrow supported range on fast-moving pre-stable APIs | A dedicated compatibility adapter package plus a scheduled upstream CI lane |

## Observed claims we will not restate without our own evidence

Their README publishes a paired 60-run benchmark against a Playwright baseline. We do not reuse those
numbers. Any performance claim this project makes must come from our own reproducible measurements on
our own harness, recorded in `docs/TEST-EVIDENCE.md`.

## What this project deliberately does not take

Their protocol, message kinds, module layout, package names, tool names, page-representation format,
element-numbering scheme, installer scripts, UI, and assets. Where a name is an obvious industry term
(`snapshot`, `click`, `navigate`) the coincidence is unavoidable and carries no implementation.
