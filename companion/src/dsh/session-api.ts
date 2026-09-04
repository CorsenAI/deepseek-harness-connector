/**
 * DeepSeek Harness session identity and lifecycle, expressed as this connector's own types
 * (ADR 0005).
 *
 * Nothing outside `src/dsh/` imports a DeepSeek Harness type. When upstream moves, this file moves
 * and the routing, transport, and extension code do not.
 *
 * @module @corsen-ai/dsh-browser-connector/dsh/session-api
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ID_PATTERN } from '../protocol.ts'

/** One live DeepSeek Harness session as the connector sees it. */
export interface LiveSession {
  /** The session identifier, which is also the agent's identity in DeepSeek Harness. */
  readonly sessionId: string
  /** A short label for the panel. */
  readonly title: string
}

/** Why a tool call could not be routed to a session. */
export type SessionResolutionFailure =
  /** The call carried no agent, so it belongs to no session and must not act (ADR 0007). */
  | { readonly kind: 'no-agent' }
  /** The call carried an agent whose identity is not a usable routing key. */
  | { readonly kind: 'unusable-id', readonly value: string }

/** The outcome of resolving a tool call to a session. */
export type SessionResolution =
  | { readonly ok: true, readonly sessionId: string }
  | { readonly ok: false, readonly failure: SessionResolutionFailure }

/**
 * Resolve which DeepSeek Harness session a tool call belongs to.
 *
 * `exec.agent` is optional on a tool execution: a programmatic or transport-level dispatch can run
 * with no agent at all. That case must fail rather than fall back to any other session, which is
 * why this returns a failure instead of a nullable string a caller could accidentally ignore.
 * @param exec - the tool execution context DeepSeek Harness supplies.
 * @returns the session id, or the reason there is none.
 */
export function resolveSession(exec: Pick<ToolRunContext, 'agent'>): SessionResolution {
  const agent = exec.agent
  if (agent === undefined) return { ok: false, failure: { kind: 'no-agent' } }
  const sessionId = String(agent.id)
  if (!ID_PATTERN.test(sessionId)) return { ok: false, failure: { kind: 'unusable-id', value: sessionId } }
  return { ok: true, sessionId }
}

/**
 * The message shown to the model when a call cannot be routed.
 *
 * It names the actual cause, because a model that is told only "failed" will retry the same call.
 * @param failure - why resolution failed.
 * @returns a model-facing sentence.
 */
export function sessionFailureMessage(failure: SessionResolutionFailure): string {
  switch (failure.kind) {
    case 'no-agent':
      return 'This browser tool can only run inside a DeepSeek Harness session, and this call carried none. '
        + 'No browser action was performed.'
    case 'unusable-id':
      return `This session's identifier (${failure.value}) cannot be used to route a browser action. `
        + 'No browser action was performed.'
    default:
      return 'This call could not be routed to a DeepSeek Harness session. No browser action was performed.'
  }
}

/** Callbacks fired as sessions come and go inside one DeepSeek Harness process. */
export interface SessionObserver {
  /**
   * @param session - a session that just became live.
   */
  onStart(session: LiveSession): void
  /**
   * @param sessionId - a session that just ended.
   */
  onEnd(sessionId: string): void
}

/**
 * Track the sessions live in this DeepSeek Harness process.
 *
 * Session discovery is push-based so the panel can list sessions without querying any DSH HTTP API,
 * which keeps it working for the `headless`, `sdk`, and `acp` profiles that have no Web surface
 * (ADR 0001). Registration goes through `ctx.on`, so disposing the plugin fiber unsubscribes.
 * @param ctx - the Cordis context this plugin was applied with.
 * @param observer - what to do as sessions start and end.
 */
export function observeSessions(ctx: Context, observer: SessionObserver): void {
  ctx.on('agent/created', ({ agent }) => {
    const sessionId = String(agent.id)
    if (!ID_PATTERN.test(sessionId)) return
    observer.onStart({ sessionId, title: sessionId })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    const sessionId = String(agent.id)
    if (!ID_PATTERN.test(sessionId)) return
    observer.onEnd(sessionId)
  })
}
