/**
 * The visibility policy, proven against a page built to defeat it.
 *
 * Every `LEAK_ME` string in `page-hidden.html` is content the user cannot see, none of it looking
 * like a secret so that credential masking cannot hide a visibility defect. Every `_OK` string is
 * visible and must survive, so a policy that over-hides fails here as surely as one that leaks.
 * The checks read the real extension's output in a real Chromium, through every path page data
 * takes: the element inventory (names and values), the visible text, `find`, and the guard before
 * an action.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { BrowserActionError } from '../../companion/src/agent-client.ts'
import { ACTION, ERROR } from '../../companion/src/protocol.ts'
import { attachTab, pairExtension, startHarness, tabIdFor, type Harness } from './harness.ts'

const PROFILE = 'web.vis000000001'
const SESSION = 'visibility-session'

let harness: Harness
let agent: Awaited<ReturnType<Harness['agent']>>

/** Every sentinel the user cannot see. */
const HIDDEN = [
  'LEAK_ME_CHILD',
  'LEAK_ME_OPACITY_TEXT', 'LEAK_ME_OPACITY_BUTTON', 'LEAK_ME_OPACITY_VALUE',
  'LEAK_ME_DISPLAY_TEXT', 'LEAK_ME_DISPLAY_BUTTON', 'LEAK_ME_DISPLAY_VALUE',
  'LEAK_ME_VISIBILITY_TEXT', 'LEAK_ME_VISIBILITY_BUTTON', 'LEAK_ME_VISIBILITY_VALUE',
  'LEAK_ME_CV_TEXT', 'LEAK_ME_CV_BUTTON', 'LEAK_ME_CV_VALUE',
  'LEAK_ME_DETAILS_TEXT', 'LEAK_ME_DETAILS_BUTTON', 'LEAK_ME_DETAILS_VALUE',
  'LEAK_ME_HIDDEN_TYPE', 'LEAK_ME_HIDDEN_ATTRIBUTE', 'LEAK_ME_HIDDEN_INLINE',
  'LEAK_ME_ARIA_TEXT', 'LEAK_ME_ARIA_BUTTON',
  'LEAK_ME_TEMPLATE', 'LEAK_ME_NOSCRIPT',
]

/** Every sentinel the user can see. */
const VISIBLE_TEXT = ['VISIBLE_TEXT_OK', 'VISIBLE_AGAIN_OK', 'VISIBLE_SUMMARY_OK', 'OPEN_DETAILS_OK', 'SR_ONLY_OK']
const VISIBLE_NAMES = ['Visible button OK', 'Visible label', 'Reshown button OK', 'Open details button OK', 'Visible field']

before(async () => {
  harness = await startHarness()
  await pairExtension(harness)
  const page = await harness.context.newPage()
  await page.goto(harness.pageUrl('page-hidden.html'))
  const tabId = await tabIdFor(harness, harness.pageUrl('page-hidden.html'))
  const attached = await attachTab(harness, { profileId: PROFILE, sessionId: SESSION }, tabId)
  assert.equal(attached.ok, true, attached.error ?? 'attach failed')
  agent = await harness.agent(PROFILE, [SESSION])
}, { timeout: 120000 })

after(async () => { await harness?.close() })

/**
 * @param haystack - serialised output.
 * @param where - which output, for the failure message.
 */
function assertNoLeak(haystack: string, where: string): void {
  for (const sentinel of HIDDEN) {
    assert.equal(haystack.includes(sentinel), false, `${sentinel} reached the model through ${where}`)
  }
  assert.equal(haystack.includes('LEAK_ME'), false, `an unlisted LEAK_ME sentinel reached the model through ${where}`)
}

describe('hidden content never leaves the page', () => {
  it('keeps every hidden sentinel out of the snapshot: text, names, and values', { timeout: 60000 }, async () => {
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as {
      text: string
      elements: { ref: string, name: string, value?: string }[]
    }
    assertNoLeak(JSON.stringify(snapshot), 'the snapshot')

    // The trap the audit reproduced: a control under an opacity-zero ancestor, whose own computed
    // opacity is 1, and whose ordinary value would otherwise be reported in full.
    const opacityField = snapshot.elements.find((element) => element.name === 'Opacity field')
    assert.equal(opacityField, undefined, 'a control under an opacity-zero ancestor was inventoried')
    assert.equal(snapshot.elements.some((element) => element.name === 'Details field'), false)
    assert.equal(snapshot.elements.some((element) => element.name === 'Content-visibility field'), false)
  })

  it('keeps every hidden sentinel out of read_text', { timeout: 60000 }, async () => {
    const result = await agent.request(SESSION, ACTION.READ_TEXT, {}) as { text: string }
    assertNoLeak(result.text, 'read_text')
  })

  it('does not let find locate hidden text, so it cannot scroll the user to nothing', { timeout: 60000 }, async () => {
    for (const needle of ['LEAK_ME_OPACITY_TEXT', 'LEAK_ME_DETAILS_TEXT', 'LEAK_ME_CV_TEXT', 'LEAK_ME_ARIA_TEXT']) {
      const result = await agent.request(SESSION, ACTION.FIND, { text: needle }) as { found: boolean, count: number }
      assert.deepEqual([result.found, result.count], [false, 0], `find located hidden text ${needle}`)
    }
  })

  it('names a visible control by its visible text only', { timeout: 60000 }, async () => {
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as { elements: { name: string }[] }
    const named = snapshot.elements.find((element) => element.name.startsWith('Visible label'))
    assert.ok(named, 'the button with a hidden child must still be listed')
    assert.equal(named.name, 'Visible label', 'the hidden child must not become part of the name')
  })
})

describe('visible content still gets through', () => {
  it('lists every visible control, including a descendant re-shown inside a hidden ancestor', { timeout: 60000 }, async () => {
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as {
      elements: { name: string, value?: string }[]
    }
    const names = snapshot.elements.map((element) => element.name)
    for (const expected of VISIBLE_NAMES) {
      assert.ok(names.includes(expected), `${expected} is visible and must be listed; got ${JSON.stringify(names)}`)
    }
    assert.equal(snapshot.elements.find((element) => element.name === 'Visible field')?.value, 'VISIBLE_VALUE_OK')
  })

  it('reports every visible sentinel in the page text', { timeout: 60000 }, async () => {
    const result = await agent.request(SESSION, ACTION.READ_TEXT, {}) as { text: string }
    for (const expected of VISIBLE_TEXT) {
      assert.ok(result.text.includes(expected), `${expected} is visible and must be in the text`)
    }
  })

  it('lets find locate visible text', { timeout: 60000 }, async () => {
    const result = await agent.request(SESSION, ACTION.FIND, { text: 'VISIBLE_AGAIN_OK' }) as { found: boolean, count: number }
    assert.deepEqual([result.found, result.count], [true, 1])
  })
})

describe('an action on a control the user can no longer see', () => {
  it('is refused as stale rather than performed blind', { timeout: 60000 }, async () => {
    const page = harness.context.pages().find((candidate) => candidate.url().endsWith('page-hidden.html'))
    assert.ok(page)
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as { elements: { ref: string, name: string }[] }
    const button = snapshot.elements.find((element) => element.name === 'Visible button OK')
    assert.ok(button)

    // The page hides the control after the snapshot was taken, the way a dismissed dialog would.
    await page.evaluate(() => { document.getElementById('visible-button')!.style.opacity = '0' })

    await assert.rejects(
      agent.request(SESSION, ACTION.CLICK, { ref: button.ref }),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.STALE_REF,
    )
    assert.equal(await page.textContent('#outcome'), 'untouched', 'the hidden control must not have been clicked')

    await page.evaluate(() => { document.getElementById('visible-button')!.style.opacity = '' })
  })
})
