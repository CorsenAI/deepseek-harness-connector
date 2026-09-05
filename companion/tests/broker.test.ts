/**
 * Routing and authorization tests for the broker.
 *
 * These are the release-blocking cases from `docs/TEST-MATRIX.md` at the unit level: a wrong-tab or
 * cross-session result here is a security failure. Sockets are fakes so every ordering below is
 * exact rather than timing-dependent.
 * @module
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { brokerProof, createSecret, roleProof } from '../src/auth.ts'
import { Broker, type PeerSocket, type StateStore } from '../src/broker.ts'
import { ACTION, CLIENT, ERROR, LIMITS, PROTOCOL_VERSION, ROLE, SERVER } from '../src/protocol.ts'

const VERSION = '0.1.0'
const EXTENSION_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

/** A fake socket that records every frame the broker sent it. */
class FakeSocket implements PeerSocket {
  readonly sent: Record<string, unknown>[] = []
  readonly origin: string | undefined
  closed?: { code: number, reason: string }

  /**
   * @param origin - the connection's Origin header, or `undefined` for a non-browser client.
   */
  constructor(origin: string | undefined) {
    this.origin = origin
  }

  send(frame: Record<string, unknown>): void {
    this.sent.push(frame)
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason }
  }

  /**
   * @param type - the frame type to look for.
   * @returns the last frame of that type, or `undefined`.
   */
  last(type: string): Record<string, unknown> | undefined {
    return [...this.sent].reverse().find((frame) => frame['type'] === type)
  }

  /**
   * @param type - the frame type to count.
   * @returns how many frames of that type were sent.
   */
  count(type: string): number {
    return this.sent.filter((frame) => frame['type'] === type).length
  }
}

/** An in-memory state store, isolated per test. */
function store(): StateStore {
  let held = { scopeOwners: {} as Record<string, string> }
  return { load: () => held, save: (state) => { held = { scopeOwners: { ...state.scopeOwners } } } }
}

const secret = createSecret()
let broker: Broker

beforeEach(() => {
  broker = new Broker({ secret, version: VERSION, store: store(), actionTimeoutMs: 50 })
})

/**
 * Connect and authenticate one client.
 * @param role - the role to claim.
 * @param id - the client id.
 * @param extras - additional hello fields.
 * @param origin - an explicit Origin, defaulting to the role's correct one.
 * @returns the fake socket, already paired.
 */
function connect(
  role: typeof ROLE[keyof typeof ROLE],
  id: string,
  extras: Record<string, unknown> = {},
  origin?: string | undefined,
): FakeSocket {
  const socket = new FakeSocket(origin === undefined && role === ROLE.BROWSER ? EXTENSION_ORIGIN : origin)
  broker.open(socket)
  const challenge = socket.last(SERVER.CHALLENGE)
  assert.ok(challenge, 'broker must challenge on connect')
  broker.handle(socket, CLIENT.HELLO, {
    type: CLIENT.HELLO,
    role,
    id,
    nonce: 'client-nonce-0123456789abcdef',
    proof: roleProof(secret, role, id, String(challenge['nonce'])),
    protocolVersion: PROTOCOL_VERSION,
    connectorVersion: VERSION,
    ...extras,
  })
  return socket
}

/**
 * Connect a browser and attach one tab to one scope.
 * @param browserId - the extension installation id.
 * @param scope - profile and session.
 * @param tabIds - tabs to attach; the last becomes active.
 * @returns the paired browser socket.
 */
function browserWith(browserId: string, scope: { profileId: string, sessionId: string }, tabIds: number[]): FakeSocket {
  const socket = connect(ROLE.BROWSER, browserId, { name: 'Chrome', capabilities: Object.values(ACTION) })
  broker.handle(socket, CLIENT.BINDING_UPDATE, {
    type: CLIENT.BINDING_UPDATE,
    ...scope,
    tabIds,
    activeTabId: tabIds[tabIds.length - 1],
  })
  return socket
}

/**
 * Connect one agent for a profile.
 * @param agentId - the plugin instance id.
 * @param profileId - the DSH profile.
 * @param sessionIds - sessions to announce.
 * @returns the paired agent socket.
 */
function agentWith(agentId: string, profileId: string, sessionIds: string[]): FakeSocket {
  const socket = connect(ROLE.AGENT, agentId, { profileId })
  broker.handle(socket, CLIENT.SESSION_ANNOUNCE, {
    type: CLIENT.SESSION_ANNOUNCE,
    sessions: sessionIds.map((sessionId) => ({ sessionId, title: `Session ${sessionId}` })),
  })
  return socket
}

/**
 * Ask for one action.
 * @param agent - the agent socket.
 * @param requestId - the agent's request id.
 * @param scope - profile and session.
 * @param kind - the action kind.
 * @param args - action arguments.
 */
function request(
  agent: FakeSocket,
  requestId: string,
  scope: { profileId: string, sessionId: string },
  kind: string = ACTION.SNAPSHOT,
  args: Record<string, unknown> = {},
): void {
  broker.handle(agent, CLIENT.ACTION_REQUEST, {
    type: CLIENT.ACTION_REQUEST,
    id: requestId,
    ...scope,
    action: { kind, args },
  })
}

/**
 * @param socket - the socket to read.
 * @param requestId - the agent request id to find.
 * @returns that request's response frame.
 */
function responseFor(socket: FakeSocket, requestId: string): Record<string, unknown> {
  const frame = [...socket.sent].reverse().find((entry) => (
    entry['type'] === SERVER.ACTION_RESPONSE && entry['id'] === requestId
  ))
  assert.ok(frame, `no response for ${requestId}`)
  return frame
}

/**
 * @param frame - a response frame.
 * @returns its typed error code.
 */
function errorCode(frame: Record<string, unknown>): string {
  return String((frame['error'] as Record<string, unknown> | undefined)?.['code'])
}

/**
 * @param frame - a response frame.
 * @returns the failure message the caller would read.
 */
function errorMessage(frame: Record<string, unknown>): string {
  return String((frame['error'] as Record<string, unknown> | undefined)?.['message'] ?? '')
}

const WEB_A = { profileId: 'web', sessionId: 'session-a' }
const WEB_B = { profileId: 'web', sessionId: 'session-b' }

describe('handshake', () => {
  it('challenges before accepting anything', () => {
    const socket = new FakeSocket(EXTENSION_ORIGIN)
    broker.open(socket)
    const challenge = socket.last(SERVER.CHALLENGE)
    assert.equal(challenge?.['protocolVersion'], PROTOCOL_VERSION)
    assert.equal(challenge?.['brokerVersion'], VERSION)
    assert.match(String(challenge?.['nonce']), /^[0-9a-f]{32}$/)
  })

  it('proves the broker back to the client', () => {
    const socket = connect(ROLE.AGENT, 'agent-1', { profileId: 'web' })
    const paired = socket.last(SERVER.PAIRED)
    assert.equal(
      paired?.['proof'],
      brokerProof(secret, ROLE.AGENT, 'agent-1', 'client-nonce-0123456789abcdef'),
    )
  })

  it('refuses a frame sent before authenticating and closes the connection', () => {
    const socket = new FakeSocket(EXTENSION_ORIGIN)
    broker.open(socket)
    broker.handle(socket, CLIENT.BINDING_UPDATE, { type: CLIENT.BINDING_UPDATE, ...WEB_A, tabIds: [1], activeTabId: 1 })
    assert.equal(errorCodeOf(socket), ERROR.UNAUTHENTICATED)
    assert.ok(socket.closed)
  })

  it('refuses a browser role from a web page origin', () => {
    const socket = new FakeSocket('https://evil.example')
    broker.open(socket)
    const challenge = socket.last(SERVER.CHALLENGE)
    broker.handle(socket, CLIENT.HELLO, {
      type: CLIENT.HELLO,
      role: ROLE.BROWSER,
      id: 'browser-1',
      nonce: 'client-nonce-0123456789abcdef',
      proof: roleProof(secret, ROLE.BROWSER, 'browser-1', String(challenge?.['nonce'])),
      protocolVersion: PROTOCOL_VERSION,
    })
    assert.equal(errorCodeOf(socket), ERROR.UNAUTHENTICATED)
    assert.ok(socket.closed)
  })

  it('refuses an agent role from any origin, so a page cannot drive the browser', () => {
    const socket = new FakeSocket('https://evil.example')
    broker.open(socket)
    const challenge = socket.last(SERVER.CHALLENGE)
    broker.handle(socket, CLIENT.HELLO, {
      type: CLIENT.HELLO,
      role: ROLE.AGENT,
      id: 'agent-1',
      profileId: 'web',
      nonce: 'client-nonce-0123456789abcdef',
      proof: roleProof(secret, ROLE.AGENT, 'agent-1', String(challenge?.['nonce'])),
      protocolVersion: PROTOCOL_VERSION,
    })
    assert.equal(errorCodeOf(socket), ERROR.UNAUTHENTICATED)
  })

  it('refuses a browser proof replayed as an agent', () => {
    const socket = new FakeSocket(undefined)
    broker.open(socket)
    const challenge = socket.last(SERVER.CHALLENGE)
    broker.handle(socket, CLIENT.HELLO, {
      type: CLIENT.HELLO,
      role: ROLE.AGENT,
      id: 'client-1',
      profileId: 'web',
      nonce: 'client-nonce-0123456789abcdef',
      proof: roleProof(secret, ROLE.BROWSER, 'client-1', String(challenge?.['nonce'])),
      protocolVersion: PROTOCOL_VERSION,
    })
    assert.equal(errorCodeOf(socket), ERROR.UNAUTHENTICATED)
  })

  it('refuses a proof minted against another connection challenge', () => {
    const first = new FakeSocket(undefined)
    broker.open(first)
    const stolen = String(first.last(SERVER.CHALLENGE)?.['nonce'])

    const second = new FakeSocket(undefined)
    broker.open(second)
    broker.handle(second, CLIENT.HELLO, {
      type: CLIENT.HELLO,
      role: ROLE.AGENT,
      id: 'agent-1',
      profileId: 'web',
      nonce: 'client-nonce-0123456789abcdef',
      proof: roleProof(secret, ROLE.AGENT, 'agent-1', stolen),
      protocolVersion: PROTOCOL_VERSION,
    })
    assert.equal(errorCodeOf(second), ERROR.UNAUTHENTICATED)
  })

  it('refuses a mismatched protocol and names which side is older', () => {
    const socket = new FakeSocket(undefined)
    broker.open(socket)
    broker.handle(socket, CLIENT.HELLO, {
      type: CLIENT.HELLO,
      role: ROLE.AGENT,
      id: 'agent-1',
      profileId: 'web',
      nonce: 'client-nonce-0123456789abcdef',
      proof: 'irrelevant',
      protocolVersion: PROTOCOL_VERSION - 1,
    })
    const denied = socket.last(SERVER.DENIED)
    assert.equal(denied?.['code'], ERROR.PROTOCOL_VERSION)
    assert.match(String(denied?.['message']), /client is older/)
    assert.ok(socket.closed)
  })

  it('checks the protocol before the proof, so a stale peer learns the real reason', () => {
    const socket = new FakeSocket(undefined)
    broker.open(socket)
    broker.handle(socket, CLIENT.HELLO, {
      type: CLIENT.HELLO,
      role: ROLE.AGENT,
      id: 'agent-1',
      profileId: 'web',
      nonce: 'client-nonce-0123456789abcdef',
      proof: 'wrong',
      protocolVersion: PROTOCOL_VERSION + 1,
    })
    const denied = socket.last(SERVER.DENIED)
    assert.equal(denied?.['code'], ERROR.PROTOCOL_VERSION)
    assert.match(String(denied?.['message']), /broker is older/)
  })
})

describe('fail closed', () => {
  it('refuses an action for a session with no attached tab, contacting no browser', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a', 'session-b'])
    const before = browser.count(SERVER.ACTION)

    request(agent, 'req-1', WEB_B)

    assert.equal(errorCode(responseFor(agent, 'req-1')), ERROR.NO_BINDING)
    assert.equal(browser.count(SERVER.ACTION), before, 'no browser may be contacted')
  })

  it('refuses an action when the owning browser is not connected', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    broker.close(browser)

    request(agent, 'req-1', WEB_A)
    assert.equal(errorCode(responseFor(agent, 'req-1')), ERROR.NO_BROWSER)
  })

  it('refuses an action for another profile even with a valid session id', () => {
    browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'headless', ['session-a'])

    request(agent, 'req-1', WEB_A)
    assert.equal(errorCode(responseFor(agent, 'req-1')), ERROR.UNAUTHENTICATED)
  })

  it('refuses an action the extension does not implement', () => {
    const socket = connect(ROLE.BROWSER, 'browser-1', { capabilities: [ACTION.SNAPSHOT] })
    broker.handle(socket, CLIENT.BINDING_UPDATE, { type: CLIENT.BINDING_UPDATE, ...WEB_A, tabIds: [11], activeTabId: 11 })
    const agent = agentWith('agent-1', 'web', ['session-a'])

    request(agent, 'req-1', WEB_A, ACTION.DRAG)
    assert.equal(errorCode(responseFor(agent, 'req-1')), ERROR.UNSUPPORTED_ACTION)
  })
})

describe('exact routing', () => {
  it('sends each session action only to its own tab', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    broker.handle(browser, CLIENT.BINDING_UPDATE, { type: CLIENT.BINDING_UPDATE, ...WEB_B, tabIds: [22], activeTabId: 22 })
    const agent = agentWith('agent-1', 'web', ['session-a', 'session-b'])

    request(agent, 'req-a', WEB_A)
    request(agent, 'req-b', WEB_B)

    const dispatched = browser.sent.filter((frame) => frame['type'] === SERVER.ACTION)
    assert.equal(dispatched.length, 2)
    const forA = dispatched.find((frame) => (frame['scope'] as Record<string, unknown>)['sessionId'] === 'session-a')
    const forB = dispatched.find((frame) => (frame['scope'] as Record<string, unknown>)['sessionId'] === 'session-b')
    assert.equal(forA?.['targetTabId'], 11)
    assert.equal(forB?.['targetTabId'], 22)
  })

  it('returns each result to the session that asked, under interleaving', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    broker.handle(browser, CLIENT.BINDING_UPDATE, { type: CLIENT.BINDING_UPDATE, ...WEB_B, tabIds: [22], activeTabId: 22 })
    const agentA = agentWith('agent-1', 'web', ['session-a'])
    const agentB = agentWith('agent-2', 'web', ['session-b'])

    request(agentA, 'req-a', WEB_A)
    request(agentB, 'req-b', WEB_B)

    const dispatched = browser.sent.filter((frame) => frame['type'] === SERVER.ACTION)
    // Answer in reverse order: the route must follow the request, not arrival order.
    for (const frame of [...dispatched].reverse()) {
      broker.handle(browser, CLIENT.ACTION_RESULT, {
        type: CLIENT.ACTION_RESULT,
        id: frame['id'],
        ok: true,
        data: { tab: frame['targetTabId'] },
      })
    }

    assert.deepEqual(responseFor(agentA, 'req-a')['data'], { tab: 11 })
    assert.deepEqual(responseFor(agentB, 'req-b')['data'], { tab: 22 })
    assert.equal(agentA.sent.some((frame) => frame['id'] === 'req-b'), false)
    assert.equal(agentB.sent.some((frame) => frame['id'] === 'req-a'), false)
  })

  it('targets the scope active tab, not the first attached one', () => {
    const browser = browserWith('browser-1', WEB_A, [11, 12, 13])
    const agent = agentWith('agent-1', 'web', ['session-a'])

    request(agent, 'req-1', WEB_A)
    assert.equal(browser.last(SERVER.ACTION)?.['targetTabId'], 13)
  })
})

describe('post-action revalidation', () => {
  it('drops a result whose tab moved to another session while it ran', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a', 'session-b'])
    request(agent, 'req-1', WEB_A)
    const dispatched = browser.last(SERVER.ACTION)
    assert.ok(dispatched)

    // The user re-attaches tab 11 to session B before the page answered.
    broker.handle(browser, CLIENT.BINDING_UPDATE, { type: CLIENT.BINDING_UPDATE, ...WEB_B, tabIds: [11], activeTabId: 11 })
    broker.handle(browser, CLIENT.ACTION_RESULT, {
      type: CLIENT.ACTION_RESULT,
      id: dispatched['id'],
      ok: true,
      data: { secret: 'session B page content' },
    })

    const response = responseFor(agent, 'req-1')
    assert.equal(response['ok'], false)
    assert.equal(errorCode(response), ERROR.BINDING_CHANGED)
    assert.equal(JSON.stringify(agent.sent).includes('session B page content'), false)
  })

  it('drops a result whose scope moved to another browser while it ran', () => {
    const first = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A)
    const dispatched = first.last(SERVER.ACTION)

    browserWith('browser-2', WEB_A, [77])
    broker.handle(first, CLIENT.ACTION_RESULT, {
      type: CLIENT.ACTION_RESULT,
      id: dispatched?.['id'],
      ok: true,
      data: { page: 'stale' },
    })

    assert.equal(errorCode(responseFor(agent, 'req-1')), ERROR.BINDING_CHANGED)
  })

  it('drops a result whose target is no longer the scope active tab', () => {
    const browser = browserWith('browser-1', WEB_A, [11, 12])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A)
    const dispatched = browser.last(SERVER.ACTION)
    assert.equal(dispatched?.['targetTabId'], 12)

    broker.handle(browser, CLIENT.BINDING_UPDATE, {
      type: CLIENT.BINDING_UPDATE, ...WEB_A, tabIds: [11, 12], activeTabId: 11,
    })
    broker.handle(browser, CLIENT.ACTION_RESULT, {
      type: CLIENT.ACTION_RESULT, id: dispatched?.['id'], ok: true, data: { page: 'from tab 12' },
    })

    assert.equal(errorCode(responseFor(agent, 'req-1')), ERROR.BINDING_CHANGED)
  })

  it('ignores a result from a browser that never held the request', () => {
    const owner = browserWith('browser-1', WEB_A, [11])
    const other = connect(ROLE.BROWSER, 'browser-2', { capabilities: Object.values(ACTION) })
    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A)
    const dispatched = owner.last(SERVER.ACTION)

    broker.handle(other, CLIENT.ACTION_RESULT, {
      type: CLIENT.ACTION_RESULT, id: dispatched?.['id'], ok: true, data: { forged: true },
    })

    assert.equal(
      agent.sent.some((frame) => frame['type'] === SERVER.ACTION_RESPONSE && frame['id'] === 'req-1'),
      false,
      'a forged result must not settle the request',
    )
  })

  it('ignores a duplicate result for an already settled request', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A)
    const dispatched = browser.last(SERVER.ACTION)
    const result = { type: CLIENT.ACTION_RESULT, id: dispatched?.['id'], ok: true, data: { n: 1 } }

    broker.handle(browser, CLIENT.ACTION_RESULT, result)
    broker.handle(browser, CLIENT.ACTION_RESULT, result)

    const responses = agent.sent.filter((frame) => (
      frame['type'] === SERVER.ACTION_RESPONSE && frame['id'] === 'req-1'
    ))
    assert.equal(responses.length, 1, 'a replayed result must not answer twice')
  })

  it('lets a close_tab that removed the scope last tab report its own outcome', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A, ACTION.CLOSE_TAB)
    const dispatched = browser.last(SERVER.ACTION)

    broker.handle(browser, CLIENT.BINDING_REMOVE, { type: CLIENT.BINDING_REMOVE, ...WEB_A })
    broker.handle(browser, CLIENT.ACTION_RESULT, {
      type: CLIENT.ACTION_RESULT, id: dispatched?.['id'], ok: true, data: { closed: 11 },
    })

    const response = responseFor(agent, 'req-1')
    assert.equal(response['ok'], true)
    assert.deepEqual(response['data'], { closed: 11 })
  })

  it('reports an unknown outcome, not a refusal, when the browser disconnects mid-action', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A)

    broker.close(browser)
    // The action had reached the browser; NO_BROWSER would falsely claim nothing was performed.
    const response = responseFor(agent, 'req-1')
    assert.equal(errorCode(response), ERROR.INTERRUPTED)
    assert.match(String((response['error'] as Record<string, unknown>)['message']), /may have performed it/)
  })

  it('refuses before dispatch, with NO_BROWSER, when the owning browser is already gone', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    broker.close(browser)

    request(agent, 'req-1', WEB_A)
    assert.equal(errorCode(responseFor(agent, 'req-1')), ERROR.NO_BROWSER, 'nothing was dispatched, so nothing may have run')
  })

  it('fails the request when the browser never answers', async () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A)
    assert.ok(browser.last(SERVER.ACTION))

    await new Promise((resolve) => setTimeout(resolve, 80))
    const answer = responseFor(agent, 'req-1')
    assert.equal(errorCode(answer), ERROR.TIMEOUT)
    // The timer is armed only after the action has gone to the browser, so a timeout is an unknown
    // outcome. Wording that reads as "nothing happened" invites a caller to retry a submission.
    assert.match(errorMessage(answer), /may have performed the action/i)
  })
})

describe('ownership transfer', () => {
  it('revokes the previous browser before the new one becomes authoritative', () => {
    const first = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    const second = browserWith('browser-2', WEB_A, [77])

    const revoked = first.last(SERVER.BINDING_REVOKED)
    assert.equal(revoked?.['sessionId'], 'session-a')

    request(agent, 'req-1', WEB_A)
    assert.equal(second.last(SERVER.ACTION)?.['targetTabId'], 77)
    assert.equal(first.count(SERVER.ACTION), 0, 'the old browser receives no action after the transfer')
  })

  it('takes a tab from another session in the same browser when the user reattaches it', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a', 'session-b'])

    broker.handle(browser, CLIENT.BINDING_UPDATE, {
      type: CLIENT.BINDING_UPDATE, ...WEB_B, tabIds: [11], activeTabId: 11,
    })

    request(agent, 'req-a', WEB_A)
    assert.equal(errorCode(responseFor(agent, 'req-a')), ERROR.NO_BINDING)

    request(agent, 'req-b', WEB_B)
    assert.equal(browser.last(SERVER.ACTION)?.['targetTabId'], 11)
  })

  it('refuses a sync that claims one tab under two sessions', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    broker.handle(browser, CLIENT.BINDING_SYNC, {
      type: CLIENT.BINDING_SYNC,
      bindings: [
        { ...WEB_A, tabIds: [11], activeTabId: 11 },
        { ...WEB_B, tabIds: [11], activeTabId: 11 },
      ],
    })
    assert.equal(errorCodeOf(browser), ERROR.MALFORMED)
  })

  it('refuses a sync that names one scope twice', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    broker.handle(browser, CLIENT.BINDING_SYNC, {
      type: CLIENT.BINDING_SYNC,
      bindings: [
        { ...WEB_A, tabIds: [11], activeTabId: 11 },
        { ...WEB_A, tabIds: [12], activeTabId: 12 },
      ],
    })
    assert.equal(errorCodeOf(browser), ERROR.MALFORMED)
  })

  it('refuses a reconnect sync that would reclaim a scope owned elsewhere', () => {
    browserWith('browser-1', WEB_A, [11])
    const second = browserWith('browser-2', WEB_A, [77])
    const agent = agentWith('agent-1', 'web', ['session-a'])

    // browser-1 comes back and re-announces its stale local copy.
    const returning = connect(ROLE.BROWSER, 'browser-1', { capabilities: Object.values(ACTION) })
    broker.handle(returning, CLIENT.BINDING_SYNC, {
      type: CLIENT.BINDING_SYNC,
      bindings: [{ ...WEB_A, tabIds: [11], activeTabId: 11 }],
    })

    assert.equal(returning.last(SERVER.BINDING_REVOKED)?.['sessionId'], 'session-a')
    request(agent, 'req-1', WEB_A)
    assert.equal(second.last(SERVER.ACTION)?.['targetTabId'], 77)
  })

  it('restores a scope on reconnect when no other browser claimed it', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    broker.close(browser)

    const returning = connect(ROLE.BROWSER, 'browser-1', { capabilities: Object.values(ACTION) })
    broker.handle(returning, CLIENT.BINDING_SYNC, {
      type: CLIENT.BINDING_SYNC,
      bindings: [{ ...WEB_A, tabIds: [11], activeTabId: 11 }],
    })

    request(agent, 'req-1', WEB_A)
    assert.equal(returning.last(SERVER.ACTION)?.['targetTabId'], 11)
  })

  it('treats a scope missing from a full sync as a detachment', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])

    broker.handle(browser, CLIENT.BINDING_SYNC, { type: CLIENT.BINDING_SYNC, bindings: [] })

    request(agent, 'req-1', WEB_A)
    assert.equal(errorCode(responseFor(agent, 'req-1')), ERROR.NO_BINDING)
  })

  it('keeps two browser identities apart', () => {
    const first = browserWith('browser-1', WEB_A, [11])
    const second = browserWith('browser-2', WEB_B, [22])
    const agent = agentWith('agent-1', 'web', ['session-a', 'session-b'])

    request(agent, 'req-a', WEB_A)
    request(agent, 'req-b', WEB_B)

    assert.equal(first.last(SERVER.ACTION)?.['targetTabId'], 11)
    assert.equal(second.last(SERVER.ACTION)?.['targetTabId'], 22)
    assert.equal(first.count(SERVER.ACTION), 1)
    assert.equal(second.count(SERVER.ACTION), 1)
  })
})

describe('hostile frames', () => {
  it('refuses a frame kind the sending role may not use', () => {
    const agent = agentWith('agent-1', 'web', ['session-a'])
    broker.handle(agent, CLIENT.BINDING_UPDATE, { type: CLIENT.BINDING_UPDATE, ...WEB_A, tabIds: [11], activeTabId: 11 })
    assert.equal(errorCodeOf(agent), ERROR.MALFORMED)
  })

  it('refuses a browser frame kind only agents may send', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    broker.handle(browser, CLIENT.ACTION_REQUEST, { type: CLIENT.ACTION_REQUEST, id: 'x', ...WEB_A, action: { kind: ACTION.SNAPSHOT } })
    assert.equal(errorCodeOf(browser), ERROR.MALFORMED)
  })

  it('keeps an authenticated peer connected after one malformed frame', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    broker.handle(browser, CLIENT.BINDING_SYNC, { type: CLIENT.BINDING_SYNC, bindings: 'not an array' })
    assert.equal(errorCodeOf(browser), ERROR.MALFORMED)
    assert.equal(browser.closed, undefined)

    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A)
    assert.ok(browser.last(SERVER.ACTION), 'the browser still serves requests')
  })

  it('refuses an unknown action kind', () => {
    browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A, 'exfiltrate_cookies')
    assert.equal(errorCodeOf(agent), ERROR.UNSUPPORTED_ACTION)
  })

  it('refuses more bindings than one browser may hold', () => {
    const browser = browserWith('browser-1', WEB_A, [11])
    const bindings = Array.from({ length: LIMITS.MAX_BINDINGS_PER_BROWSER + 1 }, (_unused, index) => ({
      profileId: 'web', sessionId: `s${index}`, tabIds: [index + 100], activeTabId: index + 100,
    }))
    broker.handle(browser, CLIENT.BINDING_SYNC, { type: CLIENT.BINDING_SYNC, bindings })
    assert.equal(errorCodeOf(browser), ERROR.TOO_LARGE)
  })

  it('refuses more sessions than one agent may announce', () => {
    const agent = agentWith('agent-1', 'web', ['session-a'])
    const sessions = Array.from({ length: LIMITS.MAX_SESSIONS_PER_AGENT + 1 }, (_unused, index) => ({ sessionId: `s${index}` }))
    broker.handle(agent, CLIENT.SESSION_ANNOUNCE, { type: CLIENT.SESSION_ANNOUNCE, sessions })
    assert.equal(errorCodeOf(agent), ERROR.TOO_LARGE)
  })

  it('refuses more in-flight actions than one agent may hold', () => {
    browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    for (let index = 0; index < LIMITS.MAX_PENDING_PER_AGENT; index += 1) request(agent, `req-${index}`, WEB_A)
    request(agent, 'overflow', WEB_A)
    assert.equal(errorCode(responseFor(agent, 'overflow')), ERROR.TOO_LARGE)
  })

  it('refuses a reused in-flight request id', () => {
    browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    request(agent, 'req-1', WEB_A)
    request(agent, 'req-1', WEB_A)
    assert.equal(errorCode(responseFor(agent, 'req-1')), ERROR.MALFORMED)
  })

  it('refuses a malformed scope id', () => {
    browserWith('browser-1', WEB_A, [11])
    const agent = agentWith('agent-1', 'web', ['session-a'])
    broker.handle(agent, CLIENT.ACTION_REQUEST, {
      type: CLIENT.ACTION_REQUEST, id: 'req-1', profileId: 'web', sessionId: 'ab', action: { kind: ACTION.SNAPSHOT },
    })
    assert.equal(errorCodeOf(agent), ERROR.MALFORMED)
  })
})

describe('session view', () => {
  it('lists announced sessions with the tabs they own', () => {
    browserWith('browser-1', WEB_A, [11, 12])
    agentWith('agent-1', 'web', ['session-a', 'session-b'])

    const sessions = broker.sessions()
    const a = sessions.find((entry) => entry.sessionId === 'session-a')
    const b = sessions.find((entry) => entry.sessionId === 'session-b')
    assert.deepEqual(a?.tabIds, [11, 12])
    assert.equal(a?.activeTabId, 12)
    assert.equal(a?.browserId, 'browser-1')
    assert.deepEqual(b?.tabIds, [])
    assert.equal(b?.browserId, undefined)
  })

  it('drops a retired session', () => {
    const agent = agentWith('agent-1', 'web', ['session-a'])
    broker.handle(agent, CLIENT.SESSION_RETIRE, { type: CLIENT.SESSION_RETIRE, sessionId: 'session-a' })
    assert.deepEqual(broker.sessions(), [])
  })

  it('drops every session when its plugin process exits', () => {
    const agent = agentWith('agent-1', 'web', ['session-a'])
    broker.close(agent)
    assert.deepEqual(broker.sessions(), [])
  })

  it('keeps the same session id in two profiles apart', () => {
    agentWith('agent-1', 'web', ['session-a'])
    agentWith('agent-2', 'headless', ['session-a'])
    assert.deepEqual(broker.sessions().map((entry) => entry.profileId), ['headless', 'web'])
  })
})

/**
 * @param socket - the socket to read.
 * @returns the code of the last `denied` frame.
 */
function errorCodeOf(socket: FakeSocket): string {
  return String(socket.last(SERVER.DENIED)?.['code'])
}
