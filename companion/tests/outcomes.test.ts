/**
 * What a caller is told when an action's outcome is not known.
 *
 * An external review of 2026-09-05 showed the connector reporting a cancelled call as `TIMEOUT`
 * with wording that read as "nothing happened", whichever side of the dispatch the cancellation
 * fell. That distinction is the whole point: a call abandoned before its frame left is the only one
 * that can honestly be called cancelled, and everything after it may already have changed the page.
 * These cases run over real loopback sockets, because the moment the frame leaves is exactly what
 * is being tested.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { AgentClient, type BrowserActionError } from '../src/agent-client.ts'
import { createSecret } from '../src/auth.ts'
import { startBroker, type RunningBroker } from '../src/broker-server.ts'
import type { StateStore } from '../src/broker.ts'
import { ACTION, ERROR } from '../src/protocol.ts'

const VERSION = '0.1.0'
const PROFILE = 'web.0123456789ab'
const SESSION = 'session-outcome'

const secret = createSecret()
let running: RunningBroker
let client: AgentClient

/** State kept only for this test run. */
function store(): StateStore {
  let held = { scopeOwners: {} as Record<string, string> }
  return { load: () => held, save: (state) => { held = { scopeOwners: { ...state.scopeOwners } } } }
}

/** Give the event loop a turn. */
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10) })

/**
 * @param cause - a rejection from `request`.
 * @returns its typed error code.
 */
const codeOf = (cause: unknown): string => (cause as BrowserActionError).code

before(async () => {
  running = await startBroker({ secret, version: VERSION, port: 0, store: store() })
  client = new AgentClient({
    url: `ws://127.0.0.1:${running.port}`,
    secret,
    version: VERSION,
    profileId: PROFILE,
    name: 'DeepSeek Harness (test)',
  })
  client.start()
  for (let attempt = 0; attempt < 60 && !client.connected; attempt += 1) await settle()
  assert.equal(client.connected, true, 'the agent client must pair with the broker')
  client.addSession(SESSION, 'Session')
  await settle()
})

after(async () => {
  client.dispose()
  await running.close()
})

describe('an outcome that is not known is never reported as one that is', () => {
  it('calls a cancellation before dispatch cancelled, because nothing was sent', async () => {
    const controller = new AbortController()
    controller.abort()

    await assert.rejects(
      client.request(SESSION, ACTION.SNAPSHOT, {}, controller.signal),
      (cause: unknown) => {
        assert.equal(codeOf(cause), ERROR.CANCELLED)
        assert.match((cause as Error).message, /before anything was sent/i)
        return true
      },
    )
  })

  it('calls a cancellation after dispatch an unknown outcome, because the page may already have acted', async () => {
    const controller = new AbortController()
    // `request` writes its frame synchronously, so by the time it returns the browser side may
    // already be acting. Aborting here is the exact race the review found reported as "cancelled".
    const pending = client.request(SESSION, ACTION.CLICK, { ref: 'e1@1' }, controller.signal)
    controller.abort()

    await assert.rejects(pending, (cause: unknown) => {
      assert.equal(codeOf(cause), ERROR.INTERRUPTED)
      assert.match((cause as Error).message, /may have performed it/i)
      return true
    })
  })

  it('keeps the two codes distinct, so a caller can tell them apart without reading prose', () => {
    assert.notEqual(ERROR.CANCELLED, ERROR.INTERRUPTED)
    assert.equal(ERROR.CANCELLED, 'CANCELLED')
  })
})
