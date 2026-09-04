/**
 * Ownership tests. These encode the wrong-tab rules from ADR 0007; a failure here is a routing
 * safety failure, not a style regression.
 * @module
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  attachTab,
  bindingList,
  detachTab,
  EMPTY,
  forgetTab,
  lookup,
  normalizeBinding,
  normalizeRegistry,
  removeScope,
  retainLiveTabs,
  sameRegistry,
  setActiveTab,
} from '../src/bindings.ts'
import { LIMITS, type Scope } from '../src/protocol.ts'

const A: Scope = { profileId: 'web', sessionId: 'session-a' }
const B: Scope = { profileId: 'web', sessionId: 'session-b' }
const OTHER_PROFILE: Scope = { profileId: 'headless', sessionId: 'session-a' }

describe('single ownership', () => {
  it('moves a tab away from the scope that held it', () => {
    let registry = attachTab(EMPTY, A, 11)
    registry = attachTab(registry, B, 11)
    assert.equal(lookup(registry, A), undefined)
    assert.deepEqual(lookup(registry, B)?.tabIds, [11])
  })

  it('leaves the previous scope intact when it still holds other tabs', () => {
    let registry = attachTab(attachTab(EMPTY, A, 11), A, 12)
    registry = attachTab(registry, B, 11)
    assert.deepEqual(lookup(registry, A)?.tabIds, [12])
    assert.equal(lookup(registry, A)?.activeTabId, 12)
    assert.deepEqual(lookup(registry, B)?.tabIds, [11])
  })

  it('keeps the same session id in two profiles apart', () => {
    let registry = attachTab(EMPTY, A, 11)
    registry = attachTab(registry, OTHER_PROFILE, 12)
    assert.deepEqual(lookup(registry, A)?.tabIds, [11])
    assert.deepEqual(lookup(registry, OTHER_PROFILE)?.tabIds, [12])
  })

  it('re-attaching a tab a scope already owns only moves the active pointer', () => {
    let registry = attachTab(attachTab(EMPTY, A, 11), A, 12)
    assert.equal(lookup(registry, A)?.activeTabId, 12)
    registry = attachTab(registry, A, 11)
    assert.deepEqual(lookup(registry, A)?.tabIds, [11, 12])
    assert.equal(lookup(registry, A)?.activeTabId, 11)
  })
})

describe('no default target', () => {
  it('an unknown scope resolves to nothing', () => {
    const registry = attachTab(EMPTY, A, 11)
    assert.equal(lookup(registry, B), undefined)
  })

  it('an empty registry resolves to nothing', () => {
    assert.equal(lookup(EMPTY, A), undefined)
  })

  it('removing the last tab removes the scope rather than leaving it targetless', () => {
    const registry = detachTab(attachTab(EMPTY, A, 11), A, 11)
    assert.equal(lookup(registry, A), undefined)
    assert.deepEqual(Object.keys(registry), [])
  })
})

describe('active tab', () => {
  it('always belongs to the owned set', () => {
    const registry = attachTab(attachTab(EMPTY, A, 11), A, 12)
    const binding = lookup(registry, A)
    assert.ok(binding)
    assert.ok(binding.tabIds.includes(binding.activeTabId))
  })

  it('is promoted when the active tab is detached', () => {
    let registry = attachTab(attachTab(EMPTY, A, 11), A, 12)
    assert.equal(lookup(registry, A)?.activeTabId, 12)
    registry = detachTab(registry, A, 12)
    assert.equal(lookup(registry, A)?.activeTabId, 11)
  })

  it('cannot be pointed at a tab the scope does not own', () => {
    const registry = attachTab(EMPTY, A, 11)
    assert.throws(() => setActiveTab(registry, A, 99), /not attached to this session/)
  })

  it('cannot be set on a scope that owns nothing', () => {
    assert.throws(() => setActiveTab(EMPTY, A, 11), /not attached to this session/)
  })

  it('is repaired to a member when storage holds an impossible value', () => {
    const binding = normalizeBinding({ ...A, tabIds: [11, 12], activeTabId: 99 })
    assert.equal(binding?.activeTabId, 11)
  })
})

describe('closed tabs', () => {
  it('are removed from every scope that referenced them', () => {
    let registry = attachTab(attachTab(EMPTY, A, 11), B, 12)
    registry = forgetTab(registry, 11)
    assert.equal(lookup(registry, A), undefined)
    assert.deepEqual(lookup(registry, B)?.tabIds, [12])
  })

  it('are dropped from a restored registry when the browser no longer has them', () => {
    let registry = attachTab(attachTab(EMPTY, A, 11), A, 12)
    registry = attachTab(registry, B, 20)
    const live = retainLiveTabs(registry, [12, 20])
    assert.deepEqual(lookup(live, A)?.tabIds, [12])
    assert.deepEqual(lookup(live, B)?.tabIds, [20])
  })

  it('leave nothing behind when none of a scope’s tabs survived', () => {
    const registry = attachTab(EMPTY, A, 11)
    assert.deepEqual(Object.keys(retainLiveTabs(registry, [99])), [])
  })
})

describe('validation', () => {
  it('refuses a malformed scope id rather than collapsing two scopes', () => {
    assert.throws(() => normalizeBinding({ profileId: 'ab', sessionId: 's', tabIds: [1] }), /invalid profileId/)
    assert.throws(() => normalizeBinding({ profileId: 'p', sessionId: '', tabIds: [1] }), /invalid sessionId/)
  })

  it('refuses a non-integer or negative tab id', () => {
    assert.throws(() => normalizeBinding({ ...A, tabIds: ['3'] }), /invalid tabId/)
    assert.throws(() => normalizeBinding({ ...A, tabIds: [-1] }), /invalid tabId/)
    assert.throws(() => normalizeBinding({ ...A, tabIds: [1.5] }), /invalid tabId/)
  })

  it('refuses more tabs than one scope may hold', () => {
    const tabIds = Array.from({ length: LIMITS.MAX_TABS_PER_BINDING + 1 }, (_unused, index) => index)
    assert.throws(() => normalizeBinding({ ...A, tabIds }), /too many tabs/)
  })

  it('refuses to grow a scope past its tab budget', () => {
    let registry = EMPTY
    for (let tabId = 0; tabId < LIMITS.MAX_TABS_PER_BINDING; tabId += 1) {
      registry = attachTab(registry, A, tabId)
    }
    assert.throws(() => attachTab(registry, A, LIMITS.MAX_TABS_PER_BINDING), /too many tabs/)
  })

  it('deduplicates repeated tab ids', () => {
    assert.deepEqual(normalizeBinding({ ...A, tabIds: [4, 4, 5] })?.tabIds, [4, 5])
  })

  it('drops one unreadable stored entry without losing the others', () => {
    const restored = normalizeRegistry({
      good: { ...A, tabIds: [11], activeTabId: 11 },
      broken: { profileId: '', sessionId: '', tabIds: [1] },
      empty: { ...B, tabIds: [] },
    })
    assert.deepEqual(Object.keys(restored).length, 1)
    assert.deepEqual(lookup(restored, A)?.tabIds, [11])
  })

  it('treats non-object input as an empty registry', () => {
    assert.deepEqual(normalizeRegistry(null), EMPTY)
    assert.deepEqual(normalizeRegistry('nonsense'), EMPTY)
    assert.deepEqual(normalizeRegistry(42), EMPTY)
  })

  it('refuses a binding that is not an object', () => {
    assert.throws(() => normalizeBinding(null), /must be an object/)
    assert.throws(() => normalizeBinding('x'), /must be an object/)
  })

  it('refuses tabIds that is not an array', () => {
    assert.throws(() => normalizeBinding({ ...A, tabIds: 11 }), /must be an array/)
  })
})

describe('projection and equality', () => {
  it('serialises two equal registries identically', () => {
    const left = attachTab(attachTab(EMPTY, B, 20), A, 11)
    const right = attachTab(attachTab(EMPTY, A, 11), B, 20)
    assert.deepEqual(bindingList(left), bindingList(right))
    assert.equal(sameRegistry(left, right), true)
  })

  it('detects an active-tab change', () => {
    const before = attachTab(attachTab(EMPTY, A, 11), A, 12)
    const after = setActiveTab(before, A, 11)
    assert.equal(sameRegistry(before, after), false)
  })

  it('detects a different scope set', () => {
    assert.equal(sameRegistry(attachTab(EMPTY, A, 11), attachTab(EMPTY, B, 11)), false)
  })
})

describe('immutability', () => {
  it('never modifies the registry it was given', () => {
    const before = attachTab(EMPTY, A, 11)
    const snapshot = JSON.stringify(before)
    attachTab(before, B, 11)
    detachTab(before, A, 11)
    removeScope(before, A)
    forgetTab(before, 11)
    assert.equal(JSON.stringify(before), snapshot)
  })

  it('returns the same registry when nothing changed', () => {
    const registry = attachTab(EMPTY, A, 11)
    assert.equal(detachTab(registry, A, 99), registry)
    assert.equal(removeScope(registry, B), registry)
    assert.equal(forgetTab(registry, 99), registry)
  })
})
