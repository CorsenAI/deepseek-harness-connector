/**
 * The scope-to-tab ownership registry (ADR 0007).
 *
 * Pure data with no Chrome, network, or filesystem access, so every wrong-tab rule below is
 * testable without a browser. The extension holds the authoritative copy and the broker holds a
 * mirror; both use this module so the two cannot disagree about what ownership means.
 *
 * Ported from Corsen AI Hermes Connector v0.2.4 (`extension/src/bindings.js`): the same ownership
 * algebra, re-implemented with typed scopes and explicit bounds.
 *
 * @module @corsen-ai/dsh-browser-connector/bindings
 */

import { type Binding, ID_PATTERN, LIMITS, type Scope, scopeKey } from './protocol.ts'

/** Every scope one browser owns, keyed by {@link scopeKey}. */
export type Registry = Readonly<Record<string, Binding>>

/** An empty registry. */
export const EMPTY: Registry = Object.freeze({})

/**
 * Whether a value can be a Chrome tab id.
 * @param value - the candidate.
 * @returns whether it is a non-negative safe integer.
 */
function isTabId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Normalise one binding, dropping it when it carries no usable tab.
 *
 * A binding with no tabs is not an empty binding, it is an absence: keeping one would create a
 * scope that exists but can never be acted on, which is exactly the ambiguity fail-closed routing
 * exists to remove.
 * @param raw - untrusted binding-shaped input, from storage or the wire.
 * @returns the normalised binding, or `null` when it holds nothing actionable.
 * @throws when the scope identifiers are malformed, since a bad id could collapse two scopes.
 */
export function normalizeBinding(raw: unknown): Binding | null {
  if (typeof raw !== 'object' || raw === null) throw new Error('binding must be an object')
  const record = raw as Record<string, unknown>
  const profileId = String(record['profileId'] ?? '')
  const sessionId = String(record['sessionId'] ?? '')
  if (!ID_PATTERN.test(profileId)) throw new Error(`invalid profileId: ${JSON.stringify(profileId)}`)
  if (!ID_PATTERN.test(sessionId)) throw new Error(`invalid sessionId: ${JSON.stringify(sessionId)}`)

  const rawTabs = record['tabIds']
  if (!Array.isArray(rawTabs)) throw new Error('tabIds must be an array')
  if (rawTabs.length > LIMITS.MAX_TABS_PER_BINDING) throw new Error('too many tabs for one scope')

  const tabIds: number[] = []
  for (const candidate of rawTabs) {
    if (!isTabId(candidate)) throw new Error(`invalid tabId: ${JSON.stringify(candidate)}`)
    if (!tabIds.includes(candidate)) tabIds.push(candidate)
  }
  if (tabIds.length === 0) return null

  const claimed = record['activeTabId']
  // A stored active tab that is not a member is repaired to the first tab rather than rejected:
  // the set is the ownership fact, and the active choice is a preference within it.
  const activeTabId = isTabId(claimed) && tabIds.includes(claimed) ? claimed : (tabIds[0] as number)
  return { profileId, sessionId, tabIds: Object.freeze(tabIds), activeTabId }
}

/**
 * Normalise a whole registry, discarding entries that cannot be understood.
 *
 * Malformed entries are dropped rather than thrown, because this runs on restored storage that a
 * previous version or a partial write may have left inconsistent; one bad entry must not make the
 * user lose every other attachment.
 * @param raw - untrusted registry-shaped input.
 * @returns a registry containing only well-formed, actionable bindings.
 */
export function normalizeRegistry(raw: unknown): Registry {
  if (typeof raw !== 'object' || raw === null) return EMPTY
  const result: Record<string, Binding> = {}
  for (const value of Object.values(raw as Record<string, unknown>)) {
    let binding: Binding | null = null
    try {
      binding = normalizeBinding(value)
    } catch {
      // A malformed stored entry is dropped; `normalizeBinding` names the reason for callers that
      // validate wire input, and nothing else can reach this branch.
      continue
    }
    if (binding) result[scopeKey(binding.profileId, binding.sessionId)] = binding
  }
  return Object.freeze(result)
}

/**
 * Look one scope up.
 * @param registry - the registry to read.
 * @param scope - the exact profile and session.
 * @returns the binding, or `undefined` when this scope owns no tab. There is no default.
 */
export function lookup(registry: Registry, scope: Scope): Binding | undefined {
  return registry[scopeKey(scope.profileId, scope.sessionId)]
}

/**
 * Attach one tab to one scope, taking it from whichever scope held it.
 *
 * Single ownership is enforced here rather than checked later: two sessions must never both believe
 * they control the same signed-in page. The newly attached tab also becomes the scope's active tab,
 * matching the user's gesture of attaching the tab they are looking at.
 * @param registry - the registry to derive from.
 * @param scope - the scope gaining the tab.
 * @param tabId - the Chrome tab id.
 * @returns a new registry; the input is not modified.
 * @throws when the tab id is invalid or the scope would exceed its tab budget.
 */
export function attachTab(registry: Registry, scope: Scope, tabId: number): Registry {
  if (!isTabId(tabId)) throw new Error(`invalid tabId: ${JSON.stringify(tabId)}`)
  const key = scopeKey(scope.profileId, scope.sessionId)
  const next = mutable(registry)

  for (const [otherKey, binding] of Object.entries(next)) {
    if (otherKey === key || !binding.tabIds.includes(tabId)) continue
    const remaining = binding.tabIds.filter((id) => id !== tabId)
    if (remaining.length === 0) delete next[otherKey]
    else {
      next[otherKey] = {
        profileId: binding.profileId,
        sessionId: binding.sessionId,
        tabIds: Object.freeze(remaining),
        activeTabId: binding.activeTabId === tabId ? (remaining[0] as number) : binding.activeTabId,
      }
    }
  }

  const existing = next[key]
  const tabIds = existing ? [...existing.tabIds] : []
  if (!tabIds.includes(tabId)) tabIds.push(tabId)
  if (tabIds.length > LIMITS.MAX_TABS_PER_BINDING) throw new Error('too many tabs for one scope')
  next[key] = {
    profileId: scope.profileId,
    sessionId: scope.sessionId,
    tabIds: Object.freeze(tabIds),
    activeTabId: tabId,
  }
  return Object.freeze(next)
}

/**
 * Detach one tab from one scope.
 * @param registry - the registry to derive from.
 * @param scope - the scope losing the tab.
 * @param tabId - the Chrome tab id.
 * @returns a new registry; removing the scope's last tab removes the scope.
 */
export function detachTab(registry: Registry, scope: Scope, tabId: number): Registry {
  const key = scopeKey(scope.profileId, scope.sessionId)
  const binding = registry[key]
  if (!binding || !binding.tabIds.includes(tabId)) return registry
  const next = mutable(registry)
  const remaining = binding.tabIds.filter((id) => id !== tabId)
  if (remaining.length === 0) delete next[key]
  else {
    next[key] = {
      profileId: binding.profileId,
      sessionId: binding.sessionId,
      tabIds: Object.freeze(remaining),
      activeTabId: binding.activeTabId === tabId ? (remaining[0] as number) : binding.activeTabId,
    }
  }
  return Object.freeze(next)
}

/**
 * Remove one tab from every scope, for a tab Chrome reports as closed.
 * @param registry - the registry to derive from.
 * @param tabId - the Chrome tab id.
 * @returns a new registry with no reference to that tab.
 */
export function forgetTab(registry: Registry, tabId: number): Registry {
  let next = registry
  for (const binding of Object.values(registry)) {
    if (binding.tabIds.includes(tabId)) next = detachTab(next, binding, tabId)
  }
  return next
}

/**
 * Choose which of a scope's own tabs its actions target.
 * @param registry - the registry to derive from.
 * @param scope - the scope.
 * @param tabId - a tab the scope already owns.
 * @returns a new registry.
 * @throws when the tab is not attached to this scope, so a session cannot point itself at a page it
 * does not own.
 */
export function setActiveTab(registry: Registry, scope: Scope, tabId: number): Registry {
  const key = scopeKey(scope.profileId, scope.sessionId)
  const binding = registry[key]
  if (!binding || !binding.tabIds.includes(tabId)) {
    throw new Error('tab is not attached to this session')
  }
  const next = mutable(registry)
  next[key] = { ...binding, activeTabId: tabId }
  return Object.freeze(next)
}

/**
 * Drop one scope entirely.
 * @param registry - the registry to derive from.
 * @param scope - the scope to remove.
 * @returns a new registry.
 */
export function removeScope(registry: Registry, scope: Scope): Registry {
  const key = scopeKey(scope.profileId, scope.sessionId)
  if (!(key in registry)) return registry
  const next = mutable(registry)
  delete next[key]
  return Object.freeze(next)
}

/**
 * Install one complete binding, taking its tabs from every other scope in this registry.
 *
 * The broker uses this for an explicit attachment rather than assigning the entry directly: the
 * extension is authoritative for its own tabs, but the broker must not depend on it being
 * well-behaved. A browser that reported the same tab under two scopes would otherwise leave the
 * broker routing two sessions to one signed-in page, which is the exact leak ADR 0007 forbids.
 * @param registry - the registry to derive from.
 * @param binding - the binding to install, already normalised.
 * @returns a new registry in which only this scope holds these tabs.
 */
export function applyBinding(registry: Registry, binding: Binding): Registry {
  const key = scopeKey(binding.profileId, binding.sessionId)
  const claimed = new Set(binding.tabIds)
  const next = mutable(registry)
  for (const [otherKey, other] of Object.entries(next)) {
    if (otherKey === key) continue
    const remaining = other.tabIds.filter((tabId) => !claimed.has(tabId))
    if (remaining.length === other.tabIds.length) continue
    if (remaining.length === 0) delete next[otherKey]
    else {
      next[otherKey] = {
        profileId: other.profileId,
        sessionId: other.sessionId,
        tabIds: Object.freeze(remaining),
        activeTabId: remaining.includes(other.activeTabId) ? other.activeTabId : (remaining[0] as number),
      }
    }
  }
  next[key] = binding
  return Object.freeze(next)
}

/**
 * Restrict a registry to tabs that still exist.
 *
 * Chrome reuses tab ids after a restart, so a restored binding is a claim to verify, not a fact.
 * @param registry - the restored registry.
 * @param liveTabIds - tab ids the browser currently reports.
 * @returns a registry containing only live tabs, with empty scopes removed.
 */
export function retainLiveTabs(registry: Registry, liveTabIds: Iterable<number>): Registry {
  const live = new Set(liveTabIds)
  let next = registry
  for (const binding of Object.values(registry)) {
    for (const tabId of binding.tabIds) {
      if (!live.has(tabId)) next = detachTab(next, binding, tabId)
    }
  }
  return next
}

/**
 * Project a registry to the wire form used by `binding_sync`.
 * @param registry - the registry to project.
 * @returns bindings in a stable order, so two equal registries serialise identically.
 */
export function bindingList(registry: Registry): Binding[] {
  return Object.keys(registry)
    .sort()
    .map((key) => registry[key] as Binding)
}

/**
 * Whether two registries express the same ownership.
 *
 * Used to skip storage writes and broker traffic when a validation pass changed nothing.
 * @param left - one registry.
 * @param right - the other registry.
 * @returns whether they are equivalent.
 */
export function sameRegistry(left: Registry, right: Registry): boolean {
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key, index) => {
    if (rightKeys[index] !== key) return false
    const a = left[key] as Binding
    const b = right[key] as Binding
    return a.activeTabId === b.activeTabId
      && a.tabIds.length === b.tabIds.length
      && a.tabIds.every((tabId, position) => tabId === b.tabIds[position])
  })
}

/**
 * Copy a frozen registry into a mutable working object.
 * @param registry - the source.
 * @returns a shallow mutable copy.
 */
function mutable(registry: Registry): Record<string, Binding> {
  return { ...registry }
}
