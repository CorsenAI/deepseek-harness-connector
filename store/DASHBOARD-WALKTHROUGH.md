# Chrome Web Store dashboard, field by field

The developer dashboard (`https://chrome.google.com/webstore/devconsole/`) cannot be driven by an
agent: Chrome refuses extension scripting on the Store ("the extensions gallery cannot be scripted")
and refuses the Store in embedded browsers. The owner clicks; this sheet gives every field in the
dashboard's own order, with the text to paste and the file to upload, so the submission takes about
fifteen minutes and matches the material in this directory.

**Before the first click**: the GitHub release `v0.1.0` must be public with
`corsen-ai-dsh-browser-connector-0.1.0.tgz` attached (the setup card tells the reviewer to install
it), the privacy page must answer (`https://corsen.ai/privacy/deepseek-harness-connector/`), and the
ZIP to upload is `dist/dsh-browser-connector-extension-0.1.0.zip` built from the tagged commit
(SHA-256 `00a5b09e76466374983bfb0fb8d03bae8024371619c55b00173fba1be335a464`, 72311 bytes; check it
with `sha256sum` before uploading).

## 1. New item → Package

Upload `dist/dsh-browser-connector-extension-0.1.0.zip`. The dashboard reads the manifest: name
"DeepSeek Harness Connector — by Corsen AI", version 0.1.0, the permissions `storage`, `sidePanel`,
`scripting`, `alarms` and the host permission `<all_urls>`. Note the item ID it assigns: it becomes
the listing URL `https://chromewebstore.google.com/detail/<id>` to record afterwards.

## 2. Store listing

| Field | Value |
|---|---|
| Title | from the manifest: `DeepSeek Harness Connector — by Corsen AI` |
| Summary | from the manifest: `Let an exact DeepSeek Harness session operate the tabs you choose, in your own signed-in Chrome. Local, unofficial, by Corsen AI.` |
| Description | the English **Detailed description** block of `LISTING.md`, as it is |
| Category | Developer Tools |
| Language | English |
| Store icon | `store/store-icon-128.png` (128×128: the Corsen mark with "Corsen AI", the file Hermes Connector uses) |
| Screenshots (1280×800), in this order | `store/screenshots/01-pair.png`, `02-no-tabs.png`, `03-ready.png`, `04-snapshot.png`, `05-update-required.png` |
| Small promo tile (440×280) | `store/promo-small-440x280.png` |
| Marquee promo tile (1400×560) | `store/promo-marquee-1400x560.png` |
| Official URL | leave empty unless `corsen.ai` is verified for this publisher in Search Console; then `https://corsen.ai/` |
| Homepage URL | `https://github.com/CorsenAI/deepseek-harness-connector` (the GitHub Pages site once it answers: `https://corsenai.github.io/deepseek-harness-connector/`) |
| Support URL | `https://github.com/CorsenAI/deepseek-harness-connector/issues` (or the support page once Pages answers) |
| Mature content | No |

A second language can be added with the French block of `LISTING.md` ("Français"): title,
short description and detailed description are there, character counts included.

## 3. Privacy

**Single purpose** (paste):

> Connect explicitly user-selected browser tabs to the user's locally running DeepSeek Harness
> sessions, so those sessions can perform requested browser actions in those tabs.

**Permission justifications** — one field per permission; the full reasoning is
`PERMISSION-JUSTIFICATIONS.md`, these are the pastes:

- `storage` — Stores this installation's random identity, the user's connector address and pairing
  code, and which DeepSeek Harness session is attached to which tabs. All local to this browser
  profile; nothing in storage is page content.
- `sidePanel` — The side panel is the extension's only user interface: it is where the user pairs
  with the local connector, chooses a DeepSeek Harness session and attaches or detaches tabs. The
  single purpose requires explicit selection, which happens there.
- `scripting` — Runs the page-reading and page-acting code inside a tab the user explicitly
  attached, only when that tab's DeepSeek Harness session requests an action. The injected code
  produces a structured text snapshot or performs one action and returns. It is never injected
  into a tab that is not attached.
- `alarms` — Chrome terminates the extension's service worker when idle. A periodic alarm lets it
  wake and restore the connection to the local connector so a session's request is not lost; it
  does nothing when already connected.
- Host permission `<all_urls>` — The core gesture is "attach the tab I am looking at", on any site:
  the extension must be able to run its page code in whichever tab the user chooses, and the same
  grant lets chrome.tabs.captureVisibleTab take a screenshot of an attached tab when its session
  asks. The effective access is narrower than the grant and enforced: page code runs only in a tab
  the user explicitly attached, only for the session that owns it, only when that session requests
  an action; no page code runs in, no content is read from, and no picture is taken of, a tab the
  user has not attached. Optional per-origin grants were evaluated and rejected: a session following
  a link to another origin would lose its own tab mid-task until a second prompt was answered.
- Remote code — **No**: every line ships in the package; no external script, no downloaded code,
  no interpreter; the only network destination is the user's own 127.0.0.1.

**Data usage** — tick, per `DATA-DISCLOSURES.md`:

- Website content — yes (visible text, structure and controls of attached tabs; screenshots on request)
- Web history — yes (the URL and title of attached tabs, and of open tabs shown locally in the tab chooser)
- Everything else (personally identifiable information, health, financial and payment, authentication, personal communications, location, user activity) — no

**Certifications** — tick all three: not sold to third parties outside the approved use cases;
not used or transferred for purposes unrelated to the single purpose; not used or transferred to
determine creditworthiness or for lending.

**Privacy policy URL**: `https://corsen.ai/privacy/deepseek-harness-connector/`

## 4. Distribution

| Field | Value |
|---|---|
| Payments | Free of charge |
| Visibility | Public |
| Regions | All regions |

## 5. Submit for review

Leave "Publish automatically after it has passed review" on, unless the owner prefers to press
Publish themselves. Then, after the submission:

- record the item ID and the listing URL in `README.md`, `docs/index.html`,
  `docs/support/index.html`, `marketing/LAUNCH-KIT.md` and `docs/TEST-EVIDENCE.md`;
- tick the "Before pressing submit" list in `SUBMISSION-CHECKLIST.md` with the date;
- when the review needs an answer, `REVIEWER-INSTRUCTIONS.md` is the text to point at, and
  `scripts/review-session.mjs` the stand-in a reviewer can run without DeepSeek Harness.
