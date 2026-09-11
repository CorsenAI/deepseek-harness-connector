# ADR 0009 — The host permission is `<all_urls>`, required at install; the permission set is frozen

Status: accepted (2026-09-11)

## Context

ADR 0006 chose `<all_urls>` over per-origin optional grants on reasoning. Before the Store
submission the choice had to be made on evidence, between the two shapes that satisfy the one fixed
product requirement — **an attached session must follow a cross-origin link without losing
authority over its own tab** — and the permission set had to be frozen so every Store document can
be checked against the manifest.

The two shapes:

- **A. Required.** `"host_permissions": ["<all_urls>"]`, as shipped. Chrome warns at install.
- **B. Optional, broad.** `"optional_host_permissions": ["<all_urls>"]` and no required host, with
  the panel calling `chrome.permissions.request({ origins: ['<all_urls>'] })` once during pairing.
  No host warning at install; the same grant, asked for in context.

Per-origin grants (a prompt per site) and `activeTab` were not candidates: Chrome's own
documentation has `activeTab` revoked when "the user navigates to" another origin, and a per-origin
grant needs a user gesture the model's link click is not, so neither can meet the requirement.

## What was run

Everything below is in `docs/TEST-EVIDENCE.md` (2026-09-11).

**Under A, the shipped manifest.** The complete real-browser suite — 62 cases, headed under Xvfb
and in Chrome's new headless mode — including the new `tests/e2e/cross-origin.test.ts`, which
serves a second fixture origin on its own port and has the session (1) navigate its tab there,
(2) follow a link the page offers to it, and (3) keep a `wait` that was in flight when the page
navigated itself. After each, the broker's registry still lists the same tab for the session and
the session reads the page that arrived. Three consecutive runs, 3/3 each.

Running that case also found a defect in what the model was told when its own click navigated the
tab — "Chrome refused to run the action" for a click that had happened — fixed in the same commit:
an action whose page moved is now reported as a navigation, with the new address.

**Under B, a spike copy of the extension with the optional manifest.** The suite cannot run past
the grant: `permissions.request` must run in a user gesture and answers with a native Chrome
prompt, which Playwright cannot accept. So the spike measured the state a user is in *until* the
prompt is answered:

| Observed | A (required) | B (optional, not yet granted) |
|---|---|---|
| `chrome.permissions.contains({ origins: ['<all_urls>'] })` | `true` | `false` |
| Tab chooser, three open tabs | the fixture tab listed with its address; the two internal tabs restricted | no tab has an address; all three restricted |
| Can the user attach the page they are looking at? | yes | no — every tab reads as restricted |
| `chrome://extensions` details page (read in the spike) | "Allow this extension to read and change all your data on websites you visit: On click / On specific sites / On all sites" | "This extension can read and change your data on sites. You can control which sites the extension can access." |
| Install-time host warning (Chrome's documentation) | shown | not shown; shown at the runtime request |

The first table row is the product's core gesture: under B, "attach the tab I am looking at" is
impossible until an onboarding prompt is accepted, and a user who declines or later revokes leaves
the connector in a state the panel would have to explain — a third state beside "not paired" and
"no tab attached", indistinguishable from fail-closed routing unless every message is written to
tell them apart. That is the confusion ADR 0006 named, moved rather than removed.

## Decision

**A.** `"host_permissions": ["<all_urls>"]` stays required. The permission set is frozen for the
Store submission at exactly:

```json
"permissions": ["storage", "sidePanel", "scripting", "alarms"],
"host_permissions": ["<all_urls>"]
```

`store/PERMISSION-JUSTIFICATIONS.md` and `store/DATA-DISCLOSURES.md` describe this set and no
other; `scripts/verify-package.mjs` refuses a manifest that differs.

## Rationale

- **The requirement is met and tested under A.** The cross-origin suite is the evidence, and it
  runs on every push.
- **B's grant is the same grant.** Once accepted it authorises exactly what A does; the Store
  justification is the same sentence. What B changes is *when* the user is told, at the price of a
  state in which the product cannot do the one thing it exists for.
- **The user already has per-site control under A.** Chrome's own site-access setting — "On click",
  "On specific sites", "On all sites" — was observed on the details page for the shipped manifest.
  A user who narrows it is honoured: an injection Chrome refuses is reported as a failed action
  with Chrome's reason, never as a success (ADR 0006's honesty rule), and the panel's tab chooser
  marks tabs whose address Chrome withholds as restricted (ADR 0006, amendment).
- **A gate that cannot run is a gate that cannot close.** The release gates load the packaged ZIP
  into a real Chrome and drive it. Under B the pairing path would carry a native prompt no gate can
  answer, so the shipped onboarding could never be part of what is proven.
- **Reviewability.** The reviewer sees one broad permission with one justification and the
  narrowing the extension enforces on itself: page code runs only in a tab the user attached, only
  for the session that owns it, only when that session acts. `store/REVIEWER-INSTRUCTIONS.md` walks
  that path.

## Consequences

- The install-time warning for all-sites access is shown. The listing text and the reviewer notes
  say why, in the words of the justification file.
- A user who sets site access to "On click" or to specific sites gets honest failures elsewhere:
  `ACTION_FAILED` carrying Chrome's own "cannot access contents" reason, and a chooser that shows
  the tab as restricted when Chrome withholds its address. No fallback, no guess.
- Revisiting this is a new decision with new evidence: a way to run the optional-grant path under
  test, or Store feedback that the install-time warning costs more than the onboarding state would.
