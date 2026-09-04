# ADR 0001 — A local broker owns the port; DSH plugins are clients

Status: accepted (2026-09-04)

## Context

Three architectures were evaluated against DeepSeek Harness at baseline `d347e703` and against the
product invariants: exact routing, failure closed, one tab one owner, explicit attachment, untrusted page content, no `cookies` / `debugger` / remote code, redaction before the trust boundary, honest results.

- **A — plugin hosts the transport.** The Chrome extension connects to a WebSocket server opened by
  the DSH plugin inside the DSH process.
- **B — local broker.** A single detached broker owns one loopback port. Chrome extensions connect as
  `browser` clients; DSH plugin instances connect as `agent` clients. The broker routes.
- **C — hybrid.** The companion owns browser multiplexing while DSH plugins stay thin clients. This is
  B with a different name; the distinction collapses once the broker is the only port owner.

Facts established from the DeepSeek Harness source that drive the decision:

- Every supported application is a `dsh` CLI process with a named profile: `dsh web`,
  `dsh --profile headless`, `dsh --profile sdk`, `dsh --profile acp`
  (`docs/architecture.md`, "Application launch"). These are **separate OS processes**, and a user may
  run several at once.
- `dsh --profile headless "task"` is a **one-shot** process. It exits when the task ends.
- Profiles are independent directories under `$DSH_HOME/profiles/<name>` with their own plugin
  dependency sets, so the same plugin is installed and loaded more than once.
- A tool's calling session is `exec.agent.id`, a `SessionId` (`packages/core/agent/src/types.ts`), and
  `exec.agent` is **optional** on `ToolExecutionInput`.

## Decision

Architecture B. One broker process per DSH home owns `127.0.0.1:8781`. Chrome extension instances and
DSH plugin instances are both authenticated clients of it.

## Rationale

1. **Only one process can bind a port.** Under A, the first `dsh` process to start wins the port and
   every other DSH process — a second profile, a headless one-shot, the SDK — cannot serve the
   extension at all. Port-per-process plus discovery would then have to be invented, which is a broker
   with worse properties.
2. **One-shot processes must not own durable state.** Pairing secrets, browser identity, and tab
   ownership have to outlive `dsh --profile headless "task"`. Under A they die with the task.
3. **MV3 service workers are evicted.** The extension needs one stable reconnect target whose address
   does not change with DSH's lifecycle.
4. **Version mismatch needs one authority.** Chrome auto-updates the extension; the local package does
   not update at the same moment. A single broker with an explicit version handshake is the one place
   that can fail closed with an actionable message (ADR 0004).
5. **Proven.** Corsen's Hermes Connector reached the same conclusion under the same pressures and
   shipped it; its `docs/ARCHITECTURE-V2.md` records the single-`controlledTabId` design this replaced.

## Difference from Hermes

Hermes' broker is Python because the Hermes plugin API is Python. DeepSeek Harness is an ESM TypeScript
monorepo on Node `^22.19 || >=24`. Our broker is therefore **TypeScript on the same Node runtime as
DSH**, shipped inside the same npm package as the plugin. The result is one runtime, no Python
dependency, and `dsh plugin ... add` as the whole installation (ADR 0002).

## Consequences

- The broker is a detached process with its own lifecycle, requiring a start/health/stop story and a
  cross-process launch lock.
- Both roles authenticate; neither is trusted for being on loopback (ADR 0003).
- Session discovery is push-based: plugins announce their live sessions from `agent/created` and
  `agent/disposed`, so the panel lists sessions without querying any DSH HTTP API and works for
  headless, ACP, and SDK profiles, not only `dsh web`.
