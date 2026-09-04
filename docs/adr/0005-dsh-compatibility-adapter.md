# ADR 0005 — One compatibility adapter, no scattered version checks

Status: accepted (2026-09-04)

## Context

DeepSeek Harness states plainly that its public APIs are pre-stable and that every consumer must be
updated (`AGENTS.md`, "Pre-stable APIs"). The evidence at baseline is concrete: the source tree is at
`dsh-v0.1.3-alpha.1` while `@deepseek-ai/dsh-tools` publishes `0.0.1-rc.1` as `latest`, `0.1.2-rc.1` as
`next`, and `0.1.2-alpha.5` as `alpha`. A connector that spreads `if (version >= x)` through its tool
handlers becomes unmaintainable within one release cycle.

## Decision

All contact with DeepSeek Harness goes through `companion/src/dsh/`:

```
dsh/
  adapter.ts        resolve the runtime's shape once, at plugin apply()
  capabilities.ts   what this DSH runtime can do, as our own flags
  version.ts        detect and range-check the DSH version
  session-api.ts    session identity and lifecycle, as our own types
  tool-registration.ts  register our tools through whatever API this version exposes
```

The rest of the connector depends only on our internal interface. It never imports a DSH type outside
that directory, and never branches on a DSH version.

## Rationale

- One file changes when upstream changes, and one set of tests proves the change.
- The internal interface is designed for *our* routing model, so it stays stable while DSH's shape
  moves underneath it.
- It makes the supported range a declaration we can test rather than an accident of what happened to
  work on the developer's machine.

## Supported-range policy

`docs/COMPATIBILITY.md` is the single source of truth and records, per row: DSH version or range,
connector version, protocol version, status, known limitations, and the test evidence.

CI runs three lanes:

1. **released** — the npm `latest` DSH the majority of users have.
2. **next** — the current pre-release dist-tag.
3. **upstream** — a scheduled lane against `deepseek-ai/deepseek-harness` `master`.

The upstream lane is allowed to fail without blocking a release; it exists to discover a breaking
change before users report it. The released and next lanes are release gates.

## Consequences

- A DSH version outside the declared range is refused at plugin load with a message naming the
  supported range, rather than being run on hope.
- Adding support for a new DSH version is a change to `dsh/` plus a `COMPATIBILITY.md` row plus a
  regression test, never a change to a tool handler.
