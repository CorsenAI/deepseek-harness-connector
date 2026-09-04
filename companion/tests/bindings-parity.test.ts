/**
 * Behavioural parity between the companion's and the extension's ownership registries.
 *
 * Comparing exported names would prove almost nothing. Instead the same randomised operation
 * sequences run through both copies and the resulting ownership is compared after every step, so a
 * divergence in *behaviour* fails even when both files still export the same functions. If the
 * broker and the extension disagreed about who owns a tab, the broker would route an action the
 * extension would refuse, or worse, accept one it should not.
 * @module
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as companion from '../src/bindings.ts'
import * as extension from '../../extension/src/bindings.js'
import type { Binding, Scope } from '../src/protocol.ts'

/** The subset of the registry API both copies expose, as this test uses it. */
interface RegistryApi {
  EMPTY: unknown
  attachTab(registry: unknown, scope: Scope, tabId: number): unknown
  detachTab(registry: unknown, scope: Scope, tabId: number): unknown
  forgetTab(registry: unknown, tabId: number): unknown
  setActiveTab(registry: unknown, scope: Scope, tabId: number): unknown
  applyBinding(registry: unknown, binding: Binding): unknown
  removeScope(registry: unknown, scope: Scope): unknown
  retainLiveTabs(registry: unknown, liveTabIds: Iterable<number>): unknown
  normalizeBinding(raw: unknown): Binding | null
  normalizeRegistry(raw: unknown): unknown
  bindingList(registry: unknown): Binding[]
}

const left = companion as unknown as RegistryApi
const right = extension as unknown as RegistryApi

/** One operation applied to both registries. */
type Operation =
  | { kind: 'attach', scope: Scope, tabId: number }
  | { kind: 'detach', scope: Scope, tabId: number }
  | { kind: 'forget', tabId: number }
  | { kind: 'active', scope: Scope, tabId: number }
  | { kind: 'remove', scope: Scope }
  | { kind: 'retain', live: number[] }

const SCOPES: readonly Scope[] = [
  { profileId: 'web', sessionId: 'a' },
  { profileId: 'web', sessionId: 'b' },
  { profileId: 'web', sessionId: 'c' },
  { profileId: 'headless', sessionId: 'a' },
]

const TAB_IDS = [1, 2, 3, 4, 5]

/**
 * A small deterministic generator, so a failure is reproducible from its seed.
 * @param seed - the starting state.
 * @returns a function returning successive values in `[0, 1)`.
 */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

/**
 * Build one randomised operation sequence.
 * @param seed - the generator seed.
 * @param length - how many operations.
 * @returns the sequence.
 */
function sequence(seed: number, length: number): Operation[] {
  const next = random(seed)
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(next() * values.length)] as T
  const operations: Operation[] = []
  for (let index = 0; index < length; index += 1) {
    const kind = pick(['attach', 'attach', 'attach', 'detach', 'forget', 'active', 'remove', 'retain'] as const)
    if (kind === 'forget') operations.push({ kind, tabId: pick(TAB_IDS) })
    else if (kind === 'remove') operations.push({ kind, scope: pick(SCOPES) })
    else if (kind === 'retain') operations.push({ kind, live: TAB_IDS.filter(() => next() > 0.35) })
    else operations.push({ kind, scope: pick(SCOPES), tabId: pick(TAB_IDS) })
  }
  return operations
}

/**
 * Apply one operation, treating a thrown rejection as an observable outcome.
 * @param api - the registry implementation.
 * @param registry - the current registry.
 * @param operation - what to do.
 * @returns the next registry, or the rejection message.
 */
function apply(api: RegistryApi, registry: unknown, operation: Operation): { registry: unknown, error: string | null } {
  try {
    switch (operation.kind) {
      case 'attach': return { registry: api.attachTab(registry, operation.scope, operation.tabId), error: null }
      case 'detach': return { registry: api.detachTab(registry, operation.scope, operation.tabId), error: null }
      case 'forget': return { registry: api.forgetTab(registry, operation.tabId), error: null }
      case 'active': return { registry: api.setActiveTab(registry, operation.scope, operation.tabId), error: null }
      case 'remove': return { registry: api.removeScope(registry, operation.scope), error: null }
      case 'retain': return { registry: api.retainLiveTabs(registry, operation.live), error: null }
      default: throw new Error('unreachable')
    }
  } catch (cause) {
    return { registry, error: (cause as Error).message }
  }
}

/**
 * A comparable projection of one registry.
 * @param api - the registry implementation.
 * @param registry - the registry.
 * @returns ownership as plain sorted data.
 */
function project(api: RegistryApi, registry: unknown): unknown {
  return api.bindingList(registry).map((binding) => ({
    profileId: binding.profileId,
    sessionId: binding.sessionId,
    tabIds: [...binding.tabIds],
    activeTabId: binding.activeTabId,
  }))
}

describe('registry behavioural parity', () => {
  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`agrees at every step of sequence ${seed}`, () => {
      let ours: unknown = left.EMPTY
      let theirs: unknown = right.EMPTY
      const operations = sequence(seed, 60)

      operations.forEach((operation, index) => {
        const a = apply(left, ours, operation)
        const b = apply(right, theirs, operation)
        ours = a.registry
        theirs = b.registry
        const where = `sequence ${seed}, step ${index} (${operation.kind})`
        assert.equal(b.error, a.error, `rejection differs at ${where}`)
        assert.deepEqual(project(right, theirs), project(left, ours), `ownership differs at ${where}`)
      })
    })
  }

  it('agrees on the single-owner rule', () => {
    const scopeA = SCOPES[0] as Scope
    const scopeB = SCOPES[1] as Scope
    const ours = left.attachTab(left.attachTab(left.EMPTY, scopeA, 9), scopeB, 9)
    const theirs = right.attachTab(right.attachTab(right.EMPTY, scopeA, 9), scopeB, 9)
    assert.deepEqual(project(right, theirs), project(left, ours))
    assert.equal(left.bindingList(ours).length, 1)
  })

  it('agrees on applyBinding stripping tabs from other scopes', () => {
    const scopeA = SCOPES[0] as Scope
    const scopeB = SCOPES[1] as Scope
    const binding = left.normalizeBinding({ ...scopeB, tabIds: [1, 2], activeTabId: 2 })
    assert.ok(binding)
    const ours = left.applyBinding(left.attachTab(left.attachTab(left.EMPTY, scopeA, 1), scopeA, 3), binding)
    const theirs = right.applyBinding(right.attachTab(right.attachTab(right.EMPTY, scopeA, 1), scopeA, 3), binding)
    assert.deepEqual(project(right, theirs), project(left, ours))
  })

  it('agrees on which malformed input is rejected', () => {
    const cases: unknown[] = [
      null,
      'nonsense',
      { profileId: '', sessionId: 'a', tabIds: [1] },
      { profileId: 'web', sessionId: 'a b', tabIds: [1] },
      { profileId: 'web', sessionId: 'a', tabIds: 'not an array' },
      { profileId: 'web', sessionId: 'a', tabIds: [-1] },
      { profileId: 'web', sessionId: 'a', tabIds: [1.5] },
      { profileId: 'web', sessionId: 'a', tabIds: ['1'] },
      { profileId: 'web', sessionId: 'a', tabIds: [] },
      { profileId: 'web', sessionId: 'a', tabIds: [1, 1, 2], activeTabId: 99 },
    ]
    for (const input of cases) {
      let ourResult: unknown
      let ourError: string | null = null
      let theirResult: unknown
      let theirError: string | null = null
      try { ourResult = left.normalizeBinding(input) } catch (cause) { ourError = (cause as Error).message }
      try { theirResult = right.normalizeBinding(input) } catch (cause) { theirError = (cause as Error).message }
      assert.equal(theirError, ourError, `rejection differs for ${JSON.stringify(input)}`)
      assert.deepEqual(theirResult, ourResult, `result differs for ${JSON.stringify(input)}`)
    }
  })

  it('agrees on how a partially corrupt stored registry is recovered', () => {
    const stored = {
      good: { profileId: 'web', sessionId: 'a', tabIds: [1], activeTabId: 1 },
      broken: { profileId: '', sessionId: '', tabIds: [2] },
      empty: { profileId: 'web', sessionId: 'b', tabIds: [] },
      repaired: { profileId: 'web', sessionId: 'c', tabIds: [3, 4], activeTabId: 99 },
    }
    assert.deepEqual(
      project(right, right.normalizeRegistry(stored)),
      project(left, left.normalizeRegistry(stored)),
    )
  })
})
