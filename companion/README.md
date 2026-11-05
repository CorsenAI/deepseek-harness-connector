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

Then start DeepSeek Harness. The plugin starts the local broker by itself when nothing is
listening on the port (a detached process that outlives the session; `autoStartBroker: false` in
the profile's `cordis.yml` turns that off), and the pairing code is printed by the package's own
command, which `dsh plugin` runs for you in the profile directory:

```bash
dsh plugin --profile web exec dsh-connector-broker --pairing-code
```

Install the Chrome extension, type that code into its panel once, and attach a tab to a session.
Until a tab is attached, every browser tool fails with a clear refusal. There is no fallback to
whatever tab happens to be active.

Requires Node `^22.19 || >=24`, pnpm on `PATH` (DeepSeek Harness's `dsh plugin` command forwards
to it and does not install it: `npm install -g pnpm`), and DeepSeek Harness `0.1.2-rc.1` or later,
tested through `0.2.2-rc.1`; the `0.3` line is refused until it is tested. The range is declared as
`engines.dsh`, which DeepSeek Harness 0.2.1 and later check before installing
(`docs/COMPATIBILITY.md` in the repository lists every tested release).

## What it does, and what it never does

The plugin registers twenty-one browser tools, one per protocol action: reading a page as text or
as a screenshot, acting in it, navigating, and managing the session's own tabs. Routing is by
`(profileId, sessionId)`, so two sessions running at once never reach each other's tabs. DeepSeek
Harness clients show each call as a titled card ("Open" and the address, "Type into e3@2"), and the
Plugins page shows the package by its own name, description and icon.

It never reads cookies, never uses `chrome.debugger`, and sends nothing to Corsen AI. Passwords,
one-time codes, payment fields and hidden values are masked inside the page, before anything leaves
the browser; a screenshot is pixels and is not masked, which its tool description says. Screenshots
go through DeepSeek Harness's own attachment service (`@deepseek-ai/dsh-attachment`, an optional
peer: without it the tool refuses and says to use the text snapshot). An action whose outcome is
unknown is reported as unknown, and nothing is ever replayed on reconnect.

## Documentation and source

<https://github.com/CorsenAI/deepseek-harness-connector>

The repository carries the architecture, the protocol, the threat model, the test matrix, and the
evidence for every release gate.

## Licence

MIT. See `LICENSE`.
