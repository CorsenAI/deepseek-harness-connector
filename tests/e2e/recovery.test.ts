/**
 * Recovery: honest behaviour when a component dies mid-flight (gates AA, AB).
 *
 * Each case takes one real component away — the broker, the extension's service worker, the
 * DeepSeek Harness plugin instance, the tab, the whole browser — while an action is running, and
 * checks three things: the caller is told the truth (an unknown outcome is reported as unknown, a
 * refusal as a refusal), the system comes back without the user doing anything it should not have
 * to, and nothing destructive ever runs twice. The slow form in `page-c.html` blocks the page for
 * 1.5 s on submit and counts its runs, so a replay would be visible as a count of 2.
 * @module
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { Page } from 'playwright'
import WebSocket from 'ws'
import { AgentClient, BrowserActionError } from '../../companion/src/agent-client.ts'
import { brokerProof, createNonce, proofsMatch, roleProof } from '../../companion/src/auth.ts'
import { ACTION, CLIENT, ERROR, PROTOCOL_VERSION, ROLE, SERVER, scopeKey } from '../../companion/src/protocol.ts'
import {
  attachTab,
  extensionConnected,
  pairExtension,
  settle,
  startHarness,
  tabIdFor,
  waitFor,
  type Harness,
} from './harness.ts'

const PROFILE = 'web.rec000000001'

let harness: Harness
let workspace: string

before(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'dsh-connector-recovery-'))
  const profile = join(workspace, 'profile')
  mkdirSync(profile)
  harness = await startHarness({ userDataDir: profile, stateFile: join(workspace, 'broker-state.json') })
  await pairExtension(harness)
}, { timeout: 120000 })

after(async () => {
  await harness?.close()
  rmSync(workspace, { recursive: true, force: true })
})

/** The panel's own view of the extension. */
interface PanelState {
  connected: boolean
  identity: { browserId: string }
  bindings: { profileId: string, sessionId: string, tabIds: number[], activeTabId: number }[]
}

/** @returns what the panel would show right now. */
async function panelState(): Promise<PanelState> {
  return await harness.panel.evaluate(async () => await chrome.runtime.sendMessage({ type: 'connector/state' })) as PanelState
}

/**
 * Open the controls fixture in a new tab and attach it to one session.
 * @param sessionId - the session that will own the tab.
 * @returns the page and its tab id.
 */
async function openAttached(sessionId: string): Promise<{ page: Page, tabId: number }> {
  const page = await harness.context.newPage()
  const url = `${harness.pageUrl('page-c.html')}?s=${sessionId}`
  await page.goto(url)
  const tabId = await tabIdFor(harness, url)
  await waitFor('the tab to be complete in Chrome', async () => (
    await harness.panel.evaluate(async (id: number) => (await chrome.tabs.get(id)).status === 'complete', tabId)
  ))
  const attached = await attachTab(harness, { profileId: PROFILE, sessionId }, tabId)
  assert.equal(attached.ok, true, attached.error ?? 'attach failed')
  return { page, tabId }
}

/**
 * @param agent - a connected agent.
 * @param sessionId - the session whose tab to read.
 * @returns the ref of the slow form's field from a fresh snapshot.
 */
async function slowFieldRef(agent: AgentClient, sessionId: string): Promise<string> {
  const snapshot = await agent.request(sessionId, ACTION.SNAPSHOT, {}) as { elements: { ref: string, name: string }[] }
  const field = snapshot.elements.find((element) => element.name === 'Slow field')
  assert.ok(field, 'the slow form field must be in the snapshot')
  return field.ref
}

/**
 * @param page - the fixture page.
 * @returns how many times the slow form has been submitted, as the page recorded it.
 */
async function submissions(page: Page): Promise<string | null> {
  return await page.getAttribute('#slow-form', 'data-submissions')
}

/**
 * @param code - the expected typed code.
 * @returns a matcher for `assert.rejects`.
 */
function rejectsWith(code: string): (cause: unknown) => boolean {
  return (cause: unknown) => cause instanceof BrowserActionError && cause.code === code
}

/** How a request ended, captured without ever letting a rejection go unhandled. */
interface Outcome {
  value?: unknown
  cause?: unknown
}

/**
 * Start watching a request that is expected to fail while the test is busy taking a component away.
 *
 * A promise that rejects before a handler is attached is an unhandled rejection, and node:test
 * fails the case on the spot. Capturing the outcome the moment the request starts keeps the
 * assertion where it belongs: after the component is gone.
 * @param promise - the in-flight request.
 * @returns the eventual outcome, never a rejection.
 */
function outcomeOf(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then((value) => ({ value }), (cause: unknown) => ({ cause }))
}

/**
 * @param outcome - a captured outcome.
 * @param codes - the typed codes that are honest here.
 * @param what - what the failure is about, for the message.
 */
function assertFailedWith(outcome: Outcome, codes: string[], what: string): void {
  const cause = outcome.cause
  assert.ok(
    cause instanceof BrowserActionError,
    `${what}: expected a typed failure, got ${cause === undefined ? `success ${JSON.stringify(outcome.value)}` : String(cause)}`,
  )
  assert.ok(codes.includes(cause.code), `${what}: expected ${codes.join(' or ')}, got ${cause.code}: ${cause.message}`)
}

/**
 * A DeepSeek Harness plugin stand-in that exposes every frame the broker sends it.
 *
 * `AgentClient` deliberately hides unknown responses; this client records them, so a test can
 * prove that a result belonging to a previous plugin instance never reaches the next one.
 */
class RawAgent {
  readonly unsolicited: Record<string, unknown>[] = []
  readonly socket: WebSocket
  readonly profileId: string
  readonly pending = new Map<string, { resolve: (value: Record<string, unknown>) => void, reject: (cause: Error) => void }>()
  counter = 0

  /**
   * @param socket - the paired connection.
   * @param profileId - the profile this instance belongs to.
   */
  constructor(socket: WebSocket, profileId: string) {
    this.socket = socket
    this.profileId = profileId
  }

  /**
   * Connect and authenticate as an agent, then announce sessions.
   * @param host - the running harness.
   * @param profileId - the profile.
   * @param sessions - sessions to announce.
   * @returns the paired client.
   */
  static connect(host: Harness, profileId: string, sessions: string[]): Promise<RawAgent> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${host.broker.port}`)
      const agentId = `agent-raw-${createNonce()}`
      const clientNonce = createNonce()
      const agent = new RawAgent(socket, profileId)
      socket.once('error', reject)
      // Listeners go on before the socket opens: the broker challenges on accept, and a listener
      // attached after `open` can miss that first frame.
      socket.on('message', (raw: Buffer) => {
        const frame = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
        if (frame['type'] === SERVER.CHALLENGE) {
          socket.send(JSON.stringify({
            type: CLIENT.HELLO,
            role: ROLE.AGENT,
            id: agentId,
            profileId,
            name: 'DeepSeek Harness (raw)',
            nonce: clientNonce,
            proof: roleProof(host.secret, ROLE.AGENT, agentId, String(frame['nonce'])),
            protocolVersion: PROTOCOL_VERSION,
            connectorVersion: '0.1.0',
          }))
          return
        }
        if (frame['type'] === SERVER.PAIRED) {
          if (!proofsMatch(String(frame['proof']), brokerProof(host.secret, ROLE.AGENT, agentId, clientNonce))) {
            reject(new Error('the broker did not prove the pairing secret'))
            return
          }
          socket.send(JSON.stringify({
            type: CLIENT.SESSION_ANNOUNCE,
            sessions: sessions.map((sessionId) => ({ sessionId, title: sessionId })),
          }))
          resolve(agent)
          return
        }
        if (frame['type'] === SERVER.DENIED) { reject(new Error(String(frame['message']))); return }
        if (frame['type'] === SERVER.ACTION_RESPONSE) agent.onResponse(frame)
      })
    })
  }

  /**
   * @param frame - an `action_response` frame.
   */
  onResponse(frame: Record<string, unknown>): void {
    const id = String(frame['id'])
    const waiting = this.pending.get(id)
    if (!waiting) { this.unsolicited.push(frame); return }
    this.pending.delete(id)
    if (frame['ok'] === true) waiting.resolve(frame['data'] as Record<string, unknown>)
    else waiting.reject(new Error(String((frame['error'] as { message?: string } | undefined)?.message ?? 'failed')))
  }

  /**
   * @param sessionId - the calling session.
   * @param kind - the action kind.
   * @param args - the action arguments.
   * @returns the result payload.
   */
  request(sessionId: string, kind: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = `raw${this.counter++}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ type: CLIENT.ACTION_REQUEST, id, profileId: this.profileId, sessionId, action: { kind, args } }))
    })
  }

  close(): void {
    this.socket.close()
  }
}

// One outer suite: node:test runs top-level suites concurrently, and every case here shares one
// browser, one broker, and one state file. As subtests they run in order.
describe('recovery', () => {
  it('broker restart: both sides reconnect with bounded backoff, and ownership comes back from the state file', { timeout: 90000 }, async () => {
    const session = 'broker-restart'
    await openAttached(session)
    const agent = await harness.agent(PROFILE, [session])
    const before = await agent.request(session, ACTION.CURRENT_URL, {}) as { url: string }
    assert.match(before.url, /s=broker-restart/)

    // The broker persisted the attachment before anything was restarted.
    const { identity } = await panelState()
    const persisted = JSON.parse(readFileSync(harness.stateFile as string, 'utf8')) as { scopeOwners: Record<string, string> }
    assert.equal(persisted.scopeOwners[scopeKey(PROFILE, session)], identity.browserId, 'ownership must be on disk before the restart')

    const started = Date.now()
    await harness.restartBroker()
    await waitFor('the extension to reconnect to the new broker', () => extensionConnected(harness), 30000)
    await waitFor('the agent to reconnect to the new broker', () => agent.connected, 30000)
    const reconnectMs = Date.now() - started
    assert.ok(reconnectMs < 30000, `reconnection took ${reconnectMs} ms`)

    // No re-attachment by the user: the request routes as before.
    const after = await agent.request(session, ACTION.CURRENT_URL, {}) as { url: string }
    assert.match(after.url, /s=broker-restart/)
  })

  it('broker restart while a destructive action is in flight: the outcome is reported unknown and the action is never replayed', { timeout: 90000 }, async () => {
    const session = 'no-replay'
    const { page } = await openAttached(session)
    const agent = await harness.agent(PROFILE, [session])
    const ref = await slowFieldRef(agent, session)

    const inflight = outcomeOf(agent.request(session, ACTION.TYPE, { ref, text: 'w', submit: true }))
    await settle(300)
    await harness.restartBroker()

    // The action had reached the page; the honest answer is "unknown", never "refused".
    assertFailedWith(await inflight, [ERROR.INTERRUPTED], 'a destructive action cut off by a broker restart')

    await waitFor('the extension to reconnect', () => extensionConnected(harness), 30000)
    await waitFor('the agent to reconnect', () => agent.connected, 30000)
    await waitFor('the page to have finished its one slow submission', async () => (await submissions(page)) === '1', 10000)
    await settle(1500)
    assert.equal(await submissions(page), '1', 'reconnecting must not replay the submission')

    // The system is usable again, and still nothing ran twice.
    const snapshot = await agent.request(session, ACTION.SNAPSHOT, {}) as { title: string }
    assert.equal(snapshot.title, 'Connector fixture C')
    assert.equal(await submissions(page), '1')
  })

  it('service worker killed mid-action: the caller gets INTERRUPTED, the action ran once, and the next request after the worker returns succeeds', { timeout: 90000 }, async () => {
    const session = 'worker-kill'
    const { page } = await openAttached(session)
    const agent = await harness.agent(PROFILE, [session])
    const ref = await slowFieldRef(agent, session)

    const inflight = outcomeOf(agent.request(session, ACTION.TYPE, { ref, text: 'x', submit: true }))
    await settle(300)
    await harness.killWorker()

    assertFailedWith(await inflight, [ERROR.INTERRUPTED], 'an action whose worker was killed')

    // Chrome starts the worker again on the next event, here an ordinary panel message; the
    // worker reconnects and restores its bindings from storage without the user doing anything.
    await harness.wakeWorker()
    await waitFor('the extension to reconnect after the worker restarted', () => extensionConnected(harness), 30000)
    await waitFor('the page to have finished its one slow submission', async () => (await submissions(page)) === '1', 10000)

    const snapshot = await agent.request(session, ACTION.SNAPSHOT, {}) as { title: string }
    assert.equal(snapshot.title, 'Connector fixture C')
    assert.equal(await submissions(page), '1', 'the interrupted action must not have run twice')
  })

  it('plugin instance restart: sessions are re-announced, a request succeeds, and a result for the old instance never reaches the new one', { timeout: 90000 }, async () => {
    const session = 'plugin-restart'
    const { page } = await openAttached(session)
    const first = await harness.agent(PROFILE, [session])
    const ref = await slowFieldRef(first, session)

    const inflight = outcomeOf(first.request(session, ACTION.TYPE, { ref, text: 'y', submit: true }))
    await settle(300)
    // The plugin instance goes away mid-flight, as it would when its dsh process exits.
    first.dispose()
    assertFailedWith(await inflight, [ERROR.INTERRUPTED], 'an action whose plugin instance was unloaded')

    // A new instance for the same session connects before the page has finished the old action.
    const second = await RawAgent.connect(harness, PROFILE, [session])
    await settle(2500)
    assert.equal(second.unsolicited.length, 0, 'the old instance’s result must be dropped by the broker, not delivered to the new one')

    const url = await second.request(session, ACTION.CURRENT_URL) as { url: string }
    assert.match(url.url, /s=plugin-restart/)
    assert.equal(await submissions(page), '1')
    second.close()
  })

  it('tab closed mid-action: the action fails as gone or as changed, never as done, and the binding no longer lists the tab', { timeout: 90000 }, async () => {
    const session = 'tab-close'
    const { page, tabId } = await openAttached(session)
    const agent = await harness.agent(PROFILE, [session])
    const ref = await slowFieldRef(agent, session)

    const inflight = outcomeOf(agent.request(session, ACTION.TYPE, { ref, text: 'z', submit: true }))
    await settle(300)
    await page.close()

    // Two honest outcomes race: the injection fails and the extension reports TAB_GONE, or Chrome's
    // tab-removed event releases the binding first and the broker reports the binding as changed.
    // Either way the model is told the action did not complete as asked.
    assertFailedWith(await inflight, [ERROR.TAB_GONE, ERROR.BINDING_CHANGED], 'an action whose tab was closed')
    await waitFor('the binding to forget the closed tab', async () => (
      !(await panelState()).bindings.some((binding) => binding.tabIds.includes(tabId))
    ), 10000)
    await assert.rejects(agent.request(session, ACTION.CURRENT_URL, {}), rejectsWith(ERROR.NO_BINDING))
  })

  it('Chrome restart: pairing and identity survive, bindings do not, and a reused tab id is never acted on', { timeout: 120000 }, async () => {
    const session = 'chrome-restart'
    const { tabId: oldTabId } = await openAttached(session)
    const agent = await harness.agent(PROFILE, [session])
    const before = await agent.request(session, ACTION.CURRENT_URL, {}) as { url: string }
    assert.match(before.url, /s=chrome-restart/)
    const identityBefore = (await panelState()).identity.browserId

    await harness.relaunchChrome()
    await waitFor('the extension to reconnect after Chrome restarted', () => extensionConnected(harness), 45000)

    const state = await panelState()
    assert.equal(state.identity.browserId, identityBefore, 'the installation identity must survive a restart')
    assert.deepEqual(state.bindings, [], 'tab ids from a previous browser session must not be trusted')
    await assert.rejects(agent.request(session, ACTION.CURRENT_URL, {}), rejectsWith(ERROR.NO_BINDING))

    // A new tab in the new session may well receive the old tab's id. It must still be unreachable
    // until the user attaches it again.
    const page = await harness.context.newPage()
    const url = `${harness.pageUrl('page-c.html')}?s=after-restart`
    await page.goto(url)
    const newTabId = await tabIdFor(harness, url)
    await assert.rejects(agent.request(session, ACTION.SNAPSHOT, {}), rejectsWith(ERROR.NO_BINDING))
    if (newTabId === oldTabId) {
      // Recorded, not asserted: whether Chrome reused the id is Chrome's business; that the
      // connector did not act on it is ours.
      process.stdout.write(`note: Chrome reused tab id ${oldTabId} after the restart\n`)
    }

    const attached = await attachTab(harness, { profileId: PROFILE, sessionId: session }, newTabId)
    assert.equal(attached.ok, true)
    const after = await agent.request(session, ACTION.CURRENT_URL, {}) as { url: string }
    assert.match(after.url, /s=after-restart/)
  })
})
