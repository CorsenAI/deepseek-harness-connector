# DeepSeek Harness Connector 0.1.0 — release notes

The text for the GitHub release `v0.1.0`, ready to paste. Hashes are those of the artifacts built
from the closing commit of 2026-09-11 (`docs/TEST-EVIDENCE.md`); they hold for any later commit
that leaves `extension/` and `companion/` untouched, and `scripts/verify-package.mjs` refuses a
build whose manifest does not match the tree it was built from.

---

## First public release

**DeepSeek Harness Connector** lets one exact DeepSeek Harness session — running on your own
computer — read and act in the Chrome tabs you explicitly attach to it, inside the Chrome profile
you are already signed in to. Two parts, released together at the same version:

| Artifact | What it is | SHA-256 | Bytes |
|---|---|---|---|
| `dsh-browser-connector-extension-0.1.0.zip` | The Chrome extension (Manifest V3) — the file submitted to the Chrome Web Store | `f7573fce6cf65ede7707ef2453e9d859edce2f82a10fc1b479876adf46f61a9e` | 51079 |
| `corsen-ai-dsh-browser-connector-0.1.0.tgz` | The companion: DeepSeek Harness plugin and local broker, published as `@corsen-ai/dsh-browser-connector` | `614e26cc6f3758f38a30c74bdd8c62245ea5ceaa1abed9282df253eb74826fd2` | 59888 |

Built from a clean tree; byte-identical when built on Ubuntu, macOS and Windows. `SHA256SUMS` and
`release-manifest.json` accompany them.

### Install

Requires DeepSeek Harness (`dsh`), Node.js 22.19 or newer, and pnpm on `PATH`.

```bash
dsh plugin --profile web add @corsen-ai/dsh-browser-connector
npx dsh-connector-broker --pairing-code
```

Install the extension from the Chrome Web Store, open its side panel, type the pairing code once,
pick your session, and press **Attach this tab**. Installers that also start the broker and check
the setup: `scripts/install.sh` (macOS, Linux) and `scripts/Install Connector.cmd` (Windows).

### Compatibility

| DeepSeek Harness | State |
|---|---|
| `@deepseek-ai/dsh` 0.1.2-rc.1, 0.1.5-rc.1 (`latest`), 0.1.5-rc.2 (`next`) | tested |
| newer, below 0.2.0 | loads, with a notice that it is untested |
| 0.2.0 and above | refused until tested |

Chrome 120 or newer on Windows, macOS and Linux. Protocol version 1; the extension and the
companion must be the same version, and a mismatch is shown as "Update required".

### What a session can do in its tabs

Twenty tools, one per action: read the visible page as structured text, find text, wait, click,
type, press keys, scroll, hover, choose options, drag, navigate, go back and forward, reload, and
open, list, switch and close tabs — only within the tabs attached to that session.

### What it never does

- Reads or acts in a tab you did not attach. Attachment is explicit and per session; two sessions,
  projects or Chrome profiles never reach each other's tabs.
- Reads cookies, history, bookmarks or saved passwords — those permissions are not requested.
- Lets a password, one-time code, payment field or hidden value leave the page: they are masked
  inside the page.
- Sends anything to Corsen AI. The extension talks only to the broker on `127.0.0.1`.
- Claims an action happened when the browser refused it, or that a page navigated when it did not.

### Evidence

324 tests: 246 unit and protocol, 14 on the shipped page module in a real Chrome, 64 real-browser
end-to-end — multi-session isolation, a page built to leak hidden content, a page built to give a
model instructions, an attached tab that changes site mid-task, recovery from a killed worker, a
restarted broker, a replaced agent, a closed tab and a relaunched Chrome, the released pair
installed into a real `dsh` with its broker killed and restarted as a process, and one live turn
of a real `dsh` process (its model being DeepSeek Harness's own scripted mock provider). Run on
Ubuntu 26.04, macOS 26.6 and Windows 11 against the three DeepSeek Harness versions above.
`docs/TEST-MATRIX.md` and `docs/TEST-EVIDENCE.md` in the repository say exactly what was run and
what is not proven.

### Known limitations

- Pages Chrome protects (`chrome://`, the Web Store) cannot be attached.
- Sites that require trusted input events may ignore synthetic clicks; the failure is reported.
- On Windows, `dsh plugin add` splits a path containing a space (an upstream limitation); the
  installer works around it.
- Content inside iframes and shadow DOM is not read or acted on in this version: the page code
  runs in the tab's top document and does not descend into either.
- Secret masking is by the signals a page gives; an unlabelled field cannot be told from an
  ordinary one.

Unofficial community project by Corsen AI. Not affiliated with, endorsed by, or certified by
DeepSeek. MIT licence.
