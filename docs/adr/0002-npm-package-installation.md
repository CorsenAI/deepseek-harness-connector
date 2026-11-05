# ADR 0002 — Ship as one `dsh plugin`-installable npm bundle

Status: accepted (2026-09-04); the distribution channel amended by [ADR 0011](0011-release-tarball-distribution.md)
(2026-11-05) — the same one package, installed by the same `dsh plugin add`, served from the project's
GitHub release instead of the npm registry

## Context

DeepSeek Harness installs persistent external plugins with `dsh plugin --profile <name> <pnpm args>`
(`apps/cli/src/plugin.ts`). It is a thin pnpm forwarder that installs into the profile directory, then
reconciles `dsh.profile.bundles` against the **installed state**: any dependency resolving to a package
whose manifest declares `dsh.bundle.patch` joins the profile's layer stack automatically.

A bundle is therefore an ordinary npm package with:

```json
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
```

whose patch file inserts plugin rows into the profile's Cordis tree
(`packages/bundle/headless/cordis.patch.yml` is the reference shape).

The community reference project states that "the standard `dsh plugin` command alone cannot install
this project" and distributes a piped shell installer from a git branch instead, because its bridge and
extension are separate artifacts.

## Decision

Publish one npm package, `@corsen-ai/dsh-browser-connector`, that contains the DSH plugin **and** the
broker, and declares `dsh.bundle.patch`. Installation for a user who already has DSH is:

```sh
dsh plugin --profile web add @corsen-ai/dsh-browser-connector
```

The OS installers (`.cmd` / `.ps1` / `.sh`) exist for users who want pairing, health checks, and
uninstall handled for them, and for non-default `DSH_HOME` layouts. They wrap this command; they are
never the only path.

## Rationale

- It is the officially supported seam. Nothing in DSH core is patched or forked.
- Because reconciliation reads installed state, a user who upgrades our package with
  `dsh plugin --profile web update` gets the new layer without editing YAML.
- One artifact keeps the plugin and its broker at the same version by construction, which removes an
  entire class of local mismatch. Only extension-to-package skew remains, and ADR 0004 handles it.
- Corsen-controlled naming: the package is `@corsen-ai/*`, never `@deepseek-ai/*`.

## Consequences

- The package must be publishable and installable on Windows, macOS, and Linux with no build step at
  install time, so it ships built `lib/` output.
- `@deepseek-ai/dsh-tools` and `@deepseek-ai/cordis` are peer dependencies, matching how every DSH
  package declares Cordis. The profile supplies the real instances through the two-anchor resolution
  described in `packages/boot/app-boot/src/profile.ts`.
- npm dist-tags at baseline are behind the source tree (`@deepseek-ai/dsh-tools` latest `0.0.1-rc.1`,
  next `0.1.2-rc.1`, alpha `0.1.2-alpha.5`; source at `dsh-v0.1.3-alpha.1`). The supported range is an
  explicit, tested declaration, not an assumption (ADR 0005).
