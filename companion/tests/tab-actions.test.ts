/**
 * The tab-level actions under a Chrome that refuses.
 *
 * A real browser cannot be made to refuse `chrome.tabs.remove` on demand, so the refusal paths are
 * exercised here against a stubbed `chrome` whose answers the test controls. The invariant under
 * test is the product's honesty rule: Chrome did not perform the action, so the result is not
 * success — and the ownership change that protects the user still happens.
 * @module
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import { ERROR, STORE, scopeKey } from '../../extension/src/protocol.js'
import { attachTab, EMPTY, lookup } from '../../extension/src/bindings.js'

/** One fake tab as the stub reports it. */
interface FakeTab {
  id: number
  title: string
  url: string
  windowId: number
  status: string
  active?: boolean
}

/** The controllable parts of the stub. */
interface ChromeStub {
  tabs: Map<number, FakeTab>
  storage: Map<string, unknown>
  removeError: Error | null
  updateError: Error | null
  createError: Error | null
  nextTabId: number
  /** Called after `tabs.create` returns, so a test can make the new tab vanish immediately. */
  afterCreate: ((tab: FakeTab) => void) | null
  removed: number[]
  activated: number[]
  /** What each successive `captureVisibleTab` answers: a data URL, or the error Chrome throws. */
  captures: (string | Error)[]
  /** Called while a capture is in progress, so a test can change the world under it. */
  duringCapture: (() => void) | null
  captureCalls: number
}

const stub: ChromeStub = {
  tabs: new Map(),
  storage: new Map(),
  removeError: null,
  updateError: null,
  createError: null,
  nextTabId: 100,
  afterCreate: null,
  removed: [],
  activated: [],
  captures: [],
  duringCapture: null,
  captureCalls: 0,
}

/** A tiny but valid JPEG data URL, as Chrome's capture answers. */
const JPEG_DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k='

/** A no-op event that remembers nothing; the worker registers listeners it never needs here. */
const inertEvent = { addListener: () => {}, removeListener: () => {} }

/**
 * Reject the way Chrome does for a tab that does not exist.
 * @param tabId - the missing tab.
 * @returns a rejected promise carrying Chrome's wording.
 */
const noSuchTab = (tabId: number): Promise<never> => Promise.reject(new Error(`No tab with id: ${tabId}.`))

// The worker module reads `chrome` at import time and on every call, so the stub is installed on
// the global before the import below and mutated by each test afterwards.
Object.assign(globalThis, {
  chrome: {
    runtime: {
      onMessage: inertEvent,
      onInstalled: inertEvent,
      onStartup: inertEvent,
      getManifest: () => ({ version: '0.1.0' }),
      sendMessage: async () => ({}),
    },
    alarms: { onAlarm: inertEvent, create: async () => {} },
    action: { onClicked: inertEvent },
    sidePanel: { open: async () => {} },
    scripting: { executeScript: async () => [] },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: stub.storage.get(key) }),
        set: async (bag: Record<string, unknown>) => { for (const [key, value] of Object.entries(bag)) stub.storage.set(key, value) },
        remove: async (key: string) => { stub.storage.delete(key) },
      },
      // Session storage lives for one browser session; the worker reads a marker from it on wake to
      // tell a fresh browser session (bindings must go) from a mere worker restart (bindings stay).
      session: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    tabs: {
      onRemoved: inertEvent,
      onUpdated: inertEvent,
      query: async () => [...stub.tabs.values()],
      get: async (tabId: number) => stub.tabs.get(tabId) ?? noSuchTab(tabId),
      create: async (options: { url?: string, windowId?: number }) => {
        if (stub.createError) throw stub.createError
        const tab: FakeTab = { id: stub.nextTabId++, title: 'New tab', url: options.url ?? 'about:blank', windowId: options.windowId ?? 1, status: 'complete' }
        stub.tabs.set(tab.id, tab)
        stub.afterCreate?.(tab)
        return { ...tab }
      },
      update: async (tabId: number, change: { active?: boolean }) => {
        if (!stub.tabs.has(tabId)) return noSuchTab(tabId)
        if (stub.updateError) throw stub.updateError
        stub.activated.push(tabId)
        if (change.active === true) {
          const target = stub.tabs.get(tabId)!
          for (const tab of stub.tabs.values()) if (tab.windowId === target.windowId) tab.active = tab.id === tabId
        }
        return { ...stub.tabs.get(tabId) }
      },
      captureVisibleTab: async (_windowId: number, _options: { format: string, quality: number }) => {
        stub.captureCalls += 1
        stub.duringCapture?.()
        const answer = stub.captures.shift()
        if (answer === undefined) throw new Error('the test scripted no answer for this capture')
        if (answer instanceof Error) throw answer
        return answer
      },
      remove: async (tabId: number) => {
        if (!stub.tabs.has(tabId)) return noSuchTab(tabId)
        if (stub.removeError) throw stub.removeError
        stub.tabs.delete(tabId)
        stub.removed.push(tabId)
      },
    },
  },
})

// The worker reads a capture's size by decoding the bytes; Node has no image decoder, so the
// stand-in answers a fixed size, and what the tests check is that the result reports what the
// decoder said rather than what the window claimed.
Object.assign(globalThis, {
  createImageBitmap: async () => ({ width: 640, height: 360, close() {} }),
})

const { performTabAction, restrictionReason } = await import('../../extension/src/background.js')

const SCOPE = { profileId: 'web.stub00000001', sessionId: 'stub-session' }

/**
 * Put a scope in charge of some tabs, exactly as the panel would have.
 * @param tabIds - the tabs; the last becomes active.
 * @returns the binding as the worker will look it up.
 */
function own(tabIds: number[]): { profileId: string, sessionId: string, tabIds: number[], activeTabId: number } {
  let registry = EMPTY
  for (const tabId of tabIds) {
    stub.tabs.set(tabId, { id: tabId, title: `Tab ${tabId}`, url: `https://example.test/${tabId}`, windowId: 1, status: 'complete' })
    registry = attachTab(registry, SCOPE, tabId)
  }
  stub.storage.set(STORE.BINDINGS, registry)
  // The registry module is plain JavaScript; its JSDoc types reach this file only as `object`.
  const binding = lookup(registry, SCOPE) as
    { profileId: string, sessionId: string, tabIds: readonly number[], activeTabId: number } | undefined
  assert.ok(binding)
  return { ...binding, tabIds: [...binding.tabIds] }
}

/** @returns the tabs the scope currently owns, from storage. */
function ownedNow(): number[] {
  const registry = stub.storage.get(STORE.BINDINGS) as Record<string, { tabIds: number[] }> | undefined
  return [...(registry?.[scopeKey(SCOPE.profileId, SCOPE.sessionId)]?.tabIds ?? [])]
}

beforeEach(() => {
  stub.tabs.clear()
  stub.storage.clear()
  stub.removeError = null
  stub.updateError = null
  stub.createError = null
  stub.afterCreate = null
  stub.removed = []
  stub.activated = []
  stub.captures = []
  stub.duringCapture = null
  stub.captureCalls = 0
  stub.nextTabId = 100
})

describe('close_tab', () => {
  it('reports a failure, not "closed", when Chrome refuses the close — and keeps the tab detached', async () => {
    const binding = own([11, 12])
    stub.removeError = new Error('Tabs cannot be edited right now (user may be dragging a tab).')

    const result = await performTabAction('close_tab', { tabRef: 't12' }, SCOPE, binding, 12) as { ok: boolean, error?: { code: string, message: string } }

    assert.equal(result.ok, false, 'a refused close must not be reported as success')
    assert.equal(result.error?.code, ERROR.ACTION_FAILED)
    assert.match(String(result.error?.message), /detached from this session for safety/)
    assert.match(String(result.error?.message), /could not close it/)
    assert.match(String(result.error?.message), /dragging a tab/, 'Chrome\'s own reason must be passed on')
    assert.deepEqual(ownedNow(), [11], 'authority over the tab is withdrawn even though the close failed')
    assert.ok(stub.tabs.has(12), 'the tab itself still exists, which is the whole point')
    assert.deepEqual(stub.removed, [])
  })

  it('reports TAB_GONE when the tab vanished before the close, and cleans the binding', async () => {
    const binding = own([11, 12])
    stub.tabs.delete(12)

    const result = await performTabAction('close_tab', { tabRef: 't12' }, SCOPE, binding, 12) as { ok: boolean, error?: { code: string } }

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, ERROR.TAB_GONE)
    assert.deepEqual(ownedNow(), [11])
  })

  it('reports success only after Chrome actually removed the tab', async () => {
    const binding = own([11, 12])

    const result = await performTabAction('close_tab', { tabRef: 't12' }, SCOPE, binding, 12) as { ok: boolean, data?: { closed: string, remainingTabs: number, activeTabRef: string | null } }

    assert.equal(result.ok, true)
    assert.equal(result.data?.closed, 't12')
    assert.equal(result.data?.remainingTabs, 1)
    assert.equal(result.data?.activeTabRef, 't11')
    assert.deepEqual(stub.removed, [12])
    assert.deepEqual(ownedNow(), [11])
  })

  it('closes the active tab when no tabRef is given, and removes the scope with its last tab', async () => {
    const binding = own([11])

    const result = await performTabAction('close_tab', {}, SCOPE, binding, 11) as { ok: boolean, data?: { remainingTabs: number, activeTabRef: string | null } }

    assert.equal(result.ok, true)
    assert.equal(result.data?.remainingTabs, 0)
    assert.equal(result.data?.activeTabRef, null)
    assert.deepEqual(ownedNow(), [])
  })

  it('refuses a tab outside the scope without touching it', async () => {
    const binding = own([11])
    stub.tabs.set(99, { id: 99, title: 'Stranger', url: 'https://other.test/', windowId: 1, status: 'complete' })

    const result = await performTabAction('close_tab', { tabRef: 't99' }, SCOPE, binding, 11) as { ok: boolean, error?: { message: string } }

    assert.equal(result.ok, false)
    assert.match(String(result.error?.message), /not attached to this session/)
    assert.ok(stub.tabs.has(99))
    assert.deepEqual(stub.removed, [])
  })
})

describe('open_tab', () => {
  it('reports TAB_GONE and cleans the binding when the new tab disappears before its first report', async () => {
    const binding = own([11])
    stub.afterCreate = (tab) => { stub.tabs.delete(tab.id) }

    const result = await performTabAction('open_tab', {}, SCOPE, binding, 11) as { ok: boolean, error?: { code: string, message: string } }

    assert.equal(result.ok, false, 'an incomplete success must not be reported')
    assert.equal(result.error?.code, ERROR.TAB_GONE)
    assert.match(String(result.error?.message), /detached/)
    assert.deepEqual(ownedNow(), [11], 'the vanished tab must not linger in the binding')
  })

  it('attaches the new tab to the calling scope and makes it active on success', async () => {
    const binding = own([11])

    const result = await performTabAction('open_tab', { url: 'https://example.test/new' }, SCOPE, binding, 11) as { ok: boolean, data?: { opened: string, attachedTabs: number, url: string } }

    assert.equal(result.ok, true)
    assert.equal(result.data?.opened, 't100')
    assert.equal(result.data?.attachedTabs, 2)
    assert.equal(result.data?.url, 'https://example.test/new')
    assert.deepEqual(ownedNow(), [11, 100])
  })

  it('refuses a URL that is not http or https before creating anything', async () => {
    const binding = own([11])
    await assert.rejects(
      performTabAction('open_tab', { url: 'javascript:alert(1)' }, SCOPE, binding, 11),
      /only http and https/,
    )
    assert.equal(stub.tabs.size, 1)
  })
})

describe('switch_tab', () => {
  it('reports TAB_GONE and cleans the binding when the target vanished', async () => {
    const binding = own([11, 12])
    stub.tabs.delete(12)

    const result = await performTabAction('switch_tab', { tabRef: 't12' }, SCOPE, binding, 11) as { ok: boolean, error?: { code: string } }

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, ERROR.TAB_GONE)
    assert.deepEqual(ownedNow(), [11])
  })

  it('changes the scope but reports foregrounded: false when Chrome refuses to bring it forward', async () => {
    const binding = own([11, 12])
    stub.updateError = new Error('Tabs cannot be edited right now (user may be dragging a tab).')

    const result = await performTabAction('switch_tab', { tabRef: 't11' }, SCOPE, binding, 12) as { ok: boolean, data?: { activeTabRef: string, foregrounded: boolean } }

    assert.equal(result.ok, true, 'the scope change succeeded and is the security-relevant part')
    assert.equal(result.data?.activeTabRef, 't11')
    assert.equal(result.data?.foregrounded, false, 'a refused foreground must be reported, not assumed')
    const registry = stub.storage.get(STORE.BINDINGS) as Record<string, { activeTabId: number }>
    assert.equal(registry[scopeKey(SCOPE.profileId, SCOPE.sessionId)]?.activeTabId, 11)
  })

  it('reports foregrounded: true when Chrome did bring it forward', async () => {
    const binding = own([11, 12])

    const result = await performTabAction('switch_tab', { tabRef: 't11' }, SCOPE, binding, 12) as { ok: boolean, data?: { foregrounded: boolean } }

    assert.equal(result.ok, true)
    assert.equal(result.data?.foregrounded, true)
    assert.deepEqual(stub.activated, [11])
  })

  it('refuses a tab outside the scope', async () => {
    const binding = own([11])
    stub.tabs.set(99, { id: 99, title: 'Stranger', url: 'https://other.test/', windowId: 1, status: 'complete' })

    const result = await performTabAction('switch_tab', { tabRef: 't99' }, SCOPE, binding, 11) as { ok: boolean, error?: { message: string } }

    assert.equal(result.ok, false)
    assert.match(String(result.error?.message), /not attached to this session/)
    assert.deepEqual(stub.activated, [])
  })
})

describe('screenshot', () => {
  /** The shape of a capture's answer. */
  interface Capture { ok: boolean, data?: { url: string, title: string, mediaType: string, dataUrl: string, width: number, height: number, foregrounded: boolean }, error?: { code: string, message: string } }

  it('captures a tab already at the front without touching it, and reports the decoded size', async () => {
    const binding = own([11])
    stub.tabs.get(11)!.active = true
    stub.captures = [JPEG_DATA_URL]

    const result = await performTabAction('screenshot', {}, SCOPE, binding, 11) as Capture

    assert.equal(result.ok, true, result.error?.message)
    assert.equal(result.data?.mediaType, 'image/jpeg')
    assert.equal(result.data?.dataUrl, JPEG_DATA_URL)
    assert.deepEqual({ width: result.data?.width, height: result.data?.height }, { width: 640, height: 360 }, 'the size is what the bytes decode to')
    assert.equal(result.data?.foregrounded, false)
    assert.deepEqual(stub.activated, [], 'a tab at the front is not brought there again')
    assert.equal(result.data?.title, 'Tab 11')
  })

  it('brings a covered tab to the front first and says so', async () => {
    const binding = own([11, 12])
    stub.tabs.get(12)!.active = true
    stub.captures = [JPEG_DATA_URL]

    const result = await performTabAction('screenshot', {}, SCOPE, binding, 11) as Capture

    assert.equal(result.ok, true, result.error?.message)
    assert.equal(result.data?.foregrounded, true)
    assert.deepEqual(stub.activated, [11])
    assert.equal(stub.tabs.get(11)?.active, true)
  })

  it('retries while Chrome has no frame to read back yet, and reports the capture that then succeeds', async () => {
    // The two answers Chrome gives before a tab's compositor has produced a frame: an empty
    // bitmap, or no view. Both clear on their own; a capture is not refused for them at once.
    const binding = own([11])
    stub.tabs.get(11)!.active = true
    stub.captures = [new Error('Failed to capture tab: image readback failed'), new Error('Failed to capture tab: view is invisible'), JPEG_DATA_URL]

    const result = await performTabAction('screenshot', {}, SCOPE, binding, 11) as Capture

    assert.equal(result.ok, true, result.error?.message)
    assert.equal(stub.captureCalls, 3)
    assert.equal(result.data?.dataUrl, JPEG_DATA_URL)
  })

  it('reports the failure, with Chrome\'s own reason, when the readback never succeeds', async () => {
    const binding = own([11])
    stub.tabs.get(11)!.active = true
    stub.captures = Array.from({ length: 8 }, () => new Error('Failed to capture tab: image readback failed'))

    const result = await performTabAction('screenshot', {}, SCOPE, binding, 11) as Capture

    assert.equal(result.ok, false, 'a capture that never happened must not be reported as one')
    assert.equal(result.error?.code, ERROR.ACTION_FAILED)
    assert.match(String(result.error?.message), /image readback failed/)
    assert.equal(stub.captureCalls, 5, 'bounded: five attempts, then the truth')
  })

  it('does not retry a refusal that is not transient', async () => {
    const binding = own([11])
    stub.tabs.get(11)!.active = true
    stub.captures = [new Error('Taking screenshots has been disabled'), JPEG_DATA_URL]

    const result = await performTabAction('screenshot', {}, SCOPE, binding, 11) as Capture

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, ERROR.ACTION_FAILED)
    assert.match(String(result.error?.message), /has been disabled/)
    assert.equal(stub.captureCalls, 1)
  })

  it('discards the image when the active tab changed during the capture', async () => {
    // Chrome captured whatever was at the front; if that stopped being the attached tab while the
    // capture ran, the picture may be of another page and must not be reported as this one.
    const binding = own([11, 12])
    stub.tabs.get(11)!.active = true
    stub.captures = [JPEG_DATA_URL]
    stub.duringCapture = () => { stub.tabs.get(11)!.active = false; stub.tabs.get(12)!.active = true }

    const result = await performTabAction('screenshot', {}, SCOPE, binding, 11) as Capture

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, ERROR.ACTION_FAILED)
    assert.match(String(result.error?.message), /active tab changed during the capture/)
    assert.match(String(result.error?.message), /discarded/)
  })

  it('reports TAB_GONE, and cleans the binding, when the tab closed during the capture', async () => {
    const binding = own([11, 12])
    stub.tabs.get(11)!.active = true
    stub.captures = [JPEG_DATA_URL]
    stub.duringCapture = () => { stub.tabs.delete(11) }

    const result = await performTabAction('screenshot', {}, SCOPE, binding, 11) as Capture

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, ERROR.TAB_GONE)
    assert.deepEqual(ownedNow(), [12])
  })

  it('refuses a page Chrome protects before capturing anything', async () => {
    const binding = own([11])
    stub.tabs.get(11)!.url = 'chrome://settings/'
    stub.tabs.get(11)!.active = true
    stub.captures = [JPEG_DATA_URL]

    const result = await performTabAction('screenshot', {}, SCOPE, binding, 11) as Capture

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, ERROR.RESTRICTED_PAGE)
    assert.equal(stub.captureCalls, 0)
  })

  it('refuses a capture larger than the connector carries, and says what to do', async () => {
    const binding = own([11])
    stub.tabs.get(11)!.active = true
    stub.captures = [`data:image/jpeg;base64,${'A'.repeat(6 * 1024 * 1024)}`]

    const result = await performTabAction('screenshot', {}, SCOPE, binding, 11) as Capture

    assert.equal(result.ok, false)
    assert.equal(result.error?.code, ERROR.ACTION_FAILED)
    assert.match(String(result.error?.message), /make the window smaller/)
  })
})

describe('restricted pages', () => {
  it('treats a tab whose address Chrome withholds as restricted, never as safe', () => {
    assert.match(String(restrictionReason({ id: 1 } as never)), /treated as restricted/)
    assert.match(String(restrictionReason({ id: 1, url: '' } as never)), /treated as restricted/)
  })

  it('refuses browser-internal pages and the Web Store, and allows an ordinary page', () => {
    assert.match(String(restrictionReason({ id: 1, url: 'chrome://settings/' } as never)), /chrome:/)
    assert.match(String(restrictionReason({ id: 1, url: 'https://chromewebstore.google.com/' } as never)), /Web Store/)
    assert.equal(restrictionReason({ id: 1, url: 'https://example.test/' } as never), null)
  })
})
