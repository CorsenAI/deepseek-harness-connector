/**
 * Open shadow DOM through the whole product: the extension's page code runs in Chrome's isolated
 * world, which shares the document with the page but not its objects, so what the page suite
 * proved of the module is proved again here through the extension, the broker, and the tool
 * client — a control inside a web component listed, read, and clicked, and the page's own listener
 * inside the root seeing the click.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ACTION } from '../../companion/src/protocol.ts'
import { attachTab, pairExtension, startHarness, tabIdFor, type Harness } from './harness.ts'

const PROFILE = 'web.shadow0000001'
const SESSION = 'shadow-session'

let harness: Harness
let agent: Awaited<ReturnType<Harness['agent']>>

before(async () => {
  harness = await startHarness()
  await pairExtension(harness)
  const page = await harness.context.newPage()
  await page.goto(harness.pageUrl('page-shadow.html'))
  const tabId = await tabIdFor(harness, harness.pageUrl('page-shadow.html'))
  const attached = await attachTab(harness, { profileId: PROFILE, sessionId: SESSION }, tabId)
  assert.equal(attached.ok, true, attached.error ?? 'attach failed')
  agent = await harness.agent(PROFILE, [SESSION])
}, { timeout: 120000 })

after(async () => { await harness?.close() })

describe('open shadow DOM, through the extension', () => {
  it('lists, reads, finds and clicks inside an open shadow root; never claims a closed one', { timeout: 60000 }, async () => {
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as { text: string, elements: { ref: string, role: string, name: string, masked?: boolean }[] }
    const names = snapshot.elements.map((entry) => `${entry.role}:${entry.name}`)
    for (const expected of ['button:Shadow button', 'textbox:Shadow field', 'link:Deep link', 'button:Slotted button']) {
      assert.ok(names.includes(expected), `${expected} must be listed; got ${names.join(' | ')}`)
    }
    assert.ok(snapshot.text.includes('SHADOW_TEXT_OK') && snapshot.text.includes('SLOTTED_TEXT_OK') && snapshot.text.includes('DEEP_TEXT_OK'))
    const whole = JSON.stringify(snapshot)
    for (const absent of ['CLOSED_LEAK', 'CLOSED_TEXT_LEAK', 'UNSLOTTED_LEAK', 'SHADOW_HIDDEN_LEAK', 'hunter2shadow']) {
      assert.ok(!whole.includes(absent), `${absent} must not reach the model`)
    }
    assert.equal(snapshot.elements.find((entry) => entry.name === 'Shadow password')?.masked, true)

    const found = await agent.request(SESSION, ACTION.FIND, { text: 'DEEP_TEXT_OK' }) as { found: boolean, count: number }
    assert.deepEqual({ found: found.found, count: found.count }, { found: true, count: 1 })

    const button = snapshot.elements.find((entry) => entry.name === 'Shadow button')
    assert.ok(button)
    await agent.request(SESSION, ACTION.CLICK, { ref: button.ref })
    const page = harness.context.pages().find((candidate) => candidate.url() === harness.pageUrl('page-shadow.html'))
    assert.ok(page)
    const events = await page.evaluate(() => (globalThis as unknown as { __events: string[] }).__events)
    assert.ok(events.includes('shadow-button-clicked'), `the page's listener inside the root must have seen the click; got ${JSON.stringify(events)}`)
  })
})
