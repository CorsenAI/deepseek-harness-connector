/**
 * An attached session follows a cross-origin link without losing its tab (ADR 0009).
 *
 * The host-permission decision rests on one fixed requirement: a task that starts on one site and
 * continues on another — a sign-in redirect, a payment provider, a link in a page — must keep the
 * session's authority over its own tab. This suite runs that task under the shipped manifest, with
 * the second origin served by its own loopback server on its own port, which is a different origin
 * to the browser. Both routes are taken: the model navigating, and the model clicking a link the
 * page offers. The registry is read from the broker, the page's identity from the page.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ACTION } from '../../companion/src/protocol.ts'
import { serveFixtures, type FixtureServer } from './browser.ts'
import { attachTab, pairExtension, startHarness, tabIdFor, type Harness } from './harness.ts'

const PROFILE = 'web.xo0000000001'
const SESSION = 'cross-origin-session'

let harness: Harness
let other: FixtureServer
let agent: Awaited<ReturnType<Harness['agent']>>
let tabId: number

before(async () => {
  harness = await startHarness()
  other = await serveFixtures()
  await pairExtension(harness)
  const page = await harness.context.newPage()
  await page.goto(harness.pageUrl('page-a.html'))
  tabId = await tabIdFor(harness, harness.pageUrl('page-a.html'))
  const attached = await attachTab(harness, { profileId: PROFILE, sessionId: SESSION }, tabId)
  assert.equal(attached.ok, true, attached.error ?? 'attach failed')
  agent = await harness.agent(PROFILE, [SESSION])
}, { timeout: 120000 })

after(async () => {
  await other?.close()
  await harness?.close()
})

/** @returns the broker's view of the session's tabs. */
function ownedTabs(): readonly number[] {
  return harness.broker.broker.sessions().find((view) => view.profileId === PROFILE && view.sessionId === SESSION)?.tabIds ?? []
}

describe('an attached tab that changes origin mid-task', () => {
  it('stays the session’s tab when the model navigates it to another origin', { timeout: 60000 }, async () => {
    const originA = new URL(harness.pageUrl('page-a.html')).origin
    const originB = new URL(other.url('page-b.html')).origin
    assert.notEqual(originA, originB, 'the two servers must be different origins for this to prove anything')

    const before = await agent.request(SESSION, ACTION.CURRENT_URL, {}) as { url: string }
    assert.equal(new URL(before.url).origin, originA)

    const navigated = await agent.request(SESSION, ACTION.NAVIGATE, { url: other.url('page-b.html') }) as { url: string, loaded: string }
    assert.equal(new URL(navigated.url).origin, originB)

    // Authority did not move: the same tab, still owned, still scriptable on the new origin.
    assert.deepEqual(ownedTabs(), [tabId])
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as { url: string, text: string, elements: { ref: string, name: string }[] }
    assert.equal(new URL(snapshot.url).origin, originB)
    assert.match(snapshot.text, /Fixture B/)
    const button = snapshot.elements.find((element) => element.name === 'Click me on B')
    assert.ok(button, 'the new origin’s controls must be listed')
    await agent.request(SESSION, ACTION.CLICK, { ref: button.ref })
    const page = harness.context.pages().find((candidate) => candidate.url() === other.url('page-b.html'))
    assert.ok(page)
    assert.equal(await page.evaluate(() => document.getElementById('outcome')?.textContent), 'B was clicked')
  })

  it('stays the session’s tab when the model follows a link the page offers to another origin', { timeout: 60000 }, async () => {
    // Back on origin A, with a link to origin B that the page itself provides.
    await agent.request(SESSION, ACTION.NAVIGATE, { url: harness.pageUrl('page-a.html') })
    const page = harness.context.pages().find((candidate) => candidate.url() === harness.pageUrl('page-a.html'))
    assert.ok(page)
    await page.evaluate((target: string) => {
      const link = document.createElement('a')
      link.href = target
      link.textContent = 'Continue on the other site'
      document.body.appendChild(link)
    }, other.url('page-b.html'))

    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as { elements: { ref: string, name: string }[] }
    const link = snapshot.elements.find((element) => element.name === 'Continue on the other site')
    assert.ok(link, 'the link must be listed')
    // Two honest answers race inside Chrome. Either the page's own answer travels back before the
    // document is replaced — the click, at the address it happened on — or the document is gone
    // first and the extension reports the click as what it was: a navigation, with the new address.
    // Both are true at the instant they describe; neither may claim the other's address.
    const clicked = await agent.request(SESSION, ACTION.CLICK, { ref: link.ref }) as { clicked: string, navigated?: boolean, url: string }
    if (clicked.navigated === true) {
      assert.equal(new URL(clicked.url).origin, new URL(other.url('page-b.html')).origin, 'a navigated answer names the new page')
      assert.equal(clicked.clicked, link.ref)
    } else {
      assert.equal(new URL(clicked.url).origin, new URL(harness.pageUrl('page-a.html')).origin, 'an in-page answer names the page it ran in')
      assert.equal(clicked.clicked, 'Continue on the other site')
    }
    await agent.request(SESSION, ACTION.WAIT, {})

    const after = await agent.request(SESSION, ACTION.CURRENT_URL, {}) as { url: string }
    assert.equal(new URL(after.url).origin, new URL(other.url('page-b.html')).origin)
    assert.deepEqual(ownedTabs(), [tabId])
    const text = await agent.request(SESSION, ACTION.READ_TEXT, {}) as { text: string }
    assert.match(text.text, /Fixture B/, 'the session reads the page it followed the link to')
  })

  it('answers a read that was in flight when the page left, from the page that arrived', { timeout: 60000 }, async () => {
    // A wait is injected into origin A, and the page navigates itself to origin B while the wait is
    // running: the document that ran the script is replaced. The wait must not fail as a refusal
    // Chrome never made; it is answered from the new page, marked as having moved.
    await agent.request(SESSION, ACTION.NAVIGATE, { url: harness.pageUrl('page-a.html') })
    const page = harness.context.pages().find((candidate) => candidate.url() === harness.pageUrl('page-a.html'))
    assert.ok(page)

    const waiting = agent.request(SESSION, ACTION.WAIT, { timeoutMs: 5000 }) as Promise<{ url: string, settled: boolean, navigated?: boolean }>
    await new Promise((resolve) => setTimeout(resolve, 150))
    await page.evaluate((target: string) => { location.assign(target) }, other.url('page-b.html'))

    const settled = await waiting
    assert.equal(settled.navigated, true, 'the answer must say the page moved while the wait ran')
    assert.equal(new URL(settled.url).origin, new URL(other.url('page-b.html')).origin, 'the answer describes the page that arrived')
    assert.deepEqual(ownedTabs(), [tabId])
  })
})
