/**
 * How DeepSeek Harness sessions reach the connector, and what a session-less call gets.
 *
 * DeepSeek Harness 0.2 made `agent/created` a serial event: every listener is awaited before a
 * session's creation or resume completes, and a listener that throws rolls the creation back. A
 * connector bug there would stop the user's session from starting at all, so the observer is held
 * to two rules: it answers `undefined` at once, and nothing a callback throws escapes it.
 * @module
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { observeSessions, resolveSession, sessionFailureMessage } from '../src/dsh/session-api.ts'

type Listener = (payload: { agent: { id: unknown } }) => unknown

/** A context that records listeners and log lines, standing in for the plugin's Cordis context. */
function fakeContext(): { ctx: Context, listeners: Map<string, Listener>, warnings: string[] } {
  const listeners = new Map<string, Listener>()
  const warnings: string[] = []
  const ctx = {
    on(name: string, listener: Listener) { listeners.set(name, listener); return () => {} },
    logger: { warn(line: string) { warnings.push(line) } },
  } as unknown as Context
  return { ctx, listeners, warnings }
}

describe('observing DeepSeek Harness sessions', () => {
  it('announces a created session and retires a disposed one, by agent id', () => {
    const { ctx, listeners } = fakeContext()
    const events: string[] = []
    observeSessions(ctx, {
      onStart: (session) => { events.push(`start ${session.sessionId} ${session.title}`) },
      onEnd: (sessionId) => { events.push(`end ${sessionId}`) },
    })
    assert.equal(listeners.get('agent/created')?.({ agent: { id: 'session-1' } }), undefined, 'the serial listener has nothing to be awaited')
    listeners.get('agent/disposed')?.({ agent: { id: 'session-1' } })
    assert.deepEqual(events, ['start session-1 session-1', 'end session-1'])
  })

  it('ignores an agent whose id cannot be a routing key', () => {
    const { ctx, listeners } = fakeContext()
    const events: string[] = []
    observeSessions(ctx, { onStart: (session) => { events.push(session.sessionId) }, onEnd: (id) => { events.push(id) } })
    for (const id of ['', 'has space', 'a/b', 'x'.repeat(161)]) {
      listeners.get('agent/created')?.({ agent: { id } })
      listeners.get('agent/disposed')?.({ agent: { id } })
    }
    assert.deepEqual(events, [])
  })

  it('never lets an observer failure reach DeepSeek Harness, where it would roll the session back', () => {
    const { ctx, listeners, warnings } = fakeContext()
    observeSessions(ctx, {
      onStart: () => { throw new Error('broker socket in a bad state') },
      onEnd: () => { throw new Error('retire failed') },
    })
    assert.doesNotThrow(() => listeners.get('agent/created')?.({ agent: { id: 'session-2' } }))
    assert.equal(listeners.get('agent/created')?.({ agent: { id: 'session-2' } }), undefined)
    assert.doesNotThrow(() => listeners.get('agent/disposed')?.({ agent: { id: 'session-2' } }))
    assert.equal(warnings.length, 3)
    assert.match(warnings[0] ?? '', /announcing a new session failed and was ignored: broker socket in a bad state/)
    assert.match(warnings[2] ?? '', /retiring an ended session failed and was ignored: retire failed/)
  })
})

describe('resolving the session a tool call belongs to', () => {
  it('fails closed without an agent, and says so', () => {
    const resolution = resolveSession({})
    assert.equal(resolution.ok, false)
    assert.ok(!resolution.ok && resolution.failure.kind === 'no-agent')
    assert.match(sessionFailureMessage({ kind: 'no-agent' }), /No browser action was performed/)
  })

  it('refuses an agent id that is not a routing key', () => {
    const resolution = resolveSession({ agent: { id: 'a b' } } as never)
    assert.ok(!resolution.ok && resolution.failure.kind === 'unusable-id')
  })

  it('routes by the exact agent id', () => {
    assert.deepEqual(resolveSession({ agent: { id: 'session-3' } } as never), { ok: true, sessionId: 'session-3' })
  })
})
