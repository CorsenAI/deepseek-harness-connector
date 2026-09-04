/**
 * Multi-session isolation: the release-blocking architecture gate.
 *
 * Tests A to E of `docs/TEST-MATRIX.md`, run against a real browser and the real extension. A
 * failure here is a cross-session data leak, not a bug: one DeepSeek Harness session would receive
 * page content from a tab another session owns. Nothing ships while any of these fails.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { BrowserActionError } from '../../companion/src/agent-client.ts'
import { ACTION, ERROR } from '../../companion/src/protocol.ts'
import { attachTab, pairExtension, settle, startHarness, tabIdFor, waitFor, type Harness } from './harness.ts'

const PROFILE = 'web.iso000000001'
const A = { profileId: PROFILE, sessionId: 'session-a' }
const B = { profileId: PROFILE, sessionId: 'session-b' }

// Each suite uses its own sessions so a binding one case leaves behind cannot change what the next
// case observes. Sharing a scope across cases would make a real leak and a stale fixture look alike.
const MULTI = { profileId: PROFILE, sessionId: 'multi-tab-session' }
const FROM = { profileId: PROFILE, sessionId: 'transfer-from' }
const TO = { profileId: PROFILE, sessionId: 'transfer-to' }

let harness: Harness

before(async () => {
  harness = await startHarness()
  await pairExtension(harness)
}, { timeout: 120000 })

after(async () => { await harness?.close() })

// One outer suite: node:test runs top-level suites concurrently, and these share one browser and
// one broker. As subtests they run in order, so each case sees only the state it set up.
describe('multi-session isolation', () => {
  describe('A — two sessions never act in each other tabs', () => {
  it('keeps every interleaved request in its own tab', { timeout: 120000 }, async () => {
    const pageA = await harness.context.newPage()
    await pageA.goto(harness.pageUrl('page-a.html'))
    const pageB = await harness.context.newPage()
    await pageB.goto(harness.pageUrl('page-b.html'))

    const tabA = await tabIdFor(harness, harness.pageUrl('page-a.html'))
    const tabB = await tabIdFor(harness, harness.pageUrl('page-b.html'))
    assert.notEqual(tabA, tabB)

    assert.equal((await attachTab(harness, A, tabA)).ok, true)
    assert.equal((await attachTab(harness, B, tabB)).ok, true)

    const agent = await harness.agent(PROFILE, ['session-a', 'session-b'])

    // Interleave aggressively: 24 requests alternating between the two sessions, all in flight at
    // once. Ordering is exactly where a routing table keyed on anything global would fail.
    const requests: Promise<Record<string, unknown>>[] = []
    for (let round = 0; round < 12; round += 1) {
      requests.push(agent.request('session-a', ACTION.SNAPSHOT, {}) as Promise<Record<string, unknown>>)
      requests.push(agent.request('session-b', ACTION.SNAPSHOT, {}) as Promise<Record<string, unknown>>)
    }
    const results = await Promise.all(requests)

    results.forEach((result, index) => {
      const expected = index % 2 === 0 ? 'Connector fixture A' : 'Connector fixture B'
      assert.equal(result['title'], expected, `request ${index} was answered from the wrong tab`)
    })

    // Fixture B's text is unmistakable. It must never appear in a result for session A.
    for (let index = 0; index < results.length; index += 2) {
      const serialized = JSON.stringify(results[index])
      assert.equal(
        serialized.includes('must never reach the session that owns fixture A'),
        false,
        `session A received fixture B's content in request ${index}`,
      )
    }

    await pageA.close()
    await pageB.close()
  })

  it('clicks only in the tab the calling session owns', { timeout: 120000 }, async () => {
    const pageA = await harness.context.newPage()
    await pageA.goto(harness.pageUrl('page-a.html'))
    const pageB = await harness.context.newPage()
    await pageB.goto(harness.pageUrl('page-b.html'))
    await attachTab(harness, A, await tabIdFor(harness, harness.pageUrl('page-a.html')))
    await attachTab(harness, B, await tabIdFor(harness, harness.pageUrl('page-b.html')))

    const agent = await harness.agent(PROFILE, ['session-a', 'session-b'])
    const snapshotB = await agent.request('session-b', ACTION.SNAPSHOT, {}) as Record<string, unknown>
    const buttonB = (snapshotB['elements'] as { ref: string, name: string }[])
      .find((element) => element.name === 'Click me on B')
    assert.ok(buttonB)

    await agent.request('session-b', ACTION.CLICK, { ref: buttonB.ref })

    await pageB.waitForFunction(() => document.getElementById('outcome')?.textContent === 'B was clicked')
    assert.equal(
      await pageA.textContent('#outcome'),
      'untouched',
      "session B's click reached session A's page",
    )

    await pageA.close()
    await pageB.close()
  })
  })

  describe('B — a session sees only its own tabs', () => {
  it('targets its active tab and can be pointed only at tabs it owns', { timeout: 120000 }, async () => {
    const pages = []
    for (const fixture of ['page-a.html', 'page-b.html', 'page-a.html']) {
      const page = await harness.context.newPage()
      await page.goto(`${harness.pageUrl(fixture)}?n=${pages.length}`)
      pages.push(page)
    }
    const owned: number[] = []
    for (let index = 0; index < pages.length; index += 1) {
      const url = pages[index]?.url() ?? ''
      const tabId = await harness.panel.evaluate(async (target: string) => {
        const tabs = await chrome.tabs.query({})
        return tabs.find((tab) => tab.url === target)?.id ?? -1
      }, url)
      assert.ok(tabId > 0)
      owned.push(tabId)
      assert.equal((await attachTab(harness, MULTI, tabId)).ok, true)
    }

    const state = await harness.panel.evaluate(async () => (
      await chrome.runtime.sendMessage({ type: 'connector/state' })
    )) as { bindings: { profileId: string, sessionId: string, tabIds: number[], activeTabId: number }[] }
    const binding = state.bindings.find((entry) => entry.sessionId === MULTI.sessionId)
    assert.ok(binding)
    assert.deepEqual([...binding.tabIds].sort(), [...owned].sort(), 'the session must own exactly the three tabs')
    assert.equal(binding.activeTabId, owned[owned.length - 1], 'the last attached tab becomes active')

    // Pointing the session at a tab it does not own is refused, not silently accepted.
    const stranger = await harness.context.newPage()
    await stranger.goto(`${harness.pageUrl('page-b.html')}?stranger=1`)
    const strangerId = await tabIdFor(harness, `${harness.pageUrl('page-b.html')}?stranger=1`)
    const refused = await harness.panel.evaluate(async (payload: Record<string, unknown>) => (
      await chrome.runtime.sendMessage({ type: 'connector/set-active-tab', ...payload })
    ), { ...MULTI, tabId: strangerId }) as { ok: boolean, error?: string }
    assert.equal(refused.ok, false)
    assert.match(String(refused.error), /not attached to this session/)

    // Switching to a tab it does own moves the target, and the result proves which page answered.
    const first = owned[0] as number
    await harness.panel.evaluate(async (payload: Record<string, unknown>) => (
      await chrome.runtime.sendMessage({ type: 'connector/set-active-tab', ...payload })
    ), { ...MULTI, tabId: first })
    await settle()

    const agent = await harness.agent(PROFILE, [MULTI.sessionId])
    const answered = await agent.request(MULTI.sessionId, ACTION.CURRENT_URL, {}) as Record<string, unknown>
    assert.equal(String(answered['url']).includes('n=0'), true, 'the active tab was not the one selected')

    for (const page of [...pages, stranger]) await page.close()
  })
  })

  describe('C — an unbound session changes nothing', () => {
  it('fails, and leaves every tab untouched', { timeout: 120000 }, async () => {
    const page = await harness.context.newPage()
    await page.goto(harness.pageUrl('page-a.html'))
    const before = await page.textContent('#outcome')

    const agent = await harness.agent(PROFILE, ['session-a', 'orphan-session'])
    await assert.rejects(
      agent.request('orphan-session', ACTION.SNAPSHOT, {}),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.NO_BINDING,
    )
    await assert.rejects(
      agent.request('orphan-session', ACTION.CLICK, { ref: 'e1@1' }),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.NO_BINDING,
    )

    assert.equal(await page.textContent('#outcome'), before, 'an unbound session altered a page')
    await page.close()
  })
  })

  describe('D — a transfer removes the old authority first', () => {
  it('moves a tab between sessions with no interval where both hold it', { timeout: 120000 }, async () => {
    const page = await harness.context.newPage()
    await page.goto(`${harness.pageUrl('page-a.html')}?transfer=1`)
    const tabId = await tabIdFor(harness, `${harness.pageUrl('page-a.html')}?transfer=1`)

    assert.equal((await attachTab(harness, FROM, tabId)).ok, true)
    const agent = await harness.agent(PROFILE, [FROM.sessionId, TO.sessionId])
    const before = await agent.request(FROM.sessionId, ACTION.CURRENT_URL, {}) as Record<string, unknown>
    assert.equal(String(before['url']).includes('transfer=1'), true)

    // The user attaches the same tab to session B. Ownership is single, so A must lose it.
    assert.equal((await attachTab(harness, TO, tabId)).ok, true)

    await assert.rejects(
      agent.request(FROM.sessionId, ACTION.CURRENT_URL, {}),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.NO_BINDING,
      'session A kept authority over a tab that moved to session B',
    )
    const after = await agent.request(TO.sessionId, ACTION.CURRENT_URL, {}) as Record<string, unknown>
    assert.equal(String(after['url']).includes('transfer=1'), true)

    await page.close()
  })
  })

  describe('E — two Chrome profiles stay distinct', () => {
  it('gives each installation its own identity and keeps their scopes apart', { timeout: 180000 }, async () => {
    // A second harness is a second Chrome profile with its own extension installation, connected to
    // the same broker. Two profiles must never be confused for one another.
    const second = await startHarness()
    try {
      // Point the second browser at the FIRST harness's broker, so both share one router.
      await second.panel.evaluate(async ([brokerUrl, code]: string[]) => {
        await chrome.runtime.sendMessage({ type: 'connector/settings', settings: { brokerUrl, pairingCode: code } })
      }, [`ws://127.0.0.1:${harness.broker.port}`, (await import('../../companion/src/auth.ts')).pairingCode(harness.secret)])
      await waitFor('the second browser to authenticate', async () => (
        await second.panel.evaluate(async () => {
          const state = await chrome.runtime.sendMessage({ type: 'connector/state' })
          return state?.connected === true
        })
      ))

      const firstIdentity = await harness.panel.evaluate(async () => (
        (await chrome.runtime.sendMessage({ type: 'connector/state' }))?.identity
      )) as { browserId: string }
      const secondIdentity = await second.panel.evaluate(async () => (
        (await chrome.runtime.sendMessage({ type: 'connector/state' }))?.identity
      )) as { browserId: string }

      assert.notEqual(secondIdentity.browserId, firstIdentity.browserId, 'two installations share one identity')
      assert.match(firstIdentity.browserId, /^browser-[0-9a-f-]{36}$/)
      assert.match(secondIdentity.browserId, /^browser-[0-9a-f-]{36}$/)

      // Each profile attaches its own tab to its own session; neither may answer for the other.
      const firstPage = await harness.context.newPage()
      await firstPage.goto(`${harness.pageUrl('page-a.html')}?profile=1`)
      await attachTab(harness, A, await tabIdFor(harness, `${harness.pageUrl('page-a.html')}?profile=1`))

      const secondPage = await second.context.newPage()
      await secondPage.goto(`${second.pageUrl('page-b.html')}?profile=2`)
      const secondTab = await second.panel.evaluate(async (target: string) => {
        const tabs = await chrome.tabs.query({})
        return tabs.find((tab) => tab.url === target)?.id ?? -1
      }, `${second.pageUrl('page-b.html')}?profile=2`)
      await second.panel.evaluate(async (payload: Record<string, unknown>) => (
        await chrome.runtime.sendMessage({ type: 'connector/attach', ...payload })
      ), { ...B, tabId: secondTab })
      await settle(250)

      const agent = await harness.agent(PROFILE, ['session-a', 'session-b'])
      const fromFirst = await agent.request('session-a', ACTION.CURRENT_URL, {}) as Record<string, unknown>
      const fromSecond = await agent.request('session-b', ACTION.CURRENT_URL, {}) as Record<string, unknown>

      assert.equal(String(fromFirst['url']).includes('profile=1'), true)
      assert.equal(String(fromSecond['url']).includes('profile=2'), true)
      assert.equal(String(fromFirst['url']).includes('profile=2'), false, 'a profile answered for another')

      await firstPage.close()
      await secondPage.close()
    } finally {
      await second.close()
    }
  })
  })
})
