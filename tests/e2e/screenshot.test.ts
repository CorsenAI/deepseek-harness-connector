/**
 * The screenshot action, in a real browser.
 *
 * Chrome captures the active tab of a window and nothing else, so the action has two honest
 * outcomes worth proving: a capture of the attached tab when it is already at the front, and a
 * capture that first brought it there — reported, because the user's window changed. The bytes
 * are checked as bytes: a JPEG with the dimensions the extension reported. A page Chrome protects
 * is refused as restricted, never captured as whatever else was on screen.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { BrowserActionError } from '../../companion/src/agent-client.ts'
import { ACTION, ERROR } from '../../companion/src/protocol.ts'
import { attachTab, pairExtension, settle, startHarness, tabIdFor, type Harness } from './harness.ts'
import { jpegDimensions } from './jpeg.ts'

const PROFILE = 'web.shot00000001'
const SESSION = 'screenshot-session'

let harness: Harness
let agent: Awaited<ReturnType<Harness['agent']>>
let tabId: number

/** What the extension answers for a capture. */
interface Capture {
  url: string
  title: string
  mediaType: string
  dataUrl: string
  width: number
  height: number
  foregrounded: boolean
}

before(async () => {
  harness = await startHarness()
  await pairExtension(harness)
  const page = await harness.context.newPage()
  await page.goto(harness.pageUrl('page-a.html'))
  tabId = await tabIdFor(harness, harness.pageUrl('page-a.html'))
  const attached = await attachTab(harness, { profileId: PROFILE, sessionId: SESSION }, tabId)
  assert.equal(attached.ok, true, attached.error ?? 'attach failed')
  agent = await harness.agent(PROFILE, [SESSION])
}, { timeout: 120000 })

after(async () => { await harness?.close() })

describe('browser_screenshot', () => {
  it('captures the attached tab as a JPEG whose bytes match the reported size', { timeout: 60000 }, async () => {
    // The fixture tab is the last one opened, so it is at the front already.
    const capture = await agent.request(SESSION, ACTION.SCREENSHOT, {}) as Capture
    assert.equal(capture.mediaType, 'image/jpeg')
    assert.equal(capture.url, harness.pageUrl('page-a.html'))
    assert.equal(capture.title, 'Connector fixture A')
    assert.equal(capture.foregrounded, false, 'a tab already at the front is not brought there again')
    assert.ok(capture.dataUrl.startsWith('data:image/jpeg;base64,'))
    const bytes = Buffer.from(capture.dataUrl.slice(capture.dataUrl.indexOf(',') + 1), 'base64')
    assert.ok(bytes.length > 2000, `a capture of a page with text is more than ${bytes.length} bytes`)
    const measured = jpegDimensions(bytes)
    assert.deepEqual({ width: capture.width, height: capture.height }, measured, 'the reported dimensions must be the bytes\' own')
    assert.ok(measured.width >= 200 && measured.height >= 200, `implausible capture ${measured.width}×${measured.height}`)
  })

  it('brings the tab to the front when another tab covers it, and says so', { timeout: 60000 }, async () => {
    const cover = await harness.context.newPage()
    await cover.goto(harness.pageUrl('page-b.html'))
    await settle(300)
    const before = await harness.panel.evaluate(async (id: number) => (await chrome.tabs.get(id)).active, tabId)
    assert.equal(before, false, 'the fixture tab must be covered for this to prove anything')

    const capture = await agent.request(SESSION, ACTION.SCREENSHOT, {}) as Capture
    assert.equal(capture.foregrounded, true)
    assert.equal(capture.title, 'Connector fixture A', 'the capture is of the attached tab, not of the tab that covered it')
    const afterwards = await harness.panel.evaluate(async (id: number) => (await chrome.tabs.get(id)).active, tabId)
    assert.equal(afterwards, true)
    await cover.close()
  })

  it('refuses a page Chrome protects instead of capturing whatever is on screen', { timeout: 60000 }, async () => {
    const page = harness.context.pages().find((candidate) => candidate.url() === harness.pageUrl('page-a.html'))
    assert.ok(page)
    await page.goto('chrome://version/')
    await settle(300)
    await assert.rejects(
      agent.request(SESSION, ACTION.SCREENSHOT, {}),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.RESTRICTED_PAGE,
    )
    await page.goto(harness.pageUrl('page-a.html'))
  })
})
