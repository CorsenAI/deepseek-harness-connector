/**
 * The vertical slice, end to end in a real browser.
 *
 * DeepSeek Harness session -> plugin client -> broker -> Chrome extension -> the exact attached tab
 * -> snapshot and click -> the result back to the same session. Nothing here is mocked except
 * DeepSeek Harness itself; the extension, the broker, the transport, and the page are real.
 * @module
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { ACTION, ERROR } from '../../companion/src/protocol.ts'
import { BrowserActionError } from '../../companion/src/agent-client.ts'
import { attachTab, pairExtension, settle, startHarness, tabIdFor, type Harness } from './harness.ts'

const PROFILE = 'web.e2e00000001'
const SESSION = 'slice-session'
const SCOPE = { profileId: PROFILE, sessionId: SESSION }

let harness: Harness

before(async () => {
  harness = await startHarness()
  await pairExtension(harness)
}, { timeout: 120000 })

after(async () => { await harness?.close() })

describe('the vertical slice in a real browser', () => {
  it('pairs the extension and reaches an attached tab', { timeout: 60000 }, async () => {
    const page = await harness.context.newPage()
    await page.goto(harness.pageUrl('page-a.html'))
    const tabId = await tabIdFor(harness, harness.pageUrl('page-a.html'))

    const attached = await attachTab(harness, SCOPE, tabId)
    assert.equal(attached.ok, true, attached.error ?? 'attach failed')

    const agent = await harness.agent(PROFILE, [SESSION])
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as Record<string, unknown>

    assert.equal(snapshot['title'], 'Connector fixture A')
    assert.match(String(snapshot['text']), /The quick brown fox/)
    assert.ok(Array.isArray(snapshot['elements']))
    assert.ok((snapshot['elements'] as unknown[]).length > 0, 'the snapshot must list interactive elements')
  })

  it('never reports a password, one-time code, card number, or hidden value', { timeout: 60000 }, async () => {
    const agent = await harness.agent(PROFILE, [SESSION])
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as Record<string, unknown>
    const serialized = JSON.stringify(snapshot)

    for (const secret of [
      'hunter2-the-real-password',
      '123456',
      '4111111111111111',
      'csrf-token-should-never-appear',
    ]) {
      assert.equal(serialized.includes(secret), false, `${secret} reached the model through the snapshot`)
    }

    // The fields are still listed, so the model can act on them; only the values are masked.
    const elements = snapshot['elements'] as { name: string, masked?: boolean, value?: string }[]
    const masked = elements.filter((element) => element.masked === true)
    assert.ok(masked.length >= 3, 'the password, one-time code, and card fields must all be marked masked')
    for (const element of masked) assert.equal(element.value, '••••••••')
  })

  it('clicks the element the model named and reports the real outcome', { timeout: 60000 }, async () => {
    const page = harness.context.pages().find((candidate) => candidate.url().endsWith('page-a.html'))
    assert.ok(page)
    const agent = await harness.agent(PROFILE, [SESSION])

    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as Record<string, unknown>
    const elements = snapshot['elements'] as { ref: string, name: string }[]
    const target = elements.find((element) => element.name === 'Click me')
    assert.ok(target, 'the fixture button must appear in the snapshot')

    const result = await agent.request(SESSION, ACTION.CLICK, { ref: target.ref }) as Record<string, unknown>
    assert.equal(result['clicked'], 'Click me')

    // The page is the authority on whether the click happened, not the extension's own report.
    await page.waitForFunction(() => document.getElementById('outcome')?.textContent === 'clicked 1')
  })

  it('types into a field the way a controlled component sees it', { timeout: 60000 }, async () => {
    const page = harness.context.pages().find((candidate) => candidate.url().endsWith('page-a.html'))
    assert.ok(page)
    const agent = await harness.agent(PROFILE, [SESSION])

    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as Record<string, unknown>
    const elements = snapshot['elements'] as { ref: string, name: string }[]
    const field = elements.find((element) => element.name === 'Email')
    assert.ok(field, 'the email field must appear in the snapshot')

    await agent.request(SESSION, ACTION.TYPE, { ref: field.ref, text: 'someone@example.test', replace: true })
    assert.equal(await page.inputValue('#email'), 'someone@example.test')
  })

  it('refuses an element reference from an earlier snapshot', { timeout: 60000 }, async () => {
    const agent = await harness.agent(PROFILE, [SESSION])
    const first = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as Record<string, unknown>
    const stale = (first['elements'] as { ref: string }[])[0]
    assert.ok(stale)

    // A second snapshot mints a new generation, which is what makes the first one's refs stale.
    await agent.request(SESSION, ACTION.SNAPSHOT, {})

    await assert.rejects(
      agent.request(SESSION, ACTION.CLICK, { ref: stale.ref }),
      (cause: unknown) => cause instanceof Error && /earlier snapshot|fresh browser_snapshot/.test(cause.message),
    )
  })

  it('reports a disabled control as a failure rather than a silent success', { timeout: 60000 }, async () => {
    const agent = await harness.agent(PROFILE, [SESSION])
    const snapshot = await agent.request(SESSION, ACTION.SNAPSHOT, {}) as Record<string, unknown>
    const elements = snapshot['elements'] as { ref: string, name: string }[]
    const disabled = elements.find((element) => element.name === 'Cannot click')
    assert.ok(disabled)

    await assert.rejects(
      agent.request(SESSION, ACTION.CLICK, { ref: disabled.ref }),
      (cause: unknown) => cause instanceof Error && /disabled/.test(cause.message),
    )
  })

  it('scrubs a credential out of the reported URL', { timeout: 60000 }, async () => {
    const page = await harness.context.newPage()
    const url = `${harness.pageUrl('page-b.html')}?access_token=SUPERSECRETVALUE&safe=keep`
    await page.goto(url)
    const tabId = await tabIdFor(harness, url)
    const scope = { profileId: PROFILE, sessionId: 'url-session' }
    await attachTab(harness, scope, tabId)

    const agent = await harness.agent(PROFILE, [SESSION, 'url-session'])
    const reported = await agent.request('url-session', ACTION.CURRENT_URL, {}) as Record<string, unknown>

    assert.equal(String(reported['url']).includes('SUPERSECRETVALUE'), false, 'a token reached the model')
    assert.equal(String(reported['url']).includes('safe=keep'), true, 'ordinary parameters must survive')
    await page.close()
  })

  it('fails closed for a session with no attached tab', { timeout: 60000 }, async () => {
    const agent = await harness.agent(PROFILE, [SESSION, 'unbound-session'])
    // Matched on the typed code, not the message: the wording differs by layer, and only the code
    // is a contract. The DSH tool wrapper turns this same code into its model-facing sentence.
    await assert.rejects(
      agent.request('unbound-session', ACTION.SNAPSHOT, {}),
      (cause: unknown) => cause instanceof BrowserActionError && cause.code === ERROR.NO_BINDING,
    )
  })

  it('reports a tab that was closed under it', { timeout: 60000 }, async () => {
    const page = await harness.context.newPage()
    await page.goto(harness.pageUrl('page-b.html'))
    const tabId = await tabIdFor(harness, harness.pageUrl('page-b.html'))
    const scope = { profileId: PROFILE, sessionId: 'closing-session' }
    await attachTab(harness, scope, tabId)

    const agent = await harness.agent(PROFILE, [SESSION, 'closing-session'])
    await page.close()
    await settle(250)

    // Either the extension has already forgotten the closed tab (NO_BINDING) or it discovers the
    // tab is gone when it tries to reach it (TAB_GONE). Both are honest refusals; a success is not.
    await assert.rejects(
      agent.request('closing-session', ACTION.SNAPSHOT, {}),
      (cause: unknown) => cause instanceof BrowserActionError
        && [ERROR.NO_BINDING, ERROR.TAB_GONE].includes(cause.code as never),
    )
  })
})
