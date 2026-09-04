# Provenance

DeepSeek Harness Connector is an independent Corsen AI implementation. This file records the exact
sources its engineering rests on, the role each source plays, and the baselines captured at project
initialization.

## Baselines

Captured 2026-09-04. Reference clones live in `.refs/` and are excluded from the repository and from
every release artifact by `.gitignore`.

| Repository | Role | Baseline commit | Tag | Commit date |
|---|---|---|---|---|
| `CorsenAI/hermes-connector` | Corsen-owned implementation source | `bfd9bc29718c4647a1438962aae28ed4d1220df6` | `v0.2.4` | 2026-09-02 |
| `deepseek-ai/deepseek-harness` | Official integration authority | `d347e703908d0406b7a7ef80e3a0e594d86b2215` | `dsh-v0.1.3-alpha.1` | 2026-09-04 |
| `Lum1104/dsh-browser` | Behavioral reference only | `e60e6e3f589205a5755b35f234155d3ec17d030b` | `v0.1.3` | 2026-09-04 |

The Hermes baseline was re-cloned from GitHub rather than read from a local working copy; the fresh
clone's `HEAD` matched the local checkout, confirming the reference was current.

## Implementation authority

Design and implementation decisions follow this order. A lower rank never overrides a higher one.

1. **Official DeepSeek Harness APIs and source.** Every integration point — tool registration, session
   identity, plugin installation, profile layout — is taken from the baseline above, not from
   recollection or from third-party projects.
2. **Corsen's own Hermes Connector.** Corsen owns this code and reuses its architecture where it
   remains the best design: the role-bound mutual-HMAC handshake, the exact-scope routing model, the
   post-action ownership revalidation, the explicit tab-ownership registry, and the fail-closed rule.
3. **Newly written Corsen code.** Everything the two sources above do not already settle.
4. **Behavioral observations from other projects.** Capability lists and known failure modes only.

## Ported Corsen modules

Modules whose design descends from Hermes Connector v0.2.4 are marked in their module JSDoc with an
`Ported from Corsen AI Hermes Connector v0.2.4` line naming the origin file. The port is a
re-implementation in TypeScript against DeepSeek Harness interfaces, not a copy: Hermes' companion and
broker are Python and its plugin targets the Hermes plugin API, neither of which exists here.

| This project | Hermes origin | Nature of the port |
|---|---|---|
| `companion/src/auth.ts` | `hermes-plugin/broker.py` (`role_proof`, `broker_proof`) | Same proof construction, re-implemented in TypeScript |
| `companion/src/bindings.ts` | `extension/src/bindings.js` | Same ownership algebra, re-implemented with typed scopes |
| `companion/src/broker.ts` | `hermes-plugin/broker.py` | Same routing and revalidation model, new runtime and protocol |
| `extension/src/protocol.js` | `extension/src/protocol.js` | Same message-kind discipline, new protocol version and action set |

## Third-party reference

`Lum1104/dsh-browser` is used as a behavioral reference only: which capabilities a DeepSeek Harness
browser integration needs, which installation and compatibility problems users hit, and which gaps are
worth solving better. Observations are recorded in `docs/research/REFERENCE-BEHAVIOR.md`.

No source was copied, translated, restructured, or line-by-line rewritten from that project. Its
protocol, module layout, naming, tests, UI, and assets are not used. `docs/PROVENANCE-AUDIT.md`
records the similarity audit run before release.

## Licensing

- Hermes Connector is Corsen AI's own MIT-licensed project; reuse is unrestricted for Corsen.
- DeepSeek Harness is MIT licensed. This project depends on its published npm packages as an external
  plugin and does not vendor, fork, or modify its source.
- `Lum1104/dsh-browser` is MIT licensed. No code from it is present, so no notice obligation arises
  from it; it is credited here as a reference for honesty, not as a dependency.

This project is an unofficial community project by Corsen AI. It is not endorsed by, affiliated with,
or certified by DeepSeek.
