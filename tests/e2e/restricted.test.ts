/**
 * Pages Chrome protects stay fail-closed, whether or not Chrome exposes their address.
 *
 * A browser-internal page reaches the tab chooser either with a `chrome://` address or, when Chrome
 * withholds the address from the extension entirely, with none. Both must read as restricted and
 * both must be refused on attach. This is the case the minimum-permission decision rests on: an
 * unknown address is never treated as a safe one.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { pairExtension, settle, startHarness, type Harness } from './harness.ts'

const PROFILE = 'web.res000000001'
const SESSION = 'restricted-session'

let harness: Harness

before(async () => {
  harness = await startHarness()
  await pairExtension(harness)
}, { timeout: 120000 })

after(async () => { await harness?.close() })

/** One chooser row as the panel receives it. */
interface ChooserTab {
  id: number
  url: string
  title: string
  restricted: boolean
}

describe('pages Chrome protects', () => {
  it('lists a browser-internal tab as restricted and refuses to attach it', { timeout: 60000 }, async () => {
    const internal = await harness.context.newPage()
    await internal.goto('chrome://version/')
    const fixture = await harness.context.newPage()
    await fixture.goto(harness.pageUrl('page-a.html'))
    await settle(250)

    const listed = await harness.panel.evaluate(async () => (
      await chrome.runtime.sendMessage({ type: 'connector/tabs' })
    )) as { ok: boolean, tabs: ChooserTab[] }
    assert.equal(listed.ok, true)

    const internalEntries = listed.tabs.filter((tab) => tab.url === '' || tab.url.startsWith('chrome://'))
    assert.ok(internalEntries.length >= 1, 'the chrome://version tab must appear in the chooser, with or without an address')
    for (const entry of internalEntries) {
      assert.equal(entry.restricted, true, `${entry.url || '(no address)'} must be marked restricted`)
    }

    const ordinary = listed.tabs.find((tab) => tab.url === harness.pageUrl('page-a.html'))
    assert.ok(ordinary, 'an ordinary page must be listed with its address')
    assert.equal(ordinary.restricted, false)

    for (const entry of internalEntries) {
      const reply = await harness.panel.evaluate(async (payload: Record<string, unknown>) => (
        await chrome.runtime.sendMessage({ type: 'connector/attach', ...payload })
      ), { profileId: PROFILE, sessionId: SESSION, tabId: entry.id }) as { ok: boolean, error?: string }
      assert.equal(reply.ok, false, 'attaching a restricted tab must be refused')
      assert.match(String(reply.error), /Chrome does not/)
    }

    const state = await harness.panel.evaluate(async () => (
      await chrome.runtime.sendMessage({ type: 'connector/state' })
    )) as { bindings: unknown[] }
    assert.equal(state.bindings.length, 0, 'a refused attachment must leave no binding behind')

    await internal.close()
    await fixture.close()
  })

  it('keeps an attached tab fail-closed once it navigates to a protected page', { timeout: 60000 }, async () => {
    const page = await harness.context.newPage()
    await page.goto(harness.pageUrl('page-b.html'))
    await settle(200)
    const listed = await harness.panel.evaluate(async () => (
      await chrome.runtime.sendMessage({ type: 'connector/tabs' })
    )) as { tabs: ChooserTab[] }
    const entry = listed.tabs.find((tab) => tab.url === harness.pageUrl('page-b.html'))
    assert.ok(entry)
    const attached = await harness.panel.evaluate(async (payload: Record<string, unknown>) => (
      await chrome.runtime.sendMessage({ type: 'connector/attach', ...payload })
    ), { profileId: PROFILE, sessionId: SESSION, tabId: entry.id }) as { ok: boolean }
    assert.equal(attached.ok, true)

    const agent = await harness.agent(PROFILE, [SESSION])
    await page.goto('chrome://version/')
    await settle(250)

    // The page-level action must be refused as restricted, not attempted blind: injection into a
    // chrome:// page is impossible, and an injection failure dressed as a page failure would
    // mislead the model about what it can do next.
    await assert.rejects(
      agent.request(SESSION, 'snapshot', {}),
      (cause: unknown) => cause instanceof Error && 'code' in cause && (cause as { code: string }).code === 'RESTRICTED_PAGE',
    )
    await page.close()
  })
})
