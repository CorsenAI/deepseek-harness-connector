# Compatibility

Which DeepSeek Harness versions this connector is tested against, with the evidence. This file is
the single source of truth for the supported range; `companion/src/dsh/version.ts` enforces it at
load and must not be widened without a row here.

DeepSeek Harness states that its public APIs are pre-stable and that every consumer must be updated
(`AGENTS.md`, "Pre-stable APIs and released Session data"). The rows below are declarations backed
by runs, not assumptions.

## Supported

| DeepSeek Harness | Connector | Protocol | Status | Evidence | Limitations |
|---|---|---|---|---|---|
| `@deepseek-ai/dsh` 0.1.2-rc.1 with `@deepseek-ai/dsh-tools` 0.1.2-rc.1, `@deepseek-ai/cordis` 4.0.2 | 0.1.0 | 1 | **tested** | `docs/TEST-EVIDENCE.md`, 2026-09-04: packaged tarball installed with `dsh plugin add`, composed into the Cordis tree, plugin applied; `tools.test.ts` against the real `defineTool` | A live model turn was not run (no API key in the test environment) |

## Declared range

`companion/src/dsh/version.ts`:

```
minimum: 0.1.2-rc.1   (inclusive)
maximum: none yet     (no tested upper bound)
```

A runtime below the minimum is refused at plugin load with a message naming this range. A runtime
above it is **accepted**, because no incompatibility has been observed yet — but it is not *tested*,
and the upstream lane below exists to find out before a user does.

## Not supported

| DeepSeek Harness | Reason |
|---|---|
| `@deepseek-ai/dsh-tools` 0.0.1-rc.x (npm `latest` at baseline) | Older tool-registry API; untested. Refused at load. |
| Anything before 0.1.2-rc.1 | Untested. Refused at load. |

## Version detection

The connector reads the version of `@deepseek-ai/dsh-tools` as resolved from its own installation
location. That package is the API it actually depends on: a DeepSeek Harness distribution that
changed it is the one that can break us, whatever the CLI reports.

If the version cannot be read at all, the connector refuses to load (with
`requireSupportedHarness: true`, the default) rather than guessing.

## Source baseline

Development was done against `deepseek-ai/deepseek-harness` at
`d347e703908d0406b7a7ef80e3a0e594d86b2215` (`dsh-v0.1.3-alpha.1`, 2026-09-04). The source tree is
ahead of the published packages; the table above records what was *run*, which is the published
`0.1.2-rc.1`.

## CI lanes (planned)

| Lane | Target | Gate |
|---|---|---|
| **released** | npm `latest` | release blocker |
| **next** | npm `next` dist-tag | release blocker |
| **upstream** | `deepseek-ai/deepseek-harness` `master`, scheduled | advisory — may fail without blocking a release; exists to discover a breaking change before users report it |

None of these lanes is configured yet (`TEST-MATRIX.md` gate Z). Until they are, this table has one
row and it was produced by hand.

## When upstream breaks us

1. The upstream lane fails, or a user reports it.
2. The change is confined to `companion/src/dsh/` (ADR 0005). Nothing outside that directory
   imports a DeepSeek Harness type.
3. A regression test is added.
4. This table gains a row, `version.ts` is updated, and the connector version is bumped.

The protocol version does **not** change for a DeepSeek Harness compatibility update; it changes
only when the extension and the package could misread each other.
