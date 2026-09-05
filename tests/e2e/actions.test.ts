/**
 * The fifteen actions beyond the vertical slice, each proven against the page's own state.
 *
 * Every assertion reads what the page recorded, not what the extension reported: `#outcome` is
 * written by the fixture's own handlers, so a passing case means the browser did the thing.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { Page } from 'playwright'
import { BrowserActionError } from '../../companion/src/agent-client.ts'
import { ACTION, ERROR } from '../../companion/src/protocol.ts'
import { attachTab, pairExtension, settle, startHarness, tabIdFor, waitFor, type Harness } from './harness.ts'

const PROFILE = 'web.act000000001'

let harness: Harness

before(async () => {
  harness = await startHarness()
  await pairExtension(harness)
}, { timeout: 120000 })

after(async () => { await harness?.close() })

/**
 * Open fixture C in a fresh tab attached to a fresh session.
 * @param sessionId - a session id unique to the case.
 * @returns the page, the agent, and a snapshot helper.
 */
async function fixtureC(sessionId: string): Promise<{
  page: Page
  agent: Awaited<ReturnType<Harness['agent']>>
  refOf: (name: string) => Promise<string>
}> {
  const page = await harness.context.newPage()
  const url = `${harness.pageUrl('page-c.html')}?s=${sessionId}`
  await page.goto(url)
  const tabId = await tabIdFor(harness, url)
  // Chrome marks a tab complete slightly after Playwright's own load event resolves. A navigation
  // issued inside that gap replaces the entry still being loaded instead of adding one, so no case
  // gets its tab until Chrome, not Playwright, reports it complete. The connector's own actions
  // already wait this way; a user cannot act faster than Chrome, but a test harness can.
  await waitFor('the fixture tab to be complete in Chrome', async () => (
    await harness.panel.evaluate(async (id: number) => (await chrome.tabs.get(id)).status === 'complete', tabId)
  ))
  const attached = await attachTab(harness, { profileId: PROFILE, sessionId }, tabId)
  assert.equal(attached.ok, true, attached.error ?? 'attach failed')
  const agent = await harness.agent(PROFILE, [sessionId])
  const refOf = async (name: string): Promise<string> => {
    const snapshot = await agent.request(sessionId, ACTION.SNAPSHOT, {}) as { elements: { ref: string, name: string }[] }
    const element = snapshot.elements.find((entry) => entry.name === name)
    assert.ok(element, `no element named ${JSON.stringify(name)} in the snapshot`)
    return element.ref
  }
  return { page, agent, refOf }
}

/**
 * @param page - the fixture page.
 * @returns the text the fixture's handlers last wrote.
 */
async function outcome(page: Page): Promise<string> {
  return (await page.textContent('#outcome')) ?? ''
}

// One outer suite: node:test runs top-level suites concurrently, and these share one browser and
// one broker. As subtests they run in order, so a navigation in one case cannot race a tab
// creation in another. Splitting them back out reintroduces interference that looks like a bug.
describe('browser actions', () => {
  describe('page actions', () => {
  it('key: Enter in a form field submits the form, Escape reaches its handler, modifiers are carried', { timeout: 60000 }, async () => {
    const { page, agent, refOf } = await fixtureC('key')
    const search = await refOf('Search')
    await agent.request('key', ACTION.TYPE, { ref: search, text: 'hello', replace: true })
    await agent.request('key', ACTION.KEY, { key: 'Control+a', ref: search })
    assert.equal(await page.textContent('#last-key'), 'a+ctrl')

    const result = await agent.request('key', ACTION.KEY, { key: 'Enter', ref: search }) as { submitted: boolean }
    assert.equal(result.submitted, true)
    assert.equal(await outcome(page), 'submitted:hello', 'Enter must actually submit the form')

    const target = await refOf('Press Escape here')
    await agent.request('key', ACTION.KEY, { key: 'Escape', ref: target })
    assert.equal(await outcome(page), 'escaped')

    await assert.rejects(
      agent.request('key', ACTION.KEY, { key: 'F13' }),
      (cause: unknown) => cause instanceof BrowserActionError && /not a supported key/.test(cause.message),
    )
    await page.close()
  })

  it('type with submit: true submits the containing form', { timeout: 60000 }, async () => {
    const { page, agent, refOf } = await fixtureC('type-submit')
    const search = await refOf('Search')
    const result = await agent.request('type-submit', ACTION.TYPE, { ref: search, text: 'needle', replace: true, submit: true }) as { submitted: boolean }
    assert.equal(result.submitted, true)
    assert.equal(await outcome(page), 'submitted:needle')
    await page.close()
  })

  it('scroll: to the bottom, to an element, and by pixels', { timeout: 60000 }, async () => {
    const { page, agent } = await fixtureC('scroll')
    const bottom = await agent.request('scroll', ACTION.SCROLL, { to: 'bottom' }) as { scrollY: number, scrollHeight: number }
    assert.ok(bottom.scrollY > 2000, `expected to be near the bottom, scrollY ${bottom.scrollY}`)
    assert.ok(await page.evaluate(() => window.scrollY > 2000))

    const up = await agent.request('scroll', ACTION.SCROLL, { dy: -500 }) as { scrollY: number }
    assert.ok(up.scrollY < bottom.scrollY, 'a negative dy scrolls up')

    const top = await agent.request('scroll', ACTION.SCROLL, { to: 'top' }) as { scrollY: number }
    assert.equal(top.scrollY, 0)

    // Scrolling to an element by ref, then confirming the page put it in the viewport.
    const snapshot = await agent.request('scroll', ACTION.SNAPSHOT, {}) as { elements: { ref: string, name: string }[] }
    const button = snapshot.elements.find((entry) => entry.name === 'Bottom button')
    assert.ok(button)
    await agent.request('scroll', ACTION.SCROLL, { ref: button.ref })
    // Sub-pixel layout can put the last element's bottom edge a fraction of a pixel past the
    // viewport at maximum scroll (observed: 720.075 against 720). One pixel of tolerance keeps the
    // assertion about the viewport, not about rounding.
    assert.ok(await page.evaluate(() => {
      const rect = document.getElementById('bottom-button')?.getBoundingClientRect()
      return rect !== undefined && rect.top >= -1 && rect.bottom <= window.innerHeight + 1
    }), 'the element must be inside the viewport after scrolling to it')

    await assert.rejects(
      agent.request('scroll', ACTION.SCROLL, {}),
      (cause: unknown) => cause instanceof BrowserActionError && /needs a ref/.test(cause.message),
    )
    await page.close()
  })

  it('hover reaches the page’s mouseover handler', { timeout: 60000 }, async () => {
    const { page, agent, refOf } = await fixtureC('hover')
    await agent.request('hover', ACTION.HOVER, { ref: await refOf('Hover me') })
    assert.equal(await outcome(page), 'hovered')
    assert.equal(await page.isVisible('#tooltip'), true)
    await page.close()
  })

  it('select_option by value and by label, and refuses an unknown option with the list', { timeout: 60000 }, async () => {
    const { page, agent, refOf } = await fixtureC('select')
    const colour = await refOf('Colour')
    const byValue = await agent.request('select', ACTION.SELECT_OPTION, { ref: colour, value: 'b' }) as { selected: { value: string, label: string } }
    assert.deepEqual(byValue.selected, { value: 'b', label: 'Blue' })
    assert.equal(await outcome(page), 'colour:b')
    assert.equal(await page.inputValue('#colour'), 'b')

    await agent.request('select', ACTION.SELECT_OPTION, { ref: colour, label: 'red' })
    assert.equal(await page.inputValue('#colour'), 'r', 'label matching is case-insensitive as a fallback')

    await assert.rejects(
      agent.request('select', ACTION.SELECT_OPTION, { ref: colour, value: 'purple' }),
      (cause: unknown) => cause instanceof BrowserActionError && /available: Red \(r\), Green \(g\), Blue \(b\)/.test(cause.message),
    )

    // A snapshot lists the options of a select, so the model can choose without guessing.
    const snapshot = await agent.request('select', ACTION.SNAPSHOT, {}) as { elements: { name: string, options?: { value: string, selected: boolean }[] }[] }
    const listed = snapshot.elements.find((entry) => entry.name === 'Colour')?.options
    assert.deepEqual(listed?.map((option) => option.value), ['r', 'g', 'b'])
    assert.equal(listed?.find((option) => option.selected)?.value, 'r')
    await page.close()
  })

  it('drag delivers the HTML5 drop with its data transfer', { timeout: 60000 }, async () => {
    const { page, agent } = await fixtureC('drag')
    // Both refs must come from ONE snapshot: every snapshot mints a new generation, and a ref from
    // an earlier one is refused as stale. That refusal is the security property, not a nuisance.
    const snapshot = await agent.request('drag', ACTION.SNAPSHOT, {}) as { elements: { ref: string, name: string }[] }
    const from = snapshot.elements.find((entry) => entry.name === 'Drag me')?.ref
    const to = snapshot.elements.find((entry) => entry.name === 'Drop here')?.ref
    assert.ok(from !== undefined && to !== undefined, 'both ends of the drag must be in the same snapshot')
    const result = await agent.request('drag', ACTION.DRAG, { from, to }) as { dragged: string, droppedOn: string }
    assert.equal(result.dragged, 'Drag me')
    assert.equal(await outcome(page), 'dropped:payload-42', 'the drop handler must receive the dragged payload')
    await page.close()
  })

  it('find locates text far down the page and scrolls to it', { timeout: 60000 }, async () => {
    const { page, agent } = await fixtureC('find')
    assert.equal(await page.evaluate(() => window.scrollY), 0)
    const result = await agent.request('find', ACTION.FIND, { text: 'needle in the haystack' }) as { found: boolean, count: number, snippet: string }
    assert.equal(result.found, true)
    assert.equal(result.count, 1)
    assert.match(result.snippet, /needle in the haystack/)
    assert.ok(await page.evaluate(() => window.scrollY > 1000), 'the first match must be scrolled into view')

    const missing = await agent.request('find', ACTION.FIND, { text: 'text that is not on this page' }) as { found: boolean, count: number }
    assert.deepEqual([missing.found, missing.count], [false, 0])
    await page.close()
  })

  it('wait outlasts a late mutation and reports a settled page', { timeout: 60000 }, async () => {
    const { page, agent } = await fixtureC('wait')
    await page.reload()
    const result = await agent.request('wait', ACTION.WAIT, { ms: 5000 }) as { settled: boolean, waitedMs: number, readyState: string }
    assert.equal(result.settled, true)
    assert.equal(result.readyState, 'complete')
    assert.ok(result.waitedMs >= 400, `a mutation inside the quiet window must extend the wait; waited only ${result.waitedMs} ms`)
    assert.equal(await page.getAttribute('#outcome', 'data-late'), 'arrived', 'the 400 ms mutation must have landed before the page counted as settled')
    await page.close()
  })
  })

  describe('navigation', () => {
  it('navigate, back, forward, and reload move the tab and wait for it', { timeout: 90000 }, async () => {
    const { page, agent } = await fixtureC('nav')
    const target = harness.pageUrl('page-a.html')
    const entriesAtStart = await page.evaluate(() => history.length)

    const navigated = await agent.request('nav', ACTION.NAVIGATE, { url: target }) as { url: string, title: string, loaded: string }
    assert.equal(navigated.title, 'Connector fixture A')
    assert.equal(navigated.loaded, 'complete')
    assert.equal(page.url(), target)
    // A navigation the session asked for must add a history entry, not replace the one it left;
    // otherwise browser_back could never return to where the session came from.
    const entriesAfterNavigate = await page.evaluate(() => history.length)
    assert.equal(entriesAfterNavigate, entriesAtStart + 1, `navigate must add one history entry (had ${entriesAtStart}, now ${entriesAfterNavigate})`)

    const back = await agent.request('nav', ACTION.BACK, {}) as { title: string, url: string, loaded: string }
    const afterBack = await page.evaluate(() => ({ href: location.href, entries: history.length }))
    assert.equal(back.title, 'Connector fixture C', `back reported ${back.url} (${back.loaded}); the page is at ${afterBack.href} with ${afterBack.entries} entries`)
    assert.match(page.url(), /page-c\.html/)

    const forward = await agent.request('nav', ACTION.FORWARD, {}) as { title: string }
    assert.equal(forward.title, 'Connector fixture A')

    await page.click('#counter')
    assert.equal(await outcome(page), 'clicked 1')
    const reloaded = await agent.request('nav', ACTION.RELOAD, {}) as { title: string, loaded: string }
    assert.equal(reloaded.loaded, 'complete')
    assert.equal(await outcome(page), 'untouched', 'a reload must produce a fresh page')
    await page.close()
  })

  it('refuses to navigate anywhere but http and https', { timeout: 60000 }, async () => {
    const { page, agent } = await fixtureC('nav-refuse')
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings', 'not a url']) {
      await assert.rejects(
        agent.request('nav-refuse', ACTION.NAVIGATE, { url }),
        (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.ACTION_FAILED,
        `${url} must be refused`,
      )
    }
    assert.match(page.url(), /page-c\.html/, 'the tab must not have moved')
    await page.close()
  })

  it('back fails honestly when there is no history', { timeout: 60000 }, async () => {
    // A tab opened by Playwright starts at about:blank and keeps that entry, so its history is
    // never empty (history.length is 2 after the first goto). A tab the session opens itself is
    // created directly at its URL and has exactly one entry: that is the honest "no history" case.
    const { page, agent } = await fixtureC('nav-nohistory')
    const opened = await agent.request('nav-nohistory', ACTION.OPEN_TAB, { url: harness.pageUrl('page-b.html') }) as { opened: string }
    await assert.rejects(
      agent.request('nav-nohistory', ACTION.BACK, {}),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.ACTION_FAILED && /history/i.test(cause.message),
      'Chrome\'s own reason must be passed through, and no success may be reported',
    )
    await agent.request('nav-nohistory', ACTION.CLOSE_TAB, { tabRef: opened.opened })
    await page.close()
  })
  })

  describe('this session’s tabs', () => {
  it('open, list, switch, and close stay inside the scope', { timeout: 120000 }, async () => {
    const session = 'tabs'
    const { page, agent } = await fixtureC(session)

    // A tab this session never attached must stay invisible to it throughout.
    const stranger = await harness.context.newPage()
    await stranger.goto(`${harness.pageUrl('page-b.html')}?stranger=tabs`)
    const strangerId = await tabIdFor(harness, `${harness.pageUrl('page-b.html')}?stranger=tabs`)

    const opened = await agent.request(session, ACTION.OPEN_TAB, { url: harness.pageUrl('page-b.html') }) as { opened: string, title: string, attachedTabs: number }
    assert.equal(opened.title, 'Connector fixture B')
    assert.equal(opened.attachedTabs, 2)

    const listed = await agent.request(session, ACTION.LIST_TABS, {}) as { tabs: { tabRef: string, title: string, active: boolean }[], activeTabRef: string }
    assert.equal(listed.tabs.length, 2, 'only the two attached tabs, not the stranger')
    assert.equal(listed.activeTabRef, opened.opened)
    assert.equal(listed.tabs.find((tab) => tab.active)?.title, 'Connector fixture B')
    assert.equal(listed.tabs.some((tab) => tab.tabRef === `t${strangerId}`), false)

    // The new tab is the active one, so a snapshot comes from it.
    const snapshot = await agent.request(session, ACTION.SNAPSHOT, {}) as { title: string }
    assert.equal(snapshot.title, 'Connector fixture B')

    const first = listed.tabs.find((tab) => !tab.active)
    assert.ok(first)
    const switched = await agent.request(session, ACTION.SWITCH_TAB, { tabRef: first.tabRef }) as { activeTabRef: string, title: string }
    assert.equal(switched.activeTabRef, first.tabRef)
    assert.equal(switched.title, 'Connector fixture C')
    assert.equal((await agent.request(session, ACTION.SNAPSHOT, {}) as { title: string }).title, 'Connector fixture C')

    await assert.rejects(
      agent.request(session, ACTION.SWITCH_TAB, { tabRef: `t${strangerId}` }),
      (cause: unknown) => cause instanceof BrowserActionError && /not attached to this session/.test(cause.message),
    )
    await assert.rejects(
      agent.request(session, ACTION.CLOSE_TAB, { tabRef: `t${strangerId}` }),
      (cause: unknown) => cause instanceof BrowserActionError && /not attached to this session/.test(cause.message),
    )
    assert.equal(stranger.isClosed(), false, 'a tab outside the scope must never be closed')

    const closed = await agent.request(session, ACTION.CLOSE_TAB, { tabRef: opened.opened }) as { closed: string, remainingTabs: number, activeTabRef: string }
    assert.equal(closed.remainingTabs, 1)
    assert.equal(closed.activeTabRef, first.tabRef)
    await waitFor('the closed tab to disappear', async () => harness.context.pages().every((candidate) => !candidate.url().endsWith('page-b.html')))

    // Closing the last tab removes the binding, and the next action fails closed.
    const last = await agent.request(session, ACTION.CLOSE_TAB, {}) as { remainingTabs: number, activeTabRef: string | null }
    assert.equal(last.remainingTabs, 0)
    assert.equal(last.activeTabRef, null)
    await settle(300)
    await assert.rejects(
      agent.request(session, ACTION.SNAPSHOT, {}),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.NO_BINDING,
    )
    assert.equal(stranger.isClosed(), false)
    assert.equal(page.isClosed(), true)
    await stranger.close()
  })
  })
})
