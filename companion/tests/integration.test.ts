/**
 * Integration tests over real loopback WebSockets.
 *
 * `broker.test.ts` proves the routing rules against fake sockets. This file proves the same route
 * survives the real transport: the handshake, frame parsing, size caps, and the `AgentClient` a
 * DeepSeek Harness plugin actually uses.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import WebSocket from 'ws'
import { AgentClient, BrowserActionError } from '../src/agent-client.ts'
import { createSecret, roleProof, brokerProof, proofsMatch } from '../src/auth.ts'
import { startBroker, requireLoopback, type RunningBroker } from '../src/broker-server.ts'
import type { StateStore } from '../src/broker.ts'
import { ACTION, CLIENT, ERROR, PROTOCOL_VERSION, ROLE, SERVER } from '../src/protocol.ts'

const VERSION = '0.1.0'
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const PROFILE = 'web.0123456789ab'

const secret = createSecret()
let running: RunningBroker
let port: number

/** State kept only for this test run. */
function store(): StateStore {
  let held = { scopeOwners: {} as Record<string, string> }
  return { load: () => held, save: (state) => { held = { scopeOwners: { ...state.scopeOwners } } } }
}

before(async () => {
  // Port 0 asks the OS for a free port, so the suite never collides with a real broker.
  running = await startBroker({ secret, version: VERSION, port: 0, store: store() })
  port = running.port
})

after(async () => { await running.close() })

/** A paired browser client driven directly, so tests control exactly what it answers. */
class TestBrowser {
  readonly socket: WebSocket
  readonly actions: Record<string, unknown>[] = []
  #answer: (action: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true, data: {} })

  /**
   * @param socket - an open, already paired connection.
   */
  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      if (frame['type'] !== SERVER.ACTION) return
      this.actions.push(frame)
      const reply = this.#answer(frame)
      socket.send(JSON.stringify({ type: CLIENT.ACTION_RESULT, id: frame['id'], ...reply }))
    })
  }

  /**
   * @param answer - what to reply to each dispatched action.
   */
  answerWith(answer: (action: Record<string, unknown>) => Record<string, unknown>): void {
    this.#answer = answer
  }

  /**
   * @param frame - a frame to send to the broker.
   */
  send(frame: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(frame))
  }

  /**
   * Attach tabs to one scope and wait for the broker to have applied it.
   * @param sessionId - the session.
   * @param tabIds - the tabs; the last becomes active.
   */
  async attach(sessionId: string, tabIds: number[]): Promise<void> {
    this.send({
      type: CLIENT.BINDING_UPDATE,
      profileId: PROFILE,
      sessionId,
      tabIds,
      activeTabId: tabIds[tabIds.length - 1],
    })
    await settle()
  }

  close(): void {
    this.socket.close()
  }
}

/** Let queued frames reach the broker and back. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30))
}

/**
 * Open and authenticate one browser client over the real transport.
 * @param browserId - the extension installation id.
 * @returns the paired test browser.
 */
async function pairBrowser(browserId: string): Promise<TestBrowser> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: EXTENSION_ORIGIN })

  // The listener is attached before the socket opens on purpose. The broker sends its challenge the
  // moment it accepts a connection, so `ws` can emit `open` and that first `message` in one tick; a
  // listener attached after awaiting `open` misses the challenge and the handshake never completes.
  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject)
    socket.on('message', function handshake(raw: Buffer) {
      const frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
      if (frame['type'] === SERVER.CHALLENGE) {
        socket.send(JSON.stringify({
          type: CLIENT.HELLO,
          role: ROLE.BROWSER,
          id: browserId,
          name: 'Chrome',
          nonce: 'browser-nonce-0123456789abcd',
          proof: roleProof(secret, ROLE.BROWSER, browserId, String(frame['nonce'])),
          protocolVersion: PROTOCOL_VERSION,
          connectorVersion: VERSION,
          capabilities: Object.values(ACTION),
        }))
        return
      }
      if (frame['type'] === SERVER.PAIRED) {
        socket.off('message', handshake)
        const expected = brokerProof(secret, ROLE.BROWSER, browserId, 'browser-nonce-0123456789abcd')
        if (!proofsMatch(String(frame['proof']), expected)) { reject(new Error('broker proof mismatch')); return }
        resolve()
        return
      }
      if (frame['type'] === SERVER.DENIED) reject(new Error(String(frame['message'])))
    })
  })
  return new TestBrowser(socket)
}

/**
 * Start one agent client and wait until it is paired.
 * @param sessions - sessions to announce.
 * @returns the connected client.
 */
async function startAgent(sessions: string[]): Promise<AgentClient> {
  const client = new AgentClient({
    url: `ws://127.0.0.1:${port}`,
    secret,
    version: VERSION,
    profileId: PROFILE,
    name: 'DeepSeek Harness (web)',
  })
  client.start()
  for (let attempt = 0; attempt < 60 && !client.connected; attempt += 1) await settle()
  assert.equal(client.connected, true, 'the agent client must pair with the broker')
  for (const sessionId of sessions) client.addSession(sessionId, `Session ${sessionId}`)
  await settle()
  return client
}

describe('loopback binding', () => {
  it('refuses every non-loopback bind address', () => {
    assert.equal(requireLoopback('127.0.0.1'), '127.0.0.1')
    assert.equal(requireLoopback('localhost'), 'localhost')
    assert.equal(requireLoopback('::1'), '::1')
    assert.throws(() => requireLoopback('0.0.0.0'), /loopback/)
    assert.throws(() => requireLoopback('192.168.1.10'), /loopback/)
    assert.throws(() => requireLoopback(''), /loopback/)
  })
})

describe('the full route over real sockets', () => {
  it('carries a snapshot from a session to its own tab and back', async () => {
    const browser = await pairBrowser('browser-live-1')
    await browser.attach('session-live-a', [101])
    const agent = await startAgent(['session-live-a'])
    browser.answerWith((action) => ({
      ok: true,
      data: { url: 'https://example.test/', title: 'Example', text: 'hello', targetTabId: action['targetTabId'] },
    }))

    const result = await agent.request('session-live-a', ACTION.SNAPSHOT, {}) as Record<string, unknown>

    assert.equal(result['title'], 'Example')
    assert.equal(result['targetTabId'], 101)
    assert.equal(browser.actions.length, 1)
    agent.dispose()
    browser.close()
  })

  it('fails a session with no attached tab and contacts no browser', async () => {
    const browser = await pairBrowser('browser-live-2')
    await browser.attach('session-live-b', [102])
    const agent = await startAgent(['session-live-b', 'session-live-unbound'])

    await assert.rejects(
      agent.request('session-live-unbound', ACTION.SNAPSHOT, {}),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.NO_BINDING,
    )
    assert.equal(browser.actions.length, 0, 'no browser may be contacted for an unbound session')
    agent.dispose()
    browser.close()
  })

  it('keeps two sessions apart under interleaved requests', async () => {
    const browser = await pairBrowser('browser-live-3')
    await browser.attach('session-x', [201])
    await browser.attach('session-y', [202])
    const agent = await startAgent(['session-x', 'session-y'])
    browser.answerWith((action) => ({ ok: true, data: { tab: action['targetTabId'] } }))

    const results = await Promise.all([
      agent.request('session-x', ACTION.SNAPSHOT, {}),
      agent.request('session-y', ACTION.SNAPSHOT, {}),
      agent.request('session-x', ACTION.CURRENT_URL, {}),
      agent.request('session-y', ACTION.CURRENT_URL, {}),
    ]) as Record<string, unknown>[]

    assert.deepEqual(results.map((entry) => entry['tab']), [201, 202, 201, 202])
    agent.dispose()
    browser.close()
  })

  it('reports a browser-side failure with its typed code', async () => {
    const browser = await pairBrowser('browser-live-4')
    await browser.attach('session-fail', [301])
    const agent = await startAgent(['session-fail'])
    browser.answerWith(() => ({ ok: false, error: { code: ERROR.STALE_REF, message: 'ref e7 is gone' } }))

    await assert.rejects(
      agent.request('session-fail', ACTION.CLICK, { ref: 'e7' }),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.STALE_REF,
    )
    agent.dispose()
    browser.close()
  })

  it('fails in flight requests when the browser disconnects', async () => {
    const browser = await pairBrowser('browser-live-5')
    await browser.attach('session-drop', [401])
    const agent = await startAgent(['session-drop'])
    browser.answerWith(() => ({ ok: true, data: {} }))
    // Answer nothing, then drop the connection while the request is outstanding.
    browser.socket.removeAllListeners('message')

    const pending = agent.request('session-drop', ACTION.SNAPSHOT, {})
    await settle()
    browser.socket.terminate()

    // The request had been dispatched, so the honest answer is "outcome unknown", never "refused".
    await assert.rejects(pending, (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.INTERRUPTED)
    agent.dispose()
  })
})

describe('hostile connections', () => {
  it('refuses a web page origin claiming the browser role', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://evil.test' })
    // Listeners are attached below before any frame can arrive; see pairBrowser.
    const denied = await new Promise<Record<string, unknown>>((resolve) => {
      socket.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
        if (frame['type'] === SERVER.CHALLENGE) {
          socket.send(JSON.stringify({
            type: CLIENT.HELLO,
            role: ROLE.BROWSER,
            id: 'browser-evil',
            nonce: 'nonce-0123456789abcdef',
            proof: roleProof(secret, ROLE.BROWSER, 'browser-evil', String(frame['nonce'])),
            protocolVersion: PROTOCOL_VERSION,
          }))
          return
        }
        if (frame['type'] === SERVER.DENIED) resolve(frame)
      })
    })
    assert.equal(denied['code'], ERROR.UNAUTHENTICATED)
    socket.close()
  })

  it('refuses a client that does not know the secret', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    // Listeners are attached below before any frame can arrive; see pairBrowser.
    const denied = await new Promise<Record<string, unknown>>((resolve) => {
      socket.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
        if (frame['type'] === SERVER.CHALLENGE) {
          socket.send(JSON.stringify({
            type: CLIENT.HELLO,
            role: ROLE.AGENT,
            id: 'agent-guess',
            profileId: PROFILE,
            nonce: 'nonce-0123456789abcdef',
            proof: roleProof('the wrong secret', ROLE.AGENT, 'agent-guess', String(frame['nonce'])),
            protocolVersion: PROTOCOL_VERSION,
          }))
          return
        }
        if (frame['type'] === SERVER.DENIED) resolve(frame)
      })
    })
    assert.equal(denied['code'], ERROR.UNAUTHENTICATED)
    socket.close()
  })

  it('refuses an unparseable frame without disturbing other clients', async () => {
    const good = await pairBrowser('browser-live-6')
    await good.attach('session-ok', [501])

    const rogue = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise((resolve, reject) => { rogue.once('open', resolve); rogue.once('error', reject) })
    rogue.send('this is not json')
    await settle()

    const agent = await startAgent(['session-ok'])
    good.answerWith(() => ({ ok: true, data: { fine: true } }))
    const result = await agent.request('session-ok', ACTION.SNAPSHOT, {}) as Record<string, unknown>
    assert.equal(result['fine'], true)

    agent.dispose()
    good.close()
    rogue.close()
  })

  it('answers a plain HTTP request with 426 rather than anything probeable', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(response.status, 426)
    assert.match(await response.text(), /WebSocket/)
  })
})
