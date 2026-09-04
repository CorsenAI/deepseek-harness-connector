// The extension's copy of the scope-to-tab ownership registry (ADR 0007).
//
// `companion/src/bindings.ts` is the authoritative definition. This file mirrors it because the
// extension ships as its own Chrome Web Store package. `companion/tests/bindings-parity.test.ts`
// runs the same operation sequences through both copies and fails when they disagree, so the two
// cannot drift into different ideas of who owns a tab.
//
// Pure data: no Chrome API, no network, no storage. The extension holds the authoritative registry
// and the broker holds a mirror; both use the same rules.

import { ID_PATTERN, LIMITS, scopeKey } from "./protocol.js";

/** An empty registry. */
export const EMPTY = Object.freeze({});

/**
 * Whether a value can be a Chrome tab id.
 * @param {unknown} value The candidate.
 * @returns {boolean} Whether it is a non-negative safe integer.
 */
function isTabId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Copy a frozen registry into a mutable working object.
 * @param {object} registry The source.
 * @returns {object} A shallow mutable copy.
 */
function mutable(registry) {
  return { ...registry };
}

/**
 * Normalise one binding, dropping it when it carries no usable tab.
 * @param {unknown} raw Untrusted binding-shaped input.
 * @returns {object|null} The normalised binding, or null when it holds nothing actionable.
 */
export function normalizeBinding(raw) {
  if (typeof raw !== "object" || raw === null) throw new Error("binding must be an object");
  const profileId = String(raw.profileId ?? "");
  const sessionId = String(raw.sessionId ?? "");
  if (!ID_PATTERN.test(profileId)) throw new Error(`invalid profileId: ${JSON.stringify(profileId)}`);
  if (!ID_PATTERN.test(sessionId)) throw new Error(`invalid sessionId: ${JSON.stringify(sessionId)}`);

  if (!Array.isArray(raw.tabIds)) throw new Error("tabIds must be an array");
  if (raw.tabIds.length > LIMITS.MAX_TABS_PER_BINDING) throw new Error("too many tabs for one scope");

  const tabIds = [];
  for (const candidate of raw.tabIds) {
    if (!isTabId(candidate)) throw new Error(`invalid tabId: ${JSON.stringify(candidate)}`);
    if (!tabIds.includes(candidate)) tabIds.push(candidate);
  }
  if (tabIds.length === 0) return null;

  const claimed = raw.activeTabId;
  const activeTabId = isTabId(claimed) && tabIds.includes(claimed) ? claimed : tabIds[0];
  return { profileId, sessionId, tabIds: Object.freeze(tabIds), activeTabId };
}

/**
 * Normalise a whole registry, discarding entries that cannot be understood.
 * @param {unknown} raw Untrusted registry-shaped input, usually restored storage.
 * @returns {object} A registry of well-formed, actionable bindings.
 */
export function normalizeRegistry(raw) {
  if (typeof raw !== "object" || raw === null) return EMPTY;
  const result = {};
  for (const value of Object.values(raw)) {
    let binding = null;
    try {
      binding = normalizeBinding(value);
    } catch {
      // One unreadable stored entry must not cost the user every other attachment.
      continue;
    }
    if (binding) result[scopeKey(binding.profileId, binding.sessionId)] = binding;
  }
  return Object.freeze(result);
}

/**
 * Look one scope up. There is no default target.
 * @param {object} registry The registry to read.
 * @param {{profileId: string, sessionId: string}} scope The exact profile and session.
 * @returns {object|undefined} The binding, or undefined.
 */
export function lookup(registry, scope) {
  return registry[scopeKey(scope.profileId, scope.sessionId)];
}

/**
 * Attach one tab to one scope, taking it from whichever scope held it.
 * @param {object} registry The registry to derive from.
 * @param {{profileId: string, sessionId: string}} scope The scope gaining the tab.
 * @param {number} tabId The Chrome tab id.
 * @returns {object} A new registry; the input is not modified.
 */
export function attachTab(registry, scope, tabId) {
  if (!isTabId(tabId)) throw new Error(`invalid tabId: ${JSON.stringify(tabId)}`);
  const key = scopeKey(scope.profileId, scope.sessionId);
  const next = mutable(registry);

  for (const [otherKey, binding] of Object.entries(next)) {
    if (otherKey === key || !binding.tabIds.includes(tabId)) continue;
    const remaining = binding.tabIds.filter((id) => id !== tabId);
    if (remaining.length === 0) delete next[otherKey];
    else {
      next[otherKey] = {
        profileId: binding.profileId,
        sessionId: binding.sessionId,
        tabIds: Object.freeze(remaining),
        activeTabId: binding.activeTabId === tabId ? remaining[0] : binding.activeTabId,
      };
    }
  }

  const existing = next[key];
  const tabIds = existing ? [...existing.tabIds] : [];
  if (!tabIds.includes(tabId)) tabIds.push(tabId);
  if (tabIds.length > LIMITS.MAX_TABS_PER_BINDING) throw new Error("too many tabs for one scope");
  next[key] = {
    profileId: scope.profileId,
    sessionId: scope.sessionId,
    tabIds: Object.freeze(tabIds),
    activeTabId: tabId,
  };
  return Object.freeze(next);
}

/**
 * Detach one tab from one scope.
 * @param {object} registry The registry to derive from.
 * @param {{profileId: string, sessionId: string}} scope The scope losing the tab.
 * @param {number} tabId The Chrome tab id.
 * @returns {object} A new registry; removing the last tab removes the scope.
 */
export function detachTab(registry, scope, tabId) {
  const key = scopeKey(scope.profileId, scope.sessionId);
  const binding = registry[key];
  if (!binding || !binding.tabIds.includes(tabId)) return registry;
  const next = mutable(registry);
  const remaining = binding.tabIds.filter((id) => id !== tabId);
  if (remaining.length === 0) delete next[key];
  else {
    next[key] = {
      profileId: binding.profileId,
      sessionId: binding.sessionId,
      tabIds: Object.freeze(remaining),
      activeTabId: binding.activeTabId === tabId ? remaining[0] : binding.activeTabId,
    };
  }
  return Object.freeze(next);
}

/**
 * Remove one tab from every scope, for a tab Chrome reports as closed.
 * @param {object} registry The registry to derive from.
 * @param {number} tabId The Chrome tab id.
 * @returns {object} A new registry with no reference to that tab.
 */
export function forgetTab(registry, tabId) {
  let next = registry;
  for (const binding of Object.values(registry)) {
    if (binding.tabIds.includes(tabId)) next = detachTab(next, binding, tabId);
  }
  return next;
}

/**
 * Choose which of a scope's own tabs its actions target.
 * @param {object} registry The registry to derive from.
 * @param {{profileId: string, sessionId: string}} scope The scope.
 * @param {number} tabId A tab the scope already owns.
 * @returns {object} A new registry.
 */
export function setActiveTab(registry, scope, tabId) {
  const key = scopeKey(scope.profileId, scope.sessionId);
  const binding = registry[key];
  if (!binding || !binding.tabIds.includes(tabId)) {
    throw new Error("tab is not attached to this session");
  }
  const next = mutable(registry);
  next[key] = { ...binding, activeTabId: tabId };
  return Object.freeze(next);
}

/**
 * Install one complete binding, taking its tabs from every other scope.
 * @param {object} registry The registry to derive from.
 * @param {object} binding The binding to install, already normalised.
 * @returns {object} A new registry in which only this scope holds these tabs.
 */
export function applyBinding(registry, binding) {
  const key = scopeKey(binding.profileId, binding.sessionId);
  const claimed = new Set(binding.tabIds);
  const next = mutable(registry);
  for (const [otherKey, other] of Object.entries(next)) {
    if (otherKey === key) continue;
    const remaining = other.tabIds.filter((tabId) => !claimed.has(tabId));
    if (remaining.length === other.tabIds.length) continue;
    if (remaining.length === 0) delete next[otherKey];
    else {
      next[otherKey] = {
        profileId: other.profileId,
        sessionId: other.sessionId,
        tabIds: Object.freeze(remaining),
        activeTabId: remaining.includes(other.activeTabId) ? other.activeTabId : remaining[0],
      };
    }
  }
  next[key] = binding;
  return Object.freeze(next);
}

/**
 * Drop one scope entirely.
 * @param {object} registry The registry to derive from.
 * @param {{profileId: string, sessionId: string}} scope The scope to remove.
 * @returns {object} A new registry.
 */
export function removeScope(registry, scope) {
  const key = scopeKey(scope.profileId, scope.sessionId);
  if (!(key in registry)) return registry;
  const next = mutable(registry);
  delete next[key];
  return Object.freeze(next);
}

/**
 * Restrict a registry to tabs that still exist.
 *
 * Chrome reuses tab ids after a restart, so a restored binding is a claim to verify, not a fact.
 * @param {object} registry The restored registry.
 * @param {Iterable<number>} liveTabIds Tab ids the browser currently reports.
 * @returns {object} A registry containing only live tabs, with empty scopes removed.
 */
export function retainLiveTabs(registry, liveTabIds) {
  const live = new Set(liveTabIds);
  let next = registry;
  for (const binding of Object.values(registry)) {
    for (const tabId of binding.tabIds) {
      if (!live.has(tabId)) next = detachTab(next, binding, tabId);
    }
  }
  return next;
}

/**
 * Project a registry to the wire form used by `binding_sync`.
 * @param {object} registry The registry to project.
 * @returns {object[]} Bindings in a stable order.
 */
export function bindingList(registry) {
  return Object.keys(registry).sort().map((key) => registry[key]);
}

/**
 * Whether two registries express the same ownership.
 * @param {object} left One registry.
 * @param {object} right The other registry.
 * @returns {boolean} Whether they are equivalent.
 */
export function sameRegistry(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => {
    if (rightKeys[index] !== key) return false;
    const a = left[key];
    const b = right[key];
    return a.activeTabId === b.activeTabId
      && a.tabIds.length === b.tabIds.length
      && a.tabIds.every((tabId, position) => tabId === b.tabIds[position]);
  });
}
