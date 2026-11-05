# DeepSeek Harness Connector launch kit

Use this kit once the GitHub release and the Chrome Web Store listing are public. Adapt the opening
line to each community; never post identical text everywhere, and never ask for stars, reviews or
ratings. Modelled on the Hermes Connector kit, which is the precedent for Corsen's connectors.

## Canonical positioning

**DeepSeek Harness Connector is a Chrome extension and local companion that let one exact DeepSeek
Harness session operate only the tabs the user explicitly attaches, in the user's own signed-in
Chrome profile.**

Proof points that can be stated publicly (each is tested; `docs/TEST-EVIDENCE.md` has the runs):

- Works in the user's real, signed-in Chrome profile; no hidden automation browser.
- Exact routing: profile and session (`exec.agent.id`) to the attached tabs, one owner per tab; a
  session with no attached tab is refused — never the active tab, never a guess.
- Twenty-one browser actions: navigate, snapshot, read, find, click, type, keys, scroll, hover,
  select, drag, wait, screenshots to a vision model, tabs within the scope.
- Passwords, one-time codes, payment fields, hidden values and secret-bearing URL parameters are
  masked inside the page before anything leaves the browser.
- No `cookies`, no `debugger`, no remote code; the extension talks only to the companion on
  `127.0.0.1`, authenticated; Corsen AI runs no relay and receives no telemetry.
- One `dsh plugin add` installs the companion from the project's release; DeepSeek Harness 0.1.2-rc.1
  through 0.2.2-rc.1 tested on Linux, macOS and Windows; 392 tests, reproducible artifacts.
- Open source (MIT), with the evidence, the ADRs and the Store material in the repository.

Do not claim that the project is official, endorsed or certified by DeepSeek, that it is the first,
that it is perfectly secure, or that it works on DeepSeek Harness versions it was not tested with.

## Canonical links

- Source: https://github.com/CorsenAI/deepseek-harness-connector
- Release (ZIP, companion tarball, hashes): https://github.com/CorsenAI/deepseek-harness-connector/releases/tag/v0.1.0
- Product and setup: https://corsenai.github.io/deepseek-harness-connector/
- Support: https://corsenai.github.io/deepseek-harness-connector/support/
- Privacy: https://corsen.ai/privacy/deepseek-harness-connector/
- Corsen AI: https://corsen.ai/
- Chrome Web Store: `<the listing URL, once the item is created in the developer dashboard>`

## Where DeepSeek Harness users look (the directories), in order

Every DeepSeek Harness directory indexes the public GitHub topic **`dsh-plugin`** first; the
repository carries it (with `deepseek-harness`, `deepseek`, `chrome-extension`,
`browser-automation`, `ai-agent`, `manifest-v3`, `chrome-side-panel`). The rest is one submission
each, with the install command of the release tarball, never a `github:` shorthand: the repository
root is the monorepo, not the plugin, so `dsh plugin add github:CorsenAI/deepseek-harness-connector`
would install nothing useful.

1. **dsh-plugin.org** (DSH Plugin Hub) — https://dsh-plugin.org/submit — a GitHub issue in their
   fixed format; the filled template is below. It indexes repositories with the topic and reviews
   them; without an npm package the listing is on the site only, not in the in-app hub, which is
   the expected outcome (ADR 0011).
2. **dshplugins.com** — "Submit a plugin"; human-reviewed, public GitHub source, install command
   taken from the maintainer's documentation. It already lists `dsh-browser`, the other Chrome
   bridge, as a local checkout.
3. **Awesome lists** — `0xsline/awesome-deepseek-harness` (built from the `dsh-plugin` topic, so it
   follows by itself), `kejixiaoliang/awesome-dsh-plugins`, `Fishsb/awesome-dsh-plugin` (plugins
   installable with `dsh plugin add` — this one qualifies), `awesome-deepseekharness/awesome-deepseek-harness`
   (wiki table), `HackSing/dsh-plugins` (submission by issue). One issue or pull request each, with
   the canonical description and links; follow each list's own template.
4. **deepseek-ai/deepseek-harness Discussions** — one "show and tell" post, as the community
   catalogues did (discussion #1045 is the precedent); technical, with the security model and the
   evidence, answered in the thread.
5. **Chrome Web Store** — the listing itself (`store/LISTING.md`), category Developer Tools, with
   the five screenshots and the tiles.

### dsh-plugin.org issue, filled

Title:

```text
[Plugin submission] CorsenAI/deepseek-harness-connector — Let an exact DeepSeek Harness session operate only the Chrome tabs you attach, in your own signed-in Chrome
```

Body:

```markdown
### Repository
https://github.com/CorsenAI/deepseek-harness-connector

### One-line value
After installing, one exact DeepSeek Harness session can read and act in the Chrome tabs you explicitly attach to it — in your real, signed-in Chrome profile, through a Chrome Web Store extension — and in no other tab.

### Category
Tools & Capabilities

### Install command
dsh plugin --profile web add https://github.com/CorsenAI/deepseek-harness-connector/releases/download/v0.1.0/corsen-ai-dsh-browser-connector-0.1.0.tgz
(the companion is served from the GitHub release, not from npm; the Chrome extension comes from the Chrome Web Store and shows this command for its own version)

### Compatibility
DeepSeek Harness 0.1.2-rc.1 through 0.2.2-rc.1 (tested), later 0.2 releases load with a notice, the 0.3 line is refused until tested (`engines.dsh`); Node ^22.19 || >=24; pnpm on PATH (DeepSeek Harness's `dsh plugin` needs it); Chrome 120+ on Windows, macOS, Linux.

### License
MIT

### Screenshots / demo
https://github.com/CorsenAI/deepseek-harness-connector/tree/main/store/screenshots

### Notes
Permissions: storage, sidePanel, scripting, alarms, host <all_urls> (needed to act in any tab you attach); no cookies, no debugger, no remote code. The companion listens on 127.0.0.1 only, authenticated; no relay, no telemetry. Passwords, one-time codes, payment fields, hidden values and secret-bearing URL parameters are masked in the page before anything leaves the browser. Unofficial community project by Corsen AI, not affiliated with DeepSeek. Privacy policy: https://corsen.ai/privacy/deepseek-harness-connector/

### Pre-submission checklist
- [x] Repository is public
- [x] GitHub topic `dsh-plugin` added
- [x] README includes the install command
- [x] Plugin exports an `apply(ctx)` module
- [x] Repository root includes a `package.json`
```

## Community post (forum, Discussions, Reddit where showcases are allowed)

Suggested title:

```text
An open-source Chrome extension that gives one DeepSeek Harness session exactly the tabs you choose
```

Body:

```text
I wanted DeepSeek Harness to use my normal signed-in Chrome without guessing the active tab or
mixing two concurrent sessions. DeepSeek Harness Connector binds an exact profile and session to
only the tabs you attach in the side panel: a session with nothing attached is refused, never
redirected to whatever tab is in front.

It can navigate, read, find, click, type, scroll, capture screenshots for a vision model and manage
tabs inside that scope. Passwords, one-time codes and payment fields are masked inside the page
before anything leaves the browser; the extension requests neither cookies nor debugger. The
companion is a DeepSeek Harness plugin installed with one `dsh plugin add` from the project's
release; it listens on 127.0.0.1 only, and Corsen AI runs no relay or telemetry.

Tested on DeepSeek Harness 0.1.2-rc.1 through 0.2.2-rc.1, on Linux, macOS and Windows; the tests,
the evidence and the architecture decisions are in the repository.

Source and setup: https://github.com/CorsenAI/deepseek-harness-connector
Chrome Web Store: <listing URL>

Unofficial community project by Corsen AI, not affiliated with DeepSeek. Feedback on onboarding,
the permission explanations and multi-session behaviour is what I am after.
```

## Verification after publishing

- Every link opens the intended public page in a private window; the release tarball URL answers
  200 after its redirect and installs with the command as written.
- The Store listing, the reviewer note, the privacy page, the README and the support page describe
  the same behaviour and the same version.
- Answer installation questions with the support URL and the setup card, not with pasted shell
  commands that go stale.
- Track Store impressions, installs and uninstalls apart from GitHub stars; ask for honest feedback,
  never incentivise ratings, reviews, stars or forks.
