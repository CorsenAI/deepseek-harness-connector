# ADR 0010 — One version boundary, declared to DeepSeek Harness as `engines.dsh`

Status: accepted (2026-11-05)

## Context

ADR 0005 put every DeepSeek Harness contact in `companion/src/dsh/` and made the supported range a
tested declaration enforced at plugin load. Two things changed after it.

**The range went stale while nothing changed here.** On 2026-11-05 DeepSeek Harness's npm `latest`
was 0.2.1-rc.5 and `next` 0.2.2-rc.1. The connector refused everything from 0.2.0 on, so a user
following the README got a plugin that would not load. Run for real, both releases pass the
released-pair and live-turn suites; the plugin's own code needed one change (below).

**DeepSeek Harness grew its own rule.** From 0.2.1 its installer and its profile startup read a
plugin's `engines.dsh` (else its `@deepseek-ai/dsh*` peer ranges), evaluate it with prereleases
included, refuse a package whose range the running version does not satisfy before any of the
package's code runs, and offer the user an exact-version exemption
(`dsh plugin allow-version <pkg@ver> --dsh-version <ver> --accept-risk`). Its publishing guide asks
bundle authors to declare `engines.dsh`. The connector declared nothing, and its peer ranges
(`>=0.0.1-0`) accepted everything — so DeepSeek Harness installed a package that then refused to load.

**The 0.2 prereleases changed what the connector depends on.** `agent/created` became a serial,
awaited event whose listener failure rolls a session's creation back; a profile launch stopped
linking the runtime's packages beside the profile; the provider wire moved to the Messages protocol.
None was announced as breaking for plugins, and all arrived in `-alpha`/`-rc` releases of the new
minor line. The old boundary, `refuseFrom: 0.2.0`, let every `0.2.0-*` prerelease load as
"untested" because a prerelease sorts below its release.

## Decision

1. **One boundary, two enforcers.** The supported range is `>=0.1.2-rc.1 <0.3.0-0`:
   - tested from `0.1.2-rc.1` to `0.2.2-rc.1` (each end and the current `latest`/`next` have a passing
     row in `docs/COMPATIBILITY.md`);
   - later releases of the 0.2 line load as *untested*, with a log line saying so;
   - refused from `0.3.0-0`, the lowest possible prerelease of the next minor line.

   `companion/src/dsh/version.ts` enforces it at load (`SUPPORTED_DSH`, `DSH_ENGINES_RANGE`), and
   `companion/package.json` declares the same string as `engines.dsh`. A unit test keeps the two
   equal; the released-pair suite loads DeepSeek Harness's own `evaluatePluginCompatibility` from the
   installation under test and checks, version by version, that it accepts and refuses exactly where
   the connector's gate does.

2. **The next minor line is refused from its first prerelease.** A pre-stable project's next line
   changes its plugin surface in prereleases; "untested but probably fine" is not a claim the
   connector can make about a release that drives a signed-in browser. The user keeps two explicit,
   per-installation escapes: DeepSeek Harness's exact-version exemption, and the connector's own
   `requireSupportedHarness: false`.

3. **Peer ranges stay permissive.** With `engines.dsh` present DeepSeek Harness ignores the peers for
   compatibility; they remain only to share the host's instances of cordis, the tool registry and
   the attachment service, as DeepSeek Harness's publishing guide prescribes.

4. **A DeepSeek Harness event listener never throws.** Because a listener on a serial event can roll
   back the user's session, the session observer contains its own failures and logs them. This
   holds for any DeepSeek Harness event the connector listens to.

## Consequences

- On DeepSeek Harness 0.2.1 and later, an incompatible version is refused at `dsh plugin add` with
  DeepSeek Harness's own message and remedy, instead of installing and failing at startup.
- On 0.1.x and 0.2.0, which read no `engines.dsh`, the connector's load-time gate is still the only
  guard; the released-pair suite records that case as skipped, with the reason.
- Widening the range is a `COMPATIBILITY.md` row with evidence, a change to `SUPPORTED_DSH`, and the
  matching `engines.dsh` string — the unit test fails if the last is forgotten.
- A new DeepSeek Harness minor line needs a connector release before its users can use the
  connector. That is the cost of not guessing, and the scheduled upstream CI lane exists to make the
  release early.
