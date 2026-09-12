# DeepSeek Harness Connector 0.1.0 — release notes

The text for the GitHub release `v0.1.0`, ready to paste. Hashes are those of the artifacts built
from the closing commit of 2026-09-12 (`docs/TEST-EVIDENCE.md`); they hold for any later commit
that leaves `extension/` and `companion/` untouched, and `scripts/verify-package.mjs` refuses a
build whose manifest does not match the tree it was built from.

---

## First public release

**DeepSeek Harness Connector** lets one exact DeepSeek Harness session — running on your own
computer — read and act in the Chrome tabs you explicitly attach to it, inside the Chrome profile
you are already signed in to. Two parts, released together at the same version:

| Artifact | What it is | SHA-256 | Bytes |
|---|---|---|---|
| `dsh-browser-connector-extension-0.1.0.zip` | The Chrome extension (Manifest V3) — the file submitted to the Chrome Web Store | `4472fe8aa404bf776507a68197e58b8a515e0859091837cf770c73555ea90d8e` | 52596 |
| `corsen-ai-dsh-browser-connector-0.1.0.tgz` | The companion: DeepSeek Harness plugin and local broker, published as `@corsen-ai/dsh-browser-connector` | `9fd23306a537b916ea95f736171f7742826f0a4b3f3c62e971a2943ffc555ea1` | 61521 |

Built from a clean tree; byte-identical when built on Ubuntu, macOS and Windows. `SHA256SUMS` and
`release-manifest.json` accompany them.

### Install

Requires DeepSeek Harness (`dsh`), Node.js 22.19 or newer, and pnpm on `PATH`.

```bash
dsh plugin --profile web add @corsen-ai/dsh-browser-connector
dsh plugin --profile web exec dsh-connector-broker --pairing-code
```

Start DeepSeek Harness — the connector starts its local broker by itself when nothing is listening
— install the extension from the Chrome Web Store, open its side panel, type the pairing code once,
pick your session, and press **Attach this tab**. The panel's setup card says whether the
connector is reachable and shows the commands for your system. Installers that do all of this and
print the code: `scripts/install.sh` (macOS, Linux) and `scripts/Install Connector.cmd` (Windows).

### Compatibility

| DeepSeek Harness | State |
|---|---|
| `@deepseek-ai/dsh` 0.1.2-rc.1, 0.1.5-rc.1 (`latest`), 0.1.5-rc.2 (`next`) | tested |
| newer, below 0.2.0 | loads, with a notice that it is untested |
| 0.2.0 and above | refused until tested |

Chrome 120 or newer on Windows, macOS and Linux. Protocol version 1; the extension and the
companion must be the same version, and a mismatch is shown as "Update required".

### What a session can do in its tabs

Twenty-one tools, one per action: read the visible page as structured text or as a screenshot,
find text, wait, click, type, press keys, scroll, hover, choose options, drag, navigate, go back
and forward, reload, and open, list, switch and close tabs — only within the tabs attached to that
session. A screenshot travels through DeepSeek Harness's own attachment service: a model that
accepts images receives the pixels, a text-only model receives DeepSeek Harness's placeholder
naming the stored file.

### What it never does

- Reads or acts in a tab you did not attach. Attachment is explicit and per session; two sessions,
  projects or Chrome profiles never reach each other's tabs.
- Reads cookies, history, bookmarks or saved passwords — those permissions are not requested.
- Lets a password, one-time code, payment field or hidden value leave the page as text: they are
  masked inside the page. (A screenshot is pixels and is not masked; it is taken only when the
  session asks, and only of an attached tab.)
- Sends anything to Corsen AI. The extension talks only to the broker on `127.0.0.1`.
- Claims an action happened when the browser refused it, or that a page navigated when it did not.

### Evidence

340 tests: 258 unit and protocol, 14 on the shipped page module in a real Chrome, 68 real-browser
end-to-end — multi-session isolation, a page built to leak hidden content, a page built to give a
model instructions, an attached tab that changes site mid-task, recovery from a killed worker, a
restarted broker, a replaced agent, a closed tab and a relaunched Chrome, the released pair
installed into a real `dsh` with its broker killed and restarted as a process, and three live
turns of a real `dsh` process (its model being DeepSeek Harness's own scripted mock provider):
a text snapshot, a screenshot delivered to a vision model as pixels, and a screenshot delivered to
a text-only model as the placeholder. Run on Ubuntu 26.04, macOS 26.6 and Windows 11 against the
three DeepSeek Harness versions above.
`docs/TEST-MATRIX.md` and `docs/TEST-EVIDENCE.md` in the repository say exactly what was run and
what is not proven.

### Known limitations

- Pages Chrome protects (`chrome://`, the Web Store) cannot be attached.
- Sites that require trusted input events may ignore synthetic clicks; the failure is reported.
- On Windows, `dsh plugin add` splits a path containing a space (an upstream limitation); the
  installer works around it.
- Content inside iframes is not read or acted on in this version: the page code runs in the tab's
  top document and does not descend into frames. Open shadow DOM is read and acted on as rendered;
  a closed shadow root cannot be reached by any script and is not claimed.
- Secret masking is by the signals a page gives; an unlabelled field cannot be told from an
  ordinary one. It applies to text; a screenshot shows the page as rendered.
- A screenshot is of the tab at the front of its window, which is all Chrome captures; a covered
  attached tab is brought to the front first and the result says so.

Unofficial community project by Corsen AI. Not affiliated with, endorsed by, or certified by
DeepSeek. MIT licence.
