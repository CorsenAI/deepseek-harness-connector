# Third-party notices

This project is MIT licensed. It depends on, or is built against, the following third-party
software. Notices are grouped by what ships to whom.

## Shipped in the npm package (`@corsen-ai/dsh-browser-connector`)

| Package | Licence | Role |
|---|---|---|
| `ws` | MIT | WebSocket server and client for the broker and the plugin's agent client |

`ws` is the only runtime dependency. Everything else the package uses is Node's standard library.

## Peer dependencies, supplied by the user's DeepSeek Harness installation

| Package | Licence | Role |
|---|---|---|
| `@deepseek-ai/cordis` | MIT | The plugin framework DeepSeek Harness is built on |
| `@deepseek-ai/dsh-tools` | MIT | The tool registry and `defineTool` contract |
| `@deepseek-ai/schemastery` | MIT | Configuration schema for the plugin's `Config` |

These are declared as peers and never bundled. The user's DeepSeek Harness supplies them, which is
what keeps the connector's copy of the framework identical to the host's.

## Shipped in the Chrome extension

Nothing. The extension has no dependencies. Every file in the Store package is authored in this
repository.

## Development and test only — never shipped

| Package | Licence | Role |
|---|---|---|
| `typescript` | Apache-2.0 | Compilation and type checking |
| `@types/node`, `@types/ws` | MIT | Type declarations |
| `playwright` | Apache-2.0 | Real-browser end-to-end tests |

## Provenance

The architecture of the authentication handshake, the ownership registry, the routing broker, and
the message-kind discipline descends from Corsen AI's own MIT-licensed Hermes Connector
(`CorsenAI/hermes-connector` v0.2.4), re-implemented in TypeScript for DeepSeek Harness. Modules
that do so say so in their JSDoc.

`deepseek-ai/deepseek-harness` (MIT) was the integration authority. Its source was read; none of it
is vendored, forked, or modified.

`Lum1104/dsh-browser` (MIT) was consulted as a behavioural reference only. No code, protocol,
naming, tests, UI, or assets from it are present. Full detail in `docs/PROVENANCE.md`.

## Brand

DeepSeek and DeepSeek Harness are marks of their respective owners. This is an unofficial community
project by Corsen AI, not affiliated with, endorsed by, or certified by DeepSeek.
