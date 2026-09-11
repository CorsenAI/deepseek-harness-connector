# @corsen-ai/dsh-browser-connector

The DeepSeek Harness half of the **DeepSeek Harness Connector**: a plugin that gives one exact
DeepSeek Harness session the ability to operate the Chrome tabs its user explicitly attached, plus
the local broker the Chrome extension connects to.

An unofficial community project by **Corsen AI**. Not affiliated with, endorsed by, or certified by
DeepSeek.

## Install

```bash
dsh plugin --profile web add @corsen-ai/dsh-browser-connector
```

That is the whole installation. The package declares `dsh.bundle.patch`, so DeepSeek Harness adds it
to the profile's layer stack itself; there is no YAML to edit.

Then start the broker and read the pairing code:

```bash
npx dsh-connector-broker --pairing-code
```

Install the Chrome extension, type that code into its panel once, and attach a tab to a session.
Until a tab is attached, every browser tool fails with a clear refusal. There is no fallback to
whatever tab happens to be active.

Requires Node `^22.19 || >=24`, pnpm on `PATH` (DeepSeek Harness's `dsh plugin` command forwards
to it and does not install it: `npm install -g pnpm`), and a DeepSeek Harness at or above
`0.1.2-rc.1`; tested up to `0.1.5-rc.2` (`docs/COMPATIBILITY.md` in the repository lists every
tested release).

## What it does, and what it never does

The plugin registers twenty browser tools, one per protocol action: reading a page, acting in it,
navigating, and managing the session's own tabs. Routing is by `(profileId, sessionId)`, so two
sessions running at once never reach each other's tabs.

It never reads cookies, never uses `chrome.debugger`, and sends nothing to Corsen AI. Passwords,
one-time codes, payment fields and hidden values are masked inside the page, before anything leaves
the browser. An action whose outcome is unknown is reported as unknown, and nothing is ever replayed
on reconnect.

## Documentation and source

<https://github.com/CorsenAI/deepseek-harness-connector>

The repository carries the architecture, the protocol, the threat model, the test matrix, and the
evidence for every release gate.

## Licence

MIT. See `LICENSE`.
