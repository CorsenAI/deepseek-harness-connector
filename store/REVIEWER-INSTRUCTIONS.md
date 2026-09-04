# Instructions for the Chrome Web Store reviewer

This extension is one half of a two-part local tool. It does nothing useful on its own: it needs a
small local program (the "connector") that ships in an npm package, and a running DeepSeek Harness.
These steps let you see it working in a few minutes without a DeepSeek Harness account.

## What you are looking at

The user runs DeepSeek Harness (an open-source coding agent) on their own computer. This extension
lets them attach browser tabs to one of its sessions so the agent can read and act in those tabs.
The extension talks only to a local program on `127.0.0.1`. It has no server.

## Setup, about five minutes

You need Node.js 22.19 or newer.

**1. Get the connector.**

```bash
git clone https://github.com/CorsenAI/deepseek-harness-connector
cd deepseek-harness-connector
npm install
npm run build
```

**2. Start the local connector and note the pairing code it prints.**

```bash
node companion/lib/broker-main.js --pairing-code --home ./review-home
node companion/lib/broker-main.js --home ./review-home
```

The first command prints a code like `A3KD-7FMQ-XE94-RTUV-9CTG`. The second starts the connector and
keeps running. Leave it running.

**3. Load the extension** from the `extension/` directory (or the submitted ZIP, unpacked).

**4. Pair.** Open the extension's side panel. Type the pairing code. The status band turns to
"Connected".

## Seeing it work without DeepSeek Harness

DeepSeek Harness requires an API key, so this repository includes a stand-in that behaves as a
DeepSeek Harness session would. It sends the same messages the real plugin sends.

```bash
node scripts/review-session.mjs --home ./review-home
```

This announces a session called "Review session" to the connector. In the side panel:

1. The session appears under **DeepSeek Harness sessions**. Select it.
2. Open any ordinary web page in a tab, for example `https://example.com`.
3. Click **Attach this tab**. The route card now shows the session, this Chrome profile, and one
   attached tab.
4. Back in the terminal, the stand-in offers a prompt. Type `snapshot` and press Enter. The
   terminal prints the page as structured text with numbered controls — the same output a DeepSeek
   Harness model would receive.
5. Type `click e1@1` (or any reference from the snapshot). The click happens in the tab.

## What to check

- **Nothing happens in a tab you did not attach.** Open a second tab; the stand-in cannot reach it.
- **Passwords are masked.** Navigate the attached tab to any login page and take a snapshot: the
  password field is listed but its value is `••••••••`.
- **No external traffic.** DevTools network tab on the service worker shows only
  `ws://127.0.0.1:...`.
- **No cookies permission.** `chrome://extensions` → Details → Permissions.
- **Everything the extension runs is in the package.** `src/` is plain, unminified JavaScript.
  There is no remote script, no `eval`, and no interpreter.

## The five things the extension can do

`browser_snapshot`, `browser_read_text`, `browser_current_url`, `browser_click`, `browser_type`.
These are the complete list, declared in `extension/src/page-actions.js`, and the connector refuses
any other request.

## Source

`https://github.com/CorsenAI/deepseek-harness-connector`. The submitted ZIP is produced by
`scripts/package.mjs` from a tagged commit and is byte-identical across builds; the tag and hashes
are in the release notes.

## Contact

Corsen AI — support address in the listing. This is an unofficial community project, not affiliated
with DeepSeek.
