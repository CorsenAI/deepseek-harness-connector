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
| `@deepseek-ai/dsh` 0.1.2-rc.1 with `@deepseek-ai/dsh-tools` 0.1.2-rc.1, `@deepseek-ai/cordis` 4.0.2 | 0.1.0 | 1 | **tested** | `docs/TEST-EVIDENCE.md`, 2026-09-04 (Windows 11): packaged tarball installed with `dsh plugin add`, composed into the Cordis tree, plugin applied; `tools.test.ts` against the real `defineTool`. 2026-09-11 (Ubuntu 26.04): gate AQ, `tests/e2e/released-pair.test.ts` 5/5 — the released pair, a real `dsh` process applying the plugin, the installed tool layer driving a real Chromium through the packaged broker process | A live model turn was not run (no API key in the test environment) |
| `@deepseek-ai/dsh` 0.1.5-rc.1 (npm `latest` on 2026-09-11) with `@deepseek-ai/dsh-tools` 0.1.5-rc.2, `@deepseek-ai/cordis` 4.0.2 | 0.1.0 | 1 | **tested** | `docs/TEST-EVIDENCE.md`, 2026-09-11 (Ubuntu 26.04): the released lane — `dsh plugin add` of the packaged tarball, `--dump-config`, plugin applied in a real `dsh` process; gate AQ 5/5 with `DSH_BIN_DIR` at this installation; companion typecheck and the 240-case unit suite (the real `defineTool` included) against `dsh-tools` 0.1.5-rc.2 | Same: no live model turn |
| `@deepseek-ai/dsh` 0.1.5-rc.2 (npm `next` on 2026-09-11) with `@deepseek-ai/dsh-tools` 0.1.5-rc.2, `@deepseek-ai/cordis` 4.0.2 | 0.1.0 | 1 | **tested** | Same runs as the row above, on the `next` installation | Same: no live model turn |

What changed in `@deepseek-ai/dsh-tools` between 0.1.2-rc.1 and 0.1.5-rc.2, read from the published
type declarations: the programmatic-tool-calling events were renamed (`tool/code-dispatch` →
`tool/ptc-dispatch`) and their sub-call ids became opaque. Nothing this connector uses —
`defineTool`, `ToolRunContext.agent`, `ToolDefinition` — moved, and `agent/created` /
`agent/disposed` are still emitted by `@deepseek-ai/dsh-agent` 0.1.5-rc.2. The releases between
the two ends (0.1.3-alpha.2, 0.1.5-alpha.x, 0.1.5-rc.1 of `dsh-tools`) are alphas and release
candidates of the same line and are declared on the strength of both ends, not of their own row.

## Declared range

`companion/src/dsh/version.ts`:

```
minimum:       0.1.2-rc.1   (inclusive; below this the connector refuses to load)
maximumTested: 0.1.5-rc.2   (inclusive; the highest version with a passing row above)
refuseFrom:    0.2.0        (at or above this the connector refuses to load)
```

Three states, not two:

| Runtime | State | What happens |
|---|---|---|
| Below the minimum | incompatible | Refused at plugin load, with a message naming this range |
| Between the minimum and `maximumTested` | **tested** | Loads; a passing row above says so |
| Above `maximumTested`, below `refuseFrom` | untested | **Loads, and logs that nothing has been verified** |
| At or above `refuseFrom` | incompatible | Refused at plugin load |

The upper bound exists because it was missing: an external review of 2026-09-05 ran the adapter and
found `999.0.0` reported as supported. Claiming to support a release nobody has seen is claiming
something the project cannot know. `companion/tests/version.test.ts` now covers each state.

A runtime in the untested band is **accepted**, because no incompatibility has been observed yet —
but it is not *tested*,
and the upstream lane below exists to find out before a user does.

## Not supported

| DeepSeek Harness | Reason |
|---|---|
| `@deepseek-ai/dsh-tools` 0.0.1-rc.x (npm `latest` at baseline) | Older tool-registry API; untested. Refused at load. |
| Anything before 0.1.2-rc.1 | Untested. Refused at load. |
| Anything at or above 0.2.0 | A new pre-stable minor line may change the APIs this connector depends on. Refused at load until a row above says otherwise. |

## Known upstream limitations

Observed behaviour of the DeepSeek Harness releases above that the connector has to work around.
Each names the evidence, the workaround, and where it lives.

### `dsh plugin add <path>` splits a path containing a space, on Windows only

**Evidence.** In `@deepseek-ai/dsh` 0.1.2-rc.1, `apps/cli/src/plugin.ts` forwards to pnpm with
`spawnSync("pnpm", args, { shell: process.platform === "win32" })` (visible in the published
`lib/plugin-*.js`). With a shell, the arguments are joined into one command line that `cmd.exe`
re-tokenizes, so `C:\Users\Jane Doe\x.tgz` arrives at pnpm as three tokens. Reproduced on
2026-09-04: the same tarball installs from `C:\Users\RTX6000\AppData\Local\Temp\dsh-flat\` and
fails from `…\DeepSeek Harness connector\dist\` with `ENOENT …\connector\dist\…` plus an attempt to
fetch a package named `Harness`. Linux is unaffected because no shell is involved there.

**Workaround.** `scripts/install.ps1` passes the file's Windows 8.3 short name, which contains no
spaces and needs no copy, and stops with an explanation when short names are disabled on the
volume. A user calling `dsh plugin add` by hand on Windows must supply a space-free path.

**Status.** Worth reporting upstream: quoting each argument, or spawning `pnpm.cmd` without a
shell, would remove the limitation. Until then this row stays.

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

## CI lanes

| Lane | Target | Gate | Where |
|---|---|---|---|
| **released** | npm `latest` | release blocker | `.github/workflows/ci.yml`, jobs `dsh-integration` and `released-pair` |
| **next** | npm `next` dist-tag | release blocker | same jobs |
| **upstream** | `deepseek-ai/deepseek-harness` `master`, scheduled | advisory — may fail without blocking a release; exists to discover a breaking change before users report it | `dsh-integration` |

The lanes are configured and have been **run locally, by hand, on 2026-09-11** with the same
commands the jobs run (`.scratch/compat-lane.sh` on this machine; the rows above). They have never
run on GitHub, because the repository has no remote yet (`TEST-MATRIX.md` gate Z stays partial
until the first hosted run writes its row).

## When upstream breaks us

1. The upstream lane fails, or a user reports it.
2. The change is confined to `companion/src/dsh/` (ADR 0005). Nothing outside that directory
   imports a DeepSeek Harness type.
3. A regression test is added.
4. This table gains a row, `version.ts` is updated, and the connector version is bumped.

The protocol version does **not** change for a DeepSeek Harness compatibility update; it changes
only when the extension and the package could misread each other.
