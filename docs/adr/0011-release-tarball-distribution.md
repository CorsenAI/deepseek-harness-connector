# ADR 0011 — The companion is served from the project's GitHub release, not from npm

Status: accepted (2026-11-05, the owner's decision). Amends ADR 0002.

## Context

ADR 0002 ships the companion as one `dsh plugin`-installable package, `@corsen-ai/dsh-browser-connector`,
and assumed it would be published to the npm registry, so that installation is
`dsh plugin --profile web add @corsen-ai/dsh-browser-connector`.

DeepSeek Harness's plugin manager installs from more than a registry name. On the 0.1 line
`dsh plugin` forwards its arguments to pnpm as they are; on the 0.2 line `parseInstallSpec`
(`packages/boot/plugin-manager/src/install-spec.ts`) reads a spec as a registry name, a local path, a
git address, or a **tarball** — on disk or over HTTP, `/\.(?:tgz|tar\.gz)(?:#.*)?$/` — and pnpm fetches
a tarball URL itself, following redirects. On 2026-11-05 the real `dsh` 0.1.2-rc.1 and 0.2.2-rc.1 both
installed the packaged tarball from a loopback URL shaped like a GitHub release asset (a 302 to the
file, as github.com answers), recorded the URL as the profile's dependency, reconciled the bundle, and
removed it on `dsh plugin remove`. DeepSeek Harness 0.2.2-rc.1 still applied `engines.dsh` to a
tarball: a tarball declaring an incompatible range was rejected after the download, with DeepSeek
Harness's own message and the profile restored (`restored package.json, pnpm-lock.yaml, and
node_modules`).

Corsen AI's other connector, Hermes Connector, distributes its companion as a download from its GitHub
release, matched to the extension version, with no package registry in the loop. The owner asked
why this connector needed npm at all.

## Decision

The companion is **not published to npm**. Each release of this project attaches
`corsen-ai-dsh-browser-connector-<version>.tgz` to the GitHub release `v<version>`, and that URL is
the install spec everywhere:

```sh
dsh plugin --profile web add https://github.com/CorsenAI/deepseek-harness-connector/releases/download/v<version>/corsen-ai-dsh-browser-connector-<version>.tgz
```

- The extension's setup card builds the command from **its own version**
  (`companionTarballUrl` in `extension/src/panel-state.js`), so whatever release a user has, the card
  names its pair (ADR 0004: extension and companion at the same version).
- The "Update required" state names that command too: a tarball dependency is pinned to its URL, so
  moving to a newer release is the install command of the newer version, not `dsh plugin update`.
- Both installers download that URL by default; `--package` / `-Package` still take any tarball
  `dsh plugin add` accepts — another URL or a local `.tgz`. The installers carry the version as a
  constant, and a unit test holds it equal to the extension's and the companion's.
- The package keeps its name `@corsen-ai/dsh-browser-connector`: it is the name inside the tarball,
  the profile's dependency key, and what `dsh plugin remove` takes.
- The installer suites (`tests/installer/`) install through a loopback stand-in for the release URL
  with its redirect (`tarball-server.mjs`), against the real `dsh`, on every lane.

## Rationale

- One fewer account and one fewer publication step for the owner, with no loss for the user: the
  command is one line either way, the setup card writes it and copies it.
- The same channel as Hermes Connector: one place to look for a release, the tarball beside the ZIP,
  the hashes and the manifest.
- DeepSeek Harness's own compatibility gate still applies: `engines.dsh` is read from the downloaded
  manifest, and 0.2.1 and later refuse an incompatible pairing before anything runs.
- Nothing changes in the companion: it ships built `lib/`, installs with no build step, and the
  package is the same bytes a registry would have served.

## Consequences

- The GitHub release must be public **before** the Store submission: a reviewer who follows the setup
  card must be able to install (`store/SUBMISSION-CHECKLIST.md`).
- No pre-download compatibility check: for a registry spec, DeepSeek Harness 0.2 asks the registry
  for `engines.dsh` before fetching; for a tarball it fetches first. The refusal is the same, a few
  hundred kilobytes later.
- No Discover-tab index: DeepSeek Harness's plugin-index format needs the registry's publish time, so
  the optional index exists only if the package is one day published to npm as
  well. This decision does not forbid that; it removes it from the release path.
- `dsh plugin update` does not move a URL dependency. The panel and the documentation say that a
  newer release is the same command with the newer URL.
- A user behind a proxy that blocks github.com cannot install from the card; the installers'
  `--package ./x.tgz` with a downloaded file remains the way, as before.
